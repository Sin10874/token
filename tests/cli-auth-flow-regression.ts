import assert from 'node:assert/strict'
import { resolveSessionToken, type AuthIO, type TokenIdentity } from '../cli/auth.ts'

// CLI 激活/身份解析流程回归（2026-08-08）。
// 覆盖：身份打印、失效重问、quiet 拒问、--reauth 换绑、校验请求异常不阻断。

type FakeOptions = {
  config?: { token?: string } | null
  identities?: Record<string, TokenIdentity>
  validateThrows?: boolean
  promptAnswers?: string[]
  isInteractive?: boolean
}

function makeIo(options: FakeOptions) {
  const state = {
    config: options.config === undefined ? null : options.config,
    saved: [] as string[],
    cleared: 0,
    logs: [] as string[],
    errors: [] as string[],
    prompts: [] as string[],
  }
  const answers = [...(options.promptAnswers ?? [])]
  const io: AuthIO = {
    readConfig: () => state.config,
    saveConfig: (token) => { state.saved.push(token); state.config = { token } },
    clearConfig: () => { state.cleared += 1; state.config = null },
    validate: async (token) => {
      if (options.validateThrows) throw new Error('network down')
      return options.identities?.[token] ?? { ok: false }
    },
    prompt: async (question) => {
      state.prompts.push(question)
      return answers.shift() ?? ''
    },
    isInteractive: options.isInteractive ?? true,
    log: (msg) => { state.logs.push(msg) },
    error: (msg) => { state.errors.push(msg) },
  }
  return { io, state }
}

async function testPrintsBoundIdentityOnEverySync() {
  const { io, state } = makeIo({
    config: { token: 'tkd_old' },
    identities: { tkd_old: { ok: true, member_code: 'ZOPC042' } },
  })
  const result = await resolveSessionToken({ reauth: false, quiet: false }, io)
  assert.deepEqual(result, { kind: 'token', token: 'tkd_old', memberCode: 'ZOPC042' })
  assert.ok(state.logs.some((m) => m.includes('同步账户: ZOPC042')), '应打印绑定身份')
  assert.equal(state.prompts.length, 0, '有效 token 不应再提示')
}

async function testQuietModeStillValidatesButStaysSilent() {
  const { io, state } = makeIo({
    config: { token: 'tkd_old' },
    identities: { tkd_old: { ok: true, member_code: 'ZOPC042' } },
  })
  const result = await resolveSessionToken({ reauth: false, quiet: true }, io)
  assert.equal(result.kind, 'token')
  assert.equal(state.logs.length, 0, 'quiet 模式不打印')
}

async function testInvalidTokenInteractiveReactivates() {
  const { io, state } = makeIo({
    config: { token: 'tkd_dead' },
    identities: { tkd_new: { ok: true, member_code: 'ZOPC099' } },
    promptAnswers: ['tkd_new'],
  })
  const result = await resolveSessionToken({ reauth: false, quiet: false }, io)
  assert.deepEqual(result, { kind: 'token', token: 'tkd_new', memberCode: 'ZOPC099' })
  assert.deepEqual(state.saved, ['tkd_new'], '新 token 应落盘')
  assert.ok(state.errors.some((m) => m.includes('已失效')), '应提示旧 token 失效')
}

async function testInvalidTokenQuietExitsWithReauthHint() {
  const { io, state } = makeIo({ config: { token: 'tkd_dead' }, isInteractive: false })
  const result = await resolveSessionToken({ reauth: false, quiet: true }, io)
  assert.deepEqual(result, { kind: 'exit', code: 1 })
  assert.equal(state.prompts.length, 0, 'quiet 不得提示输入')
  assert.ok(state.errors.some((m) => m.includes('--reauth')), '应给出换绑指引')
}

async function testReauthClearsConfigAndPrompts() {
  const { io, state } = makeIo({
    config: { token: 'tkd_old' },
    identities: { tkd_new: { ok: true, member_code: 'ZOPC001' } },
    promptAnswers: ['tkd_new'],
  })
  const result = await resolveSessionToken({ reauth: true, quiet: false }, io)
  assert.equal(state.cleared, 1, 'reauth 应清配置')
  assert.equal(state.prompts.length, 1, 'reauth 后应走激活流程')
  assert.deepEqual(result, { kind: 'token', token: 'tkd_new', memberCode: 'ZOPC001' })
}

async function testFirstRunRejectsBadFormat() {
  const { io, state } = makeIo({ promptAnswers: ['not-a-token'] })
  const result = await resolveSessionToken({ reauth: false, quiet: false }, io)
  assert.deepEqual(result, { kind: 'exit', code: 1 })
  assert.equal(state.saved.length, 0)
  assert.ok(state.errors.some((m) => m.includes('tkd_')), '应提示格式')
}

async function testFirstRunRejectsInvalidToken() {
  const { io, state } = makeIo({ promptAnswers: ['tkd_fake'] })
  const result = await resolveSessionToken({ reauth: false, quiet: false }, io)
  assert.deepEqual(result, { kind: 'exit', code: 1 })
  assert.equal(state.saved.length, 0, '校验不过不落盘')
}

async function testValidateNetworkErrorDoesNotBlockSync() {
  const { io, state } = makeIo({ config: { token: 'tkd_old' }, validateThrows: true })
  const result = await resolveSessionToken({ reauth: false, quiet: false }, io)
  assert.deepEqual(result, { kind: 'token', token: 'tkd_old', memberCode: null })
  assert.ok(state.logs.some((m) => m.includes('继续尝试同步')), '应警告后继续')
}

async function testNonInteractiveWithoutTokenExits() {
  const { io, state } = makeIo({ isInteractive: false })
  const result = await resolveSessionToken({ reauth: false, quiet: true }, io)
  assert.deepEqual(result, { kind: 'exit', code: 1 })
  assert.equal(state.prompts.length, 0)
}

const tests = [
  testPrintsBoundIdentityOnEverySync,
  testQuietModeStillValidatesButStaysSilent,
  testInvalidTokenInteractiveReactivates,
  testInvalidTokenQuietExitsWithReauthHint,
  testReauthClearsConfigAndPrompts,
  testFirstRunRejectsBadFormat,
  testFirstRunRejectsInvalidToken,
  testValidateNetworkErrorDoesNotBlockSync,
  testNonInteractiveWithoutTokenExits,
]

async function main() {
  for (const test of tests) {
    await test()
    console.log(`  ✓ ${test.name}`)
  }
  console.log(`\ncli-auth-flow: ${tests.length} passed`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
