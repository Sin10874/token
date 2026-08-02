import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const repoRoot = process.cwd()
const indexPath = path.join(repoRoot, 'scripts/supabase-v15-backfill-candidate-index.sql')
const cleanupPath = path.join(repoRoot, 'scripts/supabase-v15-backfill-candidate-index.cleanup.sql')
const v15Path = path.join(repoRoot, 'scripts/supabase-v15-versioned-model-prices.sql')

const models = [
  'claude-opus-5',
  'claude-sonnet-5',
  'kimi-k2.7-code',
  'kimi-k3',
  'deepseek-v4-flash',
  'deepseek-v4-pro',
  'mimo-v2.5',
  'mimo-v2.5-pro',
  'deepseek-chat',
  'deepseek-reasoner',
  'mimo-v2-flash',
  'mimo-v2-omni',
  'mimo-v2-pro',
] as const

function read(filePath: string) {
  return fs.readFileSync(filePath, 'utf8')
}

function assertCandidateModels(sql: string, subject: string) {
  for (const model of models) {
    assert.match(sql, new RegExp(`'${model}'`), `${subject} is missing ${model}`)
  }
  assert.doesNotMatch(sql, /vendor-claude-opus-5|kimi-k3-highspeed|claude-mythos-5/)
}

function assertExactModelInPredicate(sql: string, subject: string) {
  const match = sql.match(/(?:event\.)?model\s+IN\s*\(([\s\S]*?)\)\s*(?:;|AND)/i)
  assert.ok(match, `${subject} model IN predicate is missing`)
  const actual = [...match[1].matchAll(/'([^']+)'/g)].map((item) => item[1])
  assert.deepEqual(actual, models, `${subject} model IN predicate drifted`)
}

const indexSql = read(indexPath)
const cleanupSql = read(cleanupPath)
const v15Sql = read(v15Path)

assert.match(indexSql, /CREATE\s+INDEX\s+CONCURRENTLY\s+IF\s+NOT\s+EXISTS\s+idx_tokend_usage_events_v15_backfill_candidates/i)
assert.match(indexSql, /ON\s+public\.tokend_usage_events\s*\(\s*timestamp_ms\s*,\s*id\s*,\s*member_code\s*\)/i)
assert.match(indexSql, /total_cost\s*=\s*0/i)
assert.match(indexSql, /total_tokens\s*>\s*0/i)
assert.match(indexSql, /indisvalid/i)
assert.match(indexSql, /indisready/i)
assert.match(indexSql, /DO\s+\$\$/i)
assert.match(indexSql, /RAISE\s+EXCEPTION/i)
assert.doesNotMatch(indexSql, /current_setting\s*\(/i)
assert.doesNotMatch(indexSql, /^\s*(BEGIN|COMMIT)\s*;/im)
assertCandidateModels(indexSql, 'candidate index predicate')
assertExactModelInPredicate(indexSql, 'candidate index')

assert.match(cleanupSql, /DROP\s+INDEX\s+CONCURRENTLY\s+IF\s+EXISTS\s+public\.idx_tokend_usage_events_v15_backfill_candidates/i)
assert.doesNotMatch(cleanupSql, /^\s*(BEGIN|COMMIT)\s*;/im)

assert.match(cleanupSql, /v15 rollback/i)
assert.match(v15Sql, /tokend_backfill_versioned_model_costs_batch\(p_limit\s+INTEGER\s+DEFAULT\s+1000\)/i)
assert.match(v15Sql, /tokend_backfill_versioned_model_costs_batch\(1000\)/i)

const candidateStart = v15Sql.indexOf('  candidates AS (')
const candidateEnd = v15Sql.indexOf('  ),\n  audited AS (', candidateStart)
assert.ok(candidateStart >= 0 && candidateEnd > candidateStart, 'v15 candidates CTE is missing')
const candidateSql = v15Sql.slice(candidateStart, candidateEnd)
assert.match(candidateSql, /event\.model\s+IN\s*\(/i)
assertCandidateModels(candidateSql, 'v15 candidate predicate')
assertExactModelInPredicate(candidateSql, 'v15 candidate')

console.log('v15 backfill candidate index static contract passed')
