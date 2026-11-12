const config = require('../config');

class Autoscaler {
  constructor(pool, scheduler) {
    this.pool = pool;
    this.scheduler = scheduler;
    this.pressureSince = null;
    this.lastScale = 0;
    this.timer = null;
  }

  start() {
    this.timer = setInterval(() => this.tick(), 1000);
  }

  stop() {
    clearInterval(this.timer);
  }

  tick() {
    const now = Date.now();
    const backends = this.pool.backends.filter(b => b.state !== 'stopped' && b.state !== 'draining');
    const healthy = backends.filter(b => b.acceptsTasks);
    const starting = backends.some(b => b.state === 'starting' && b.managed);
    const queued = this.scheduler.queue.length;
    const freeSlots = healthy.reduce((s, b) => s + b.freeSlots, 0);

    if (queued > 0 && freeSlots === 0) {
      if (!this.pressureSince) this.pressureSince = now;
      const waited = now - this.pressureSince;
      if (!starting && waited >= config.SCALE_UP_AFTER && backends.length < config.MAX_SERVERS
          && now - this.lastScale >= config.SCALE_COOLDOWN) {
        this.lastScale = now;
        this.pressureSince = null;
        this.pool.spawn({ dynamic: true, reason: `у черзі ${queued} задач, вільних слотів немає ${Math.round(waited / 1000)} с` });
      }
    } else {
      this.pressureSince = null;
    }

    for (const b of backends) {
      if (b.busy > 0 || b.state !== 'healthy') b.idleSince = null;
      else if (!b.idleSince) b.idleSince = now;
    }

    if (queued === 0 && healthy.length > config.MIN_SERVERS && now - this.lastScale >= config.SCALE_COOLDOWN) {
      const victim = healthy
        .filter(b => b.dynamic && b.idleSince && now - b.idleSince >= config.SCALE_DOWN_AFTER)
        .sort((a, b) => b.startedAt - a.startedAt)[0];
      if (victim) {
        this.lastScale = now;
        this.pool.stop(victim, `простій ${Math.round((now - victim.idleSince) / 1000)} с`);
      }
    }
  }

  info() {
    return {
      minServers: config.MIN_SERVERS,
      maxServers: config.MAX_SERVERS,
      scaleUpAfter: config.SCALE_UP_AFTER / 1000,
      scaleDownAfter: config.SCALE_DOWN_AFTER / 1000,
      cooldown: config.SCALE_COOLDOWN / 1000,
      pressureFor: this.pressureSince ? (Date.now() - this.pressureSince) / 1000 : 0,
    };
  }
}

module.exports = Autoscaler;
