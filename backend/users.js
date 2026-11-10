/**
 * users.js — PostgreSQL-backed user store
 *
 * Uses DATABASE_URL env var (Render PostgreSQL internal URL).
 * Falls back to JSON file store if DATABASE_URL is not set (local dev).
 *
 * Schema:
 *   users(id, email, name, password_hash, credits, created_at)
 *   usage(id, user_id, date, tokens, cost, report_id)
 */

const { Pool } = require('pg');
const fs   = require('fs');
const path = require('path');

const USE_PG = !!process.env.DATABASE_URL;
let pool;

if (USE_PG) {
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });

  // Create tables if they don't exist
  pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      name TEXT,
      password_hash TEXT,
      credits NUMERIC(10,4) DEFAULT 20.0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS usage (
      id SERIAL PRIMARY KEY,
      user_id TEXT REFERENCES users(id),
      date TIMESTAMPTZ DEFAULT NOW(),
      tokens INTEGER DEFAULT 0,
      cost NUMERIC(10,6) DEFAULT 0,
      report_id TEXT
    );
  `).catch(err => console.error('[db] init error:', err.message));
}

// ─── FILE FALLBACK (local dev) ───────────────────────────────────────────────
const DATA_DIR   = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');

function ensureStore() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, '[]', 'utf8');
}
function loadUsers() {
  ensureStore();
  try { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); } catch { return []; }
}
function saveUsers(users) {
  ensureStore();
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), 'utf8');
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────
function rowToUser(r, usageRows = []) {
  return {
    id: r.id, email: r.email, name: r.name,
    passwordHash: r.password_hash,
    credits: parseFloat(r.credits),
    createdAt: r.created_at,
    usage: usageRows.map(u => ({
      date: u.date, tokens: u.tokens,
      cost: parseFloat(u.cost), reportId: u.report_id
    }))
  };
}

// ─── PUBLIC API ──────────────────────────────────────────────────────────────

async function findByEmail(email) {
  if (!USE_PG) return loadUsers().find(u => u.email.toLowerCase() === email.toLowerCase()) || null;
  const { rows } = await pool.query('SELECT * FROM users WHERE LOWER(email)=$1', [email.toLowerCase()]);
  return rows[0] ? rowToUser(rows[0]) : null;
}

async function findById(id) {
  if (!USE_PG) return loadUsers().find(u => u.id === id) || null;
  const { rows } = await pool.query('SELECT * FROM users WHERE id=$1', [id]);
  if (!rows[0]) return null;
  const { rows: urows } = await pool.query(
    'SELECT * FROM usage WHERE user_id=$1 ORDER BY date DESC LIMIT 100', [id]);
  return rowToUser(rows[0], urows);
}

async function createUser({ email, name, passwordHash }) {
  const id = 'u_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  if (!USE_PG) {
    const users = loadUsers();
    const user = { id, email: email.toLowerCase(), name, passwordHash, credits: 20.00, createdAt: new Date().toISOString(), usage: [] };
    users.push(user); saveUsers(users); return user;
  }
  const { rows } = await pool.query(
    'INSERT INTO users(id,email,name,password_hash,credits) VALUES($1,$2,$3,$4,20.00) RETURNING *',
    [id, email.toLowerCase(), name, passwordHash]);
  return rowToUser(rows[0]);
}

async function updateUser(id, patch) {
  if (!USE_PG) {
    const users = loadUsers(); const idx = users.findIndex(u => u.id === id);
    if (idx === -1) return null; Object.assign(users[idx], patch); saveUsers(users); return users[idx];
  }
  const fields = [], vals = [];
  if (patch.name)         { fields.push(`name=$${fields.length+1}`);          vals.push(patch.name); }
  if (patch.passwordHash) { fields.push(`password_hash=$${fields.length+1}`); vals.push(patch.passwordHash); }
  if (!fields.length) return findById(id);
  vals.push(id);
  const { rows } = await pool.query(`UPDATE users SET ${fields.join(',')} WHERE id=$${vals.length} RETURNING *`, vals);
  return rows[0] ? rowToUser(rows[0]) : null;
}

async function addCredits(id, amount) {
  if (!USE_PG) {
    const users = loadUsers(); const idx = users.findIndex(u => u.id === id);
    if (idx === -1) return null;
    users[idx].credits = Math.round((users[idx].credits + amount) * 100) / 100;
    saveUsers(users); return users[idx];
  }
  const { rows } = await pool.query(
    'UPDATE users SET credits=credits+$1 WHERE id=$2 RETURNING *', [amount, id]);
  return rows[0] ? rowToUser(rows[0]) : null;
}

async function deductCredits(id, tokens) {
  const COST_PER_10K = 0.05;
  const cost = Math.ceil(tokens / 10000) * COST_PER_10K;
  const reportId = 'r_' + Date.now();

  if (!USE_PG) {
    const users = loadUsers(); const idx = users.findIndex(u => u.id === id);
    if (idx === -1) return { ok: false, reason: 'User not found', cost: 0, remaining: 0 };
    users[idx].credits = Math.round((users[idx].credits - cost) * 10000) / 10000;
    users[idx].usage = users[idx].usage || [];
    users[idx].usage.push({ date: new Date().toISOString(), tokens, cost, reportId });
    saveUsers(users);
    return { ok: true, cost, remaining: users[idx].credits };
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      'UPDATE users SET credits=credits-$1 WHERE id=$2 RETURNING credits', [cost, id]);
    if (!rows[0]) { await client.query('ROLLBACK'); return { ok: false, reason: 'User not found', cost: 0, remaining: 0 }; }
    await client.query(
      'INSERT INTO usage(user_id,tokens,cost,report_id) VALUES($1,$2,$3,$4)',
      [id, tokens, cost, reportId]);
    await client.query('COMMIT');
    return { ok: true, cost, remaining: parseFloat(rows[0].credits) };
  } catch (err) {
    await client.query('ROLLBACK'); throw err;
  } finally {
    client.release();
  }
}

async function deleteUserByEmail(email) {
  if (USE_PG) {
    const res = await pool.query('DELETE FROM users WHERE email=$1 RETURNING id', [email]);
    if (res.rowCount > 0) {
      await pool.query('DELETE FROM usage WHERE user_id=$1', [res.rows[0].id]);
    }
    return res.rowCount > 0;
  } else {
    const data = loadUsers();
    const idx = data.users.findIndex(u => u.email === email);
    if (idx === -1) return false;
    data.users.splice(idx, 1);
    fs.writeFileSync(USERS_FILE, JSON.stringify(data, null, 2));
    return true;
  }
}

function safeUser(u) {
  const { passwordHash, ...safe } = u;
  return safe;
}

module.exports = {
  findByEmail, findById,
  createUser, updateUser,
  addCredits, deductCredits,
  deleteUserByEmail,
  safeUser, loadUsers
};
