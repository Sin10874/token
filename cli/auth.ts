#!/usr/bin/env npx tsx

// Tokend CLI 激活/身份解析流程（2026-08-08）。
// 背景：老配置静默复用导致数据同步到旧身份（TEST001 事故）——CLI 有配置就不再提示、
// 也不显示绑定的是谁。现在：每次同步前校验并打印绑定身份；token 失效时交互环境自动
// 重新激活、非交互（daemon --quiet）给明确换绑指引；--reauth 主动换绑。
// IO 全部注入，测试可全量覆盖流程分支（见 tests/cli-auth-flow-regression.ts）。

export type TokenIdentity = { ok: boolean; member_code?: string }

export type AuthIO = {
  readConfig(): { token?: string } | null
  saveConfig(token: string): void
  clearConfig(): void
  /** 校验 token；网络/服务异常应 throw（与「token 无效」区分：后者 resolve {ok:false}） */
  validate(token: string): Promise<TokenIdentity>
  prompt(question: string): Promise<string>
  isInteractive: boolean
  log(msg: string): void
  error(msg: string): void
}

export type ResolveResult =
  | { kind: 'token'; token: string; memberCode: string | null }
  | { kind: 'exit'; code: number }

const ACTIVATE_HINT = '  请先在 https://ai798lab.com/tokend 获取 Token（设置页 → 同步令牌 → 复制）'

async function activate(io: AuthIO): Promise<ResolveResult> {
  io.log(ACTIVATE_HINT)
  const token = await io.prompt('  请输入激活 Token: ')

  if (!token || !token.startsWith('tkd_')) {
    io.error('\n  Token 无效。Token 应以 "tkd_" 开头。\n')
    return { kind: 'exit', code: 1 }
  }

  let identity: TokenIdentity
  try {
    identity = await io.validate(token)
  } catch (err: any) {
    io.error(`\n  Token 校验请求失败：${err?.message ?? err}\n`)
    return { kind: 'exit', code: 1 }
  }
  if (!identity?.ok) {
    io.error('\n  Token 无效，请检查后重试。\n')
    return { kind: 'exit', code: 1 }
  }

  io.saveConfig(token)
  io.log(`\n  ✓ 验证成功 (${identity.member_code})\n`)
  return { kind: 'token', token, memberCode: identity.member_code ?? null }
}

export async function resolveSessionToken(
  opts: { reauth: boolean; quiet: boolean },
  io: AuthIO,
): Promise<ResolveResult> {
  if (opts.reauth) {
    io.clearConfig()
    if (!opts.quiet) io.log('  已清除本地绑定，请重新激活。\n')
  }

  const config = io.readConfig()

  if (config?.token) {
    let identity: TokenIdentity
    try {
      identity = await io.validate(config.token)
    } catch {
      // 校验请求本身失败（网络抖动等）不阻断同步；上传链路会暴露真实错误
      if (!opts.quiet) io.log('  (身份校验请求失败，继续尝试同步)\n')
      return { kind: 'token', token: config.token, memberCode: null }
    }

    if (identity?.ok) {
      if (!opts.quiet) io.log(`  同步账户: ${identity.member_code}\n`)
      return { kind: 'token', token: config.token, memberCode: identity.member_code ?? null }
    }

    // token 无效/已失效
    if (opts.quiet || !io.isInteractive) {
      io.error('\n  绑定 Token 已失效，请运行 npx tokend-cli --reauth 重新激活。\n')
      return { kind: 'exit', code: 1 }
    }
    io.error('  绑定 Token 已失效，请重新激活。\n')
    // 落入重新激活流程
  }

  if (!opts.quiet && !config?.token) {
    io.log('\n  Tokend — AI 编程成本监控\n')
  }
  if (!io.isInteractive) {
    io.error('\n  未找到绑定 Token。请先交互运行 npx tokend-cli 完成激活。\n')
    return { kind: 'exit', code: 1 }
  }
  return activate(io)
}
