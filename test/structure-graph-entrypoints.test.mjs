import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { tempHome } from './helpers.mjs'

const execFileP = promisify(execFile)
const CLI = path.resolve(import.meta.dirname, '../bin/taskboard.js')

function seed(store) {
  const p = store.createNode({ type: 'project', name: 'P' })
  const r = store.createNode({ parentId: p.id, type: 'requirement', name: 'R' })
  const s = store.createNode({ parentId: r.id, type: 'subreq', name: 'S' })
  store.upsertDocument(r.id, '需求内容', '需求正文')
  store.upsertDocument(r.id, '概要设计', '设计正文')
  store.createTestCase(r.id, { name: '回归用例', prompt: '跑单测' })
  store.upsertDocument(s.id, '需求内容', '子需求正文') // S 缺概要设计
  return { p, r, s }
}

test('structure_graph：store / HTTP 逐字段一致，md 导出可用，非法筛选拒绝', async (t) => {
  const tmp = await tempHome()
  const store = tmp.store.createStore(tmp.openDb())
  const { p } = seed(store)
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

  const viaStore = store.buildStructureGraph(p.id, { scope: 'subtree' })
  const viaHttp = await fetch(`${base}/api/nodes/${p.id}/structure-graph?scope=subtree`).then((x) => x.json())
  assert.deepEqual(viaHttp, viaStore)
  assert.equal(viaHttp.totals.nodes, 3)
  assert.equal(viaHttp.totals.gapNodes, 1)

  // 筛选一致性：hasGap=true 只留 S
  const gaps = await fetch(`${base}/api/nodes/${p.id}/structure-graph?scope=subtree&hasGap=true`).then((x) => x.json())
  assert.deepEqual(gaps.nodes.map((n) => n.name), ['S'])

  const md = await fetch(`${base}/api/nodes/${p.id}/structure-graph?scope=subtree&format=md`).then((x) => x.text())
  assert.ok(md.startsWith('# 结构探索'))
  assert.ok(md.includes('S'))

  for (const qs of ['scope=sub', 'type=bogus', 'status=bogus', 'ready=maybe', 'hasGap=maybe', 'caseStatus=bogus', 'format=xml']) {
    const res = await fetch(`${base}/api/nodes/${p.id}/structure-graph?${qs}`)
    assert.equal(res.status, 400, qs)
    assert.equal((await res.json()).error.code, 'VALIDATION_FAILED', qs)
  }
})

test('structure_graph：CLI 与 MCP 与 store 逐字段一致', async (t) => {
  const tmp = await tempHome()
  const home = tmp.dir
  const store = tmp.store.createStore(tmp.openDb())
  const { p } = seed(store)
  t.after(() => tmp.cleanup())

  const viaStore = store.buildStructureGraph(p.id, { scope: 'subtree', hasGap: true })
  assert.deepEqual(viaStore.nodes.map((n) => n.name), ['S'])

  // CLI 真实子进程
  const cliOut = JSON.parse(
    (
      await execFileP('node', [CLI, 'structure', 'graph', String(p.id), '--scope', 'subtree', '--has-gap', 'true'], {
        env: { ...process.env, TASKBOARD_HOME: home },
        encoding: 'utf8'
      })
    ).stdout
  )
  assert.deepEqual(cliOut, viaStore)

  // CLI md
  const cliMd = (
    await execFileP('node', [CLI, 'structure', 'graph', String(p.id), '--scope', 'subtree', '--format', 'md'], {
      env: { ...process.env, TASKBOARD_HOME: home },
      encoding: 'utf8'
    })
  ).stdout
  assert.ok(cliMd.startsWith('# 结构探索'))

  // MCP 真实协议
  const { createMcpServer } = await import('../server/mcp.mjs')
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js')
  const server = createMcpServer({ store })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: 'taskboard-structure-graph-test', version: '1.0.0' })
  await client.connect(clientTransport)
  t.after(async () => {
    await client.close()
    await server.close()
  })

  const mcpOut = await client.callTool({ name: 'structure_graph', arguments: { node: p.id, scope: 'subtree', hasGap: 'true' } })
  assert.equal(mcpOut.isError, undefined)
  assert.deepEqual(JSON.parse(mcpOut.content[0].text), viaStore)

  // MCP 非法值 → isError + VALIDATION_FAILED（不泄漏协议错误）
  const mcpBad = await client.callTool({ name: 'structure_graph', arguments: { node: p.id, caseStatus: 'bogus' } })
  assert.equal(mcpBad.isError, true)
  assert.match(mcpBad.content[0].text, /VALIDATION_FAILED/)
})
