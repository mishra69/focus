# focus.

A minimal, no-nonsense focus timer PWA — a personal clone of the [Focus Friend](https://apps.apple.com/app/focus-friend) app. No skins, no decorations, no subscriptions — just a timer that counts your focus time and shows you your progress over time.

---

## What it does

**Timer tab**

Two modes depending on how you like to work:

- **Countdown** — set a target duration (10–120 min in 10-minute increments via a slider), start the timer, and work until it hits zero. You only get credit if you complete the full session. Stop early and the session is discarded.
- **Count Up** — start the timer and go. Work as long as you want. If you stop before 10 minutes the session is discarded. Hit 10 minutes or more and it saves whatever you accumulated.

A ring around the clock face fills as time progresses, shifting from green to blue to pink. Today's total focused time and session count are shown at the top.

**Screen lock (Wake Lock)**

While the timer is running the app requests a Wake Lock so your screen stays on — no need for a live activity widget. After 8 seconds of inactivity the screen dims to near-black to save battery (especially effective on OLED iPhones where black pixels are off). Tap anywhere to brighten it back up. While dimmed, the timer display only updates every 10 seconds to avoid unnecessary rendering.

**Report tab**

Three time ranges — Week, Month, All time — with:

- Total focused time
- Session count
- Daily average (across active days only)
- Best day
- Animated bar chart of daily/weekly focus time
- Recent sessions list with date, time, and duration

---

## Implementation

### Stack

Pure HTML, CSS, and vanilla JavaScript — no frameworks, no build tools, no dependencies. A single `index.html` file plus supporting files, backed by a Cloudflare Worker for auth and data persistence.

### Files

| File | Purpose |
|------|---------|
| `focus-app/index.html` | Entire app — markup, styles, and logic |
| `focus-app/manifest.json` | PWA manifest — name, theme color, icons, display mode |
| `focus-app/sw.js` | Service worker — network-first fetch with offline fallback |
| `focus-app/icon-192.png` | Home screen icon (192×192) |
| `focus-app/icon-512.png` | Home screen icon (512×512) |
| `worker.js` | Cloudflare Worker — handles auth, API routes, serves static assets |
| `wrangler.toml` | Cloudflare Workers config — KV binding, assets directory |

### Auth

Sign in with Google via OAuth 2.0, handled entirely in the Worker:

1. `GET /auth/login` — redirects to Google's OAuth consent screen
2. `GET /auth/callback` — exchanges the code for tokens, fetches user info, creates a session, sets an `HttpOnly` cookie
3. `GET /auth/logout` — clears the session cookie

Sessions are stored in KV as `session:{uuid} → { userId, name, email, picture }` with a 30-day TTL. The UUID in the cookie is unguessable — it maps to the user's Google ID server-side, never exposed to the client.

### Data persistence

Focus sessions are stored in Cloudflare KV under `sessions:{googleUserId}` as a JSON array of `{ id, date, duration }` objects. All devices signed in with the same Google account share the same key — sessions are synced across devices automatically.

Every session save costs 2 KV reads (auth token lookup + existing sessions) + 1 KV write.

Active sessions are tracked in KV under `active:{userId}` — written when a session starts, deleted when it ends. If the app is evicted mid-session, the next open recovers the elapsed time automatically. Count-up sessions are saved (capped at 2 hours). Countdown sessions are discarded — consistent with the full-completion rule. Zero periodic writes: one write on start, one delete on end.

### Timer logic

Both modes use a `setInterval` tick at 1-second intervals. Countdown decrements `remainingSeconds`; count up increments `elapsedSeconds`. The ring progress is calculated as a fraction of `CIRCUMFERENCE` (2π × 110px radius) and applied as `stroke-dashoffset` on an SVG circle.

Session credit rules:
- Countdown: full completion only
- Count up: minimum 10 minutes elapsed

### Wake Lock

Uses the [Screen Wake Lock API](https://developer.mozilla.org/en-US/docs/Web/API/Screen_Wake_Lock_API) (`navigator.wakeLock.request('screen')`) to prevent the screen from sleeping during a session. Automatically re-acquired if you switch tabs and return. Released on pause, stop, or session completion.

**Why Wake Lock instead of Live Activity:** The ideal solution would be an iOS Live Activity on the lock screen. However, Live Activities require a native iOS app (Swift/ActivityKit) or an Expo-based build with a developer account ($99/year). Since this app is a PWA with no Apple developer account, Live Activities are not available. Wake Lock is the closest equivalent — it keeps the screen on and the timer visible.

**TODO:** When Live Activity support becomes viable (either via improved PWA APIs, Expo, or a native build), this should be the first thing to switch to. The Wake Lock approach should be removed in favour of a proper lock screen widget that works even when the phone screen is off.

**Dim mode:** After 8 seconds a CSS `filter: brightness(0.15) saturate(0)` is applied to all UI elements over a black body background. On OLED screens this means most pixels are completely off, minimising battery drain while keeping the Wake Lock active. The timer display skips updates while dimmed, only refreshing every 10 seconds. Tap anywhere to restore full brightness.

### Service worker

Uses a **network-first** strategy: always fetches fresh content from the network, caches the response, and falls back to cache only when offline. This means deployments are picked up immediately on the next app open without requiring reinstall.

`/auth/*` and `/api/*` routes are excluded from the service worker entirely — the browser handles them natively so redirects and cookies work correctly.

### Install prompt

On first visit in a browser (not already installed as PWA), a bottom sheet prompts installation:

- **iOS Safari** — shows 3-step manual instructions (Share → Add to Home Screen → Add)
- **Android/Chrome** — intercepts `beforeinstallprompt` and shows a single button that triggers the native install prompt
- **Desktop Safari / Firefox** — no prompt (PWA install not supported)
- Dismissed state is stored in `sessionStorage` — reappears on next browser visit as a reminder

### Safe areas

`env(safe-area-inset-top)` is added to the nav padding to account for notches, Dynamic Island, and status bars across different devices. Degrades to base padding on devices without a notch.

### Reporting

Session data is fetched from KV and filtered client-side by time range. The bar chart is built from plain `div` elements with CSS height set proportionally to the maximum value in the period — animated in with a CSS cubic-bezier spring transition. No charting library used.

### Design

- **Background:** `#0a0a0f` near-black
- **Accent:** `#c8f564` yellow-green
- **Fonts:** [Fraunces](https://fonts.google.com/specimen/Fraunces) (display numerals) + [DM Mono](https://fonts.google.com/specimen/DM+Mono) (UI labels)
- Ring color shifts: green → blue (`#5b8df6`) → pink (`#f564a9`) as time progresses

---

## Deployment

Hosted on Cloudflare Workers. The Worker serves static assets and handles API routes.

**Prerequisites:**
- Cloudflare account with a KV namespace bound as `SESSIONS`
- Google OAuth 2.0 credentials with `https://focus.mishabhi.workers.dev/auth/callback` as an authorized redirect URI
- `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` set as Worker secrets via `wrangler secret put`

**To redeploy after changes:**

```bash
npx wrangler deploy
```

---

## Installing as a PWA on iPhone

1. Open the URL in **Safari**
2. Tap the Share button → **Add to Home Screen**
3. Tap **Add**

The app will appear on your home screen and open fullscreen with no browser chrome.
