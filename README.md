# ConnectX AI — Next-Generation Messaging Platform

A working messaging platform with a real backend, database, authentication and
real-time messaging: 1:1 and group chats, communities with multiple channels
(including admin-only broadcast channels), 1:1 WebRTC voice/video calls, polls,
scheduled and disappearing messages, and a privacy-first built-in AI assistant.

Built as a staged MVP: the core (auth, real-time messaging, groups, media) is
fully functional today; calling, AI and community tools are layered on top of
the same API. This README is deliberately honest about what is **not** in this
build — see [Honest limits](#honest-limits).

---

## Quick start

```bash
npm install
npm start          # http://localhost:3000
```

That is all. The SQLite database is created automatically at
`data/connectx.db` on first run (Node's built-in `node:sqlite` — no database
server to install). Copy `.env.example` to `.env` to change the port, JWT
secret, upload limits, etc.

Requirements: **Node.js ≥ 22.5** (for `node:sqlite`).

Run the test suite (25 end-to-end tests — real server, real WebSockets):

```bash
npm test
```

---

## What's implemented

### Accounts & security
- Register / login with **email or phone number** as the identifier, bcrypt-hashed passwords (never plain text), JWT sessions stored server-side so any session can be revoked.
- **Devices & Sessions** page: list every signed-in device, revoke any of them (a revoked token dies immediately).
- Login **rate limiting** (lockout after repeated failures), password change, password-reset token flow, account deletion, and a full **data export** (JSON — only your own data).
- Profiles: name, bio, avatar upload; privacy controls for **profile-photo visibility** and **last-seen / online status** (`everyone` / `nobody`), enforced in API responses.
- Block / unblock and report (user or message) — blocking stops DM creation and message delivery between the two users.

### Real-time messaging (WebSocket + REST history)
- 1:1 DMs and group chats, delivered instantly over WebSocket with paginated REST history (works across devices — sign in anywhere, history is on the server).
- **Delivery & read receipts** (per-message), **typing indicators**, online/last-seen presence (privacy-respecting).
- Reply-to, edit (marked "edited"), delete-for-everyone, **reactions**, **pin** (per conversation) and **star** (per user), full-text **message search** with sender/date/conversation filters.
- Attachments: images, videos, documents and **voice notes** (in-browser recording), ≤ 25 MB, type-validated server-side, and downloads are restricted to conversation participants.
- **Disappearing messages** per conversation (server sweep deletes expired messages), **scheduled messages** (delivered by the server even if you go offline), drafts (saved locally per chat), unread counters.
- Per-chat **mute / Focus Mode** (silence until a time you choose), **Smart Inbox categories** (Personal / Work / Family / Community), per-conversation **chat wallpapers**, and a **low-data mode** that stops images auto-loading.
- In-app **notifications** list (also pushed live over the socket).

### Groups & communities
- Groups: creator is admin; **only admins** can rename, change the disappearing timer, add/remove members (enforced server-side, 403 otherwise). Invite-link joining. **Temporary groups** that auto-archive (read-only) at their expiry time.
- Communities: a container with multiple channels; joining a community joins its channels. **Broadcast channels** where only admins can post. Community admins can create channels and promote/demote members. **Polls** in any group/channel with live vote counts.

### Calls (WebRTC, 1:1)
- 1:1 **voice and video calls** using WebRTC with signaling relayed over the same WebSocket — the server forwards offers/answers/ICE **only** to the other participant of that DM.
- Mic/camera mute, speaker switching (where the browser supports `setSinkId`), **screen sharing** via `getDisplayMedia` where supported — otherwise the UI says so plainly.
- **Call history** (incoming/outgoing, missed/declined, duration). A basic connection-state indicator is shown and labelled basic.

### AI assistant (optional, local by default)
- Built-in assistant chat: writing help (leave applications, meeting requests, follow-ups, introductions), a small built-in **Hindi⇄English common-phrase translator**, and reply suggestions.
- **"Summarize this chat"** runs an extractive summary on the server, only when the user presses the button in that conversation. Private chats are **never** sent to the assistant automatically.
- Optional OpenAI-compatible provider behind `AI_API_KEY` (off by default; receives only the dedicated assistant chat). This route is provided for integration and is **untested with a live key**.

### Pages (single-page app)
Landing, Login, Register, Chat dashboard, Conversation, Groups, Communities & Channels, Calling UI, AI Assistant, Notifications, Privacy & Security settings, Devices & Sessions, Discover/Contacts, Starred, Help & Support, Terms of Service and Privacy Policy. Light/dark themes, fully responsive (mobile layout collapses to one panel with a back button).

---

## Honest limits

Read this before deploying or demoing:

- **No end-to-end encryption.** Messages are protected in transit when served over HTTPS/WSS and are stored server-side (that is what makes multi-device sync work here). End-to-end encryption is **NOT implemented in this version** — the UI (Settings → Privacy, Privacy Policy) says exactly this. Do not market this build as E2EE.
- **Group calls are not available** — calls are 1:1 only. The UI states this instead of showing a fake button.
- **SMS verification is not implemented.** A phone number works as a login identifier with a password; no OTP is sent. Email verification and password-reset **emails** are likewise not sent (no SMTP configured): in non-production mode the reset token is returned in the API response and logged to the server console so the flow can be tested.
- **Push notifications** are in-app only (list + live socket + badges). There is no FCM/APNs integration in this build.
- **SQLite is the zero-setup local database.** It is right for local use, demos and small deployments. For production scale, migrate to PostgreSQL — see below. No load testing has been done, so **no user-scale claims** are made.
- Screen sharing and speaker switching depend on the browser/device; the UI reports when they are unavailable instead of failing silently.
- Voice notes record in the browser (`MediaRecorder`); formats vary by browser.

---

## Architecture

```
connectx-ai/
├── server/
│   ├── server.js   Express app + HTTP server + background sweeps
│   ├── db.js       SQLite schema + helpers (node:sqlite)
│   ├── auth.js     bcrypt, JWT sessions, rate limiting, privacy shaping
│   ├── core.js     Shared messaging rules (REST + WS use the same code)
│   ├── routes.js   Auth, users, settings, notifications, uploads, AI
│   ├── routes2.js  Conversations, messages, polls, communities, calls, search
│   ├── ws.js       WebSocket hub: messages, typing, receipts, presence, WebRTC signaling
│   └── ai.js       Built-in assistant, phrase translator, extractive summarizer
├── public/         Vanilla HTML/CSS/JS single-page app (no build step)
├── tests/          node:test end-to-end suite
├── data/           SQLite database (auto-created)
└── uploads/        Attachment + avatar files on disk (never in the DB)
```

- **One port** serves the SPA, REST API (`/api/...`) and WebSocket (`/ws?token=<JWT>`).
- The API + WebSocket protocol are framework-agnostic: the bundled frontend is vanilla JS for zero-build simplicity, and a **Next.js or React Native client can be built against the same backend** later.
- Posting rules (membership, admin roles, broadcast channels, blocks, archived groups) live in `core.js` and are enforced identically for REST posts and WebSocket sends.
- **Background sweeps** (every `SWEEP_MS`, default 1s): delete expired disappearing messages, deliver due scheduled messages, archive expired temporary groups.
- Uploaded files live on disk under `uploads/attachments/` (avatars under `uploads/avatars/`); the database stores metadata only. For multi-instance production, swap the disk layer for S3-compatible object storage — the attachment rows already carry everything needed (name, MIME, size).

### WebSocket protocol (summary)
Client → server: `message`, `typing`, `read`, `signal` (WebRTC payloads), `call-event` (`invite`/`accept`/`decline`/`end`), `ping`.
Server → client: `ready`, `message`, `message-updated`, `typing`, `receipt`, `presence`, `notification`, `conversation-updated`, `signal`, `call-event`, `error`.

### Database
Tables: `users`, `sessions`, `password_resets`, `communities`, `community_members`, `conversations`, `participants` (role, mute, category, wallpaper, last-read), `messages` (reply/edit/disappearing/scheduled), `attachments`, `message_receipts`, `reactions`, `pins`, `stars`, `polls`, `poll_options`, `poll_votes`, `calls`, `notifications`, `blocks`, `reports`, `user_settings`. Key indexes: `messages(conversation_id, id)`, `participants(user_id)`, `notifications(user_id, is_read)`.

#### Migrating to PostgreSQL
The schema uses near-standard SQL. To migrate: create the same tables in Postgres (change `INTEGER PRIMARY KEY AUTOINCREMENT` → `BIGSERIAL PRIMARY KEY`, `INSERT OR IGNORE` → `ON CONFLICT DO NOTHING`), point `db.js` at a `pg` pool behind the same `run/get/all` helper signatures, and keep everything else. The codebase intentionally avoids SQLite-only features beyond those two constructs.

---

## Deployment notes

- Set a strong `JWT_SECRET` and `NODE_ENV=production` (this also stops reset tokens being returned in API responses).
- Put the app behind a reverse proxy (nginx/Caddy) with **HTTPS** — WebRTC and `wss://` require a secure origin in production. Proxy `/`, `/api`, `/files` and upgrade `/ws`.
- Persist `data/` and `uploads/` (or set `DB_PATH` / `UPLOAD_DIR` to mounted volumes).
- `docker` example: `node:22-alpine`, `npm ci --omit=dev`, run `node server/server.js` with the volumes above mounted.
- Never commit `.env` or real secrets; no secrets exist in the frontend code.

## Testing

`npm test` starts the real server on a throwaway database and verifies, among other things: bcrypt hashing, wrong-password rejection, login rate limiting, session revocation, real WebSocket DM delivery + history pagination, delivery→read receipts, typing relay, admin-only group rename (403), broadcast-channel posting rules, attachment type validation + participant-only downloads, edit/delete ownership, reactions, search, blocking, disappearing-message expiry, scheduled delivery, poll counts, WebRTC signaling isolation (a third user receives nothing), last-seen privacy, own-data-only export, and the built-in AI assistant/summarizer.

## Business model (as specified)

Core messaging is free. Intended future revenue: premium themes, business accounts/tools, advanced community management, extra cloud storage, premium AI features. Private message content is never sold and never used for targeted advertising.
