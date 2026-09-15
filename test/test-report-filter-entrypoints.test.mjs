import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { tempHome } from './helpers.mjs'

const execFileP = promisify(execFile)
const CLI = path.resolve(import.meta.dirname, '../bin/taskboard.js')

/**
 * 造「报告数 > 默认 limit(100)」的数据：旧用例 c1 的 5 条报告会被后续 150 条挤出窗口。
 * 修复前：先 LIMIT 100 再在内存里过滤 → 按 caseId / kind 都筛出空列表。
 */
function seed(store) {
  const p = store.createNode({ type: 'project', name: 'P' })
  const r = store.createNode({ parentId: p.id, type: 'requirement', name: 'R' })
  const c1 = store.createTestCase(r.id, { name: '旧用例', prompt: 'p', kind: 'acceptance' })
  for (let i = 0; i < 5; i += 1) store.createTestReport(r.id, { caseId: c1.id, kind: 'acceptance' })
  const c2 = store.createTestCase(r.id, { name: '新用例', prompt: 'p', kind: 'regression' })
  for (let i = 0; i < 150; i += 1) store.createTestReport(r.id, { caseId: c2.id, kind: 'regression' })
  return { p, r, c1, c2 }
}

test('报告筛选 > limit：store 与 HTTP 按 caseId / kind 都能筛到旧报告', async (t) => {
  const tmp = await tempHome()
  const store = tmp.store.createStore(tmp.openDb())
  const { r, c1 } = seed(store)
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

  const viaStore = store.listTestReports(r.id, { caseId: c1.id })
  assert.equal(viaStore.length, 5)

  const byCase = await fetch(`${base}/api/nodes/${r.id}/test-reports?caseId=${c1.id}`).then((x) => x.json())
  assert.equal(byCase.length, 5)
  assert.deepEqual(byCase, viaStore)

  const byKind = await fetch(`${base}/api/nodes/${r.id}/test-reports?kind=acceptance`).then((x) => x.json())
  assert.equal(byKind.length, 5)
  assert.equal(byKind.every((x) => x.kind === 'acceptance'), true)

  // 未过滤时仍是默认窗口 100 条
  assert.equal((await fetch(`${base}/api/nodes/${r.id}/test-reports`).then((x) => x.json())).length, 100)
})

test('报告筛选 > limit：CLI 与 MCP 与 store 逐字段一致', async (t) => {
  const tmp = await tempHome()
  const home = tmp.dir
  const store = tmp.store.createStore(tmp.openDb())
  const { r, c1 } = seed(store)
  t.after(() => tmp.cleanup())

  const viaStoreCase = store.listTestReports(r.id, { caseId: c1.id })
  const viaStoreKind = store.listTestReports(r.id, { kind: 'acceptance' })
  assert.equal(viaStoreCase.length, 5)
  assert.equal(viaStoreKind.length, 5)

  // CLI 真实子进程：用节点 id 引用，避免路径歧义
  const cliByCase = JSON.parse(
    (
      await execFileP('node', [CLI, 'test', 'report', 'list', String(r.id), '--case-id', String(c1.id)], {
        env: { ...process.env, TASKBOARD_HOME: home },
        encoding: 'utf8'
      })
    ).stdout
  )
  assert.equal(cliByCase.length, 5)
  assert.deepEqual(cliByCase, viaStoreCase)

  const cliByKind = JSON.parse(
    (
      await execFileP('node', [CLI, 'test', 'report', 'list', String(r.id), '--kind', 'acceptance'], {
        env: { ...process.env, TASKBOARD_HOME: home },
        encoding: 'utf8'
      })
    ).stdout
  )
  assert.equal(cliByKind.length, 5)
  assert.deepEqual(cliByKind, viaStoreKind)

  // MCP 真实协议：同一个 store
  const { createMcpServer } = await import('../server/mcp.mjs')
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js')
  const server = createMcpServer({ store })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: 'taskboard-test-report-filter-test', version: '1.0.0' })
  await client.connect(clientTransport)
  t.after(async () => {
    await client.close()
    await server.close()
  })

  const mcpByCase = await client.callTool({ name: 'test_report_list', arguments: { node: r.id, caseId: c1.id } })
  assert.equal(mcpByCase.isError, undefined)
  assert.deepEqual(JSON.parse(mcpByCase.content[0].text), viaStoreCase)

  const mcpByKind = await client.callTool({ name: 'test_report_list', arguments: { node: r.id, kind: 'acceptance' } })
  assert.equal(mcpByKind.isError, undefined)
  assert.deepEqual(JSON.parse(mcpByKind.content[0].text), viaStoreKind)
})
