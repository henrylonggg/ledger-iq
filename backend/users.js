/**
 * users.js — Lightweight JSON-file user store
 *
 * Stores users in backend/data/users.json (persisted on Render disk).
 * Schema per user:
 *   { id, email, name, passwordHash, credits, createdAt,
 *     usage: [ { date, tokens, cost, reportId } ] }
 */

const fs   = require('fs');
const path = require('path');

const DATA_DIR  = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');

function ensureStore() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, '[]', 'utf8');
}

function loadUsers() {
  ensureStore();
  try { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); }
  catch { return []; }
}

function saveUsers(users) {
  ensureStore();
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), 'utf8');
}

function findByEmail(email) {
  return loadUsers().find(u => u.email.toLowerCase() === email.toLowerCase());
}

function findById(id) {
  return loadUsers().find(u => u.id === id);
}

function createUser({ email, name, passwordHash }) {
  const users = loadUsers();
  const id = 'u_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  const user = {
    id, email: email.toLowerCase(), name,
    passwordHash,
    credits: 5.00,       // starts with $5.00 free credits
    createdAt: new Date().toISOString(),
    usage: []
  };
  users.push(user);
  saveUsers(users);
  return user;
}

function updateUser(id, patch) {
  const users = loadUsers();
  const idx   = users.findIndex(u => u.id === id);
  if (idx === -1) return null;
  Object.assign(users[idx], patch);
  saveUsers(users);
  return users[idx];
}

function addCredits(id, amount) {
  const users = loadUsers();
  const idx   = users.findIndex(u => u.id === id);
  if (idx === -1) return null;
  users[idx].credits = Math.round((users[idx].credits + amount) * 100) / 100;
  saveUsers(users);
  return users[idx];
}

/** Deduct credits for a report run. Returns { ok, cost, remaining } */
function deductCredits(id, tokens) {
  const COST_PER_10K = 0.05;
  const cost = (Math.ceil(tokens / 10000) * COST_PER_10K);

  const users = loadUsers();
  const idx   = users.findIndex(u => u.id === id);
  if (idx === -1) return { ok: false, reason: 'User not found', cost: 0, remaining: 0 };

  users[idx].credits = Math.round((users[idx].credits - cost) * 10000) / 10000;
  users[idx].usage = users[idx].usage || [];
  users[idx].usage.push({
    date: new Date().toISOString(),
    tokens,
    cost,
    reportId: 'r_' + Date.now()
  });
  saveUsers(users);
  return { ok: true, cost, remaining: users[idx].credits };
}

function safeUser(u) {
  // Never send passwordHash to client
  const { passwordHash, ...safe } = u;
  return safe;
}

module.exports = {
  findByEmail, findById,
  createUser, updateUser,
  addCredits, deductCredits,
  safeUser, loadUsers
};
