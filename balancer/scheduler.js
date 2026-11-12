const config = require('../config');
const db = require('../common/db');
const { requestJson } = require('./pool');

class Scheduler {
  constructor(pool) {
    this.pool = pool;
    this.queue = [];
    this.decisions = [];
    this.dispatched = 0;
    this.running = false;
    this.timer = null;
  }

  start() {
    this.timer = setInterval(() => this.tick(), config.SCHEDULER_INTERVAL);
  }

  stop() {
    clearInterval(this.timer);
  }

  decide(message) {
    this.decisions.unshift({ time: Date.now(), message });
    if (this.decisions.length > 50) this.decisions.pop();
  }

  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      await this.recoverOrphans();
      await this.dispatch();
    } catch (e) {
      console.error('[scheduler]', e.message);
    } finally {
      this.running = false;
    }
  }

  async recoverOrphans() {
    const rows = await db.many("SELECT id, server_id, started_at, attempts FROM tasks WHERE status = 'running'");
    const now = Date.now();
    for (const task of rows) {
      const backend = this.pool.get(task.server_id);
      let lost = false;
      if (!backend || backend.state === 'down' || backend.state === 'stopped') {
        lost = !backend || backend.state === 'stopped' || now - backend.statusAt > 3000;
      } else if (backend.status && backend.statusAt - task.started_at > 3000) {
        lost = !backend.status.running.some(r => r.taskId === task.id);
      }
      if (!lost) continue;
      if (task.attempts >= config.MAX_ATTEMPTS) {
        await db.query(
          `UPDATE tasks SET status = 'failed', error = $2, finished_at = $3 WHERE id = $1 AND status = 'running'`,
          [task.id, `Сервер ${task.server_id} не зміг виконати задачу, вичерпано спроби (${config.MAX_ATTEMPTS})`, now],
        );
        this.pool.log(`Задача #${task.id} завершилась помилкою: вичерпано спроби (${task.server_id})`, 'error');
      } else {
        await db.query(
          `UPDATE tasks SET status = 'queued', server_id = NULL, progress = 0, started_at = NULL,
                  stage = 'Повторно в черзі (збій сервера)' WHERE id = $1 AND status = 'running'`,
          [task.id],
        );
        this.pool.log(`Задачу #${task.id} повернуто в чергу: її втратив сервер ${task.server_id}`, 'warn');
      }
    }
  }

  score(backend, work) {
    return (backend.remainingWork + work) / (backend.speed * backend.slots);
  }

  async dispatch() {
    const queued = await db.many(
      `SELECT id, n, work FROM tasks WHERE status = 'queued' AND cancel_requested = FALSE ORDER BY id`,
    );
    const candidates = this.pool.backends.filter(b => b.acceptsTasks);
    const waiting = [];
    for (const task of queued) {
      const free = candidates.filter(b => b.freeSlots > 0);
      if (!free.length) {
        waiting.push(task);
        continue;
      }
      let best = null;
      let bestScore = Infinity;
      for (const b of free) {
        const s = this.score(b, task.work);
        if (s < bestScore) { bestScore = s; best = b; }
      }
      const reservation = { at: Date.now(), work: task.work, taskId: task.id };
      best.reservations.push(reservation);
      let res;
      try {
        res = await requestJson(`${best.url}/internal/execute`, { method: 'POST', body: { taskId: task.id }, timeout: 5000 });
      } catch (e) {
        res = { status: 0, data: { message: e.message } };
      }
      if (res.status === 200) {
        this.dispatched += 1;
        const alternatives = free.filter(b => b !== best)
          .map(b => `${b.id}: ${this.score(b, task.work).toFixed(2)} с`).join(', ');
        this.decide(`Задача #${task.id} (n=${task.n}) → ${best.id}, оцінка ${bestScore.toFixed(2)} с${alternatives ? ` (інші: ${alternatives})` : ''}`);
      } else {
        best.reservations = best.reservations.filter(r => r !== reservation);
        if (res.status !== 409) {
          waiting.push(task);
          if (res.status === 503) best.status = { ...best.status, busy: best.slots };
        }
      }
    }
    await this.estimate(waiting, candidates);
  }

  slowdown(backend) {
    const ratios = (backend.status?.running || [])
      .filter(r => r.progress > 0.1 && r.remainingWork > 0)
      .map(r => {
        const work = r.remainingWork / (1 - r.progress);
        return (r.elapsed / r.progress) / (work / backend.speed);
      });
    if (!ratios.length) return 1;
    const avg = ratios.reduce((a, b) => a + b, 0) / ratios.length;
    return Math.min(10, Math.max(1, avg));
  }

  async estimate(waiting, candidates) {
    const slots = [];
    for (const b of candidates) {
      const rate = b.speed / this.slowdown(b);
      const busy = [
        ...(b.status?.running || []).map(r => (r.progress > 0.06 ? (r.elapsed * (1 - r.progress)) / r.progress : r.remainingWork / rate)),
        ...b.reservations.map(r => r.work / rate),
      ];
      for (let i = 0; i < b.slots; i++) slots.push({ rate, freeAt: busy[i] || 0 });
    }
    this.queue = [];
    const ids = [];
    const positions = [];
    const etas = [];
    waiting.forEach((task, index) => {
      let eta = null;
      if (slots.length) {
        let best = slots[0];
        for (const s of slots) {
          if (s.freeAt + task.work / s.rate < best.freeAt + task.work / best.rate) best = s;
        }
        eta = best.freeAt;
        best.freeAt += task.work / best.rate;
      }
      ids.push(task.id);
      positions.push(index + 1);
      etas.push(eta);
      this.queue.push({ id: task.id, n: task.n, position: index + 1, eta });
    });
    if (!ids.length) return;
    await db.query(
      `UPDATE tasks t SET queue_position = v.pos, eta = v.eta
       FROM (SELECT unnest($1::int[]) AS id, unnest($2::int[]) AS pos, unnest($3::float8[]) AS eta) v
       WHERE t.id = v.id AND t.status = 'queued'`,
      [ids, positions, etas],
    );
  }
}

module.exports = Scheduler;
