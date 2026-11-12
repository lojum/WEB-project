(() => {
  const $ = id => document.getElementById(id);
  let limits = null;
  let authMode = 'login';
  let activeIds = '';
  let pollTimer = null;

  Api.onServedBy(id => { $('served').textContent = `Запит обслужив: ${id}`; });

  function showAuth() {
    $('authView').hidden = false;
    $('appView').hidden = true;
    $('logoutBtn').hidden = true;
    $('adminLink').hidden = true;
    $('who').textContent = '';
  }

  function showApp() {
    const user = Api.getUser();
    $('authView').hidden = true;
    $('appView').hidden = false;
    $('logoutBtn').hidden = false;
    $('adminLink').hidden = !user?.isAdmin;
    $('who').textContent = user?.username || '';
    loadLimits();
    refresh(true);
    clearInterval(pollTimer);
    pollTimer = setInterval(() => refresh(false), 1000);
  }

  function setAuthMode(mode) {
    authMode = mode;
    $('tabLogin').className = mode === 'login' ? '' : 'secondary';
    $('tabRegister').className = mode === 'register' ? '' : 'secondary';
    $('authSubmit').textContent = mode === 'login' ? 'Увійти' : 'Зареєструватися';
    $('password').autocomplete = mode === 'login' ? 'current-password' : 'new-password';
    $('authError').textContent = '';
  }

  $('tabLogin').onclick = () => setAuthMode('login');
  $('tabRegister').onclick = () => setAuthMode('register');

  $('authForm').onsubmit = async e => {
    e.preventDefault();
    const username = $('username').value.trim();
    const password = $('password').value;
    if (!/^[A-Za-z0-9_.-]{3,32}$/.test(username)) {
      $('authError').textContent = 'Логін: 3–32 символи (латиниця, цифри, _ . -)';
      return;
    }
    if (password.length < 6) {
      $('authError').textContent = 'Пароль має містити щонайменше 6 символів';
      return;
    }
    try {
      const data = await Api.post(`/api/auth/${authMode}`, { username, password });
      Api.setSession(data);
      showApp();
    } catch (err) {
      $('authError').textContent = err.message;
    }
  };

  $('logoutBtn').onclick = () => {
    Api.logout();
    clearInterval(pollTimer);
    showAuth();
  };

  async function loadLimits() {
    try {
      limits = await Api.get('/api/limits');
      $('n').max = limits.maxN;
      $('limitsInfo').innerHTML =
        `Обмеження: n ≤ ${limits.maxN} (вручну ≤ ${limits.maxManualN}), час обчислення ≤ ${limits.timeLimit} с, ` +
        `активних задач на користувача ≤ ${limits.maxActivePerUser}, історія ≤ ${limits.maxHistoryPerUser} задач, ` +
        `загальна черга ≤ ${limits.maxQueue}.`;
      updateEstimate();
    } catch (err) {
      $('limitsInfo').textContent = err.message;
    }
  }

  const mode = () => document.querySelector('input[name=mode]:checked').value;
  const workUnits = n => (2 * n ** 3) / 3 + 4 * n ** 2;

  function parseNumbers(text) {
    return text.trim().split(/[\s,;]+/).filter(Boolean).map(Number);
  }

  function validate() {
    const n = Number($('n').value);
    if (!limits) return { error: 'Обмеження ще не завантажені' };
    if (!Number.isInteger(n) || n < limits.minN || n > limits.maxN) {
      return { error: `n має бути цілим числом від ${limits.minN} до ${limits.maxN}` };
    }
    const est = limits.speed ? workUnits(n) / limits.speed : 0;
    if (est > limits.timeLimit) {
      return { error: `Оцінений час (${fmt.seconds(est)}) перевищує ліміт ${limits.timeLimit} с — зменшіть n` };
    }
    if (mode() === 'random') {
      const seedRaw = $('seed').value.trim();
      const seed = seedRaw === '' ? null : Number(seedRaw);
      if (seed !== null && (!Number.isInteger(seed) || seed < 0 || seed > 2147483647)) {
        return { error: 'Seed має бути цілим невід’ємним числом' };
      }
      return { body: { n, mode: 'random', seed } };
    }
    if (n > limits.maxManualN) return { error: `При ручному введенні n ≤ ${limits.maxManualN}` };
    const rows = $('matrixA').value.trim().split(/\n+/).filter(r => r.trim());
    if (rows.length !== n) return { error: `Матриця A має містити ${n} рядків (зараз ${rows.length})` };
    const a = rows.map(parseNumbers);
    const badRow = a.findIndex(r => r.length !== n || r.some(v => !Number.isFinite(v)));
    if (badRow >= 0) return { error: `Рядок ${badRow + 1} матриці A має містити ${n} чисел` };
    const b = parseNumbers($('vectorB').value);
    if (b.length !== n || b.some(v => !Number.isFinite(v))) return { error: `Вектор b має містити ${n} чисел` };
    return { body: { n, mode: 'manual', a, b } };
  }

  function updateEstimate() {
    const n = Number($('n').value);
    $('seedBox').hidden = mode() !== 'random';
    $('manualBox').hidden = mode() !== 'manual';
    if (!limits || !Number.isInteger(n) || n < 2) {
      $('estimate').textContent = '';
      return;
    }
    const w = workUnits(n);
    const est = limits.speed ? w / limits.speed : null;
    $('estimate').textContent = `Трудомісткість: ≈ ${(w / 1e9).toFixed(2)}·10⁹ операцій, орієнтовний час: ${fmt.seconds(est)}`;
    const v = validate();
    $('taskError').textContent = v.error && !/Матриця|Рядок|Вектор/.test(v.error) ? v.error : '';
  }

  document.querySelectorAll('input[name=mode]').forEach(r => { r.onchange = updateEstimate; });
  $('n').oninput = updateEstimate;
  $('seed').oninput = updateEstimate;

  $('exampleBtn').onclick = () => {
    $('n').value = 3;
    $('matrixA').value = '2 1 -1\n-3 -1 2\n-2 1 2';
    $('vectorB').value = '8 -11 -3';
    updateEstimate();
  };

  $('taskForm').onsubmit = async e => {
    e.preventDefault();
    const v = validate();
    if (v.error) {
      $('taskError').textContent = v.error;
      return;
    }
    $('submitBtn').disabled = true;
    try {
      await Api.post('/api/tasks', v.body);
      $('taskError').textContent = '';
      refresh(true);
    } catch (err) {
      $('taskError').textContent = err.message;
    } finally {
      $('submitBtn').disabled = false;
    }
  };

  function remaining(t) {
    if (t.status !== 'running' || !t.startedAt || t.progress <= 0.06) return null;
    const elapsed = (Date.now() - t.startedAt) / 1000;
    return (elapsed * (1 - t.progress)) / t.progress;
  }

  function renderActive(tasks) {
    if (!tasks.length) {
      $('activeList').innerHTML = '<div class="empty">Немає активних задач</div>';
      return;
    }
    $('activeList').innerHTML = tasks.map(t => {
      const pct = Math.round(t.progress * 100);
      let info = '';
      if (t.status === 'queued') {
        info = `<div class="notice warn">Усі ресурси системи зайняті — запит поставлено в чергу.
          Позиція в черзі: <b>${t.queuePosition ?? '…'}</b>,
          орієнтовний час очікування: <b>${t.eta === null || t.eta === undefined ? 'розраховується' : fmt.seconds(t.eta)}</b>.</div>`;
      } else {
        const elapsed = t.startedAt ? (Date.now() - t.startedAt) / 1000 : 0;
        info = `<div class="meta">Етап: <b>${fmt.esc(t.stage || '—')}</b> · Сервер: <b>${fmt.esc(t.serverId || '—')}</b> ·
          Минуло: ${fmt.seconds(elapsed)} · Залишилось: ~${fmt.seconds(remaining(t))}</div>`;
      }
      return `<div class="task">
        <div class="top">
          <div><b>Задача #${t.id}</b> · n = ${t.n} <span class="badge ${t.status}">${fmt.status(t.status)}</span></div>
          <button class="danger small" data-cancel="${t.id}" ${t.cancelRequested ? 'disabled' : ''}>
            ${t.cancelRequested ? 'Скасовується…' : 'Скасувати'}</button>
        </div>
        <div class="bar ${t.status}"><div style="width:${t.status === 'queued' ? 0 : pct}%"></div></div>
        <div class="meta">${t.status === 'running' ? `${pct}%` : ''}</div>
        ${info}
      </div>`;
    }).join('');
  }

  function renderHistory(tasks) {
    $('historyEmpty').hidden = tasks.length > 0;
    $('historyBody').innerHTML = tasks.map(t => {
      const dur = t.startedAt && t.finishedAt ? (t.finishedAt - t.startedAt) / 1000 : null;
      return `<tr>
        <td>${t.id}</td>
        <td>${t.n}</td>
        <td><span class="badge ${t.status}">${fmt.status(t.status)}</span>
          ${t.error ? `<div class="hint">${fmt.esc(t.error)}</div>` : ''}</td>
        <td>${fmt.esc(t.serverId || '—')}</td>
        <td>${fmt.time(t.createdAt)}</td>
        <td>${fmt.seconds(dur)}</td>
        <td class="row" style="flex-wrap:nowrap">
          ${t.status === 'completed' ? `<button class="secondary small auto" data-view="${t.id}">Результат</button>` : ''}
          <button class="danger small auto" data-delete="${t.id}">Видалити</button>
        </td>
      </tr>`;
    }).join('');
  }

  let seq = 0;
  let ticks = 0;
  let inFlight = false;

  async function refresh(full) {
    if (inFlight && !full) return;
    const my = ++seq;
    ticks += 1;
    inFlight = true;
    try {
      const active = await Api.get('/api/tasks?scope=active');
      if (my !== seq) return;
      renderActive(active);
      const ids = active.map(t => t.id).join(',');
      if (full || ids !== activeIds || ticks % 5 === 0) {
        const history = await Api.get('/api/tasks?scope=history');
        if (my !== seq) return;
        activeIds = ids;
        renderHistory(history);
      }
    } catch (err) {
      if (my === seq) $('activeList').innerHTML = `<div class="notice err">${fmt.esc(err.message)}</div>`;
    } finally {
      if (my === seq) inFlight = false;
    }
  }

  document.addEventListener('click', async e => {
    const t = e.target;
    try {
      if (t.dataset.cancel) {
        t.disabled = true;
        await Api.post(`/api/tasks/${t.dataset.cancel}/cancel`);
        refresh(true);
      } else if (t.dataset.delete) {
        await Api.del(`/api/tasks/${t.dataset.delete}`);
        refresh(true);
      } else if (t.dataset.view) {
        showResult(await Api.get(`/api/tasks/${t.dataset.view}`));
      }
    } catch (err) {
      alert(err.message);
    }
  });

  function showResult(task) {
    const r = task.result;
    const shown = r.x.slice(0, 100).map((v, i) => `x${i + 1} = ${v.toPrecision(10)}`).join('\n');
    $('modalTitle').textContent = `Задача #${task.id}: n = ${task.n}`;
    $('modalBody').innerHTML = `
      <p>Сервер: <b>${fmt.esc(task.serverId)}</b> · Час обчислення: <b>${r.computeTime.toFixed(2)} с</b> ·
        Нев'язка ‖Ax − b‖ = <b>${r.residual.toExponential(3)}</b>
        ${task.mode === 'random' ? ` · Seed: ${task.seed}` : ''}</p>
      <pre>${shown}${r.x.length > 100 ? `\n… ще ${r.x.length - 100} значень` : ''}</pre>
      <button id="downloadBtn" class="secondary small">Завантажити розв'язок (JSON)</button>`;
    $('downloadBtn').onclick = () => {
      const blob = new Blob([JSON.stringify({ id: task.id, n: task.n, seed: task.seed, ...r }, null, 1)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `solution-${task.id}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
    };
    $('modal').classList.add('open');
  }

  $('modalClose').onclick = () => $('modal').classList.remove('open');
  $('modal').onclick = e => { if (e.target.id === 'modal') $('modal').classList.remove('open'); };

  if (Api.getToken()) showApp();
  else showAuth();
})();
