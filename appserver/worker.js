const { parentPort, workerData } = require('node:worker_threads');
const { buildSystem, gaussSolve, residualNorm, SingularMatrixError } = require('../common/solver');

const { n, mode, seed, data, shared } = workerData;
const state = new Float64Array(shared);

function setState(stage, progress) {
  state[1] = stage;
  state[0] = progress;
}

function report(stage, fraction) {
  if (stage === 2) setState(2, 0.05 + 0.85 * fraction);
  else if (stage === 3) setState(3, 0.9 + 0.06 * fraction);
}

const started = Date.now();
try {
  setState(1, 0.01);
  const { a, b } = buildSystem(n, mode, seed, data);
  setState(2, 0.05);
  const x = gaussSolve(n, a, b, report);
  setState(4, 0.97);
  if (!x.every(Number.isFinite)) throw new SingularMatrixError();
  const residual = residualNorm(n, a, b, x);
  parentPort.postMessage({ ok: true, x: Array.from(x), residual, computeTime: (Date.now() - started) / 1000 });
} catch (e) {
  const error = e instanceof SingularMatrixError
    ? "Матриця системи вироджена — розв'язок не єдиний або не існує"
    : `Помилка обчислення: ${e.message}`;
  parentPort.postMessage({ ok: false, error });
}
