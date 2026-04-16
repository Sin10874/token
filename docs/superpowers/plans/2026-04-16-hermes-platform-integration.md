# Hermes Platform Integration Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Hermes as a first-class Tokend platform end-to-end, including local ingestion, cloud sync, Supabase visibility, and deployed `/tokend` UI support without double counting usage.

**Architecture:** Hermes is a cumulative snapshot source, so the implementation must translate Hermes session totals into per-session deltas before inserting Tokend usage rows. The plan keeps `channel='hermes'` as the top-level platform identifier everywhere, preserves Hermes internal sources in synthetic session keys and display metadata, and reuses the existing Tokend dashboards and RPCs wherever possible.

**Tech Stack:** TypeScript, Node.js SQLite (`node:sqlite`), Supabase RPCs, React, Next.js, existing Tokend ingestion/session rebuild pipeline

---

## File Structure

### ClawMeter repository: `/Users/xinzechao/ClawMeter`

**New files**
- `server/ingestion/hermes-scanner.ts`
  Hermes source discovery and metadata loading from `~/.hermes/state.db` and `~/.hermes/sessions/sessions.json`.
- `server/ingestion/hermes-parser.ts`
  Hermes cumulative session diffing, synthetic usage event creation, message mapping, and title/source enrichment.
- `tests/hermes-ingestion.ts`
  Regression tests for Hermes delta sync, message mapping, and title fallback.
- `docs/superpowers/plans/2026-04-16-hermes-platform-integration.md`
  This implementation plan.

**Modified files**
- `server/ingestion/index.ts`
  Register Hermes local ingestion in the desktop/local pipeline.
- `cli/sync.ts`
  Register Hermes cloud sync and route Hermes through remote delta lookup + upload.
- `cli/bin.ts`
  Optionally expose a safe full-resync or rebuild-friendly message if Hermes history requires one extra sync after upgrade.
- `server/ingestion/session-upsert.ts`
  Preserve Hermes titles/session keys correctly during session rebuilds.
- `server/db/index.ts`
  Extend model alias / pricing support for Hermes-observed models if needed.
- `server/api/platform-summary.ts`
  Add `hermes` to platform enums and summary cards.
- `server/api/platform-overview.ts`
  Add `hermes` to overview queries and prevent Hermes from being folded into OpenClaw-only branches.
- `server/api/routes.ts`
  Add Hermes as a valid product filter and platform route target.
- `src/lib/api.ts`
  Extend platform product unions/types with `hermes`.
- `src/lib/format.ts`
  Add Hermes display labels and platform formatting support.
- `src/App.tsx`
  Add Hermes route using the existing platform overview pattern.
- `src/pages/Sessions.tsx`
  Add Hermes to the session product filter list.
- `tests/ingestion-regression.ts`
  Wire Hermes regression checks into the main test file if that remains the project pattern.
- `tests/package-manifest.ts`
  Verify the npm package still ships all required Hermes ingestion files if needed.
- `package.json`
  Add Hermes tests to the test script if using a dedicated test file.
- `package-lock.json`
  Update only if `package.json` changes.
- `README.md`
  Update supported data sources and Hermes user resync guidance.

**Likely Supabase/SQL changes**
- `scripts/supabase-v9-hermes-sync.sql`
  Add helper RPC(s) for remote Hermes delta lookup if the existing sync RPCs cannot support cumulative-source syncing safely.
- `scripts/supabase-v9-hermes-validation.sql`
  Validation SQL for Hermes rows, counts, and platform appearance after rollout.

### Deployed frontend repository: `/Users/xinzechao/ai798-global-official`

**Modified files**
- `src/app/tokend/lib/tokend-format.ts`
  Add Hermes platform display name.
- `src/app/tokend/components/TokendPlatforms.tsx`
  Stop folding Hermes into OpenClaw aggregation.
- `src/app/tokend/components/TokendDashboard.tsx`
  Only label-level changes should be needed, but keep it in the verification scope.
- `src/app/tokend/lib/tokend-api.ts`
  No expected Hermes-specific RPC changes, but keep under review if channel or session shape assumptions need updates.

---

## Chunk 1: Hermes Local Ingestion

### Task 1: Create a focused Hermes fixture-driven test

**Files:**
- Create: `tests/hermes-ingestion.ts`
- Reference: `tests/ingestion-regression.ts`
- Reference: `server/ingestion/session-upsert.ts`

- [ ] **Step 1: Write the failing local Hermes ingestion test**

Create fixture-backed tests that prove:
- first import of a Hermes session inserts one synthetic usage delta event
- second import with unchanged cumulative totals inserts zero new usage
- third import after cumulative totals grow inserts only the incremental delta
- Hermes titles resolve from `display_name` / `origin.chat_name` / `origin.user_name`
- Hermes messages map to `user`, `assistant`, `tool_call`, `tool_result`

Use an in-memory SQLite DB with schema limited to:

```ts
CREATE TABLE usage_events (...);
CREATE TABLE message_events (...);
CREATE TABLE sessions (...);
```

and Hermes source fixtures shaped like:

```ts
const hermesSession = {
  id: '20260415_091635_14970634',
  source: 'feishu',
  model: 'kimi-k2-thinking',
  input_tokens: 254439,
  output_tokens: 68474,
  cache_read_tokens: 7056277,
  cache_write_tokens: 0,
  reasoning_tokens: 0,
  estimated_cost_usd: 0,
  started_at: 1776215795.55736,
  ended_at: 1776225471.86615,
}
```

- [ ] **Step 2: Run Hermes-only test to confirm it fails**

Run:

```bash
cd /Users/xinzechao/ClawMeter
npx tsx tests/hermes-ingestion.ts
```

Expected:
- FAIL because Hermes scanner/parser functions do not exist yet

- [ ] **Step 3: Create `server/ingestion/hermes-scanner.ts`**

Implement a scanner that loads:
- `~/.hermes/state.db`
- `~/.hermes/sessions/sessions.json`

and returns a typed structure like:

```ts
interface HermesSessionRecord {
  sessionId: string
  source: string
  model: string | null
  billingProvider: string | null
  billingBaseUrl: string | null
  startedAtMs: number | null
  endedAtMs: number | null
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
  estimatedCostUsd: number
  title: string | null
  sessionKey: string
  sourcePath: string
}
```

with `sessionKey` synthesized as:

```ts
`hermes:${source}:${sessionId}`
```

- [ ] **Step 4: Create `server/ingestion/hermes-parser.ts`**

Implement pure helpers for:
- resolving Hermes display title
- reading prior imported totals for the same `session_id`
- computing token/cost deltas
- synthesizing one usage event per session delta
- mapping Hermes `messages` rows into Tokend `message_events`

Key rule in code:

```ts
deltaInput = current.inputTokens - prior.inputTokens
deltaOutput = current.outputTokens - prior.outputTokens
deltaCacheRead = current.cacheReadTokens - prior.cacheReadTokens
...
skip when all deltas <= 0
```

- [ ] **Step 5: Run Hermes-only test to verify it passes**

Run:

```bash
cd /Users/xinzechao/ClawMeter
npx tsx tests/hermes-ingestion.ts
```

Expected:
- PASS

- [ ] **Step 6: Commit**

```bash
git -C /Users/xinzechao/ClawMeter add tests/hermes-ingestion.ts server/ingestion/hermes-scanner.ts server/ingestion/hermes-parser.ts
git -C /Users/xinzechao/ClawMeter commit -m "feat: add Hermes ingestion primitives"
```

---

### Task 2: Wire Hermes into local ingestion and session rebuild flow

**Files:**
- Modify: `server/ingestion/index.ts`
- Modify: `server/ingestion/session-upsert.ts`
- Modify: `tests/ingestion-regression.ts`

- [ ] **Step 1: Extend the regression test with Hermes integration coverage**

Add assertions that:
- Hermes rows are included in `getPlatformsSummary`
- Hermes rows survive `rebuildSessionsFromUsage`
- Hermes titles and session keys are preserved

- [ ] **Step 2: Run the targeted regression test and confirm failure**

Run:

```bash
cd /Users/xinzechao/ClawMeter
npx tsx tests/ingestion-regression.ts
```

Expected:
- FAIL because Hermes is not yet included in the ingestion pipeline or platform summary enums

- [ ] **Step 3: Register Hermes in `server/ingestion/index.ts`**

Add:
- Hermes parser version constant
- Hermes discovery pass
- Hermes persistence using the same `persistParseResult()` path
- Hermes session upsert fallback values with `channel: 'hermes'`

The Hermes branch should look structurally similar to the existing tool branches, but must not use line-based `resolveStartLine()` as the source of truth for cumulative diffing.

- [ ] **Step 4: Adjust `server/ingestion/session-upsert.ts` for Hermes title/session-key preservation**

Ensure `upsertSessionSnapshot()` and `rebuildSessionsFromUsage()` do not discard:
- Hermes resolved titles
- Hermes synthetic session keys

Preserve `title` using the existing `existingTitles` logic and prefer non-empty Hermes fallback titles over nulls.

- [ ] **Step 5: Re-run regression test and verify pass**

Run:

```bash
cd /Users/xinzechao/ClawMeter
npx tsx tests/ingestion-regression.ts
```

Expected:
- PASS

- [ ] **Step 6: Commit**

```bash
git -C /Users/xinzechao/ClawMeter add server/ingestion/index.ts server/ingestion/session-upsert.ts tests/ingestion-regression.ts
git -C /Users/xinzechao/ClawMeter commit -m "feat: wire Hermes into local ingestion"
```

---

## Chunk 2: Platform Visibility In Local API And UI

### Task 3: Add Hermes to local platform enums, summaries, and routes

**Files:**
- Modify: `server/api/platform-summary.ts`
- Modify: `server/api/platform-overview.ts`
- Modify: `server/api/routes.ts`
- Modify: `src/lib/api.ts`

- [ ] **Step 1: Add API tests or regression assertions for Hermes platform visibility**

Add assertions in existing regression coverage that:
- `PLATFORM_PRODUCTS` includes `hermes`
- `getPlatformsSummary()` returns Hermes card data
- `getPlatformOverviewData(db, 'hermes', ...)` succeeds
- Hermes session filtering works via `/sessions?product=hermes`

- [ ] **Step 2: Run the failing API/regression test**

Run:

```bash
cd /Users/xinzechao/ClawMeter
npx tsx tests/ingestion-regression.ts
```

Expected:
- FAIL because `hermes` is not a valid `PlatformProduct`

- [ ] **Step 3: Extend local platform enums and filters**

Implement:
- add `{ product: 'hermes', label: 'Hermes', subtitle: 'Hermes Agent 工作流' }` to `PLATFORM_PRODUCTS`
- ensure `getPlatformFilter('hermes')` returns `channel = 'hermes'`
- ensure OpenClaw-only branches in `platform-overview.ts` remain OpenClaw-only
- add `hermes` to `DashboardProduct` and `PlatformOverviewProduct` unions in `src/lib/api.ts`
- add `hermes` handling in `server/api/routes.ts` product filters

- [ ] **Step 4: Re-run regression and verify pass**

Run:

```bash
cd /Users/xinzechao/ClawMeter
npx tsx tests/ingestion-regression.ts
```

Expected:
- PASS

- [ ] **Step 5: Commit**

```bash
git -C /Users/xinzechao/ClawMeter add server/api/platform-summary.ts server/api/platform-overview.ts server/api/routes.ts src/lib/api.ts tests/ingestion-regression.ts
git -C /Users/xinzechao/ClawMeter commit -m "feat: expose Hermes in local platform APIs"
```

---

### Task 4: Add Hermes to the local React app

**Files:**
- Modify: `src/lib/format.ts`
- Modify: `src/App.tsx`
- Modify: `src/pages/Sessions.tsx`
- Modify: `src/pages/PlatformsOverview.tsx` if label ordering requires adjustment
- Optionally modify: `src/pages/ToolOverview.tsx`
- Test: `tests/platform-overview-ui.tsx`

- [ ] **Step 1: Add a UI assertion for Hermes visibility**

Extend `tests/platform-overview-ui.tsx` or add a nearby UI test to verify:
- Hermes label formatting resolves to `Hermes`
- Hermes can be routed as a platform page
- Hermes appears in the session product filter options

- [ ] **Step 2: Run the UI test and confirm failure**

Run:

```bash
cd /Users/xinzechao/ClawMeter
npx tsx tests/platform-overview-ui.tsx
```

Expected:
- FAIL because Hermes is not in local label maps or routes

- [ ] **Step 3: Implement the minimal local UI changes**

Add:
- `hermes: 'Hermes'` to `src/lib/format.ts`
- route in `src/App.tsx`, preferably using `ToolOverview product="hermes"`
- Hermes option in `src/pages/Sessions.tsx`

Do not create a custom Hermes page unless `ToolOverview` proves insufficient.

- [ ] **Step 4: Re-run UI test and verify pass**

Run:

```bash
cd /Users/xinzechao/ClawMeter
npx tsx tests/platform-overview-ui.tsx
```

Expected:
- PASS

- [ ] **Step 5: Commit**

```bash
git -C /Users/xinzechao/ClawMeter add src/lib/format.ts src/App.tsx src/pages/Sessions.tsx tests/platform-overview-ui.tsx
git -C /Users/xinzechao/ClawMeter commit -m "feat: add Hermes to local UI surfaces"
```

---

## Chunk 3: Cloud Sync, Supabase Support, And Deployed Frontend

### Task 5: Add safe Hermes delta sync to `tokend-cli`

**Files:**
- Modify: `cli/sync.ts`
- Modify: `cli/bin.ts` if user guidance changes
- Create or modify: `scripts/supabase-v9-hermes-sync.sql`
- Create: `scripts/supabase-v9-hermes-validation.sql`
- Modify: `README.md`

- [ ] **Step 1: Write the failing cloud-sync test or CLI-level assertion**

Add a focused regression test that proves:
- Hermes sync computes deltas against prior remote session totals
- unchanged Hermes sessions are not reuploaded
- new Hermes sessions are uploaded once

If a full RPC mock is too heavy, isolate the logic into a pure helper in `cli/sync.ts` and test that helper directly.

- [ ] **Step 2: Run the Hermes sync test and confirm failure**

Run:

```bash
cd /Users/xinzechao/ClawMeter
npx tsx tests/hermes-ingestion.ts
```

Expected:
- FAIL because cloud delta lookup helper does not exist yet

- [ ] **Step 3: Add Supabase helper support**

Create `scripts/supabase-v9-hermes-sync.sql` with one minimal helper RPC that returns remote totals keyed by:

```sql
member_code + session_id + channel='hermes'
```

The RPC should return:
- `sessionId`
- `inputTokens`
- `outputTokens`
- `cacheReadTokens`
- `cacheWriteTokens`
- `reasoningTokens`
- `totalCost`

Do not replace existing upload RPCs unless strictly necessary.

- [ ] **Step 4: Update `cli/sync.ts` to include Hermes in cloud sync**

Implement:
- Hermes discovery/parser call
- remote totals lookup for Hermes sessions
- client-side delta calculation
- upload of only positive Hermes deltas
- upload of Hermes message events and project/title strings

Keep OpenClaw and existing tool sync behavior unchanged.

- [ ] **Step 5: Add user-facing rollout guidance**

Update `README.md` and `cli/bin.ts` output copy if needed to make the rollout message explicit:

```text
If you use Hermes, upgrade tokend-cli and rerun npx tokend-cli once to sync Hermes history.
```

- [ ] **Step 6: Re-run targeted tests**

Run:

```bash
cd /Users/xinzechao/ClawMeter
npx tsx tests/hermes-ingestion.ts
npx tsx tests/ingestion-regression.ts
```

Expected:
- PASS

- [ ] **Step 7: Commit**

```bash
git -C /Users/xinzechao/ClawMeter add cli/sync.ts cli/bin.ts scripts/supabase-v9-hermes-sync.sql scripts/supabase-v9-hermes-validation.sql README.md tests/hermes-ingestion.ts tests/ingestion-regression.ts
git -C /Users/xinzechao/ClawMeter commit -m "feat: add Hermes cloud sync"
```

---

### Task 6: Expose Hermes in the deployed Next.js Tokend frontend

**Files:**
- Modify: `/Users/xinzechao/ai798-global-official/src/app/tokend/lib/tokend-format.ts`
- Modify: `/Users/xinzechao/ai798-global-official/src/app/tokend/components/TokendPlatforms.tsx`
- Review: `/Users/xinzechao/ai798-global-official/src/app/tokend/components/TokendDashboard.tsx`
- Review: `/Users/xinzechao/ai798-global-official/src/app/tokend/lib/tokend-api.ts`

- [ ] **Step 1: Add a Hermes aggregation test or at minimum a focused regression check**

If the external frontend repo has no existing test harness for Tokend, add a minimal file-local assertion or document a manual verification checklist in the commit message. Preferred behavior:
- `aggregatePlatforms()` keeps Hermes as its own row
- only true OpenClaw non-coding traffic is folded into `openclaw`

- [ ] **Step 2: Run the current frontend build to establish a baseline**

Run:

```bash
cd /Users/xinzechao/ai798-global-official
npm run build
```

Expected:
- PASS before changes

- [ ] **Step 3: Implement the minimal Hermes frontend changes**

Add:
- `hermes: 'Hermes'` in `tokend-format.ts`
- logic in `TokendPlatforms.tsx` so `aggregatePlatforms()` returns Hermes as a standalone platform row
- ensure trend merging for `openclaw` excludes Hermes rows

Do not add Hermes-specific RPC calls.

- [ ] **Step 4: Re-run frontend build**

Run:

```bash
cd /Users/xinzechao/ai798-global-official
npm run build
```

Expected:
- PASS

- [ ] **Step 5: Commit in the frontend repo**

```bash
git -C /Users/xinzechao/ai798-global-official add src/app/tokend/lib/tokend-format.ts src/app/tokend/components/TokendPlatforms.tsx
git -C /Users/xinzechao/ai798-global-official commit -m "feat: show Hermes as a first-class Tokend platform"
```

---

### Task 7: End-to-end validation and release handoff

**Files:**
- Review: `scripts/supabase-v9-hermes-validation.sql`
- Review: both repo working trees

- [ ] **Step 1: Apply Hermes SQL helper in Supabase**

Use the generated SQL script in Supabase, then run validation queries that prove:
- Hermes rows exist
- Hermes totals match local source totals for the same token/member
- OpenClaw totals are unchanged except for expected new Hermes separation

- [ ] **Step 2: Run the full local ClawMeter test suite**

Run:

```bash
cd /Users/xinzechao/ClawMeter
npm test
```

Expected:
- PASS

- [ ] **Step 3: Run local and deployed frontend builds**

Run:

```bash
cd /Users/xinzechao/ClawMeter
npm run build

cd /Users/xinzechao/ai798-global-official
npm run build
```

Expected:
- PASS in both repos

- [ ] **Step 4: Perform one real Hermes sync**

Run:

```bash
cd /Users/xinzechao/ClawMeter
npx tokend-cli
```

Expected:
- Hermes history is uploaded once
- rerunning `npx tokend-cli` immediately does not grow Hermes totals again

- [ ] **Step 5: Verify production `/tokend`**

Check:
- Hermes appears in dashboard/platforms/session tables
- Hermes is not folded into OpenClaw
- top projects and top conversations show Hermes labels correctly

- [ ] **Step 6: Publish rollout guidance**

Use this message shape:

```text
Hermes support is now live. If you use Hermes, upgrade to the latest tokend-cli and run npx tokend-cli once to sync Hermes history and enable ongoing tracking.
```

- [ ] **Step 7: Final commit(s)**

```bash
git -C /Users/xinzechao/ClawMeter status --short
git -C /Users/xinzechao/ai798-global-official status --short
```

Create final release commits only after all tests and production checks pass.

