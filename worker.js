export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/sessions') {
      if (request.method === 'GET') {
        const data = await env.SESSIONS.get('sessions');
        return Response.json(data ? JSON.parse(data) : []);
      }

      if (request.method === 'POST') {
        const session = await request.json();
        const data = await env.SESSIONS.get('sessions');
        const sessions = data ? JSON.parse(data) : [];
        sessions.unshift(session);
        await env.SESSIONS.put('sessions', JSON.stringify(sessions));
        return Response.json({ ok: true });
      }

      return new Response('Method not allowed', { status: 405 });
    }

    return env.ASSETS.fetch(request);
  }
};
