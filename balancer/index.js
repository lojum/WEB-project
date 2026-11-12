const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const selfsigned = require('selfsigned');
const config = require('../config');
const db = require('../common/db');
const { Pool } = require('./pool');
const Scheduler = require('./scheduler');
const Autoscaler = require('./autoscaler');
const createAdmin = require('./admin');
const { proxy, sendJson } = require('./proxy');

async function loadCertificate() {
  const keyFile = path.join(config.CERT_DIR, 'server.key');
  const certFile = path.join(config.CERT_DIR, 'server.crt');
  if (!fs.existsSync(keyFile) || !fs.existsSync(certFile)) {
    const notAfterDate = new Date();
    notAfterDate.setFullYear(notAfterDate.getFullYear() + 1);
    const pems = await selfsigned.generate([{ name: 'commonName', value: 'localhost' }], {
      keySize: 2048,
      notAfterDate,
      extensions: [{ name: 'subjectAltName', altNames: [{ type: 2, value: 'localhost' }, { type: 7, ip: '127.0.0.1' }] }],
    });
    fs.writeFileSync(keyFile, pems.private);
    fs.writeFileSync(certFile, pems.cert);
    console.log(`[balancer] згенеровано самопідписаний сертифікат: ${certFile}`);
  }
  return { key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) };
}

async function main() {
  await db.init();

  const events = [];
  const pool = new Pool(events);
  const scheduler = new Scheduler(pool);
  const autoscaler = new Autoscaler(pool, scheduler);
  const stats = { total: 0, window: [], perBackend: {} };
  const handleAdmin = createAdmin({ pool, scheduler, autoscaler, stats, startedAt: Date.now() });

  config.EXTERNAL_SERVERS.forEach((url, i) => pool.addExternal(url, i));
  for (let i = pool.backends.length; i < config.MIN_SERVERS; i++) pool.spawn();

  pool.startHealthChecks();
  scheduler.start();
  autoscaler.start();

  const handler = (req, res) => {
    stats.total += 1;
    stats.window.push(Date.now());
    if (stats.window.length > 5000) stats.window.splice(0, 1000);
    const url = new URL(req.url, 'https://localhost');
    res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    if (url.pathname.startsWith('/internal')) return sendJson(res, 404, { error: 'Не знайдено' });
    if (url.pathname.startsWith('/api/admin/')) return handleAdmin(req, res, url);
    return proxy(pool, req, res, stats);
  };

  const tls = await loadCertificate();
  const server = https.createServer(tls, handler);
  server.listen(config.LB_HTTPS_PORT, config.LB_HOST, () => {
    console.log(`[balancer] HTTPS: https://localhost:${config.LB_HTTPS_PORT}`);
  });

  const redirect = http.createServer((req, res) => {
    const host = (req.headers.host || 'localhost').replace(/:\d+$/, '');
    res.writeHead(301, { location: `https://${host}:${config.LB_HTTPS_PORT}${req.url}` });
    res.end();
  });
  redirect.listen(config.LB_HTTP_PORT, config.LB_HOST, () => {
    console.log(`[balancer] HTTP → HTTPS перенаправлення: http://localhost:${config.LB_HTTP_PORT}`);
  });

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    console.log('[balancer] зупинка...');
    scheduler.stop();
    autoscaler.stop();
    server.close();
    redirect.close();
    await pool.shutdownAll();
    await db.pool.end().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch(e => {
  console.error('[balancer] не вдалося запустити:', e.message);
  process.exit(1);
});
