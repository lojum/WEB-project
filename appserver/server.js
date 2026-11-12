const os = require('node:os');
const express = require('express');
const config = require('../config');
const db = require('../common/db');
const auth = require('../common/auth');
const { workUnits, benchmark } = require('../common/solver');
const Executor = require('./executor');

const SERVER_ID = process.env.SERVER_ID || `app-${process.pid}`;
const PORT = parseInt(process.env.PORT || '9001', 10);
const HOST = process.env.HOST || config.APP_HOST;
const SLOTS = parseInt(process.env.SLOTS || String(config.SLOTS_PER_SERVER), 10);

const executor = new Executor(SERVER_ID, SLOTS);
const startedAt = Date.now();
let speed = 0;
let requests = 0;
let cpuPercent = 0;
let lastCpu = process.cpuUsage();
let lastCpuTime = process.hrtime.bigint();

setInterval(() => {
  const now = process.hrtime.bigint();
  const usage = process.cpuUsage(lastCpu);
  const elapsedUs = Number(now - lastCpuTime) / 1000;
  cpuPercent = elapsedUs > 0 ? ((usage.user + usage.system) / elapsedUs) * 100 : 0;
  lastCpu = process.cpuUsage();
  lastCpuTime = now;
}, 1000).unref();

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const app = express();
app.disable('x-powered-by');
app.use((req, res, next) => {
  requests += 1;
  res.setHeader('X-Served-By', SERVER_ID);
  next();
});
app.use(express.json({ limit: '2mb' }));

function requireUser(req, res, next) {
  const user = auth.userFromHeader(req.headers.authorization);
  if (!user) throw new HttpError(401, 'Необхідна авторизація');
  req.user = user;
  next();
}

function requireInternal(req, res, next) {
  if (req.headers['x-internal-token'] !== config.INTERNAL_TOKEN) throw new HttpError(403, 'Заборонено');
  next();
}

function publicTask(row, withDetails = false) {
  const task = {
    id: row.id,
    status: row.status,
    n: row.n,
    mode: row.mode,
    seed: row.seed,
    progress: row.progress,
    stage: row.stage,
    serverId: row.server_id,
    error: row.error,
    cancelRequested: row.cancel_requested,
    queuePosition: row.queue_position,
    eta: row.eta,
    estimatedTime: speed ? row.work / speed : null,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
  if (row.username) task.username = row.username;
  if (withDetails) {
    task.result = row.result ? JSON.parse(row.result) : null;
    task.input = row.input_data ? JSON.parse(row.input_data) : null;
  }
  return task;
}

const limits = () => ({
  minN: config.MIN_N,
  maxN: config.MAX_N,
  maxManualN: config.MAX_MANUAL_N,
  timeLimit: config.TASK_TIME_LIMIT / 1000,
  maxActivePerUser: config.MAX_ACTIVE_PER_USER,
  maxHistoryPerUser: config.MAX_HISTORY_PER_USER,
  maxQueue: config.MAX_QUEUE,
  speed,
});

function validateCredentials(body) {
  const username = String(body?.username || '').trim();
  const password = String(body?.password || '');
  if (!/^[A-Za-z0-9_.-]{3,32}$/.test(username)) {
    throw new HttpError(400, "Логін: 3–32 символи (латиниця, цифри, _ . -)");
  }
  if (password.length < 6 || password.length > 128) throw new HttpError(400, 'Пароль: від 6 до 128 символів');
  return { username, password };
}

app.post('/api/auth/register', async (req, res) => {
  const { username, password } = validateCredentials(req.body);
  const user = await db.one(
    `INSERT INTO users (username, password_hash, is_admin, created_at) VALUES ($1, $2, FALSE, $3)
     ON CONFLICT (username) DO NOTHING RETURNING id, username, is_admin`,
    [username, auth.hashPassword(password), Date.now()],
  );
  if (!user) throw new HttpError(409, 'Користувач з таким логіном вже існує');
  res.status(201).json({ token: auth.createToken(user), user: { id: user.id, username: user.username, isAdmin: user.is_admin } });
});

app.post('/api/auth/login', async (req, res) => {
  const { username, password } = validateCredentials(req.body);
  const user = await db.one('SELECT * FROM users WHERE username = $1', [username]);
  if (!user || !auth.verifyPassword(password, user.password_hash)) throw new HttpError(401, 'Невірний логін або пароль');
  res.json({ token: auth.createToken(user), user: { id: user.id, username: user.username, isAdmin: user.is_admin } });
});

app.get('/api/me', requireUser, (req, res) => res.json(req.user));

app.get('/api/limits', (req, res) => res.json(limits()));

function validateTask(body) {
  const n = Number(body?.n);
  const mode = body?.mode === 'manual' ? 'manual' : 'random';
  if (!Number.isInteger(n) || n < config.MIN_N || n > config.MAX_N) {
    throw new HttpError(400, `Кількість невідомих має бути цілим числом від ${config.MIN_N} до ${config.MAX_N}`);
  }
  let seed = null;
  let input = null;
  if (mode === 'random') {
    seed = body.seed === undefined || body.seed === null || body.seed === '' ? Math.floor(Math.random() * 1e9) : Number(body.seed);
    if (!Number.isInteger(seed) || seed < 0 || seed > 2147483647) throw new HttpError(400, 'Seed має бути цілим числом від 0 до 2147483647');
  } else {
    if (n > config.MAX_MANUAL_N) throw new HttpError(400, `При ручному введенні n ≤ ${config.MAX_MANUAL_N}`);
    const { a, b } = body;
    const okRow = row => Array.isArray(row) && row.length === n && row.every(v => typeof v === 'number' && Number.isFinite(v));
    if (!Array.isArray(a) || a.length !== n || !a.every(okRow)) throw new HttpError(400, `Матриця A має бути розміру ${n}×${n}`);
    if (!okRow(b)) throw new HttpError(400, `Вектор b має містити ${n} чисел`);
    input = { a, b };
  }
  const work = workUnits(n);
  if (speed && work / speed > config.TASK_TIME_LIMIT / 1000) {
    throw new HttpError(400, `Оцінений час обчислення (${(work / speed).toFixed(0)} с) перевищує ліміт ${config.TASK_TIME_LIMIT / 1000} с`);
  }
  return { n, mode, seed, input, work };
}

app.post('/api/tasks', requireUser, async (req, res) => {
  const t = validateTask(req.body);
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(42)');
    const active = await client.query(
      "SELECT COUNT(*)::int AS c FROM tasks WHERE user_id = $1 AND status IN ('queued', 'running')", [req.user.id],
    );
    if (active.rows[0].c >= config.MAX_ACTIVE_PER_USER) {
      throw new HttpError(429, `Досягнуто ліміт активних задач (${config.MAX_ACTIVE_PER_USER}). Дочекайтесь завершення або скасуйте задачу`);
    }
    const queued = await client.query("SELECT COUNT(*)::int AS c FROM tasks WHERE status = 'queued'");
    if (queued.rows[0].c >= config.MAX_QUEUE) {
      throw new HttpError(503, `Система перевантажена: черга заповнена (${config.MAX_QUEUE} задач). Спробуйте пізніше`);
    }
    const row = (await client.query(
      `INSERT INTO tasks (user_id, status, n, mode, seed, input_data, work, stage, created_at)
       VALUES ($1, 'queued', $2, $3, $4, $5, $6, 'Очікування в черзі', $7) RETURNING *`,
      [req.user.id, t.n, t.mode, t.seed, t.input ? JSON.stringify(t.input) : null, t.work, Date.now()],
    )).rows[0];
    await client.query(
      `DELETE FROM tasks WHERE id IN (
         SELECT id FROM tasks WHERE user_id = $1 AND status IN ('completed', 'failed', 'cancelled')
         ORDER BY created_at DESC OFFSET $2)`,
      [req.user.id, config.MAX_HISTORY_PER_USER],
    );
    await client.query('COMMIT');
    res.status(201).json(publicTask(row));
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
});

app.get('/api/tasks', requireUser, async (req, res) => {
  const statuses = req.query.scope === 'history' ? ['completed', 'failed', 'cancelled']
    : req.query.scope === 'active' ? ['queued', 'running']
      : ['queued', 'running', 'completed', 'failed', 'cancelled'];
  const rows = await db.many(
    `SELECT id, status, n, mode, seed, work, progress, stage, server_id, error, cancel_requested,
            queue_position, eta, created_at, started_at, finished_at
     FROM tasks WHERE user_id = $1 AND status = ANY($2) ORDER BY id DESC LIMIT 100`,
    [req.user.id, statuses],
  );
  res.json(rows.map(r => publicTask(r)));
});

async function loadOwnTask(req) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) throw new HttpError(404, 'Задачу не знайдено');
  const row = await db.one('SELECT * FROM tasks WHERE id = $1', [id]);
  if (!row || (row.user_id !== req.user.id && !req.user.isAdmin)) throw new HttpError(404, 'Задачу не знайдено');
  return row;
}

app.get('/api/tasks/:id', requireUser, async (req, res) => {
  res.json(publicTask(await loadOwnTask(req), true));
});

app.post('/api/tasks/:id/cancel', requireUser, async (req, res) => {
  const row = await loadOwnTask(req);
  if (!['queued', 'running'].includes(row.status)) throw new HttpError(409, 'Задача вже завершена');
  const updated = await db.one(
    `UPDATE tasks SET
       cancel_requested = TRUE,
       status = CASE WHEN status = 'queued' THEN 'cancelled' ELSE status END,
       finished_at = CASE WHEN status = 'queued' THEN $2 ELSE finished_at END,
       error = CASE WHEN status = 'queued' THEN 'Скасовано користувачем' ELSE error END,
       queue_position = NULL, eta = NULL
     WHERE id = $1 RETURNING *`,
    [row.id, Date.now()],
  );
  res.json(publicTask(updated));
});

app.delete('/api/tasks/:id', requireUser, async (req, res) => {
  const row = await loadOwnTask(req);
  if (['queued', 'running'].includes(row.status)) throw new HttpError(409, 'Активну задачу спочатку потрібно скасувати');
  await db.query('DELETE FROM tasks WHERE id = $1', [row.id]);
  res.status(204).end();
});

app.get('/internal/status', requireInternal, (req, res) => {
  const mem = process.memoryUsage();
  res.json({
    id: SERVER_ID,
    pid: process.pid,
    ready: speed > 0,
    slots: SLOTS,
    busy: executor.busy,
    running: executor.snapshot(),
    speed,
    cpu: Math.round(cpuPercent * 10) / 10,
    memory: mem.rss,
    loadavg: os.loadavg()[0],
    requests,
    stats: executor.stats,
    uptime: (Date.now() - startedAt) / 1000,
  });
});

app.post('/internal/execute', requireInternal, async (req, res) => {
  const result = await executor.start(Number(req.body?.taskId));
  res.status(result.code).json({ message: result.message });
});

app.use(express.static(config.FRONTEND_DIR, { extensions: ['html'] }));

app.use('/api', (req, res) => res.status(404).json({ error: 'Не знайдено' }));

app.use((err, req, res, next) => {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Занадто великий запит' });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Некоректний JSON' });
  console.error(`[${SERVER_ID}]`, err);
  res.status(500).json({ error: 'Внутрішня помилка сервера' });
});

async function main() {
  speed = benchmark(400);
  executor.startLoop();
  const server = app.listen(PORT, HOST, () => {
    console.log(`[${SERVER_ID}] сервер застосувань слухає http://${HOST}:${PORT}, швидкість ${(speed / 1e6).toFixed(0)} Мфлоп/с`);
  });
  const stop = async () => {
    console.log(`[${SERVER_ID}] зупинка, повернення задач у чергу`);
    server.close();
    await executor.shutdown().catch(() => {});
    await db.pool.end().catch(() => {});
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  process.on('message', msg => { if (msg === 'shutdown') stop(); });
}

main().catch(e => {
  console.error(`[${SERVER_ID}] не вдалося запустити:`, e);
  process.exit(1);
});
