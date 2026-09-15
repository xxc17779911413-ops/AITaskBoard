import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { tempHome } from './helpers.mjs'

const execFileP = promisify(execFile)
const CLI = path.resolve(import.meta.dirname, '../bin/taskboard.js')

async function mcpClient() {
  const tmp = await tempHome()
  const store = tmp.store.createStore(tmp.openDb())
  const { createMcpServer } = await import('../server/mcp.mjs')
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js')
  const server = createMcpServer({ store })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: 'taskboard-delivery-gate-test', version: '1.0.0' })
  await client.connect(clientTransport)
  const call = (name, args) => client.callTool({ name, arguments: args })
  return {
    tmp,
    store,
    call,
    close: async () => {
      await client.close()
      await server.close()
    }
  }
}

function seedGate(store) {
  const p = store.createNode({ type: 'project', name: 'P' })
  const r = store.createNode({ parentId: p.id, type: 'requirement', name: 'R' })
  store.upsertDocument(r.id, '需求内容', '需求正文')
  store.upsertDocument(r.id, '概要设计', '设计正文')
  const testCase = store.upsertTestCase(r.id, { name: '回归用例', prompt: '跑单测' })
  return { p, r, testCase }
}

test('MCP delivery_gate：真实调用返回 JSON，与 store 结果逐字段一致', async (t) => {
  const { tmp, store, call, close } = await mcpClient()
  t.after(async () => {
    await close()
    tmp.cleanup()
  })
  const { r, testCase } = seedGate(store)
  store.createTestReport(r.id, { caseId: testCase.id, status: 'running', kind: 'regression' })

  const out = await call('delivery_gate', { node: r.id })
  assert.equal(out.isError, undefined)
  const viaMcp = JSON.parse(out.content[0].text)
  const { buildDeliveryGateFull } = await import('../server/ops.mjs')
  const viaStore = await buildDeliveryGateFull(store, r.id)
  assert.deepEqual(viaMcp, viaStore)
  assert.equal(viaMcp.decision, 'not_ready')
  assert.equal(viaMcp.sources.find((s) => s.key === 'acceptance').evidence.totals.running, 1)
})

test('MCP delivery_gate：scope=subtree 与 store 结果逐字段一致', async (t) => {
  const { tmp, store, call, close } = await mcpClient()
  t.after(async () => {
    await close()
    tmp.cleanup()
  })
  const { p, r } = seedGate(store)
  store.createNode({ parentId: r.id, type: 'subreq', name: 'S' })

  const out = await call('delivery_gate', { node: p.id, scope: 'subtree' })
  const viaMcp = JSON.parse(out.content[0].text)
  const { buildDeliveryGateFull } = await import('../server/ops.mjs')
  assert.deepEqual(viaMcp, await buildDeliveryGateFull(store, p.id, { scope: 'subtree' }))
  assert.equal(viaMcp.scope, 'subtree')
})

test('MCP delivery_gate：format=md 与 renderDeliveryGateMd 一致', async (t) => {
  const { tmp, store, call, close } = await mcpClient()
  t.after(async () => {
    await close()
    tmp.cleanup()
  })
  const { r } = seedGate(store)
  const { renderDeliveryGateMd, buildDeliveryGateFull } = await import('../server/ops.mjs')
  const out = await call('delivery_gate', { node: r.id, format: 'md' })
  assert.equal(out.content[0].text, renderDeliveryGateMd(await buildDeliveryGateFull(store, r.id)))
})

test('MCP delivery_gate：非法 scope/format 返回 VALIDATION_FAILED（不再泄漏 -32602 协议错误）', async (t) => {
  const { tmp, store, call, close } = await mcpClient()
  t.after(async () => {
    await close()
    tmp.cleanup()
  })
  const { r } = seedGate(store)
  for (const args of [
    { node: r.id, scope: 'sub' },
    { node: r.id, format: 'xml' }
  ]) {
    const out = await call('delivery_gate', args)
    assert.equal(out.isError, true)
    assert.match(out.content[0].text, /VALIDATION_FAILED/)
    assert.ok(!/MCP error -32602/.test(out.content[0].text))
  }
})

test('四入口一致性：store / HTTP / CLI / MCP 的 delivery_gate 返回逐字段一致', async (t) => {
  const tmp = await tempHome()
  const home = tmp.dir
  const store = tmp.store.createStore(tmp.openDb())
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
  const client = new Client({ name: 'taskboard-four-way-test', version: '1.0.0' })
  await client.connect(clientTransport)

  t.after(async () => {
    await client.close()
    await mcp.close()
    await new Promise((r) => server.close(r))
    tmp.cleanup()
  })

  const { r, testCase } = seedGate(store)
  store.createTestReport(r.id, { caseId: testCase.id, status: 'running', kind: 'regression' })
  const { buildDeliveryGateFull } = await import('../server/ops.mjs')
  const expected = await buildDeliveryGateFull(store, r.id)

  const httpOut = await fetch(`${base}/api/nodes/${r.id}/delivery-gate`).then((x) => x.json())
  const mcpOut = JSON.parse((await client.callTool({ name: 'delivery_gate', arguments: { node: r.id } })).content[0].text)
  const { stdout } = await execFileP('node', [CLI, 'delivery', 'gate', 'P/R'], {
    env: { ...process.env, TASKBOARD_HOME: home },
    encoding: 'utf8'
  })
  const cliOut = JSON.parse(stdout)

  assert.deepEqual(httpOut, expected)
  assert.deepEqual(mcpOut, expected)
  assert.deepEqual(cliOut, expected)
})
