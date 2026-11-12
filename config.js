const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const BASE_DIR = __dirname;
const DATA_DIR = process.env.DATA_DIR || path.join(BASE_DIR, 'data');
const CERT_DIR = process.env.CERT_DIR || path.join(BASE_DIR, 'certs');
const LOG_DIR = process.env.LOG_DIR || path.join(BASE_DIR, 'logs');
for (const dir of [DATA_DIR, CERT_DIR, LOG_DIR]) fs.mkdirSync(dir, { recursive: true });

const int = (name, def) => (process.env[name] !== undefined ? parseInt(process.env[name], 10) : def);
const num = (name, def) => (process.env[name] !== undefined ? parseFloat(process.env[name]) : def);

function loadSecret() {
  if (process.env.APP_SECRET) return process.env.APP_SECRET;
  const file = path.join(DATA_DIR, 'secret.key');
  if (!fs.existsSync(file)) {
    try {
      fs.writeFileSync(file, crypto.randomBytes(32).toString('hex'), { flag: 'wx' });
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
  }
  return fs.readFileSync(file, 'utf8').trim();
}

const SECRET = loadSecret();

module.exports = {
  BASE_DIR,
  DATA_DIR,
  CERT_DIR,
  LOG_DIR,
  FRONTEND_DIR: path.join(BASE_DIR, 'frontend'),
  DATABASE_URL: process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/webproject',

  LB_HOST: process.env.LB_HOST || '0.0.0.0',
  LB_HTTPS_PORT: int('LB_HTTPS_PORT', 8443),
  LB_HTTP_PORT: int('LB_HTTP_PORT', 8080),

  APP_HOST: process.env.APP_HOST || '127.0.0.1',
  APP_BASE_PORT: int('APP_BASE_PORT', 9001),
  EXTERNAL_SERVERS: (process.env.EXTERNAL_SERVERS || '').split(',').map(s => s.trim().replace(/\/$/, '')).filter(Boolean),

  MIN_SERVERS: int('MIN_SERVERS', 2),
  MAX_SERVERS: int('MAX_SERVERS', 4),
  SLOTS_PER_SERVER: int('SLOTS_PER_SERVER', 2),
  SCALE_UP_AFTER: num('SCALE_UP_AFTER', 4) * 1000,
  SCALE_DOWN_AFTER: num('SCALE_DOWN_AFTER', 30) * 1000,
  SCALE_COOLDOWN: num('SCALE_COOLDOWN', 8) * 1000,
  HEALTH_INTERVAL: 1000,
  SCHEDULER_INTERVAL: 500,

  MIN_N: 2,
  MAX_N: int('MAX_N', 4000),
  MAX_MANUAL_N: int('MAX_MANUAL_N', 50),
  TASK_TIME_LIMIT: num('TASK_TIME_LIMIT', 180) * 1000,
  MAX_ACTIVE_PER_USER: int('MAX_ACTIVE_PER_USER', 3),
  MAX_HISTORY_PER_USER: int('MAX_HISTORY_PER_USER', 20),
  MAX_QUEUE: int('MAX_QUEUE', 30),
  MAX_ATTEMPTS: int('MAX_ATTEMPTS', 3),

  TOKEN_TTL: int('TOKEN_TTL', 12 * 3600),
  ADMIN_USERNAME: process.env.ADMIN_USERNAME || 'admin',
  ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || 'admin123',

  SECRET,
  INTERNAL_TOKEN: crypto.createHash('sha256').update(SECRET + ':internal').digest('hex'),
};
