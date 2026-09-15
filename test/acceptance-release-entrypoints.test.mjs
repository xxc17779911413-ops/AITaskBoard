import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { tempHome } from './helpers.mjs'

const execFileP = promisify(execFile)
const CLI = path.resolve(import.meta.dirname, '../bin/taskboard.js')

/** 需求文档 + 概要设计 + 回归用例 + pass 报告，使验收结论 pass */
function seedAcceptance(store, nodeId) {
  store.upsertDocument(nodeId, '需求内容', '需求正文')
  store.upsertDocument(nodeId, '概要设计', '设计正文')
  const c = store.upsertTestCase(nodeId, { name: '回归用例', prompt: '跑单测' })
  const rep = store.createTestReport(nodeId, { caseId: c.id, kind: 'regression', status: 'running' })
  store.finishTestReport(rep.id, { status: 'pass', summary: '全绿' })
  return c
}

test('验收结论：store 与 HTTP 逐字段一致，format=md 可导出；非法 scope 拒绝', async (t) => {
  const tmp = await tempHome()
  const store = tmp.store.createStore(tmp.openDb())
  const p = store.createNode({ type: 'project', name: 'P' })
  const r = store.createNode({ parentId: p.id, type: 'requirement', name: 'R' })
  seedAcceptance(store, r.id)
  const { createApp } = await import('../server/http.mjs')
  const app = createApp({ store })
  const server = await new Promise((resolve, reject) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s))
    s.once('error', reject)
  })
  const base = `http://127.0.0.1:${server.address().port}`
  t.after(async () => {
    await new Promise((res) => server.close(res))
    tmp.cleanup()
  })

  const viaStore = store.buildAcceptanceConclusion(r.id)
  assert.equal(viaStore.decision, 'accepted')

  const viaHttp = await fetch(`${base}/api/nodes/${r.id}/acceptance-conclusion`).then((x) => x.json())
  assert.deepEqual(viaHttp, viaStore)

  const md = await fetch(`${base}/api/nodes/${r.id}/acceptance-conclusion?format=md`).then((x) => x.text())
  assert.ok(md.startsWith('# 验收结论'))
  assert.ok(md.includes('验收通过'))

  const bad = await fetch(`${base}/api/nodes/${r.id}/acceptance-conclusion?scope=sub`).then(async (x) => ({ status: x.status, body: await x.json() }))
  assert.equal(bad.status, 400)
  assert.equal(bad.body.error.code, 'VALIDATION_FAILED')
})

test('验收结论 + 上线清单：CLI 与 MCP 与 store 逐字段一致（含检查用例阻塞）', async (t) => {
  const tmp = await tempHome()
  const home = tmp.dir
  const store = tmp.store.createStore(tmp.openDb())
  const p = store.createNode({ type: 'project', name: 'P' })
  const r = store.createNode({ parentId: p.id, type: 'requirement', name: 'R' })
  seedAcceptance(store, r.id)
  // 上线：必做项 done，但代码检查从没跑 → 清单/交付门禁都应阻塞
  store.createReleaseItem(r.id, { name: '开灰度开关', kind: 'config', status: 'done' })
  store.createTestCase(r.id, { name: '静态检查', prompt: '跑 lint', kind: 'code_check' })

  const viaStoreConclusion = store.buildAcceptanceConclusion(r.id)
  const viaStoreChecklist = store.buildReleaseChecklist(r.id)
  assert.equal(viaStoreChecklist.ready, false)

  t.after(() => tmp.cleanup())

  // CLI 真实子进程
  const cliConclusion = JSON.parse(
    (
      await execFileP('node', [CLI, 'acceptance', 'conclusion', String(r.id)], {
        env: { ...process.env, TASKBOARD_HOME: home },
        encoding: 'utf8'
      })
    ).stdout
  )
  assert.deepEqual(cliConclusion, viaStoreConclusion)

  const cliChecklist = JSON.parse(
    (
      await execFileP('node', [CLI, 'release', 'checklist', String(r.id)], {
        env: { ...process.env, TASKBOARD_HOME: home },
        encoding: 'utf8'
      })
    ).stdout
  )
  assert.deepEqual(cliChecklist, viaStoreChecklist)
  assert.equal(cliChecklist.totals.checkCases, 1)
  assert.equal(cliChecklist.caseBlockers[0].name, '静态检查')

  // MCP 真实协议
  const { createMcpServer } = await import('../server/mcp.mjs')
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js')
  const server = createMcpServer({ store })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: 'taskboard-acceptance-release-test', version: '1.0.0' })
  await client.connect(clientTransport)
  t.after(async () => {
    await client.close()
    await server.close()
  })

  const mcpConclusion = await client.callTool({ name: 'acceptance_conclusion', arguments: { node: r.id } })
  assert.equal(mcpConclusion.isError, undefined)
  assert.deepEqual(JSON.parse(mcpConclusion.content[0].text), viaStoreConclusion)

  const mcpChecklist = await client.callTool({ name: 'release_checklist', arguments: { node: r.id } })
  assert.equal(mcpChecklist.isError, undefined)
  assert.deepEqual(JSON.parse(mcpChecklist.content[0].text), viaStoreChecklist)
})

test('验收结论：按版本过滤后 KPI 等于明细求和，store / HTTP / CLI / MCP 一致', async (t) => {
  const tmp = await tempHome()
  const home = tmp.dir
  const store = tmp.store.createStore(tmp.openDb())
  const p = store.createNode({ type: 'project', name: 'P' })
  const r = store.createNode({ parentId: p.id, type: 'requirement', name: 'RQ3' })
  const s = store.createNode({ parentId: p.id, type: 'requirement', name: 'RQ4' })
  store.addAttrDef({ nodeType: 'requirement', key: 'version', label: '版本', dataType: 'text' })
  // 26Q3：1 pass；26Q4：1 pass + 1 fail
  const rc = seedAcceptance(store, r.id)
  const sc = seedAcceptance(store, s.id)
  const scFail = store.createTestCase(s.id, { name: '回归用例2', prompt: '再跑一次' })
  const failRep = store.createTestReport(s.id, { caseId: scFail.id, kind: 'regression', status: 'running' })
  store.finishTestReport(failRep.id, { status: 'fail', summary: '断言失败' })
  store.setAttrs(r.id, { version: '26Q3' })
  store.setAttrs(s.id, { version: '26Q4' })
  void rc
  void sc

  const viaStore = store.buildAcceptanceConclusion(p.id, { scope: 'subtree', version: '26Q3' })
  assert.equal(viaStore.totals.cases, 1)
  assert.equal(viaStore.totals.testPass, 1)
  assert.equal(viaStore.totals.testFail, 0)

  const { createApp } = await import('../server/http.mjs')
  const app = createApp({ store })
  const server = await new Promise((resolve, reject) => {
    const srv = app.listen(0, '127.0.0.1', () => resolve(srv))
    srv.once('error', reject)
  })
  const base = `http://127.0.0.1:${server.address().port}`

  t.after(async () => {
    await new Promise((res) => server.close(res))
    tmp.cleanup()
  })

  const viaHttp = await fetch(`${base}/api/nodes/${p.id}/acceptance-conclusion?scope=subtree&version=26Q3`).then((x) => x.json())
  assert.deepEqual(viaHttp, viaStore)
  // 与明细自洽：KPI == 逐需求求和
  assert.equal(viaHttp.totals.cases, viaHttp.items.reduce((a, i) => a + i.caseCount, 0))
  assert.equal(
    viaHttp.totals.testPass,
    viaHttp.items.reduce((a, i) => a + i.latestStatuses.filter((x) => x.status === 'pass').length, 0)
  )

  // markdown 导出也必须展示过滤后的数字（1 条用例、1 通过、0 未通过）
  const md = await fetch(`${base}/api/nodes/${p.id}/acceptance-conclusion?scope=subtree&version=26Q3&format=md`).then((x) => x.text())
  assert.ok(md.includes('测试用例：1 · 通过：1 · 未通过：0'))

  // CLI 真实子进程
  const cliOut = JSON.parse(
    (
      await execFileP('node', [CLI, 'acceptance', 'conclusion', String(p.id), '--scope', 'subtree', '--version', '26Q3'], {
        env: { ...process.env, TASKBOARD_HOME: home },
        encoding: 'utf8'
      })
    ).stdout
  )
  assert.deepEqual(cliOut, viaStore)

  // MCP 真实协议
  const { createMcpServer } = await import('../server/mcp.mjs')
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js')
  const mcpServer = createMcpServer({ store })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await mcpServer.connect(serverTransport)
  const client = new Client({ name: 'taskboard-version-kpi-test', version: '1.0.0' })
  await client.connect(clientTransport)
  t.after(async () => {
    await client.close()
    await mcpServer.close()
  })
  const mcpOut = await client.callTool({
    name: 'acceptance_conclusion',
    arguments: { node: p.id, scope: 'subtree', version: '26Q3' }
  })
  assert.equal(mcpOut.isError, undefined)
  assert.deepEqual(JSON.parse(mcpOut.content[0].text), viaStore)
})
