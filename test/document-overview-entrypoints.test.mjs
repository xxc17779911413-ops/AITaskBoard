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

test('document overview：未知项目在 HTTP / CLI / MCP 一律空态（不是 NOT_FOUND / PATH_NOT_FOUND）', async (t) => {
  const ctx = await setup()
  t.after(async () => {
    await ctx.close()
    ctx.tmp.cleanup()
  })
  const expectedEmpty = ctx.store.documentOverview({ projectRef: 999999 })

  // HTTP：未知数字 id 走空态；未知路径与非法数字仍按既有契约处理
  const httpUnknownId = await fetch(`${ctx.base}/api/documents/overview?projectId=999999`).then(async (r) => ({ status: r.status, body: await r.json() }))
  assert.equal(httpUnknownId.status, 200)
  assert.equal(httpUnknownId.body.summary.requirementCount, 0)
  assert.deepEqual(httpUnknownId.body.items, [])
  const httpBadId = await fetch(`${ctx.base}/api/documents/overview?projectId=abc`).then((r) => r.status)
  assert.equal(httpBadId, 400)

  // CLI：未知数字 id 与未知路径都不得抛 NOT_FOUND / PATH_NOT_FOUND，而是空态 JSON
  const cliById = await execFileP('node', [CLI, 'document', 'overview', '--project', '999999'], {
    env: { ...process.env, TASKBOARD_HOME: ctx.home },
    encoding: 'utf8'
  })
  const cliByIdOut = JSON.parse(cliById.stdout)
  assert.equal(cliByIdOut.summary.requirementCount, 0)
  assert.deepEqual(cliByIdOut.items, [])
  assert.deepEqual(cliByIdOut, expectedEmpty)

  const cliByPath = await execFileP('node', [CLI, 'document', 'overview', '--project', '不存在项目'], {
    env: { ...process.env, TASKBOARD_HOME: ctx.home },
    encoding: 'utf8'
  })
  const cliByPathOut = JSON.parse(cliByPath.stdout)
  assert.equal(cliByPathOut.summary.requirementCount, 0)

  // MCP：未知数字 id 与未知路径都返回空态，而不是 isError
  const { createMcpServer } = await import('../server/mcp.mjs')
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js')
  const server = createMcpServer({ store: ctx.store })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: 'taskboard-document-overview-unknown-test', version: '1.0.0' })
  await client.connect(clientTransport)
  t.after(async () => {
    await client.close()
    await server.close()
  })

  const mcpById = await client.callTool({ name: 'document_overview', arguments: { project: '999999' } })
  assert.equal(mcpById.isError, undefined)
  const mcpByIdOut = JSON.parse(mcpById.content[0].text)
  assert.equal(mcpByIdOut.summary.requirementCount, 0)
  assert.deepEqual(mcpByIdOut.items, [])
  assert.deepEqual(mcpByIdOut, expectedEmpty)

  const mcpByPath = await client.callTool({ name: 'document_overview', arguments: { project: '不存在项目' } })
  assert.equal(mcpByPath.isError, undefined)
  assert.equal(JSON.parse(mcpByPath.content[0].text).summary.requirementCount, 0)

  // 三入口未知项目的空态结果逐字段一致
  assert.deepEqual(cliByIdOut, httpUnknownId.body)
  assert.deepEqual(mcpByIdOut, httpUnknownId.body)
})
