import assert from 'node:assert/strict'
import * as syncModuleImport from '../cli/sync.ts'

type UploadResult = {
  data: { inserted?: number } | null
  error: { code?: string; message: string } | null
}

type UploadCall = (
  events: Record<string, unknown>[],
  syncStates: Record<string, unknown>[],
) => Promise<UploadResult>

const syncModule = syncModuleImport as Record<string, unknown>
const uploadEventBatches = syncModule.uploadEventBatches as (
  events: Record<string, unknown>[],
  syncStates: Record<string, unknown>[],
  upload: UploadCall,
) => Promise<number>

async function testUsesSmallerInitialBatchesAndCommitsSyncStateLast() {
  const calls: Array<{ eventCount: number; syncStateCount: number }> = []
  const events = Array.from({ length: 501 }, (_, index) => ({ id: `event-${index}` }))
  const syncStates = [{ sourcePathHash: 'source', lastProcessedLines: 501, parserVersion: 1 }]

  const inserted = await uploadEventBatches(events, syncStates, async (batch, states) => {
    calls.push({ eventCount: batch.length, syncStateCount: states.length })
    return { data: { inserted: batch.length }, error: null }
  })

  assert.equal(inserted, 501)
  assert.deepEqual(calls, [
    { eventCount: 500, syncStateCount: 0 },
    { eventCount: 1, syncStateCount: 1 },
  ])
}

async function testSplitsOnlyTimedOutBatchAndPreservesFinalSyncState() {
  const calls: Array<{ eventCount: number; syncStateCount: number }> = []
  const events = Array.from({ length: 500 }, (_, index) => ({ id: `event-${index}` }))
  const syncStates = [{ sourcePathHash: 'source', lastProcessedLines: 500, parserVersion: 1 }]

  const inserted = await uploadEventBatches(events, syncStates, async (batch, states) => {
    calls.push({ eventCount: batch.length, syncStateCount: states.length })
    if (batch.length === 500) {
      return {
        data: null,
        error: { code: '57014', message: 'canceling statement due to statement timeout' },
      }
    }
    return { data: { inserted: batch.length }, error: null }
  })

  assert.equal(inserted, 500)
  assert.deepEqual(calls, [
    { eventCount: 500, syncStateCount: 1 },
    { eventCount: 250, syncStateCount: 0 },
    { eventCount: 250, syncStateCount: 1 },
  ])
}

async function testDoesNotRetryNonTimeoutErrors() {
  let attempts = 0

  await assert.rejects(
    () => uploadEventBatches([{ id: 'event-1' }], [], async () => {
      attempts++
      return { data: null, error: { code: '42501', message: 'permission denied' } }
    }),
    /Upload failed: permission denied/,
  )

  assert.equal(attempts, 1)
}

async function testSingleEventTimeoutFailsWithoutLooping() {
  let attempts = 0

  await assert.rejects(
    () => uploadEventBatches([{ id: 'event-1' }], [], async () => {
      attempts++
      return {
        data: null,
        error: { code: '57014', message: 'canceling statement due to statement timeout' },
      }
    }),
    /Upload failed: canceling statement due to statement timeout/,
  )

  assert.equal(attempts, 1)
}

async function testDoesNotSplitUnrelatedStatementTimeoutErrors() {
  let attempts = 0

  await assert.rejects(
    () => uploadEventBatches([{ id: 'event-1' }, { id: 'event-2' }], [], async () => {
      attempts++
      return {
        data: null,
        error: { code: '22023', message: 'invalid statement timeout configuration' },
      }
    }),
    /Upload failed: invalid statement timeout configuration/,
  )

  assert.equal(attempts, 1)
}

async function main() {
  assert.equal(
    typeof syncModule.uploadEventBatches,
    'function',
    'cloud sync must expose a timeout-safe event batch uploader',
  )

  await testUsesSmallerInitialBatchesAndCommitsSyncStateLast()
  await testSplitsOnlyTimedOutBatchAndPreservesFinalSyncState()
  await testDoesNotRetryNonTimeoutErrors()
  await testSingleEventTimeoutFailsWithoutLooping()
  await testDoesNotSplitUnrelatedStatementTimeoutErrors()

  console.log('cloud sync upload regression tests passed (5 cases)')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
