# Tokend

Tokend is a local single-user cost monitoring cockpit for OpenClaw.

It reads historical usage primarily from local OpenClaw session files, stores normalized events in SQLite, and shows breakdowns by:

- day
- model
- channel
- session

It also supports estimated cost tracking via an editable model price table.

## What works now

- Dashboard with today totals, model mix, channel mix, top sessions, and trends
- Models / Channels / Sessions / Session detail pages
- SQLite-backed ingestion from local OpenClaw session files
- Manual re-sync and full re-index
- Source health view
- Editable model price table

## Current limitations

- Cost is only as good as the configured or inferred price table
- Some models may show `$0.00` until you add prices manually
- Realtime activity is limited; Tokend is strongest on historical accounting
- No file watcher / auto-refresh loop yet
- Single-user local app only

## Requirements

- Node.js 24+
- npm

## Install

```bash
cd /Users/xinzechao/.openclaw/workspace/Tokend
npm install
```

## Development

This starts:
- API server on `127.0.0.1:3001`
- frontend dev server on `127.0.0.1:4173`

```bash
cd /Users/xinzechao/.openclaw/workspace/Tokend
npm run dev
```

Open:

```text
http://127.0.0.1:4173
```

### Important

Tokend now uses **frontend port 4173** by default instead of 5173, to avoid common Vite port collisions.

If 4173 is already occupied, Vite is configured with `strictPort: true`, so startup should fail loudly instead of silently hopping to another port.

## Production-ish local run

Build frontend and serve it from the backend on port 3001:

```bash
cd /Users/xinzechao/.openclaw/workspace/Tokend
npm run build
npm run prod
```

Open:

```text
http://127.0.0.1:3001
```

## Useful commands

### Incremental ingestion

```bash
npm run ingest
```

### Install Project Hooks

This project can auto-update the Feishu `版本记录` sheet before `git push`.

```bash
npm run setup-hooks
```

After that, each push will run:

```bash
npm run update-version-record
```

Release content is read from:

```text
release/current-version.json
```

Before publishing a new version:

1. Update `package.json` version
2. Update `release/current-version.json`
3. Run `git push`

The hook currently writes to:

- spreadsheet: `ICA2s2tgGhonFjtLblRctv8AnGc`
- sheet: `版本记录` (`cVwJUD`)

### Rebuild frontend

```bash
npm run build
```

## Data sources

Primary historical sources:

- `~/.openclaw/agents/*/sessions/*.jsonl`
- session metadata from nearby `sessions.json` indexes

## Troubleshooting

### Frontend won't open

1. Make sure `npm run dev` is still running
2. Open `http://127.0.0.1:4173`
3. If startup fails, another process is likely already using 4173
4. Either stop that process or run with a different port:

```bash
FRONTEND_PORT=4273 npm run dev
```

Then open:

```text
http://127.0.0.1:4273
```

### Backend API fails

Default backend port is:

```text
127.0.0.1:3001
```

To change it:

```bash
PORT=3011 npm run dev
```

### Costs look wrong

Go to **Settings** and update the model price table.

Some providers/models do not currently have trustworthy built-in pricing, so Tokend may need manual price inputs.

## Notes

- Tokend does **not** modify core OpenClaw config
- It is intended as a local observability tool, not a billing source of truth
