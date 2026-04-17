#!/usr/bin/env npx tsx

/**
 * Sync members from Feishu Bitable → Supabase tokend_members table.
 *
 * Usage:
 *   SUPABASE_URL=https://xxx.supabase.co SUPABASE_SERVICE_ROLE_KEY=xxx npx tsx scripts/sync-members-to-supabase.ts
 */

import { execFileSync } from 'node:child_process'
import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

// Feishu Bitable config (same as server/feishu/bitable.ts)
const BASE_TOKEN = 'AkBCbKSWbaT7jzsMABzceEmPnJd'
const TABLE_ID = 'tblqcDlnvjXbnwbj'
const FIELD_PHONE = 'fldiSYURLN'
const FIELD_MEMBER_CODE = 'fld95IuhYN'
const FIELD_TAGLINE = 'fld9PmMjfy'

async function main() {
  console.log('Fetching members from Feishu Bitable...')

  const raw = execFileSync('lark-cli', [
    'base', '+record-list',
    '--as', 'user',
    '--base-token', BASE_TOKEN,
    '--table-id', TABLE_ID,
    '--limit', '500',
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

  const parsed = JSON.parse(raw)
  const data = parsed?.data
  if (!data?.field_id_list || !data?.data) {
    console.error('Failed to parse Feishu response')
    process.exit(1)
  }

  const fieldIds: string[] = data.field_id_list
  const records: unknown[][] = data.data

  const phoneIdx = fieldIds.indexOf(FIELD_PHONE)
  const codeIdx = fieldIds.indexOf(FIELD_MEMBER_CODE)
  const taglineIdx = fieldIds.indexOf(FIELD_TAGLINE)

  if (phoneIdx === -1 || codeIdx === -1) {
    console.error('Required fields not found in Bitable')
    process.exit(1)
  }

  const members = records
    .map((row) => ({
      phone: String(row[phoneIdx] ?? ''),
      member_code: String(row[codeIdx] ?? ''),
      tagline: taglineIdx !== -1 ? String(row[taglineIdx] ?? '') : '',
    }))
    .filter((m) => m.phone && m.member_code)

  console.log(`Found ${members.length} members in Feishu`)

  // Upsert to Supabase
  const { data: result, error } = await supabase
    .from('tokend_members')
    .upsert(members, { onConflict: 'member_code' })
    .select()

  if (error) {
    console.error('Supabase upsert failed:', error.message)
    process.exit(1)
  }

  console.log(`Synced ${result?.length ?? members.length} members to Supabase ✓`)
}

main()
