import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { tempHome } from './helpers.mjs'

/** 临时 git 仓库 + 一个含高危硬编码凭据新增行的提交（代码检查用例共用） */
function makeAuditRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'taskboard-codeaudit-http-'))
  const dir = path.join(root, 'work')
  fs.mkdirSync(dir)
  const g = (args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' })
  g(['init', '-q', '-b', 'main'])
  g(['config', 'user.email', 't@t.local'])
  g(['config', 'user.name', 't'])
  fs.writeFileSync(path.join(dir, 'base.js'), 'export const a = 1\n')
  g(['add', '.'])
  g(['commit', '-q', '-m', 'init'])
  fs.writeFileSync(path.join(dir, 'x.js'), 'const token = "abcdefghijkl"\n')
  g(['add', '.'])
  g(['commit', '-q', '-m', 'risky'])
  return { root, dir, sha: g(['rev-parse', 'HEAD']).trim() }
}

async function setup() {
  const tmp = await tempHome()
  const db = tmp.openDb()
  const { createStore } = tmp.store
  const store = createStore(db)
  const { createApp } = await import('../server/http.mjs')
  const app = createApp({ store })
  let server
  const base = (await new Promise((resolve, reject) => {
    server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      resolve(`http://127.0.0.1:${addr.port}`)
    })
    server.once('error', reject)
  }))
  const get = (p) => fetch(`${base}${p}`).then((r) => r.json())
  const post = (p, body) => fetch(`${base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json())
  const patch = (p, body) => fetch(`${base}${p}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json())
  const del = (p, body) => fetch(`${base}${p}`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json())
  const close = () => new Promise((r) => server.close(r))
  const cleanup = () => { close(); tmp.cleanup() }
  // 带状态码的原始请求（用于断言 4xx/5xx 契约，而不是只断言 body.code）
  const raw = (method, p, body) =>
    fetch(`${base}${p}`, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    }).then(async (r) => ({ status: r.status, body: await r.json() }))
  return { tmp, store, base, get, post, patch, del, raw, close, cleanup }
}

// ---------- 健康 / schema / revision ----------

test('GET /api/health', async () => {
  const { tmp, get, close } = await setup()
  const r = await get('/api/health')
  assert.equal(r.ok, true)
  assert.ok(typeof r.revision === 'number')
  await close()
  tmp.cleanup()
})

test('GET /api/schema', async () => {
  const { tmp, get, close } = await setup()
  const r = await get('/api/schema')
  assert.ok(Array.isArray(r.nodeTypes))
  assert.ok(Array.isArray(r.tools))
  assert.ok(r.tools.includes('schema'))
  await close()
  tmp.cleanup()
})

test('GET /api/revision', async () => {
  const { tmp, get, close } = await setup()
  const r = await get('/api/revision')
  assert.ok(typeof r.revision === 'number')
  await close()
  tmp.cleanup()
})

// ---------- 节点 CRUD ----------

test('POST /api/nodes 创建项目', async () => {
  const { tmp, post, get, close } = await setup()
  const r = await post('/api/nodes', { type: 'project', name: '测试项目' })
  assert.equal(r.type, 'project')
  assert.equal(r.name, '测试项目')
  const tree = await get('/api/tree')
  assert.equal(tree.nodes.length, 1)
  await close()
  tmp.cleanup()
})

test('POST /api/nodes 父子校验失败返回 400', async () => {
  const { tmp, post, close } = await setup()
  const r = await post('/api/nodes', { type: 'task', name: '孤任务' }) // task 不能是根
  assert.ok(r.error)
  assert.equal(r.error.code, 'PARENT_TYPE_INVALID')
  await close()
  tmp.cleanup()
})

test('PATCH /api/nodes/:id 更新节点', async () => {
  const { tmp, post, patch, close } = await setup()
  const p = await post('/api/nodes', { type: 'project', name: 'P' })
  const u = await patch(`/api/nodes/${p.id}`, { name: 'P-改', status: 'doing' })
  assert.equal(u.name, 'P-改')
  assert.equal(u.status, 'doing')
  await close()
  tmp.cleanup()
})

test('DELETE /api/nodes/:id 需要 confirm', async () => {
  const { tmp, post, del, close } = await setup()
  const p = await post('/api/nodes', { type: 'project', name: 'P' })
  const r = await del(`/api/nodes/${p.id}`, { confirm: false })
  assert.equal(r.error.code, 'CONFIRM_REQUIRED')
  await close()
  tmp.cleanup()
})

test('DELETE /api/nodes/:id 带 confirm 正常删除', async () => {
  const { tmp, post, del, get, close } = await setup()
  const p = await post('/api/nodes', { type: 'project', name: 'P' })
  await del(`/api/nodes/${p.id}`, { confirm: true })
  const tree = await get('/api/tree')
  assert.equal(tree.nodes.length, 0)
  await close()
  tmp.cleanup()
})

// ---------- 文档 ----------

test('POST /api/nodes/:id/documents 与 upsert', async () => {
  const { tmp, post, get, close } = await setup()
  const p = await post('/api/nodes', { type: 'project', name: 'P' })
  // 先创建一个新文档
  const d = await post(`/api/nodes/${p.id}/documents`, { name: '备注', content: '正文' })
  assert.equal(d.name, '备注')

  // upsert 预置的「描述」文档（项目新建时自动创建），幂等更新内容
  const upsert = await post(`/api/nodes/${p.id}/documents/upsert`, { name: '描述', content: '新正文' })
  assert.equal(upsert.created, false)

  const docs = await get(`/api/nodes/${p.id}/documents`)
  assert.equal(docs.length, 2)
  const desc = docs.find((d) => d.name === '描述')
  assert.equal(desc.content, '新正文')
  await close()
  tmp.cleanup()
})

// ---------- upsert / batch / import ----------

test('POST /api/nodes/upsert 按路径幂等', async () => {
  const { tmp, post, get, close } = await setup()
  const r1 = await post('/api/nodes/upsert', { path: '项目A/需求1' })
  assert.equal(r1.node.name, '需求1')
  assert.equal(r1.steps.length, 2)

  const r2 = await post('/api/nodes/upsert', { path: '项目A/需求1' })
  assert.equal(r2.steps.length, 0)

  const tree = await get('/api/tree')
  assert.equal(tree.nodes[0].children.length, 1)
  await close()
  tmp.cleanup()
})

test('POST /api/batch 批量操作', async () => {
  const { tmp, post, close } = await setup()
  const p = await post('/api/nodes', { type: 'project', name: 'P' })
  const r = await post('/api/batch', {
    ops: [
      { op: 'node.create', parentId: p.id, type: 'requirement', name: 'R1' },
      { op: 'node.create', parentId: p.id, type: 'requirement', name: 'R2' }
    ]
  })
  assert.equal(r.total, 2)
  assert.equal(r.failed, 0)
  await close()
  tmp.cleanup()
})

test('POST /api/import 大纲导入', async () => {
  const { tmp, post, get, close } = await setup()
  const md = '- 项目\n  - 需求A\n    - 子需求1'
  const r = await post('/api/import', { content: md })
  assert.equal(r.count, 3)
  const tree = await get('/api/tree')
  assert.equal(tree.nodes.length, 1)
  assert.equal(tree.nodes[0].children[0].children[0].name, '子需求1')
  await close()
  tmp.cleanup()
})

// ---------- 属性 ----------

test('属性定义 CRUD', async () => {
  const { tmp, post, get, close } = await setup()
  const def = await post('/api/attr-defs', { nodeType: 'requirement', key: 'priority', label: '优先级', dataType: 'text' })
  assert.equal(def.key, 'priority')

  const list = await get('/api/attr-defs')
  assert.ok(list.some((d) => d.key === 'priority'))
  await close()
  tmp.cleanup()
})

// ---------- 仓库 ----------

test('仓库 CRUD', async () => {
  const { tmp, post, get, close } = await setup()
  const repo = await post('/api/repos', { name: 'xp-charge', localPath: '/tmp/test' })
  assert.equal(repo.name, 'xp-charge')

  const list = await get('/api/repos')
  assert.ok(list.some((r) => r.name === 'xp-charge'))
  await close()
  tmp.cleanup()
})

// ---------- commit ----------

test('commit 登记与删除', async () => {
  const { tmp, post, get, close } = await setup()
  await post('/api/repos', { name: 'test-repo' })
  const p = await post('/api/nodes', { type: 'project', name: 'P' })
  const r = await post(`/api/nodes/${p.id}/commits`, { repo: 'test-repo', sha: 'abc1234', note: '测试提交' })
  assert.equal(r.sha, 'abc1234')
  assert.equal(r.created, true)

  // 幂等
  const r2 = await post(`/api/nodes/${p.id}/commits`, { repo: 'test-repo', sha: 'abc1234' })
  assert.equal(r2.created, false)

  const list = await get(`/api/nodes/${p.id}/commits`)
  assert.equal(list.length, 1)
  await close()
  tmp.cleanup()
})

// ---------- 配置 ----------

test('GET /api/config', async () => {
  const { tmp, get, close } = await setup()
  const r = await get('/api/config')
  assert.equal(r.port, 3210)
  await close()
  tmp.cleanup()
})

// ---------- 404 ----------

// ---------- agent 运行时 / 会话 / 任务 ----------

function makeTree(store) {
  const p = store.createNode({ type: 'project', name: 'P' })
  const r = store.createNode({ parentId: p.id, type: 'requirement', name: 'R' })
  const s = store.createNode({ parentId: r.id, type: 'subreq', name: 'S' })
  const t = store.createNode({ parentId: s.id, type: 'task', name: 'T' })
  return t
}

test('运行时：注册 / 列表 / 心跳 / 状态 / 删除', async () => {
  const { tmp, store, get, post, patch, del, close } = await setup()
  const rt = await post('/api/runtimes', { name: 'Host A', daemonId: 'host-a', provider: 'qodercli' })
  assert.equal(rt.status, 'online')

  const list = await get('/api/runtimes')
  assert.equal(list.items.length, 1)
  assert.equal(list.summary.online, 1)

  const beat = await post(`/api/runtimes/${rt.id}/heartbeat`, {})
  assert.equal(beat.status, 'online')

  const off = await patch(`/api/runtimes/${rt.id}`, { status: 'offline' })
  assert.equal(off.status, 'offline')

  const removed = await del(`/api/runtimes/${rt.id}`, {})
  assert.equal(removed.ok, true)
  assert.equal((await get('/api/runtimes')).items.length, 0)

  await close()
  tmp.cleanup()
})

test('会话：新建 / 列表 / 归档', async () => {
  const { tmp, store, post, get, del, close } = await setup()
  const task = makeTree(store)
  const s = await post(`/api/nodes/${task.id}/agent-sessions`, { agent: 'qodercli', title: '第一次评审' })
  assert.equal(s.status, 'active')
  assert.equal(s.runCount, 0)

  const list = await get(`/api/nodes/${task.id}/agent-sessions`)
  assert.equal(list.length, 1)
  assert.equal(list[0].title, '第一次评审')

  const archived = await del(`/api/agent-sessions/${s.id}`, {})
  assert.equal(archived.status, 'archived')

  await close()
  tmp.cleanup()
})

test('任务：派单 echo → 消息流 → 终态；列表与详情一致', async () => {
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const { tmp, store, base, get, close } = await setup()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-http-agent-'))
  const task = makeTree(store)
  store.addRepo({ name: 'demo', localPath: dir })
  store.addCommit(task.id, { repo: 'demo', sha: 'abcdef1' })

  const run = await fetch(`${base}/api/nodes/${task.id}/agent-runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: '验证 HTTP 链路', agent: 'echo', cwd: dir })
  }).then((r) => r.json())
  assert.ok(run.id > 0)
  assert.ok(run.sessionId > 0)
  assert.ok(run.runtimeId > 0) // 自动注册本机运行时

  // 等任务结束
  let done = run
  for (let i = 0; i < 60 && done.status === 'running'; i++) {
    await new Promise((res) => setTimeout(res, 100))
    done = await get(`/api/agent-runs/${run.id}`)
  }
  assert.equal(done.status, 'success')

  const messages = await get(`/api/agent-runs/${run.id}/messages`)
  assert.ok(messages.length > 0)
  assert.deepEqual(messages.map((m) => m.seq).sort((a, b) => a - b), messages.map((m) => m.seq))
  assert.ok(messages.some((m) => (m.content || '').includes('验证 HTTP 链路')))

  const runs = await get(`/api/nodes/${task.id}/agent-runs`)
  assert.equal(runs.length, 1)
  assert.equal(runs[0].status, 'success')

  // 会话沉淀：runCount 与消息流
  const sessions = await get(`/api/nodes/${task.id}/agent-sessions`)
  assert.equal(sessions[0].runCount, 1)

  await close()
  tmp.cleanup()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('任务：取消未结束任务 / 重试已结束任务（attempt+1 指向原任务）', async () => {
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const { tmp, store, get, post, close } = await setup()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-http-retry-'))
  const task = makeTree(store)
  // agent=echo：重试会真的重新执行，可以验证 dispatch 生效（本机未必装了 qodercli）
  const run = store.createAgentRun(task.id, { prompt: 'p', agent: 'echo', cwd: dir })

  const cancelled = await post(`/api/agent-runs/${run.id}/cancel`, { reason: 'user_cancelled' })
  assert.equal(cancelled.status, 'cancelled')

  const retried = await post(`/api/agent-runs/${run.id}/retry`, {})
  assert.equal(retried.attempt, 2)
  assert.equal(retried.parentRunId, run.id)
  assert.equal(retried.sessionId, run.sessionId)

  // 重试会立刻拉起子进程：等它跑完，确认不是卡在 running
  let done = retried
  for (let i = 0; i < 60 && done.status === 'running'; i++) {
    await new Promise((res) => setTimeout(res, 100))
    done = await get(`/api/agent-runs/${retried.id}`)
  }
  assert.equal(done.status, 'success')
  const msgs = await get(`/api/agent-runs/${retried.id}/messages`)
  assert.ok(msgs.length > 0)

  await close()
  tmp.cleanup()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('任务：重试超过 maxAttempts 硬上限时 HTTP 400 拒绝（VALIDATION_FAILED）', async () => {
  const { tmp, store, base, get, post, close } = await setup()
  const task = makeTree(store)
  const run = store.createAgentRun(task.id, { prompt: 'p', agent: 'echo', cwd: '/tmp', maxAttempts: 1 })
  store.finishAgentRun(run.id, { status: 'failed', failureReason: 'timeout' })

  const res = await fetch(`${base}/api/agent-runs/${run.id}/retry`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}'
  })
  assert.equal(res.status, 400)
  const body = await res.json()
  assert.equal(body.error.code, 'VALIDATION_FAILED')
  assert.equal(body.error.details.maxAttempts, 1)

  // 拒绝后不落库
  assert.equal((await get(`/api/nodes/${task.id}/agent-runs`)).length, 1)

  await close()
  tmp.cleanup()
})

test('任务：派单可显式指定 maxAttempts，回读一致', async () => {
  const { tmp, store, post, close } = await setup()
  const task = makeTree(store)
  const run = await post(`/api/nodes/${task.id}/agent-runs`, { prompt: 'p', agent: 'echo', cwd: '/tmp', maxAttempts: 5 })
  assert.equal(run.maxAttempts, 5)

  // 非法值拒绝
  const bad = await post(`/api/nodes/${task.id}/agent-runs`, { prompt: 'p', agent: 'echo', cwd: '/tmp', maxAttempts: 0 })
  assert.equal(bad.error.code, 'VALIDATION_FAILED')

  await close()
  tmp.cleanup()
})

test('任务：回写（PATCH）置终态并沉淀 cliSessionId', async () => {
  const { tmp, store, get, patch, close } = await setup()
  const task = makeTree(store)
  const run = store.createAgentRun(task.id, { prompt: 'p', cwd: '/tmp' })

  const updated = await patch(`/api/agent-runs/${run.id}`, {
    status: 'success',
    output: '结论',
    cliSessionId: 'cli-xyz'
  })
  assert.equal(updated.status, 'success')

  const session = await get(`/api/agent-sessions/${run.sessionId}`)
  assert.equal(session.cliSessionId, 'cli-xyz')

  await close()
  tmp.cleanup()
})

test('未知路由返回 404', async () => {
  const { tmp, get, close } = await setup()
  const r = await get('/api/unknown')
  assert.equal(r.error.code, 'NOT_FOUND')
  await close()
  tmp.cleanup()
})

// ---------- 回归测试闭环 ----------

test('回归闭环：用例 upsert → dryRun → 报告 → 验收报告（HTTP 全链路）', async () => {
  const { tmp, post, get, patch, close } = await setup()
  const p = await post('/api/nodes', { type: 'project', name: 'P' })
  const r = await post('/api/nodes', { parentId: p.id, type: 'requirement', name: 'R' })

  // 用例：按名 upsert 幂等
  const c1 = await post(`/api/nodes/${r.id}/test-cases/upsert`, {
    name: '登录回归',
    prompt: '跑登录单测',
    expectation: '全绿'
  })
  assert.equal(c1.created, true)
  assert.equal(c1.kind, 'regression')
  const c2 = await post(`/api/nodes/${r.id}/test-cases/upsert`, {
    name: '登录回归',
    prompt: '跑登录单测 v2',
    expectation: '全绿'
  })
  assert.equal(c2.created, false)
  assert.equal(c2.id, c1.id)

  const cases = await get(`/api/nodes/${r.id}/test-cases`)
  assert.equal(cases.length, 1)
  assert.equal(cases[0].prompt, '跑登录单测 v2')

  // dryRun 只返回提示词，不落报告
  const dry = await post(`/api/nodes/${r.id}/test-runs`, { dryRun: true })
  assert.equal(dry.dryRun, true)
  assert.ok(dry.prompt.includes('登录回归'))
  assert.equal((await get(`/api/nodes/${r.id}/test-reports`)).length, 0)

  // 验收报告聚合：用例已建、尚未执行
  const acceptance = await get(`/api/nodes/${r.id}/acceptance-report`)
  assert.equal(acceptance.totals.cases, 1)
  assert.equal(acceptance.totals.notRun, 1)
  assert.equal(acceptance.passRate, null)

  await close()
  tmp.cleanup()
})

test('回归闭环：重名用例返回 TEST_CASE_NAME_EXISTS', async () => {
  const { tmp, post, base, close } = await setup()
  const p = await post('/api/nodes', { type: 'project', name: 'P' })
  await post(`/api/nodes/${p.id}/test-cases`, { name: 'A', prompt: 'p' })
  const res = await fetch(`${base}/api/nodes/${p.id}/test-cases`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'A', prompt: 'q' })
  })
  assert.equal(res.status, 409)
  const dup = await post(`/api/nodes/${p.id}/test-cases`, { name: 'A', prompt: 'q' })
  assert.equal(dup.error.code, 'TEST_CASE_NAME_EXISTS')
  await close()
  tmp.cleanup()
})

test('回归闭环：报告列表 / 单条读取 / 回写终态', async () => {
  const { tmp, store, post, get, patch, close } = await setup()
  const p = await post('/api/nodes', { type: 'project', name: 'P' })
  const c = await post(`/api/nodes/${p.id}/test-cases`, { name: 'A', prompt: 'p' })
  // 直接经 store 开一条 running 报告（派单需要真实运行目录，这里只验报告接口）
  const rep = store.createTestReport(p.id, { caseId: c.id, kind: 'regression', status: 'running' })

  const list = await get(`/api/nodes/${p.id}/test-reports`)
  assert.equal(list.length, 1)
  assert.equal(list[0].status, 'running')
  assert.equal((await get(`/api/nodes/${p.id}/test-reports?caseId=${c.id}`)).length, 1)
  assert.equal((await get(`/api/nodes/${p.id}/test-reports?kind=acceptance`)).length, 0)

  const one = await get(`/api/test-reports/${rep.id}`)
  assert.equal(one.id, rep.id)

  const done = await patch(`/api/test-reports/${rep.id}`, { status: 'pass', summary: '全绿' })
  assert.equal(done.status, 'pass')
  assert.equal(done.summary, '全绿')
  assert.ok(done.finishedAt)

  const acceptance = await get(`/api/nodes/${p.id}/acceptance-report`)
  assert.equal(acceptance.totals.pass, 1)
  assert.equal(acceptance.passRate, 1)

  await close()
  tmp.cleanup()
})

// ---------- 回归：验收退回的缺陷 1 / 2 / 5（HTTP 契约层） ----------

test('缺陷1回归：重名用例 HTTP 返回 409 TEST_CASE_NAME_EXISTS（不是 500）', async () => {
  const { tmp, post, raw, close } = await setup()
  const p = await post('/api/nodes', { type: 'project', name: 'P' })
  await post(`/api/nodes/${p.id}/test-cases`, { name: 'A', prompt: 'p' })
  const dup = await raw('POST', `/api/nodes/${p.id}/test-cases`, { name: 'A', prompt: 'q' })
  assert.equal(dup.status, 409)
  assert.equal(dup.body.error.code, 'TEST_CASE_NAME_EXISTS')
  await close()
  tmp.cleanup()
})

test('缺陷2回归：HTTP 非法报告状态返回 400 VALIDATION_FAILED（不是 500 ERR_SQLITE_ERROR）', async () => {
  const { tmp, store, post, raw, close } = await setup()
  const p = await post('/api/nodes', { type: 'project', name: 'P' })
  const c = await post(`/api/nodes/${p.id}/test-cases`, { name: 'A', prompt: 'p' })
  const rep = store.createTestReport(p.id, { caseId: c.id })
  const bad = await raw('PATCH', `/api/test-reports/${rep.id}`, { status: 'bogus' })
  assert.equal(bad.status, 400)
  assert.equal(bad.body.error.code, 'VALIDATION_FAILED')
  assert.ok(!String(bad.body.error.message).includes('SQLITE'))
  await close()
  tmp.cleanup()
})

test('缺陷2回归：HTTP 终态互转返回 409 REPORT_STATUS_IMMUTABLE，overwrite 可覆盖', async () => {
  const { tmp, store, post, raw, close } = await setup()
  const p = await post('/api/nodes', { type: 'project', name: 'P' })
  const c = await post(`/api/nodes/${p.id}/test-cases`, { name: 'A', prompt: 'p' })
  const rep = store.createTestReport(p.id, { caseId: c.id })
  assert.equal((await raw('PATCH', `/api/test-reports/${rep.id}`, { status: 'pass' })).status, 200)
  const conflict = await raw('PATCH', `/api/test-reports/${rep.id}`, { status: 'fail' })
  assert.equal(conflict.status, 409)
  assert.equal(conflict.body.error.code, 'REPORT_STATUS_IMMUTABLE')
  const forced = await raw('PATCH', `/api/test-reports/${rep.id}`, { status: 'fail', overwrite: true })
  assert.equal(forced.status, 200)
  assert.equal(forced.body.status, 'fail')
  await close()
  tmp.cleanup()
})

test('缺陷3回归：HTTP 验收报告分桶守恒、running 不入分母', async () => {
  const { tmp, store, post, get, close } = await setup()
  const p = await post('/api/nodes', { type: 'project', name: 'P' })
  const c = await post(`/api/nodes/${p.id}/test-cases`, { name: 'A', prompt: 'p' })
  const rep = store.createTestReport(p.id, { caseId: c.id }) // running
  const report = await get(`/api/nodes/${p.id}/acceptance-report`)
  assert.equal(report.totals.cases, 1)
  assert.equal(report.totals.running, 1)
  assert.equal(report.totals.settled, 0)
  assert.equal(report.passRate, null)
  store.finishTestReport(rep.id, { status: 'pass' })
  const after = await get(`/api/nodes/${p.id}/acceptance-report`)
  assert.equal(after.totals.pass + after.totals.fail + after.totals.blocked + after.totals.error + after.totals.cancelled + after.totals.running + after.totals.notRun, after.totals.cases)
  assert.equal(after.passRate, 1)
  await close()
  tmp.cleanup()
})

test('缺陷5回归：报告接口接受 runId 字段并与 MCP/CLI 契约一致', async () => {
  const { tmp, store, post, raw, close } = await setup()
  const p = await post('/api/nodes', { type: 'project', name: 'P' })
  const c = await post(`/api/nodes/${p.id}/test-cases`, { name: 'A', prompt: 'p' })
  // runId 指向不存在的 agent 任务 → 404 NOT_FOUND（而非外键 500）
  const rep = store.createTestReport(p.id, { caseId: c.id })
  const bad = await raw('PATCH', `/api/test-reports/${rep.id}`, { status: 'pass', runId: 999999 })
  assert.equal(bad.status, 404)
  assert.equal(bad.body.error.code, 'NOT_FOUND')
  // 合法 runId：先建一条 agent 任务再回填
  const run = store.createAgentRun(p.id, { prompt: 'x', agent: 'qodercli' }, 'user')
  const ok = await raw('PATCH', `/api/test-reports/${rep.id}`, { status: 'pass', runId: run.id })
  assert.equal(ok.status, 200)
  assert.equal(ok.body.runId, run.id)
  await close()
  tmp.cleanup()
})

// ---------- 研发主线思维导图 ----------

test('研发主线思维导图：HTTP 只读聚合 + markdown 输出', async () => {
  const { tmp, store, post, get, base, close } = await setup()
  const p = await post('/api/nodes', { type: 'project', name: 'P' })
  const r = await post('/api/nodes', { parentId: p.id, type: 'requirement', name: 'R' })
  await post(`/api/nodes/${r.id}/documents/upsert`, { name: '需求内容', content: '需求正文' })
  await post(`/api/nodes/${r.id}/documents/upsert`, { name: '概要设计', content: '设计正文' })
  const c = await post(`/api/nodes/${r.id}/test-cases/upsert`, { name: '回归用例', prompt: '跑单测' })
  const rep = store.createTestReport(r.id, { caseId: c.id, kind: 'regression' })
  store.finishTestReport(rep.id, { status: 'pass' })
  await post(`/api/nodes/${r.id}/release-items/upsert`, { name: '执行上线 SQL', kind: 'sql', status: 'pending' })

  const map = await get(`/api/nodes/${r.id}/workflow-map`)
  assert.equal(map.scope, 'self')
  assert.equal(map.status, 'fail')
  assert.equal(map.stages.length, 12)
  assert.ok(map.nodes.some((n) => n.type === 'branch' && n.stage === 'release_sql' && n.status === 'fail'))

  const raw = await fetch(`${base}/api/nodes/${r.id}/workflow-map?format=md`)
  assert.equal(raw.status, 200)
  const md = await raw.text()
  assert.match(md, /研发主线思维导图/)
  assert.match(md, /上线 SQL/)

  await close()
  tmp.cleanup()
})

// ---------- 上线治理 ----------

test('上线治理：上线项 upsert → 清单 → 就绪结论（HTTP 全链路）', async () => {
  const { tmp, post, get, patch, del, close } = await setup()
  const p = await post('/api/nodes', { type: 'project', name: 'P' })
  const r = await post('/api/nodes', { parentId: p.id, type: 'requirement', name: 'R' })

  // 按名 upsert 幂等
  const i1 = await post(`/api/nodes/${r.id}/release-items/upsert`, {
    name: '执行上线 SQL',
    kind: 'sql',
    content: 'ALTER TABLE …',
    rollback: 'DROP INDEX …'
  })
  assert.equal(i1.created, true)
  assert.equal(i1.kind, 'sql')
  assert.equal(i1.status, 'pending')
  const i2 = await post(`/api/nodes/${r.id}/release-items/upsert`, {
    name: '执行上线 SQL',
    kind: 'sql',
    content: 'ALTER TABLE … v2'
  })
  assert.equal(i2.created, false)
  assert.equal(i2.id, i1.id)
  assert.equal(i2.content, 'ALTER TABLE … v2')

  const items = await get(`/api/nodes/${r.id}/release-items`)
  assert.equal(items.length, 1)

  // 必做项未完成 → 未就绪
  const checklist = await get(`/api/nodes/${r.id}/release-checklist`)
  assert.equal(checklist.ready, false)
  assert.equal(checklist.blockers.length, 1)
  assert.equal(checklist.blockers[0].name, '执行上线 SQL')

  // 回写 done → 就绪
  const done = await patch(`/api/release-items/${i1.id}`, { status: 'done' })
  assert.equal(done.status, 'done')
  assert.equal((await get(`/api/nodes/${r.id}/release-checklist`)).ready, true)

  // 删除后清单为空，ready=null
  await del(`/api/release-items/${i1.id}`, {})
  assert.equal((await get(`/api/nodes/${r.id}/release-checklist`)).ready, null)

  await close()
  tmp.cleanup()
})

test('上线治理：重名上线项返回 RELEASE_ITEM_NAME_EXISTS（409）', async () => {
  const { tmp, post, base, close } = await setup()
  const p = await post('/api/nodes', { type: 'project', name: 'P' })
  await post(`/api/nodes/${p.id}/release-items`, { name: 'A' })
  const res = await fetch(`${base}/api/nodes/${p.id}/release-items`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'A' })
  })
  assert.equal(res.status, 409)
  const dup = await post(`/api/nodes/${p.id}/release-items`, { name: 'A' })
  assert.equal(dup.error.code, 'RELEASE_ITEM_NAME_EXISTS')
  await close()
  tmp.cleanup()
})

test('上线治理：dryRun 拼上线清单与 code/biz/release_check 用例', async () => {
  const { tmp, post, get, close } = await setup()
  const p = await post('/api/nodes', { type: 'project', name: 'P' })
  const r = await post('/api/nodes', { parentId: p.id, type: 'requirement', name: 'R' })
  await post(`/api/nodes/${r.id}/release-items/upsert`, { name: '灰度开关', kind: 'config', content: 'switch=on' })
  await post(`/api/nodes/${r.id}/test-cases/upsert`, { name: '静态检查', prompt: '跑 lint', kind: 'code_check' })
  await post(`/api/nodes/${r.id}/test-cases/upsert`, { name: '普通回归', prompt: '跑回归', kind: 'regression' })

  const dry = await post(`/api/nodes/${r.id}/release-checks`, { dryRun: true })
  assert.equal(dry.dryRun, true)
  assert.deepEqual(dry.cases.map((c) => c.name), ['静态检查'])
  assert.equal(dry.items.length, 1)
  assert.ok(dry.prompt.includes('灰度开关'))
  assert.ok(dry.prompt.includes('静态检查'))
  // dryRun 不落报告、不派单
  assert.equal((await get(`/api/nodes/${r.id}/test-reports`)).length, 0)

  await close()
  tmp.cleanup()
})

test('上线治理：清单 md 输出可贴进上线单', async () => {
  const { tmp, post, base, close } = await setup()
  const p = await post('/api/nodes', { type: 'project', name: 'P' })
  await post(`/api/nodes/${p.id}/release-items/upsert`, { name: '执行上线 SQL', kind: 'sql' })
  const res = await fetch(`${base}/api/nodes/${p.id}/release-checklist?format=md`)
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-type') || '', /text\/markdown/)
  const md = await res.text()
  assert.ok(md.startsWith('# 上线检查'))
  assert.ok(md.includes('执行上线 SQL'))
  await close()
  tmp.cleanup()
})

test('上线治理：必做项 done 但检查用例未执行 → 清单未就绪（假绿灯全链路回归）', async () => {
  const { tmp, store, post, get, patch, close } = await setup()
  const p = await post('/api/nodes', { type: 'project', name: 'P' })
  const r = await post('/api/nodes', { parentId: p.id, type: 'requirement', name: 'R' })

  const item = await post(`/api/nodes/${r.id}/release-items/upsert`, { name: '执行上线 SQL', kind: 'sql' })
  await patch(`/api/release-items/${item.id}`, { status: 'done' })
  const lint = await post(`/api/nodes/${r.id}/test-cases/upsert`, { name: '静态检查', prompt: '跑 lint', kind: 'code_check' })

  // 旧实现：必做项全 done → ready=true，检查用例被忽略
  const blocked = await get(`/api/nodes/${r.id}/release-checklist`)
  assert.equal(blocked.ready, false)
  assert.equal(blocked.totals.checkNotRun, 1)
  assert.equal(blocked.caseBlockers[0].name, '静态检查')

  // 通过既有报告回写接口写入 pass → 清单恢复就绪
  const report = store.createTestReport(r.id, { caseId: lint.id, kind: 'code_check', status: 'running' })
  await patch(`/api/test-reports/${report.id}`, { status: 'pass', summary: '无告警' })
  const ready = await get(`/api/nodes/${r.id}/release-checklist`)
  assert.equal(ready.ready, true)
  assert.deepEqual(ready.caseBlockers, [])

  // 检查用例同样是交付证据：未执行时 delivery-gate 不可交付
  const report2 = store.createTestReport(r.id, { caseId: lint.id, kind: 'code_check', status: 'running' })
  await patch(`/api/test-reports/${report2.id}`, { status: 'fail', summary: 'lint 报错', overwrite: true })
  const gate = await get(`/api/nodes/${r.id}/delivery-gate`)
  assert.equal(gate.decision, 'not_ready')
  assert.ok(gate.blockers.some((b) => b.source === 'release' && b.name === '静态检查'))

  await close()
  tmp.cleanup()
})

// ---------- 需求就绪门禁（需求管理闭环的前置判定） ----------

// ---------- 业务检查门禁（业务可验收性的只读判定） ----------

test('业务检查门禁：未关闭缺陷 + 未跑用例 → 阻塞；关闭并跑通后放行（HTTP 全链路）', async () => {
  const { tmp, store, post, get, patch, base, close } = await setup()
  const p = await post('/api/nodes', { type: 'project', name: 'P' })
  const s = await post('/api/nodes', { parentId: p.id, type: 'requirement', name: 'R' })
  const g = await post('/api/nodes', { parentId: s.id, type: 'group', name: 'G' })
  const d = await post('/api/nodes', { parentId: g.id, type: 'defect', name: 'D' })
  const c = await post(`/api/nodes/${s.id}/test-cases/upsert`, { name: '下单主流程', prompt: 'p', kind: 'biz_check' })

  // 未关闭缺陷 + 用例未执行 → 阻塞（两条 blocker 各占一键）
  const gate = await get(`/api/nodes/${s.id}/business-gate?scope=subtree`)
  assert.equal(gate.ready, false)
  assert.equal(gate.totals.openDefects, 1)
  assert.equal(gate.totals.notRun, 1)
  assert.deepEqual(gate.blockers.map((b) => b.kind).sort(), ['open_defect', 'unpassed_case'])

  // 关闭缺陷 + 跑通用例 → 放行
  await patch(`/api/nodes/${d.id}`, { status: 'done' })
  // 报告由派单执行产生（HTTP 没有裸建报告的入口），这里用 store 落一条 pass 报告后回到 HTTP 断言
  const rep = store.createTestReport(s.id, { caseId: c.id, kind: 'biz_check' })
  store.finishTestReport(rep.id, { status: 'pass' })
  const ready = await get(`/api/nodes/${s.id}/business-gate?scope=subtree`)
  assert.equal(ready.ready, true)
  assert.deepEqual(ready.blockers, [])

  // 空态：只有 self 上没有缺陷 / 用例时 ready=null
  assert.equal((await get(`/api/nodes/${p.id}/business-gate`)).ready, null)

  // md 形态
  const res = await fetch(`${base}/api/nodes/${s.id}/business-gate?scope=subtree&format=md`)
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-type') || '', /text\/markdown/)
  assert.ok((await res.text()).startsWith('# 业务检查'))

  // 非法 scope → 400 VALIDATION_FAILED
  const rawRes = await fetch(`${base}/api/nodes/${s.id}/business-gate?scope=Subtree`)
  assert.equal(rawRes.status, 400)
  assert.equal((await rawRes.json()).error.code, 'VALIDATION_FAILED')

  await close()
  tmp.cleanup()
})


test('就绪门禁：全链路（未就绪 → 补文档 + 用例 → 就绪）', async () => {
  const { tmp, post, get, close } = await setup()
  const p = await post('/api/nodes', { type: 'project', name: 'P' })
  const r = await post('/api/nodes', { parentId: p.id, type: 'requirement', name: 'R' })

  // 新建需求：预置空白「需求内容」不算通过（存在 ≠ 写完）
  let out = await get(`/api/nodes/${r.id}/readiness`)
  assert.equal(out.ready, false)
  assert.equal(out.totals.units, 1)
  assert.equal(out.totals.failed, 3)

  await post(`/api/nodes/${r.id}/documents/upsert`, { name: '需求内容', content: '需求正文' })
  out = await get(`/api/nodes/${r.id}/readiness`)
  assert.equal(out.ready, false)
  assert.equal(out.items.find((i) => i.key === 'requirement_doc').passed, true)

  await post(`/api/nodes/${r.id}/documents/upsert`, { name: '概要设计', content: '设计正文' })
  await post(`/api/nodes/${r.id}/test-cases/upsert`, { name: '回归用例', prompt: '跑单测' })
  out = await get(`/api/nodes/${r.id}/readiness`)
  assert.equal(out.ready, true)
  assert.equal(out.totals.readyUnits, 1)
  assert.deepEqual(out.blockers, [])

  await close()
  tmp.cleanup()
})

test('就绪门禁：scope=subtree 汇总 + md 输出', async () => {
  const { tmp, post, base, close } = await setup()
  const p = await post('/api/nodes', { type: 'project', name: 'P' })
  const r = await post('/api/nodes', { parentId: p.id, type: 'requirement', name: 'R' })
  const s = await post('/api/nodes', { parentId: r.id, type: 'subreq', name: 'S' })
  for (const [n, body] of [
    [r.id, { name: '需求内容', content: '正文' }],
    [r.id, { name: '概要设计', content: '设计' }],
    [s.id, { name: '需求内容', content: '正文' }]
  ]) {
    await post(`/api/nodes/${n}/documents/upsert`, body)
  }
  await post(`/api/nodes/${r.id}/test-cases/upsert`, { name: '回归用例', prompt: '跑单测' })

  const subtree = await fetch(`${base}/api/nodes/${p.id}/readiness?scope=subtree`).then((x) => x.json())
  assert.equal(subtree.totals.units, 2)
  assert.equal(subtree.totals.readyUnits, 1)
  assert.equal(subtree.ready, false)

  const res = await fetch(`${base}/api/nodes/${p.id}/readiness?scope=subtree&format=md`)
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-type') || '', /text\/markdown/)
  const md = await res.text()
  assert.ok(md.startsWith('# 需求就绪门禁'))
  assert.ok(md.includes('阻塞项'))
  await close()
  tmp.cleanup()
})

test('代码检查：端到端（登记提交 → 命中高危 → md）', async () => {
  const { tmp, post, get, base, close } = await setup()
  const repo = makeAuditRepo()
  try {
    const p = await post('/api/nodes', { type: 'project', name: 'P' })
    const r = await post('/api/nodes', { parentId: p.id, type: 'requirement', name: 'R' })
    await post('/api/repos', { name: 'demo', localPath: repo.dir })
    await post(`/api/nodes/${r.id}/commits`, { repo: 'demo', sha: repo.sha })

    const out = await get(`/api/nodes/${r.id}/code-audit`)
    assert.equal(out.ready, false)
    assert.equal(out.totals.danger, 1)
    assert.equal(out.blockers[0].rule, 'hardcoded_secret')
    assert.ok(!JSON.stringify(out).includes('abcdefghijkl'), '不得回显原值')

    const res = await fetch(`${base}/api/nodes/${r.id}/code-audit?format=md`)
    assert.equal(res.status, 200)
    assert.match(res.headers.get('content-type') || '', /text\/markdown/)
    const md = await res.text()
    assert.ok(md.startsWith('# 代码检查'))
    assert.ok(md.includes('| 高危 |'))

    const bad = await fetch(`${base}/api/nodes/${r.id}/code-audit?scope=Subtree`)
    assert.equal(bad.status, 400)
    assert.equal((await bad.json()).error.code, 'VALIDATION_FAILED')
  } finally {
    await close()
    tmp.cleanup()
    fs.rmSync(repo.root, { recursive: true, force: true })
  }
})

// ---------- D2 回归：非法 scope 必须 400，不得静默降级 self ----------

test('D2回归：非法 scope 返回 400 VALIDATION_FAILED（三入口契约一致，不再静默降级）', async () => {
  const { tmp, post, raw, close } = await setup()
  const p = await post('/api/nodes', { type: 'project', name: 'P' })
  const r = await post('/api/nodes', { parentId: p.id, type: 'requirement', name: 'R' })
  // 让 R 自身就绪：旧实现下 scope=Subtree 会降级 self → ready=true（假绿）
  await post(`/api/nodes/${r.id}/documents/upsert`, { name: '需求内容', content: '正文' })
  await post(`/api/nodes/${r.id}/documents/upsert`, { name: '概要设计', content: '设计' })
  await post(`/api/nodes/${r.id}/test-cases/upsert`, { name: '回归用例', prompt: '跑单测' })

  const paths = ['readiness', 'acceptance-report', 'release-checklist', 'delivery-gate']
  for (const bad of ['Subtree', 'xyz', 'subtre']) {
    for (const path of paths) {
      const res = await raw('GET', `/api/nodes/${r.id}/${path}?scope=${encodeURIComponent(bad)}`)
      assert.equal(res.status, 400, `${path}?scope=${bad} 应当 400`)
      assert.equal(res.body.error.code, 'VALIDATION_FAILED')
      assert.deepEqual(res.body.error.details.allowed, ['self', 'subtree'])
    }
  }
  // 空串同样属于显式非法值
  const emptyScope = await raw('GET', `/api/nodes/${r.id}/readiness?scope=`)
  assert.equal(emptyScope.status, 400)
  assert.equal(emptyScope.body.error.code, 'VALIDATION_FAILED')

  // 合法值不受影响
  const okSelf = await raw('GET', `/api/nodes/${r.id}/readiness?scope=self`)
  assert.equal(okSelf.status, 200)
  const okSubtree = await raw('GET', `/api/nodes/${r.id}/readiness?scope=subtree`)
  assert.equal(okSubtree.status, 200)

  await close()
  tmp.cleanup()
})

test('D1回归：子树无需求时 readiness 返回 ready=null 空态（HTTP 200，不是 400）', async () => {
  const { tmp, post, raw, close } = await setup()
  const p = await post('/api/nodes', { type: 'project', name: 'P' })
  const r = await post('/api/nodes', { parentId: p.id, type: 'requirement', name: 'R' })
  await raw('DELETE', `/api/nodes/${r.id}`, { confirm: true })

  const res = await raw('GET', `/api/nodes/${p.id}/readiness?scope=subtree`)
  assert.equal(res.status, 200)
  assert.equal(res.body.ready, null)
  assert.equal(res.body.totals.units, 0)

  await close()
  tmp.cleanup()
})

// ---------- 交付门禁（需求就绪 + 测试验收 + 上线治理的最终汇总） ----------

test('交付门禁：全链路（需求就绪 → 测试未跑不可交付 → 通过后可交付）', async () => {
  const { tmp, store, post, get, patch, base, close } = await setup()
  const p = await post('/api/nodes', { type: 'project', name: 'P' })
  const r = await post('/api/nodes', { parentId: p.id, type: 'requirement', name: 'R' })

  await post(`/api/nodes/${r.id}/documents/upsert`, { name: '需求内容', content: '需求正文' })
  await post(`/api/nodes/${r.id}/documents/upsert`, { name: '概要设计', content: '设计正文' })
  const testCase = await post(`/api/nodes/${r.id}/test-cases/upsert`, { name: '回归用例', prompt: '跑单测' })

  // 测试未执行：需求就绪通过，但验收未通过
  let gate = await get(`/api/nodes/${r.id}/delivery-gate`)
  assert.equal(gate.decision, 'not_ready')
  assert.equal(gate.sources.find((s) => s.key === 'readiness').status, 'pass')
  assert.equal(gate.sources.find((s) => s.key === 'acceptance').status, 'fail')
  assert.equal(gate.sources.find((s) => s.key === 'acceptance').evidence.totals.notRun, 1)
  assert.equal(gate.sources.find((s) => s.key === 'acceptance').evidence.items[0].latestStatus, 'not_run')
  assert.equal(gate.blockers.length, 1)
  assert.deepEqual(gate.blockers.map((b) => [b.source, b.name, b.detail]), [
    ['acceptance', '回归用例', '最近结果：not_run']
  ])

  // 报告回写 pass 后，全链路可交付
  const report = store.createTestReport(r.id, { caseId: testCase.id })
  await patch(`/api/test-reports/${report.id}`, { status: 'pass', summary: '全绿' })
  await post(`/api/nodes/${r.id}/acceptance-signoff`, { decision: 'accepted', comment: '业务确认通过' })
  gate = await get(`/api/nodes/${r.id}/delivery-gate`)
  assert.equal(gate.decision, 'ready')
  assert.equal(gate.ready, true)

  // markdown 可直接贴进 issue
  const res = await fetch(`${base}/api/nodes/${r.id}/delivery-gate?format=md`)
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-type') || '', /text\/markdown/)
  const md = await res.text()
  assert.ok(md.startsWith('# 交付门禁'))
  assert.ok(md.includes('可交付'))
  await close()
  tmp.cleanup()
})

test('交付门禁：没有任何证据时 unknown，不伪造成可交付', async () => {
  const { tmp, post, get, close } = await setup()
  const p = await post('/api/nodes', { type: 'project', name: 'P' })
  const gate = await get(`/api/nodes/${p.id}/delivery-gate`)
  assert.equal(gate.decision, 'unknown')
  assert.equal(gate.ready, null)
  assert.equal(gate.totals.notApplicable, 3)
  await close()
  tmp.cleanup()
})

test('交付门禁：非法 scope / format 返回 400 VALIDATION_FAILED（HTTP 回归）', async () => {
  const { tmp, post, raw, close } = await setup()
  const p = await post('/api/nodes', { type: 'project', name: 'P' })
  for (const qs of ['scope=sub', 'format=xml', 'format=', 'scope=']) {
    const res = await raw('GET', `/api/nodes/${p.id}/delivery-gate?${qs}`)
    assert.equal(res.status, 400, qs)
    assert.equal(res.body.error.code, 'VALIDATION_FAILED', qs)
  }
  await close()
  tmp.cleanup()
})
