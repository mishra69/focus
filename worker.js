import { DurableObject } from 'cloudflare:workers';

const APP_ORIGIN = 'https://focus.mishabhi.workers.dev';
const REDIRECT_URI = `${APP_ORIGIN}/auth/callback`;
const SCOPE = 'openid email profile';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/auth/login') return handleLogin(env);
    if (url.pathname === '/auth/callback') return handleCallback(request, env);
    if (url.pathname === '/auth/logout') return handleLogout();
    if (url.pathname === '/api/me') return handleMe(request, env);
    if (url.pathname === '/api/sessions') return handleSessions(request, env);
    if (url.pathname === '/api/active') return handleActive(request, env);
    if (url.pathname === '/api/log') return handleLog(request, env);
    if (url.pathname === '/api/push/key') return Response.json({ key: env.VAPID_PUBLIC_KEY });
    if (url.pathname === '/api/push/subscribe') return handlePushSubscribe(request, env);
    if (url.pathname === '/api/push/test') return handlePushTest(request, env);
    if (url.pathname === '/api/push/log') return handlePushLog(request, env);

    return env.ASSETS.fetch(request);
  }
};

// ── AUTH ──

function handleLogin(env) {
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: SCOPE,
    prompt: 'select_account'
  });
  return Response.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`, 302);
}

async function handleCallback(request, env) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  if (!code) return new Response('Missing code', { status: 400 });

  // Exchange code for tokens
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: REDIRECT_URI,
      grant_type: 'authorization_code'
    })
  });
  const tokens = await tokenRes.json();
  if (!tokens.access_token) return new Response('Auth failed', { status: 401 });

  // Get user info
  const userRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { Authorization: `Bearer ${tokens.access_token}` }
  });
  const user = await userRes.json();

  // Create session
  const sessionId = crypto.randomUUID();
  await env.SESSIONS.put(`session:${sessionId}`, JSON.stringify({
    userId: user.sub,
    name: user.name,
    email: user.email,
    picture: user.picture
  }), { expirationTtl: 60 * 60 * 24 * 30 }); // 30 days

  return new Response(null, {
    status: 302,
    headers: {
      Location: '/',
      'Set-Cookie': `session=${sessionId}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${60 * 60 * 24 * 30}`
    }
  });
}

function handleLogout() {
  return new Response(null, {
    status: 302,
    headers: {
      Location: '/',
      'Set-Cookie': 'session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0'
    }
  });
}

async function getSession(request, env) {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(/session=([^;]+)/);
  if (!match) return null;
  const data = await env.SESSIONS.get(`session:${match[1]}`);
  return data ? JSON.parse(data) : null;
}

// ── API ──

async function handleMe(request, env) {
  const session = await getSession(request, env);
  if (!session) return Response.json(null);
  return Response.json(session);
}

async function handleSessions(request, env) {
  const session = await getSession(request, env);
  if (!session) return new Response('Unauthorized', { status: 401 });

  const key = `sessions:${session.userId}`;

  if (request.method === 'GET') {
    const data = await env.SESSIONS.get(key);
    return Response.json(data ? JSON.parse(data) : []);
  }

  if (request.method === 'POST') {
    const newSession = await request.json();
    const data = await env.SESSIONS.get(key);
    const sessions = data ? JSON.parse(data) : [];
    // Idempotent by id so the client's offline-retry queue can't duplicate a session
    if (!sessions.some(s => s.id === newSession.id)) {
      sessions.unshift(newSession);
      await env.SESSIONS.put(key, JSON.stringify(sessions));
    }
    return Response.json({ ok: true });
  }

  return new Response('Method not allowed', { status: 405 });
}

// Stores the client's rolling diagnostic log so it can be inspected remotely.
async function handleLog(request, env) {
  const session = await getSession(request, env);
  if (!session) return new Response('Unauthorized', { status: 401 });

  // GET lets you read back the client log from a desktop browser that shares the session.
  if (request.method === 'GET') {
    const raw = await env.SESSIONS.get(`log:${session.userId}`);
    return new Response(raw || '[]', { headers: { 'Content-Type': 'application/json' } });
  }

  if (request.method === 'POST') {
    const body = await request.text();
    await env.SESSIONS.put(`log:${session.userId}`, body, { expirationTtl: 60 * 60 * 24 * 14 });
    return Response.json({ ok: true });
  }

  return new Response('Method not allowed', { status: 405 });
}

async function handleActive(request, env) {
  const session = await getSession(request, env);
  if (!session) return new Response('Unauthorized', { status: 401 });

  const key = `active:${session.userId}`;

  if (request.method === 'GET') {
    const data = await env.SESSIONS.get(key);
    return Response.json(data ? JSON.parse(data) : null);
  }

  if (request.method === 'POST') {
    const body = await request.json();
    await env.SESSIONS.put(key, JSON.stringify(body));
    // Schedule (or refresh) the server-side completion notification. Reschedule is idempotent.
    await scheduleCompletion(env, session.userId, body);
    return Response.json({ ok: true });
  }

  if (request.method === 'DELETE') {
    await env.SESSIONS.delete(key);
    await cancelCompletion(env, session.userId); // stop/complete/pause clears the pending alarm
    return Response.json({ ok: true });
  }

  return new Response('Method not allowed', { status: 405 });
}

// ── PUSH SUBSCRIPTIONS ──

async function handlePushSubscribe(request, env) {
  const session = await getSession(request, env);
  if (!session) return new Response('Unauthorized', { status: 401 });
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const sub = await request.json();
  await env.SESSIONS.put(`push:${session.userId}`, JSON.stringify(sub));
  await pushLog(env, session.userId, 'subscribe', { host: hostOf(sub.endpoint) });
  return Response.json({ ok: true });
}

// Fire a one-off push on demand to verify delivery without waiting out a countdown.
// Returns the push service's HTTP status (201 = accepted; 403 VAPID; 400 encryption; 410 gone).
async function handlePushTest(request, env) {
  const session = await getSession(request, env);
  if (!session) return new Response('Unauthorized', { status: 401 });

  const raw = await env.SESSIONS.get(`push:${session.userId}`);
  if (!raw) {
    await pushLog(env, session.userId, 'test-no-subscription');
    return Response.json({ ok: false, error: 'no subscription stored' }, { status: 404 });
  }

  const payload = JSON.stringify({
    web_push: 8030,
    notification: {
      title: 'Focus',
      body: 'Test notification ✅',
      navigate: `${APP_ORIGIN}/`,
      icon: '/icon-192.png',
      tag: 'focus-test'
    }
  });

  let status = 0, error = null;
  try {
    const res = await sendDeclarativePush(env, JSON.parse(raw), payload);
    status = res.status;
    if (res.status === 404 || res.status === 410) await env.SESSIONS.delete(`push:${session.userId}`);
  } catch (e) {
    error = String((e && e.message) || e);
  }
  await pushLog(env, session.userId, 'test-send', { status, error });
  return Response.json({ ok: status >= 200 && status < 300, status, error });
}

// Read back the server-side push event log (separate key from the client log so neither clobbers
// the other). Viewable from a desktop browser that shares the session.
async function handlePushLog(request, env) {
  const session = await getSession(request, env);
  if (!session) return new Response('Unauthorized', { status: 401 });
  const raw = await env.SESSIONS.get(`pushlog:${session.userId}`);
  return new Response(raw || '[]', { headers: { 'Content-Type': 'application/json' } });
}

// Rolling diagnostic buffer for the server push flow, mirrored to KV under pushlog:{userId}.
async function pushLog(env, userId, event, data) {
  try {
    const key = `pushlog:${userId}`;
    const raw = await env.SESSIONS.get(key);
    const log = raw ? JSON.parse(raw) : [];
    const entry = { t: new Date().toISOString(), e: event };
    if (data !== undefined) entry.d = data;
    log.push(entry);
    while (log.length > 50) log.shift();
    await env.SESSIONS.put(key, JSON.stringify(log), { expirationTtl: 60 * 60 * 24 * 14 });
  } catch (e) {}
}

// Log the push endpoint's host only — the full endpoint is a capability URL we don't want in logs.
function hostOf(url) {
  try { return new URL(url).host; } catch (e) { return null; }
}

// ── COMPLETION SCHEDULING (Durable Object alarm per user) ──

function timerStub(env, userId) {
  return env.FOCUS_TIMER.get(env.FOCUS_TIMER.idFromName(userId));
}

// Countdown sessions get an alarm at their completion instant; anything else clears it.
async function scheduleCompletion(env, userId, active) {
  try {
    const stub = timerStub(env, userId);
    if (active && active.mode === 'countdown' && active.duration && active.startTime) {
      const fireAt = Date.parse(active.startTime) + active.duration * 1000;
      if (fireAt > Date.now()) {
        await stub.schedule(userId, fireAt);
        await pushLog(env, userId, 'schedule', { fireAt: new Date(fireAt).toISOString() });
        return;
      }
    }
    await stub.cancel();
    await pushLog(env, userId, 'schedule-skip', { mode: active && active.mode });
  } catch (e) {
    await pushLog(env, userId, 'schedule-error', { msg: String((e && e.message) || e) });
  }
}

async function cancelCompletion(env, userId) {
  try {
    await timerStub(env, userId).cancel();
    await pushLog(env, userId, 'cancel');
  } catch (e) {}
}

// ── DURABLE OBJECT: one per user, fires the completion push via setAlarm() ──

export class FocusTimerDO extends DurableObject {
  async schedule(userId, fireAt) {
    await this.ctx.storage.put('userId', userId);
    await this.ctx.storage.setAlarm(fireAt);
  }

  async cancel() {
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.delete('userId');
  }

  async alarm(alarmInfo) {
    const userId = await this.ctx.storage.get('userId');
    if (!userId) return;
    await pushLog(this.env, userId, 'alarm-fire', { retry: alarmInfo && alarmInfo.retryCount });

    const raw = await this.env.SESSIONS.get(`push:${userId}`);
    if (!raw) { // never subscribed
      await pushLog(this.env, userId, 'alarm-no-subscription');
      await this.ctx.storage.delete('userId');
      return;
    }

    const sub = JSON.parse(raw);
    const payload = JSON.stringify({
      web_push: 8030,
      notification: {
        title: 'Focus',
        body: 'Session complete 🎉',
        navigate: `${APP_ORIGIN}/`,
        icon: '/icon-192.png',
        tag: 'focus-complete'
      }
    });

    let res;
    try {
      res = await sendDeclarativePush(this.env, sub, payload);
    } catch (e) {
      await pushLog(this.env, userId, 'alarm-send-error', { msg: String((e && e.message) || e) });
      if (alarmInfo && alarmInfo.retryCount >= 5) { await this.ctx.storage.delete('userId'); return; }
      throw e; // let the alarm retry with backoff
    }

    await pushLog(this.env, userId, 'alarm-send', { status: res.status });
    if (res.status === 404 || res.status === 410) {
      await this.env.SESSIONS.delete(`push:${userId}`); // subscription gone for good
    } else if (!res.ok) {
      // Transient push-service error: let the alarm retry with backoff, then give up.
      if (alarmInfo && alarmInfo.retryCount >= 5) { await this.ctx.storage.delete('userId'); return; }
      throw new Error(`push failed: ${res.status}`);
    }
    await this.ctx.storage.delete('userId');
  }
}

// ── WEB PUSH: RFC 8291 (aes128gcm payload) + RFC 8292 (VAPID) ──

// Declarative push: the encrypted body is application/notification+json, so Safari renders
// it directly without a service-worker `push` event handler.
async function sendDeclarativePush(env, sub, payloadJson) {
  const body = await encryptPayload(payloadJson, sub.keys.p256dh, sub.keys.auth);
  const authorization = await vapidAuthHeader(env, sub.endpoint);
  return fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      'TTL': '600',
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/notification+json',
      'Urgency': 'high',
      'Authorization': authorization
    },
    body
  });
}

async function vapidAuthHeader(env, endpoint) {
  const header = { typ: 'JWT', alg: 'ES256' };
  const claims = {
    aud: new URL(endpoint).origin,
    exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60, // < 24h per spec
    sub: 'mailto:mishabhi@gmail.com'
  };
  const enc = o => bytesToB64url(new TextEncoder().encode(JSON.stringify(o)));
  const signingInput = `${enc(header)}.${enc(claims)}`;

  const key = await crypto.subtle.importKey(
    'jwk', JSON.parse(env.VAPID_PRIVATE_JWK),
    { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']
  );
  // WebCrypto ECDSA returns raw r||s — already the JOSE signature format.
  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(signingInput)
  );
  return `vapid t=${signingInput}.${bytesToB64url(sig)}, k=${env.VAPID_PUBLIC_KEY}`;
}

async function encryptPayload(plaintext, p256dhB64, authB64) {
  const uaPublic = b64urlToBytes(p256dhB64);  // recipient public key, 65 bytes
  const authSecret = b64urlToBytes(authB64);  // 16 bytes

  // Ephemeral application-server ECDH keypair.
  const asKeys = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', asKeys.publicKey)); // 65 bytes

  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdhSecret = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, asKeys.privateKey, 256)
  );

  // IKM = HKDF(salt=auth, ikm=ecdh, info="WebPush: info\0"||ua_public||as_public)
  const keyInfo = concatBytes(new TextEncoder().encode('WebPush: info\0'), uaPublic, asPublic);
  const ecdhKey = await crypto.subtle.importKey('raw', ecdhSecret, 'HKDF', false, ['deriveBits']);
  const ikm = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: authSecret, info: keyInfo }, ecdhKey, 256)
  );

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const ikmKey = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const cek = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info: new TextEncoder().encode('Content-Encoding: aes128gcm\0') }, ikmKey, 128
  ));
  const nonce = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info: new TextEncoder().encode('Content-Encoding: nonce\0') }, ikmKey, 96
  ));

  // Single record: plaintext followed by the 0x02 last-record delimiter (RFC 8188).
  const record = concatBytes(new TextEncoder().encode(plaintext), new Uint8Array([2]));
  const aesKey = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['encrypt']);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, record));

  // aes128gcm header: salt(16) | rs(4, BE) | idlen(1) | keyid(as_public)
  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, 4096);
  const header = concatBytes(salt, rs, new Uint8Array([asPublic.length]), asPublic);
  return concatBytes(header, ciphertext);
}

function concatBytes(...arrays) {
  let len = 0;
  for (const a of arrays) len += a.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const a of arrays) { out.set(a, off); off += a.length; }
  return out;
}

function b64urlToBytes(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = s.length % 4;
  if (pad) s += '='.repeat(4 - pad);
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64url(buf) {
  const arr = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
