#!/usr/bin/env npx tsx

import { createInterface } from 'node:readline'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { supabase } from './supabase-client.js'
import { runCloudSync } from './sync.js'
import { installDaemon, uninstallDaemon, daemonStatus, shouldAutoInstallDaemon } from './daemon.js'

const CONFIG_DIR = join(homedir(), '.tokend')
const CONFIG_FILE = join(CONFIG_DIR, 'config.json')

function readConfig(): { token?: string } | null {
  if (!existsSync(CONFIG_FILE)) return null
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'))
  } catch {
    return null
  }
}

function saveConfig(token: string) {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true })
  }
  writeFileSync(CONFIG_FILE, JSON.stringify({ token, activatedAt: new Date().toISOString() }, null, 2))
}

function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close()
      resolve(answer.trim())
    })
  })
}

async function main() {
  const cmd = process.argv[2]
  const quiet = cmd === '--quiet' || process.argv.includes('--quiet')

  // Daemon subcommand
  if (cmd === 'daemon') {
    const sub = process.argv[3]
    if (sub === 'install') installDaemon()
    else if (sub === 'uninstall') uninstallDaemon()
    else daemonStatus()
    return
  }

  // Read or prompt for token
  let config = readConfig()

  if (!config?.token) {
    console.log('\n  Tokend — AI 编程成本监控\n')
    console.log('  请先在 https://ai798lab.com/tokend 获取 Token\n')
    const token = await prompt('  请输入激活 Token: ')

    if (!token || !token.startsWith('tkd_')) {
      console.error('\n  Token 无效。Token 应以 "tkd_" 开头。\n')
      process.exit(1)
    }

    // Validate against Supabase
    const { data } = await supabase.rpc('tokend_validate_token', { p_token: token })
    if (!data?.ok) {
      console.error('\n  Token 无效，请检查后重试。\n')
      process.exit(1)
    }

    saveConfig(token)
    console.log(`\n  ✓ 验证成功 (${data.member_code})\n`)
    config = { token }
  }

  // Run sync
  if (!quiet) console.log('  正在同步数据...\n')

  try {
    const stats = await runCloudSync(config.token!)

    if (!quiet) {
      console.log(`  ✓ 同步完成`)
      console.log(`    文件: ${stats.filesProcessed}`)
      console.log(`    事件: ${stats.eventsInserted}`)
      console.log(`    会话: ${stats.sessionsUpdated}`)
      console.log(`    耗时: ${stats.duration}ms\n`)
      console.log(`  查看面板: https://ai798lab.com/tokend\n`)
    }

    // Auto-install/update daemon on EVERY run (not just interactive)
    // This ensures daemon stays healthy even if node/script paths change
    if (shouldAutoInstallDaemon()) {
      try {
        installDaemon(true)
      } catch {
        // Silently skip if daemon install fails
      }
    }
  } catch (err: any) {
    if (!quiet) {
      console.error(`\n  同步失败: ${err.message}\n`)
    }
    process.exit(1)
  }
}

main()
