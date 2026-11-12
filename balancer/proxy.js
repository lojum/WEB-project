const http = require('node:http');

const HOP_HEADERS = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer',
  'transfer-encoding', 'upgrade', 'x-internal-token',
]);

const agent = new http.Agent({ keepAlive: true, maxSockets: 64 });

function readBody(req, limit = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('Занадто великий запит'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function forward(backend, req, res, body) {
  return new Promise((resolve, reject) => {
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) if (!HOP_HEADERS.has(k)) headers[k] = v;
    headers['x-forwarded-for'] = req.socket.remoteAddress || '';
    headers['x-forwarded-proto'] = 'https';
    headers['x-forwarded-host'] = req.headers.host || '';
    headers['content-length'] = body.length;
    const upstream = http.request(`${backend.url}${req.url}`, { method: req.method, headers, agent, timeout: 30000 }, up => {
      const out = {};
      for (const [k, v] of Object.entries(up.headers)) if (!HOP_HEADERS.has(k)) out[k] = v;
      out['x-balanced-by'] = 'custom-lb';
      res.writeHead(up.statusCode, out);
      up.pipe(res);
      up.on('end', resolve);
      up.on('error', resolve);
    });
    upstream.on('timeout', () => upstream.destroy(new Error('timeout')));
    upstream.on('error', err => reject(Object.assign(err, { beforeResponse: !res.headersSent })));
    upstream.end(body);
  });
}

function sendJson(res, status, data) {
  const payload = JSON.stringify(data);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

async function proxy(pool, req, res, stats) {
  let body;
  try {
    body = await readBody(req);
  } catch (e) {
    return sendJson(res, e.status || 400, { error: e.message });
  }
  const tried = new Set();
  for (let attempt = 0; attempt < 3; attempt++) {
    const backend = pool.pickForRequest(tried);
    if (!backend) break;
    tried.add(backend.id);
    backend.requests += 1;
    stats.perBackend[backend.id] = (stats.perBackend[backend.id] || 0) + 1;
    try {
      await forward(backend, req, res, body);
      return;
    } catch (err) {
      backend.proxyErrors += 1;
      if (['ECONNREFUSED', 'ECONNRESET'].includes(err.code)) pool.markDown(backend, err.code);
      if (!err.beforeResponse) return res.destroy();
      const retriable = ['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH'].includes(err.code) && (req.method === 'GET' || err.code === 'ECONNREFUSED');
      if (!retriable) return sendJson(res, 502, { error: `Сервер ${backend.id} не відповів: ${err.message}` });
    }
  }
  sendJson(res, 503, { error: 'Немає доступних серверів застосувань. Спробуйте пізніше' });
}

module.exports = { proxy, sendJson, readBody };
