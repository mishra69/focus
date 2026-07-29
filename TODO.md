# Focus — roadmap / parked work

Running list of follow-ups and design decisions, so they survive across sessions.

## Notifications / check-ins

- [x] **Server push renders on iOS** — switched completion push from declarative-only to a
  service-worker `push` handler (`sw.js`) + `sendWebPush`. Verified on-device. (`1387b12`)
- [x] **Count-up check-ins** — DO arms "Still focusing?" at 60m, then every 30m, capped at 6h,
  re-arming after each. Completion push TTL raised 10m → 6h; check-ins expire after 30m. (`d0f3fb1`)
- [x] **Abandonment: ask, don't silently bank** — on reopen of a count-up past the 2h mark, prompt
  Save (real elapsed) / Discard instead of auto-saving a 120-min cap. Recovery saves now use a
  **deterministic id derived from startTime**, so no path can double-count the same session.
- [ ] **"Mark done" from the check-in notification** — *needs the test account to verify the
  notification → server-write chain before it can touch real session data.* Plan:
  - `POST /api/active/finalize`: read `active:{userId}`, credit real elapsed as a session with a
    deterministic id (`Date.parse(startTime)`), delete active, cancel the alarm. Callable from the
    SW with no page open (SW fetch carries the session cookie).
  - Check-in notification gets `actions: [{done, keep}]`; SW `notificationclick` on `done` →
    `POST /api/active/finalize`. Renders on desktop/Android; **iOS ignores action buttons**, where
    "mark done" degrades to tap → open → existing Stop button (already works).
- [ ] **"Keep going" affordance on the abandonment prompt** — currently Save/Discard only; a genuine
  long session reopened late can't be resumed from the prompt (must Save then restart).

## Push infrastructure

- [ ] **Multi-device subscriptions** — `push:{userId}` holds ONE subscription, so only the
  last-subscribed device gets notifications (iPhone vs desktop fight over the slot). Store an array
  and fan out `sendWebPush` to all; prune on 404/410.
- [ ] **Logout cleanup** — `handleLogout` only clears the cookie. It leaves `active:{userId}`, the
  scheduled DO alarm, and `push:{userId}` live, so you keep getting that account's pushes (with
  check-ins, up to 6h of "Still focusing?" pings) after logging out. Logout should also
  `DELETE /api/active` (cancel alarm) and clear the push subscription.

## Testing

- [ ] **Test account** — sign in with a second Google account (isolated `*:{sub}` namespace, no code
  change). Use it in desktop Chrome for fast push iteration (DevTools + its own subscription slot).
- [ ] **Fast check-in cadence hook** — a test-only short cadence (~90s) so check-ins can be verified
  without waiting an hour. Gate to the test user or a `?fast` flag; never in prod default.

## Data hygiene

- Orphaned bare `sessions` KV key (no userId) — dead data from an older schema; safe to delete.
