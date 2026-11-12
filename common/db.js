const { Pool, Client } = require('pg');
const config = require('../config');
const { hashPassword } = require('./auth');

const pool = new Pool({ connectionString: config.DATABASE_URL, max: 10 });
pool.on('error', err => console.error('[db] помилка з’єднання:', err.message));

const query = (text, params) => pool.query(text, params);

async function one(text, params) {
  const res = await pool.query(text, params);
  return res.rows[0] || null;
}

async function many(text, params) {
  const res = await pool.query(text, params);
  return res.rows;
}

async function ensureDatabase() {
  const url = new URL(config.DATABASE_URL);
  const name = decodeURIComponent(url.pathname.slice(1));
  url.pathname = '/postgres';
  const client = new Client({ connectionString: url.toString() });
  await client.connect();
  try {
    const exists = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
    if (!exists.rowCount) await client.query(`CREATE DATABASE "${name.replace(/"/g, '')}"`);
  } finally {
    await client.end();
  }
}

async function init() {
  try {
    await ensureDatabase();
  } catch (e) {
    console.warn('[db] не вдалося перевірити/створити базу даних:', e.message);
  }
  await query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username VARCHAR(64) NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      is_admin BOOLEAN NOT NULL DEFAULT FALSE,
      created_at DOUBLE PRECISION NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status VARCHAR(16) NOT NULL,
      n INTEGER NOT NULL,
      mode VARCHAR(16) NOT NULL,
      seed INTEGER,
      input_data TEXT,
      work DOUBLE PRECISION NOT NULL,
      progress DOUBLE PRECISION NOT NULL DEFAULT 0,
      stage TEXT,
      server_id VARCHAR(32),
      result TEXT,
      error TEXT,
      cancel_requested BOOLEAN NOT NULL DEFAULT FALSE,
      queue_position INTEGER,
      eta DOUBLE PRECISION,
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at DOUBLE PRECISION NOT NULL,
      started_at DOUBLE PRECISION,
      finished_at DOUBLE PRECISION
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_tasks_user ON tasks(user_id);
  `);
  await query(
    `INSERT INTO users (username, password_hash, is_admin, created_at) VALUES ($1, $2, TRUE, $3)
     ON CONFLICT (username) DO NOTHING`,
    [config.ADMIN_USERNAME, hashPassword(config.ADMIN_PASSWORD), Date.now()],
  );
}

module.exports = { pool, query, one, many, init };
