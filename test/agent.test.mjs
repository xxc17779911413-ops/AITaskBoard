import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { tempHome } from './helpers.mjs'

const WORKER = fileURLToPath(new URL('../scripts/append-message-worker.mjs', import.meta.url))

async function setup() {
  const tmp = await tempHome()
  const db = tmp.openDb()
  const store = tmp.store.createStore(db)
  const agent = await import('../server/agent.mjs')
  return { tmp, store, agent }
}

function makeTask(store) {
  const p = store.createNode({ type: 'project', name: 'P' })
  const r = store.createNode({ parentId: p.id, type: 'requirement', name: 'R' })
  const s = store.createNode({ parentId: r.id, type: 'subreq', name: 'S' })
  const t = store.createNode({ parentId: s.id, type: 'task', name: 'T' })
  return { s, t }
}

async function waitRun(store, runId, timeoutMs = 5000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const r = store.getAgentRun(runId)
    if (r.status !== 'running') return r
    await new Promise((res) => setTimeout(res, 80))
  }
  throw new Error('agent run 未在预期时间内完成')
}

test('agent run：执行成功、输出落库、exitCode 记录', async (t) => {
  const { tmp, store, agent } = await setup()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-agent-'))
  t.after(() => {
    tmp.cleanup()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  const { t: task } = makeTask(store)
  store.addRepo({ name: 'demo', localPath: dir })
  store.addCommit(task.id, { repo: 'demo', sha: 'abcdef1' })

  const run = agent.startAgentRun(store, task.id, { prompt: '验证链路', agent: 'echo', cwd: dir })
  assert.equal(run.status, 'running')
  assert.equal(run.agent, 'echo')
  assert.equal(run.cwd, dir)

  const done = await waitRun(store, run.id)
  assert.equal(done.status, 'success')
  assert.equal(done.exitCode, 0)
  assert.ok(done.output.includes('验证链路'))
  assert.ok(done.finishedAt)
})

test('agent run：cwd 缺省时自动推导自节点提交关联的仓库', async (t) => {
  const { tmp, store, agent } = await setup()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-agent-'))
  t.after(() => {
    tmp.cleanup()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  const { t: task } = makeTask(store)
  store.addRepo({ name: 'demo', localPath: dir })
  store.addCommit(task.id, { repo: 'demo', sha: 'abcdef1' })

  assert.equal(agent.resolveRunCwd(store, task.id), dir)
  const run = agent.startAgentRun(store, task.id, { prompt: 'x', agent: 'echo' })
  assert.equal(run.cwd, dir)
  await waitRun(store, run.id)
})

test('agent run：无可用 cwd 或空 prompt → VALIDATION_FAILED', async (t) => {
  const { tmp, store, agent } = await setup()
  t.after(() => tmp.cleanup())
  const { t: task } = makeTask(store)

  assert.throws(
    () => agent.startAgentRun(store, task.id, { prompt: '没有仓库' }),
    (e) => e.code === 'VALIDATION_FAILED'
  )

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-agent-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  assert.throws(
    () => agent.startAgentRun(store, task.id, { prompt: '   ', cwd: dir }),
    (e) => e.code === 'VALIDATION_FAILED'
  )
})

test('agent runs：历史按时间倒序、含状态与输出', async (t) => {
  const { tmp, store, agent } = await setup()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-agent-'))
  t.after(() => {
    tmp.cleanup()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  const { t: task } = makeTask(store)

  const r1 = agent.startAgentRun(store, task.id, { prompt: '第一次', agent: 'echo', cwd: dir })
  await waitRun(store, r1.id)
  const r2 = agent.startAgentRun(store, task.id, { prompt: '第二次', agent: 'echo', cwd: dir })
  await waitRun(store, r2.id)

  const list = store.listAgentRuns(task.id)
  assert.equal(list.length, 2)
  assert.equal(list[0].id, r2.id) // 倒序
  assert.equal(list[0].status, 'success')
  assert.ok(list[0].output.includes('第二次'))
})

// ---------- 运行时 / 会话 / 任务模型（对齐 multica） ----------

test('runtime：upsert 幂等（daemonId + provider），心跳刷新，离线降级', async (t) => {
  const { tmp, store } = await setup()
  t.after(() => tmp.cleanup())

  const r1 = store.upsertRuntime({ name: 'A', daemonId: 'host1', provider: 'qodercli' })
  assert.equal(r1.status, 'online')
  assert.ok(r1.lastSeenAt)
  // 同一 daemon+provider 再注册 → 同一行，不新建
  const r2 = store.upsertRuntime({ name: 'A2', daemonId: 'host1', provider: 'qodercli' })
  assert.equal(r2.id, r1.id)
  assert.equal(r2.name, 'A2')
  assert.equal(store.listRuntimes().length, 1)

  // 不同 provider → 另一行
  store.upsertRuntime({ name: 'B', daemonId: 'host1', provider: 'echo' })
  assert.equal(store.listRuntimes().length, 2)

  // 手动置 offline
  const off = store.setRuntimeStatus(r1.id, 'offline')
  assert.equal(off.status, 'offline')
  // 心跳恢复 online 并刷新 last_seen_at
  const beat = store.heartbeatRuntime(r1.id)
  assert.equal(beat.status, 'online')
  assert.ok(beat.lastSeenAt >= r1.lastSeenAt)

  // 缺 daemonId → VALIDATION_FAILED
  assert.throws(() => store.upsertRuntime({ name: 'X', provider: 'p' }), (e) => e.code === 'VALIDATION_FAILED')
})

test('runtime：summary 统计在线数与活跃任务', async (t) => {
  const { tmp, store, agent } = await setup()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-agent-'))
  t.after(() => {
    tmp.cleanup()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  const { t: task } = makeTask(store)
  const rt = agent.ensureLocalRuntime(store, 'echo')
  const s = store.agentRuntimeSummary()
  assert.equal(s.online, 1)
  assert.ok(s.runtimes >= 1)

  const run = agent.startAgentRun(store, task.id, { prompt: 'x', agent: 'echo', cwd: dir })
  assert.equal(run.runtimeId, rt.id)
  await waitRun(store, run.id)
  assert.equal(store.agentRuntimeSummary().activeRuns, 0)
})

test('runtime：有未完成任务时禁止删除；删除后历史任务解绑保留', async (t) => {
  const { tmp, store } = await setup()
  t.after(() => tmp.cleanup())
  const { t: task } = makeTask(store)
  const rt = store.upsertRuntime({ name: 'R', daemonId: 'h', provider: 'p' })
  const run = store.createAgentRun(task.id, { prompt: 'p', runtimeId: rt.id, cwd: '/tmp' })
  assert.throws(() => store.deleteRuntime(rt.id), (e) => e.code === 'VALIDATION_FAILED')

  store.finishAgentRun(run.id, { status: 'success' })
  const del = store.deleteRuntime(rt.id)
  assert.equal(del.ok, true)
  assert.equal(store.listRuntimes().length, 0)
  // 历史任务仍在，只是 runtime 引用被解绑
  const kept = store.getAgentRun(run.id)
  assert.equal(kept.runtimeId, null)
})

test('session：ensure 幂等复用同一活动会话，new 强制新会话', async (t) => {
  const { tmp, store } = await setup()
  t.after(() => tmp.cleanup())
  const { t: task } = makeTask(store)

  const s1 = store.ensureAgentSession(task.id, { agent: 'qodercli' })
  const s2 = store.ensureAgentSession(task.id, { agent: 'qodercli' })
  assert.equal(s2.id, s1.id)
  assert.equal(s1.status, 'active')

  const s3 = store.createAgentSession(task.id, { agent: 'qodercli' })
  assert.notEqual(s3.id, s1.id)
  assert.equal(store.listAgentSessions(task.id).length, 2)

  // 归档后 ensure 会新建（不再复用已归档会话）
  store.archiveAgentSession(s1.id)
  store.archiveAgentSession(s3.id)
  const s4 = store.ensureAgentSession(task.id, { agent: 'qodercli' })
  assert.notEqual(s4.id, s1.id)
  assert.equal(store.listAgentSessions(task.id, { status: 'archived' }).length, 2)
})

test('run：缺省自动挂活动会话；runCount / lastActivityAt 随任务递增', async (t) => {
  const { tmp, store } = await setup()
  t.after(() => tmp.cleanup())
  const { t: task } = makeTask(store)

  const r1 = store.createAgentRun(task.id, { prompt: '一', cwd: '/tmp' })
  assert.ok(r1.sessionId)
  const r2 = store.createAgentRun(task.id, { prompt: '二', cwd: '/tmp' })
  assert.equal(r2.sessionId, r1.sessionId) // 同一会话

  const s = store.getAgentSession(r1.sessionId)
  assert.equal(s.runCount, 2)
  assert.ok(s.lastActivityAt)
})

test('run：finish 把 cliSessionId/workDir 沉淀到会话（供 --resume 续跑）', async (t) => {
  const { tmp, store } = await setup()
  t.after(() => tmp.cleanup())
  const { t: task } = makeTask(store)

  const r = store.createAgentRun(task.id, { prompt: 'p', cwd: '/tmp/proj' })
  store.finishAgentRun(r.id, { status: 'success', cliSessionId: 'cli-abc-123' })
  const s = store.getAgentSession(r.sessionId)
  assert.equal(s.cliSessionId, 'cli-abc-123')
  assert.equal(s.workDir, '/tmp/proj')

  // 用会话号续跑
  const r2 = store.createAgentRun(task.id, { prompt: '继续', sessionId: s.id, resumed: true })
  assert.equal(r2.resumed, true)
  assert.equal(r2.sessionId, s.id)
})

test('run：消息流按 seq 递增，支持 sinceSeq 增量拉取', async (t) => {
  const { tmp, store } = await setup()
  t.after(() => tmp.cleanup())
  const { t: task } = makeTask(store)
  const r = store.createAgentRun(task.id, { prompt: 'p', cwd: '/tmp' })

  store.appendAgentRunMessage(r.id, { type: 'text', content: '第一行' })
  store.appendAgentRunMessage(r.id, { type: 'tool_use', tool: 'grep', input: { pattern: 'foo' } })
  store.appendAgentRunMessage(r.id, { type: 'error', content: '出错了' })

  const all = store.listAgentRunMessages(r.id)
  assert.equal(all.length, 3)
  assert.deepEqual(all.map((m) => m.seq), [1, 2, 3])
  assert.equal(all[1].tool, 'grep')
  assert.deepEqual(all[1].input, { pattern: 'foo' })

  const inc = store.listAgentRunMessages(r.id, { sinceSeq: 2 })
  assert.equal(inc.length, 1)
  assert.equal(inc[0].seq, 3)
})

test('run：多进程并发追加消息不撞号，seq 连续且无重复', async (t) => {
  const { tmp, store } = await setup()
  t.after(() => tmp.cleanup())
  const { t: task } = makeTask(store)
  const dbFile = path.join(tmp.dir, 'data.db')
  const r = store.createAgentRun(task.id, { prompt: 'p', cwd: '/tmp' })

  // 4 个独立进程各写 25 条 = 100 条；修复前「读 MAX + 写」会撞 UNIQUE(run_id, seq)
  const workers = ['w0', 'w1', 'w2', 'w3'].map(
    (label) =>
      new Promise((resolve) => {
        const p = spawn(process.execPath, [WORKER, dbFile, String(r.id), '25', label], { stdio: ['ignore', 'ignore', 'pipe'] })
        let err = ''
        p.stderr.on('data', (d) => (err += d))
        p.on('close', (code) => resolve({ code, err }))
      })
  )
  const results = await Promise.all(workers)
  for (const res of results) assert.equal(res.code, 0, `并发 worker 失败：${res.err}`)

  const db2 = tmp.openDb(dbFile)
  const store2 = tmp.store.createStore(db2)
  const msgs = store2.listAgentRunMessages(r.id)
  assert.equal(msgs.length, 100)
  assert.deepEqual(msgs.map((m) => m.seq), Array.from({ length: 100 }, (_, i) => i + 1))
  assert.equal(new Set(msgs.map((m) => m.content)).size, 100)
  db2.close()
})

test('run：取消把未结束任务置 cancelled；已结束任务保持原状', async (t) => {
  const { tmp, store } = await setup()
  t.after(() => tmp.cleanup())
  const { t: task } = makeTask(store)

  const r = store.createAgentRun(task.id, { prompt: 'p', cwd: '/tmp' })
  const c = store.cancelAgentRun(r.id, { reason: 'user_cancelled' })
  assert.equal(c.status, 'cancelled')
  assert.equal(c.failureReason, 'user_cancelled')
  assert.ok(c.finishedAt)

  // 已是终态 → 幂等返回，不覆盖
  const again = store.cancelAgentRun(r.id)
  assert.equal(again.status, 'cancelled')
  assert.equal(again.failureReason, 'user_cancelled')
})

test('run：重试新建 attempt+1 子任务并指向原任务；未结束不能重试', async (t) => {
  const { tmp, store } = await setup()
  t.after(() => tmp.cleanup())
  const { t: task } = makeTask(store)

  const r = store.createAgentRun(task.id, { prompt: '做某事', cwd: '/tmp' })
  assert.throws(() => store.retryAgentRun(r.id), (e) => e.code === 'VALIDATION_FAILED')

  store.finishAgentRun(r.id, { status: 'failed', failureReason: 'agent_error.nonzero_exit' })
  const r2 = store.retryAgentRun(r.id)
  assert.equal(r2.attempt, 2)
  assert.equal(r2.parentRunId, r.id)
  assert.equal(r2.sessionId, r.sessionId) // 同一会话
  assert.equal(r2.prompt, '做某事')
})

test('run：max_attempts 是硬上限——用满最后一次尝试后重试被拒绝', async (t) => {
  const { tmp, store } = await setup()
  t.after(() => tmp.cleanup())
  const { t: task } = makeTask(store)

  // maxAttempts=2：首次 + 1 次重试
  const r1 = store.createAgentRun(task.id, { prompt: 'p', cwd: '/tmp', maxAttempts: 2 })
  assert.equal(r1.attempt, 1)
  assert.equal(r1.maxAttempts, 2)

  store.finishAgentRun(r1.id, { status: 'failed', failureReason: 'timeout' })
  const r2 = store.retryAgentRun(r1.id)
  assert.equal(r2.attempt, 2)
  assert.equal(r2.maxAttempts, 2) // 上限沿重试链继承，不被重置

  store.finishAgentRun(r2.id, { status: 'failed', failureReason: 'timeout' })
  assert.throws(
    () => store.retryAgentRun(r2.id),
    (e) => e.code === 'VALIDATION_FAILED' && e.details.attempt === 2 && e.details.maxAttempts === 2
  )
  // 拒绝后不落库：仍只有两条记录
  assert.equal(store.listAgentRuns(task.id).length, 2)
})

test('run：显式 maxAttempts=1 时首次重试即被拒绝', async (t) => {
  const { tmp, store } = await setup()
  t.after(() => tmp.cleanup())
  const { t: task } = makeTask(store)
  const r = store.createAgentRun(task.id, { prompt: 'p', cwd: '/tmp', maxAttempts: 1 })
  store.finishAgentRun(r.id, { status: 'failed', failureReason: 'agent_error.nonzero_exit' })
  assert.throws(() => store.retryAgentRun(r.id), (e) => e.code === 'VALIDATION_FAILED')
})

test('run：默认 maxAttempts=3，可重试到 attempt=3 后拒绝', async (t) => {
  const { tmp, store } = await setup()
  t.after(() => tmp.cleanup())
  const { t: task } = makeTask(store)
  const r1 = store.createAgentRun(task.id, { prompt: 'p', cwd: '/tmp' })
  assert.equal(r1.maxAttempts, 3)
  store.finishAgentRun(r1.id, { status: 'failed', failureReason: 'timeout' })
  const r2 = store.retryAgentRun(r1.id)
  store.finishAgentRun(r2.id, { status: 'failed', failureReason: 'timeout' })
  const r3 = store.retryAgentRun(r2.id)
  assert.equal(r3.attempt, 3)
  store.finishAgentRun(r3.id, { status: 'failed', failureReason: 'timeout' })
  assert.throws(() => store.retryAgentRun(r3.id), (e) => e.code === 'VALIDATION_FAILED')
})

// ---------- 重试边界（独立测试缺陷 1）：用例报告必须随 child run 刷新 ----------

function makeTaskWithCase(store) {
  const { t } = makeTask(store)
  const c = store.createTestCase(t.id, { name: 'A', prompt: 'p' })
  return { t, c }
}

test('重试缺陷1回归：重试为同一用例随 child run 开新 running 报告，旧结论保留为历史', async (t) => {
  const { tmp, store } = await setup()
  t.after(() => tmp.cleanup())
  const { t: task, c } = makeTaskWithCase(store)

  const r1 = store.createAgentRun(task.id, { prompt: 'x', agent: 'echo', cwd: '/tmp' })
  const rep1 = store.createTestReport(task.id, { caseId: c.id, runId: r1.id, kind: 'regression', status: 'running' })
  store.finishAgentRun(r1.id, { status: 'failed', failureReason: 'agent_error.nonzero_exit' })
  assert.equal(store.getTestReport(rep1.id).status, 'error', '父 run 失败 → 报告 error')

  const r2 = store.retryAgentRun(r1.id)
  const reports = store.listTestReports(task.id, {})
  assert.equal(reports.length, 2, '重试后应为该用例多开一条报告（旧结论 + 新执行）')
  const childReport = reports.find((x) => x.runId === r2.id)
  assert.ok(childReport, '必须存在挂在 child run 上的报告')
  assert.equal(childReport.status, 'running', 'child 报告初始为 running')
  assert.equal(childReport.caseId, c.id, '仍绑定同一用例')
  // 旧报告不被原地改写（保留历史）
  assert.equal(store.getTestReport(rep1.id).status, 'error')
})

test('重试缺陷1回归：child run 落终态刷新该用例报告，验收报告取到重试后的结论', async (t) => {
  const { tmp, store } = await setup()
  t.after(() => tmp.cleanup())
  const { t: task, c } = makeTaskWithCase(store)

  const r1 = store.createAgentRun(task.id, { prompt: 'x', agent: 'echo', cwd: '/tmp' })
  store.createTestReport(task.id, { caseId: c.id, runId: r1.id, kind: 'regression', status: 'running' })
  store.finishAgentRun(r1.id, { status: 'failed', failureReason: 'agent_error.nonzero_exit' })
  assert.equal(store.buildAcceptanceReport(task.id).items[0].latestStatus, 'error')

  const r2 = store.retryAgentRun(r1.id)
  // 模拟 child 重试成功并给出结论
  store.appendAgentRunOutput(r2.id, 'A: PASS - 重试后恢复\n')
  store.finishAgentRun(r2.id, { status: 'success', exitCode: 0 })

  const childReport = store.listTestReports(task.id, {}).find((x) => x.runId === r2.id)
  assert.equal(store.getTestReport(childReport.id).status, 'pass', 'child 报告随 child 终态刷新为 pass')
  assert.equal(store.getTestReport(childReport.id).autoFinalized, true)
  // 验收报告按「最近一条」取，落到重试后的结论
  const acceptance = store.buildAcceptanceReport(task.id)
  assert.equal(acceptance.items[0].latestStatus, 'pass')
  assert.equal(acceptance.items[0].latestReportId, childReport.id)
  assert.equal(acceptance.totals.cases, 1, '仍只有一条用例（不是把历史报告当新用例）')
})

test('重试缺陷1回归：不带用例报告的普通任务重试不凭空造报告', async (t) => {
  const { tmp, store } = await setup()
  t.after(() => tmp.cleanup())
  const { t: task } = makeTask(store)
  const r1 = store.createAgentRun(task.id, { prompt: 'p', cwd: '/tmp' })
  store.finishAgentRun(r1.id, { status: 'failed' })
  const r2 = store.retryAgentRun(r1.id)
  assert.equal(r2.attempt, 2)
  assert.equal(store.listTestReports(task.id, {}).length, 0, '普通 agent 任务重试不建报告')
})

test('重试缺陷1回归：重试建 child run + 随 child 报告只递增一次 revision', async (t) => {
  const { tmp, store } = await setup()
  t.after(() => tmp.cleanup())
  const { t: task, c } = makeTaskWithCase(store)
  const r1 = store.createAgentRun(task.id, { prompt: 'x', agent: 'echo', cwd: '/tmp' })
  store.createTestReport(task.id, { caseId: c.id, runId: r1.id, kind: 'regression', status: 'running' })
  store.finishAgentRun(r1.id, { status: 'failed' })

  const before = store.getRevision()
  store.retryAgentRun(r1.id)
  assert.equal(store.getRevision(), before + 1, '组合写入（child run + 报告）应只 +1')
})

test('重试缺陷1回归：多条用例共用一条 run（grouped）时，重试为每条用例各开一条 child 报告', async (t) => {
  const { tmp, store } = await setup()
  t.after(() => tmp.cleanup())
  const { t: task } = makeTask(store)
  const a = store.createTestCase(task.id, { name: 'A', prompt: 'p' })
  const b = store.createTestCase(task.id, { name: 'B', prompt: 'p' })
  const r1 = store.createAgentRun(task.id, { prompt: 'x', agent: 'echo', cwd: '/tmp' })
  store.createTestReport(task.id, { caseId: a.id, runId: r1.id })
  store.createTestReport(task.id, { caseId: b.id, runId: r1.id })
  store.finishAgentRun(r1.id, { status: 'failed' })

  const r2 = store.retryAgentRun(r1.id)
  const childReports = store.listTestReports(task.id, {}).filter((x) => x.runId === r2.id)
  assert.equal(childReports.length, 2, '两条用例各开一条 child 报告')
  assert.deepEqual(childReports.map((x) => x.caseId).sort(), [a.id, b.id].sort())
})

test('run：失败原因分类落库并可查询', async (t) => {
  const { tmp, store } = await setup()
  t.after(() => tmp.cleanup())
  const { t: task } = makeTask(store)
  const r = store.createAgentRun(task.id, { prompt: 'p', cwd: '/tmp' })
  const done = store.finishAgentRun(r.id, { status: 'failed', failureReason: 'timeout', exitCode: 1 })
  assert.equal(done.failureReason, 'timeout')
  assert.equal(done.exitCode, 1)
})

test('run：服务重启把残留 running 置 failed（runtime_recovery）并把运行时置离线', async (t) => {
  const { tmp, store } = await setup()
  t.after(() => tmp.cleanup())
  const { t: task } = makeTask(store)
  store.upsertRuntime({ name: 'R', daemonId: 'h', provider: 'p' })
  const r = store.createAgentRun(task.id, { prompt: 'p', cwd: '/tmp' })

  const res = store.failStaleAgentRuns()
  assert.equal(res.cleared, 1)
  const after = store.getAgentRun(r.id)
  assert.equal(after.status, 'failed')
  assert.equal(after.failureReason, 'runtime_recovery')
  assert.equal(store.listRuntimes()[0].status, 'offline')
})

test('run：latestAgentRun 返回最近一次（供「继续上次会话」）', async (t) => {
  const { tmp, store } = await setup()
  t.after(() => tmp.cleanup())
  const { t: task } = makeTask(store)
  assert.equal(store.latestAgentRun(task.id), null)
  const r1 = store.createAgentRun(task.id, { prompt: '一', cwd: '/tmp' })
  const r2 = store.createAgentRun(task.id, { prompt: '二', cwd: '/tmp' })
  assert.equal(store.latestAgentRun(task.id).id, r2.id)
  assert.equal(store.latestAgentRun(task.id, { agent: 'nope' }), null)
  assert.equal(store.latestAgentRun(task.id, { agent: 'qodercli' }).id, r2.id)
})

test('retryAndDispatch：后台任务重试会真正重新执行并跑完', async (t) => {
  const { tmp, store, agent } = await setup()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-agent-retry-'))
  t.after(() => {
    tmp.cleanup()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  const { t: task } = makeTask(store)
  store.addRepo({ name: 'demo', localPath: dir })

  const run = agent.startAgentRun(store, task.id, { prompt: '第一次', agent: 'echo', cwd: dir })
  await waitRun(store, run.id)

  const retried = agent.retryAndDispatch(store, run.id)
  assert.equal(retried.attempt, 2)
  assert.equal(retried.parentRunId, run.id)
  // 立刻拉起子进程：应在预期时间内跑到终态，而不是卡在 running
  const done = await waitRun(store, retried.id)
  assert.equal(done.status, 'success')
  assert.ok(done.output.includes('第一次'))
})

test('retryAndDispatch：运行目录不可用时置 failed（environment_prepare_failed）', async (t) => {
  const { tmp, store, agent } = await setup()
  t.after(() => tmp.cleanup())
  const { t: task } = makeTask(store)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-agent-gone-'))
  const run = store.createAgentRun(task.id, { prompt: 'p', agent: 'echo', cwd: dir })
  store.finishAgentRun(run.id, { status: 'failed', failureReason: 'agent_error.nonzero_exit' })
  fs.rmSync(dir, { recursive: true, force: true })

  const retried = agent.retryAndDispatch(store, run.id)
  assert.equal(retried.status, 'failed')
  assert.equal(retried.failureReason, 'environment_prepare_failed')
})

test('retryAndDispatch：前台（qoder-ide）任务只重建记录、不 spawn', async (t) => {
  const { tmp, store, agent } = await setup()
  t.after(() => tmp.cleanup())
  const { t: task } = makeTask(store)
  const run = store.createAgentRun(task.id, { prompt: 'p', agent: 'qoder-ide', cwd: null })
  store.finishAgentRun(run.id, { status: 'success' })

  const retried = agent.retryAndDispatch(store, run.id)
  assert.equal(retried.agent, 'qoder-ide')
  assert.equal(retried.status, 'running') // 等 IDE 回写
  assert.equal(retried.attempt, 2)
})
