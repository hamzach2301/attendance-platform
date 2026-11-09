'use strict';

// Load simple KEY=value entries from a private local .env file. Cloud deployments
// should inject these variables through their service settings instead.
(function loadLocalEnv() {
  const fs = require('fs');
  const envPath = require('path').join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || process.env[match[1]] !== undefined) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, '');
    process.env[match[1]] = value;
  }
})();

// Local network binding defaults to 0.0.0.0 so students on the professor's
// hotspot can connect. Set HOST=127.0.0.1 to restrict access to this laptop.
const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT || 3000);
// Use an absolute persistent-disk path in production (for example /var/data/attendance.sqlite).
const DB_FILE = process.env.DB_PATH || './attendance.sqlite';
// QR display rotates every 10 seconds; claimed links keep a short grace window below.
const QR_TTL_MS = 10000;
const QR_ROTATION_MS = 10000;
// iPhone Camera may require tapping the detected link before opening Safari.
// Keep old QR links claimable briefly while the displayed QR continues rotating.
const QR_CLAIM_GRACE_MS = 2 * 60 * 1000;
const EMAIL_RETRY_MS = 15000;
const MAX_EMAIL_RETRY_MS = 15 * 60 * 1000;
// SMTP settings are read from SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER,
// SMTP_PASS and SMTP_FROM. Set them in the launch environment;
// no credentials are stored in the source or SQLite database.

const express = require('express');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const dns = require('dns').promises;
const net = require('net');
const Database = require('better-sqlite3');
const { WebSocketServer, WebSocket } = require('ws');
const nodemailer = require('nodemailer');
const QRCode = require('qrcode');

const DB_ABSOLUTE_PATH = path.resolve(__dirname, DB_FILE);
fs.mkdirSync(path.dirname(DB_ABSOLUTE_PATH), { recursive: true });

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });
const db = new Database(DB_ABSOLUTE_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// In production set a long random AUTH_SECRET in the provider's environment settings.
// A random local fallback keeps development convenient; it invalidates logins on restart.
const authSecret = process.env.AUTH_SECRET || crypto.randomBytes(48).toString('hex');
if (process.env.NODE_ENV === 'production' && !process.env.AUTH_SECRET) {
  throw new Error('Set AUTH_SECRET in production before starting the server.');
}
const SESSION_COOKIE = 'attendance_teacher';
const SESSION_MAX_AGE_SECONDS = 8 * 60 * 60;
// The check is enabled by default for production deployments and disabled for
// local development, where hotspot devices have different private LAN IPs.
// In a cloud deployment, keep it true so QR attendance requires the same
// public IP that started the session. TRUST_PROXY_HOPS must match the
// deployment topology: 0 for a direct VPS, 1 for a single provider proxy.
const REQUIRE_HOTSPOT_IP_MATCH = process.env.REQUIRE_HOTSPOT_IP_MATCH === undefined
  ? process.env.NODE_ENV === 'production'
  : process.env.REQUIRE_HOTSPOT_IP_MATCH !== 'false';
const TRUST_PROXY_HOPS = Number.parseInt(process.env.TRUST_PROXY_HOPS || '0', 10);
if (!Number.isInteger(TRUST_PROXY_HOPS) || TRUST_PROXY_HOPS < 0 || TRUST_PROXY_HOPS > 10) {
  throw new Error('TRUST_PROXY_HOPS must be an integer from 0 to 10.');
}

db.exec(`
  CREATE TABLE IF NOT EXISTS teachers (
    teacher_id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    email TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS students (
    student_id TEXT PRIMARY KEY,
    full_name TEXT NOT NULL,
    section TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    teacher_id TEXT REFERENCES teachers(teacher_id)
  );
  CREATE TABLE IF NOT EXISTS sessions (
    session_id TEXT PRIMARY KEY,
    teacher_id TEXT REFERENCES teachers(teacher_id),
    section_name TEXT NOT NULL,
    start_time TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    end_time TEXT,
    status TEXT NOT NULL DEFAULT 'ACTIVE',
    teacher_ip TEXT
  );
  CREATE TABLE IF NOT EXISTS attendance_records (
    record_id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(session_id),
    student_id TEXT NOT NULL REFERENCES students(student_id),
    timestamp TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    checkin_method TEXT NOT NULL CHECK(checkin_method IN ('QR', 'MANUAL')),
    device_fingerprint TEXT,
    client_ip TEXT,
    teacher_id TEXT REFERENCES teachers(teacher_id),
    UNIQUE(session_id, student_id)
  );
  CREATE TABLE IF NOT EXISTS email_jobs (
    job_id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL UNIQUE,
    recipient TEXT NOT NULL,
    subject TEXT NOT NULL,
    filename TEXT NOT NULL DEFAULT 'Section_A_Attendance.csv',
    html TEXT NOT NULL,
    csv TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER NOT NULL DEFAULT 0,
    last_error TEXT
  );
`);
// Add ownership columns to existing single-teacher SQLite databases without dropping data.
for (const [table, column] of [['students', 'teacher_id'], ['sessions', 'teacher_id'], ['attendance_records', 'teacher_id']]) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
  if (!columns.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN teacher_id TEXT REFERENCES teachers(teacher_id)`);
}
const sessionColumns = db.prepare('PRAGMA table_info(sessions)').all().map((r) => r.name);
if (!sessionColumns.includes('teacher_ip')) db.exec('ALTER TABLE sessions ADD COLUMN teacher_ip TEXT');
const attendanceIpColumns = db.prepare('PRAGMA table_info(attendance_records)').all().map((r) => r.name);
if (!attendanceIpColumns.includes('client_ip')) db.exec('ALTER TABLE attendance_records ADD COLUMN client_ip TEXT');
db.exec(`CREATE INDEX IF NOT EXISTS students_teacher_section ON students(teacher_id, section);
  CREATE INDEX IF NOT EXISTS sessions_teacher_status ON sessions(teacher_id, status);
  CREATE INDEX IF NOT EXISTS attendance_teacher_session ON attendance_records(teacher_id, session_id);
  CREATE UNIQUE INDEX IF NOT EXISTS one_active_session_per_teacher ON sessions(teacher_id) WHERE status = 'ACTIVE' AND teacher_id IS NOT NULL;`);
const studentColumns = db.prepare('PRAGMA table_info(students)').all().map((r) => r.name);
if (!studentColumns.includes('active')) db.exec('ALTER TABLE students ADD COLUMN active INTEGER NOT NULL DEFAULT 1');
const emailColumns = db.prepare('PRAGMA table_info(email_jobs)').all().map((r) => r.name);
if (!emailColumns.includes('filename')) {
  db.exec("ALTER TABLE email_jobs ADD COLUMN filename TEXT NOT NULL DEFAULT 'Section_A_Attendance.csv'");
}

// Migrate a database created from the base schema in the request.
const attendanceColumns = db.prepare('PRAGMA table_info(attendance_records)').all().map((r) => r.name);
if (!attendanceColumns.includes('device_fingerprint')) {
  db.exec('ALTER TABLE attendance_records ADD COLUMN device_fingerprint TEXT');
}
db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS attendance_device_once
  ON attendance_records(session_id, device_fingerprint)
  WHERE device_fingerprint IS NOT NULL`);

app.use(express.json({ limit: '64kb' }));
app.use(express.static(path.join(__dirname, 'public')));

function validEmail(value) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value); }
function passwordMatches(password, salt, expectedHash) {
  const actual = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(expectedHash, 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}
app.post('/api/auth/register', (req, res) => {
  if (process.env.TEACHER_SIGNUP_CODE && req.body.signup_code !== process.env.TEACHER_SIGNUP_CODE) {
    return sendJson(res, 403, { error: 'A valid teacher signup code is required.' });
  }
  const username = String(req.body.username || '').trim().toLowerCase();
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  if (!/^[a-z0-9][a-z0-9._-]{2,31}$/.test(username)) return sendJson(res, 400, { error: 'Username must be 3–32 characters using letters, numbers, dot, underscore, or dash.' });
  if (!validEmail(email) || email.length > 254) return sendJson(res, 400, { error: 'Enter a valid report email address.' });
  if (password.length < 12 || password.length > 200) return sendJson(res, 400, { error: 'Password must be at least 12 characters.' });
  const teacherId = crypto.randomUUID();
  const salt = crypto.randomBytes(16).toString('hex');
  const passwordHash = crypto.scryptSync(password, salt, 64).toString('hex');
  try {
    const register = db.transaction(() => {
      const isFirstTeacher = db.prepare('SELECT COUNT(*) AS count FROM teachers').get().count === 0;
      db.prepare('INSERT INTO teachers(teacher_id, username, email, password_hash, password_salt) VALUES(?, ?, ?, ?, ?)')
        .run(teacherId, username, email, passwordHash, salt);
      // The first account claims existing single-user data so migration preserves the current database.
      if (isFirstTeacher) {
        for (const table of ['students', 'sessions', 'attendance_records']) {
          db.prepare(`UPDATE ${table} SET teacher_id = ? WHERE teacher_id IS NULL`).run(teacherId);
        }
      }
      return db.prepare('SELECT teacher_id, username, email FROM teachers WHERE teacher_id = ?').get(teacherId);
    });
    const teacher = register();
    setTeacherCookie(res, teacher.teacher_id);
    res.status(201).json({ teacher });
  } catch (error) {
    if (String(error.code).startsWith('SQLITE_CONSTRAINT')) return sendJson(res, 409, { error: 'That username is already in use.' });
    throw error;
  }
});
app.post('/api/auth/login', (req, res) => {
  const username = String(req.body.username || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const account = db.prepare('SELECT * FROM teachers WHERE username = ? COLLATE NOCASE').get(username);
  const matches = account && passwordMatches(password, account.password_salt, account.password_hash);
  if (!matches) return sendJson(res, 401, { error: 'Username or password is incorrect.' });
  setTeacherCookie(res, account.teacher_id);
  res.json({ teacher: { teacher_id: account.teacher_id, username: account.username, email: account.email } });
});
app.post('/api/auth/logout', (_req, res) => { clearTeacherCookie(res); res.json({ logged_out: true }); });
app.get('/api/auth/me', requireTeacher, (req, res) => res.json({ teacher: req.teacher }));

const activeQrTokens = new Map();
const checkinTickets = new Map();
const professorSockets = new Set();
const latestQrBySession = new Map();
let shuttingDown = false;

function sendJson(res, status, body) { return res.status(status).json(body); }
function firstLanIpv4() {
  const candidates = Object.entries(os.networkInterfaces()).flatMap(([name, addresses]) =>
    (addresses || []).filter((entry) => (entry.family === 'IPv4' || entry.family === 4) && !entry.internal && !entry.address.startsWith('169.254.'))
      .map((entry) => ({ name: name.toLowerCase(), address: entry.address })));
  candidates.sort((a, b) => {
    const wifi = (name) => /wi-?fi|wlan|wireless|hotspot/.test(name) ? 0 : 1;
    return wifi(a.name) - wifi(b.name);
  });
  return candidates[0]?.address || null;
}
function portalOrigin(req) {
  // Set PUBLIC_URL when the laptop has several network adapters or a fixed hotspot URL.
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/+$/, '');
  const protocol = req.socket.encrypted ? 'https' : 'http';
  const hostHeader = req.headers.host || `localhost:${PORT}`;
  const hostName = hostHeader.replace(/^\[|\]$/g, '').split(':')[0].toLowerCase();
  if (hostName === 'localhost' || hostName === '127.0.0.1' || hostName === '::1') {
    const address = firstLanIpv4();
    if (address) {
      const port = hostHeader.match(/:(\d+)$/)?.[1] || String(PORT);
      return `${protocol}://${address}:${port}`;
    }
  }
  return `${protocol}://${hostHeader}`;
}
// Convert socket and forwarded-address formats to one comparison-safe value.
// X-Forwarded-For entries are supplied right-to-left by proxies. We only trust
// them when TRUST_PROXY_HOPS explicitly says how many proxies sit in front of
// this app; otherwise a caller could forge a header and bypass hotspot checks.
function normalizeIp(rawIp) {
  if (rawIp === undefined || rawIp === null) return null;
  let ip = String(rawIp).trim().toLowerCase();
  if (!ip || ip === 'unknown') return null;
  ip = ip.replace(/^for=/i, '').replace(/^"|"$/g, '');
  const bracketed = ip.match(/^\[([^\]]+)\](?::\d+)?$/);
  if (bracketed) ip = bracketed[1];
  const ipv4WithPort = ip.match(/^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/);
  if (ipv4WithPort) ip = ipv4WithPort[1];
  ip = ip.replace(/%.+$/, ''); // IPv6 zone IDs are not part of the public address.
  if (ip.startsWith('::ffff:')) {
    const mappedIpv4 = ip.slice('::ffff:'.length);
    if (net.isIP(mappedIpv4) === 4) ip = mappedIpv4;
  }
  return net.isIP(ip) ? ip : null;
}
function isPublicRoutableIp(ip) {
  if (!ip) return false;
  if (net.isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168));
  }
  const lower = ip.toLowerCase();
  return lower !== '::' && lower !== '::1' && !lower.startsWith('fe80:') && !lower.startsWith('fc') && !lower.startsWith('fd');
}
function forwardedIps(req) {
  const header = req.headers['x-forwarded-for'];
  return String(Array.isArray(header) ? header.join(',') : header || '')
    .split(',').map(normalizeIp).filter(Boolean);
}
function extractClientIp(req) {
  const socketIp = normalizeIp(req.socket?.remoteAddress || req.connection?.remoteAddress);
  if (TRUST_PROXY_HOPS === 0) return socketIp;

  // With one proxy, the rightmost X-Forwarded-For address is the client.
  // With more, select the first address beyond the configured trusted hops.
  const forwarded = forwardedIps(req);
  const forwardedIndex = forwarded.length - TRUST_PROXY_HOPS;
  if (forwardedIndex >= 0 && forwarded[forwardedIndex]) return forwarded[forwardedIndex];

  // Some providers send only X-Real-IP. Accept it only after the deployment
  // has been explicitly configured to trust one or more reverse proxies.
  return normalizeIp(req.headers['x-real-ip']) || socketIp;
}
function verifyHotspotIp(session, req) {
  const clientIp = extractClientIp(req);
  if (!REQUIRE_HOTSPOT_IP_MATCH) return { ok: true, clientIp };
  if (!session.teacher_ip) return { ok: false, status: 409, error: 'This session has no hotspot IP. The teacher must end and restart it.' };
  if (!clientIp) return { ok: false, status: 503, error: 'The server could not determine your network address. Try again shortly.' };
  if (clientIp !== normalizeIp(session.teacher_ip)) {
    return { ok: false, status: 403, error: "You must be connected to the teacher's hotspot to check in." };
  }
  return { ok: true, clientIp };
}
function signCookiePayload(payload) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.createHmac('sha256', authSecret).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
}
function readTeacherCookie(req) {
  const cookieHeader = req.headers.cookie || '';
  const token = cookieHeader.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${SESSION_COOKIE}=`))?.slice(SESSION_COOKIE.length + 1);
  if (!token) return null;
  let decoded;
  try { decoded = decodeURIComponent(token); } catch { return null; }
  const [encoded, signature] = decoded.split('.');
  if (!encoded || !signature) return null;
  const expected = crypto.createHmac('sha256', authSecret).update(encoded).digest();
  let actual;
  try { actual = Buffer.from(signature, 'base64url'); } catch { return null; }
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    if (!payload.teacherId || payload.expiresAt <= Date.now()) return null;
    const teacher = db.prepare('SELECT teacher_id, username, email FROM teachers WHERE teacher_id = ?').get(payload.teacherId);
    return teacher || null;
  } catch { return null; }
}
function setTeacherCookie(res, teacherId) {
  const value = signCookiePayload({ teacherId, expiresAt: Date.now() + SESSION_MAX_AGE_SECONDS * 1000 });
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${encodeURIComponent(value)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MAX_AGE_SECONDS}${secure}`);
}
function clearTeacherCookie(res) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure}`);
}
function requireTeacher(req, res, next) {
  const teacher = readTeacherCookie(req);
  if (!teacher) return sendJson(res, 401, { error: 'Please sign in to your teacher account.' });
  req.teacher = teacher;
  req.teacherId = teacher.teacher_id;
  next();
}
function activeSession(teacherId) {
  return db.prepare("SELECT * FROM sessions WHERE teacher_id = ? AND status = 'ACTIVE' ORDER BY start_time DESC LIMIT 1").get(teacherId) || null;
}
function sessionCount(sessionId) {
  return db.prepare('SELECT COUNT(*) AS count FROM attendance_records WHERE session_id = ?').get(sessionId).count;
}
function broadcast(teacherId, payload) {
  const message = JSON.stringify(payload);
  for (const socket of professorSockets) {
    if (socket.teacherId === teacherId && socket.readyState === WebSocket.OPEN) socket.send(message);
  }
}
async function sendQrToProfessor(socket, qr) {
  if (socket.readyState !== WebSocket.OPEN || !socket.portalOrigin) return;
  const studentUrl = `${socket.portalOrigin}/?token=${encodeURIComponent(qr.token)}`;
  const qrDataUrl = await QRCode.toDataURL(studentUrl, { errorCorrectionLevel: 'M', margin: 1, width: 300 });
  const { teacherId: _teacherId, ...publicQr } = qr;
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'qr', ...publicQr, studentUrl, qrDataUrl }));
}
function attendanceList(sessionId) {
  return db.prepare(`SELECT a.record_id, a.student_id, s.full_name, a.timestamp, a.checkin_method
    FROM attendance_records a JOIN students s ON s.student_id = a.student_id
    WHERE a.session_id = ? ORDER BY s.full_name COLLATE NOCASE`).all(sessionId);
}

async function rotateQr() {
  const sessions = db.prepare("SELECT * FROM sessions WHERE status = 'ACTIVE'").all();
  const activeIds = new Set(sessions.map((session) => session.session_id));
  for (const id of latestQrBySession.keys()) if (!activeIds.has(id)) latestQrBySession.delete(id);
  for (const session of sessions) {
    const token = crypto.randomBytes(24).toString('base64url');
    const expiresAt = Date.now() + QR_TTL_MS;
    const qr = { token, sessionId: session.session_id, teacherId: session.teacher_id, expiresAt };
    activeQrTokens.set(token, { sessionId: session.session_id, teacherId: session.teacher_id, expiresAt: Date.now() + QR_CLAIM_GRACE_MS });
    latestQrBySession.set(session.session_id, qr);
    for (const socket of professorSockets) {
      if (socket.teacherId === session.teacher_id) sendQrToProfessor(socket, qr).catch((err) => console.error('QR rendering failed:', err.message));
    }
  }
}
const qrRotationTimer = setInterval(() => {
  if (shuttingDown) return;
  const now = Date.now();
  for (const [token, entry] of activeQrTokens) if (entry.expiresAt <= now) activeQrTokens.delete(token);
  for (const [ticket, entry] of checkinTickets) if (entry.expiresAt <= now) checkinTickets.delete(ticket);
  rotateQr().catch((err) => console.error('QR rotation failed:', err.message));
}, QR_ROTATION_MS);
qrRotationTimer.unref();

app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'student.html')));
app.get('/professor', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'professor.html')));

app.get('/api/session/active', requireTeacher, (req, res) => {
  const session = activeSession(req.teacherId);
  if (!session) return res.json({ session: null });
  res.json({ session: { ...session, present_count: sessionCount(session.session_id) } });
});

app.get('/api/sections', requireTeacher, (req, res) => {
  const sections = db.prepare('SELECT DISTINCT section_name FROM sessions WHERE teacher_id = ? ORDER BY section_name COLLATE NOCASE').all(req.teacherId).map((row) => row.section_name);
  res.json({ sections });
});

// HTTP QR endpoint used when a browser or network blocks the WebSocket stream.
app.get('/api/qr/current', requireTeacher, async (req, res) => {
  const session = activeSession(req.teacherId);
  if (!session) return sendJson(res, 409, { error: 'There is no active session.' });
  let qr = latestQrBySession.get(session.session_id);
  if (!qr || qr.expiresAt <= Date.now()) { await rotateQr(); qr = latestQrBySession.get(session.session_id); }
  const studentUrl = `${portalOrigin(req)}/?token=${encodeURIComponent(qr.token)}`;
  try {
    const qrDataUrl = await QRCode.toDataURL(studentUrl, { errorCorrectionLevel: 'M', margin: 1, width: 300 });
    const { teacherId: _teacherId, ...publicQr } = qr;
    res.json({ ...publicQr, studentUrl, qrDataUrl });
  } catch (error) {
    sendJson(res, 500, { error: `Could not render QR: ${error.message}` });
  }
});

// Only the professor can start a session.
app.post('/api/session/start', requireTeacher, (req, res) => {
  const section = String(req.body.section_name || '').trim();
  if (!section) return sendJson(res, 400, { error: 'section_name is required.' });
  if (activeSession(req.teacherId)) return sendJson(res, 409, { error: 'You already have an active session. End it first.' });
  const teacherIp = extractClientIp(req);
  if (REQUIRE_HOTSPOT_IP_MATCH && !teacherIp) {
    return sendJson(res, 400, { error: 'Could not determine your public IP. Check TRUST_PROXY_HOPS and try again.' });
  }
  if (REQUIRE_HOTSPOT_IP_MATCH && !isPublicRoutableIp(teacherIp)) {
    return sendJson(res, 400, { error: 'The server received a private proxy IP instead of your public IP. Check TRUST_PROXY_HOPS before starting the session.' });
  }
  const sessionId = crypto.randomUUID();
  try { db.prepare('INSERT INTO sessions(session_id, teacher_id, section_name, teacher_ip) VALUES(?, ?, ?, ?)').run(sessionId, req.teacherId, section, teacherIp); }
  catch (error) {
    if (String(error.code).startsWith('SQLITE_CONSTRAINT')) return sendJson(res, 409, { error: 'You already have an active session. End it first.' });
    throw error;
  }
  broadcast(req.teacherId, { type: 'state', session: { session_id: sessionId, section_name: section, status: 'ACTIVE', present_count: 0 } });
  rotateQr().catch((err) => console.error('QR rotation failed:', err.message));
  res.status(201).json({ session: activeSession(req.teacherId) });
});

app.get('/api/attendance/summary', requireTeacher, (req, res) => {
  const sessionId = String(req.query.session_id || '');
  const session = db.prepare('SELECT * FROM sessions WHERE session_id = ? AND teacher_id = ?').get(sessionId, req.teacherId);
  if (!session) return sendJson(res, 404, { error: 'Session not found.' });
  res.json({ session, present_count: sessionCount(sessionId), records: attendanceList(sessionId) });
});

function markPresent(sessionId, teacherId, fullNameInput, method, fingerprint = null, declaredSection = '', clientIp = null) {
  const session = db.prepare('SELECT * FROM sessions WHERE session_id = ?').get(sessionId);
  if (!session || session.teacher_id !== teacherId || session.status !== 'ACTIVE') return { error: 'This session is not active.', status: 409 };
  const fullName = String(fullNameInput || '').trim().replace(/\s+/g, ' ').slice(0, 120);
  if (!fullName) return { error: 'Enter your full name.', status: 400 };
  if (method === 'QR' && String(declaredSection || '').trim().toLocaleLowerCase() !== session.section_name.trim().toLocaleLowerCase()) {
    return { error: `This QR is for ${session.section_name}. Choose your own section to check in.`, status: 403 };
  }
  const duplicate = db.prepare(`SELECT 1 FROM attendance_records a
    JOIN students s ON s.student_id = a.student_id
    WHERE a.session_id = ? AND s.full_name = ? COLLATE NOCASE LIMIT 1`).get(sessionId, fullName);
  if (duplicate) return { error: 'That name is already marked present for this session.', status: 409 };
  // Add each attendee to the session's section automatically; no preloaded roster is required.
  let student = db.prepare('SELECT * FROM students WHERE teacher_id = ? AND full_name = ? COLLATE NOCASE AND section = ? COLLATE NOCASE AND active = 1 LIMIT 1').get(teacherId, fullName, session.section_name);
  if (!student) {
    const studentId = `AUTO-${crypto.randomUUID()}`;
    db.prepare('INSERT INTO students(student_id, full_name, section, active, teacher_id) VALUES(?, ?, ?, 1, ?)').run(studentId, fullName, session.section_name, teacherId);
    student = { student_id: studentId, full_name: fullName, section: session.section_name, active: 1, teacher_id: teacherId };
  }
  try {
    db.prepare(`INSERT INTO attendance_records(session_id, student_id, checkin_method, device_fingerprint, client_ip, teacher_id)
      VALUES(?, ?, ?, ?, ?, ?)`).run(sessionId, student.student_id, method, fingerprint, clientIp, teacherId);
  } catch (error) {
    if (String(error.code).startsWith('SQLITE_CONSTRAINT')) return { error: 'This device has already checked in for this session.', status: 409 };
    throw error;
  }
  const count = sessionCount(sessionId);
  broadcast(teacherId, { type: 'attendance', sessionId, present_count: count, student: { student_id: student.student_id, full_name: student.full_name, checkin_method: method } });
  return { student, present_count: count };
}

app.post('/api/attendance/claim', (req, res) => {
  const token = String(req.body.dynamic_token || '');
  const fingerprint = String(req.body.device_fingerprint || '').trim().slice(0, 128);
  if (!token || !fingerprint) return sendJson(res, 400, { error: 'dynamic_token and device_fingerprint are required.' });
  const tokenRecord = activeQrTokens.get(token);
  if (!tokenRecord || tokenRecord.expiresAt <= Date.now()) return sendJson(res, 410, { error: 'That QR code expired before it opened. Scan the current code.' });
  const ticket = crypto.randomBytes(24).toString('base64url');
  const session = db.prepare("SELECT session_id, teacher_id, section_name, teacher_ip FROM sessions WHERE session_id = ? AND status = 'ACTIVE'").get(tokenRecord.sessionId);
  if (!session || session.teacher_id !== tokenRecord.teacherId) return sendJson(res, 410, { error: 'That class session has ended. Scan the current QR code.' });
  const hotspotCheck = verifyHotspotIp(session, req);
  if (!hotspotCheck.ok) return sendJson(res, hotspotCheck.status, { error: hotspotCheck.error });
  checkinTickets.set(ticket, { sessionId: tokenRecord.sessionId, teacherId: tokenRecord.teacherId, fingerprint, expiresAt: Date.now() + 2 * 60 * 1000 });
  res.json({ checkin_ticket: ticket, section_name: session.section_name, expires_in_seconds: 120 });
});

app.post('/api/attendance/scan', (req, res) => {
  const fullName = String(req.body.full_name || req.body.student_name || req.body.student_id || '').trim();
  const sectionName = String(req.body.section_name || '').trim();
  const token = String(req.body.dynamic_token || '');
  const ticket = String(req.body.checkin_ticket || '');
  const fingerprint = String(req.body.device_fingerprint || '').trim().slice(0, 128);
  if (!fullName || !sectionName || (!token && !ticket) || !fingerprint) return sendJson(res, 400, { error: 'full_name, section_name, QR code, and device_fingerprint are required.' });
  let sessionId;
  let teacherId;
  if (ticket) {
    const claim = checkinTickets.get(ticket);
    if (!claim || claim.expiresAt <= Date.now()) return sendJson(res, 410, { error: 'The check-in form expired. Scan the current QR code again.' });
    if (claim.fingerprint !== fingerprint) return sendJson(res, 403, { error: 'This check-in link belongs to another device.' });
    sessionId = claim.sessionId;
    teacherId = claim.teacherId;
  } else {
    const tokenRecord = activeQrTokens.get(token);
    if (!tokenRecord || tokenRecord.expiresAt <= Date.now()) return sendJson(res, 410, { error: 'That QR code expired. Scan the current code.' });
    sessionId = tokenRecord.sessionId;
    teacherId = tokenRecord.teacherId;
  }
  const session = db.prepare("SELECT session_id, teacher_id, status, teacher_ip FROM sessions WHERE session_id = ?").get(sessionId);
  if (!session || session.teacher_id !== teacherId || session.status !== 'ACTIVE') return sendJson(res, 410, { error: 'That class session has ended. Scan the current QR code.' });
  const hotspotCheck = verifyHotspotIp(session, req);
  if (!hotspotCheck.ok) return sendJson(res, hotspotCheck.status, { error: hotspotCheck.error });
  const result = markPresent(sessionId, teacherId, fullName, 'QR', fingerprint, sectionName, hotspotCheck.clientIp);
  if (result.error) return sendJson(res, result.status, { error: result.error });
  if (ticket) checkinTickets.delete(ticket);
  res.status(201).json({ message: `Attendance recorded for ${result.student.full_name}.`, present_count: result.present_count });
});

app.post('/api/attendance/manual', requireTeacher, (req, res) => {
  const sessionId = String(req.body.session_id || '');
  const fullName = String(req.body.full_name || '').trim();
  if (!sessionId || !fullName) return sendJson(res, 400, { error: 'session_id and full_name are required.' });
  const result = markPresent(sessionId, req.teacherId, fullName, 'MANUAL');
  if (result.error) return sendJson(res, result.status, { error: result.error });
  res.status(201).json({ student: result.student, present_count: result.present_count });
});

app.delete('/api/attendance/:recordId', requireTeacher, (req, res) => {
  const recordId = Number.parseInt(req.params.recordId, 10);
  if (!Number.isInteger(recordId) || recordId < 1) return sendJson(res, 400, { error: 'Invalid attendance record.' });
  const record = db.prepare(`SELECT a.record_id, a.session_id, s.status, p.full_name
    FROM attendance_records a JOIN sessions s ON s.session_id = a.session_id
    JOIN students p ON p.student_id = a.student_id WHERE a.record_id = ? AND s.teacher_id = ?`).get(recordId, req.teacherId);
  if (!record) return sendJson(res, 404, { error: 'Attendance record not found.' });
  if (record.status !== 'ACTIVE') return sendJson(res, 409, { error: 'Only attendance in an active session can be removed here.' });
  db.prepare('DELETE FROM attendance_records WHERE record_id = ? AND teacher_id = ?').run(recordId, req.teacherId);
  const presentCount = sessionCount(record.session_id);
  broadcast(req.teacherId, { type: 'attendance', sessionId: record.session_id, present_count: presentCount, removed: true });
  res.json({ removed: true, full_name: record.full_name, present_count: presentCount });
});

function csvEscape(value) { return `"${String(value ?? '').replace(/"/g, '""')}"`; }
function createReport(session) {
  const records = attendanceList(session.session_id);
  const htmlRows = records.map((row) => `<tr><td>${escapeHtml(row.full_name)}</td><td>${escapeHtml(row.timestamp)}</td><td>${escapeHtml(row.checkin_method)}</td></tr>`).join('');
  const html = `<h2>Attendance: ${escapeHtml(session.section_name)}</h2><p>Session started: ${escapeHtml(session.start_time)}<br>Session ended: ${escapeHtml(session.end_time)}</p><p>Present: ${records.length}</p><table border="1" cellpadding="6" cellspacing="0"><thead><tr><th>Name</th><th>Timestamp</th><th>Method</th></tr></thead><tbody>${htmlRows || '<tr><td colspan="3">No attendance recorded</td></tr>'}</tbody></table>`;
  const csv = ['Full Name,Timestamp,Method', ...records.map((r) => [r.full_name, r.timestamp, r.checkin_method].map(csvEscape).join(','))].join('\r\n');
  return { records, html, csv };
}
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}

const smtpConfigured = () => Boolean(process.env.SMTP_HOST);
let dispatchingEmails = false;
function makeTransport() {
  const port = Number(process.env.SMTP_PORT || 587);
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: process.env.SMTP_SECURE === 'true' || port === 465,
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS || '' } : undefined
  });
}
async function hasInternet() {
  try { await dns.lookup(process.env.SMTP_HOST || 'example.com'); return true; }
  catch { return false; }
}
async function dispatchQueuedEmails() {
  if (shuttingDown || dispatchingEmails || !smtpConfigured()) return;
  if (!(await hasInternet()) || shuttingDown) return;
  dispatchingEmails = true;
  try {
    const jobs = db.prepare('SELECT * FROM email_jobs WHERE next_attempt_at <= ? ORDER BY job_id LIMIT 5').all(Date.now());
    for (const job of jobs) {
      if (shuttingDown) return;
      try {
        await makeTransport().sendMail({
          from: process.env.SMTP_FROM || process.env.SMTP_USER,
          to: job.recipient,
          subject: job.subject,
          html: job.html,
          attachments: [{ filename: job.filename, content: job.csv, contentType: 'text/csv; charset=utf-8' }]
        });
        if (shuttingDown) return;
        db.prepare('DELETE FROM email_jobs WHERE job_id = ?').run(job.job_id);
        console.log(`Attendance email delivered for session ${job.session_id}`);
      } catch (error) {
        if (shuttingDown) return;
        const attempts = job.attempts + 1;
        const delay = Math.min(EMAIL_RETRY_MS * (2 ** Math.min(attempts - 1, 6)), MAX_EMAIL_RETRY_MS);
        db.prepare('UPDATE email_jobs SET attempts = ?, next_attempt_at = ?, last_error = ? WHERE job_id = ?')
          .run(attempts, Date.now() + delay, String(error.message).slice(0, 500), job.job_id);
        console.error(`Email send failed; retry scheduled in ${Math.round(delay / 1000)}s:`, error.message);
      }
    }
  } finally {
    dispatchingEmails = false;
  }
}
const emailRetryTimer = setInterval(() => {
  if (!shuttingDown) dispatchQueuedEmails().catch((err) => console.error('Email queue check failed:', err.message));
}, EMAIL_RETRY_MS);
emailRetryTimer.unref();

app.post('/api/session/close', requireTeacher, async (req, res) => {
  const sessionId = String(req.body.session_id || '');
  const session = db.prepare("SELECT * FROM sessions WHERE session_id = ? AND teacher_id = ? AND status = 'ACTIVE'").get(sessionId, req.teacherId);
  if (!session) return sendJson(res, 404, { error: 'Active session not found.' });
  const close = db.transaction(() => {
    db.prepare("UPDATE sessions SET status = 'COMPLETED', end_time = CURRENT_TIMESTAMP WHERE session_id = ? AND teacher_id = ?").run(sessionId, req.teacherId);
    const ended = db.prepare('SELECT * FROM sessions WHERE session_id = ?').get(sessionId);
    const report = createReport(ended);
    const recipient = db.prepare('SELECT email FROM teachers WHERE teacher_id = ?').get(req.teacherId).email;
    const date = ended.end_time.slice(0, 10);
    const sectionSlug = ended.section_name.replace(/[^a-z0-9_-]+/gi, '_').replace(/^_+|_+$/g, '') || 'Section_A';
    const filename = `Section_${sectionSlug}_Attendance_${date}.csv`;
    db.prepare(`INSERT INTO email_jobs(session_id, recipient, subject, filename, html, csv, next_attempt_at)
      VALUES(?, ?, ?, ?, ?, ?, ?)`).run(sessionId, recipient, `Attendance report — ${ended.section_name} — ${date}`, filename, report.html, report.csv, Date.now());
    return { ended, report };
  });
  const { ended, report } = close();
  latestQrBySession.delete(sessionId);
  broadcast(req.teacherId, { type: 'closed', sessionId, present_count: report.records.length });
  await dispatchQueuedEmails().catch((err) => console.error('Initial email delivery failed:', err.message));
  const pending = Boolean(db.prepare('SELECT 1 FROM email_jobs WHERE session_id = ?').get(sessionId));
  res.json({ status: 'COMPLETED', present_count: report.records.length, email_status: pending ? (smtpConfigured() ? 'QUEUED_FOR_RETRY' : 'QUEUED_SMTP_NOT_CONFIGURED') : 'SENT' });
});

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname !== '/ws/qr') return socket.destroy();
  const teacher = readTeacherCookie(req);
  if (!teacher) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    return socket.destroy();
  }
  req.teacher = teacher;
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});
wss.on('connection', (ws, req) => {
  ws.portalOrigin = portalOrigin(req);
  ws.teacherId = req.teacher.teacher_id;
  professorSockets.add(ws);
  ws.on('close', () => professorSockets.delete(ws));
  const session = activeSession(ws.teacherId);
  ws.send(JSON.stringify({ type: 'state', session: session ? { ...session, present_count: sessionCount(session.session_id) } : null }));
  const qr = session && latestQrBySession.get(session.session_id);
  if (qr && qr.expiresAt > Date.now()) {
    sendQrToProfessor(ws, qr).catch((err) => console.error('QR rendering failed:', err.message));
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Attendance server listening on http://${HOST}:${PORT}`);
  console.log(`Database: ${DB_ABSOLUTE_PATH}`);
  if (!smtpConfigured()) console.log('SMTP is not configured; closed-session reports will remain queued in SQLite.');
});

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(qrRotationTimer);
  clearInterval(emailRetryTimer);
  activeQrTokens.clear();
  checkinTickets.clear();
  // End dashboard WebSockets so server.close() can finish cleanly.
  for (const socket of wss.clients) socket.terminate();
  professorSockets.clear();
  server.close((error) => {
    if (error) console.error('Server shutdown error:', error.message);
    if (db.open) db.close();
    process.exit(error ? 1 : 0);
  });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
