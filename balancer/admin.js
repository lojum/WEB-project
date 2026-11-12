const os = require('node:os');
const config = require('../config');
const db = require('../common/db');
const auth = require('../common/auth');
const { sendJson } = require('./proxy');

function createAdmin({ pool, scheduler, autoscaler, stats, startedAt }) {
  async function overview() {
    const [counts, running, queued, users] = await Promise.all([
      db.many('SELECT status, COUNT(*)::int AS c FROM tasks GROUP BY status'),
      db.many(
        `SELECT t.id, t.n, t.progress, t.stage, t.server_id, t.started_at, t.attempts, u.username
         FROM tasks t JOIN users u ON u.id = t.user_id WHERE t.status = 'running' ORDER BY t.started_at`,
      ),
      db.many(
        `SELECT t.id, t.n, t.queue_position, t.eta, t.created_at, u.username
         FROM tasks t JOIN users u ON u.id = t.user_id WHERE t.status = 'queued' ORDER BY t.id`,
      ),
      db.one('SELECT COUNT(*)::int AS c FROM users'),
    ]);
    const now = Date.now();
    stats.window = stats.window.filter(t => now - t < 10000);
    return {
      balancer: {
        uptime: (now - startedAt) / 1000,
        pid: process.pid,
        totalRequests: stats.total,
        rps: stats.window.length / 10,
        perBackend: stats.perBackend,
        dispatched: scheduler.dispatched,
        requestAlgorithm: 'Адаптивний плавний зважений Round Robin (Smooth Weighted RR)',
        taskAlgorithm: 'Мінімальний очікуваний час завершення (Minimum Completion Time)',
        host: { cpus: os.cpus().length, loadavg: os.loadavg(), totalmem: os.totalmem(), freemem: os.freemem() },
      },
      autoscaler: autoscaler.info(),
      limits: {
        maxN: config.MAX_N,
        maxManualN: config.MAX_MANUAL_N,
        timeLimit: config.TASK_TIME_LIMIT / 1000,
        maxActivePerUser: config.MAX_ACTIVE_PER_USER,
        maxHistoryPerUser: config.MAX_HISTORY_PER_USER,
        maxQueue: config.MAX_QUEUE,
        slotsPerServer: config.SLOTS_PER_SERVER,
      },
      servers: pool.backends.map(b => b.toJSON()),
      counts: Object.fromEntries(counts.map(r => [r.status, r.c])),
      users: users.c,
      running,
      queued,
      events: pool.events.slice(-60).reverse(),
      decisions: scheduler.decisions.slice(0, 20),
    };
  }

  return async function handleAdmin(req, res, url) {
    const user = auth.userFromHeader(req.headers.authorization);
    if (!user) return sendJson(res, 401, { error: 'Необхідна авторизація' });
    if (!user.isAdmin) return sendJson(res, 403, { error: 'Доступ лише для адміністратора' });
    try {
      const parts = url.pathname.split('/').filter(Boolean);
      if (req.method === 'GET' && url.pathname === '/api/admin/overview') {
        return sendJson(res, 200, await overview());
      }
      if (req.method === 'POST' && url.pathname === '/api/admin/servers') {
        const active = pool.backends.filter(b => b.state !== 'stopped' && b.state !== 'draining').length;
        if (active >= config.MAX_SERVERS) {
          return sendJson(res, 409, { error: `Досягнуто максимальну кількість серверів (${config.MAX_SERVERS})` });
        }
        const b = pool.spawn({ dynamic: true, reason: `запуск адміністратором ${user.username}` });
        return sendJson(res, 201, { id: b.id });
      }
      if (parts[2] === 'servers' && parts[3]) {
        const backend = pool.get(parts[3]);
        if (!backend) return sendJson(res, 404, { error: 'Сервер не знайдено' });
        if (req.method === 'POST' && parts[4] === 'kill') {
          if (!pool.kill(backend)) return sendJson(res, 409, { error: 'Сервер не керується балансувальником' });
          return sendJson(res, 200, { ok: true });
        }
        if (req.method === 'DELETE') {
          if (!backend.dynamic) return sendJson(res, 409, { error: 'Базові сервери не зупиняються (мінімум для роботи)' });
          pool.stop(backend, `зупинка адміністратором ${user.username}`);
          return sendJson(res, 200, { ok: true });
        }
      }
      return sendJson(res, 404, { error: 'Не знайдено' });
    } catch (e) {
      console.error('[admin]', e);
      return sendJson(res, 500, { error: 'Внутрішня помилка' });
    }
  };
}

module.exports = createAdmin;
