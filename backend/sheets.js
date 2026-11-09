/**
 * sheets.js — Google Sheets sync
 *
 * Env vars required:
 *   SHEETS_SPREADSHEET_ID  — the spreadsheet ID to write to
 *   SHEETS_CREDS_JSON      — service account JSON as a string (or path)
 *
 * Sheet layout:
 *   "Users"     — name | email | createdAt
 *   "Purchases" — name | email | amount | timestamp
 */

let google;
try { google = require('googleapis').google; } catch { google = null; }

const SPREADSHEET_ID = process.env.SHEETS_SPREADSHEET_ID;
const CREDS_RAW      = process.env.SHEETS_CREDS_JSON;

function getAuth() {
  if (!google || !SPREADSHEET_ID || !CREDS_RAW) {
    throw new Error('Google Sheets not configured (missing env vars)');
  }
  let creds;
  try {
    creds = typeof CREDS_RAW === 'string' && CREDS_RAW.trim().startsWith('{')
      ? JSON.parse(CREDS_RAW)
      : require(CREDS_RAW);
  } catch (e) {
    throw new Error('SHEETS_CREDS_JSON is not valid JSON: ' + e.message);
  }
  const auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return auth;
}

async function appendRow(sheetName, values) {
  const auth   = getAuth();
  const sheets = google.sheets({ version: 'v4', auth });
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `${sheetName}!A1`,
    valueInputOption: 'USER_ENTERED',
    resource: { values: [values] },
  });
}

/** Called on new user signup */
async function appendUserSignup({ name, email }) {
  await appendRow('Users', [name, email, new Date().toISOString()]);
}

/** Called when user adds credits */
async function appendPurchase({ name, email, amount }) {
  await appendRow('Purchases', [name, email, `$${amount.toFixed(2)}`, new Date().toISOString()]);
}

module.exports = { appendUserSignup, appendPurchase };
