# Ledger IQ — Quality of Earnings Platform

Frontend + backend QoE analysis app. The backend does all parsing; Claude is called **once** per analysis to assign confidence scores and compute the QoE score.

## Architecture

```
qoe-app/
├── backend/
│   ├── server.js      Express API — SSE streaming, file uploads
│   ├── parser.js      ALL parsing logic (CSV, PDF, XLSX, TXT) — NO Claude
│   ├── claude.js      THE ONLY Claude call — sends pre-parsed summary, gets scores
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
| **Claude API call** | `claude.js` | Receives compact JSON summary, assigns confidence scores, computes QoE score |
| Review queue | Frontend | Human approves/rejects flagged items |

## Setup

```bash
cd backend
cp .env.example .env
# Edit .env — add ANTHROPIC_API_KEY=sk-ant-...
npm install
npm start
```

Then open http://localhost:3001

## Claude usage

Claude receives a **pre-classified JSON summary** (not the raw files), so token usage is minimal — typically 1,500–3,500 input tokens and 2,000–4,000 output tokens per analysis regardless of file size.

Claude's tasks:
- Assign confidence score (0–100) per transaction
- Decide if each item needs human review (confidence < 75 or high severity)
- Compute overall QoE score (0–100) + grade
- Write category scores, flags, narrative

## Deployment

The Express server serves the frontend from `frontend/public/`. For production:

```bash
# Set environment variables
export ANTHROPIC_API_KEY=sk-ant-...
export PORT=3001
npm start
```

Or use a process manager like PM2:
```bash
npm install -g pm2
pm2 start backend/server.js --name ledger-iq
pm2 save
```

For cloud deployment (Railway, Render, Fly.io), point the root to `backend/` and set `ANTHROPIC_API_KEY` as an environment variable. The API key in the UI overrides the server env var per-request.
