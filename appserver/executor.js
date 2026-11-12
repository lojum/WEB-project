const path = require('node:path');
const { Worker } = require('node:worker_threads');
const config = require('../config');
const db = require('../common/db');
const { STAGES } = require('../common/solver');

const WORKER_FILE = path.join(__dirname, 'worker.js');

class Executor {
  constructor(serverId, slots) {
    this.serverId = serverId;
    this.slots = slots;
    this.jobs = new Map();
    this.reserved = 0;
    this.stats = { completed: 0, failed: 0, cancelled: 0 };
    this.timer = null;
  }

  get busy() {
    return this.jobs.size + this.reserved;
  }

  snapshot() {
    const now = Date.now();
    return [...this.jobs.values()].map(job => {
      const progress = job.state[0];
      return {
        taskId: job.taskId,
        n: job.n,
        progress: Math.round(progress * 10000) / 10000,
        elapsed: (now - job.started) / 1000,
        remainingWork: job.work * Math.max(0, 1 - progress),
      };
    });
  }

  startLoop() {
    this.timer = setInterval(() => this.tick().catch(e => console.error(`[${this.serverId}] supervisor:`, e.message)), 500);
  }

  async start(taskId) {
    if (this.busy >= this.slots) return { code: 503, message: 'немає вільних слотів' };
    this.reserved += 1;
    try {
      const task = await db.one(
        `UPDATE tasks SET status = 'running', server_id = $2, started_at = $3, progress = 0, stage = $4,
                queue_position = NULL, eta = NULL, attempts = attempts + 1
         WHERE id = $1 AND status = 'queued' AND cancel_requested = FALSE
         RETURNING *`,
        [taskId, this.serverId, Date.now(), STAGES[1]],
      );
      if (!task) return { code: 409, message: 'задача вже не в черзі' };
      const shared = new SharedArrayBuffer(16);
      const worker = new Worker(WORKER_FILE, {
        workerData: {
          n: task.n,
          mode: task.mode,
          seed: task.seed,
          data: task.input_data ? JSON.parse(task.input_data) : null,
          shared,
        },
      });
      const job = {
        taskId: task.id, n: task.n, work: task.work, worker,
        state: new Float64Array(shared), started: Date.now(), lastWritten: -1, done: false,
      };
      worker.on('message', msg => {
        if (msg.ok) this.finalize(job, 'completed', { result: JSON.stringify({ x: msg.x, residual: msg.residual, computeTime: msg.computeTime }) });
        else this.finalize(job, 'failed', { error: msg.error });
      });
      worker.on('error', err => this.finalize(job, 'failed', { error: `Помилка обчислення: ${err.message}` }));
      worker.on('exit', () => this.finalize(job, 'failed', { error: 'Процес обчислення аварійно завершився' }));
      this.jobs.set(task.id, job);
      return { code: 200, message: 'запущено' };
    } finally {
      this.reserved -= 1;
    }
  }

  async tick() {
    if (!this.jobs.size) return;
    const ids = [...this.jobs.keys()];
    const cancelled = new Set((await db.many(
      'SELECT id FROM tasks WHERE id = ANY($1::int[]) AND cancel_requested = TRUE', [ids],
    )).map(r => r.id));
    const now = Date.now();
    for (const job of [...this.jobs.values()]) {
      if (job.done) continue;
      if (cancelled.has(job.taskId)) {
        await this.finalize(job, 'cancelled', { error: 'Скасовано користувачем' });
      } else if (now - job.started > config.TASK_TIME_LIMIT) {
        await this.finalize(job, 'failed', { error: `Перевищено ліміт часу обчислення (${config.TASK_TIME_LIMIT / 1000} с)` });
      } else if (job.state[0] !== job.lastWritten) {
        job.lastWritten = job.state[0];
        await db.query(
          "UPDATE tasks SET progress = $2, stage = $3 WHERE id = $1 AND status = 'running'",
          [job.taskId, job.state[0], STAGES[job.state[1]] || ''],
        );
      }
    }
  }

  async finalize(job, status, { result = null, error = null } = {}) {
    if (job.done) return;
    job.done = true;
    job.worker.terminate().catch(() => {});
    this.stats[status] += 1;
    await db.query(
      `UPDATE tasks SET status = $2::varchar, finished_at = $3, result = $4, error = $5,
              stage = $6, progress = CASE WHEN $2::varchar = 'completed' THEN 1 ELSE progress END
       WHERE id = $1 AND status = 'running'`,
      [job.taskId, status, Date.now(), result, error, status === 'completed' ? STAGES[5] : null],
    ).catch(e => console.error(`[${this.serverId}] finalize:`, e.message));
    this.jobs.delete(job.taskId);
  }

  async shutdown() {
    clearInterval(this.timer);
    const ids = [...this.jobs.keys()];
    for (const job of this.jobs.values()) {
      job.done = true;
      await job.worker.terminate().catch(() => {});
    }
    this.jobs.clear();
    if (ids.length) {
      await db.query(
        `UPDATE tasks SET status = 'queued', server_id = NULL, progress = 0, stage = NULL, started_at = NULL
         WHERE id = ANY($1::int[]) AND status = 'running'`,
        [ids],
      );
    }
  }
}

module.exports = Executor;
