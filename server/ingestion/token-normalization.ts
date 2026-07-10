import type { RawUsageEvent } from './parser.js'

export type UsageBuckets = Pick<
  RawUsageEvent,
  'inputTokens' | 'outputTokens' | 'reasoningTokens' | 'cacheReadTokens' | 'cacheWriteTokens'
>

const USAGE_BUCKET_NAMES: Array<keyof UsageBuckets> = [
  'inputTokens',
  'outputTokens',
  'reasoningTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
]

export function validateUsageBuckets(
  usage: UsageBuckets,
): { ok: true; value: UsageBuckets } | { ok: false; warning: string } {
  for (const bucket of USAGE_BUCKET_NAMES) {
    const value = usage[bucket]
    if (!Number.isFinite(value) || value < 0) {
      return {
        ok: false,
        warning: `${bucket} must be a finite non-negative number (received ${String(value)})`,
      }
    }
  }

  return { ok: true, value: usage }
}
