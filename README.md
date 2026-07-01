# 🥷 OSC Live Scheduler — Salsa Ninja Tracker

Live schedule tracker for **Academia Salsa Ninja Dance Academy** performing at the **Orlando Salsa Congress 2026**.

## 🎯 What It Does

- Connects directly to the [Podium System](https://live.podiumsystem.mx/minuto?ev=215) live schedule via Socket.IO
- Filters for all choreographies from **Salsa Ninja Dance Academy**
- Displays performance times, categories, statuses, and team members
- Auto-refreshes every **5 minutes** to catch schedule changes
- Manual refresh button for instant updates

## 🚀 Live

Deployed on Netlify — [view live site](#)

## 🛠️ Tech Stack

- **Vanilla HTML/CSS/JS** — no frameworks, no build step
- **Socket.IO Client** (CDN) — connects to Podium System's WebSocket API
- **Netlify** — static hosting

## 💻 Local Development

Just open `public/index.html` in a browser, or serve it:

```bash
npx serve public
```

The Node.js backend (`server.js`) is an optional local-only server if you prefer a proxy approach:

```bash
npm install
npm start
# → http://localhost:3000
```

## 🔎 Production Diagnostics

Production reads should go through `/api/schedule`, which Netlify routes to `netlify/functions/schedule.js`. That server-side function can send the `x-user` WebSocket header required by Podium.

To debug a production browser session, open DevTools and run:

```js
window.oscDiagnostics()
```

Netlify Function logs are prefixed with `[podium:<request-id>]` and show the read stage: connection, payload parsing, match counts, stale-cache fallback, or failure details.

## 📁 Project Structure

```
├── public/
│   ├── index.html    # Main page
│   ├── style.css     # Premium dark theme
│   └── app.js        # Socket.IO client + rendering
├── server.js          # Optional Node.js backend (local dev)
├── netlify.toml       # Netlify config
└── package.json
```

## 📝 License

MIT
