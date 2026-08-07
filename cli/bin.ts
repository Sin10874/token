#!/usr/bin/env npx tsx

import { createInterface } from 'node:readline'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { supabase } from './supabase-client.js'
import { runCloudSync } from './sync.js'
import { installDaemon, uninstallDaemon, daemonStatus, shouldAutoInstallDaemon } from './daemon.js'
import { resolveSessionToken, type TokenIdentity } from './auth.js'

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

function clearConfig() {
  try {
    rmSync(CONFIG_FILE)
  } catch {
    // 不存在或不可删都按未绑定处理
  }
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

async function validateToken(token: string): Promise<TokenIdentity> {
  const { data, error } = await supabase.rpc('tokend_validate_token', { p_token: token })
  if (error) throw new Error(error.message)
  return data as TokenIdentity
}

async function main() {
  const cmd = process.argv[2]
  const quiet = cmd === '--quiet' || process.argv.includes('--quiet')
  const reauth = cmd === '--reauth' || process.argv.includes('--reauth')

  // Daemon subcommand
  if (cmd === 'daemon') {
    const sub = process.argv[3]
    if (sub === 'install') installDaemon()
    else if (sub === 'uninstall') uninstallDaemon()
    else daemonStatus()
    return
  }

  // 激活/身份解析：--reauth 换绑；已有 token 每次校验并打印绑定身份；
  // token 失效时交互环境自动重新激活，--quiet（daemon）给换绑指引退出
  const session = await resolveSessionToken(
    { reauth, quiet },
    {
      readConfig,
      saveConfig,
      clearConfig,
      validate: validateToken,
      prompt,
      isInteractive: Boolean(process.stdin.isTTY),
      log: (msg) => console.log(msg),
      error: (msg) => console.error(msg),
    },
  )
  if (session.kind === 'exit') process.exit(session.code)

  // Run sync
  if (!quiet) console.log('  正在同步数据...\n')

  try {
    const stats = await runCloudSync(session.token)

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
