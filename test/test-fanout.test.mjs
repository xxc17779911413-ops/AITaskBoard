import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { tempHome } from './helpers.mjs'

async function setup() {
  const tmp = await tempHome()
  const db = tmp.openDb()
  const store = tmp.store.createStore(db)
  const p = store.createNode({ type: 'project', name: 'P' })
  const r = store.createNode({ parentId: p.id, type: 'requirement', name: 'R' })
  const s = store.createNode({ parentId: r.id, type: 'subreq', name: 'S' })
  const task = store.createNode({ parentId: s.id, type: 'task', name: 'T' })
  return { tmp, store, p, r, s, task }
}

/** 造一个可当 agent 用的目录（startAgentRun 会校验 cwd 存在） */
function agentDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-fanout-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

// ---------- grouped 缺省：向后兼容 ----------

test('fanout 缺省为 false：仍是一段提示词 + 一个 run + N 条报告（e2e 兼容）', async (t) => {
  const { tmp, store, task } = await setup()
  t.after(() => tmp.cleanup())
  const { runTestCases } = await import('../server/ops.mjs')
  store.createTestCase(task.id, { name: 'A', prompt: '跑 A' })
  store.createTestCase(task.id, { name: 'B', prompt: '跑 B' })
  const dir = agentDir(t)

  const out = runTestCases(store, task.id, { agent: 'echo', cwd: dir })
  assert.equal(out.mode, 'grouped')
  assert.ok(out.run, '缺省仍返回单个 run')
  assert.equal(out.reports.length, 2)
  assert.equal(new Set(out.reports.map((x) => x.runId)).size, 1, '两条报告共用同一个 run')
  assert.equal(store.listAgentRuns(task.id).length, 1, '只派了一个 agent 任务')
})

// ---------- fan-out：每用例一个独立任务 ----------

test('fanout：每条用例派独立 run + 独立提示词 + 一一对应的报告', async (t) => {
  const { tmp, store, task } = await setup()
  t.after(() => tmp.cleanup())
  const { runTestCases } = await import('../server/ops.mjs')
  const a = store.createTestCase(task.id, { name: 'A', prompt: '跑 A', expectation: '绿' })
  const b = store.createTestCase(task.id, { name: 'B', prompt: '跑 B' })
  const dir = agentDir(t)

  const out = runTestCases(store, task.id, { agent: 'echo', cwd: dir, fanout: true })
  assert.equal(out.mode, 'fanout')
  assert.equal(out.runs.length, 2)
  assert.equal(out.reports.length, 2)
  assert.equal(store.listAgentRuns(task.id).length, 2, '每条用例一个 agent 任务（并行）')

  // 报告与 run 一一对应，且每条 run 只承载它自己那条用例
  const byCase = new Map(out.tasks.map((x) => [x.caseId, x]))
  assert.deepEqual([...byCase.keys()].sort(), [a.id, b.id].sort())
  assert.equal(new Set(out.tasks.map((x) => x.runId)).size, 2, 'runId 各不相同')
  assert.equal(new Set(out.tasks.map((x) => x.reportId)).size, 2)
  for (const x of out.tasks) {
    const run = store.getAgentRun(x.runId)
    assert.equal(run.nodeId, task.id)
    assert.ok(run.prompt.includes(`用例 1：${x.name}`), `run 提示词只含自己的用例：${run.prompt}`)
  }
  // 每条 run 的提示词里不出现「另一个用例」，证明确实是拆开的
  const promptA = store.getAgentRun(byCase.get(a.id).runId).prompt
  assert.ok(!promptA.includes('跑 B'))
})

test('fanout：dryRun 只回报将派哪些任务与各自提示词，不落库不动 revision', async (t) => {
  const { tmp, store, task } = await setup()
  t.after(() => tmp.cleanup())
  const { runTestCases } = await import('../server/ops.mjs')
  store.createTestCase(task.id, { name: 'A', prompt: '跑 A' })
  store.createTestCase(task.id, { name: 'B', prompt: '跑 B' })
  const before = store.getRevision()

  const out = runTestCases(store, task.id, { fanout: true, dryRun: true })
  assert.equal(out.dryRun, true)
  assert.equal(out.mode, 'fanout')
  assert.equal(out.tasks.length, 2)
  assert.ok(out.tasks[0].prompt.includes('用例 1：A'))
  assert.ok(!out.tasks[0].prompt.includes('用例 1：B'), '每条任务只带自己的用例')
  assert.equal(store.listAgentRuns(task.id).length, 0, 'dryRun 不派单')
  assert.equal(store.listTestReports(task.id).length, 0, 'dryRun 不开报告')
  assert.equal(store.getRevision(), before, 'dryRun 不动 revision')
})

test('fanout：dryRun 与 caseIds / kind 过滤联动', async (t) => {
  const { tmp, store, task } = await setup()
  t.after(() => tmp.cleanup())
  const { runTestCases } = await import('../server/ops.mjs')
  const r = store.createTestCase(task.id, { name: 'R', prompt: 'p', kind: 'regression' })
  store.createTestCase(task.id, { name: 'A', prompt: 'p', kind: 'acceptance' })

  const byKind = runTestCases(store, task.id, { fanout: true, dryRun: true, kind: 'acceptance' })
  assert.deepEqual(byKind.tasks.map((x) => x.name), ['A'])
  const byId = runTestCases(store, task.id, { fanout: true, dryRun: true, caseIds: [r.id] })
  assert.deepEqual(byId.tasks.map((x) => x.name), ['R'])
})

// ---------- 护栏与值域（禁止静默降级 / 截断） ----------

test('fanout：选中数超过 maxParallel 显式拒绝，而不是静默截断（不留假 running）', async (t) => {
  const { tmp, store, task } = await setup()
  t.after(() => tmp.cleanup())
  const { runTestCases } = await import('../server/ops.mjs')
  for (const n of ['A', 'B', 'C']) store.createTestCase(task.id, { name: n, prompt: 'p' })
  const dir = agentDir(t)

  assert.throws(
    () => runTestCases(store, task.id, { agent: 'echo', cwd: dir, fanout: true, maxParallel: 2 }),
    (e) => e.code === 'VALIDATION_FAILED' && e.details.selected === 3 && e.details.maxParallel === 2
  )
  // 关键：拒绝后不能留下任何 running 任务 / 报告（否则就是「假执行中」）
  assert.equal(store.listAgentRuns(task.id).length, 0)
  assert.equal(store.listTestReports(task.id).length, 0)
})

test('fanout：maxParallel 值域 1..16，非法值一律 VALIDATION_FAILED（不静默降级）', async (t) => {
  const { tmp, store, task } = await setup()
  t.after(() => tmp.cleanup())
  const { runTestCases } = await import('../server/ops.mjs')
  store.createTestCase(task.id, { name: 'A', prompt: 'p' })
  const dir = agentDir(t)
  for (const bad of [0, -1, 1.5, 17, 100]) {
    assert.throws(
      () => runTestCases(store, task.id, { agent: 'echo', cwd: dir, fanout: true, maxParallel: bad }),
      (e) => e.code === 'VALIDATION_FAILED' && /maxParallel 必须是 1\.\.16 的整数/.test(e.message)
    )
  }
  assert.equal(store.listAgentRuns(task.id).length, 0)
})

test('fanout 缺陷2回归：maxParallel 严格拒绝非 number 类型（true / "4" / [1] 等）', async (t) => {
  const { tmp, store, task } = await setup()
  t.after(() => tmp.cleanup())
  const { runTestCases } = await import('../server/ops.mjs')
  store.createTestCase(task.id, { name: 'A', prompt: 'p' })
  const dir = agentDir(t)
  // 旧实现用 Number(value) 隐式转换：true→1、"4"→4、[1]→1 都会被放过（独立测试缺陷 2）。
  for (const bad of [true, false, '4', '1', [1], {}, '', ' ', '0x10', '1e1']) {
    assert.throws(
      () => runTestCases(store, task.id, { agent: 'echo', cwd: dir, fanout: true, maxParallel: bad }),
      (e) => e.code === 'VALIDATION_FAILED' && /maxParallel 必须是 1\.\.16 的整数/.test(e.message),
      `maxParallel=${JSON.stringify(bad)} 应当被严格拒绝`
    )
  }
  assert.equal(store.listAgentRuns(task.id).length, 0, '拒绝后不留任务')
})

test('fanout 缺陷2回归：非法 maxParallel 在 grouped（fanout=false）下也拒绝，不被静默忽略', async (t) => {
  const { tmp, store, task } = await setup()
  t.after(() => tmp.cleanup())
  const { runTestCases } = await import('../server/ops.mjs')
  store.createTestCase(task.id, { name: 'A', prompt: 'p' })
  const dir = agentDir(t)
  // 旧实现把校验放在 fanout 分支内，grouped 时非法类型被静默忽略（HTTP 漏洞）。
  assert.throws(
    () => runTestCases(store, task.id, { agent: 'echo', cwd: dir, fanout: false, maxParallel: '4' }),
    (e) => e.code === 'VALIDATION_FAILED'
  )
  assert.equal(store.listAgentRuns(task.id).length, 0)
})

test('fanout 缺陷2回归：parseMaxParallelCli 只看规范十进制整数，其余一律拒绝', async (t) => {
  const { parseMaxParallelCli } = await import('../server/ops.mjs')
  assert.equal(parseMaxParallelCli(null), null, '缺省不传 → null（走默认 4）')
  assert.equal(parseMaxParallelCli('4'), 4)
  assert.equal(parseMaxParallelCli('16'), 16)
  for (const bad of ['1.5', 'true', '0x10', '1e1', '', ' ', '-1', '0', '17', '4abc', ' 4 ']) {
    assert.throws(
      () => parseMaxParallelCli(bad),
      (e) => e.code === 'VALIDATION_FAILED' && /maxParallel 必须是 1\.\.16 的整数/.test(e.message),
      `CLI maxParallel=${JSON.stringify(bad)} 应当被拒绝`
    )
  }
})

test('fanout：maxParallel 边界值 1 与 16 可用', async (t) => {
  const { tmp, store, task } = await setup()
  t.after(() => tmp.cleanup())
  const { runTestCases } = await import('../server/ops.mjs')
  const c = store.createTestCase(task.id, { name: 'A', prompt: 'p' })
  const dir = agentDir(t)
  assert.equal(runTestCases(store, task.id, { fanout: true, dryRun: true, maxParallel: 1 }).maxParallel, 1)
  assert.equal(runTestCases(store, task.id, { fanout: true, dryRun: true, maxParallel: 16 }).maxParallel, 16)
  assert.equal(runTestCases(store, task.id, { fanout: true, dryRun: true }).maxParallel, 4, '缺省 4')
})

// ---------- 收尾：每条报告独立解析，互不污染 ----------

test('fanout 收尾：每个 run 只回写自己的那条报告，一条 fail 不影响另一条 pass', async (t) => {
  const { tmp, store, task } = await setup()
  t.after(() => tmp.cleanup())
  const { runTestCases } = await import('../server/ops.mjs')
  store.createTestCase(task.id, { name: 'A', prompt: '跑 A' })
  store.createTestCase(task.id, { name: 'B', prompt: '跑 B' })
  const dir = agentDir(t)

  const out = runTestCases(store, task.id, { agent: 'echo', cwd: dir, fanout: true })
  const byName = new Map(out.tasks.map((x) => [x.name, x]))

  // 模拟两个任务各自跑完并各自给出结论
  store.appendAgentRunOutput(byName.get('A').runId, 'A: PASS - 全绿\n')
  store.finishAgentRun(byName.get('A').runId, { status: 'success', exitCode: 0 })
  store.appendAgentRunOutput(byName.get('B').runId, 'B: FAIL - 断言挂了\n')
  store.finishAgentRun(byName.get('B').runId, { status: 'success', exitCode: 0 })

  assert.equal(store.getTestReport(byName.get('A').reportId).status, 'pass')
  assert.equal(store.getTestReport(byName.get('B').reportId).status, 'fail')
  // A 的输出里没有 B 的结论，也不会被 B 的 FAIL 带偏
  assert.match(store.getTestReport(byName.get('A').reportId).summary, /全绿/)
})

test('fanout：取消一条 run 只收尾它自己的报告，另一条不受影响（可单独操作）', async (t) => {
  const { tmp, store, task } = await setup()
  t.after(() => tmp.cleanup())
  const { runTestCases } = await import('../server/ops.mjs')
  store.createTestCase(task.id, { name: 'A', prompt: 'p' })
  store.createTestCase(task.id, { name: 'B', prompt: 'p' })
  const dir = agentDir(t)

  const out = runTestCases(store, task.id, { agent: 'echo', cwd: dir, fanout: true })
  const [first, second] = out.tasks
  store.cancelAgentRun(first.runId, { reason: 'manual' })

  assert.equal(store.getTestReport(first.reportId).status, 'cancelled')
  assert.equal(store.getTestReport(second.reportId).status, 'running', '另一条仍在执行')
  assert.equal(store.getAgentRun(second.runId).status, 'running')
})

// ---------- 报告归属 / 验收口径 ----------

test('fanout：报告挂回用例所属节点，验收报告口径不变', async (t) => {
  const { tmp, store, task } = await setup()
  t.after(() => tmp.cleanup())
  const { runTestCases } = await import('../server/ops.mjs')
  store.createTestCase(task.id, { name: 'A', prompt: 'p' })
  store.createTestCase(task.id, { name: 'B', prompt: 'p' })
  const dir = agentDir(t)

  const out = runTestCases(store, task.id, { agent: 'echo', cwd: dir, fanout: true })
  for (const r of out.reports) assert.equal(r.nodeId, task.id)
  const acceptance = store.buildAcceptanceReport(task.id)
  assert.equal(acceptance.totals.cases, 2)
  assert.equal(acceptance.totals.running, 2, 'fan-out 后两条都算执行中')
  assert.equal(acceptance.passRate, null, '刚派单时通过率为 null 而非 0')
})

// ---------- 无用例 ----------

test('fanout：无用例时报错（与 grouped 同口径）', async (t) => {
  const { tmp, store, task } = await setup()
  t.after(() => tmp.cleanup())
  const { runTestCases } = await import('../server/ops.mjs')
  assert.throws(() => runTestCases(store, task.id, { fanout: true, dryRun: true }), /没有可执行的测试用例/)
})

// ---------- 三入口 1:1 ----------

test('fanout：HTTP /api/nodes/:id/test-runs 透传 fanout 与 maxParallel', async (t) => {
  const tmp = await tempHome()
  const db = tmp.openDb()
  const { createStore } = tmp.store
  const store = createStore(db)
  const { createApp } = await import('../server/http.mjs')
  const app = createApp({ store })
  const server = await new Promise((resolve, reject) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s))
    s.once('error', reject)
  })
  t.after(() => {
    server.close()
    tmp.cleanup()
  })
  const base = `http://127.0.0.1:${server.address().port}`

  const p = store.createNode({ type: 'project', name: 'P' })
  const r = store.createNode({ parentId: p.id, type: 'requirement', name: 'R' })
  store.createTestCase(r.id, { name: 'A', prompt: 'p' })
  store.createTestCase(r.id, { name: 'B', prompt: 'p' })

  const res = await fetch(`${base}/api/nodes/${r.id}/test-runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fanout: true, dryRun: true, maxParallel: 8 })
  })
  assert.equal(res.status, 201)
  const body = await res.json()
  assert.equal(body.mode, 'fanout')
  assert.equal(body.maxParallel, 8)
  assert.equal(body.tasks.length, 2)

  // 护栏经由 HTTP 也返回 VALIDATION_FAILED（不是 500）
  const over = await fetch(`${base}/api/nodes/${r.id}/test-runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fanout: true, dryRun: true, maxParallel: 1 })
  })
  assert.equal(over.status, 400)
  const overBody = await over.json()
  assert.equal(overBody.error.code, 'VALIDATION_FAILED')
})

test('fanout 缺陷2回归：HTTP 对非 number maxParallel 一律 400 VALIDATION_FAILED（含 grouped）', async (t) => {
  const tmp = await tempHome()
  const store = tmp.store.createStore(tmp.openDb())
  const { createApp } = await import('../server/http.mjs')
  const app = createApp({ store })
  const server = await new Promise((resolve, reject) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s))
    s.once('error', reject)
  })
  t.after(() => {
    server.close()
    tmp.cleanup()
  })
  const base = `http://127.0.0.1:${server.address().port}`
  const p = store.createNode({ type: 'project', name: 'P' })
  const r = store.createNode({ parentId: p.id, type: 'requirement', name: 'R' })
  store.createTestCase(r.id, { name: 'A', prompt: 'p' })

  const post = (payload) =>
    fetch(`${base}/api/nodes/${r.id}/test-runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(async (res) => ({ status: res.status, body: await res.json() }))

  for (const bad of [true, '4', [1], '1e1', '0x10', 1.5]) {
    const fan = await post({ fanout: true, dryRun: true, maxParallel: bad })
    assert.equal(fan.status, 400, `fanout maxParallel=${JSON.stringify(bad)}`)
    assert.equal(fan.body.error.code, 'VALIDATION_FAILED')
    // grouped 分支同样不能静默忽略
    const grouped = await post({ dryRun: true, maxParallel: bad })
    assert.equal(grouped.status, 400, `grouped maxParallel=${JSON.stringify(bad)}`)
    assert.equal(grouped.body.error.code, 'VALIDATION_FAILED')
  }
  assert.equal(store.listAgentRuns(r.id).length, 0)
})

test('fanout 缺陷2回归：MCP 对非 number maxParallel 返回 isError + VALIDATION_FAILED，不泄漏 -32602', async (t) => {
  const tmp = await tempHome()
  const store = tmp.store.createStore(tmp.openDb())
  const { createMcpServer } = await import('../server/mcp.mjs')
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js')
  const server = createMcpServer({ store })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: 'taskboard-fanout-type', version: '1.0.0' })
  await client.connect(clientTransport)
  t.after(async () => {
    await client.close()
    await server.close()
    tmp.cleanup()
  })

  const p = store.createNode({ type: 'project', name: 'P' })
  const r = store.createNode({ parentId: p.id, type: 'requirement', name: 'R' })
  store.createTestCase(r.id, { name: 'A', prompt: 'p' })

  for (const bad of [true, '4', [1], 1.5]) {
    const out = await client.callTool({
      name: 'test_run',
      arguments: { node: r.id, fanout: true, dryRun: true, maxParallel: bad }
    })
    assert.equal(out.isError, true, `maxParallel=${JSON.stringify(bad)} 应当 isError`)
    assert.match(out.content[0].text, /VALIDATION_FAILED/)
    assert.ok(!/MCP error -32602/.test(out.content[0].text), '不得泄漏 SDK -32602')
  }
})

test('fanout：MCP test_run 暴露 fanout / maxParallel 且与 ops 结果一致', async (t) => {
  const tmp = await tempHome()
  const store = tmp.store.createStore(tmp.openDb())
  const { createMcpServer } = await import('../server/mcp.mjs')
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js')
  const server = createMcpServer({ store })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: 'taskboard-test-fanout', version: '1.0.0' })
  await client.connect(clientTransport)
  t.after(async () => {
    await client.close()
    await server.close()
    tmp.cleanup()
  })

  const p = store.createNode({ type: 'project', name: 'P' })
  const r = store.createNode({ parentId: p.id, type: 'requirement', name: 'R' })
  store.createTestCase(r.id, { name: 'A', prompt: 'p' })
  store.createTestCase(r.id, { name: 'B', prompt: 'p' })

  const dry = await client.callTool({ name: 'test_run', arguments: { node: r.id, fanout: true, dryRun: true } })
  assert.equal(dry.isError, undefined)
  const viaMcp = JSON.parse(dry.content[0].text)
  assert.equal(viaMcp.mode, 'fanout')
  assert.equal(viaMcp.tasks.length, 2)

  // 护栏错误经 MCP 变成 isError + VALIDATION_FAILED，而不是泄漏 SDK 错误
  const over = await client.callTool({
    name: 'test_run',
    arguments: { node: r.id, fanout: true, dryRun: true, maxParallel: 1 }
  })
  assert.equal(over.isError, true)
  assert.match(over.content[0].text, /VALIDATION_FAILED/)
})
