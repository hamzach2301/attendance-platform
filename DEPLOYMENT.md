# Multi-teacher attendance app: setup and deployment

## Local setup

1. In PowerShell, open the project folder and install the dependencies with `npm.cmd ci` (or `npm install` if the lock file needs updating).
2. Copy `.env.example` to `.env` and set a private `AUTH_SECRET`. Generate one with:

   ```powershell
   node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
   ```

3. Start the app with `npm.cmd start`, then open `http://localhost:3000/professor`.
4. Create a teacher account with a username, a password of at least 12 characters, and the email address that should receive that teacher's reports. The first teacher account created against an existing database adopts its unowned legacy records.
5. To run from a phone hotspot, keep `HOST=0.0.0.0`, allow Node.js through Windows Firewall on the private network, and share the Wi-Fi address shown in the QR code.

The app reads simple `KEY=value` entries from `.env` at startup. `.env` and the SQLite database are ignored by Git; commit `.env.example` only.

## Deploying on Render with a persistent disk

1. This project folder currently has no Git repository. From PowerShell in the project folder, run `git init`, then `git add server.js public package.json package-lock.json .gitignore .env.example DEPLOYMENT.md`, `git status`, and `git commit -m "Prepare attendance app for deployment"`. Confirm `.env` and SQLite files are absent before pushing to GitHub. If any database or secret was committed previously, remove it from Git history and rotate the exposed credentials.
2. Create a Render **Web Service** from the repository. Use `npm ci` as the build command and `npm start` as the start command. Select a Node runtime compatible with the project dependencies (Node 20 or newer).
3. Choose a paid web service plan and add a persistent disk mounted at `/var/data`. Render's [free web services do not support persistent disks](https://render.com/docs/free). Set `DB_PATH=/var/data/attendance.sqlite` in the service environment. The app creates the database directory if it does not exist. Only files under the disk mount path persist across restarts and deploys ([Render disk documentation](https://render.com/docs/disks)).
4. Add `NODE_ENV=production`, a long random `AUTH_SECRET`, `PUBLIC_URL=https://your-service.onrender.com`, `REQUIRE_HOTSPOT_IP_MATCH=true`, `TRUST_PROXY_HOPS=1`, and your SMTP variables in Render's environment settings. If signups should be restricted, set `TEACHER_SIGNUP_CODE` and give it only to teachers you authorize.
5. Deploy, then open `https://your-service.onrender.com/professor`. Each teacher creates an account; sessions, section history, students, and attendance rows are filtered by that account. Session reports go to the email address saved on that teacher account.
6. Back up the SQLite file from the persistent disk regularly. If the app already contains data, copy the SQLite database and its WAL/SHM files while the server is stopped to the mounted disk before the first cloud start. Alternatively, export reports and start with a fresh persistent database.

Keep this service at one running instance when using SQLite. Render also restricts a service with a persistent disk to one instance ([scaling limits](https://render.com/docs/scaling)). SQLite is a single-file database and this app keeps rotating QR tokens and check-in tickets in process memory; multiple app instances need shared storage and shared token/session state or a database designed for that deployment model.

## Offline and cloud behavior

Cloud hosting gives teachers a shared internet URL, but student phones need internet access to reach it. The local Wi-Fi hotspot workflow still works when the professor runs the app on the laptop on that same network. For attendance during an internet outage, use the local laptop server and its local SQLite file; cloud-hosted SQLite cannot provide an offline fallback automatically.

## Hotspot IP matching

When `REQUIRE_HOTSPOT_IP_MATCH=true`, the app stores the public IP address that reaches the cloud service when a teacher starts a session. Every QR claim and attendance submission must arrive from the same address. This prevents a forwarded QR URL from checking in through another mobile or home network.

Use a cloud deployment for this feature: a phone hotspot normally translates the laptop and connected student phones through the hotspot's shared public address. It cannot be used as a physical-presence guarantee. A hotspot provider can change its public IP during a session, some IPv6/mobile networks can expose different addresses per device, and students sharing the same external network can still check in. Keep the QR rotation, short claim lifetime, and teacher review of the live list enabled.

`TRUST_PROXY_HOPS` determines when the app trusts `X-Forwarded-For`/`X-Real-IP`. Set `0` for a direct VPS. Set `1` only when your hosting provider is the sole reverse proxy and it overwrites forwarding headers. Render sends the client address in `X-Forwarded-For`; Express warns that an incorrect proxy-trust setting permits spoofed headers. See [Render's proxy guidance](https://render.com/articles/how-render-handles-ddos-attacks) and [Express behind proxies](https://expressjs.com/en/guide/behind-proxies/).
