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
