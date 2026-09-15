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
  const home = tmp.dir
  const store = tmp.store.createStore(tmp.openDb())
  const p = store.createNode({ type: 'project', name: 'P' })
  const r = store.createRequirement({ projectId: p.id, name: 'R' })
  store.upsertDocument(r.id, '需求内容', '需求正文')
  const { createApp } = await import('../server/http.mjs')
  const app = createApp({ store })
  const server = await new Promise((resolve, reject) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s))
    s.once('error', reject)
  })
  return {
    tmp,
    home,
    store,
    expected: store.documentOverview({ projectId: p.id }),
    base: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((r) => server.close(r))
  }
}

test('document overview：HTTP 与 store 结果一致', async (t) => {
  const ctx = await setup()
  t.after(async () => {
    await ctx.close()
    ctx.tmp.cleanup()
  })
  const out = await fetch(`${ctx.base}/api/documents/overview?projectId=1`).then((r) => r.json())
  assert.deepEqual(out, ctx.expected)
  const bad = await fetch(`${ctx.base}/api/documents/overview?projectId=abc`).then(async (r) => ({ status: r.status, body: await r.json() }))
  assert.equal(bad.status, 400)
  assert.equal(bad.body.error.code, 'VALIDATION_FAILED')
})

test('document overview：CLI 与 store 结果一致', async (t) => {
  const ctx = await setup()
  t.after(async () => {
    await ctx.close()
    ctx.tmp.cleanup()
  })
  const { stdout } = await execFileP('node', [CLI, 'document', 'overview', '--project', 'P'], {
    env: { ...process.env, TASKBOARD_HOME: ctx.home },
    encoding: 'utf8'
  })
  assert.deepEqual(JSON.parse(stdout), ctx.expected)
})

test('document overview：MCP 与 store 结果一致', async (t) => {
  const ctx = await setup()
  t.after(async () => {
    await ctx.close()
    ctx.tmp.cleanup()
  })
  const { createMcpServer } = await import('../server/mcp.mjs')
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js')
  const server = createMcpServer({ store: ctx.store })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: 'taskboard-document-overview-test', version: '1.0.0' })
  await client.connect(clientTransport)
  t.after(async () => {
    await client.close()
    await server.close()
  })

  const out = await client.callTool({ name: 'document_overview', arguments: { project: 'P' } })
  assert.equal(out.isError, undefined)
  assert.deepEqual(JSON.parse(out.content[0].text), ctx.expected)

  const bad = await client.callTool({ name: 'document_overview', arguments: { project: 'P', fill: 'bogus' } })
  assert.equal(bad.isError, true)
  assert.match(bad.content[0].text, /VALIDATION_FAILED/)
})
