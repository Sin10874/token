# ClawMeter

Local cost monitoring cockpit for OpenClaw. Parses your session JSONL files, stores usage in SQLite, and provides a dark-themed dashboard with model/channel/session breakdowns and estimated costs.

## Stack

| Layer | Tech |
|---|---|
| Frontend | React 18 + TypeScript + Vite + Tailwind CSS + Recharts |
| Backend | Node.js + Express |
| Database | SQLite via `node:sqlite` (built-in, no compilation needed) |
| Runtime | Node.js ≥ 22.5 (24.x recommended) |

## Quick Start

**Prerequisites:** Node.js ≥ 22.5

```bash
cd ClawMeter
npm install
npm run dev
```

This runs two processes in parallel:
- **Server** on `http://127.0.0.1:3001` (auto-ingests on startup)
- **Frontend** on `http://localhost:5173` (proxies `/api` to server)

Open **http://localhost:5173** in your browser.

## Scripts

| Command | Purpose |
|---|---|
| `npm run dev` | Start both server + Vite in dev mode |
| `npm run start` | Server only (serves built frontend) |
| `npm run build` | Build frontend to `dist/client/` |
| `npm run ingest` | Manual full re-index of session files |

## Data Sources

Reads from:
- `~/.openclaw/agents/*/sessions/*.jsonl` — session JSONL files (primary)
- `~/.openclaw/agents/*/sessions/sessions.json` — session index (for channel info)
- `~/.openclaw/openclaw.json` — model price seeds (non-destructive)

Database stored at: `./data/clawmeter.db`

## Pages

| Route | Description |
|---|---|
| `/` | Dashboard — today's totals, model/channel distribution, top sessions |
| `/models` | All models table with token breakdown |
| `/models/:id` | Model detail — daily trend, channel mix |
| `/channels` | All channels with usage bars |
| `/channels/:ch` | Channel detail — daily trend, model mix, top sessions |
| `/sessions` | Session list with filters (channel, model) and pagination |
| `/sessions/:id` | Session detail — per-call event log, model history, timeline |
| `/settings` | Editable price table, ingestion health, source file list |

## Cost Estimates

Costs marked with `~` are **estimates** computed from the price table. If OpenClaw records actual cost in the session file, that value is used directly. Edit prices via the Settings page; manual edits override the auto-seeded values.

## Notes

- Single-user, local-only — no auth, no networking beyond localhost
- Incremental ingestion on server start (new lines only); use "Full re-index" in Settings to reprocess everything
- Missing/zero prices result in `$0.00` cost — add prices in Settings to fix

## Architecture

```
server/
  db/index.ts          SQLite setup + price seed
  ingestion/
    scanner.ts         Discover .jsonl files
    parser.ts          Parse JSONL → UsageEvent
    index.ts           Orchestrate + write to DB
  api/routes.ts        Express route handlers
  index.ts             Server entry

src/
  pages/               Dashboard, Models, Channels, Sessions, Settings
  components/          Layout, MetricCard, TokenBar
  lib/api.ts           Typed fetch wrappers
  lib/format.ts        Number/date formatters
```
