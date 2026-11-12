const STAGES = {
  0: 'Очікування запуску',
  1: 'Формування системи рівнянь',
  2: 'Прямий хід методу Гауса',
  3: 'Зворотний хід',
  4: "Перевірка розв'язку (нев'язка)",
  5: 'Збереження результату',
};

class SingularMatrixError extends Error {}

function workUnits(n) {
  return (2 * n ** 3) / 3 + 4 * n ** 2;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildSystem(n, mode, seed, data) {
  const a = new Float64Array(n * n);
  const b = new Float64Array(n);
  if (mode === 'random') {
    const rnd = mulberry32(seed);
    for (let i = 0; i < n * n; i++) a[i] = rnd() * 20 - 10;
    for (let i = 0; i < n; i++) b[i] = rnd() * 20 - 10;
  } else {
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) a[i * n + j] = data.a[i][j];
      b[i] = data.b[i];
    }
  }
  return { a, b };
}

function gaussSolve(n, a, b, report) {
  const w = n + 1;
  const m = new Float64Array(n * w);
  let maxAbs = 0;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const v = a[i * n + j];
      m[i * w + j] = v;
      if (Math.abs(v) > maxAbs) maxAbs = Math.abs(v);
    }
    m[i * w + n] = b[i];
  }
  const eps = 1e-12 * Math.max(1, maxAbs);
  const every = Math.max(1, Math.floor(n / 400));

  for (let k = 0; k < n; k++) {
    let p = k;
    let best = Math.abs(m[k * w + k]);
    for (let i = k + 1; i < n; i++) {
      const v = Math.abs(m[i * w + k]);
      if (v > best) { best = v; p = i; }
    }
    if (best < eps) throw new SingularMatrixError();
    if (p !== k) {
      for (let j = k; j < w; j++) {
        const t = m[k * w + j];
        m[k * w + j] = m[p * w + j];
        m[p * w + j] = t;
      }
    }
    const pivot = m[k * w + k];
    const rowK = k * w;
    for (let i = k + 1; i < n; i++) {
      const rowI = i * w;
      const f = m[rowI + k] / pivot;
      if (f === 0) continue;
      for (let j = k; j < w; j++) m[rowI + j] -= f * m[rowK + j];
    }
    if (report && k % every === 0) report(2, 1 - ((n - k - 1) / n) ** 3);
  }

  const x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let s = m[i * w + n];
    for (let j = i + 1; j < n; j++) s -= m[i * w + j] * x[j];
    x[i] = s / m[i * w + i];
    if (report && i % every === 0) report(3, (n - i) / n);
  }
  return x;
}

function residualNorm(n, a, b, x) {
  let sum = 0;
  for (let i = 0; i < n; i++) {
    let s = -b[i];
    for (let j = 0; j < n; j++) s += a[i * n + j] * x[j];
    sum += s * s;
  }
  return Math.sqrt(sum);
}

function benchmark(n = 500) {
  const { a, b } = buildSystem(n, 'random', 1);
  const start = process.hrtime.bigint();
  gaussSolve(n, a, b);
  const seconds = Math.max(Number(process.hrtime.bigint() - start) / 1e9, 1e-6);
  return workUnits(n) / seconds;
}

module.exports = { STAGES, SingularMatrixError, workUnits, buildSystem, gaussSolve, residualNorm, benchmark };
