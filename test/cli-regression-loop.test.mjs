import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { tempHome } from './helpers.mjs'

const execFileP = promisify(execFile)
const CLI = path.resolve(import.meta.dirname, '../bin/taskboard.js')

/** 每个用例独立 HOME，子进程里跑真实的 CLI（复现 #5：CLI 参数解析非 1:1） */
async function cli(home, args) {
  const { stdout } = await execFileP('node', [CLI, ...args], {
    env: { ...process.env, TASKBOARD_HOME: home },
    encoding: 'utf8'
  })
  return JSON.parse(stdout)
}

async function cliFail(home, args) {
  try {
    await execFileP('node', [CLI, ...args], { env: { ...process.env, TASKBOARD_HOME: home }, encoding: 'utf8' })
    return null
  } catch (e) {
    return { code: e.code, stderr: String(e.stderr || '') + String(e.stdout || '') }
  }
}

async function setup() {
  const tmp = await tempHome()
  // tempHome 已经塞了 TASKBOARD_HOME，但 CLI 是子进程，另起的库与当前用例无关；
  // 这里直接复用 tmp.dir 作为子进程的 HOME，保证清理即可回收。
  const home = tmp.dir
  await cli(home, ['node', 'upsert', '--path', 'P/R'])
  return { tmp, home }
}

test('缺陷5回归：CLI test case upsert 支持 --enabled false（原问题：ERR_PARSE_ARGS_UNKNOWN_OPTION）', async () => {
  const { tmp, home } = await setup()
  try {
    const c = await cli(home, ['test', 'case', 'upsert', 'P/R', '--name', 'A', '--prompt', 'p', '--enabled', 'false'])
    assert.equal(c.enabled, false)
    // 停用后默认列表不返回，--include-disabled 能查到
    assert.equal((await cli(home, ['test', 'case', 'list', 'P/R'])).length, 0)
    assert.equal((await cli(home, ['test', 'case', 'list', 'P/R', '--include-disabled'])).length, 1)
    // update 也能改回启用
    const on = await cli(home, ['test', 'case', 'update', String(c.id), '--enabled', 'true'])
    assert.equal(on.enabled, true)
    assert.equal((await cli(home, ['test', 'case', 'list', 'P/R'])).length, 1)
  } finally {
    tmp.cleanup()
  }
})

test('缺陷5回归：CLI --enabled 非法值报 VALIDATION_FAILED（不是参数解析崩溃）', async () => {
  const { tmp, home } = await setup()
  try {
    const r = await cliFail(home, ['test', 'case', 'upsert', 'P/R', '--name', 'A', '--prompt', 'p', '--enabled', 'maybe'])
    assert.ok(r, '应当失败')
    assert.match(r.stderr, /VALIDATION_FAILED/)
    assert.ok(!/UNKNOWN_OPTION/.test(r.stderr))
  } finally {
    tmp.cleanup()
  }
})

test('缺陷5回归：CLI test report finish 支持 --run-id（原问题：无此参数）', async () => {
  const { tmp, home } = await setup()
  try {
    const c = await cli(home, ['test', 'case', 'upsert', 'P/R', '--name', 'A', '--prompt', 'p'])
    // 直接经 store 开报告（真派单需要仓库，这里只验 CLI 参数契约）
    const { openDb } = await import('../server/db.mjs')
    const { createStore } = await import('../server/store.mjs')
    process.env.TASKBOARD_HOME = home
    const store = createStore(openDb(path.join(home, 'data.db')))
    const node = store.resolveRef('P/R')
    const run = store.createAgentRun(node.id, { prompt: 'x', agent: 'qodercli' }, 'user')
    const rep = store.createTestReport(node.id, { caseId: c.id })
    store.db.close()
    const done = await cli(home, ['test', 'report', 'finish', String(rep.id), '--status', 'pass', '--run-id', String(run.id)])
    assert.equal(done.status, 'pass')
    assert.equal(done.runId, run.id)
  } finally {
    tmp.cleanup()
  }
})

test('缺陷5回归：CLI test report finish 支持 --overwrite（终态互转显式覆盖）', async () => {
  const { tmp, home } = await setup()
  try {
    const c = await cli(home, ['test', 'case', 'upsert', 'P/R', '--name', 'A', '--prompt', 'p'])
    const { openDb } = await import('../server/db.mjs')
    const { createStore } = await import('../server/store.mjs')
    process.env.TASKBOARD_HOME = home
    const store = createStore(openDb(path.join(home, 'data.db')))
    const node = store.resolveRef('P/R')
    const rep = store.createTestReport(node.id, { caseId: c.id })
    store.db.close()
    await cli(home, ['test', 'report', 'finish', String(rep.id), '--status', 'pass'])
    // 终态互转默认拒绝
    const rejected = await cliFail(home, ['test', 'report', 'finish', String(rep.id), '--status', 'fail'])
    assert.match(rejected.stderr, /REPORT_STATUS_IMMUTABLE/)
    // 显式 overwrite 才覆盖
    const forced = await cli(home, ['test', 'report', 'finish', String(rep.id), '--status', 'fail', '--overwrite'])
    assert.equal(forced.status, 'fail')
  } finally {
    tmp.cleanup()
  }
})

test('需求就绪门禁：CLI readiness check 全链路（未就绪 → 补齐 → 就绪）', async () => {
  const { tmp, home } = await setup()
  try {
    // 新建需求：预置空白「需求内容」不算通过
    let out = await cli(home, ['readiness', 'check', 'P/R'])
    assert.equal(out.ready, false)
    assert.equal(out.totals.units, 1)
    assert.equal(out.totals.failed, 3)

    await cli(home, ['doc', 'upsert', 'P/R', '--name', '需求内容', '--content', '需求正文'])
    await cli(home, ['doc', 'upsert', 'P/R', '--name', '概要设计', '--content', '设计正文'])
    await cli(home, ['test', 'case', 'upsert', 'P/R', '--name', '回归用例', '--prompt', '跑单测'])
    out = await cli(home, ['readiness', 'check', 'P/R'])
    assert.equal(out.ready, true)
    assert.equal(out.totals.readyUnits, 1)

    // 非需求节点 self 拒绝，提示改用 subtree
    const rejected = await cliFail(home, ['readiness', 'check', 'P'])
    assert.match(rejected.stderr, /scope=subtree/)
  } finally {
    tmp.cleanup()
  }
})

// ---------- D2 回归：CLI 非法 --scope 必须报错，不得静默降级 self ----------

test('D2回归：CLI 非法 --scope 报 VALIDATION_FAILED（不再静默降级 self）', async () => {
  const { tmp, home } = await setup()
  try {
    // P/R 自身补齐就绪；旧实现下 --scope Subtree 会降级 self → ready=true（假绿）
    await cli(home, ['doc', 'upsert', 'P/R', '--name', '需求内容', '--content', '正文'])
    await cli(home, ['doc', 'upsert', 'P/R', '--name', '概要设计', '--content', '设计'])
    await cli(home, ['test', 'case', 'upsert', 'P/R', '--name', '回归用例', '--prompt', '跑单测'])

    for (const bad of ['Subtree', 'subtre', 'xyz']) {
      const r = await cliFail(home, ['readiness', 'check', 'P/R', '--scope', bad])
      assert.ok(r, `--scope ${bad} 应当失败`)
      assert.match(r.stderr, /VALIDATION_FAILED/)
    }
    // 合法值仍工作
    assert.equal((await cli(home, ['readiness', 'check', 'P/R', '--scope', 'self'])).ready, true)
    assert.equal((await cli(home, ['readiness', 'check', 'P/R', '--scope', 'subtree'])).scope, 'subtree')
  } finally {
    tmp.cleanup()
  }
})

test('交付门禁：CLI delivery gate 全链路（unknown → not_ready → ready）', async () => {
  const { tmp, home } = await setup()
  try {
    // 只有项目：三段证据都不适用 → unknown（不是绿灯）
    let gate = await cli(home, ['delivery', 'gate', 'P'])
    assert.equal(gate.decision, 'unknown')
    assert.equal(gate.ready, null)

    // 需求补齐 + 测试用例已登记但尚未执行 → not_ready
    await cli(home, ['doc', 'upsert', 'P/R', '--name', '需求内容', '--content', '需求正文'])
    await cli(home, ['doc', 'upsert', 'P/R', '--name', '概要设计', '--content', '设计正文'])
    const testCase = await cli(home, ['test', 'case', 'upsert', 'P/R', '--name', '回归用例', '--prompt', '跑单测'])
    gate = await cli(home, ['delivery', 'gate', 'P/R'])
    assert.equal(gate.decision, 'not_ready')
    assert.equal(gate.blockers.length, 1)

    // 直接经 store 写 pass 报告（真派单需要仓库），再验证 ready
    const { openDb } = await import('../server/db.mjs')
    const { createStore } = await import('../server/store.mjs')
    process.env.TASKBOARD_HOME = home
    const store = createStore(openDb(path.join(home, 'data.db')))
    const node = store.resolveRef('P/R')
    const report = store.createTestReport(node.id, { caseId: testCase.id })
    store.finishTestReport(report.id, { status: 'pass', summary: '全绿' })
    store.upsertAcceptanceSignoff(node.id, { decision: 'accepted', comment: '业务确认通过' })
    store.db.close()
    gate = await cli(home, ['delivery', 'gate', 'P/R'])
    assert.equal(gate.decision, 'ready')
    assert.equal(gate.ready, true)
  } finally {
    tmp.cleanup()
  }
})

test('交付门禁：CLI 非法 --scope / --format 返回 VALIDATION_FAILED（CLI 回归）', async () => {
  const { tmp, home } = await setup()
  try {
    for (const args of [
      ['delivery', 'gate', 'P/R', '--scope', 'sub'],
      ['delivery', 'gate', 'P/R', '--format', 'xml'],
      ['delivery', 'gate', 'P/R', '--scope', ''],
      ['delivery', 'gate', 'P/R', '--format', '']
    ]) {
      const r = await cliFail(home, args)
      assert.ok(r, args.join(' '))
      assert.match(r.stderr, /VALIDATION_FAILED/)
    }
  } finally {
    tmp.cleanup()
  }
})

test('缺陷2回归：CLI --max-parallel 只接受规范十进制整数，其余一律 VALIDATION_FAILED（真实子进程）', async () => {
  const { tmp, home } = await setup()
  try {
    // 先备一条用例，保证失败原因只会是参数校验而不是「没有用例」
    await cli(home, ['test', 'case', 'upsert', 'P/R', '--name', 'A', '--prompt', 'p'])
    const cases = await cli(home, ['test', 'case', 'list', 'P/R'])
    assert.equal(cases.length, 1)

    // 合法值：dry-run 正常返回（走 parseMaxParallelCli → normalizeMaxParallel）
    const ok = await cli(home, ['test', 'run', 'P/R', '--dry-run', '--fanout', '--max-parallel', '8'])
    assert.equal(ok.maxParallel, 8)

    // 非法字面量：1.5 / 0x10 / 1e1 / 空串 / 超上限 / 非数字 / 带空白
    for (const bad of ['1.5', '0x10', '1e1', '', '0', '17', 'true', '4abc', ' 4 ']) {
      const r = await cliFail(home, ['test', 'run', 'P/R', '--dry-run', '--fanout', '--max-parallel', bad])
      assert.ok(r, `--max-parallel ${JSON.stringify(bad)} 应当失败`)
      assert.match(r.stderr, /VALIDATION_FAILED/)
      assert.match(r.stderr, /maxParallel 必须是 1\.\.16 的整数/)
    }

    // 负数用 `--max-parallel=-1` 形式：裸 `-1` 会被 node:util parseArgs 在参数层拦成
    // ERR_PARSE_ARGS_INVALID_OPTION_VALUE（它认为这是另一个选项），到不了业务校验；
    // 这里验证用 `=` 形式传进去后仍由 maxParallel 校验拦成 VALIDATION_FAILED。
    const neg = await cliFail(home, ['test', 'run', 'P/R', '--dry-run', '--fanout', '--max-parallel=-1'])
    assert.ok(neg, '负数应当失败')
    assert.match(neg.stderr, /VALIDATION_FAILED/)
  } finally {
    tmp.cleanup()
  }
})

test('缺陷2回归：CLI 非法 --max-parallel 在 grouped（不加 --fanout）下同样拒绝', async () => {
  const { tmp, home } = await setup()
  try {
    await cli(home, ['test', 'case', 'upsert', 'P/R', '--name', 'A', '--prompt', 'p'])
    const r = await cliFail(home, ['test', 'run', 'P/R', '--dry-run', '--max-parallel', '4x'])
    assert.ok(r, 'grouped 下非法 maxParallel 也应失败')
    assert.match(r.stderr, /VALIDATION_FAILED/)
  } finally {
    tmp.cleanup()
  }
})
