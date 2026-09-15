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
  return { tmp, store, p, r }
}

test('D2回归：normalizeFormat 值域与错误码', async (t) => {
  const { tmp, store } = await setup()
  t.after(() => tmp.cleanup())
  assert.equal(store.normalizeFormat(undefined), 'json')
  assert.equal(store.normalizeFormat(null), 'json')
  assert.equal(store.normalizeFormat('json'), 'json')
  assert.equal(store.normalizeFormat('md'), 'md')
  for (const bad of ['xml', 'JSON', 'MD', '', ' ']) {
    assert.throws(
      () => store.normalizeFormat(bad),
      (e) => e.code === 'VALIDATION_FAILED' && Array.isArray(e.details.allowed) && e.details.allowed.join(',') === 'json,md'
    )
  }
})

test('D2回归：非法 format 在 REST / CLI 一致拒绝，revision 不变', async (t) => {
  const { tmp, store, r } = await setup()
  t.after(() => tmp.cleanup())
  const { createApp } = await import('../server/http.mjs')
  const app = createApp({ store })
  const server = await new Promise((resolve, reject) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s))
    s.once('error', reject)
  })
  const base = `http://127.0.0.1:${server.address().port}`
  const before = store.getRevision()
  try {
    const rest = await fetch(`${base}/api/nodes/${r.id}/workflow-map?format=xml`)
    assert.equal(rest.status, 400)
    const body = await rest.json()
    assert.equal(body.error.code, 'VALIDATION_FAILED')
    assert.deepEqual(body.error.details.allowed, ['json', 'md'])

    let cliError = null
    try {
      await execFileP('node', [CLI, 'workflow', 'map', String(r.id), '--format', 'xml'], {
        env: { ...process.env, TASKBOARD_HOME: tmp.dir },
        encoding: 'utf8'
      })
    } catch (e) {
      cliError = e
    }
    assert.ok(cliError, 'CLI 非法 format 应当非零退出')
    assert.match(String(cliError.stderr || '') + String(cliError.stdout || ''), /VALIDATION_FAILED/)

    assert.equal(store.getRevision(), before)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('D2回归：非法 format 在 MCP 返回 isError，revision 不变', async (t) => {
  const { tmp, store, r } = await setup()
  const { createMcpServer } = await import('../server/mcp.mjs')
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js')
  const mcpServer = createMcpServer({ store })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await mcpServer.connect(serverTransport)
  const client = new Client({ name: 'taskboard-format-test', version: '1.0.0' })
  await client.connect(clientTransport)
  t.after(async () => {
    await client.close()
    await mcpServer.close()
    tmp.cleanup()
  })
  const before = store.getRevision()
  const mcp = await client.callTool({ name: 'workflow_map', arguments: { node: r.id, format: 'xml' } })
  assert.equal(mcp.isError, true)
  assert.match(mcp.content[0].text, /VALIDATION_FAILED/)
  assert.equal(store.getRevision(), before)
})

test('D5回归：MCP acceptance_report 非法 format 返回 isError，revision 不变', async (t) => {
  const { tmp, store, r } = await setup()
  const { createMcpServer } = await import('../server/mcp.mjs')
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js')
  const mcpServer = createMcpServer({ store })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await mcpServer.connect(serverTransport)
  const client = new Client({ name: 'taskboard-format-test', version: '1.0.0' })
  await client.connect(clientTransport)
  t.after(async () => {
    await client.close()
    await mcpServer.close()
    tmp.cleanup()
  })
  const before = store.getRevision()
  const mcp = await client.callTool({ name: 'acceptance_report', arguments: { node: r.id, format: 'xml' } })
  assert.equal(mcp.isError, true)
  assert.match(mcp.content[0].text, /VALIDATION_FAILED/)
  assert.equal(store.getRevision(), before)
})
