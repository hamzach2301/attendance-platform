'use strict';

// Load private local KEY=value entries from .env. Cloud providers should set
// these values in their dashboard instead of committing a real .env file.
(function loadLocalEnv() {
  const fs = require('fs');
  const path = require('path');
  const envPath = path.join(__dirname, '.env');
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

const express = require('express');
const http = require('http');
const crypto = require('crypto');
const path = require('path');
const os = require('os');
const net = require('net');
const dns = require('dns').promises;
const { Pool } = require('pg');
const { WebSocketServer, WebSocket } = require('ws');
const nodemailer = require('nodemailer');
const QRCode = require('qrcode');

const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT || 3000);
const QR_TTL_MS = 10000;
const QR_ROTATION_MS = 10000;
const QR_CLAIM_GRACE_MS = 2 * 60 * 1000;
const EMAIL_RETRY_MS = 15000;
const MAX_EMAIL_RETRY_MS = 15 * 60 * 1000;
const SESSION_COOKIE = 'attendance_teacher';
const SESSION_MAX_AGE_SECONDS = 8 * 60 * 60;

// Enable this only for a cloud session where the teacher and students use the
// same mobile hotspot. Local Wi-Fi devices have distinct private IP addresses.
const REQUIRE_HOTSPOT_IP_MATCH = process.env.REQUIRE_HOTSPOT_IP_MATCH === undefined
  ? process.env.NODE_ENV === 'production'
  : process.env.REQUIRE_HOTSPOT_IP_MATCH !== 'false';
// 0 for a direct VPS. On Render, the platform identifies itself with RENDER
// and its documented client header is used below. For another proxy, set this
// to the exact number of trusted hops; incorrect values can trust spoofed IPs.
const TRUST_PROXY_HOPS = Number.parseInt(process.env.TRUST_PROXY_HOPS || '0', 10);
if (!Number.isInteger(TRUST_PROXY_HOPS) || TRUST_PROXY_HOPS < 0 || TRUST_PROXY_HOPS > 10) {
  throw new Error('TRUST_PROXY_HOPS must be an integer from 0 to 10.');
}
if (!process.env.DATABASE_URL) {
  throw new Error('Set DATABASE_URL to the Supabase PostgreSQL connection string before starting the server.');
}

const authSecret = process.env.AUTH_SECRET || (process.env.NODE_ENV === 'production' ? null : crypto.randomBytes(48).toString('hex'));
if (!authSecret) throw new Error('Set AUTH_SECRET in production before starting the server.');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Supabase requires TLS. Use DATABASE_SSL=false only for a local PostgreSQL server.
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false }
});
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

const activeQrTokens = new Map();
const checkinTickets = new Map();
const professorSockets = new Set();
const latestQrBySession = new Map();
let qrRotationTimer = null;
let emailRetryTimer = null;
let dispatchingEmails = false;
let shuttingDown = false;

async function initializeDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS teachers (
      teacher_id UUID PRIMARY KEY,
      username TEXT NOT NULL,
      email TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS teachers_username_ci_unique ON teachers (LOWER(username));

    CREATE TABLE IF NOT EXISTS students (
      student_id TEXT PRIMARY KEY,
      full_name TEXT NOT NULL,
      section TEXT NOT NULL,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      teacher_id UUID NOT NULL REFERENCES teachers(teacher_id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS students_teacher_name_section_ci_unique
      ON students (teacher_id, LOWER(full_name), LOWER(section));

    CREATE TABLE IF NOT EXISTS sessions (
      session_id UUID PRIMARY KEY,
      teacher_id UUID NOT NULL REFERENCES teachers(teacher_id),
      section_name TEXT NOT NULL,
      start_time TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      end_time TIMESTAMPTZ,
      status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE', 'COMPLETED')),
      teacher_ip VARCHAR(45)
    );
    CREATE INDEX IF NOT EXISTS sessions_teacher_status_idx ON sessions(teacher_id, status);
    CREATE UNIQUE INDEX IF NOT EXISTS one_active_session_per_teacher
      ON sessions(teacher_id) WHERE status = 'ACTIVE';

    CREATE TABLE IF NOT EXISTS attendance_records (
      record_id BIGSERIAL PRIMARY KEY,
      session_id UUID NOT NULL REFERENCES sessions(session_id),
      student_id TEXT NOT NULL REFERENCES students(student_id),
      timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      checkin_method TEXT NOT NULL CHECK(checkin_method IN ('QR', 'MANUAL')),
      device_fingerprint TEXT,
      client_ip VARCHAR(45),
      teacher_id UUID NOT NULL REFERENCES teachers(teacher_id),
      UNIQUE(session_id, student_id)
    );
    CREATE INDEX IF NOT EXISTS attendance_teacher_session_idx ON attendance_records(teacher_id, session_id);
    CREATE UNIQUE INDEX IF NOT EXISTS attendance_device_once
      ON attendance_records(session_id, device_fingerprint)
      WHERE device_fingerprint IS NOT NULL;

    CREATE TABLE IF NOT EXISTS email_jobs (
      job_id BIGSERIAL PRIMARY KEY,
      session_id UUID NOT NULL UNIQUE REFERENCES sessions(session_id),
      recipient TEXT NOT NULL,
      subject TEXT NOT NULL,
      filename TEXT NOT NULL,
      html TEXT NOT NULL,
      csv TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at BIGINT NOT NULL DEFAULT 0,
      last_error TEXT
    );
  `);
}

app.use(express.json({ limit: '64kb' }));
app.use(express.static(path.join(__dirname, 'public')));

function sendJson(res, status, body) { return res.status(status).json(body); }
function validEmail(value) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value); }
function passwordMatches(password, salt, expectedHash) {
  const actual = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(expectedHash, 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}
function signCookiePayload(payload) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.createHmac('sha256', authSecret).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
}
async function readTeacherCookie(req) {
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
    const result = await pool.query('SELECT teacher_id, username, email FROM teachers WHERE teacher_id = $1', [payload.teacherId]);
    return result.rows[0] || null;
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
async function requireTeacher(req, res, next) {
  try {
    const teacher = await readTeacherCookie(req);
    if (!teacher) return sendJson(res, 401, { error: 'Please sign in to your teacher account.' });
    req.teacher = teacher;
    req.teacherId = teacher.teacher_id;
    next();
  } catch (error) { next(error); }
}

function normalizeIp(rawIp) {
  if (rawIp === undefined || rawIp === null) return null;
  let ip = String(rawIp).trim().toLowerCase();
  if (!ip || ip === 'unknown') return null;
  ip = ip.replace(/^for=/i, '').replace(/^"|"$/g, '');
  const bracketed = ip.match(/^\[([^\]]+)\](?::\d+)?$/);
  if (bracketed) ip = bracketed[1];
  const ipv4WithPort = ip.match(/^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/);
  if (ipv4WithPort) ip = ipv4WithPort[1];
  ip = ip.replace(/%.+$/, '');
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
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168));
  }
  const lower = ip.toLowerCase();
  return lower !== '::' && lower !== '::1' && !lower.startsWith('fe80:') && !lower.startsWith('fc') && !lower.startsWith('fd');
}
function forwardedIps(req) {
  const header = req.headers['x-forwarded-for'];
  return String(Array.isArray(header) ? header.join(',') : header || '').split(',').map(normalizeIp).filter(Boolean);
}
function extractClientIp(req) {
  const socketIp = normalizeIp(req.socket?.remoteAddress || req.connection?.remoteAddress);
  const forwarded = forwardedIps(req);
  // Render sanitizes X-Forwarded-For and places the public client IP first.
  // Its request path can contain more than one internal proxy, so using the
  // rightmost entry here would incorrectly select a private Render address.
  if (process.env.RENDER === 'true') {
    return forwarded[0] || normalizeIp(req.headers['x-real-ip']) || socketIp;
  }
  if (TRUST_PROXY_HOPS === 0) return socketIp;
  const forwardedIndex = forwarded.length - TRUST_PROXY_HOPS;
  if (forwardedIndex >= 0 && forwarded[forwardedIndex]) return forwarded[forwardedIndex];
  return normalizeIp(req.headers['x-real-ip']) || socketIp;
}
function verifyHotspotIp(session, req) {
  const clientIp = extractClientIp(req);
  if (!REQUIRE_HOTSPOT_IP_MATCH) return { ok: true, clientIp };
  if (!session.teacher_ip) return { ok: false, status: 409, error: 'This session has no hotspot IP. The teacher must end and restart it.' };
  if (!clientIp) return { ok: false, status: 503, error: 'The server could not determine your network address. Try again shortly.' };
  if (clientIp !== normalizeIp(session.teacher_ip)) return { ok: false, status: 403, error: "You must be connected to the teacher's hotspot to check in." };
  return { ok: true, clientIp };
}
function firstLanIpv4() {
  const candidates = Object.entries(os.networkInterfaces()).flatMap(([name, addresses]) => (addresses || []).filter((entry) => (entry.family === 'IPv4' || entry.family === 4) && !entry.internal && !entry.address.startsWith('169.254.')).map((entry) => ({ name: name.toLowerCase(), address: entry.address })));
  candidates.sort((a, b) => (/wi-?fi|wlan|wireless|hotspot/.test(a.name) ? 0 : 1) - (/wi-?fi|wlan|wireless|hotspot/.test(b.name) ? 0 : 1));
  return candidates[0]?.address || null;
}
function portalOrigin(req) {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/+$/, '');
  const protocol = req.socket.encrypted ? 'https' : 'http';
  const hostHeader = req.headers.host || `localhost:${PORT}`;
  const hostName = hostHeader.replace(/^\[|\]$/g, '').split(':')[0].toLowerCase();
  if (hostName === 'localhost' || hostName === '127.0.0.1' || hostName === '::1') {
    const address = firstLanIpv4();
    if (address) return `${protocol}://${address}:${hostHeader.match(/:(\d+)$/)?.[1] || PORT}`;
  }
  return `${protocol}://${hostHeader}`;
}

async function activeSession(teacherId) {
  const result = await pool.query("SELECT * FROM sessions WHERE teacher_id = $1 AND status = 'ACTIVE' ORDER BY start_time DESC LIMIT 1", [teacherId]);
  return result.rows[0] || null;
}
async function sessionCount(sessionId) {
  const result = await pool.query('SELECT COUNT(*)::int AS count FROM attendance_records WHERE session_id = $1', [sessionId]);
  return result.rows[0].count;
}
function broadcast(teacherId, payload) {
  const message = JSON.stringify(payload);
  for (const socket of professorSockets) if (socket.teacherId === teacherId && socket.readyState === WebSocket.OPEN) socket.send(message);
}
async function sendQrToProfessor(socket, qr) {
  if (socket.readyState !== WebSocket.OPEN || !socket.portalOrigin) return;
  const studentUrl = `${socket.portalOrigin}/?token=${encodeURIComponent(qr.token)}`;
  const qrDataUrl = await QRCode.toDataURL(studentUrl, { errorCorrectionLevel: 'M', margin: 1, width: 300 });
  const { teacherId: _teacherId, ...publicQr } = qr;
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'qr', ...publicQr, studentUrl, qrDataUrl }));
}
async function attendanceList(sessionId, queryable = pool) {
  const result = await queryable.query(`SELECT a.record_id, a.student_id, s.full_name, a.timestamp, a.checkin_method FROM attendance_records a JOIN students s ON s.student_id = a.student_id WHERE a.session_id = $1 ORDER BY s.full_name ASC`, [sessionId]);
  return result.rows;
}
async function rotateQr() {
  const sessions = (await pool.query("SELECT * FROM sessions WHERE status = 'ACTIVE'")).rows;
  const activeIds = new Set(sessions.map((session) => session.session_id));
  for (const id of latestQrBySession.keys()) if (!activeIds.has(id)) latestQrBySession.delete(id);
  for (const session of sessions) {
    const token = crypto.randomBytes(24).toString('base64url');
    const expiresAt = Date.now() + QR_TTL_MS;
    const qr = { token, sessionId: session.session_id, teacherId: session.teacher_id, expiresAt };
    activeQrTokens.set(token, { sessionId: session.session_id, teacherId: session.teacher_id, expiresAt: Date.now() + QR_CLAIM_GRACE_MS });
    latestQrBySession.set(session.session_id, qr);
    for (const socket of professorSockets) if (socket.teacherId === session.teacher_id) sendQrToProfessor(socket, qr).catch((error) => console.error('QR rendering failed:', error.message));
  }
}

app.post('/api/auth/register', async (req, res, next) => {
  try {
    if (process.env.TEACHER_SIGNUP_CODE && req.body.signup_code !== process.env.TEACHER_SIGNUP_CODE) return sendJson(res, 403, { error: 'A valid teacher signup code is required.' });
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
      const result = await pool.query(`INSERT INTO teachers(teacher_id, username, email, password_hash, password_salt) VALUES($1, $2, $3, $4, $5) RETURNING teacher_id, username, email`, [teacherId, username, email, passwordHash, salt]);
      const teacher = result.rows[0];
      setTeacherCookie(res, teacher.teacher_id);
      res.status(201).json({ teacher });
    } catch (error) {
      if (error.code === '23505') return sendJson(res, 409, { error: 'That username is already in use.' });
      throw error;
    }
  } catch (error) { next(error); }
});
app.post('/api/auth/login', async (req, res, next) => {
  try {
    const username = String(req.body.username || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    const result = await pool.query('SELECT * FROM teachers WHERE LOWER(username) = LOWER($1)', [username]);
    const account = result.rows[0];
    if (!account || !passwordMatches(password, account.password_salt, account.password_hash)) return sendJson(res, 401, { error: 'Username or password is incorrect.' });
    setTeacherCookie(res, account.teacher_id);
    res.json({ teacher: { teacher_id: account.teacher_id, username: account.username, email: account.email } });
  } catch (error) { next(error); }
});
app.post('/api/auth/logout', (_req, res) => { clearTeacherCookie(res); res.json({ logged_out: true }); });
app.get('/api/auth/me', requireTeacher, (req, res) => res.json({ teacher: req.teacher }));

app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'student.html')));
app.get('/professor', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'professor.html')));
app.get('/api/session/active', requireTeacher, async (req, res, next) => {
  try {
    const session = await activeSession(req.teacherId);
    res.json({ session: session ? { ...session, present_count: await sessionCount(session.session_id) } : null });
  } catch (error) { next(error); }
});
app.get('/api/sections', requireTeacher, async (req, res, next) => {
  try {
    const result = await pool.query('SELECT DISTINCT section_name FROM sessions WHERE teacher_id = $1 ORDER BY section_name ASC', [req.teacherId]);
    res.json({ sections: result.rows.map((row) => row.section_name) });
  } catch (error) { next(error); }
});
app.get('/api/qr/current', requireTeacher, async (req, res, next) => {
  try {
    const session = await activeSession(req.teacherId);
    if (!session) return sendJson(res, 409, { error: 'There is no active session.' });
    let qr = latestQrBySession.get(session.session_id);
    if (!qr || qr.expiresAt <= Date.now()) { await rotateQr(); qr = latestQrBySession.get(session.session_id); }
    const studentUrl = `${portalOrigin(req)}/?token=${encodeURIComponent(qr.token)}`;
    const qrDataUrl = await QRCode.toDataURL(studentUrl, { errorCorrectionLevel: 'M', margin: 1, width: 300 });
    const { teacherId: _teacherId, ...publicQr } = qr;
    res.json({ ...publicQr, studentUrl, qrDataUrl });
  } catch (error) { next(error); }
});
app.post('/api/session/start', requireTeacher, async (req, res, next) => {
  try {
    const section = String(req.body.section_name || '').trim();
    if (!section) return sendJson(res, 400, { error: 'section_name is required.' });
    if (await activeSession(req.teacherId)) return sendJson(res, 409, { error: 'You already have an active session. End it first.' });
    const teacherIp = extractClientIp(req);
    if (REQUIRE_HOTSPOT_IP_MATCH && !teacherIp) return sendJson(res, 400, { error: 'Could not determine your public IP. Check TRUST_PROXY_HOPS and try again.' });
    if (REQUIRE_HOTSPOT_IP_MATCH && !isPublicRoutableIp(teacherIp)) return sendJson(res, 400, { error: 'The server received a private proxy IP instead of your public IP. Check TRUST_PROXY_HOPS before starting the session.' });
    const sessionId = crypto.randomUUID();
    try {
      const result = await pool.query(`INSERT INTO sessions(session_id, teacher_id, section_name, teacher_ip) VALUES($1, $2, $3, $4) RETURNING *`, [sessionId, req.teacherId, section, teacherIp]);
      const session = result.rows[0];
      broadcast(req.teacherId, { type: 'state', session: { ...session, present_count: 0 } });
      rotateQr().catch((error) => console.error('QR rotation failed:', error.message));
      res.status(201).json({ session });
    } catch (error) {
      if (error.code === '23505') return sendJson(res, 409, { error: 'You already have an active session. End it first.' });
      throw error;
    }
  } catch (error) { next(error); }
});
app.get('/api/attendance/summary', requireTeacher, async (req, res, next) => {
  try {
    const sessionId = String(req.query.session_id || '');
    const result = await pool.query('SELECT * FROM sessions WHERE session_id = $1 AND teacher_id = $2', [sessionId, req.teacherId]);
    const session = result.rows[0];
    if (!session) return sendJson(res, 404, { error: 'Session not found.' });
    res.json({ session, present_count: await sessionCount(sessionId), records: await attendanceList(sessionId) });
  } catch (error) { next(error); }
});

async function markPresent(sessionId, teacherId, fullNameInput, method, fingerprint = null, declaredSection = '', clientIp = null) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const sessionResult = await client.query('SELECT * FROM sessions WHERE session_id = $1 FOR UPDATE', [sessionId]);
    const session = sessionResult.rows[0];
    if (!session || session.teacher_id !== teacherId || session.status !== 'ACTIVE') { await client.query('ROLLBACK'); return { error: 'This session is not active.', status: 409 }; }
    const fullName = String(fullNameInput || '').trim().replace(/\s+/g, ' ').slice(0, 120);
    if (!fullName) { await client.query('ROLLBACK'); return { error: 'Enter your full name.', status: 400 }; }
    if (method === 'QR' && String(declaredSection || '').trim().toLocaleLowerCase() !== session.section_name.trim().toLocaleLowerCase()) { await client.query('ROLLBACK'); return { error: `This QR is for ${session.section_name}. Choose your own section to check in.`, status: 403 }; }
    const duplicate = await client.query(`SELECT 1 FROM attendance_records a JOIN students s ON s.student_id = a.student_id WHERE a.session_id = $1 AND LOWER(s.full_name) = LOWER($2) LIMIT 1`, [sessionId, fullName]);
    if (duplicate.rowCount) { await client.query('ROLLBACK'); return { error: 'That name is already marked present for this session.', status: 409 }; }
    let studentResult = await client.query(`SELECT * FROM students WHERE teacher_id = $1 AND LOWER(full_name) = LOWER($2) AND LOWER(section) = LOWER($3) AND active = TRUE LIMIT 1`, [teacherId, fullName, session.section_name]);
    if (!studentResult.rowCount) {
      await client.query(`INSERT INTO students(student_id, full_name, section, active, teacher_id) VALUES($1, $2, $3, TRUE, $4) ON CONFLICT DO NOTHING`, [`AUTO-${crypto.randomUUID()}`, fullName, session.section_name, teacherId]);
      studentResult = await client.query(`SELECT * FROM students WHERE teacher_id = $1 AND LOWER(full_name) = LOWER($2) AND LOWER(section) = LOWER($3) LIMIT 1`, [teacherId, fullName, session.section_name]);
    }
    const student = studentResult.rows[0];
    await client.query(`INSERT INTO attendance_records(session_id, student_id, checkin_method, device_fingerprint, client_ip, teacher_id) VALUES($1, $2, $3, $4, $5, $6)`, [sessionId, student.student_id, method, fingerprint, clientIp, teacherId]);
    await client.query('COMMIT');
    const presentCount = await sessionCount(sessionId);
    broadcast(teacherId, { type: 'attendance', sessionId, present_count: presentCount, student: { student_id: student.student_id, full_name: student.full_name, checkin_method: method } });
    return { student, present_count: presentCount };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* transaction already closed */ }
    if (error.code === '23505') return { error: 'This device has already checked in for this session.', status: 409 };
    throw error;
  } finally { client.release(); }
}

app.post('/api/attendance/claim', async (req, res, next) => {
  try {
    const token = String(req.body.dynamic_token || '');
    const fingerprint = String(req.body.device_fingerprint || '').trim().slice(0, 128);
    if (!token || !fingerprint) return sendJson(res, 400, { error: 'dynamic_token and device_fingerprint are required.' });
    const tokenRecord = activeQrTokens.get(token);
    if (!tokenRecord || tokenRecord.expiresAt <= Date.now()) return sendJson(res, 410, { error: 'That QR code expired before it opened. Scan the current code.' });
    const result = await pool.query("SELECT session_id, teacher_id, section_name, teacher_ip FROM sessions WHERE session_id = $1 AND status = 'ACTIVE'", [tokenRecord.sessionId]);
    const session = result.rows[0];
    if (!session || session.teacher_id !== tokenRecord.teacherId) return sendJson(res, 410, { error: 'That class session has ended. Scan the current QR code.' });
    const hotspotCheck = verifyHotspotIp(session, req);
    if (!hotspotCheck.ok) return sendJson(res, hotspotCheck.status, { error: hotspotCheck.error });
    const ticket = crypto.randomBytes(24).toString('base64url');
    checkinTickets.set(ticket, { sessionId: tokenRecord.sessionId, teacherId: tokenRecord.teacherId, fingerprint, expiresAt: Date.now() + 2 * 60 * 1000 });
    res.json({ checkin_ticket: ticket, section_name: session.section_name, expires_in_seconds: 120 });
  } catch (error) { next(error); }
});
app.post('/api/attendance/scan', async (req, res, next) => {
  try {
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
    const result = await pool.query('SELECT session_id, teacher_id, status, teacher_ip FROM sessions WHERE session_id = $1', [sessionId]);
    const session = result.rows[0];
    if (!session || session.teacher_id !== teacherId || session.status !== 'ACTIVE') return sendJson(res, 410, { error: 'That class session has ended. Scan the current QR code.' });
    const hotspotCheck = verifyHotspotIp(session, req);
    if (!hotspotCheck.ok) return sendJson(res, hotspotCheck.status, { error: hotspotCheck.error });
    const attendance = await markPresent(sessionId, teacherId, fullName, 'QR', fingerprint, sectionName, hotspotCheck.clientIp);
    if (attendance.error) return sendJson(res, attendance.status, { error: attendance.error });
    if (ticket) checkinTickets.delete(ticket);
    res.status(201).json({ message: `Attendance recorded for ${attendance.student.full_name}.`, present_count: attendance.present_count });
  } catch (error) { next(error); }
});
app.post('/api/attendance/manual', requireTeacher, async (req, res, next) => {
  try {
    const sessionId = String(req.body.session_id || '');
    const fullName = String(req.body.full_name || '').trim();
    if (!sessionId || !fullName) return sendJson(res, 400, { error: 'session_id and full_name are required.' });
    const result = await markPresent(sessionId, req.teacherId, fullName, 'MANUAL');
    if (result.error) return sendJson(res, result.status, { error: result.error });
    res.status(201).json({ student: result.student, present_count: result.present_count });
  } catch (error) { next(error); }
});
app.delete('/api/attendance/:recordId', requireTeacher, async (req, res, next) => {
  try {
    const recordId = Number.parseInt(req.params.recordId, 10);
    if (!Number.isInteger(recordId) || recordId < 1) return sendJson(res, 400, { error: 'Invalid attendance record.' });
    const found = await pool.query(`SELECT a.record_id, a.session_id, s.status, p.full_name FROM attendance_records a JOIN sessions s ON s.session_id = a.session_id JOIN students p ON p.student_id = a.student_id WHERE a.record_id = $1 AND s.teacher_id = $2`, [recordId, req.teacherId]);
    const record = found.rows[0];
    if (!record) return sendJson(res, 404, { error: 'Attendance record not found.' });
    if (record.status !== 'ACTIVE') return sendJson(res, 409, { error: 'Only attendance in an active session can be removed here.' });
    await pool.query('DELETE FROM attendance_records WHERE record_id = $1 AND teacher_id = $2', [recordId, req.teacherId]);
    const presentCount = await sessionCount(record.session_id);
    broadcast(req.teacherId, { type: 'attendance', sessionId: record.session_id, present_count: presentCount, removed: true });
    res.json({ removed: true, full_name: record.full_name, present_count: presentCount });
  } catch (error) { next(error); }
});

function csvEscape(value) { return `"${String(value ?? '').replace(/"/g, '""')}"`; }
function escapeHtml(value) { return String(value).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]); }
async function createReport(session, queryable = pool) {
  const records = await attendanceList(session.session_id, queryable);
  const htmlRows = records.map((row) => `<tr><td>${escapeHtml(row.full_name)}</td><td>${escapeHtml(row.timestamp)}</td><td>${escapeHtml(row.checkin_method)}</td></tr>`).join('');
  const html = `<h2>Attendance: ${escapeHtml(session.section_name)}</h2><p>Session started: ${escapeHtml(session.start_time)}<br>Session ended: ${escapeHtml(session.end_time)}</p><p>Present: ${records.length}</p><table border="1" cellpadding="6" cellspacing="0"><thead><tr><th>Name</th><th>Timestamp</th><th>Method</th></tr></thead><tbody>${htmlRows || '<tr><td colspan="3">No attendance recorded</td></tr>'}</tbody></table>`;
  const csv = ['Full Name,Timestamp,Method', ...records.map((r) => [r.full_name, r.timestamp, r.checkin_method].map(csvEscape).join(','))].join('\r\n');
  return { records, html, csv };
}

const smtpConfigured = () => Boolean(process.env.SMTP_HOST);
function makeTransport() {
  const port = Number(process.env.SMTP_PORT || 587);
  return nodemailer.createTransport({ host: process.env.SMTP_HOST, port, secure: process.env.SMTP_SECURE === 'true' || port === 465, auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS || '' } : undefined });
}
async function hasInternet() {
  try { await dns.lookup(process.env.SMTP_HOST || 'example.com'); return true; } catch { return false; }
}
async function dispatchQueuedEmails() {
  if (shuttingDown || dispatchingEmails || !smtpConfigured() || !(await hasInternet())) return;
  dispatchingEmails = true;
  try {
    const jobs = (await pool.query('SELECT * FROM email_jobs WHERE next_attempt_at <= $1 ORDER BY job_id LIMIT 5', [Date.now()])).rows;
    for (const job of jobs) {
      try {
        await makeTransport().sendMail({ from: process.env.SMTP_FROM || process.env.SMTP_USER, to: job.recipient, subject: job.subject, html: job.html, attachments: [{ filename: job.filename, content: job.csv, contentType: 'text/csv; charset=utf-8' }] });
        await pool.query('DELETE FROM email_jobs WHERE job_id = $1', [job.job_id]);
      } catch (error) {
        const attempts = job.attempts + 1;
        const delay = Math.min(EMAIL_RETRY_MS * (2 ** Math.min(attempts - 1, 6)), MAX_EMAIL_RETRY_MS);
        await pool.query('UPDATE email_jobs SET attempts = $1, next_attempt_at = $2, last_error = $3 WHERE job_id = $4', [attempts, Date.now() + delay, String(error.message).slice(0, 500), job.job_id]);
        console.error(`Email send failed; retry scheduled in ${Math.round(delay / 1000)}s:`, error.message);
      }
    }
  } finally { dispatchingEmails = false; }
}

app.post('/api/session/close', requireTeacher, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const sessionId = String(req.body.session_id || '');
    await client.query('BEGIN');
    const selected = await client.query("SELECT * FROM sessions WHERE session_id = $1 AND teacher_id = $2 AND status = 'ACTIVE' FOR UPDATE", [sessionId, req.teacherId]);
    const session = selected.rows[0];
    if (!session) { await client.query('ROLLBACK'); return sendJson(res, 404, { error: 'Active session not found.' }); }
    const endedResult = await client.query("UPDATE sessions SET status = 'COMPLETED', end_time = NOW() WHERE session_id = $1 AND teacher_id = $2 RETURNING *", [sessionId, req.teacherId]);
    const ended = endedResult.rows[0];
    const report = await createReport(ended, client);
    const teacherResult = await client.query('SELECT email FROM teachers WHERE teacher_id = $1', [req.teacherId]);
    const date = new Date(ended.end_time).toISOString().slice(0, 10);
    const sectionSlug = ended.section_name.replace(/[^a-z0-9_-]+/gi, '_').replace(/^_+|_+$/g, '') || 'Section_A';
    const filename = `Section_${sectionSlug}_Attendance_${date}.csv`;
    await client.query(`INSERT INTO email_jobs(session_id, recipient, subject, filename, html, csv, next_attempt_at) VALUES($1, $2, $3, $4, $5, $6, $7)`, [sessionId, teacherResult.rows[0].email, `Attendance report — ${ended.section_name} — ${date}`, filename, report.html, report.csv, Date.now()]);
    await client.query('COMMIT');
    latestQrBySession.delete(sessionId);
    broadcast(req.teacherId, { type: 'closed', sessionId, present_count: report.records.length });
    await dispatchQueuedEmails().catch((error) => console.error('Initial email delivery failed:', error.message));
    const pending = await pool.query('SELECT 1 FROM email_jobs WHERE session_id = $1', [sessionId]);
    res.json({ status: 'COMPLETED', present_count: report.records.length, email_status: pending.rowCount ? (smtpConfigured() ? 'QUEUED_FOR_RETRY' : 'QUEUED_SMTP_NOT_CONFIGURED') : 'SENT' });
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* transaction was not open */ }
    next(error);
  } finally { client.release(); }
});

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname !== '/ws/qr') return socket.destroy();
  readTeacherCookie(req).then((teacher) => {
    if (!teacher) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); return socket.destroy(); }
    req.teacher = teacher;
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  }).catch(() => socket.destroy());
});
wss.on('connection', async (ws, req) => {
  try {
    ws.portalOrigin = portalOrigin(req);
    ws.teacherId = req.teacher.teacher_id;
    professorSockets.add(ws);
    ws.on('close', () => professorSockets.delete(ws));
    const session = await activeSession(ws.teacherId);
    ws.send(JSON.stringify({ type: 'state', session: session ? { ...session, present_count: await sessionCount(session.session_id) } : null }));
    if (session) {
      if (!latestQrBySession.get(session.session_id)) await rotateQr();
      const qr = latestQrBySession.get(session.session_id);
      if (qr && qr.expiresAt > Date.now()) await sendQrToProfessor(ws, qr);
    }
  } catch (error) { console.error('WebSocket setup failed:', error.message); ws.terminate(); }
});

app.use((error, _req, res, _next) => {
  console.error('Request failed:', error.message);
  if (!res.headersSent) sendJson(res, 500, { error: 'The server could not complete that request. Please try again.' });
});

function startBackgroundJobs() {
  qrRotationTimer = setInterval(() => {
    if (shuttingDown) return;
    const now = Date.now();
    for (const [token, entry] of activeQrTokens) if (entry.expiresAt <= now) activeQrTokens.delete(token);
    for (const [ticket, entry] of checkinTickets) if (entry.expiresAt <= now) checkinTickets.delete(ticket);
    rotateQr().catch((error) => console.error('QR rotation failed:', error.message));
  }, QR_ROTATION_MS);
  emailRetryTimer = setInterval(() => {
    if (!shuttingDown) dispatchQueuedEmails().catch((error) => console.error('Email queue check failed:', error.message));
  }, EMAIL_RETRY_MS);
  qrRotationTimer.unref();
  emailRetryTimer.unref();
}
async function start() {
  await initializeDatabase();
  startBackgroundJobs();
  server.listen(PORT, HOST, () => {
    console.log(`Attendance server listening on http://${HOST}:${PORT}`);
    console.log('Database: Supabase PostgreSQL');
    if (!smtpConfigured()) console.log('SMTP is not configured; closed-session reports will remain queued in PostgreSQL.');
  });
}
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(qrRotationTimer);
  clearInterval(emailRetryTimer);
  activeQrTokens.clear();
  checkinTickets.clear();
  for (const socket of wss.clients) socket.terminate();
  professorSockets.clear();
  server.close(async (error) => {
    try { await pool.end(); } catch (dbError) { console.error('Database shutdown error:', dbError.message); }
    process.exit(error ? 1 : 0);
  });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

start().catch((error) => {
  console.error('Unable to start attendance server:', error.message);
  process.exit(1);
});
