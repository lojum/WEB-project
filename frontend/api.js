const Api = (() => {
  const TOKEN_KEY = 'slae_token';
  const USER_KEY = 'slae_user';
  const listeners = [];

  const getToken = () => localStorage.getItem(TOKEN_KEY);
  const getUser = () => {
    try { return JSON.parse(localStorage.getItem(USER_KEY)); } catch { return null; }
  };

  function setSession(data) {
    localStorage.setItem(TOKEN_KEY, data.token);
    localStorage.setItem(USER_KEY, JSON.stringify(data.user));
  }

  function logout() {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
  }

  async function request(method, url, body) {
    const headers = {};
    const token = getToken();
    if (token) headers.authorization = `Bearer ${token}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    let res;
    try {
      res = await fetch(url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    } catch {
      throw Object.assign(new Error("Немає з'єднання з сервером"), { status: 0 });
    }
    const servedBy = res.headers.get('x-served-by');
    if (servedBy) listeners.forEach(fn => fn(servedBy));
    if (res.status === 204) return null;
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && token) {
      logout();
      location.reload();
    }
    if (!res.ok) throw Object.assign(new Error(data.error || `Помилка ${res.status}`), { status: res.status });
    return data;
  }

  return {
    getToken, getUser, setSession, logout,
    onServedBy: fn => listeners.push(fn),
    get: url => request('GET', url),
    post: (url, body) => request('POST', url, body ?? {}),
    del: url => request('DELETE', url),
  };
})();

const fmt = {
  seconds(s) {
    if (s === null || s === undefined || !Number.isFinite(s)) return '—';
    if (s < 1) return '< 1 с';
    if (s < 60) return `${Math.round(s)} с`;
    const m = Math.floor(s / 60);
    return `${m} хв ${Math.round(s % 60)} с`;
  },
  time(ms) {
    return ms ? new Date(ms).toLocaleString('uk-UA') : '—';
  },
  clock(ms) {
    return new Date(ms).toLocaleTimeString('uk-UA');
  },
  bytes(b) {
    if (!b) return '—';
    return `${(b / 1024 / 1024).toFixed(0)} МБ`;
  },
  status(s) {
    return {
      queued: 'У черзі', running: 'Виконується', completed: 'Виконано', failed: 'Помилка', cancelled: 'Скасовано',
      healthy: 'Працює', starting: 'Запуск', down: 'Недоступний', draining: 'Зупиняється', stopped: 'Зупинено',
    }[s] || s;
  },
  esc(v) {
    return String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  },
};
