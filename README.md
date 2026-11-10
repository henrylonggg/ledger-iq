# Ledger IQ — Quality of Earnings Platform

Frontend + backend QoE analysis app. The backend does the parsing; OpenAI (GPT-4o mini) scores confidence and the QoE score, then writes a ~500-word narrative and a ~150-word plain-English summary.

## Architecture

```
qoe-app/
├── backend/
│   ├── server.js      Express API — SSE streaming, file uploads
│   ├── parser.js      ALL parsing logic (CSV, PDF, XLSX, TXT) — no AI needed for clean files
│   ├── claude.js      Scoring call — sends the pre-parsed summary, gets scores
│   ├── openai-client.js  Every OpenAI call goes through here (retry, 429 handling, safe errors)
│   ├── package.json
│   └── .env.example   → copy to .env and add your key
└── frontend/
    └── public/
        └── index.html  Single-page app (served by Express)
```

## What runs where

| Step | Where | What happens |
|------|-------|--------------|
| File upload | Frontend → Backend | FormData POST to `/api/analyze` |
| CSV / XLSX parsing | `parser.js` | Table extraction, header detection |
| PDF text extraction | `parser.js` (pdf-parse) | Text + line-item pattern matching |
| Transaction classification | `parser.js` | Regex rules → Revenue / EBITDA / Working Capital / etc. |
| Heuristic severity | `parser.js` | Rule-based red/yellow/green flags |
| **OpenAI scoring call** | `claude.js` | Receives compact JSON summary, assigns confidence scores, computes QoE score |
| Review queue | Frontend | Human approves/rejects flagged items |

## Setup

```bash
cd backend
cp .env.example .env
# Edit .env — set DEMO_API_KEY=sk-... (your OpenAI key; stays server-side)
npm install
npm start
```

Then open http://localhost:3001

## OpenAI usage

The model receives a **pre-classified JSON summary** (not the raw files), so token usage is minimal — typically 1,500–3,500 input tokens and 2,000–4,000 output tokens per analysis regardless of file size.

The model's tasks:
- Assign confidence score (0–100) per transaction
- Decide if each item needs human review (confidence < 75 or high severity)
- Compute overall QoE score (0–100) + grade
- Write category scores and flags
- Write the ~500-word analyst narrative, then a ~150-word plain-English summary derived from it (`/api/generate-narrative`, `/api/generate-summary`)

## Deployment

The Express server serves the frontend from `frontend/public/`. For production:

```bash
# Set environment variables
export DEMO_API_KEY=sk-...
export PORT=3001
npm start
```

Or use a process manager like PM2:
```bash
npm install -g pm2
pm2 start backend/server.js --name ledger-iq
pm2 save
```

For cloud deployment (Railway, Render, Fly.io), point the root to `backend/` and set `DEMO_API_KEY` as an environment variable. The key is read only on the server (`process.env.DEMO_API_KEY`); there is no key field in the UI and it is never sent to the browser.

## Troubleshooting OpenAI 429 errors

`GET /api/ai-status` says whether a key is configured (never the key). `GET /api/ai-status?deep=1` sends a 1-token request and reports exactly what OpenAI answered. The sidebar's **Test connection** button runs the same check.

| Code | Meaning | What to do |
|------|---------|------------|
| `openai_rate_limit` | Per-minute request/token limit. Credits are fine. | The app retries automatically. Raise your usage tier or set `OPENAI_FALLBACK_MODELS`. |
| `openai_quota` | The project that owns the key has no usable balance. | Check Billing **and the project's budget limit** at platform.openai.com. New credit can take minutes to activate. |
| `openai_auth` | Key rejected. | Update `DEMO_API_KEY` on the backend. |
| `openai_model` | Key can't use the model. | Set `OPENAI_MODEL` to one it can. |
