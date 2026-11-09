# Deploying the attendance platform for free

This version uses **Supabase PostgreSQL** for persistent data and a **Render Free Web Service** for the Express server. The database keeps teacher accounts, sessions, attendance lists, and queued email reports even when Render restarts or sleeps.

## What changed from the local SQLite version

The server now requires `DATABASE_URL`. It creates the PostgreSQL tables automatically the first time it connects. Existing local `attendance.sqlite` data remains on the laptop as a backup; it is not uploaded to Supabase. The first cloud teacher account starts with a fresh cloud database.

## 1. Create the Supabase database

1. Create an account at [Supabase](https://supabase.com/dashboard), then choose **New project**.
2. Give it a project name such as `attendance-platform`, create a strong database password, and save that password somewhere private.
3. Wait until the project status shows it is ready.
4. In the project dashboard, select **Connect**.
5. Choose **Session pooler** and copy the connection string. This is the best choice for a long-running Render Express service with an IPv4 connection.
6. Replace `[YOUR-PASSWORD]` with your database password. If the password contains characters like `@`, `#`, `?`, `&`, or spaces, encode them before pasting them in the URL.

Do not put the Supabase connection string in GitHub, screenshots, or chat messages. It grants direct database access.

## 2. Test locally with Supabase

1. In PowerShell, open the project:

   ```powershell
   cd "C:\Users\Hamzach\OneDrive\Documents\project"
   ```

2. Update the private `.env` file. Remove the old `DB_PATH` line and add your private database URL:

   ```text
   DATABASE_URL=postgresql://...your-supabase-session-pooler-URL...
   DATABASE_SSL=true
   ```

3. Keep the following while testing from the laptop:

   ```text
   REQUIRE_HOTSPOT_IP_MATCH=false
   TRUST_PROXY_HOPS=0
   ```

4. Install the changed dependencies and start the server:

   ```powershell
   npm.cmd install
   npm.cmd start
   ```

5. Open `http://localhost:3000/professor`, create a teacher account, start a test session, and complete a check-in. Tables are created automatically in Supabase.

## 3. Push the PostgreSQL changes to GitHub

Check that your database URL and local attendance files are still ignored:

```powershell
git status
```

It must not show `.env`, `attendance.sqlite`, `attendance.sqlite-wal`, or `attendance.sqlite-shm`.

Then commit and push the conversion:

```powershell
git add server.js package.json package-lock.json .env.example DEPLOYMENT.md public
git commit -m "Use Supabase PostgreSQL for cloud persistence"
git push
```

## 4. Deploy the Express server on Render Free

1. Go to [Render](https://render.com), sign in with GitHub, and choose **New → Web Service**.
2. Select `hamzach2301/attendance-platform` and configure it:

   | Field | Value |
   | --- | --- |
   | Language | Node |
   | Branch | `main` |
   | Build Command | `npm ci` |
   | Start Command | `npm start` |
   | Instance type | Free |

3. Do **not** add a persistent disk. Supabase stores the data.
4. In **Environment**, add these values:

   ```text
   NODE_ENV=production
   DATABASE_URL=your-private-Supabase-session-pooler-connection-string
   DATABASE_SSL=true
   REQUIRE_HOTSPOT_IP_MATCH=true
   TRUST_PROXY_HOPS=1
   AUTH_SECRET=a-long-random-secret
   TEACHER_SIGNUP_CODE=your-private-teacher-signup-code
   ```

5. Generate `AUTH_SECRET` in PowerShell:

   ```powershell
   node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
   ```

6. Click **Create Web Service**. After it is live, copy its address, for example `https://attendance-platform.onrender.com`.
7. Return to **Environment**, add this final variable, and choose **Save and deploy**:

   ```text
   PUBLIC_URL=https://attendance-platform.onrender.com
   ```

## 5. Check the cloud service

1. Open `https://YOUR-RENDER-URL/professor`.
2. Create the first teacher account with the private signup code.
3. Connect the teacher laptop to the teacher’s mobile hotspot.
4. Start the session **after connecting to the hotspot**.
5. Connect a student phone to that same hotspot, scan the QR code, and check in.
6. Turn Wi-Fi off on another phone and use mobile data. The app should reject its check-in with: `You must be connected to the teacher's hotspot to check in.`

## Free-plan limits

Render Free services sleep after 15 minutes without incoming traffic. The first request after sleep can take several seconds while it wakes up, so open the professor page a few minutes before class. Supabase Free may pause a project that has little activity for about a week; the Supabase dashboard sends warning email before pausing it, and you can resume it.

The actual provider behavior is documented by [Render’s Free Web Service guide](https://render.com/docs/your-first-deploy), [Render’s WebSocket update](https://render.com/changelog/free-web-services-now-remain-active-while-receiving-websocket-messages), [Supabase connection guidance](https://supabase.com/docs/guides/database/connecting-to-postgres), and [Supabase free-project pausing](https://supabase.com/docs/guides/platform/free-project-pausing).

## Hotspot IP matching limits

With `REQUIRE_HOTSPOT_IP_MATCH=true`, the server saves the teacher hotspot’s public IP when the session begins. A QR claim and attendance submission must arrive from the same public IP. This rejects a QR link opened via an unrelated home network or mobile data connection.

It is an extra control, not proof that someone is physically in the room. Hotspot carriers can change public IPs, IPv6/mobile networks can expose different addresses, and another device already connected to the hotspot can still check in. QR rotation, short ticket expiry, and teacher review of the live list remain important.

`TRUST_PROXY_HOPS=1` is required on Render because it supplies the original client IP through a proxy. Set it to `0` for a direct custom VPS. Incorrect proxy settings can make forwarded-IP headers unreliable; see [Express guidance](https://expressjs.com/en/guide/behind-proxies/).
