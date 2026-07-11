import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import * as nodeFs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

import {
  ADMIN_RPC_NAMES,
  ADMIN_RPC_SIGNATURES,
  CLIENT_RPC_NAMES,
  CLIENT_RPC_SIGNATURES,
  COMMAND_SPECS,
  EMERGENCY_VERSION,
  ExitCodeError,
  LEGACY_RPC_NAMES,
  MANAGED_MIGRATION_VERSIONS,
  PREFLIGHT_RPC_NAME,
  RECOVERY_MIN_VERSION,
  assertCommandAllowed,
  atomicWriteJson,
  compareSampleReports,
  compareWrapperDefinitions,
  collectRpcVerification,
  createMigrationManifest,
  createRolloutRunner,
  extractExactUploadWrapper,
  fetchAllPages,
  mergeMigrationManifestState,
  parseCli,
  parseMigrationList,
  percentile95,
  probeLiveRpcAccess,
  retryTransient,
  runActivationRehearsal,
  runBackfillBatches,
  runMonitorLoop,
  sanitizeForOutput,
  sha256,
  validateEmergencySurface,
  validateForwardRecovery,
  validateMigrationGate,
  validateReconciliation,
  validateRpcVerification,
} from '../scripts/tokend-production-rollout.mjs'

type Test = { name: string; run: () => void | Promise<void> }
const tests: Test[] = []
const test = (name: string, run: Test['run']) => tests.push({ name, run })

const tmpDirs: string[] = []
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tokend-rollout-contract-'))
  tmpDirs.push(dir)
  return dir
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

function digest(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

const zeroStoredCosts = {
  input_cost: 0, output_cost: 0, reasoning_cost: 0,
  cache_read_cost: 0, cache_write_cost: 0, total_cost: 0,
}

const validArgv: Record<string, string[]> = {
  'wrapper-gate': ['--live-schema', 'pre002.sql', '--rollback-sql', 'reviewed.sql', '--state', 'private.json', '--out', 'sanitized.json'],
  'migration-manifest': ['--files', '001.sql', '002.sql', '--state', 'private.json', '--out', 'manifest.json'],
  'migration-gate': ['--migration-list', 'list.txt', '--migrations-dir', 'migrations', '--state', 'private.json', '--phase', 'pre', '--out', 'gate.json'],
  preflight: ['--out', 'preflight.json'],
  'fixture-create': ['--state', 'private.json'],
  'fixture-reset': ['--state', 'private.json'],
  'upload-smoke': ['--state', 'private.json'],
  sample: ['--rpc', 'tokend_get_summary_v5', '--count', '25', '--out', 'sample.json'],
  'compare-samples': ['--baseline', 'before.json', '--candidate', 'after.json', '--max-error-rate-delta', '.01', '--max-p95-multiplier', '2', '--max-p95-seconds', '2'],
  'verify-rpcs': ['--state', 'private.json', '--out', 'verify.json'],
  'backfill-create': ['--catalog', '2026-07-10', '--state', 'private.json'],
  'backfill-run': ['--state', 'private.json', '--limit', '5000', '--interrupt-after-batches', '1'],
  'late-fixtures': ['--state', 'private.json'],
  reconcile: ['--state', 'private.json', '--out', 'reconcile.json'],
  'activation-rehearsal': ['--state', 'private.json', '--out', 'activation.json'],
  'rollback-active': ['--state', 'private.json', '--out', 'rollback.json'],
  'verify-emergency': ['--state', 'private.json', '--migration-list', 'list.txt', '--out', 'emergency.json'],
  'forward-recover': ['--state', 'private.json', '--migration-list', 'list.txt', '--migrations-dir', 'migrations', '--migration-file', '202607110001_recover.sql', '--post-schema', 'post.sql', '--approval', 'approval.json', '--out', 'recover.json'],
  monitor: ['--state', 'private.json', '--duration', '900', '--interval', '30', '--late-upload-every', '120', '--global-baseline', 'preflight.json', '--rpc-baseline', 'sample.json', '--out', 'monitor.json'],
  cleanup: ['--state', 'private.json'],
}

test('every exact subcommand validates required, optional, numeric, and secret-free argv', () => {
  assert.deepEqual(Object.keys(COMMAND_SPECS).sort(), Object.keys(validArgv).sort())
  for (const [command, argv] of Object.entries(validArgv)) {
    const parsed = parseCli([command, ...argv])
    assert.equal(parsed.command, command)
    const missingName = COMMAND_SPECS[command].required[0]
    const missingAt = argv.indexOf(`--${missingName}`)
    let missingEnd = missingAt + 2
    if (COMMAND_SPECS[command].array.includes(missingName)) {
      while (missingEnd < argv.length && !argv[missingEnd].startsWith('--')) missingEnd += 1
    }
    const withoutRequired = [...argv.slice(0, missingAt), ...argv.slice(missingEnd)]
    assert.throws(() => parseCli([command, ...withoutRequired]), /missing required option/i)
    assert.throws(() => parseCli([command, ...argv, '--not-real', 'x']), /unknown option/i)
  }
  assert.deepEqual(parseCli(['migration-manifest', ...validArgv['migration-manifest']]).options.files, ['001.sql', '002.sql'])
  assert.equal(parseCli(['sample', ...validArgv.sample]).options.count, 25)
  assert.equal(parseCli(['sample', ...validArgv.sample, '--state', 'private.json']).options.state, 'private.json')
  assert.equal(parseCli(['backfill-run', ...validArgv['backfill-run']]).options.interruptAfterBatches, 1)
  assert.equal(parseCli(['upload-smoke', '--state', 'private.json', '--legacy-only']).options.legacyOnly, true)
  assert.equal(parseCli(['migration-gate', ...validArgv['migration-gate'], '--allow-empty-history']).options.allowEmptyHistory, true)
  assert.throws(() => parseCli(['sample', '--rpc', 'x', '--count', '0', '--out', 'x']), /positive/i)
  assert.throws(() => parseCli(['backfill-run', '--state', 'x', '--limit', '5001']), /at most 5000/i)
  assert.throws(() => parseCli(['migration-gate', ...validArgv['migration-gate'].map(value => value === 'pre' ? 'other' : value)]), /pre or post/i)
  assert.throws(() => parseCli([
    'migration-gate',
    ...validArgv['migration-gate'].map(value => value === 'pre' ? 'post' : value),
    '--allow-empty-history',
  ]), /allow-empty-history.*pre/i)
  for (const flag of ['--supabase-url', '--service-key', '--anon-key', '--token']) {
    assert.throws(() => parseCli(['preflight', '--out', 'x', flag, 'secret']), /unknown option/i)
  }
})

const wrapperBody = `
/* outer comment /* nested comment ; */ still outer */
CREATE OR REPLACE FUNCTION public.tokend_upload_events(
  p_token TEXT,
  p_events JSONB,
  p_sync_states JSONB
)
RETURNS JSONB
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = public, pg_temp
AS $wrapper$
BEGIN
  PERFORM '; not a terminator -- still body';
  PERFORM $inner$body-looking CREATE FUNCTION and ;$inner$;
  RETURN jsonb_build_object('ok', true);
END;
$wrapper$;
REVOKE EXECUTE ON FUNCTION public.tokend_upload_events(TEXT, JSONB, JSONB) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.tokend_upload_events(TEXT, JSONB, JSONB) TO anon, authenticated;
`

const reviewedDefaultAclWrapper = `
CREATE FUNCTION public.tokend_upload_events(
  p_token TEXT,
  p_events JSONB,
  p_sync_states JSONB
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $reviewed$
BEGIN
  PERFORM '; retained inside the function body';
  RETURN json_build_object('ok', true);
END;
$reviewed$;
`

const pgDumpDefaultAclWrapper = `
CREATE OR REPLACE FUNCTION "public"."tokend_upload_events"("p_token" "text", "p_events" "jsonb", "p_sync_states" "jsonb") RETURNS "json"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $_pg_dump_tag_$
BEGIN
  PERFORM '; retained inside the function body';
  RETURN json_build_object('ok', true);
END;
$_pg_dump_tag_$;

ALTER FUNCTION "public"."tokend_upload_events"("p_token" "text", "p_events" "jsonb", "p_sync_states" "jsonb") OWNER TO "postgres";
GRANT ALL ON FUNCTION "public"."tokend_upload_events"("p_token" "text", "p_events" "jsonb", "p_sync_states" "jsonb") TO "anon";
GRANT ALL ON FUNCTION "public"."tokend_upload_events"("p_token" "text", "p_events" "jsonb", "p_sync_states" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."tokend_upload_events"("p_token" "text", "p_events" "jsonb", "p_sync_states" "jsonb") TO "service_role";
`

const hardenedReviewedDefaultAclWrapper = `${reviewedDefaultAclWrapper.replace(
  'SECURITY DEFINER',
  'SECURITY DEFINER\nSET search_path = public, pg_temp',
)}
REVOKE ALL ON FUNCTION public.tokend_upload_events(TEXT, JSONB, JSONB) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.tokend_upload_events(TEXT, JSONB, JSONB) TO anon, authenticated;
`

const legacyRelationWrapper = pgDumpDefaultAclWrapper.replace(
  /BEGIN[\s\S]*?END;/,
  `BEGIN
  PERFORM 1 FROM tokend_members;
  PERFORM 1 FROM tokend_model_prices;
  PERFORM 1 FROM tokend_usage_events
    WHERE tokend_usage_events.project IS NULL;
  PERFORM 1 FROM tokend_sync_state;
  RETURN json_build_object('ok', true);
END;`,
)
const hardenedRelationWrapper = `${legacyRelationWrapper
  .replace('SECURITY DEFINER', 'SECURITY DEFINER\nSET search_path = public, pg_temp')
  .replace(/\b(tokend_(?:members|model_prices|usage_events|sync_state))\b/g, 'public.$1')
  .replace(/^GRANT ALL ON FUNCTION .*$/gm, '')}
REVOKE ALL ON FUNCTION public.tokend_upload_events(TEXT, JSONB, JSONB) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.tokend_upload_events(TEXT, JSONB, JSONB) TO anon, authenticated;
`

const semanticMetadataWrapper = `
CREATE FUNCTION public.tokend_upload_events(
  p_token TEXT,
  p_events JSONB,
  p_sync_states JSONB
)
RETURNS JSON
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $semantic$
BEGIN
  RETURN json_build_object('ok', true);
END;
$semantic$;
`

test('wrapper gate accepts any valid PostgreSQL dollar tag without changing the body hash', () => {
  const unicodeTag = semanticMetadataWrapper.replaceAll('$semantic$', '$标签$')
  assert.equal(compareWrapperDefinitions(unicodeTag, semanticMetadataWrapper).wrapperGatePassed, true)
})

test('wrapper semantic hash rejects volatility, search_path, parameter name, and default drift', () => {
  const drifts = [
    semanticMetadataWrapper.replace('VOLATILE', 'IMMUTABLE'),
    semanticMetadataWrapper.replace('public, pg_temp', 'attacker, pg_temp'),
    semanticMetadataWrapper.replace('p_sync_states JSONB', 'renamed_sync_states JSONB'),
    semanticMetadataWrapper.replace('p_sync_states JSONB', "p_sync_states JSONB DEFAULT '[]'::JSONB"),
  ]
  for (const drifted of drifts) {
    assert.throws(
      () => compareWrapperDefinitions(drifted, semanticMetadataWrapper),
      /definition hash mismatch/i,
    )
  }
})

test('wrapper identity keeps quoted schema, function, and type identifiers case-sensitive', () => {
  const drifts = [
    semanticMetadataWrapper.replace('public.tokend_upload_events', '"PUBLIC"."tokend_upload_events"'),
    semanticMetadataWrapper.replace('public.tokend_upload_events', '"public"."TOKEND_UPLOAD_EVENTS"'),
    semanticMetadataWrapper.replace('p_token TEXT', 'p_token "TEXT"'),
  ]
  for (const drifted of drifts) {
    assert.throws(
      () => compareWrapperDefinitions(drifted, semanticMetadataWrapper),
      /exact wrapper.*missing|definition hash mismatch/i,
    )
  }
})

test('wrapper ACL keeps quoted role names distinct from the PUBLIC pseudo-role', () => {
  const restricted = `${semanticMetadataWrapper}
REVOKE EXECUTE ON FUNCTION public.tokend_upload_events(TEXT, JSONB, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.tokend_upload_events(TEXT, JSONB, JSONB) TO anon;
`
  const quotedRole = restricted.replace('FROM PUBLIC;', 'FROM "Public";')
  assert.throws(() => compareWrapperDefinitions(quotedRole, restricted), /ACL mismatch/i)
})

test('wrapper ACL rejects grant-option privilege expansion after PUBLIC execute is revoked', () => {
  const restricted = `${semanticMetadataWrapper}
REVOKE EXECUTE ON FUNCTION public.tokend_upload_events(TEXT, JSONB, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.tokend_upload_events(TEXT, JSONB, JSONB) TO anon;
`
  const expanded = restricted.replace('TO anon;', 'TO anon WITH GRANT OPTION;')
  assert.throws(() => compareWrapperDefinitions(expanded, restricted), /ACL mismatch/i)
})

test('balanced wrapper parser preserves dollar bodies and canonicalizes only SQL trivia', () => {
  const crlf = wrapperBody.replace(/\n/g, '\r\n')
  const spaced = wrapperBody
    .replace('CREATE OR REPLACE FUNCTION', 'CREATE   OR\n REPLACE\tFUNCTION')
    .replace('RETURNS JSONB', 'RETURNS    JSONB')
  const first = extractExactUploadWrapper(crlf)
  const second = extractExactUploadWrapper(spaced)
  assert.equal(first.signature, 'public.tokend_upload_events(text,jsonb,jsonb)')
  assert.match(first.definition, /\$inner\$body-looking CREATE FUNCTION and ;\$inner\$/)
  assert.equal(first.hash, second.hash)
  assert.deepEqual(first.aclTuples, [
    'GRANT:anon', 'GRANT:authenticated', 'REVOKE:PUBLIC', 'REVOKE:anon',
    'REVOKE:authenticated', 'REVOKE:service_role',
  ])
  assert.equal(compareWrapperDefinitions(crlf, spaced).wrapperGatePassed, true)
})

test('wrapper gate accepts semantic pg_dump quoting, dollar tags, and redundant grants under default PUBLIC execute', () => {
  const live = extractExactUploadWrapper(pgDumpDefaultAclWrapper)
  const reviewed = extractExactUploadWrapper(reviewedDefaultAclWrapper)
  assert.equal(live.signature, 'public.tokend_upload_events(text,jsonb,jsonb)')
  assert.equal(live.hash, reviewed.hash)
  assert.equal(live.aclHash, reviewed.aclHash)
  const comparison = compareWrapperDefinitions(pgDumpDefaultAclWrapper, reviewedDefaultAclWrapper)
  assert.equal(comparison.wrapperGatePassed, true)
  assert.equal(comparison.securityHardeningApplied, false)
})

test('wrapper gate permits only the known legacy default-PUBLIC wrapper to harden search_path and ACLs', () => {
  const reviewed = extractExactUploadWrapper(hardenedReviewedDefaultAclWrapper)
  const comparison = compareWrapperDefinitions(
    pgDumpDefaultAclWrapper,
    hardenedReviewedDefaultAclWrapper,
  )
  assert.equal(comparison.wrapperGatePassed, true)
  assert.equal(comparison.securityHardeningApplied, true)
  assert.equal(comparison.wrapperHash, reviewed.hash)
  assert.equal(comparison.aclHash, reviewed.aclHash)
  assert.deepEqual(comparison.roleNames, ['anon', 'authenticated'])
  assert.equal(
    compareWrapperDefinitions(hardenedReviewedDefaultAclWrapper, hardenedReviewedDefaultAclWrapper)
      .securityHardeningApplied,
    false,
  )
  assert.throws(
    () => compareWrapperDefinitions(hardenedReviewedDefaultAclWrapper, pgDumpDefaultAclWrapper),
    /definition hash mismatch/i,
  )

  const liveDrifts = [
    pgDumpDefaultAclWrapper.replace(
      'TO "anon";',
      'TO "anon" WITH GRANT OPTION;',
    ),
    `${pgDumpDefaultAclWrapper}\nGRANT EXECUTE ON FUNCTION public.tokend_upload_events(TEXT, JSONB, JSONB) TO attacker;`,
    pgDumpDefaultAclWrapper.replace(/^GRANT ALL ON FUNCTION .* TO "service_role";$/m, ''),
    pgDumpDefaultAclWrapper.replace(
      'SECURITY DEFINER',
      'SECURITY DEFINER SET search_path = public, pg_temp',
    ),
  ]
  for (const drifted of liveDrifts) {
    assert.throws(
      () => compareWrapperDefinitions(drifted, hardenedReviewedDefaultAclWrapper),
      /hardening|definition hash mismatch|ACL mismatch/i,
    )
  }

  const reviewedDrifts = [
    hardenedReviewedDefaultAclWrapper.replace('public, pg_temp', 'attacker, pg_temp'),
    hardenedReviewedDefaultAclWrapper.replace("'ok', true", "'ok', false"),
    hardenedReviewedDefaultAclWrapper.replace('LANGUAGE plpgsql', 'LANGUAGE sql'),
    hardenedReviewedDefaultAclWrapper.replace(
      'TO anon, authenticated;',
      'TO anon, authenticated WITH GRANT OPTION;',
    ),
    `${hardenedReviewedDefaultAclWrapper}\nGRANT EXECUTE ON FUNCTION public.tokend_upload_events(TEXT, JSONB, JSONB) TO attacker;`,
    `${hardenedReviewedDefaultAclWrapper}\nGRANT EXECUTE ON FUNCTION public.tokend_upload_events(TEXT, JSONB, JSONB) TO service_role;`,
  ]
  for (const drifted of reviewedDrifts) {
    assert.throws(
      () => compareWrapperDefinitions(pgDumpDefaultAclWrapper, drifted),
      /hardening|definition hash mismatch|ACL mismatch/i,
    )
  }
})

test('wrapper hardening qualifies only the four reviewed legacy relations exactly', () => {
  const comparison = compareWrapperDefinitions(legacyRelationWrapper, hardenedRelationWrapper)
  assert.equal(comparison.securityHardeningApplied, true)
  assert.deepEqual(comparison.roleNames, ['anon', 'authenticated'])
  for (const relation of ['tokend_members', 'tokend_model_prices', 'tokend_usage_events', 'tokend_sync_state']) {
    assert.throws(
      () => compareWrapperDefinitions(
        legacyRelationWrapper,
        hardenedRelationWrapper.replace(`public.${relation}`, relation),
      ),
      /definition hash mismatch/i,
    )
  }
  assert.throws(
    () => compareWrapperDefinitions(
      legacyRelationWrapper,
      hardenedRelationWrapper.replace(
        "RETURN json_build_object('ok', true);",
        "PERFORM 1 FROM public.attacker_table;\n  RETURN json_build_object('ok', true);",
      ),
    ),
    /definition hash mismatch/i,
  )
})

test('wrapper parser rejects unreviewed settings post-create mutations and alternate ACL syntax', () => {
  const fromCurrent = reviewedDefaultAclWrapper.replace(
    'SECURITY DEFINER',
    'SECURITY DEFINER\nSET search_path FROM CURRENT',
  )
  assert.throws(
    () => compareWrapperDefinitions(reviewedDefaultAclWrapper, fromCurrent),
    /definition hash mismatch/i,
  )

  for (const unsafeDefaultAcl of [
    'ALTER DEFAULT PRIVILEGES GRANT EXECUTE ON FUNCTIONS TO attacker;',
    'ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO attacker;',
    'ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA other, public GRANT EXECUTE ON FUNCTIONS TO attacker;',
  ]) {
    assert.throws(
      () => compareWrapperDefinitions(
        pgDumpDefaultAclWrapper,
        `${unsafeDefaultAcl}\n${hardenedReviewedDefaultAclWrapper}`,
      ),
      /wrapper.*ACL mutation/i,
    )
  }

  const duplicateUnsafeSearchPath = hardenedReviewedDefaultAclWrapper.replace(
    'SET search_path = public, pg_temp',
    'SET search_path = public, pg_temp\nSET search_path=attacker,pg_temp',
  )
  assert.throws(
    () => compareWrapperDefinitions(pgDumpDefaultAclWrapper, duplicateUnsafeSearchPath),
    /definition hash mismatch/i,
  )

  const unsafeSuffixes = [
    'ALTER FUNCTION public.tokend_upload_events(TEXT, JSONB, JSONB) SET search_path = attacker;',
    'DROP FUNCTION public.tokend_upload_events(TEXT, JSONB, JSONB);',
    'GRANT EXECUTE ON ROUTINE public.tokend_upload_events(TEXT, JSONB, JSONB) TO attacker;',
    'GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO attacker;',
    'GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA other, public TO attacker;',
  ]
  for (const suffix of unsafeSuffixes) {
    assert.throws(
      () => compareWrapperDefinitions(wrapperBody, `${wrapperBody}\n${suffix}`),
      /wrapper.*mutation|ACL mismatch|definition hash mismatch/i,
    )
  }
  assert.throws(
    () => compareWrapperDefinitions(
      wrapperBody,
      `ALTER FUNCTION public.tokend_upload_events(TEXT, JSONB, JSONB) OWNER TO postgres;\n${wrapperBody}`,
    ),
    /wrapper.*mutation/i,
  )
  assert.equal(
    compareWrapperDefinitions(
      wrapperBody,
      `${wrapperBody}\nGRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA other, "PUBLIC" TO attacker;`,
    ).wrapperGatePassed,
    true,
  )

  const hardenedAclBlock = hardenedReviewedDefaultAclWrapper
    .split('\n')
    .filter(line => /^(?:GRANT|REVOKE)\b/.test(line))
    .join('\n')
  const hardenedDefinitionOnly = hardenedReviewedDefaultAclWrapper
    .split('\n')
    .filter(line => !/^(?:GRANT|REVOKE)\b/.test(line))
    .join('\n')
  assert.throws(
    () => compareWrapperDefinitions(
      pgDumpDefaultAclWrapper,
      `${hardenedAclBlock}\n${hardenedDefinitionOnly}`,
    ),
    /wrapper.*mutation/i,
  )

  assert.throws(
    () => compareWrapperDefinitions(
      pgDumpDefaultAclWrapper,
      `${reviewedDefaultAclWrapper}\nGRANT EXECUTE ON ROUTINE public.tokend_upload_events(TEXT, JSONB, JSONB) TO attacker;`,
    ),
    /ACL mismatch/i,
  )
  assert.throws(
    () => compareWrapperDefinitions(
      pgDumpDefaultAclWrapper,
      `${reviewedDefaultAclWrapper}\nGRANT EXECUTE ON FUNCTION public.tokend_upload_events(TEXT, JSONB, JSONB) TO attacker;`,
    ),
    /ACL mismatch/i,
  )
  const grantOptionWrapper = wrapperBody.replace(
    'TO anon, authenticated;',
    'TO anon, authenticated WITH GRANT OPTION;',
  )
  assert.throws(
    () => compareWrapperDefinitions(grantOptionWrapper, grantOptionWrapper),
    /ACL mismatch/i,
  )
})

test('wrapper semantic hash rejects cost rows support and transform metadata drift', () => {
  for (const clause of [
    'COST 999',
    'ROWS 999',
    'SUPPORT public.wrapper_support',
    'TRANSFORM FOR TYPE public.wrapper_type',
  ]) {
    assert.throws(
      () => compareWrapperDefinitions(
        hardenedReviewedDefaultAclWrapper,
        hardenedReviewedDefaultAclWrapper.replace('LANGUAGE plpgsql', `LANGUAGE plpgsql ${clause}`),
      ),
      /definition hash mismatch/i,
    )
  }
})

test('wrapper gate still rejects function body drift after semantic pg_dump normalization', () => {
  const drifted = pgDumpDefaultAclWrapper.replace("'ok', true", "'ok', false")
  assert.throws(
    () => compareWrapperDefinitions(drifted, reviewedDefaultAclWrapper),
    /definition hash mismatch/i,
  )
})

test('wrapper gate compares exact named grants only after PUBLIC execute is revoked', () => {
  const restrictedReviewed = `${reviewedDefaultAclWrapper}
REVOKE EXECUTE ON FUNCTION public.tokend_upload_events(TEXT, JSONB, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.tokend_upload_events(TEXT, JSONB, JSONB) TO anon, authenticated;
`
  const restrictedDump = `${pgDumpDefaultAclWrapper.replace(/^GRANT ALL ON FUNCTION .* TO "service_role";$/m, '')}
REVOKE ALL ON FUNCTION "public"."tokend_upload_events"("text", "jsonb", "jsonb") FROM PUBLIC;
`
  assert.equal(compareWrapperDefinitions(restrictedDump, restrictedReviewed).wrapperGatePassed, true)
  assert.throws(
    () => compareWrapperDefinitions(
      restrictedDump.replace('FROM PUBLIC;', 'FROM PUBLIC;\nGRANT ALL ON FUNCTION "public"."tokend_upload_events"("text", "jsonb", "jsonb") TO "auditor";'),
      restrictedReviewed,
    ),
    /ACL mismatch/i,
  )
  assert.throws(
    () => compareWrapperDefinitions(
      restrictedDump.replace(/^GRANT ALL ON FUNCTION .* TO "authenticated";$/m, ''),
      restrictedReviewed,
    ),
    /ACL mismatch/i,
  )
  assert.throws(() => compareWrapperDefinitions(restrictedDump, reviewedDefaultAclWrapper), /ACL mismatch/i)
})

test('wrapper gate rejects missing, ambiguous, changed body, metadata, and ACL tuples', () => {
  assert.throws(() => extractExactUploadWrapper('SELECT 1;'), /exact wrapper.*missing/i)
  const emptyAcl = wrapperBody.replace(/^REVOKE.*$|^GRANT.*$/gm, '')
  assert.deepEqual(extractExactUploadWrapper(emptyAcl).aclTuples, [])
  assert.equal(compareWrapperDefinitions(emptyAcl, emptyAcl).wrapperGatePassed, true)
  assert.throws(() => compareWrapperDefinitions(emptyAcl, wrapperBody), /ACL mismatch/i)
  assert.throws(() => extractExactUploadWrapper(`${wrapperBody}\n${wrapperBody}`), /ambiguous/i)
  assert.throws(
    () => compareWrapperDefinitions(wrapperBody, wrapperBody.replace("'ok', true", "'ok', false")),
    /definition hash mismatch/i,
  )
  assert.throws(
    () => compareWrapperDefinitions(wrapperBody, wrapperBody.replace('SECURITY DEFINER', 'SECURITY INVOKER')),
    /definition hash mismatch/i,
  )
  assert.throws(
    () => compareWrapperDefinitions(wrapperBody, wrapperBody.replace('TO anon, authenticated;', 'TO anon;')),
    /ACL mismatch/i,
  )
})

test('atomic state writes use 0600 temp, fsync+rename, and preserve old state on failure', async () => {
  const dir = await tempDir()
  const statePath = path.join(dir, 'state.json')
  await atomicWriteJson(statePath, { wrapperGatePassed: true }, { fs: nodeFs, randomUUID })
  assert.equal((await stat(statePath)).mode & 0o777, 0o600)
  assert.deepEqual(JSON.parse(await readFile(statePath, 'utf8')), { wrapperGatePassed: true })

  const failingFs = {
    ...nodeFs,
    rename: async () => { throw new Error('rename unavailable') },
  }
  await assert.rejects(
    atomicWriteJson(statePath, { wrapperGatePassed: false }, { fs: failingFs, randomUUID: () => 'failed' }),
    /atomic state write failed/i,
  )
  assert.deepEqual(JSON.parse(await readFile(statePath, 'utf8')), { wrapperGatePassed: true })
  await assert.rejects(stat(`${statePath}.failed.tmp`), /ENOENT/)
})

test('sanitized output recursively drops identifiers, payloads, URLs, prompts, and secrets', () => {
  const secret = 'service-secret-value'
  const sanitized = sanitizeForOutput({
    wrapperGatePassed: true,
    hashes: { wrapper: 'abc' },
    roleNames: ['anon'],
    fixtureIds: ['fixture-a'],
    eventIds: ['event-a'],
    cursorMember: 'cursor-member-sentinel',
    cursorEvent: 'cursor-event-sentinel',
    nextMember: 'next-member-sentinel',
    nextEvent: 'next-event-sentinel',
    sessions: [{ id: 'generic-session-id', healthy: true }],
    fixture: {
      memberCode: 'ROLL_private', memberToken: 'roll-token', eventId: 'evt', sessionId: 'session',
      rawPayload: { prompt: 'private prompt' }, providerUrl: 'https://provider.invalid/secret',
    },
    authorization: `Bearer ${secret}`,
    serviceKey: secret,
    secretNote: 'nested-secret-value',
    link: 'https://provider.invalid/another-path',
    membersOver2x: 2,
    fixtureHealth: { ok: true },
  })
  const encoded = JSON.stringify(sanitized)
  for (const forbidden of [secret, 'nested-secret-value', 'ROLL_private', 'roll-token', 'evt', 'session', 'fixture-a', 'event-a', 'generic-session-id', 'private prompt', 'provider.invalid', 'cursor-member-sentinel', 'cursor-event-sentinel', 'next-member-sentinel', 'next-event-sentinel']) {
    assert.doesNotMatch(encoded, new RegExp(forbidden))
  }
  assert.deepEqual(sanitized, {
    wrapperGatePassed: true,
    hashes: { wrapper: 'abc' },
    roleNames: ['anon'],
    membersOver2x: 2,
    fixtureHealth: { ok: true },
  })
})

test('CLI stdout never exposes real backfill cursor sentinels', async () => {
  const dir = await tempDir()
  const statePath = path.join(dir, 'cursor-state.json')
  const cursorMember = 'REAL-CURSOR-MEMBER-SENTINEL'
  const cursorEvent = 'REAL-CURSOR-EVENT-SENTINEL'
  await atomicWriteJson(statePath, {
    wrapperGatePassed: true,
    backfill: { runId: '00000000-0000-0000-0000-000000000111', cursorMember: '', cursorEvent: '', remaining: 1, batches: 0 },
  }, { fs: nodeFs, randomUUID })
  const modulePath = path.resolve(process.cwd(), 'scripts/tokend-production-rollout.mjs')
  const script = `
    import * as fs from 'node:fs/promises';
    const { main } = await import(${JSON.stringify(`file://${modulePath}`)});
    await main(['backfill-run', '--state', ${JSON.stringify(statePath)}, '--limit', '1'], {
      env: { SUPABASE_URL: 'https://project.supabase.co', SUPABASE_SERVICE_KEY: 'svc', SUPABASE_ANON_KEY: 'anon' },
      fs,
      fetch: async () => new Response(JSON.stringify({
        processed: 1,
        remainingCount: 0,
        nextMember: ${JSON.stringify(cursorMember)},
        nextEvent: ${JSON.stringify(cursorEvent)},
      }), { status: 200, headers: { 'content-type': 'application/json' } }),
      sleep: async () => {},
      randomUUID: () => 'cursor-child',
    });
  `
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' })
  assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`)
  assert.doesNotMatch(`${child.stdout}\n${child.stderr}`, new RegExp(`${cursorMember}|${cursorEvent}`))
  assert.equal(JSON.parse(child.stdout).backfill.remaining, 0)
})

const mutatingCommands = [
  'fixture-create', 'fixture-reset', 'upload-smoke', 'backfill-create', 'backfill-run',
  'late-fixtures', 'reconcile', 'activation-rehearsal', 'rollback-active', 'monitor',
]

test('all production mutations require wrapper gate and sticky recovery blocks ordinary mutation', () => {
  for (const command of mutatingCommands) {
    assert.throws(() => assertCommandAllowed({}, command), /wrapper gate/i)
    assert.doesNotThrow(() => assertCommandAllowed({ wrapperGatePassed: true }, command))
    assert.throws(
      () => assertCommandAllowed({ wrapperGatePassed: true, forwardRecoveryRequired: true }, command),
      /forward recovery required/i,
    )
  }
  for (const command of ['verify-emergency', 'forward-recover', 'cleanup']) {
    assert.doesNotThrow(() => assertCommandAllowed({ wrapperGatePassed: true, forwardRecoveryRequired: true }, command))
  }
})

async function writeMigrations(dir: string): Promise<Record<string, string>> {
  await mkdir(dir, { recursive: true })
  const files: Record<string, string> = {}
  for (const version of MANAGED_MIGRATION_VERSIONS) {
    const file = path.join(dir, `${version}_pricing.sql`)
    const sql = `-- ${version}\nSELECT '${version}';\n`
    await writeFile(file, sql)
    files[version] = file
  }
  return files
}

test('migration manifest hashes exact immutable files and rejects duplicate path/version or replacement', async () => {
  const dir = await tempDir()
  const files = await writeMigrations(dir)
  const manifest = await createMigrationManifest(Object.values(files), { fs: nodeFs })
  assert.deepEqual(Object.keys(manifest.migrationHashes), MANAGED_MIGRATION_VERSIONS)
  for (const [version, file] of Object.entries(files)) {
    assert.equal(manifest.migrationHashes[version], digest(await readFile(file)))
  }
  assert.equal(manifest.manifestHash, sha256(JSON.stringify(manifest.entries)))
  await assert.rejects(createMigrationManifest([files[MANAGED_MIGRATION_VERSIONS[0]], files[MANAGED_MIGRATION_VERSIONS[0]]], { fs: nodeFs }), /duplicate path/i)
  const duplicateVersion = path.join(dir, `${MANAGED_MIGRATION_VERSIONS[0]}_other.sql`)
  await writeFile(duplicateVersion, 'SELECT 2;')
  await assert.rejects(createMigrationManifest([files[MANAGED_MIGRATION_VERSIONS[0]], duplicateVersion], { fs: nodeFs }), /duplicate version/i)

  const initial = mergeMigrationManifestState({ wrapperGatePassed: true }, manifest)
  const recovery = path.join(dir, `${RECOVERY_MIN_VERSION}_recovery.sql`)
  await writeFile(recovery, 'SELECT recovery;')
  const extendedManifest = await createMigrationManifest([recovery], { fs: nodeFs })
  const extended = mergeMigrationManifestState(initial, extendedManifest)
  assert.equal(extended.plannedMigrationHashes[RECOVERY_MIN_VERSION], digest('SELECT recovery;'))
  assert.equal(
    extended.manifestHash,
    digest(JSON.stringify(Object.entries(extended.plannedMigrationHashes).sort(([left], [right]) => left.localeCompare(right)))),
  )
  assert.notEqual(extended.manifestHash, initial.manifestHash)
  const renamed = { ...manifest, entries: manifest.entries.map((entry, index) => index === 0 ? { ...entry, path: 'renamed.sql' } : entry) }
  assert.throws(() => mergeMigrationManifestState(initial, renamed), /planned migration path/i)
})

function exactMigrationList(versions = MANAGED_MIGRATION_VERSIONS): string {
  return [
    ' Local | Remote | Time (UTC)',
    '-------|--------|-----------',
    ...versions.map(version => ` ${version} | ${version} | 2026-07-10`),
  ].join('\n')
}

function emptyPrettyMigrationList(): string {
  return [
    '',
    '  ',
    '   Local | Remote | Time (UTC) ',
    '  -------|--------|------------',
    '',
  ].join('\n')
}

test('migration gate accepts only an explicit empty Supabase pre-history and records its audit proof', async () => {
  const migrationsDir = await tempDir()
  const migrationList = emptyPrettyMigrationList()
  assert.throws(() => parseMigrationList(migrationList), /no version rows/i)
  assert.deepEqual(parseMigrationList(migrationList, { allowEmptyHistory: true }), [])

  const acceptedAt = '2026-07-11T01:02:03.000Z'
  const accepted = await validateMigrationGate({
    state: { wrapperGatePassed: true },
    migrationList,
    migrationsDir,
    phase: 'pre',
    allowEmptyHistory: true,
    fs: nodeFs,
    now: () => acceptedAt,
  })
  const emptyHash = digest(JSON.stringify([]))
  assert.deepEqual(accepted.migrationBaselineVersions, [])
  assert.equal(accepted.migrationBaselineHash, emptyHash)
  assert.equal(accepted.emptyHistoryAccepted, true)
  assert.deepEqual(accepted.migrationGateHistory, [{
    phase: 'pre',
    versions: [],
    historyHash: emptyHash,
    emptyHistoryAccepted: true,
    timestamp: acceptedAt,
  }])

  const repeated = await validateMigrationGate({
    state: accepted,
    migrationList,
    migrationsDir,
    phase: 'pre',
    allowEmptyHistory: true,
    fs: nodeFs,
  })
  assert.deepEqual(repeated.migrationBaselineVersions, [])
  assert.equal(repeated.emptyHistoryAccepted, true)
  assert.equal(repeated.migrationGateHistory.length, 1)

  await assert.rejects(validateMigrationGate({
    state: { ...accepted, appliedMigrationHashes: { [MANAGED_MIGRATION_VERSIONS[0]]: 'bound-hash' } },
    migrationList,
    migrationsDir,
    phase: 'pre',
    allowEmptyHistory: true,
    fs: nodeFs,
  }), /baseline.*bound|migration history/i)
  await assert.rejects(validateMigrationGate({
    state: { appliedMigrationHashes: { [MANAGED_MIGRATION_VERSIONS[0]]: 'bound-hash' } },
    migrationList,
    migrationsDir,
    phase: 'pre',
    allowEmptyHistory: true,
    fs: nodeFs,
  }), /bound.*empty|empty.*bound/i)
})

test('empty-history opt-in rejects unsafe output shapes, nonempty rows, and post phase', async () => {
  const migrationsDir = await tempDir()
  const validEmpty = emptyPrettyMigrationList()
  const invalidEmptyOutputs = [
    '',
    '   \n',
    'not supabase migration output',
    'Local | Remote | Time (UTC)',
    'Local | Remote | Timestamp\n------|--------|----------',
    `${validEmpty}\nunexpected warning`,
  ]
  for (const migrationList of invalidEmptyOutputs) {
    assert.throws(() => parseMigrationList(migrationList, { allowEmptyHistory: true }), /migration list|empty history|supabase/i)
  }

  await assert.rejects(validateMigrationGate({
    state: {}, migrationList: validEmpty, migrationsDir, phase: 'pre', fs: nodeFs,
  }), /no version rows/i)
  await assert.rejects(validateMigrationGate({
    state: {}, migrationList: validEmpty, migrationsDir, phase: 'post', allowEmptyHistory: true, fs: nodeFs,
  }), /allow-empty-history.*pre/i)
  await assert.rejects(validateMigrationGate({
    state: {}, migrationList: exactMigrationList(['202606010001']), migrationsDir, phase: 'pre', allowEmptyHistory: true, fs: nodeFs,
  }), /allow-empty-history.*empty/i)

  for (const migrationList of [
    exactMigrationList(['202606010001']).replace('202606010001 | 202606010001', '202606010001 |'),
    exactMigrationList(['202606010001']).replace('202606010001 | 202606010001', '| 202606010001'),
  ]) {
    await assert.rejects(validateMigrationGate({
      state: {}, migrationList, migrationsDir, phase: 'pre', allowEmptyHistory: true, fs: nodeFs,
    }), /allow-empty-history.*empty|local.*remote mismatch/i)
  }
})

test('migration-gate CLI forwards empty-history opt-in and emits only the sanitized boolean proof', async () => {
  const dir = await tempDir()
  const migrationsDir = path.join(dir, 'migrations')
  const migrationListPath = path.join(dir, 'migration-list.txt')
  const statePath = path.join(dir, 'private-state.json')
  const outPath = path.join(dir, 'migration-gate.json')
  await mkdir(migrationsDir)
  await writeFile(migrationListPath, emptyPrettyMigrationList())
  await writeFile(statePath, JSON.stringify({ wrapperGatePassed: true, serviceKey: 'sentinel-secret' }))

  const modulePath = path.resolve(process.cwd(), 'scripts/tokend-production-rollout.mjs')
  const child = spawnSync(process.execPath, [
    modulePath,
    'migration-gate',
    '--migration-list', migrationListPath,
    '--migrations-dir', migrationsDir,
    '--state', statePath,
    '--phase', 'pre',
    '--allow-empty-history',
    '--out', outPath,
  ], { encoding: 'utf8' })
  assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`)

  const stdout = JSON.parse(child.stdout.trim())
  const output = JSON.parse(await readFile(outPath, 'utf8'))
  const saved = JSON.parse(await readFile(statePath, 'utf8'))
  assert.equal(stdout.emptyHistoryAccepted, true)
  assert.equal(output.emptyHistoryAccepted, true)
  assert.equal(saved.emptyHistoryAccepted, true)
  assert.deepEqual(saved.migrationBaselineVersions, [])
  assert.doesNotMatch(`${child.stdout}\n${child.stderr}\n${JSON.stringify(output)}`, /sentinel-secret/)
})

test('migration gate records a clean baseline then binds planned migrations incrementally on post', async () => {
  const sourceDir = await tempDir()
  const stagedDir = await tempDir()
  const files = await writeMigrations(sourceDir)
  const manifest = await createMigrationManifest(Object.values(files), { fs: nodeFs })
  assert.deepEqual(parseMigrationList(exactMigrationList()).map(row => row.local), MANAGED_MIGRATION_VERSIONS)

  const state = {
    wrapperGatePassed: true,
    plannedMigrationHashes: manifest.migrationHashes,
    manifestHash: manifest.manifestHash,
    transition: 'pre-wrapper-gated',
  }
  const oldVersion = '202606010001'
  const gated = await validateMigrationGate({
    state, migrationList: exactMigrationList([oldVersion]), migrationsDir: stagedDir, phase: 'pre', fs: nodeFs,
    now: () => '2026-07-10T00:00:00.000Z',
  })
  assert.equal(gated.transition, 'migrations-consistent')
  assert.deepEqual(gated.appliedMigrationHashes ?? {}, {})
  assert.equal(gated.migrationGateHistory[0].phase, 'pre')
  assert.deepEqual(gated.migrationBaselineVersions, [oldVersion])
  const repeatedPre = await validateMigrationGate({
    state: gated, migrationList: exactMigrationList([oldVersion]), migrationsDir: stagedDir, phase: 'pre', fs: nodeFs,
  })
  assert.deepEqual(repeatedPre.migrationBaselineVersions, [oldVersion])
  assert.equal(repeatedPre.migrationGateHistory.length, gated.migrationGateHistory.length)
  await assert.rejects(validateMigrationGate({
    state: gated, migrationList: exactMigrationList([oldVersion, '202606010002']), migrationsDir: stagedDir, phase: 'pre', fs: nodeFs,
  }), /baseline.*bound|unexpected.*migration|rogue/i)
  for (const contaminatedVersion of [MANAGED_MIGRATION_VERSIONS[0], EMERGENCY_VERSION, RECOVERY_MIN_VERSION]) {
    await assert.rejects(validateMigrationGate({
      state,
      migrationList: exactMigrationList([oldVersion, contaminatedVersion]),
      migrationsDir: stagedDir,
      phase: 'pre',
      fs: nodeFs,
    }), /initial.*baseline.*rollout|managed|emergency|recovery/i)
  }

  await assert.rejects(validateMigrationGate({
    state: gated,
    migrationList: exactMigrationList([oldVersion]),
    migrationsDir: stagedDir,
    phase: 'post',
    fs: nodeFs,
  }), /exactly one|idempotent.*binding|matching post binding/i)

  await writeFile(path.join(stagedDir, path.basename(files[MANAGED_MIGRATION_VERSIONS[0]])), await readFile(files[MANAGED_MIGRATION_VERSIONS[0]]))
  await writeFile(path.join(stagedDir, path.basename(files[MANAGED_MIGRATION_VERSIONS[1]])), await readFile(files[MANAGED_MIGRATION_VERSIONS[1]]))
  await assert.rejects(validateMigrationGate({
    state: gated,
    migrationList: exactMigrationList([oldVersion, MANAGED_MIGRATION_VERSIONS[0], MANAGED_MIGRATION_VERSIONS[1]]),
    migrationsDir: stagedDir, phase: 'post', fs: nodeFs,
  }), /one migration|single.*binding|batch/i)
  await assert.rejects(validateMigrationGate({
    state: gated, migrationList: exactMigrationList([oldVersion, MANAGED_MIGRATION_VERSIONS[1]]),
    migrationsDir: stagedDir, phase: 'post', fs: nodeFs,
  }), /production order|expected.*001/i)

  let post = gated
  const deployed = [oldVersion]
  for (const version of MANAGED_MIGRATION_VERSIONS) {
    await writeFile(path.join(stagedDir, path.basename(files[version])), await readFile(files[version]))
    deployed.push(version)
    post = await validateMigrationGate({
      state: post, migrationList: exactMigrationList(deployed), migrationsDir: stagedDir, phase: 'post', fs: nodeFs,
      now: () => `2026-07-10T00:0${deployed.length}:00.000Z`,
    })
    assert.equal(post.appliedMigrationHashes[version], manifest.migrationHashes[version])
    const idempotent = await validateMigrationGate({
      state: post, migrationList: exactMigrationList(deployed), migrationsDir: stagedDir, phase: 'post', fs: nodeFs,
    })
    assert.equal(idempotent.appliedMigrationHashes[version], manifest.migrationHashes[version])
    const precheck = await validateMigrationGate({
      state: post, migrationList: exactMigrationList(deployed), migrationsDir: stagedDir, phase: 'pre', fs: nodeFs,
    })
    assert.deepEqual(precheck.migrationBaselineVersions, [oldVersion])
  }
  assert.deepEqual(post.appliedMigrationHashes, manifest.migrationHashes)
  assert.equal(post.migrationGateHistory.filter(entry => entry.phase === 'post').length, MANAGED_MIGRATION_VERSIONS.length)

  const latestVersion = MANAGED_MIGRATION_VERSIONS.at(-1)!
  await assert.rejects(validateMigrationGate({
    state: { ...post, migrationGateHistory: post.migrationGateHistory.filter(entry => entry.version !== latestVersion) },
    migrationList: exactMigrationList(deployed),
    migrationsDir: stagedDir,
    phase: 'post',
    fs: nodeFs,
  }), /matching post binding/i)

  await assert.rejects(validateMigrationGate({
    state, migrationList: exactMigrationList([oldVersion]).replace(`${oldVersion} | ${oldVersion}`, `${oldVersion} | 202607109998`),
    migrationsDir: stagedDir, phase: 'pre', fs: nodeFs,
  }), /local.*remote mismatch/i)

  const badDir = await tempDir()
  await assert.rejects(validateMigrationGate({
    state: gated, migrationList: exactMigrationList([oldVersion, MANAGED_MIGRATION_VERSIONS[0]]),
    migrationsDir: badDir, phase: 'post', fs: nodeFs,
  }), /staged migration file missing/i)
  await writeFile(path.join(badDir, path.basename(files[MANAGED_MIGRATION_VERSIONS[0]])), 'SELECT tampered;')
  await assert.rejects(validateMigrationGate({
    state: gated, migrationList: exactMigrationList([oldVersion, MANAGED_MIGRATION_VERSIONS[0]]),
    migrationsDir: badDir, phase: 'post', fs: nodeFs,
  }), /planned hash mismatch/i)
  await assert.rejects(validateMigrationGate({
    state: { ...gated, plannedMigrationHashes: {} },
    migrationList: exactMigrationList([oldVersion, MANAGED_MIGRATION_VERSIONS[0]]),
    migrationsDir: stagedDir, phase: 'post', fs: nodeFs,
  }), /not preplanned/i)
  await assert.rejects(validateMigrationGate({
    state: { ...gated, appliedMigrationHashes: { [MANAGED_MIGRATION_VERSIONS[0]]: 'different' } },
    migrationList: exactMigrationList([oldVersion, MANAGED_MIGRATION_VERSIONS[0]]),
    migrationsDir: stagedDir, phase: 'post', fs: nodeFs,
  }), /applied hash.*immutable/i)
  await assert.rejects(validateMigrationGate({
    state, migrationList: exactMigrationList([oldVersion, EMERGENCY_VERSION]),
    migrationsDir: stagedDir, phase: 'pre', fs: nodeFs,
  }), /emergency.*baseline/i)
})

test('emergency migration is sticky and later versions cannot clear forward recovery', async () => {
  const dir = await tempDir()
  const files = await writeMigrations(dir)
  const emergencyFile = path.join(dir, `${EMERGENCY_VERSION}_rollback.sql`)
  await writeFile(emergencyFile, 'SELECT emergency;')
  const allFiles = [...Object.values(files), emergencyFile]
  const manifest = await createMigrationManifest(allFiles, { fs: nodeFs })
  const versions = [...MANAGED_MIGRATION_VERSIONS, EMERGENCY_VERSION]
  const state = {
    wrapperGatePassed: true,
    plannedMigrationHashes: manifest.migrationHashes,
    manifestHash: manifest.manifestHash,
  }
  const baseline = await validateMigrationGate({
    state, migrationList: exactMigrationList(['202606010001']), migrationsDir: dir, phase: 'pre', fs: nodeFs,
  })
  let gated = baseline
  const deployed = ['202606010001']
  for (const version of versions) {
    deployed.push(version)
    gated = await validateMigrationGate({
      state: gated, migrationList: exactMigrationList(deployed), migrationsDir: dir, phase: 'post', fs: nodeFs,
    })
  }
  assert.equal(gated.forwardRecoveryRequired, true)
  const recoveryFile = path.join(dir, `${RECOVERY_MIN_VERSION}_forward.sql`)
  await writeFile(recoveryFile, 'SELECT forward;')
  const recoveryManifest = await createMigrationManifest([recoveryFile], { fs: nodeFs })
  const withRecovery = mergeMigrationManifestState(gated, recoveryManifest)
  const later = await validateMigrationGate({
    state: withRecovery,
    migrationList: exactMigrationList(['202606010001', ...versions, RECOVERY_MIN_VERSION]),
    migrationsDir: dir, phase: 'post', fs: nodeFs,
  })
  assert.equal(later.forwardRecoveryRequired, true)
})

test('emergency verification requires 999 history and only the legacy surface', () => {
  const baseState = {
    wrapperGatePassed: true,
    forwardRecoveryRequired: true,
    appliedMigrationHashes: { [EMERGENCY_VERSION]: 'emergency-hash' },
  }
  const emergencySurface = {
    legacyWrapperPresent: true,
    legacyWrapperAllowed: true,
    legacyRpcNames: [...LEGACY_RPC_NAMES],
    legacyAllowedRpcNames: [...LEGACY_RPC_NAMES],
    v2UploadPresent: false,
    vNextRpcNames: [],
    adminRpcNames: [],
  }
  const verified = validateEmergencySurface({
    state: baseState,
    migrationList: exactMigrationList([...MANAGED_MIGRATION_VERSIONS, EMERGENCY_VERSION]),
    surface: emergencySurface,
    now: () => '2026-07-10T01:00:00.000Z',
  })
  assert.equal(verified.emergencyVerified, true)
  assert.equal(verified.forwardRecoveryRequired, true)
  assert.equal(verified.transition, 'emergency-verified')
  assert.throws(() => validateEmergencySurface({
    state: baseState, migrationList: exactMigrationList(MANAGED_MIGRATION_VERSIONS), surface: emergencySurface,
  }), /999.*history/i)
  assert.throws(() => validateEmergencySurface({
    state: baseState,
    migrationList: exactMigrationList([...MANAGED_MIGRATION_VERSIONS, EMERGENCY_VERSION]),
    surface: { ...emergencySurface, vNextRpcNames: [CLIENT_RPC_NAMES[0]] },
  }), /vNext.*absent/i)
  assert.throws(() => validateEmergencySurface({
    state: baseState,
    migrationList: exactMigrationList([...MANAGED_MIGRATION_VERSIONS, EMERGENCY_VERSION]),
    surface: { ...emergencySurface, legacyWrapperAllowed: false },
  }), /legacy.*allowed/i)
  assert.throws(() => validateEmergencySurface({
    state: baseState,
    migrationList: exactMigrationList([...MANAGED_MIGRATION_VERSIONS, EMERGENCY_VERSION]),
    surface: { ...emergencySurface, legacyAllowedRpcNames: LEGACY_RPC_NAMES.slice(1) },
  }), /legacy.*allowed/i)
})

function pgDumpPostSchema({ grantPrivilege = 'ALL', body = `SELECT '{}'::"jsonb";`, redundantRevokes = false } = {}): string {
  const signatures: Record<string, string> = {
    tokend_upload_events_v2: 'TEXT, JSONB, JSONB',
    [PREFLIGHT_RPC_NAME]: '',
    ...ADMIN_RPC_SIGNATURES,
    ...CLIENT_RPC_SIGNATURES,
  }
  const functions = Object.entries(signatures).map(([name, signature]) => {
    const types = signature ? signature.split(',').map(type => type.trim().toLowerCase()) : []
    const namedSignature = types.map((type, index) => `"p_arg_${index + 1}" "${type}"`).join(', ')
    const aclSignature = types.map(type => `"${type}"`).join(', ')
    const roles = ADMIN_RPC_NAMES.includes(name) || name === PREFLIGHT_RPC_NAME
      ? ['service_role']
      : ['anon', 'authenticated']
    const grants = roles.map(role => `GRANT ${grantPrivilege} ON FUNCTION "public"."${name}"(${aclSignature}) TO "${role}";`).join('\n')
    const redundant = redundantRevokes
      ? ['anon', 'authenticated', 'service_role'].map(role => `REVOKE ALL ON FUNCTION "public"."${name}"(${aclSignature}) FROM "${role}";`).join('\n')
      : ''
    return `
CREATE FUNCTION "public"."${name}"(${namedSignature}) RETURNS "jsonb"
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $function$
${body}
$function$;

ALTER FUNCTION "public"."${name}"(${aclSignature}) OWNER TO "postgres";

REVOKE ALL ON FUNCTION "public"."${name}"(${aclSignature}) FROM PUBLIC;
${redundant}
${grants}
`
  }).join('\n')
  return `-- PostgreSQL database dump\n\nSET statement_timeout = 0;\nSET lock_timeout = 0;\n${functions}\n-- PostgreSQL database dump complete\n`
}

function recoveredLiveSurface() {
  return {
    legacyWrapperPresent: true,
    v2UploadPresent: true,
    clientRpcNames: [...CLIENT_RPC_NAMES],
    adminRpcNames: [...ADMIN_RPC_NAMES],
    securityDefinerNames: ['tokend_upload_events_v2', PREFLIGHT_RPC_NAME, ...ADMIN_RPC_NAMES, ...CLIENT_RPC_NAMES],
    searchPathNames: ['tokend_upload_events_v2', PREFLIGHT_RPC_NAME, ...ADMIN_RPC_NAMES, ...CLIENT_RPC_NAMES],
    anonExecuteNames: ['tokend_upload_events_v2', ...CLIENT_RPC_NAMES],
    serviceExecuteNames: [PREFLIGHT_RPC_NAME, ...ADMIN_RPC_NAMES],
  }
}

test('forward recovery rejects every bypass and only one newly reviewed exact binding clears sticky state', async () => {
  const dir = await tempDir()
  const recoveryVersion = RECOVERY_MIN_VERSION
  const migrationFile = path.join(dir, `${recoveryVersion}_forward_recovery.sql`)
  const migrationSql = 'SELECT newly_reviewed_forward_recovery;\n'
  await writeFile(migrationFile, migrationSql)
  const lowRecoveryFile = path.join(dir, '202607100998_forward_recovery.sql')
  await writeFile(lowRecoveryFile, migrationSql)
  const migrationHash = digest(migrationSql)
  const versions = [...MANAGED_MIGRATION_VERSIONS, EMERGENCY_VERSION, recoveryVersion]
  const bindingHash = digest(`${recoveryVersion}:${migrationHash}`)
  const baseState = {
    wrapperGatePassed: true,
    forwardRecoveryRequired: true,
    emergencyVerified: true,
    plannedMigrationHashes: { [recoveryVersion]: migrationHash },
    appliedMigrationHashes: { [recoveryVersion]: migrationHash, [EMERGENCY_VERSION]: 'emergency' },
    migrationGateHistory: [{ phase: 'post', version: recoveryVersion, hash: migrationHash, bindingHash }],
  }
  const approval = {
    version: recoveryVersion,
    migrationHash,
    specReview: 'Approved',
    qualityReview: 'Approved',
  }
  const common = {
    state: baseState,
    migrationList: exactMigrationList(versions),
    migrationsDir: dir,
    migrationFile,
    approval,
    postSchema: pgDumpPostSchema({ redundantRevokes: true }),
    livePostSchema: pgDumpPostSchema(),
    liveSurface: recoveredLiveSurface(),
    fs: nodeFs,
    now: () => '2026-07-11T00:00:00.000Z',
  }
  assert.match(common.livePostSchema, /REVOKE ALL ON FUNCTION "public"\."tokend_upload_events_v2"\([^)]*\) FROM PUBLIC;/)
  assert.doesNotMatch(common.livePostSchema, /tokend_upload_events_v2"\([^)]*\) FROM "anon";/)
  assert.match(common.postSchema, /tokend_upload_events_v2"\([^)]*\) FROM "anon";/)
  const recovered = await validateForwardRecovery(common)

  const rejected: Array<[string, Record<string, unknown>, RegExp]> = [
    ['missing emergency verification', { state: { ...baseState, emergencyVerified: false } }, /emergency verification/i],
    ['missing 999 history', { migrationList: exactMigrationList([...MANAGED_MIGRATION_VERSIONS, recoveryVersion]) }, /999.*history/i],
    ['replay missing 001-004', { migrationList: exactMigrationList([EMERGENCY_VERSION, recoveryVersion]) }, /001.*004|managed migration/i],
    ['low recovery version', {
      migrationFile: lowRecoveryFile,
      migrationList: exactMigrationList([...MANAGED_MIGRATION_VERSIONS, EMERGENCY_VERSION, '202607100998']),
    }, /recovery version/i],
    ['not staged in directory', { migrationFile: path.join(path.dirname(dir), path.basename(migrationFile)) }, /migrations directory/i],
    ['planned hash mismatch', { state: { ...baseState, plannedMigrationHashes: { [recoveryVersion]: 'wrong' } } }, /planned hash/i],
    ['applied hash mismatch', { state: { ...baseState, appliedMigrationHashes: { [recoveryVersion]: 'wrong', [EMERGENCY_VERSION]: 'emergency' } } }, /applied hash/i],
    ['approval hash mismatch', { approval: { ...approval, migrationHash: 'wrong' } }, /approval hash/i],
    ['spec review missing', { approval: { ...approval, specReview: 'Pending' } }, /specReview.*Approved/i],
    ['quality review missing', { approval: { ...approval, qualityReview: 'Rejected' } }, /qualityReview.*Approved/i],
    ['post gate missing', { state: { ...baseState, migrationGateHistory: [] } }, /post migration gate/i],
    ['schema only incomplete', { postSchema: pgDumpPostSchema().replace('tokend_upload_events_v2', 'missing_v2') }, /post schema/i],
    ['schema grants incomplete', {
      postSchema: pgDumpPostSchema().replace(
        `GRANT ALL ON FUNCTION "public"."tokend_get_summary_v5"("text", "text", "text") TO "anon";`,
        `GRANT ALL ON FUNCTION "public"."tokend_get_summary_v5"("text", "text", "text") TO "service_role";`,
      ),
    }, /post schema.*grant/i],
    ['linked live schema differs from reviewed schema', {
      livePostSchema: pgDumpPostSchema({ body: `SELECT '{"live":true}'::"jsonb";` }),
    }, /linked live schema.*reviewed/i],
    ['linked dump ACL role is invalid', {
      livePostSchema: pgDumpPostSchema().replace(
        `GRANT ALL ON FUNCTION "public"."tokend_get_summary_v5"("text", "text", "text") TO "anon";`,
        `GRANT ALL ON FUNCTION "public"."tokend_get_summary_v5"("text", "text", "text") TO "intruder";`,
      ),
    }, /post schema.*grant/i],
    ['RPC only incomplete', { liveSurface: { ...recoveredLiveSurface(), anonExecuteNames: [] } }, /live.*grants/i],
  ]
  for (const [label, override, pattern] of rejected) {
    await assert.rejects(validateForwardRecovery({ ...common, ...override }), pattern, label)
  }

  assert.equal(recovered.forwardRecoveryRequired, false)
  assert.equal(recovered.recoveryVersion, recoveryVersion)
  assert.equal(recovered.recoveryHash, migrationHash)
  assert.match(recovered.livePostSchemaHash, /^[a-f0-9]{64}$/)
  assert.equal(recovered.livePostSchemaSource, 'supabase-db-dump-linked')
  assert.equal(recovered.livePostSchemaRecoveryBinding, digest(`${recoveryVersion}:${migrationHash}:${recovered.livePostSchemaHash}`))
  assert.equal(recovered.transition, 'newly-reviewed-forward-recovered')
  assert.doesNotThrow(() => assertCommandAllowed(recovered, 'fixture-create'))
})

test('forward-recover command obtains an independent linked schema dump instead of trusting argv post-schema', async () => {
  const dir = await tempDir()
  const statePath = path.join(dir, 'state.json')
  const migrationListPath = path.join(dir, 'migration-list.txt')
  const migrationFile = path.join(dir, `${RECOVERY_MIN_VERSION}_forward.sql`)
  const postSchemaPath = path.join(dir, 'post.sql')
  const approvalPath = path.join(dir, 'approval.json')
  const outPath = path.join(dir, 'recover.json')
  await atomicWriteJson(statePath, { wrapperGatePassed: true, forwardRecoveryRequired: true }, { fs: nodeFs, randomUUID })
  await writeFile(migrationListPath, exactMigrationList([...MANAGED_MIGRATION_VERSIONS, EMERGENCY_VERSION, RECOVERY_MIN_VERSION]))
  await writeFile(migrationFile, 'SELECT recovery;')
  await writeFile(postSchemaPath, pgDumpPostSchema({ redundantRevokes: true }))
  await writeFile(approvalPath, '{}')
  let dumpCalls = 0
  const runner = createRolloutRunner({
    env: {},
    fetch: async () => { throw new Error('network must not be reached before linked schema equality') },
    fs: nodeFs,
    dumpLinkedSchema: async () => {
      dumpCalls += 1
      return pgDumpPostSchema({ grantPrivilege: 'ALL', body: `SELECT '{"linked":true}'::"jsonb";` })
    },
    clock: () => new Date(), sleep: async () => {}, randomUUID,
  })
  await assert.rejects(runner.execute('forward-recover', {
    state: statePath,
    migrationList: migrationListPath,
    migrationsDir: dir,
    migrationFile,
    postSchema: postSchemaPath,
    approval: approvalPath,
    out: outPath,
  }), /linked live schema.*reviewed/i)
  assert.equal(dumpCalls, 1)
})

test('REST pagination follows Content-Range until the full baseline is aggregated', async () => {
  const rows = Array.from({ length: 1501 }, (_, id) => ({ id, total_cost: 1 }))
  const ranges: Array<{ range: string; unit: string }> = []
  const fakeFetch: typeof fetch = async (_url, init) => {
    const headers = init?.headers as Record<string, string>
    const range = String(headers?.Range ?? '')
    ranges.push({ range, unit: String(headers?.['Range-Unit'] ?? '') })
    const [, fromText, toText] = /^(\d+)-(\d+)$/.exec(range) ?? []
    const from = Number(fromText)
    const to = Math.min(Number(toText), rows.length - 1)
    return jsonResponse(rows.slice(from, to + 1), 200, { 'content-range': `${from}-${to}/${rows.length}` })
  }
  const all = await fetchAllPages({ fetch: fakeFetch, url: 'https://example.invalid/rest/v1/events', headers: {}, pageSize: 1000 })
  assert.equal(all.length, 1501)
  assert.deepEqual(ranges, [
    { range: '0-999', unit: 'items' },
    { range: '1000-1500', unit: 'items' },
  ])
  assert.equal(all.reduce((sum, row: any) => sum + row.total_cost, 0), 1501)
  const empty = await fetchAllPages({
    fetch: async () => jsonResponse([], 200, { 'content-range': '*/0' }),
    url: 'https://example.invalid/rest/v1/empty', headers: {}, pageSize: 1000,
  })
  assert.deepEqual(empty, [])
})

test('retry uses injected 1/2/4 second backoff for network, 429, and 5xx only', async () => {
  const sleeps: number[] = []
  let attempt = 0
  const value = await retryTransient(async () => {
    attempt += 1
    if (attempt === 1) throw Object.assign(new Error('network'), { code: 'ECONNRESET' })
    if (attempt === 2) throw Object.assign(new Error('rate limited'), { status: 429 })
    if (attempt === 3) throw Object.assign(new Error('upstream'), { status: 503 })
    return 'ok'
  }, { maxRetries: 3, sleep: async ms => { sleeps.push(ms) } })
  assert.equal(value, 'ok')
  assert.deepEqual(sleeps, [1000, 2000, 4000])

  let sqlAttempts = 0
  await assert.rejects(retryTransient(async () => {
    sqlAttempts += 1
    throw Object.assign(new Error('state conflict'), { sqlstate: '55000', status: 503 })
  }, { maxRetries: 3, sleep: async () => { throw new Error('must not sleep') } }), /state conflict/)
  assert.equal(sqlAttempts, 1)
})

test('sample comparison gates HTTP, JSON, multiplier, and absolute two-second P95', () => {
  assert.equal(percentile95([0.01, 0.02, 0.1, 0.2]), 0.2)
  const baseline = { count: 100, httpErrorCount: 1, jsonErrorCount: 1, p95Seconds: 0.5 }
  assert.equal(compareSampleReports(baseline, { count: 100, httpErrorCount: 2, jsonErrorCount: 1, p95Seconds: 0.9 }, {
    maxErrorRateDelta: 0.01, maxP95Multiplier: 2, maxP95Seconds: 2,
  }).passed, true)
  assert.throws(() => compareSampleReports(baseline, { ...baseline, httpErrorCount: 3 }, { maxErrorRateDelta: .01, maxP95Multiplier: 2, maxP95Seconds: 2 }), /HTTP error rate/i)
  assert.throws(() => compareSampleReports(baseline, { ...baseline, jsonErrorCount: 3 }, { maxErrorRateDelta: .01, maxP95Multiplier: 2, maxP95Seconds: 2 }), /JSON error rate/i)
  assert.throws(() => compareSampleReports(baseline, { ...baseline, p95Seconds: 1.1 }, { maxErrorRateDelta: .01, maxP95Multiplier: 2, maxP95Seconds: 2 }), /P95/i)
  assert.throws(() => compareSampleReports({ ...baseline, p95Seconds: 1.5 }, { ...baseline, p95Seconds: 2.01 }, { maxErrorRateDelta: .01, maxP95Multiplier: 2, maxP95Seconds: 2 }), /P95/i)
})

function costEnvelope(total = 10) {
  return {
    inputTokens: 1, outputTokens: 2, reasoningTokens: 3, cacheReadTokens: 4, cacheWriteTokens: 5,
    totalTokens: 15, inputCost: 2, outputCost: 2, reasoningCost: 2, cacheReadCost: 2,
    cacheWriteCost: 2, unallocatedCost: 0, totalCost: total,
    eligibleEventCount: 1, reportedEventCount: 1, estimatedEventCount: 0,
    zeroRateEventCount: 0, legacyEventCount: 0, unpricedEventCount: 0,
    breakdownInvalidCount: 0, costAvailability: 1, verifiedCostCoverage: 1,
    coverageStatus: 'complete', costDetailsAvailable: true,
  }
}

test('nine vNext RPCs expose exact envelopes and aggregate/detail/legacy/grant equality', () => {
  const envelope = costEnvelope()
  const report = {
    adminExpected: true,
    clientRpcResults: Object.fromEntries(CLIENT_RPC_NAMES.map(name => [name, { ok: true, ...envelope }])),
    summaryEnvelope: envelope,
    childEnvelopeSums: {
      daily: envelope, model: envelope, channel: envelope, session: envelope, project: envelope,
    },
    detailParentPairs: [
      { detail: envelope, parent: envelope },
      { detail: envelope, parent: envelope },
      { detail: envelope, parent: envelope },
    ],
    legacyRpcNames: [...LEGACY_RPC_NAMES],
    liveAccess: {
      anonAllowed: ['tokend_upload_events', 'tokend_upload_events_v2', ...CLIENT_RPC_NAMES],
      serviceDenied: ['tokend_upload_events', 'tokend_upload_events_v2', ...CLIENT_RPC_NAMES],
      serviceAllowed: [PREFLIGHT_RPC_NAME, ...ADMIN_RPC_NAMES],
      anonDenied: [PREFLIGHT_RPC_NAME, ...ADMIN_RPC_NAMES],
    },
  }
  assert.equal(validateRpcVerification(report, 1e-9).passed, true)
  assert.throws(() => validateRpcVerification({
    ...report,
    childEnvelopeSums: { ...report.childEnvelopeSums, daily: costEnvelope(10.00001) },
  }, 1e-9), /summary.*daily/i)
  assert.throws(() => validateRpcVerification({
    ...report, clientRpcResults: { [CLIENT_RPC_NAMES[0]]: envelope },
  }, 1e-9), /nine.*RPC/i)
})

test('RPC verification calls real child keys and three selected details before equality checks', async () => {
  const envelope = costEnvelope()
  const halfEnvelope = Object.fromEntries(Object.entries(envelope).map(([key, value]) => {
    if (typeof value !== 'number') return [key, value]
    if (key === 'costAvailability' || key === 'verifiedCostCoverage') return [key, value]
    return [key, value / 2]
  }))
  const calls: Array<{ name: string; body: Record<string, unknown> }> = []
  const rows = {
    tokend_get_summary_v5: { ok: true, ...envelope },
    tokend_get_daily_trend_v5: {
      ok: true,
      days: [
        { day: '2026-07-09', ...halfEnvelope },
        { day: '2026-07-10', ...halfEnvelope },
      ],
    },
    tokend_get_model_breakdown_v3: { ok: true, models: [{ model: 'gpt-5.6-sol', ...envelope }] },
    tokend_get_model_detail_v2: { ok: true, model: 'gpt-5.6-sol', ...envelope },
    tokend_get_channel_breakdown_v4: { ok: true, channels: [{ channel: 'coding', ...envelope }] },
    tokend_get_channel_detail_v3: { ok: true, channel: 'coding', ...envelope },
    tokend_get_sessions_v2: { ok: true, sessions: [{ sessionId: 'fixture-session', ...envelope }] },
    tokend_get_session_detail_v2: { ok: true, sessionId: 'fixture-session', ...envelope },
    tokend_get_top_projects_v3: { ok: true, projects: [{ project: 'fixture-project', ...envelope }] },
  }
  const liveAccess = {
    anonAllowed: ['tokend_upload_events', 'tokend_upload_events_v2', ...CLIENT_RPC_NAMES],
    serviceDenied: ['tokend_upload_events', 'tokend_upload_events_v2', ...CLIENT_RPC_NAMES],
    serviceAllowed: [PREFLIGHT_RPC_NAME, ...ADMIN_RPC_NAMES],
    anonDenied: [PREFLIGHT_RPC_NAME, ...ADMIN_RPC_NAMES],
  }
  const report = await collectRpcVerification({
    token: 'fixture-token',
    liveAccess,
    adminExpected: true,
    callClient: async (name, body) => {
      calls.push({ name, body })
      return structuredClone(rows[name as keyof typeof rows])
    },
    callLegacy: async () => ({ ok: true }),
  })
  assert.equal(validateRpcVerification(report, 1e-9).passed, true)
  assert.equal(calls.length, 9)
  assert.equal(calls.find(call => call.name === 'tokend_get_model_detail_v2')?.body.p_model, 'gpt-5.6-sol')
  assert.equal(calls.find(call => call.name === 'tokend_get_channel_detail_v3')?.body.p_channel, 'coding')
  assert.equal(calls.find(call => call.name === 'tokend_get_session_detail_v2')?.body.p_session_id, 'fixture-session')
  await assert.rejects(collectRpcVerification({
    token: 'fixture-token', liveAccess, adminExpected: true,
    callClient: async (name) => name === 'tokend_get_model_breakdown_v3'
      ? { ok: true, modelDistribution: [{ model: 'wrong', ...envelope }] }
      : structuredClone(rows[name as keyof typeof rows]),
    callLegacy: async () => ({ ok: true }),
  }), /models.*non-empty/i)
})

test('live access proof derives grants from anon/service HTTP outcomes with safe invalid admin inputs', async () => {
  const calls: Array<{ name: string; auth: string; body: any }> = []
  const clientNames = new Set(['tokend_upload_events', 'tokend_upload_events_v2', ...CLIENT_RPC_NAMES])
  const adminNames = new Set([PREFLIGHT_RPC_NAME, ...ADMIN_RPC_NAMES])
  const fakeFetch: typeof fetch = async (input, init = {}) => {
    const name = String(input).split('/').at(-1) ?? ''
    const auth = String((init.headers as Record<string, string>)?.Authorization ?? '')
    const role = auth.endsWith('anon-key') ? 'anon' : 'service'
    const body = JSON.parse(String(init.body ?? '{}'))
    calls.push({ name, auth, body })
    if (clientNames.has(name)) return role === 'anon' ? jsonResponse({ ok: false, error: 'invalid_token' }) : jsonResponse({ code: '42501' }, 403)
    if (adminNames.has(name)) return role === 'service' ? jsonResponse({ code: '55000' }, name === PREFLIGHT_RPC_NAME ? 200 : 400) : jsonResponse({ code: '42501' }, 403)
    return jsonResponse({ code: 'PGRST202' }, 404)
  }
  const proof = await probeLiveRpcAccess({
    fetch: fakeFetch,
    url: 'https://project.supabase.co',
    anonKey: 'anon-key',
    serviceKey: 'service-key',
    expectAdmin: true,
  })
  assert.deepEqual(proof.anonAllowed, [...clientNames])
  assert.deepEqual(proof.serviceDenied, [...clientNames])
  assert.deepEqual(proof.serviceAllowed, [...adminNames])
  assert.deepEqual(proof.anonDenied, [...adminNames])
  const batchProbe = calls.find(call => call.name === 'tokend_pricing_backfill_batch' && call.auth.endsWith('service-key'))
  assert.deepEqual(Object.keys(batchProbe?.body ?? {}).sort(), ['p_after_event', 'p_after_member', 'p_limit', 'p_run_id'])
  assert.equal(batchProbe?.body.p_run_id, '00000000-0000-0000-0000-000000000000')
  const modelDetailProbe = calls.find(call => call.name === 'tokend_get_model_detail_v2' && call.auth.endsWith('anon-key'))
  assert.deepEqual(Object.keys(modelDetailProbe?.body ?? {}).sort(), ['p_model', 'p_token'])
  const channelDetailProbe = calls.find(call => call.name === 'tokend_get_channel_detail_v3' && call.auth.endsWith('anon-key'))
  assert.deepEqual(Object.keys(channelDetailProbe?.body ?? {}).sort(), ['p_channel', 'p_token'])
  const sessionDetailProbe = calls.find(call => call.name === 'tokend_get_session_detail_v2' && call.auth.endsWith('anon-key'))
  assert.deepEqual(Object.keys(sessionDetailProbe?.body ?? {}).sort(), ['p_session_id', 'p_token'])

  const pre004Fetch: typeof fetch = async (input, init = {}) => {
    const name = String(input).split('/').at(-1) ?? ''
    const auth = String((init.headers as Record<string, string>)?.Authorization ?? '')
    const role = auth.endsWith('anon-key') ? 'anon' : 'service'
    if (clientNames.has(name)) return role === 'anon' ? jsonResponse({ ok: false, error: 'invalid_token' }) : jsonResponse({ code: '42501' }, 403)
    if (name === PREFLIGHT_RPC_NAME) return role === 'service' ? jsonResponse({ eventCount: 0 }) : jsonResponse({ code: '42501' }, 403)
    if (ADMIN_RPC_NAMES.includes(name)) return jsonResponse({ code: 'PGRST202' }, 404)
    return jsonResponse({ code: 'PGRST202' }, 404)
  }
  const pre004 = await probeLiveRpcAccess({
    fetch: pre004Fetch,
    url: 'https://project.supabase.co',
    anonKey: 'anon-key',
    serviceKey: 'service-key',
    expectAdmin: false,
  })
  assert.deepEqual(pre004.serviceAllowed, [PREFLIGHT_RPC_NAME])
  assert.deepEqual(pre004.adminAbsent, ADMIN_RPC_NAMES)
})

test('backfill persists monotonic cursor before intentional exit 75, resumes, and never retries 55000', async () => {
  const saved: any[] = []
  let cleanupCalls = 0
  let calls = 0
  const requestedPairs: string[][] = []
  let committedTimeout = true
  const callBatch = async ({ afterMember, afterEvent }: { afterMember: string; afterEvent: string }) => {
    calls += 1
    requestedPairs.push([afterMember, afterEvent])
    if (committedTimeout) {
      committedTimeout = false
      throw Object.assign(new Error('commit response timed out'), { code: 'ETIMEDOUT' })
    }
    return afterMember === '' && afterEvent === ''
      ? { nextMember: 'member-a', nextEvent: 'event-10', remainingCount: 10, processed: 10 }
      : { nextMember: 'member-b', nextEvent: 'event-20', remainingCount: 0, processed: 10 }
  }
  await assert.rejects(runBackfillBatches({
    state: { wrapperGatePassed: true, backfill: { cursorMember: '', cursorEvent: '', remaining: 20, batches: 0 } },
    limit: 5000,
    interruptAfterBatches: 1,
    callBatch,
    saveState: async state => { saved.push(structuredClone(state)) },
    sleep: async () => {},
    cleanup: async () => { cleanupCalls += 1 },
  }), (error: unknown) => error instanceof ExitCodeError && error.exitCode === 75)
  assert.deepEqual(
    [saved.at(-1).backfill.cursorMember, saved.at(-1).backfill.cursorEvent],
    ['member-a', 'event-10'],
  )
  assert.equal(cleanupCalls, 0)
  assert.deepEqual(requestedPairs.slice(0, 2), [['', ''], ['', '']])

  const resumed = await runBackfillBatches({
    state: saved.at(-1), limit: 5000, callBatch,
    saveState: async state => { saved.push(structuredClone(state)) }, sleep: async () => {},
  })
  assert.deepEqual([resumed.backfill.cursorMember, resumed.backfill.cursorEvent], ['member-b', 'event-20'])
  assert.equal(resumed.backfill.remaining, 0)
  assert.equal(calls, 3)

  await assert.rejects(runBackfillBatches({
    state: { wrapperGatePassed: true, backfill: { cursorMember: 'member-b', cursorEvent: 'event-20', remaining: 5, batches: 2 } },
    limit: 5000,
    callBatch: async () => ({ nextMember: 'member-a', nextEvent: 'event-99', remainingCount: 6, processed: 1 }),
    saveState: async () => {}, sleep: async () => {},
  }), /nonmonotonic/i)

  const binaryOrdered = await runBackfillBatches({
    state: { wrapperGatePassed: true, backfill: { cursorMember: 'z', cursorEvent: '', remaining: 1, batches: 0 } },
    limit: 1,
    callBatch: async () => ({ nextMember: 'ä', nextEvent: '', remainingCount: 0, processed: 1 }),
    saveState: async () => {}, sleep: async () => {},
  })
  assert.equal(binaryOrdered.backfill.cursorMember, 'ä')

  for (const processed of [-1, 1.5, 2, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(runBackfillBatches({
      state: { wrapperGatePassed: true, backfill: { cursorMember: '', cursorEvent: '', remaining: 1, batches: 0 } },
      limit: 1,
      callBatch: async () => ({ nextMember: 'member', nextEvent: 'event', remainingCount: 0, processed }),
      saveState: async () => {}, sleep: async () => {},
    }), /processed.*safe|processed.*limit/i)
  }
})

test('activation rehearsal is activate, paired rollback, same-run activate with exact pointers and totals', async () => {
  const calls: string[] = []
  const runId = 'run-1'
  const beforeEnvelope = { ...costEnvelope(12), estimatedEventCount: 0, zeroRateEventCount: 0, unpricedEventCount: 1, reportedEventCount: 0, coverageStatus: 'unpriced', costAvailability: 0, verifiedCostCoverage: 0 }
  const activeEnvelope = { ...costEnvelope(15), estimatedEventCount: 1, zeroRateEventCount: 1, unpricedEventCount: 0, reportedEventCount: 0, coverageStatus: 'complete' }
  const snapshots = [
    { pointers: { activeCatalog: 'old', previousCatalog: null, activeRun: 'old-run', previousRun: null }, envelope: beforeEnvelope },
    { pointers: { activeCatalog: 'new', previousCatalog: 'old', activeRun: runId, previousRun: 'old-run' }, envelope: activeEnvelope },
    { pointers: { activeCatalog: 'old', previousCatalog: 'new', activeRun: 'old-run', previousRun: runId }, envelope: beforeEnvelope },
    { pointers: { activeCatalog: 'new', previousCatalog: 'old', activeRun: runId, previousRun: 'old-run' }, envelope: activeEnvelope },
  ]
  const result = await runActivationRehearsal({
    runId,
    callAdmin: async (name, body) => {
      calls.push(`${name}:${body.runId}`)
      if (name === 'tokend_pricing_rollback') return { runId, status: 'rolled_back', oldTotal: 12, newTotal: 15 }
      return { runId, status: 'active' }
    },
    inspectState: async () => snapshots.shift(),
  })
  assert.deepEqual(calls, [
    `tokend_pricing_activate:${runId}`,
    `tokend_pricing_rollback:${runId}`,
    `tokend_pricing_activate:${runId}`,
  ])
  assert.equal(result.pointers.activeRun, runId)
  assert.deepEqual(result.totals, { oldTotal: 12, newTotal: 15 })
  assert.equal(snapshots.length, 0)
})

test('activation runner inspects four live fixture summary envelopes instead of replaying saved totals', async () => {
  const dir = await tempDir()
  const statePath = path.join(dir, 'state.json')
  const outPath = path.join(dir, 'activation.json')
  const runId = '00000000-0000-0000-0000-000000000321'
  await atomicWriteJson(statePath, {
    wrapperGatePassed: true,
    backfill: { runId },
    fixture: { memberCode: 'ROLL_activation', memberToken: 'fixture-token' },
    reconciliation: { beforeTotalCost: 999, afterTotalCost: 999 },
  }, { fs: nodeFs, randomUUID })
  const before = { ok: true, ...costEnvelope(12), estimatedEventCount: 0, zeroRateEventCount: 0, unpricedEventCount: 1, reportedEventCount: 0, coverageStatus: 'unpriced', costAvailability: 0, verifiedCostCoverage: 0 }
  const active = { ok: true, ...costEnvelope(15), estimatedEventCount: 1, zeroRateEventCount: 1, unpricedEventCount: 0, reportedEventCount: 0, coverageStatus: 'complete' }
  const summaries = [before, active, before, active]
  const pointers = [
    { activeCatalogVersion: 'old', previousCatalogVersion: null, activeRunId: 'old-run', previousRunId: null },
    { activeCatalogVersion: 'new', previousCatalogVersion: 'old', activeRunId: runId, previousRunId: 'old-run' },
    { activeCatalogVersion: 'old', previousCatalogVersion: 'new', activeRunId: 'old-run', previousRunId: runId },
    { activeCatalogVersion: 'new', previousCatalogVersion: 'old', activeRunId: runId, previousRunId: 'old-run' },
  ]
  let summaryCalls = 0
  const fakeFetch: typeof fetch = async (input) => {
    const url = String(input)
    if (url.endsWith('/rpc/tokend_get_summary_v5')) {
      summaryCalls += 1
      return jsonResponse(summaries.shift())
    }
    if (url.endsWith(`/rpc/${PREFLIGHT_RPC_NAME}`)) return jsonResponse(pointers.shift())
    if (url.endsWith('/rpc/tokend_pricing_activate')) return jsonResponse({ runId, status: 'active' })
    if (url.endsWith('/rpc/tokend_pricing_rollback')) return jsonResponse({ runId, status: 'rolled_back' })
    return jsonResponse({ code: 'unexpected' }, 500)
  }
  const runner = createRolloutRunner({
    env: { SUPABASE_URL: 'https://project.supabase.co', SUPABASE_SERVICE_KEY: 'svc', SUPABASE_ANON_KEY: 'anon' },
    fetch: fakeFetch, fs: nodeFs, clock: () => new Date('2026-07-10T00:00:00Z'), sleep: async () => {}, randomUUID: () => 'uuid',
  })
  const result = await runner.execute('activation-rehearsal', { state: statePath, out: outPath })
  assert.equal(summaryCalls, 4)
  assert.deepEqual(result.totals, { oldTotal: 12, newTotal: 15 })
})

test('rollback-active binds the same run and verifies the live four-pointer swap', async () => {
  const dir = await tempDir()
  const statePath = path.join(dir, 'state.json')
  const outPath = path.join(dir, 'rollback.json')
  const runId = '00000000-0000-0000-0000-000000000401'
  await atomicWriteJson(statePath, {
    wrapperGatePassed: true,
    backfill: { runId },
    pointers: { activeCatalog: 'new', previousCatalog: 'old', activeRun: runId, previousRun: 'old-run' },
  }, { fs: nodeFs, randomUUID })
  const fakeFetch: typeof fetch = async (input) => {
    const url = String(input)
    if (url.endsWith('/rpc/tokend_pricing_rollback')) return jsonResponse({ runId, status: 'rolled_back', activeCatalogVersion: 'old', activeRunId: 'old-run' })
    if (url.endsWith(`/rpc/${PREFLIGHT_RPC_NAME}`)) return jsonResponse({
      activeCatalogVersion: 'old', previousCatalogVersion: 'new', activeRunId: 'old-run', previousRunId: runId,
    })
    return jsonResponse({ code: 'unexpected' }, 500)
  }
  const runner = createRolloutRunner({
    env: { SUPABASE_URL: 'https://project.supabase.co', SUPABASE_SERVICE_KEY: 'svc', SUPABASE_ANON_KEY: 'anon' },
    fetch: fakeFetch, fs: nodeFs, clock: () => new Date('2026-07-10T00:00:00Z'), sleep: async () => {}, randomUUID: () => 'uuid',
  })
  const result = await runner.execute('rollback-active', { state: statePath, out: outPath })
  assert.deepEqual(result.pointers, { activeCatalog: 'old', previousCatalog: 'new', activeRun: 'old-run', previousRun: runId })
  await atomicWriteJson(statePath, {
    wrapperGatePassed: true, backfill: { runId },
    pointers: { activeCatalog: 'new', previousCatalog: 'old', activeRun: runId, previousRun: 'old-run' },
  }, { fs: nodeFs, randomUUID })
  const badRunner = createRolloutRunner({
    env: { SUPABASE_URL: 'https://project.supabase.co', SUPABASE_SERVICE_KEY: 'svc', SUPABASE_ANON_KEY: 'anon' },
    fetch: async input => String(input).endsWith('/rpc/tokend_pricing_rollback')
      ? jsonResponse({ runId: 'wrong-run', status: 'rolled_back' })
      : jsonResponse({ activeCatalogVersion: 'old', previousCatalogVersion: 'new', activeRunId: 'old-run', previousRunId: runId }),
    fs: nodeFs, clock: () => new Date(), sleep: async () => {}, randomUUID: () => 'uuid',
  })
  await assert.rejects(badRunner.execute('rollback-active', { state: statePath, out: outPath }), /same run/i)
})

test('reconciliation requires all zero counters, exact catalog hash, and stable four pointers', () => {
  const report = {
    targetCount: 4, revisionCount: 4,
    missingRevisionCount: 0, duplicateRevisionCount: 0, breakdownInvalidCount: 0,
    postSnapshotEventCount: 5, unexplainedMemberCount: 0,
    reconciliationHash: 'authoritative-reconciliation-hash',
    catalogHash: 'catalog-hash',
    pointers: { activeCatalog: 'new', previousCatalog: 'old', activeRun: 'run', previousRun: 'old-run' },
  }
  assert.equal(validateReconciliation(report, {
    catalogHash: 'catalog-hash', pointers: report.pointers,
  }).passed, true)
  assert.throws(() => validateReconciliation({ ...report, missingRevisionCount: 1 }, { catalogHash: 'catalog-hash', pointers: report.pointers }), /missingRevisionCount/i)
  assert.throws(() => validateReconciliation({ ...report, revisionCount: 3 }, { catalogHash: 'catalog-hash', pointers: report.pointers }), /targetCount.*revisionCount/i)
  assert.throws(() => validateReconciliation({ ...report, catalogHash: 'other' }, { catalogHash: 'catalog-hash', pointers: report.pointers }), /catalog hash/i)
})

test('backfill creation freezes authoritative snapshot metadata and reconcile proves the same hash twice', async () => {
  const dir = await tempDir()
  const statePath = path.join(dir, 'state.json')
  const outPath = path.join(dir, 'reconcile.json')
  await atomicWriteJson(statePath, { wrapperGatePassed: true }, { fs: nodeFs, randomUUID })
  const runId = '00000000-0000-0000-0000-000000000123'
  let reconcileCalls = 0
  let catalogQueries = 0
  const runRow = {
    run_id: runId,
    catalog_version: '2026-07-10',
    status: 'reconciled',
    snapshot_at: '2026-07-10T00:00:00Z',
    target_count: '4',
    target_hash: 'target-hash',
    base_catalog_version: 'old-catalog',
    base_backfill_run_id: '00000000-0000-0000-0000-000000000122',
    input_tokens: '10',
    output_tokens: '20',
    reasoning_tokens: '30',
    cache_read_tokens: '40',
    cache_write_tokens: '50',
    before_total_cost: 12,
  }
  const reconciliation = {
    targetCount: 4, revisionCount: 4,
    missingRevisionCount: 0, duplicateRevisionCount: 0, breakdownInvalidCount: 0,
    postSnapshotEventCount: 2, unexplainedMemberCount: 0,
    beforeTotalCost: 12, afterTotalCost: 15,
    reconciliationHash: 'stable-reconciliation-hash',
  }
  const fakeFetch: typeof fetch = async (input) => {
    const url = String(input)
    if (url.endsWith('/rpc/tokend_pricing_create_backfill')) return jsonResponse({
      runId,
      status: 'staging',
      catalogVersion: '2026-07-10',
      snapshotAt: runRow.snapshot_at,
      targetCount: '4',
      targetHash: runRow.target_hash,
      baseCatalogVersion: runRow.base_catalog_version,
      baseRunId: runRow.base_backfill_run_id,
    })
    if (url.includes('/tokend_pricing_catalogs?')) { catalogQueries += 1; return jsonResponse([{ hash: 'catalog-hash' }]) }
    if (url.includes('/tokend_pricing_backfill_runs?')) {
      assert.match(url, /reconciliation_hash/)
      return jsonResponse([{
        ...runRow,
        status: reconcileCalls > 0 ? 'reconciled' : 'staging',
        reconciliation_hash: reconcileCalls > 0 ? 'stable-reconciliation-hash' : null,
      }])
    }
    if (url.endsWith('/rpc/tokend_pricing_reconcile')) {
      reconcileCalls += 1
      return jsonResponse(reconciliation)
    }
    if (url.endsWith('/rpc/tokend_pricing_get_backfill')) return jsonResponse({
      runId, status: 'reconciled', catalogVersion: '2026-07-10', snapshotAt: runRow.snapshot_at,
      targetCount: '4', revisionCount: '4', remainingCount: '0',
    })
    if (url.endsWith(`/rpc/${PREFLIGHT_RPC_NAME}`)) return jsonResponse({
      activeCatalogVersion: runRow.base_catalog_version,
      activeRunId: runRow.base_backfill_run_id,
      previousCatalogVersion: null,
      previousRunId: null,
    })
    return jsonResponse({ code: 'unexpected' }, 500)
  }
  const runner = createRolloutRunner({
    env: { SUPABASE_URL: 'https://project.supabase.co', SUPABASE_SERVICE_KEY: 'svc', SUPABASE_ANON_KEY: 'anon' },
    fetch: fakeFetch, fs: nodeFs, clock: () => new Date('2026-07-10T00:00:00Z'), sleep: async () => {}, randomUUID: () => 'uuid',
  })
  const createdOutput = await runner.execute('backfill-create', { catalog: '2026-07-10', state: statePath })
  assert.deepEqual(createdOutput, {
    status: 'staging', targetHash: 'target-hash', targetCount: '4',
    inputTokens: '10', outputTokens: '20', reasoningTokens: '30',
    cacheReadTokens: '40', cacheWriteTokens: '50',
  })
  const createdState = JSON.parse(await readFile(statePath, 'utf8'))
  assert.deepEqual(createdState.backfillSnapshot, {
    snapshotAt: runRow.snapshot_at,
    targetCount: '4',
    targetHash: runRow.target_hash,
    baseCatalogVersion: runRow.base_catalog_version,
    baseRunId: runRow.base_backfill_run_id,
    inputTokens: '10',
    outputTokens: '20',
    reasoningTokens: '30',
    cacheReadTokens: '40',
    cacheWriteTokens: '50',
    basePointers: {
      activeCatalog: 'old-catalog', activeRun: '00000000-0000-0000-0000-000000000122',
      previousCatalog: null, previousRun: null,
    },
  })
  await runner.execute('reconcile', { state: statePath, out: outPath })
  assert.equal(reconcileCalls, 2)
  assert.equal(catalogQueries, 2)
  const reconciledState = JSON.parse(await readFile(statePath, 'utf8'))
  assert.equal(reconciledState.reconciliationHash, 'stable-reconciliation-hash')
  assert.deepEqual(reconciledState.backfillSnapshot, createdState.backfillSnapshot)

  const unsafeRunner = createRolloutRunner({
    env: { SUPABASE_URL: 'https://project.supabase.co', SUPABASE_SERVICE_KEY: 'svc', SUPABASE_ANON_KEY: 'anon' },
    fetch: async input => {
      const url = String(input)
      if (url.endsWith('/rpc/tokend_pricing_create_backfill')) return jsonResponse({
        runId, status: 'staging', catalogVersion: '2026-07-10', snapshotAt: runRow.snapshot_at,
        targetCount: 4, targetHash: 'target-hash', baseCatalogVersion: 'old-catalog', baseRunId: runRow.base_backfill_run_id,
      })
      if (url.includes('/tokend_pricing_catalogs?')) return jsonResponse([{ hash: 'catalog-hash' }])
      if (url.includes('/tokend_pricing_backfill_runs?')) return jsonResponse([{ ...runRow, input_tokens: Number.MAX_SAFE_INTEGER + 1, status: 'staging' }])
      if (url.endsWith(`/rpc/${PREFLIGHT_RPC_NAME}`)) return jsonResponse({
        activeCatalogVersion: 'old-catalog', activeRunId: runRow.base_backfill_run_id,
        previousCatalogVersion: null, previousRunId: null,
      })
      return jsonResponse({ code: 'unexpected' }, 500)
    },
    fs: nodeFs, clock: () => new Date(), sleep: async () => {}, randomUUID: () => 'unsafe',
  })
  const unsafeStatePath = path.join(dir, 'unsafe.json')
  await atomicWriteJson(unsafeStatePath, { wrapperGatePassed: true }, { fs: nodeFs, randomUUID })
  await assert.rejects(
    unsafeRunner.execute('backfill-create', { catalog: '2026-07-10', state: unsafeStatePath }),
    /inputTokens.*safe integer|inputTokens.*decimal/i,
  )
})

test('monitor checks both RPC generations, adjusted global health, late cadence, and pointer/hash drift', async () => {
  const uploads: number[] = []
  let elapsed = 0
  const snapshot = {
    legacyHealthy: true,
    vNextHealthy: true,
    legacyRpc: { count: 1, httpErrorCount: 0, jsonErrorCount: 0, p95Seconds: 0.05 },
    vNextRpc: { count: 1, httpErrorCount: 0, jsonErrorCount: 0, p95Seconds: 0.05 },
    global: {
      eventCount: 105, knownFixtureCount: 5, status: 'complete', unpricedShare: 0.01, membersOver2x: 0,
      postSnapshotEventCount: 5, knownLateCount: 5,
    },
    fixtureHealth: { known: true, zero: true, unpriced: true, reported: true, legacy: true },
    reconciliationHash: 'recon-hash',
    pointers: { activeCatalog: 'new', previousCatalog: 'old', activeRun: 'run', previousRun: 'old-run' },
  }
  const result = await runMonitorLoop({
    durationSeconds: 240,
    intervalSeconds: 30,
    lateUploadEverySeconds: 120,
    baselineGlobal: { eventCount: 100, status: 'complete', maxUnpricedShare: 0.02, membersOver2x: 0, postSnapshotEventCount: 0 },
    baselineRpc: { count: 100, httpErrorCount: 0, jsonErrorCount: 0, p95Seconds: 0.05, reconciliationHash: 'recon-hash', pointers: snapshot.pointers },
    collectSnapshot: async () => structuredClone(snapshot),
    uploadLateFixture: async () => { uploads.push(elapsed) },
    sleep: async ms => { elapsed += ms / 1000 },
  })
  assert.deepEqual(uploads, [120, 240])
  assert.equal(result.samples.length, 9)
  assert.equal(result.fixtureHealth.known, true)

  const improved = await runMonitorLoop({
    durationSeconds: 0, intervalSeconds: 30, lateUploadEverySeconds: 120,
    baselineGlobal: { eventCount: 100, status: 'legacy', maxUnpricedShare: 0.02, membersOver2x: 0, postSnapshotEventCount: 0 },
    baselineRpc: { count: 100, httpErrorCount: 0, jsonErrorCount: 0, p95Seconds: 0.05, reconciliationHash: 'recon-hash', pointers: snapshot.pointers },
    collectSnapshot: async () => ({ ...snapshot, global: { ...snapshot.global, status: 'complete' } }),
    uploadLateFixture: async () => {}, sleep: async () => {},
  })
  assert.equal(improved.passed, true)

  await assert.rejects(runMonitorLoop({
    durationSeconds: 30, intervalSeconds: 30, lateUploadEverySeconds: 120,
    baselineGlobal: { eventCount: 100, status: 'complete', maxUnpricedShare: 0.02, membersOver2x: 0, postSnapshotEventCount: 0 },
    baselineRpc: { count: 100, httpErrorCount: 0, jsonErrorCount: 0, p95Seconds: 0.05, reconciliationHash: 'recon-hash', pointers: snapshot.pointers },
    collectSnapshot: async () => ({ ...snapshot, reconciliationHash: 'drifted' }),
    uploadLateFixture: async () => {}, sleep: async () => {},
  }), /reconciliation hash drift/i)

  let sampleIndex = 0
  await assert.rejects(runMonitorLoop({
    durationSeconds: 30, intervalSeconds: 30, lateUploadEverySeconds: 120,
    baselineGlobal: { eventCount: 100, status: 'complete', maxUnpricedShare: 0.02, membersOver2x: 0, postSnapshotEventCount: 0 },
    baselineRpc: { count: 100, httpErrorCount: 0, jsonErrorCount: 0, p95Seconds: 0.05, reconciliationHash: 'recon-hash', pointers: snapshot.pointers },
    collectSnapshot: async () => ({
      ...snapshot,
      global: { ...snapshot.global, postSnapshotEventCount: sampleIndex++ === 0 ? 5 : 4 },
    }),
    uploadLateFixture: async () => {}, sleep: async () => {},
  }), /postSnapshotEventCount.*regressed|post-snapshot.*regressed/i)
})

test('monitor keeps every late fixture batch, verifies its active catalog, and trusts state pointers/hash', async () => {
  const dir = await tempDir()
  const statePath = path.join(dir, 'state.json')
  const globalPath = path.join(dir, 'global.json')
  const rpcPath = path.join(dir, 'rpc.json')
  const outPath = path.join(dir, 'monitor.json')
  const existingEvents = ['known', 'zero', 'unpriced', 'reported', 'legacy'].map(kind => ({
    id: `late-${kind}-existing`, expectedStatus: kind === 'known' ? 'estimated' : kind === 'zero' ? 'zero_rate' : kind,
  }))
  await atomicWriteJson(statePath, {
    wrapperGatePassed: true,
    fixture: { memberCode: 'ROLL_monitor', memberToken: 'fixture-token' },
    catalogVersion: 'active-catalog',
    pointers: { activeCatalog: 'active-catalog', previousCatalog: 'old-catalog', activeRun: 'active-run', previousRun: null },
    reconciliationHash: 'state-reconciliation-hash',
    fixtureStatusCounts: { estimated: 1, zero_rate: 1, unpriced: 1, reported: 1, legacy: 1 },
    lateFixtureBatches: [{ catalogVersion: 'active-catalog', events: existingEvents }],
  }, { fs: nodeFs, randomUUID })
  await writeFile(globalPath, JSON.stringify({ eventCount: 100, status: 'complete', maxUnpricedShare: 0.02, membersOver2x: 0, postSnapshotEventCount: 0, reconciliationHash: 'wrong-file-hash', pointers: { wrong: true } }))
  await writeFile(rpcPath, JSON.stringify({ count: 100, httpErrorCount: 0, jsonErrorCount: 0, p95Seconds: 0.05, reconciliationHash: 'wrong-rpc-hash', pointers: { wrong: true } }))
  const revisionQueries: string[] = []
  const uploadedEventIds: string[] = []
  let preflightCalls = 0
  let uuid = 0
  const fakeFetch: typeof fetch = async (input, init = {}) => {
    const url = String(input)
    if (url.endsWith('/rpc/tokend_upload_events_v2')) {
      uploadedEventIds.push(JSON.parse(String(init.body ?? '{}')).p_events[0].id)
      return jsonResponse({ ok: true, inserted: 3 })
    }
    if (url.endsWith('/rpc/tokend_upload_events')) return jsonResponse({ ok: true, inserted: 2 })
    if (url.endsWith('/rpc/tokend_get_summary_v4') || url.endsWith('/rpc/tokend_get_summary_v5')) return jsonResponse({ ok: true })
    if (url.endsWith(`/rpc/${PREFLIGHT_RPC_NAME}`)) {
      const fixtureCount = 5 + (preflightCalls * 5)
      preflightCalls += 1
      return jsonResponse({
        eventCount: 100 + fixtureCount,
        postSnapshotEventCount: fixtureCount,
        statusCounts: { reported: 100 + (fixtureCount / 5), estimated: fixtureCount / 5, zero_rate: fixtureCount / 5, unpriced: fixtureCount / 5, legacy: fixtureCount / 5 },
        membersOver2xCount: 1,
        activeReconciliationHash: 'state-reconciliation-hash',
        activeCatalogVersion: 'active-catalog', activeRunId: 'active-run',
        previousCatalogVersion: 'old-catalog', previousRunId: null,
      })
    }
    if (url.includes('/tokend_usage_events?select=id,total_cost&')) return jsonResponse([
      { id: 'fixture-over-2x', total_cost: 1 },
    ])
    if (url.includes('/tokend_event_cost_revisions?select=event_id,version,total_cost&')) return jsonResponse([
      { event_id: 'fixture-over-2x', version: 'old-catalog', total_cost: 1 },
      { event_id: 'fixture-over-2x', version: 'active-catalog', total_cost: 3 },
    ])
    const encodedIds = /(?:id|event_id)=in\.\(([^)]+)\)/.exec(url)?.[1] ?? ''
    const ids = encodedIds.split(',').filter(Boolean).map(decodeURIComponent)
    if (url.includes('/tokend_usage_events?')) return jsonResponse(ids.map(id => ({
      id,
      pricing_status: id.includes('reported') ? 'reported' : id.includes('legacy') ? 'legacy' : 'unpriced',
      total_cost: id.includes('reported') || id.includes('legacy') ? 0.01 : 0,
    })))
    if (url.includes('/tokend_event_cost_revisions?')) {
      revisionQueries.push(url)
      return jsonResponse(ids.filter(id => id.includes('known') || id.includes('zero') || id.includes('unpriced')).map(id => ({
        event_id: id,
        pricing_status: id.includes('known') ? 'estimated' : id.includes('zero') ? 'zero_rate' : 'unpriced',
      })))
    }
    return jsonResponse({ code: 'unexpected' }, 500)
  }
  const runner = createRolloutRunner({
    env: { SUPABASE_URL: 'https://project.supabase.co', SUPABASE_SERVICE_KEY: 'svc', SUPABASE_ANON_KEY: 'anon' },
    fetch: fakeFetch, fs: nodeFs, clock: () => new Date('2026-07-10T00:00:00Z'), sleep: async () => {}, randomUUID: () => `monitor-${++uuid}`,
  })
  const result = await runner.execute('monitor', {
    state: statePath, duration: 240, interval: 120, lateUploadEvery: 120,
    globalBaseline: globalPath, rpcBaseline: rpcPath, out: outPath,
  })
  assert.equal(result.passed, true)
  assert.equal(revisionQueries.length, 6)
  assert.ok(revisionQueries.every(url => url.includes('version=eq.active-catalog')))
  assert.equal(uploadedEventIds.length, 2)
  assert.ok(uploadedEventIds.every(id => revisionQueries.some(url => url.includes(id))))
  assert.equal(JSON.parse(await readFile(statePath, 'utf8')).lateFixtureBatches.length, 3)
  assert.doesNotMatch(await readFile(outPath, 'utf8'), /late-|monitor-\d|ROLL_monitor|fixture-token/)

  const unhealthyRunner = createRolloutRunner({
    env: { SUPABASE_URL: 'https://project.supabase.co', SUPABASE_SERVICE_KEY: 'svc', SUPABASE_ANON_KEY: 'anon' },
    fetch: async (input, init) => String(input).endsWith('/rpc/tokend_get_summary_v5')
      ? jsonResponse({ ok: false })
      : fakeFetch(input, init),
    fs: nodeFs, clock: () => new Date('2026-07-10T00:00:00Z'), sleep: async () => {}, randomUUID: () => 'unhealthy',
  })
  await assert.rejects(unhealthyRunner.execute('monitor', {
    state: statePath, duration: 0, interval: 120, lateUploadEvery: 120,
    globalBaseline: globalPath, rpcBaseline: rpcPath, out: path.join(dir, 'unhealthy.json'),
  }), /JSON error rate delta exceeded/i)
})

test('runner wrapper gate writes only hashes roles hardening booleans and timestamp with a preserved private state', async () => {
  const dir = await tempDir()
  const live = path.join(dir, 'live.sql')
  const reviewed = path.join(dir, 'reviewed.sql')
  const statePath = path.join(dir, 'state.json')
  const outPath = path.join(dir, 'gate.json')
  await writeFile(live, pgDumpDefaultAclWrapper)
  await writeFile(reviewed, hardenedReviewedDefaultAclWrapper.replace(/\n/g, '\r\n'))
  const runner = createRolloutRunner({
    env: {}, fetch: async () => { throw new Error('network must not be used') }, fs: nodeFs,
    clock: () => new Date('2026-07-10T00:00:00.000Z'), sleep: async () => {}, randomUUID: () => 'uuid',
  })
  const output = await runner.execute('wrapper-gate', {
    liveSchema: live, rollbackSql: reviewed, state: statePath, out: outPath,
  })
  assert.deepEqual(Object.keys(output).sort(), [
    'aclHash', 'roleNames', 'securityHardeningApplied', 'timestamp', 'wrapperGatePassed', 'wrapperHash',
  ].sort())
  assert.equal(output.wrapperGatePassed, true)
  assert.equal(output.securityHardeningApplied, true)
  assert.deepEqual(output.roleNames, ['anon', 'authenticated'])
  assert.equal((await stat(statePath)).mode & 0o777, 0o600)
  assert.equal((await stat(outPath)).mode & 0o777, 0o600)
  const privateState = JSON.parse(await readFile(statePath, 'utf8'))
  assert.equal(privateState.wrapperGatePassed, true)
  assert.equal(privateState.wrapperHash, output.wrapperHash)
  assert.deepEqual(JSON.parse(await readFile(outPath, 'utf8')), output)
  assert.doesNotMatch(await readFile(outPath, 'utf8'), /CREATE|PERFORM|service-secret/i)
})

test('fixture creation preserves gates and smoke uses exact upload bodies plus authoritative row queries', async () => {
  const dir = await tempDir()
  const statePath = path.join(dir, 'state.json')
  await atomicWriteJson(statePath, {
    wrapperGatePassed: true,
    transition: 'migrations-consistent',
    plannedMigrationHashes: { a: 'b' },
  }, { fs: nodeFs, randomUUID })
  const calls: Array<{ url: string; method: string; auth: string; body: string }> = []
  const fakeFetch: typeof fetch = async (input, init = {}) => {
    const url = String(input)
    const headers = init.headers as Record<string, string>
    calls.push({ url, method: init.method ?? 'GET', auth: headers?.Authorization ?? '', body: String(init.body ?? '') })
    if (url.includes('/tokend_members')) return jsonResponse([{ member_code: 'ROLL_fixture' }], 201)
    if (url.includes('/tokend_usage_events?') && url.includes('late-')) return jsonResponse([
      { id: 'late-known-fixture-uuid', pricing_status: 'unpriced', total_cost: 0 },
      { id: 'late-zero-fixture-uuid', pricing_status: 'unpriced', total_cost: 0 },
      { id: 'late-unpriced-fixture-uuid', pricing_status: 'unpriced', total_cost: 0 },
      { id: 'late-reported-fixture-uuid', pricing_status: 'reported', total_cost: 0.01 },
      { id: 'late-legacy-fixture-uuid', pricing_status: 'legacy', total_cost: 0.01 },
    ])
    if (url.includes('/tokend_event_cost_revisions?') && url.includes('late-')) return jsonResponse([
      { event_id: 'late-known-fixture-uuid', pricing_status: 'estimated' },
      { event_id: 'late-zero-fixture-uuid', pricing_status: 'zero_rate' },
      { event_id: 'late-unpriced-fixture-uuid', pricing_status: 'unpriced' },
    ])
    if (url.includes('/tokend_usage_events?') && url.includes('client-cost-')) return jsonResponse([
      { id: 'legacy-fixture-uuid', pricing_status: 'legacy', total_cost: 0.02 },
      { id: 'estimated-fixture-uuid', pricing_status: 'unpriced', ...zeroStoredCosts },
      { id: 'client-cost-fixture-uuid', pricing_status: 'unpriced', ...zeroStoredCosts },
    ])
    if (url.includes('/tokend_event_cost_revisions?') && url.includes('client-cost-')) return jsonResponse([
      { event_id: 'estimated-fixture-uuid', pricing_status: 'estimated', total_cost: 0.001 },
      { event_id: 'client-cost-fixture-uuid', pricing_status: 'estimated', total_cost: 0.001 },
    ])
    if (url.includes('/rpc/tokend_upload_events')) return jsonResponse({ ok: true, inserted: JSON.parse(String(init.body ?? '{}')).p_events?.length ?? 0 })
    return jsonResponse({})
  }
  const runner = createRolloutRunner({
    env: {
      SUPABASE_URL: 'https://project.supabase.co',
      SUPABASE_SERVICE_KEY: 'service-secret',
      SUPABASE_ANON_KEY: 'anon-secret',
    },
    fetch: fakeFetch, fs: nodeFs, clock: () => new Date('2026-07-10T00:00:00Z'),
    sleep: async () => {}, randomUUID: () => 'fixture-uuid',
  })
  await runner.execute('fixture-create', { state: statePath })
  const state = JSON.parse(await readFile(statePath, 'utf8'))
  assert.equal(state.wrapperGatePassed, true)
  assert.deepEqual(state.plannedMigrationHashes, { a: 'b' })
  assert.match(state.fixture.memberCode, /^ROLL_/)
  assert.ok(state.fixture.memberToken)
  assert.equal((await stat(statePath)).mode & 0o777, 0o600)
  const memberCreate = calls.find(call =>
    call.method === 'POST' && call.url.endsWith('/rest/v1/tokend_members'))
  assert.ok(memberCreate, 'fixture creation must insert one isolated member')
  const [createdMember] = JSON.parse(memberCreate.body)
  assert.deepEqual(Object.keys(createdMember).sort(), ['member_code', 'phone', 'token'])
  assert.equal(createdMember.member_code, state.fixture.memberCode)
  assert.equal(createdMember.token, state.fixture.memberToken)
  assert.equal(createdMember.phone, 'tokend-rollout-fixtureuuid')
  assert.doesNotMatch(createdMember.phone, /^\+?[0-9][0-9 ()-]+$/)
  assert.equal(Object.hasOwn(state.fixture, 'phone'), false)
  assert.doesNotMatch(JSON.stringify(sanitizeForOutput(state)), /tokend-rollout-fixtureuuid/)

  await runner.execute('upload-smoke', { state: statePath })
  const uploadCalls = calls.filter(call => call.url.includes('/rpc/tokend_upload_events'))
  assert.equal(uploadCalls.length, 3)
  assert.ok(uploadCalls.every(call => call.auth === 'Bearer anon-secret'))
  assert.ok(uploadCalls.some(call => call.body.includes('999')))
  assert.ok(uploadCalls.some(call => call.url.endsWith('/tokend_upload_events')))
  assert.ok(uploadCalls.some(call => call.url.endsWith('/tokend_upload_events_v2')))
  const expectedTimestamp = new Date('2026-07-10T00:00:00Z').getTime()
  for (const call of uploadCalls) {
    const payload = JSON.parse(call.body)
    assert.deepEqual(Object.keys(payload).sort(), ['p_events', 'p_sync_states', 'p_token'])
    assert.ok(payload.p_events.every((event: any) => event.timestampMs === expectedTimestamp))
    assert.ok(payload.p_events.every((event: any) => !Object.hasOwn(event, 'timestamp')))
  }
  assert.ok(calls.some(call => call.url.includes('/tokend_usage_events?') && call.url.includes('client-cost-')))
  assert.ok(calls.some(call => call.url.includes('/tokend_event_cost_revisions?') && call.url.includes('client-cost-')))

  await atomicWriteJson(statePath, { ...JSON.parse(await readFile(statePath, 'utf8')), catalogVersion: 'catalog-v1' }, { fs: nodeFs, randomUUID })
  const beforeLate = calls.length
  await runner.execute('late-fixtures', { state: statePath })
  const lateCalls = calls.slice(beforeLate).filter(call => call.url.includes('/rpc/tokend_upload_events'))
  assert.equal(lateCalls.length, 2)
  assert.ok(lateCalls.some(call => call.url.endsWith('/tokend_upload_events_v2')))
  assert.ok(lateCalls.some(call => call.url.endsWith('/tokend_upload_events')))
  assert.ok(calls.slice(beforeLate).some(call => call.url.includes('/tokend_usage_events?') && call.url.includes('late-')))
  assert.ok(calls.slice(beforeLate).some(call => call.url.includes('/tokend_event_cost_revisions?') && call.url.includes('late-') && call.url.includes('version=eq.catalog-v1')))
  assert.doesNotMatch(JSON.stringify(state), /service-secret|anon-secret/)
})

test('legacy-only smoke calls only the v12 wrapper and verifies one nonzero base row', async () => {
  const dir = await tempDir()
  const statePath = path.join(dir, 'state.json')
  await atomicWriteJson(statePath, {
    wrapperGatePassed: true,
    fixture: { memberCode: 'ROLL_legacy', memberToken: 'legacy-fixture-token' },
  }, { fs: nodeFs, randomUUID })
  const calls: Array<{ url: string; method: string; body: string }> = []
  const fakeFetch: typeof fetch = async (input, init = {}) => {
    const url = String(input)
    calls.push({ url, method: init.method ?? 'GET', body: String(init.body ?? '') })
    if (url.endsWith('/rpc/tokend_upload_events')) return jsonResponse({ ok: true, inserted: 1 })
    if (url.includes('/tokend_usage_events?') && url.includes('legacy-fixture-uuid')) return jsonResponse([
      { id: 'legacy-fixture-uuid', pricing_status: null, total_cost: 0.02 },
    ])
    return jsonResponse({ code: 'unexpected' }, 500)
  }
  const runner = createRolloutRunner({
    env: { SUPABASE_URL: 'https://project.supabase.co', SUPABASE_SERVICE_KEY: 'svc', SUPABASE_ANON_KEY: 'anon' },
    fetch: fakeFetch, fs: nodeFs, clock: () => new Date('2026-07-10T00:00:00Z'),
    sleep: async () => {}, randomUUID: () => 'fixture-uuid',
  })
  await runner.execute('upload-smoke', { state: statePath, legacyOnly: true })
  assert.equal(calls.filter(call => call.url.includes('/rpc/')).length, 1)
  assert.ok(calls[0].url.endsWith('/rpc/tokend_upload_events'))
  assert.ok(calls.some(call => call.url.includes('/tokend_usage_events?') && call.url.includes('legacy-fixture-uuid')))
  assert.ok(calls.every(call => !call.url.includes('tokend_upload_events_v2')))
  assert.ok(calls.every(call => !call.url.includes('tokend_event_cost_revisions')))
})

test('v2 smoke accepts absent staging revisions while base rows remain authoritative unpriced zero', async () => {
  const dir = await tempDir()
  const statePath = path.join(dir, 'state.json')
  await atomicWriteJson(statePath, {
    wrapperGatePassed: true,
    fixture: { memberCode: 'ROLL_smoke', memberToken: 'fixture-token' },
  }, { fs: nodeFs, randomUUID })
  const fakeFetch: typeof fetch = async (input) => {
    const url = String(input)
    if (url.includes('/rpc/tokend_upload_events')) return jsonResponse({ ok: true, inserted: 1 })
    if (url.includes('/tokend_usage_events?')) return jsonResponse([
      { id: 'legacy-fixture-uuid', pricing_status: 'legacy', total_cost: 0.02 },
      { id: 'estimated-fixture-uuid', pricing_status: 'unpriced', ...zeroStoredCosts },
      { id: 'client-cost-fixture-uuid', pricing_status: 'unpriced', ...zeroStoredCosts },
    ])
    if (url.includes('/tokend_event_cost_revisions?')) return jsonResponse([])
    return jsonResponse({ code: 'unexpected' }, 500)
  }
  const runner = createRolloutRunner({
    env: { SUPABASE_URL: 'https://project.supabase.co', SUPABASE_SERVICE_KEY: 'svc', SUPABASE_ANON_KEY: 'anon' },
    fetch: fakeFetch, fs: nodeFs, clock: () => new Date('2026-07-10T00:00:00Z'), sleep: async () => {}, randomUUID: () => 'fixture-uuid',
  })
  const result = await runner.execute('upload-smoke', { state: statePath })
  assert.equal(result.passed, true)
})

test('preflight paginates usage and model prices while stateful sample uses fixture token', async () => {
  const dir = await tempDir()
  const preflightOut = path.join(dir, 'preflight.json')
  const sampleOut = path.join(dir, 'sample.json')
  const sampleState = path.join(dir, 'sample-state.json')
  await atomicWriteJson(sampleState, { wrapperGatePassed: true, fixture: { memberCode: 'ROLL_sample', memberToken: 'fixture-sample-token' } }, { fs: nodeFs, randomUUID })
  const calls: Array<{ url: string; auth: string; range?: string; rangeUnit?: string; body?: string }> = []
  let sampleCall = 0
  const fakeFetch: typeof fetch = async (input, init = {}) => {
    const url = String(input)
    const headers = init.headers as Record<string, string>
    calls.push({ url, auth: headers?.Authorization ?? '', range: headers?.Range, rangeUnit: headers?.['Range-Unit'], body: String(init.body ?? '') })
    if (url.includes('/tokend_usage_events')) {
      const range = headers.Range
      if (range === '0-999') return jsonResponse(Array.from({ length: 1000 }, () => ({ model: 'gpt-5.6-sol', total_tokens: 15, total_cost: 1 })), 200, { 'content-range': '0-999/1002' })
      return jsonResponse([
        { model: 'unknown', total_tokens: 15, total_cost: 0 },
        { model: 'ignored-zero-token', total_tokens: 0, total_cost: 0 },
      ], 200, { 'content-range': '1000-1001/1002' })
    }
    if (url.includes('/tokend_model_prices')) {
      const range = headers.Range
      if (range === '0-999') return jsonResponse(Array.from({ length: 1000 }, (_, id) => ({ model_id: `legacy-${id}` })), 200, { 'content-range': '0-999/1001' })
      return jsonResponse([{ model_id: 'legacy-1000' }], 200, { 'content-range': '1000-1000/1001' })
    }
    if (url.includes(`/rpc/${PREFLIGHT_RPC_NAME}`)) return jsonResponse({ code: 'PGRST202' }, 404)
    if (url.includes('/rpc/tokend_get_summary_v5')) {
      sampleCall += 1
      if (sampleCall === 2) return new Response('not-json', { status: 200 })
      return jsonResponse({ ok: true, secretBody: 'must never persist' })
    }
    return jsonResponse([])
  }
  const runner = createRolloutRunner({
    env: { SUPABASE_URL: 'https://project.supabase.co', SUPABASE_SERVICE_KEY: 'svc', SUPABASE_ANON_KEY: 'anon' },
    fetch: fakeFetch, fs: nodeFs, clock: () => new Date('2026-07-10T00:00:00Z'),
    sleep: async () => {}, randomUUID: () => 'uuid',
  })
  const preflight = await runner.execute('preflight', { out: preflightOut })
  assert.equal(preflight.eventCount, 1002)
  assert.equal(preflight.eligibleEventCount, 1001)
  assert.equal(preflight.eligibleZeroCostEventCount, 1)
  assert.equal(preflight.totalCost, 1000)
  assert.equal(preflight.unpricedEventCount, 1)
  assert.equal(preflight.legacyPriceRowCount, 1001)
  assert.deepEqual(preflight.statusCounts, { legacy: 1000, unpriced: 1 })
  assert.deepEqual(preflight.zeroCostByModel, [{ model: 'unknown', eventCount: 1, totalTokens: 15 }])
  assert.equal(preflight.activeCatalogVersion, 'not_present')
  assert.equal(preflight.activeRunId, 'not_present')
  assert.equal(preflight.previousCatalogVersion, 'not_present')
  assert.equal(preflight.previousRunId, 'not_present')
  assert.equal(Object.hasOwn(preflight, 'pointers'), false)
  assert.ok(calls.filter(call => call.url.includes('/tokend_usage_events')).every(call => call.auth === 'Bearer svc'))
  assert.deepEqual(calls.filter(call => call.url.includes('/tokend_model_prices')).map(call => call.range), ['0-999', '1000-1000'])
  assert.ok(calls.filter(call => call.url.includes('/tokend_usage_events') || call.url.includes('/tokend_model_prices')).every(call => call.rangeUnit === 'items'))

  const sample = await runner.execute('sample', { rpc: 'tokend_get_summary_v5', count: 3, out: sampleOut, state: sampleState })
  assert.deepEqual(Object.keys(sample).sort(), ['count', 'httpErrorCount', 'jsonErrorCount', 'p95Seconds', 'rpc'].sort())
  assert.equal(sample.count, 3)
  assert.equal(sample.jsonErrorCount, 1)
  assert.ok(calls.filter(call => call.url.includes('/rpc/tokend_get_summary_v5')).every(call => call.auth === 'Bearer anon'))
  assert.ok(calls.filter(call => call.url.includes('/rpc/tokend_get_summary_v5')).every(call => call.body?.includes('fixture-sample-token')))
  assert.doesNotMatch(await readFile(sampleOut, 'utf8'), /secretBody|must never persist|svc|anon/)
})

test('cleanup is allowed during sticky recovery and uses exact member-scoped filters without target deletion', async () => {
  const dir = await tempDir()
  const statePath = path.join(dir, 'state.json')
  await atomicWriteJson(statePath, {
    wrapperGatePassed: true,
    forwardRecoveryRequired: true,
    fixture: { memberCode: 'ROLL_exact', memberToken: 'private', runId: 'run-fixture' },
  }, { fs: nodeFs, randomUUID })
  const calls: Array<{ url: string; method: string }> = []
  const fakeFetch: typeof fetch = async (input, init = {}) => {
    calls.push({ url: String(input), method: init.method ?? 'GET' })
    return jsonResponse([])
  }
  const runner = createRolloutRunner({
    env: { SUPABASE_URL: 'https://project.supabase.co', SUPABASE_SERVICE_KEY: 'svc', SUPABASE_ANON_KEY: 'anon' },
    fetch: fakeFetch, fs: nodeFs, clock: () => new Date(), sleep: async () => {}, randomUUID: () => 'uuid',
  })
  await runner.execute('cleanup', { state: statePath })
  const deletes = calls.filter(call => call.method === 'DELETE')
  const tables = deletes.map(call => /\/rest\/v1\/([^?]+)/.exec(call.url)?.[1])
  assert.deepEqual(tables, [
    'tokend_event_cost_revisions', 'tokend_message_events', 'tokend_usage_events',
    'tokend_sessions', 'tokend_sync_state', 'tokend_members',
  ])
  assert.ok(deletes.every(call => call.url.includes('member_code=eq.ROLL_exact')))
  assert.ok(calls.some(call => call.url.includes('/tokend_pricing_backfill_targets?') && call.method === 'GET'))
  assert.ok(calls.every(call => !(call.url.includes('/tokend_pricing_backfill_targets?') && call.method === 'DELETE')))
  const cleaned = JSON.parse(await readFile(statePath, 'utf8'))
  assert.equal(cleaned.fixture, undefined)
  assert.equal(cleaned.forwardRecoveryRequired, true)

  await runner.execute('cleanup', { state: statePath })
  assert.equal(JSON.parse(await readFile(statePath, 'utf8')).forwardRecoveryRequired, true)
})

test('pre-001 fixture reset tolerates only absent additive relations and clears private fixture batches', async () => {
  const dir = await tempDir()
  const statePath = path.join(dir, 'state.json')
  await atomicWriteJson(statePath, {
    wrapperGatePassed: true,
    fixture: { memberCode: 'ROLL_pre001', memberToken: 'private' },
    fixtureStatusCounts: { legacy: 1 },
    lateFixtures: [{ id: 'private-event' }],
    lateFixtureBatches: [{ catalogVersion: 'new', events: [{ id: 'private-event' }] }],
  }, { fs: nodeFs, randomUUID })
  const calls: Array<{ url: string; method: string }> = []
  const fakeFetch: typeof fetch = async (input, init = {}) => {
    const url = String(input)
    calls.push({ url, method: init.method ?? 'GET' })
    if (url.includes('/tokend_pricing_backfill_targets?')) return jsonResponse({ code: 'PGRST205' }, 404)
    if (url.includes('/tokend_event_cost_revisions?')) return jsonResponse({ code: '42P01' }, 404)
    return jsonResponse([])
  }
  const runner = createRolloutRunner({
    env: { SUPABASE_URL: 'https://project.supabase.co', SUPABASE_SERVICE_KEY: 'svc', SUPABASE_ANON_KEY: 'anon' },
    fetch: fakeFetch, fs: nodeFs, clock: () => new Date(), sleep: async () => {}, randomUUID: () => 'uuid',
  })
  await runner.execute('fixture-reset', { state: statePath })
  const reset = JSON.parse(await readFile(statePath, 'utf8'))
  assert.equal(reset.fixture.memberCode, 'ROLL_pre001')
  assert.equal(reset.fixtureStatusCounts, undefined)
  assert.equal(reset.lateFixtures, undefined)
  assert.equal(reset.lateFixtureBatches, undefined)
  assert.ok(calls.some(call => call.url.includes('/tokend_usage_events?') && call.method === 'DELETE'))
  assert.ok(calls.every(call => !call.url.includes('/tokend_pricing_shadow_sessions?')))

  const rejected = createRolloutRunner({
    env: { SUPABASE_URL: 'https://project.supabase.co', SUPABASE_SERVICE_KEY: 'svc', SUPABASE_ANON_KEY: 'anon' },
    fetch: async input => String(input).includes('/tokend_pricing_backfill_targets?')
      ? jsonResponse({ code: 'PGRST202' }, 404)
      : jsonResponse([]),
    fs: nodeFs, clock: () => new Date(), sleep: async () => {}, randomUUID: () => 'reject',
  })
  await assert.rejects(rejected.execute('fixture-reset', { state: statePath }), /status 404/i)
})

test('preflight distinguishes an absent admin RPC from present null pointers and trusts active effective zero-cost metrics', async () => {
  const dir = await tempDir()
  const out = path.join(dir, 'preflight-present.json')
  const fakeFetch: typeof fetch = async (input, init = {}) => {
    const url = String(input)
    if (url.includes('/tokend_usage_events?')) return jsonResponse([
      { model: 'raw-zero', total_tokens: 10, total_cost: 0, member_code: 'A' },
      { model: 'raw-priced', total_tokens: 10, total_cost: 1, member_code: 'B' },
    ], 200, { 'content-range': '0-1/2' })
    if (url.includes('/tokend_model_prices?')) return jsonResponse([{ model_id: 'legacy' }], 200, { 'content-range': '0-0/1' })
    if (url.endsWith(`/rpc/${PREFLIGHT_RPC_NAME}`)) return jsonResponse({
      eventCount: 2,
      eligibleEventCount: 2,
      eligibleZeroCostEventCount: 0,
      legacyPriceRowCount: 1,
      unpricedEventCount: 0,
      statusCounts: { estimated: 2 },
      zeroCostByModel: [],
      activeCatalogVersion: null,
      activeRunId: null,
      previousCatalogVersion: null,
      previousRunId: null,
      membersOver2xCount: 0,
      activeReconciliationHash: null,
    })
    return jsonResponse({ code: 'unexpected' }, 500)
  }
  const runner = createRolloutRunner({
    env: { SUPABASE_URL: 'https://project.supabase.co', SUPABASE_SERVICE_KEY: 'svc', SUPABASE_ANON_KEY: 'anon' },
    fetch: fakeFetch, fs: nodeFs, clock: () => new Date('2026-07-10T00:00:00Z'), sleep: async () => {}, randomUUID,
  })
  const result = await runner.execute('preflight', { out })
  assert.equal(result.eligibleZeroCostEventCount, 0)
  assert.deepEqual(result.zeroCostByModel, [])
  assert.equal(result.activeCatalogVersion, null)
  assert.equal(result.activeRunId, null)
  assert.equal(result.previousCatalogVersion, null)
  assert.equal(result.previousRunId, null)
  assert.equal(result.reconciliationHash, null)
})

test('HTTP failures never echo response bodies, state secrets, provider URLs, or authorization', async () => {
  const dir = await tempDir()
  const statePath = path.join(dir, 'state.json')
  await atomicWriteJson(statePath, {
    wrapperGatePassed: true,
    fixture: { memberCode: 'ROLL_secret', memberToken: 'member-secret' },
  }, { fs: nodeFs, randomUUID })
  const runner = createRolloutRunner({
    env: { SUPABASE_URL: 'https://project.supabase.co', SUPABASE_SERVICE_KEY: 'service-secret', SUPABASE_ANON_KEY: 'anon-secret' },
    fetch: async () => new Response(JSON.stringify({ prompt: 'private-prompt', providerUrl: 'https://provider.invalid/raw', token: 'leaked' }), { status: 500 }),
    fs: nodeFs, clock: () => new Date(), sleep: async () => {}, randomUUID: () => 'uuid',
  })
  await assert.rejects(runner.execute('upload-smoke', { state: statePath }), (error: unknown) => {
    const message = String((error as Error).message)
    for (const forbidden of ['private-prompt', 'provider.invalid', 'member-secret', 'service-secret', 'anon-secret', 'leaked']) {
      assert.doesNotMatch(message, new RegExp(forbidden))
    }
    return true
  })
})

test('import has no signal or exception-handler side effects; handlers belong to CLI main only', () => {
  const modulePath = path.resolve(process.cwd(), 'scripts/tokend-production-rollout.mjs')
  const script = `
    const before = ['SIGINT','SIGTERM','uncaughtException','unhandledRejection'].map(n => process.listenerCount(n));
    await import(${JSON.stringify(`file://${modulePath}`)});
    const after = ['SIGINT','SIGTERM','uncaughtException','unhandledRejection'].map(n => process.listenerCount(n));
    if (JSON.stringify(before) !== JSON.stringify(after)) process.exit(9);
  `
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' })
  assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`)
})

test('command surface constants are exact and do not grant service access to client RPCs', () => {
  assert.equal(CLIENT_RPC_NAMES.length, 9)
  assert.equal(ADMIN_RPC_NAMES.length, 6)
  assert.equal(LEGACY_RPC_NAMES.length, 9)
  assert.deepEqual(ADMIN_RPC_NAMES, [
    'tokend_pricing_create_backfill',
    'tokend_pricing_backfill_batch',
    'tokend_pricing_reconcile',
    'tokend_pricing_activate',
    'tokend_pricing_rollback',
    'tokend_pricing_get_backfill',
  ])
  assert.equal(PREFLIGHT_RPC_NAME, 'tokend_pricing_preflight')
  assert.equal(ADMIN_RPC_SIGNATURES.tokend_pricing_backfill_batch, 'UUID, TEXT, TEXT, INTEGER')
  assert.equal(CLIENT_RPC_SIGNATURES.tokend_get_session_detail_v2, 'TEXT, TEXT')
  assert.ok(new Set([...CLIENT_RPC_NAMES, ...ADMIN_RPC_NAMES]).size === 15)
  assert.ok(CLIENT_RPC_NAMES.every(name => name.startsWith('tokend_')))
})

async function main(): Promise<void> {
  for (const { name, run } of tests) {
    try {
      await run()
    } catch (error) {
      console.error(`FAIL ${name}`)
      throw error
    }
  }
  console.log(`production rollout contract tests passed (${tests.length})`)
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
