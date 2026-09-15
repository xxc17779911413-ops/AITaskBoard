import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { tempHome } from './helpers.mjs'

const execFileP = promisify(execFile)
const CLI = path.resolve(import.meta.dirname, '../bin/taskboard.js')

async function setup() {
  const tmp = await tempHome()
  const store = tmp.store.createStore(tmp.openDb())
  const p = store.createNode({ type: 'project', name: 'P' })
  const r = store.createNode({ parentId: p.id, type: 'requirement', name: 'R' })
  store.upsertDocument(r.id, '需求内容', '需求正文')
  store.upsertDocument(r.id, '概要设计', '设计正文')
  const testCase = store.upsertTestCase(r.id, { name: '回归用例', prompt: '跑单测' })
  const report = store.createTestReport(r.id, { caseId: testCase.id, status: 'running', kind: 'regression' })
  store.finishTestReport(report.id, { status: 'pass', summary: '全绿' })
  // 交付门禁自决策 39 起要求「测试无阻塞 + 验收签收 accepted」同时成立；
  // 只写测试结论不足以让门禁 ready，这里补齐签收，让本套用例聚焦快照本身。
  store.upsertAcceptanceSignoff(r.id, { decision: 'accepted', comment: '验收通过' })
  return { tmp, store, p, r, testCase }
}

test('delivery snapshot：冻结当前交付结论并保存完整证据', async (t) => {
  const { tmp, store, r } = await setup()
  t.after(() => tmp.cleanup())
  const before = store.getRevision()
  const snapshot = store.captureDeliverySnapshot(r.id, { note: '上线审批留痕' }, 'ai')

  assert.equal(snapshot.nodeId, r.id)
  assert.equal(snapshot.scope, 'self')
  assert.equal(snapshot.decision, 'ready')
  assert.equal(snapshot.ready, true)
  assert.equal(snapshot.note, '上线审批留痕')
  assert.equal(snapshot.createdBy, 'ai')
  assert.match(snapshot.fingerprint, /^[0-9a-f]{64}$/)
  assert.equal(snapshot.gate.decision, 'ready')
  assert.deepEqual(snapshot.gate.blockers, [])
  assert.equal(snapshot.drift.status, 'current')
  assert.equal(store.getRevision(), before + 1)
})

test('delivery snapshot：无改动时 current；源证据变化后 drifted 且不改写冻结结论', async (t) => {
  const { tmp, store, r } = await setup()
  t.after(() => tmp.cleanup())
  const snapshot = store.captureDeliverySnapshot(r.id)
  assert.equal(snapshot.drift.status, 'current')

  store.createReleaseItem(r.id, { name: '执行上线 SQL', kind: 'sql', status: 'pending' })
  const [again] = store.listDeliverySnapshots(r.id)
  assert.equal(again.id, snapshot.id)
  assert.equal(again.decision, 'ready')
  assert.equal(again.gate.decision, 'ready')
  assert.equal(again.drift.status, 'drifted')
  assert.equal(again.drift.currentDecision, 'not_ready')
  assert.notEqual(again.drift.currentFingerprint, again.fingerprint)
})

test('delivery snapshot：漂移只认证据集合——节点改名不误报 drifted', async (t) => {
  const { tmp, store, r } = await setup()
  t.after(() => tmp.cleanup())
  const snapshot = store.captureDeliverySnapshot(r.id)
  assert.equal(snapshot.drift.status, 'current')

  store.updateNode(r.id, { name: 'R-改名' })
  const [again] = store.listDeliverySnapshots(r.id)
  assert.equal(again.drift.status, 'current')
  assert.equal(again.drift.currentFingerprint, again.fingerprint)
  assert.equal(again.gate.node.name, 'R')
  assert.equal(store.buildDeliveryGate(r.id).node.name, 'R-改名')
})

test('delivery snapshot：漂移只认证据集合——上线项改名 / no-op 重存 current，status 变化 drifted', async (t) => {
  const { tmp, store, r } = await setup()
  t.after(() => tmp.cleanup())
  const item = store.createReleaseItem(r.id, { name: '上线项', kind: 'sql', content: 'ALTER TABLE x', status: 'done' })
  const snapshot = store.captureDeliverySnapshot(r.id)
  assert.equal(snapshot.drift.status, 'current')

  store.updateReleaseItem(item.id, { name: '上线项改名' })
  assert.equal(store.getDeliverySnapshot(snapshot.id).drift.status, 'current')

  store.updateReleaseItem(item.id, { name: '上线项改名', kind: 'sql', content: 'ALTER TABLE x', status: 'done' })
  assert.equal(store.getDeliverySnapshot(snapshot.id).drift.status, 'current')

  store.updateReleaseItem(item.id, { status: 'pending' })
  assert.equal(store.getDeliverySnapshot(snapshot.id).drift.status, 'drifted')
})

test('delivery snapshot：scope=subtree 冻结子树证据，并按 scope 列表隔离', async (t) => {
  const { tmp, store, p, r } = await setup()
  t.after(() => tmp.cleanup())
  // 签收按 (node, scope) 存储：子树快照在 p 上捕获，门禁会按 (p, subtree) 查签收，
  // 因此签收也要落在同一个 (node, scope) 上，否则会因「未签收」判 not_ready。
  store.upsertAcceptanceSignoff(p.id, { decision: 'accepted', comment: '子树验收', scope: 'subtree' })
  const selfSnapshot = store.captureDeliverySnapshot(r.id, { scope: 'self' })
  const subtreeSnapshot = store.captureDeliverySnapshot(p.id, { scope: 'subtree' })

  assert.equal(subtreeSnapshot.scope, 'subtree')
  assert.equal(subtreeSnapshot.decision, 'ready')
  assert.equal(store.listDeliverySnapshots(p.id, { scope: 'subtree' }).length, 1)
  assert.equal(store.listDeliverySnapshots(p.id, { scope: 'self' }).length, 0)
  assert.equal(store.getDeliverySnapshot(selfSnapshot.id).id, selfSnapshot.id)
})

test('delivery snapshot：未知 scope / 快照 id 返回稳定错误码', async (t) => {
  const { tmp, store, r } = await setup()
  t.after(() => tmp.cleanup())
  for (const bad of ['sub', '', 'Subtree']) {
    assert.throws(() => store.captureDeliverySnapshot(r.id, { scope: bad }), /VALIDATION_FAILED/)
    assert.throws(() => store.listDeliverySnapshots(r.id, { scope: bad }), /VALIDATION_FAILED/)
  }
  assert.throws(() => store.getDeliverySnapshot(999999), /NOT_FOUND/)
})

test('delivery snapshot：节点删除后快照随节点级联删除', async (t) => {
  const { tmp, store, r } = await setup()
  t.after(() => tmp.cleanup())
  const snapshot = store.captureDeliverySnapshot(r.id)
  store.deleteNode(r.id)
  assert.throws(() => store.getDeliverySnapshot(snapshot.id), /NOT_FOUND/)
})

test('delivery snapshot：HTTP 捕获 / 列表 / 单条读取全链路', async (t) => {
  const tmp = await tempHome()
  const store = tmp.store.createStore(tmp.openDb())
  const { createApp } = await import('../server/http.mjs')
  const app = createApp({ store })
  const server = await new Promise((resolve, reject) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s))
    s.once('error', reject)
  })
  const base = `http://127.0.0.1:${server.address().port}`
  t.after(async () => {
    await new Promise((r) => server.close(r))
    tmp.cleanup()
  })

  const p = store.createNode({ type: 'project', name: 'P' })
  const r = store.createNode({ parentId: p.id, type: 'requirement', name: 'R' })
  store.upsertDocument(r.id, '需求内容', '需求正文')
  store.upsertDocument(r.id, '概要设计', '设计正文')
  const c = store.upsertTestCase(r.id, { name: '回归用例', prompt: '跑单测' })
  const report = store.createTestReport(r.id, { caseId: c.id, status: 'running', kind: 'regression' })
  store.finishTestReport(report.id, { status: 'pass' })
  store.upsertAcceptanceSignoff(r.id, { decision: 'accepted', comment: '验收通过' })

  const captured = await fetch(`${base}/api/nodes/${r.id}/delivery-snapshots`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-taskboard-actor': 'ai' },
    body: JSON.stringify({ scope: 'self', note: 'HTTP 留痕' })
  }).then((x) => x.json())
  assert.equal(captured.decision, 'ready')
  assert.equal(captured.createdBy, 'ai')

  const list = await fetch(`${base}/api/nodes/${r.id}/delivery-snapshots?scope=self`).then((x) => x.json())
  assert.equal(list.length, 1)
  assert.equal(list[0].id, captured.id)
  assert.equal(list[0].drift.status, 'current')

  const one = await fetch(`${base}/api/delivery-snapshots/${captured.id}`).then((x) => x.json())
  assert.equal(one.id, captured.id)
  const md = await fetch(`${base}/api/delivery-snapshots/${captured.id}?format=md`).then((x) => x.text())
  assert.match(md, /^# 交付快照 #/m)
  assert.match(md, /与当前证据一致/)
})

test('delivery snapshot：Markdown 导出转义标题与备注，不能注入章节或伪造表格', async (t) => {
  const { tmp, store, r } = await setup()
  t.after(() => tmp.cleanup())
  store.updateNode(r.id, { name: 'R\n第二行|标题\\反斜杠' })
  const snapshot = store.captureDeliverySnapshot(r.id, {
    note: '正常备注\n\n## 注入标题\n| 伪造来源 | pass | 伪造通过 |'
  })
  const { renderDeliverySnapshotMd } = await import('../server/ops.mjs')
  const md = renderDeliverySnapshotMd(store.getDeliverySnapshot(snapshot.id))

  assert.ok(md.startsWith('# 交付快照 #'))
  assert.ok(!md.includes('\n第二行'))
  assert.ok(md.includes('第二行\\|标题\\\\反斜杠'))
  assert.ok(!/^## 注入标题$/m.test(md))
  assert.ok(!md.includes('\n| 伪造来源 | pass | 伪造通过 |'))
  assert.ok(md.includes('备注：正常备注  \\#\\# 注入标题 \\| 伪造来源 \\| pass \\| 伪造通过 \\|'))
})

test('delivery snapshot：单独 CR 被归一化，Markdown 渲染后冻结依据表仍在', async (t) => {
  const { tmp, store, r } = await setup()
  t.after(() => tmp.cleanup())
  const snapshot = store.captureDeliverySnapshot(r.id, { note: '正常\r```\r> 注入\r- 列表\r1. 列表' })
  const { renderDeliverySnapshotMd } = await import('../server/ops.mjs')
  const md = renderDeliverySnapshotMd(store.getDeliverySnapshot(snapshot.id))
  assert.ok(!md.includes('\r'))
  assert.ok(!md.includes('\n```'))

  const { execFileSync } = await import('node:child_process')
  const rendered = execFileSync('python3', ['-c', 'import sys; from markdown_it import MarkdownIt; print(MarkdownIt("commonmark").render(sys.stdin.read()))'], {
    input: md,
    encoding: 'utf8'
  })
  assert.ok(!rendered.includes('<pre>'))
  assert.ok(!rendered.includes('<code>'))
  assert.ok(!rendered.includes('<blockquote>'))
  assert.ok(rendered.includes('冻结依据'))
  assert.ok(rendered.includes('需求就绪'))
  assert.ok(rendered.includes('测试验收'))
})

test('delivery snapshot：CLI capture / list / get 全链路', async (t) => {
  const tmp = await tempHome()
  const home = tmp.dir
  const store = tmp.store.createStore(tmp.openDb())
  const p = store.createNode({ type: 'project', name: 'P' })
  const r = store.createNode({ parentId: p.id, type: 'requirement', name: 'R' })
  store.upsertDocument(r.id, '需求内容', '需求正文')
  store.upsertDocument(r.id, '概要设计', '设计正文')
  const c = store.upsertTestCase(r.id, { name: '回归用例', prompt: '跑单测' })
  const report = store.createTestReport(r.id, { caseId: c.id, status: 'running', kind: 'regression' })
  store.finishTestReport(report.id, { status: 'pass' })
  store.upsertAcceptanceSignoff(r.id, { decision: 'accepted', comment: '验收通过' })
  t.after(() => tmp.cleanup())

  const env = { ...process.env, TASKBOARD_HOME: home }
  const captured = JSON.parse(
    (await execFileP('node', [CLI, 'delivery', 'snapshot', 'P/R', '--note', 'CLI 留痕'], { env, encoding: 'utf8' })).stdout
  )
  assert.equal(captured.decision, 'ready')
  assert.equal(captured.note, 'CLI 留痕')

  const listed = JSON.parse(
    (await execFileP('node', [CLI, 'delivery', 'snapshots', 'P/R'], { env, encoding: 'utf8' })).stdout
  )
  assert.equal(listed.length, 1)
  assert.equal(listed[0].drift.status, 'current')

  const one = JSON.parse(
    (await execFileP('node', [CLI, 'delivery', 'snapshot-get', String(captured.id)], { env, encoding: 'utf8' })).stdout
  )
  assert.equal(one.id, captured.id)
})

test('delivery snapshot：MCP 真实协议捕获 / 列表 / 读取', async (t) => {
  const tmp = await tempHome()
  const store = tmp.store.createStore(tmp.openDb())
  const { createMcpServer } = await import('../server/mcp.mjs')
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js')
  const server = createMcpServer({ store })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: 'taskboard-delivery-snapshot-test', version: '1.0.0' })
  await client.connect(clientTransport)
  t.after(async () => {
    await client.close()
    await server.close()
    tmp.cleanup()
  })

  const p = store.createNode({ type: 'project', name: 'P' })
  const r = store.createNode({ parentId: p.id, type: 'requirement', name: 'R' })
  store.upsertDocument(r.id, '需求内容', '需求正文')
  store.upsertDocument(r.id, '概要设计', '设计正文')
  const c = store.upsertTestCase(r.id, { name: '回归用例', prompt: '跑单测' })
  const report = store.createTestReport(r.id, { caseId: c.id, status: 'running', kind: 'regression' })
  store.finishTestReport(report.id, { status: 'pass' })
  store.upsertAcceptanceSignoff(r.id, { decision: 'accepted', comment: '验收通过' })

  const capturedOut = await client.callTool({
    name: 'delivery_snapshot_capture',
    arguments: { node: r.id, scope: 'self', note: 'MCP 留痕' }
  })
  assert.equal(capturedOut.isError, undefined)
  const captured = JSON.parse(capturedOut.content[0].text)
  assert.equal(captured.decision, 'ready')
  assert.equal(captured.createdBy, 'mcp')

  const listedOut = await client.callTool({ name: 'delivery_snapshot_list', arguments: { node: r.id } })
  const listed = JSON.parse(listedOut.content[0].text)
  assert.equal(listed.length, 1)
  assert.equal(listed[0].drift.status, 'current')

  const oneOut = await client.callTool({ name: 'delivery_snapshot_get', arguments: { id: captured.id, format: 'md' } })
  assert.match(oneOut.content[0].text, /MCP 留痕/)
})

test('delivery snapshot：HTTP / CLI / MCP 的 markdown 输出逐字一致且保持转义', async (t) => {
  const tmp = await tempHome()
  const home = tmp.dir
  const store = tmp.store.createStore(tmp.openDb())
  const p = store.createNode({ type: 'project', name: 'P' })
  const r = store.createNode({ parentId: p.id, type: 'requirement', name: 'R\n|标题\\' })
  store.upsertDocument(r.id, '需求内容', '需求正文')
  store.upsertDocument(r.id, '概要设计', '设计正文')
  const c = store.upsertTestCase(r.id, { name: '回归用例', prompt: '跑单测' })
  const report = store.createTestReport(r.id, { caseId: c.id, status: 'running', kind: 'regression' })
  store.finishTestReport(report.id, { status: 'pass' })
  store.upsertAcceptanceSignoff(r.id, { decision: 'accepted', comment: '验收通过' })
  const snapshot = store.captureDeliverySnapshot(r.id, { note: 'A|B\\C\nD' })

  const { createApp } = await import('../server/http.mjs')
  const app = createApp({ store })
  const server = await new Promise((resolve, reject) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s))
    s.once('error', reject)
  })
  const base = `http://127.0.0.1:${server.address().port}`
  const { createMcpServer } = await import('../server/mcp.mjs')
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js')
  const mcp = createMcpServer({ store })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await mcp.connect(serverTransport)
  const client = new Client({ name: 'taskboard-snapshot-md-consistency', version: '1.0.0' })
  await client.connect(clientTransport)
  t.after(async () => {
    await client.close()
    await mcp.close()
    await new Promise((resolve) => server.close(resolve))
    tmp.cleanup()
  })

  const { stdout: cliMd } = await execFileP('node', [CLI, 'delivery', 'snapshot-get', String(snapshot.id), '--format', 'md'], {
    env: { ...process.env, TASKBOARD_HOME: home },
    encoding: 'utf8'
  })
  const httpMd = await fetch(`${base}/api/delivery-snapshots/${snapshot.id}?format=md`).then((x) => x.text())
  const mcpMd = (await client.callTool({ name: 'delivery_snapshot_get', arguments: { id: snapshot.id, format: 'md' } })).content[0].text
  const expected = (await import('../server/ops.mjs')).renderDeliverySnapshotMd(store.getDeliverySnapshot(snapshot.id))

  assert.equal(httpMd, expected)
  assert.equal(cliMd.trimEnd(), expected)
  assert.equal(mcpMd, expected)
  assert.ok(expected.includes('R \\|标题\\'))
  assert.ok(expected.includes('备注：A\\|B\\\\C D'))
  assert.ok(!expected.includes('\n## 注入标题'))
})

test('delivery snapshot：HTTP / CLI / MCP 的上线项漂移矩阵一致', async (t) => {
  const tmp = await tempHome()
  const home = tmp.dir
  const store = tmp.store.createStore(tmp.openDb())
  const p = store.createNode({ type: 'project', name: 'P' })
  const r = store.createNode({ parentId: p.id, type: 'requirement', name: 'R' })
  store.upsertDocument(r.id, '需求内容', '需求正文')
  store.upsertDocument(r.id, '概要设计', '设计正文')
  const c = store.upsertTestCase(r.id, { name: '回归用例', prompt: '跑单测' })
  const report = store.createTestReport(r.id, { caseId: c.id, status: 'running', kind: 'regression' })
  store.finishTestReport(report.id, { status: 'pass' })
  store.upsertAcceptanceSignoff(r.id, { decision: 'accepted', comment: '验收通过' })
  const item = store.createReleaseItem(r.id, { name: '上线项', kind: 'sql', content: 'ALTER TABLE x', status: 'done' })
  const snapshot = store.captureDeliverySnapshot(r.id)

  const { createApp } = await import('../server/http.mjs')
  const app = createApp({ store })
  const server = await new Promise((resolve, reject) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s))
    s.once('error', reject)
  })
  const base = `http://127.0.0.1:${server.address().port}`
  const { createMcpServer } = await import('../server/mcp.mjs')
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js')
  const mcp = createMcpServer({ store })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await mcp.connect(serverTransport)
  const client = new Client({ name: 'taskboard-snapshot-drift-consistency', version: '1.0.0' })
  await client.connect(clientTransport)
  t.after(async () => {
    await client.close()
    await mcp.close()
    await new Promise((resolve) => server.close(resolve))
    tmp.cleanup()
  })

  const read = async () => {
    const http = await fetch(`${base}/api/delivery-snapshots/${snapshot.id}`).then((x) => x.json())
    const { stdout } = await execFileP('node', [CLI, 'delivery', 'snapshot-get', String(snapshot.id)], {
      env: { ...process.env, TASKBOARD_HOME: home },
      encoding: 'utf8'
    })
    const cli = JSON.parse(stdout)
    const mcp = JSON.parse((await client.callTool({ name: 'delivery_snapshot_get', arguments: { id: snapshot.id } })).content[0].text)
    return [http.drift.status, cli.drift.status, mcp.drift.status]
  }

  assert.deepEqual(await read(), ['current', 'current', 'current'])
  store.updateReleaseItem(item.id, { name: '上线项改名' })
  assert.deepEqual(await read(), ['current', 'current', 'current'])
  store.updateReleaseItem(item.id, { name: '上线项改名', kind: 'sql', content: 'ALTER TABLE x', status: 'done' })
  assert.deepEqual(await read(), ['current', 'current', 'current'])
  store.updateReleaseItem(item.id, { status: 'pending' })
  assert.deepEqual(await read(), ['drifted', 'drifted', 'drifted'])
})

test('delivery snapshot：能力清单登记三入口 1:1', async () => {
  const { TOOLS } = await import('../server/ops.mjs')
  assert.ok(TOOLS.includes('delivery_snapshot_capture'))
  assert.ok(TOOLS.includes('delivery_snapshot_list'))
  assert.ok(TOOLS.includes('delivery_snapshot_get'))
})
