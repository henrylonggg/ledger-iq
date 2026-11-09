/**
 * auth.js — Auth routes: signup, login, reset-password, profile, credits, usage
 * All passwords hashed with bcryptjs. Sessions via JWT (HS256).
 * Google Sheets sync via googleapis service account (env: SHEETS_CREDS_JSON, SHEETS_SPREADSHEET_ID).
 */

const express  = require('express');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const router   = express.Router();
const users    = require('./users');
const sheets   = require('./sheets');

const JWT_SECRET  = process.env.JWT_SECRET || 'ledgeriq-dev-secret-change-me';
const JWT_EXPIRES = '30d';

/* ─── helpers ─────────────────────────────────────────────── */
function signToken(user) {
  return jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: JWT_EXPIRES });
}

function validateEmail(e) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
}

/* ─── middleware: verify JWT ──────────────────────────────── */
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Token invalid or expired' });
  }
}

/* ─── POST /api/auth/signup ───────────────────────────────── */
router.post('/signup', async (req, res) => {
  try {
    const { name, email, password } = req.body || {};
    if (!name || !email || !password)
      return res.status(400).json({ error: 'name, email and password are required' });
    if (!validateEmail(email))
      return res.status(400).json({ error: 'Invalid email address' });
    if (password.length < 8)
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    if (users.findByEmail(email))
      return res.status(409).json({ error: 'An account with that email already exists' });

    const passwordHash = await bcrypt.hash(password, 12);
    const user = users.createUser({ email, name, passwordHash });

    // Sync new user to Google Sheets (non-blocking)
    sheets.appendUserSignup({ name, email }).catch(err =>
      console.error('[sheets] signup sync failed:', err.message)
    );

    const token = signToken(user);
    res.json({ token, user: users.safeUser(user) });
  } catch (err) {
    console.error('[auth] signup error:', err);
    res.status(500).json({ error: 'Server error during signup' });
  }
});

/* ─── POST /api/auth/login ────────────────────────────────── */
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password)
      return res.status(400).json({ error: 'email and password are required' });

    const user = users.findByEmail(email);
    if (!user) return res.status(401).json({ error: 'Invalid email or password' });

    const match = await bcrypt.compare(password, user.passwordHash);
    if (!match) return res.status(401).json({ error: 'Invalid email or password' });

    const token = signToken(user);
    res.json({ token, user: users.safeUser(user) });
  } catch (err) {
    console.error('[auth] login error:', err);
    res.status(500).json({ error: 'Server error during login' });
  }
});

/* ─── POST /api/auth/reset-password ──────────────────────── */
router.post('/reset-password', requireAuth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    if (!currentPassword || !newPassword)
      return res.status(400).json({ error: 'currentPassword and newPassword are required' });
    if (newPassword.length < 8)
      return res.status(400).json({ error: 'New password must be at least 8 characters' });

    const user = users.findById(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const match = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!match) return res.status(401).json({ error: 'Current password is incorrect' });

    const passwordHash = await bcrypt.hash(newPassword, 12);
    users.updateUser(user.id, { passwordHash });
    res.json({ ok: true });
  } catch (err) {
    console.error('[auth] reset-password error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/* ─── GET /api/user/profile ───────────────────────────────── */
router.get('/profile', requireAuth, (req, res) => {
  const user = users.findById(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ user: users.safeUser(user) });
});

/* ─── POST /api/user/credits ──────────────────────────────── */
router.post('/credits', requireAuth, async (req, res) => {
  try {
    const { amount } = req.body || {};
    const val = parseFloat(amount);
    if (!val || val <= 0 || val > 10000)
      return res.status(400).json({ error: 'Amount must be between $0.01 and $10,000' });

    const user = users.addCredits(req.user.id, val);
    if (!user) return res.status(404).json({ error: 'User not found' });

    // Sync purchase to Google Sheets (non-blocking)
    sheets.appendPurchase({ name: user.name, email: user.email, amount: val }).catch(err =>
      console.error('[sheets] purchase sync failed:', err.message)
    );

    res.json({ ok: true, credits: user.credits });
  } catch (err) {
    console.error('[auth] credits error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/* ─── GET /api/user/usage ─────────────────────────────────── */
router.get('/usage', requireAuth, (req, res) => {
  const user = users.findById(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const usage = (user.usage || []).slice().reverse(); // newest first
  const totalTokens = usage.reduce((s, u) => s + (u.tokens || 0), 0);
  const totalSpent  = usage.reduce((s, u) => s + (u.cost   || 0), 0);
  res.json({
    usage,
    totalTokens,
    totalSpent: Math.round(totalSpent * 100) / 100,
    credits: user.credits
  });
});

module.exports = { router, requireAuth };
