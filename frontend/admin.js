(() => {
  const $ = id => document.getElementById(id);
  const user = Api.getUser();
  if (!Api.getToken() || !user?.isAdmin) {
    location.href = '/';
    return;
  }

  function stat(value, label) {
    return `<div class="stat"><div class="v">${value}</div><div class="l">${label}</div></div>`;
  }

  function drawChart(canvas, history, slots) {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);
    if (history.length < 2) return;
    const maxCpu = Math.max(100 * slots, 100);
    const step = w / 59;
    const offset = 60 - history.length;
    ctx.fillStyle = 'rgba(47,111,237,.15)';
    history.forEach((p, i) => {
      const bh = (p.busy / slots) * h;
      ctx.fillRect((i + offset) * step - step / 2, h - bh, step, bh);
    });
    ctx.strokeStyle = '#2f6fed';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    history.forEach((p, i) => {
      const x = (i + offset) * step;
      const y = h - (Math.min(p.cpu, maxCpu) / maxCpu) * (h - 4) - 2;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }

  function renderServers(servers) {
    $('servers').innerHTML = servers.map(s => {
      const slotBars = Array.from({ length: s.slots }, (_, i) => `<div class="${i < s.busy ? 'on' : ''}"></div>`).join('');
      const tasks = s.running.map(r => `#${r.taskId} (${Math.round(r.progress * 100)}%)`).join(', ') || '—';
      return `<div class="server ${s.state}">
        <div class="row">
          <b>${fmt.esc(s.id)}</b>
          <span class="auto badge ${s.state}">${fmt.status(s.state)}</span>
        </div>
        <div class="hint">${fmt.esc(s.url)} · ${s.dynamic ? 'додатковий (автомасштабування)' : s.managed ? 'базовий' : 'зовнішній'}</div>
        <div class="slots" title="Зайняті слоти">${slotBars}</div>
        <canvas data-chart="${fmt.esc(s.id)}" title="CPU (лінія) та зайняті слоти (стовпці) за останню хвилину"></canvas>
        <div class="kv">
          <span>Слоти</span><span>${s.busy} / ${s.slots}</span>
          <span>CPU процесу</span><span>${s.cpu === null ? '—' : `${s.cpu.toFixed(0)}%`}</span>
          <span>Пам'ять</span><span>${fmt.bytes(s.memory)}</span>
          <span>Швидкість</span><span>${s.speed ? `${(s.speed / 1e6).toFixed(0)} Мфлоп/с` : '—'}</span>
          <span>Вага (база / поточна)</span><span>${s.baseWeight} / ${s.effectiveWeight}</span>
          <span>HTTP-запитів через LB</span><span>${s.proxiedRequests}</span>
          <span>Виконано / помилок / скас.</span><span>${s.stats ? `${s.stats.completed} / ${s.stats.failed} / ${s.stats.cancelled}` : '—'}</span>
          <span>PID · uptime</span><span>${s.pid ?? '—'} · ${fmt.seconds(s.uptime)}</span>
          <span>Задачі</span><span>${tasks}</span>
        </div>
        <div class="row" style="margin-top:10px">
          ${s.managed ? `<button class="danger small" data-kill="${fmt.esc(s.id)}" title="Імітація збою: процес буде вбито, задачі перейдуть на інші сервери">Імітувати збій</button>` : ''}
          ${s.dynamic && s.state === 'healthy' ? `<button class="secondary small" data-stop="${fmt.esc(s.id)}">Зупинити</button>` : ''}
        </div>
      </div>`;
    }).join('');
    servers.forEach(s => {
      const c = document.querySelector(`canvas[data-chart="${CSS.escape(s.id)}"]`);
      if (c) drawChart(c, s.history, s.slots);
    });
  }

  function render(o) {
    const b = o.balancer;
    const healthy = o.servers.filter(s => s.state === 'healthy');
    const slots = healthy.reduce((a, s) => a + s.slots, 0);
    const busy = healthy.reduce((a, s) => a + s.busy, 0);
    $('stats').innerHTML = [
      stat(`${healthy.length} / ${o.autoscaler.maxServers}`, `серверів працює (мін. ${o.autoscaler.minServers})`),
      stat(`${busy} / ${slots}`, 'зайнято обчислювальних слотів'),
      stat(o.queued.length, `задач у черзі (макс. ${o.limits.maxQueue})`),
      stat(o.counts.completed || 0, 'виконано задач'),
      stat((o.counts.failed || 0) + (o.counts.cancelled || 0), 'помилок / скасовано'),
      stat(b.rps.toFixed(1), 'запитів/с на балансувальник'),
      stat(b.host.loadavg[0].toFixed(2), `load average (ядер: ${b.host.cpus})`),
      stat(o.users, 'користувачів'),
    ].join('');
    $('algo').innerHTML = `HTTP-запити: <b>${fmt.esc(b.requestAlgorithm)}</b>. Обчислювальні задачі: <b>${fmt.esc(b.taskAlgorithm)}</b>.
      Автомасштабування: +1 сервер, якщо черга не порожня і вільних слотів немає ${o.autoscaler.scaleUpAfter} с;
      −1 додатковий сервер після ${o.autoscaler.scaleDownAfter} с простою.
      ${o.autoscaler.pressureFor ? `<b>Перевантаження триває ${o.autoscaler.pressureFor.toFixed(0)} с</b>` : ''}`;
    renderServers(o.servers);
    $('running').innerHTML = o.running.map(t => `<tr>
      <td>${t.id}</td><td>${fmt.esc(t.username)}</td><td>${t.n}</td><td>${fmt.esc(t.server_id)}</td>
      <td>${Math.round(t.progress * 100)}%<div class="hint">${fmt.esc(t.stage || '')}</div></td>
      <td><button class="danger small" data-cancel="${t.id}">Скасувати</button></td></tr>`).join('')
      || '<tr><td colspan="6" class="empty">Немає</td></tr>';
    $('queue').innerHTML = o.queued.map(t => `<tr>
      <td>${t.queue_position ?? '…'}</td><td>${t.id}</td><td>${fmt.esc(t.username)}</td><td>${t.n}</td>
      <td>${t.eta === null ? '—' : `~${fmt.seconds(t.eta)}`}</td>
      <td><button class="danger small" data-cancel="${t.id}">Скасувати</button></td></tr>`).join('')
      || '<tr><td colspan="6" class="empty">Черга порожня</td></tr>';
    $('decisions').innerHTML = o.decisions.map(d => `<div><span class="t">${fmt.clock(d.time)}</span>${fmt.esc(d.message)}</div>`).join('')
      || '<div class="empty">Ще немає</div>';
    $('events').innerHTML = o.events.map(e => `<div class="${e.level}"><span class="t">${fmt.clock(e.time)}</span>${fmt.esc(e.message)}</div>`).join('');
    $('updated').textContent = `Оновлено: ${fmt.clock(Date.now())}`;
  }

  let busy = false;

  async function refresh() {
    if (busy) return;
    busy = true;
    try {
      render(await Api.get('/api/admin/overview'));
      $('adminError').hidden = true;
    } catch (err) {
      $('adminError').hidden = false;
      $('adminError').textContent = err.message;
    } finally {
      busy = false;
    }
  }

  document.addEventListener('click', async e => {
    const t = e.target;
    try {
      if (t.id === 'addServer') await Api.post('/api/admin/servers');
      else if (t.dataset.kill) {
        if (!confirm(`Аварійно вимкнути ${t.dataset.kill}? Його задачі будуть перезапущені на інших серверах.`)) return;
        await Api.post(`/api/admin/servers/${t.dataset.kill}/kill`);
      } else if (t.dataset.stop) await Api.del(`/api/admin/servers/${t.dataset.stop}`);
      else if (t.dataset.cancel) await Api.post(`/api/tasks/${t.dataset.cancel}/cancel`);
      else return;
      refresh();
    } catch (err) {
      alert(err.message);
    }
  });

  refresh();
  setInterval(refresh, 1000);
})();
