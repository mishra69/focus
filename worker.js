const REDIRECT_URI = 'https://focus.mishabhi.workers.dev/auth/callback';
const SCOPE = 'openid email profile';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/auth/login') return handleLogin(env);
    if (url.pathname === '/auth/callback') return handleCallback(request, env);
    if (url.pathname === '/auth/logout') return handleLogout();
    if (url.pathname === '/api/me') return handleMe(request, env);
    if (url.pathname === '/api/sessions') return handleSessions(request, env);

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
    sessions.unshift(newSession);
    await env.SESSIONS.put(key, JSON.stringify(sessions));
    return Response.json({ ok: true });
  }

  return new Response('Method not allowed', { status: 405 });
}
