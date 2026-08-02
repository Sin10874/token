# Hermes Platform Integration Design

## Problem

Tokend currently has no Hermes ingestion path even though Hermes usage exists locally on machines that use it.

The relevant facts are:

1. Hermes data lives under `~/.hermes`, not under `~/.openclaw`.
2. Current ClawMeter ingestion scans OpenClaw and several coding tools, but does not scan Hermes at all.
3. Hermes stores stable session-level token totals in `~/.hermes/state.db`, mainly in the `sessions` table, plus message-level conversation history in the `messages` table.
4. The deployed `/tokend` UI currently folds non-coding channels into `openclaw`, so even if Hermes data were uploaded it would still not appear as a first-class platform without frontend changes.

The intended product outcome is not partial visibility. Hermes must behave like the other supported platforms across the full Tokend experience, including dashboard, platform list, top projects, top conversations, session views, and platform detail.

## Goals

- Add Hermes as a new top-level platform key: `hermes`
- Keep Hermes separate from `openclaw`
- Reuse the existing Tokend data model and most existing dashboard/query logic
- Preserve Hermes history and future incremental sync without double counting
- Keep rollout understandable for users: Hermes users upgrade CLI and resync once; non-Hermes users do nothing

## Non-Goals

- Do not invent a Hermes-specific standalone analytics stack outside Tokend
- Do not collapse Hermes into `openclaw`
- Do not require SQL backfills for every user by default
- Do not attempt fake per-turn token precision if Hermes only provides session-level cumulative usage

## Design

### 1. Treat Hermes as a first-class top-level platform

Hermes should be introduced as a new platform/product identifier:

- local product key: `hermes`
- cloud/channel key: `hermes`
- UI label: `Hermes`

This keeps the system model simple:

- `openclaw` remains OpenClaw traffic only
- `hermes` becomes a peer of `claude-code`, `codex`, `kimi-code`, `qwen-code`, and the other existing platforms

Hermes internal sources such as `feishu`, `cron`, `cli`, and `weixin` should not become separate top-level platforms in this phase. They should remain Hermes-internal attribution only.

### 2. Ingest Hermes from `~/.hermes/state.db` plus `sessions.json`

Add a dedicated Hermes ingestion path in ClawMeter:

- `server/ingestion/hermes-scanner.ts`
- `server/ingestion/hermes-parser.ts` or `server/ingestion/hermes-importer.ts`

Data sources:

- `~/.hermes/state.db`
  - `sessions`
  - `messages`
- `~/.hermes/sessions/sessions.json`

Data mapping:

- `usage_events.channel = 'hermes'`
- `message_events.channel = 'hermes'`
- `sessions.channel = 'hermes'`

Hermes source preservation:

- Preserve Hermes source (`feishu`, `cron`, `cli`, `weixin`) in a way that survives the current schema without turning source into a top-level platform
- The recommended mapping is:
  - encode source in `session_key`, for example `hermes:<source>:<session_id>`
  - keep human-readable display/title separately

### 3. Sync Hermes by per-session deltas, not by replaying cumulative totals

Hermes is a cumulative snapshot source, not an append-only event log.

This is the main correctness constraint.

The `sessions` table in `~/.hermes/state.db` stores cumulative values such as:

- `input_tokens`
- `output_tokens`
- `cache_read_tokens`
- `cache_write_tokens`
- `reasoning_tokens`
- `estimated_cost_usd`

If Tokend uploads those full totals every time, it will double count usage on every resync.

The correct rule is:

- first sync for a Hermes session uploads the full current totals
- later syncs upload only the delta between current cumulative totals and already-ingested cumulative totals

Recommended implementation:

- Local ClawMeter:
  - diff against already rebuilt local `sessions` totals for the same `session_id` where `channel='hermes'`
- Cloud `tokend-cli`:
  - add a small helper RPC to fetch already-synced remote session totals for a set of `session_id`s
  - compute Hermes deltas client-side before calling `tokend_upload_events`

This avoids overloading the existing line-based sync state system for a source that is not line-based.

### 4. Generate synthetic Hermes usage events from session deltas

Hermes does not currently expose per-assistant-turn token usage in the same way OpenClaw does.

Tokend should therefore synthesize one usage event per sync delta per session.

Event timestamp selection:

1. use the latest relevant `messages.timestamp` for the session when available
2. otherwise use `ended_at`
3. otherwise use `started_at`

Event fields:

- `session_id` = Hermes session id from `state.db.sessions.id`
- `session_key` = synthetic Hermes key with source embedded
- `channel` = `hermes`
- `provider` = Hermes billing provider when present, otherwise inferred provider
- `model` = Hermes model name, normalized through existing Tokend alias logic
- token/cost fields = delta values only

This yields correct totals and acceptable time bucketing without pretending Hermes offers finer-grained precision than it actually does.

### 5. Map Hermes messages into existing Tokend message metrics

Hermes `messages` should be translated into the existing Tokend `message_events` model:

- `role='user'` -> `kind='user'`
- `role='assistant'` with visible content -> `kind='assistant'`
- assistant `tool_calls` entries -> `kind='tool_call'`
- `role='tool'` with `tool_call_id` -> `kind='tool_result'`
- `role='session_meta'` -> ignored

This keeps the current message-count and user-message-count surfaces working without inventing a new message model just for Hermes.

### 6. Use Tokend price estimation, not Hermes native cost fields

Observed Hermes sessions currently report `estimated_cost_usd = 0.0` with `cost_status='unknown'`.

Therefore Hermes cost should continue to use Tokend’s existing price estimation pipeline:

- normalize Hermes model ids into Tokend price table aliases
- estimate input/output/cache costs using the same pricing logic already used for other platforms when native cost is missing

At minimum, the rollout must cover the real Hermes model/provider combinations already seen in local data, such as:

- `billing_provider='kimi-coding'`
- `model='kimi-k2-thinking'`

### 7. Enrich Hermes titles for project/session display

Hermes `sessions.title` is frequently empty.

Without enrichment, Hermes would show unreadable identifiers in:

- top projects
- top conversations
- session lists

Recommended display/title fallback order:

1. `sessions.json.display_name`
2. `sessions.json.origin.chat_name`
3. `sessions.json.origin.user_name`
4. `source + session_id`

Recommended data usage:

- `sessions.title` in local SQLite should store the resolved display title
- cloud upload `project` should use the same resolved display title so Hermes can participate in existing top-projects surfaces

### 8. Keep most cloud RPCs unchanged

Do not create a full Hermes-specific RPC family.

If Hermes lands in cloud usage rows as `channel='hermes'`, the current dashboard-facing RPCs should largely continue to work:

- `tokend_get_summary_v4`
- `tokend_get_daily_trend_v4`
- `tokend_get_channel_breakdown_v3`
- `tokend_get_channel_detail_v2`
- `tokend_get_top_projects_v2`

Required cloud/query changes should be limited to:

- add any helper RPC needed for Hermes delta sync against remote session totals
- extend platform enumerations and label maps where the platform list is currently hardcoded
- ensure Hermes is not folded into OpenClaw-specific logic

The existing OpenClaw heartbeat filtering should remain unchanged:

- OpenClaw internal heartbeat detection still applies only to OpenClaw traffic
- Hermes rows use `channel='hermes'` and should not be affected

### 9. Update frontend platform aggregation so Hermes is visible everywhere

The deployed Next.js Tokend frontend currently aggregates non-coding channels into `openclaw`.

That behavior must change so Hermes becomes its own first-class platform row.

Required frontend changes:

- add `hermes` to platform label maps
- update platform aggregation logic so:
  - Hermes stays as `hermes`
  - OpenClaw aggregation includes only actual OpenClaw traffic
- allow all existing dashboard/session/project tables to render Hermes labels normally

The same principle applies to the local ClawMeter frontend and API:

- add `hermes` to product enums
- add a Hermes route/platform overview
- include Hermes in session filters and platform summaries

## Limitations

Hermes time-series precision will be coarser than OpenClaw.

Because Hermes does not currently expose reliable per-turn token usage, its trend charts will reflect session-delta event timestamps rather than true turn-by-turn usage dispersion. This is acceptable for the first release as long as:

- totals are correct
- no double counting occurs
- Hermes appears consistently as a full platform

## Testing

### Ingestion correctness

- first Hermes import writes full totals for a new session
- second import with unchanged source writes zero new usage
- later import after source growth writes only the delta
- repeated syncs never double count

### Message mapping

- verify `user`, `assistant`, `tool_call`, and `tool_result` counts
- verify `session_meta` is ignored

### Cost estimation

- verify Hermes rows do not stay at `$0.00` when matching price table entries exist
- verify alias normalization covers observed Hermes models/providers

### UI coverage

- Hermes appears as a platform in summary/platform views
- Hermes is not folded into OpenClaw
- top projects, top conversations, sessions, and labels all render `Hermes`

### Cloud smoke test

- run upgraded `tokend-cli`
- verify Hermes rows appear in Supabase-backed `/tokend`
- verify OpenClaw totals do not change incorrectly

## Rollout

1. Implement local Hermes ingestion and local UI support.
2. Implement cloud sync support for Hermes deltas.
3. Add minimal cloud helper RPC support if needed for remote delta lookup.
4. Update the deployed Next.js Tokend frontend to expose Hermes as a first-class platform.
5. Verify with a real Hermes-using token before broad rollout.

## User Impact

This rollout is not a pure query-layer fix.

Existing synced cloud datasets do not contain Hermes yet, so Hermes users must take action once support ships:

- Hermes users must upgrade to the new `tokend-cli`
- Hermes users must rerun `npx tokend-cli` once so Hermes history syncs up and future Hermes usage continues incrementally
- users who do not use Hermes do not need to do anything

Desired user-facing guidance:

> Hermes support is now live. If you use Hermes, upgrade to the latest `tokend-cli` and run `npx tokend-cli` once to sync Hermes history and enable ongoing tracking.

## Constraints

- Existing repositories already have unrelated local changes; implementation must avoid reverting unrelated work
- Hermes support should fit into the current Tokend schema and dashboard model rather than creating a parallel subsystem
- Correctness of delta sync matters more than perfect chart granularity
