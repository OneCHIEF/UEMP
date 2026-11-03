const crypto = require('node:crypto');
const { handleRequest, initialize } = require('../server');

module.exports = async function varsityOneApiRouter(req, res) {
  const incoming = new URL(req.url || '/', 'https://uemp.local');
  const route = incoming.searchParams.get('__uemp_path');
  if (!route || !/^[a-zA-Z0-9_/-]+$/.test(route) || route.split('/').includes('..')) {
    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ error: 'That VarsityONE endpoint does not exist.' }));
    return;
  }

  incoming.searchParams.delete('__uemp_path');
  req.url = `/api/${route}${incoming.searchParams.size ? `?${incoming.searchParams.toString()}` : ''}`;
  try {
    await initialize();
    await handleRequest(req, res);
  } catch (error) {
    const requestId = crypto.randomUUID();
    console.error(JSON.stringify({
      level: 'error',
      event: 'api.initialization_failed',
      requestId,
      message: error.message,
    }));
    res.writeHead(503, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Retry-After': '5',
      'X-Request-Id': requestId,
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(JSON.stringify({ error: 'VarsityONE is temporarily unavailable. Please try again shortly.', requestId }));
  }
};
