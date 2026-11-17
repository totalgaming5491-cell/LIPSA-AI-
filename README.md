# LIPSA AI ULTRA — Your Intelligent World.

Node.js backend + responsive PWA frontend. Works on desktop browsers and Android (installable PWA, or packaged APK via Bubblewrap/TWA or Capacitor).

## Structure
- `server.js` – secure API: Firebase auth check, DeepSeek chat, Tavily search, vision, optional TTS, memory, history, planner, data deletion
- `public/` – UI (welcome, chat, voice, planner, history, memory, settings), orb + galaxy animations, service worker, manifest
- `.env.example` – all configuration (keys live ONLY here / in host env vars)

## Setup
1. `npm install`
2. Firebase console: create a project → enable **Authentication** (Email/Password + Google) and **Firestore**. Create a service account key (Project settings → Service accounts) and put its JSON on one line in `FIREBASE_SERVICE_ACCOUNT`. Add the web app config values to `.env`. Add your deploy domain under Auth → Authorized domains.
3. Copy `.env.example` → `.env`. Set `DEEPSEEK_API_KEY` and `DEEPSEEK_MODEL` (use the exact Flash model ID from DeepSeek's docs). Optional: `TAVILY_API_KEY` (search), `VISION_*` (image understanding; DeepSeek chat is text-only so use any OpenAI-compatible vision model), `TTS_*` (premium voice).
4. Firestore rules: deny all client access (the backend uses the Admin SDK): `allow read, write: if false;`
5. `npm start` → http://localhost:3000 (microphone needs HTTPS or localhost).

## Deploy
Any Node host (Render, Railway, Fly.io, Cloud Run). Set the env vars in the host dashboard. Serve over HTTPS.

## Android
- Quickest: open the site in Chrome → Install app.
- Play-Store APK: `npx @bubblewrap/cli init --manifest https://YOUR-DOMAIN/manifest.json` then `bubblewrap build`. Replace `icon.svg` with 192/512 PNG icons first.

## Notes / limits
- Odia voice input/output depends on the device; if unsupported the app shows a message and falls back to the available voice.
- In Live mode, tap the orb to interrupt her (browsers can't reliably listen while speaking).
- Reminders fire as notifications only while the app is open; Calendar sync is not implemented (needs Google Calendar OAuth, which should be added with explicit user consent).
- Memory is only what the user adds; delete individually or all. "Delete all my data" wipes Firestore data for the account.
