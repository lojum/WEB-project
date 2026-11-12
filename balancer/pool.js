const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { fork } = require('node:child_process');
const config = require('../config');

const HISTORY = 60;

function requestJson(url, { method = 'GET', body = null, timeout = 2000 } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request(url, {
      method,
      timeout,
      headers: {
        'x-internal-token': config.INTERNAL_TOKEN,
        ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
      },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch { data = text; }
        resolve({ status: res.statusCode, data });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

class Backend {
  constructor({ id, url, managed = false, dynamic = false, port = null }) {
    this.id = id;
    this.url = url;
    this.port = port;
    this.managed = managed;
    this.dynamic = dynamic;
    this.child = null;
    this.state = 'starting';
    this.status = null;
    this.statusAt = 0;
    this.fails = 0;
    this.baseWeight = 1;
    this.effectiveWeight = 1;
    this.currentWeight = 0;
    this.requests = 0;
    this.proxyErrors = 0;
    this.reservations = [];
    this.startedAt = Date.now();
    this.idleSince = null;
    this.restarts = 0;
    this.history = [];
  }

  get slots() {
    return this.status?.slots || config.SLOTS_PER_SERVER;
  }

  get speed() {
    return this.status?.speed || 0;
  }

  get busy() {
    return (this.status?.busy || 0) + this.reservations.length;
  }

  get freeSlots() {
    return Math.max(0, this.slots - this.busy);
  }

  get remainingWork() {
    const running = (this.status?.running || []).reduce((s, t) => s + t.remainingWork, 0);
    return running + this.reservations.reduce((s, r) => s + r.work, 0);
  }

  get acceptsTasks() {
    return this.state === 'healthy' && this.status?.ready;
  }

  toJSON() {
    return {
      id: this.id,
      url: this.url,
      state: this.state,
      managed: this.managed,
      dynamic: this.dynamic,
      pid: this.status?.pid || this.child?.pid || null,
      slots: this.slots,
      busy: this.busy,
      speed: this.speed,
      cpu: this.status?.cpu ?? null,
      memory: this.status?.memory ?? null,
      running: this.status?.running || [],
      stats: this.status?.stats || null,
      appRequests: this.status?.requests ?? null,
      proxiedRequests: this.requests,
      proxyErrors: this.proxyErrors,
      baseWeight: this.baseWeight,
      effectiveWeight: this.effectiveWeight,
      uptime: (Date.now() - this.startedAt) / 1000,
      restarts: this.restarts,
      history: this.history,
    };
  }
}

class Pool {
  constructor(events) {
    this.backends = [];
    this.events = events;
    this.timer = null;
  }

  log(message, level = 'info') {
    this.events.push({ time: Date.now(), level, message });
    if (this.events.length > 200) this.events.shift();
    console.log(`[balancer] ${message}`);
  }

  get(id) {
    return this.backends.find(b => b.id === id);
  }

  managedCount() {
    return this.backends.filter(b => b.state !== 'stopped').length;
  }

  nextPort() {
    const used = new Set(this.backends.map(b => b.port).filter(Boolean));
    let port = config.APP_BASE_PORT;
    while (used.has(port)) port += 1;
    return port;
  }

  addExternal(url, index) {
    const backend = new Backend({ id: `ext-${index + 1}`, url });
    this.backends.push(backend);
    this.log(`Додано зовнішній сервер ${backend.id} (${url})`);
    return backend;
  }

  spawn({ dynamic = false, reason = '' } = {}) {
    const port = this.nextPort();
    const id = `app-${port - config.APP_BASE_PORT + 1}`;
    const backend = new Backend({ id, url: `http://${config.APP_HOST}:${port}`, managed: true, dynamic, port });
    this.backends.push(backend);
    this.startProcess(backend);
    this.log(`Запущено сервер ${id} на порту ${port}${dynamic ? ' (автомасштабування)' : ''}${reason ? `: ${reason}` : ''}`, dynamic ? 'scale' : 'info');
    return backend;
  }

  startProcess(backend) {
    const logFile = fs.createWriteStream(path.join(config.LOG_DIR, `${backend.id}.log`), { flags: 'a' });
    const child = fork(path.join(config.BASE_DIR, 'appserver', 'server.js'), [], {
      env: { ...process.env, SERVER_ID: backend.id, PORT: String(backend.port), HOST: config.APP_HOST },
      silent: true,
    });
    child.stdout.on('data', d => { logFile.write(d); process.stdout.write(d); });
    child.stderr.on('data', d => { logFile.write(d); process.stderr.write(d); });
    child.on('exit', code => {
      logFile.end();
      if (backend.child !== child) return;
      backend.child = null;
      if (backend.state === 'draining' || backend.state === 'stopped') {
        backend.state = 'stopped';
        this.backends = this.backends.filter(b => b !== backend);
        this.log(`Сервер ${backend.id} зупинено`, 'scale');
        return;
      }
      backend.state = 'down';
      this.log(`Процес сервера ${backend.id} завершився аварійно (код ${code})`, 'error');
      if (!backend.dynamic) {
        setTimeout(() => {
          if (!this.backends.includes(backend) || backend.child) return;
          backend.restarts += 1;
          backend.state = 'starting';
          backend.status = null;
          backend.startedAt = Date.now();
          this.startProcess(backend);
          this.log(`Самовідновлення: перезапуск сервера ${backend.id}`, 'warn');
        }, 1500);
      } else {
        this.backends = this.backends.filter(b => b !== backend);
      }
    });
    backend.child = child;
  }

  stop(backend, reason = '') {
    if (!backend.managed) return false;
    backend.state = 'draining';
    this.log(`Сервер ${backend.id} виводиться з роботи${reason ? `: ${reason}` : ''}`, 'scale');
    const child = backend.child;
    if (!child) {
      backend.state = 'stopped';
      this.backends = this.backends.filter(b => b !== backend);
      return true;
    }
    try { child.send('shutdown'); } catch { child.kill(); }
    setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 5000).unref();
    return true;
  }

  kill(backend) {
    if (!backend.child) return false;
    this.log(`Адміністратор аварійно вимкнув сервер ${backend.id}`, 'warn');
    backend.child.kill('SIGKILL');
    return true;
  }

  markDown(backend, reason) {
    if (backend.state !== 'healthy') return;
    backend.state = 'down';
    backend.reservations = [];
    this.log(`Сервер ${backend.id} не відповів на запит (${reason}) — тимчасово виключено з балансування`, 'error');
  }

  startHealthChecks() {
    this.timer = setInterval(() => this.checkAll(), config.HEALTH_INTERVAL);
  }

  async checkAll() {
    await Promise.all(this.backends.map(b => this.check(b)));
    this.recomputeWeights();
  }

  async check(backend) {
    if (backend.state === 'stopped') return;
    const requestedAt = Date.now();
    try {
      const res = await requestJson(`${backend.url}/internal/status`, { timeout: 1500 });
      if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
      backend.status = res.data;
      backend.statusAt = Date.now();
      backend.fails = 0;
      backend.reservations = backend.reservations.filter(r => r.at >= requestedAt);
      if (backend.state === 'starting' || backend.state === 'down') {
        if (res.data.ready) {
          if (backend.state === 'down') this.log(`Сервер ${backend.id} знову доступний`);
          else this.log(`Сервер ${backend.id} готовий (швидкість ${(res.data.speed / 1e6).toFixed(0)} Мфлоп/с)`);
          backend.state = 'healthy';
        }
      }
      backend.history.push({ t: backend.statusAt, cpu: res.data.cpu, busy: res.data.busy });
      if (backend.history.length > HISTORY) backend.history.shift();
    } catch (e) {
      backend.fails += 1;
      if (backend.state === 'healthy' && backend.fails >= 3) {
        backend.state = 'down';
        backend.reservations = [];
        this.log(`Сервер ${backend.id} не відповідає (${e.message}) — виключено з балансування`, 'error');
      }
      if (backend.state === 'starting' && !backend.managed && backend.fails === 5) {
        this.log(`Зовнішній сервер ${backend.id} недоступний (${e.message})`, 'error');
      }
    }
  }

  recomputeWeights() {
    const speeds = this.backends.filter(b => b.speed > 0).map(b => b.speed);
    const max = speeds.length ? Math.max(...speeds) : 1;
    for (const b of this.backends) {
      b.baseWeight = b.speed > 0 ? Math.max(1, Math.round((10 * b.speed) / max)) : 1;
      const load = b.slots ? Math.min(1, b.busy / b.slots) : 0;
      b.effectiveWeight = Math.max(1, Math.round(b.baseWeight * (1 - 0.6 * load)));
    }
  }

  pickForRequest(exclude = new Set()) {
    const candidates = this.backends.filter(b => b.state === 'healthy' && !exclude.has(b.id));
    if (!candidates.length) return null;
    let total = 0;
    let best = null;
    for (const b of candidates) {
      b.currentWeight += b.effectiveWeight;
      total += b.effectiveWeight;
      if (!best || b.currentWeight > best.currentWeight) best = b;
    }
    best.currentWeight -= total;
    return best;
  }

  async shutdownAll() {
    clearInterval(this.timer);
    for (const b of this.backends) {
      if (b.child) {
        b.state = 'stopped';
        try { b.child.send('shutdown'); } catch { b.child.kill(); }
      }
    }
    await new Promise(r => setTimeout(r, 1500));
    for (const b of this.backends) if (b.child && b.child.exitCode === null) b.child.kill('SIGKILL');
  }
}

module.exports = { Pool, Backend, requestJson };
