import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { tempHome } from './helpers.mjs'

const execFileP = promisify(execFile)
const CLI = path.resolve(import.meta.dirname, '../bin/taskboard.js')

/**
 * 三入口一致性回归：`release item upsert` 的「覆盖 vs 保留」语义必须在
 * store / HTTP / CLI / MCP 完全一致——入口**不得**把未传字段补成默认值再交给 store，
 * 否则重复 upsert 只传部分字段时，既有的 rollback / status / required 会被静默回退。
 * 背景：独立测试在 5c38748 上发现 CLI 与 MCP 在参数装配处补了默认值。
 */

async function httpServer() {
  const tmp = await tempHome()
  const db = tmp.openDb()
  const store = tmp.store.createStore(db)
  const { createApp } = await import('../server/http.mjs')
  const app = createApp({ store })
  const server = await new Promise((resolve, reject) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s))
    s.once('error', reject)
  })
  const base = `http://127.0.0.1:${server.address().port}`
  const post = (p, body) =>
    fetch(`${base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json())
  return { tmp, store, post, close: () => new Promise((r) => server.close(r)) }
}

async function mcpClient() {
  const tmp = await tempHome()
  const db = tmp.openDb()
  const store = tmp.store.createStore(db)
  const { createMcpServer } = await import('../server/mcp.mjs')
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js')
  const server = createMcpServer({ store })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: 'taskboard-test', version: '1.0.0' })
  await client.connect(clientTransport)
  const call = async (name, args) => {
    const out = await client.callTool({ name, arguments: args })
    return JSON.parse(out.content[0].text)
  }
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

async function cli(home, args) {
  const { stdout } = await execFileP('node', [CLI, ...args], {
    env: { ...process.env, TASKBOARD_HOME: home },
    encoding: 'utf8'
  })
  return JSON.parse(stdout)
}

const SEED = { kind: 'sql', content: 'v1', rollback: 'DROP INDEX idx_x', status: 'done', required: true }

// ---------- store 基线 ----------

test('一致性基线（store）：已存在时只传 content，保留 kind/rollback/status/required', async (t) => {
  const tmp = await tempHome()
  t.after(() => tmp.cleanup())
  const store = tmp.store.createStore(tmp.openDb())
  const p = store.createNode({ type: 'project', name: 'P' })
  const r = store.createNode({ parentId: p.id, type: 'requirement', name: 'R' })
  const first = store.upsertReleaseItem(r.id, { name: 'X', ...SEED })
  assert.equal(first.created, true)

  const second = store.upsertReleaseItem(r.id, { name: 'X', content: 'v2' })
  assert.equal(second.created, false)
  assert.equal(second.content, 'v2')
  assert.equal(second.kind, 'sql')
  assert.equal(second.rollback, 'DROP INDEX idx_x')
  assert.equal(second.status, 'done')
  assert.equal(second.required, true)
})

// ---------- HTTP ----------

test('一致性（HTTP）：已存在时只传 content，保留既有字段', async (t) => {
  const { tmp, post, close } = await httpServer()
  t.after(async () => {
    await close()
    tmp.cleanup()
  })
  const p = await post('/api/nodes', { type: 'project', name: 'P' })
  const r = await post('/api/nodes', { parentId: p.id, type: 'requirement', name: 'R' })
  const first = await post(`/api/nodes/${r.id}/release-items/upsert`, { name: 'X', ...SEED })
  assert.equal(first.created, true)

  const second = await post(`/api/nodes/${r.id}/release-items/upsert`, { name: 'X', content: 'v2' })
  assert.equal(second.created, false)
  assert.equal(second.content, 'v2')
  assert.equal(second.kind, 'sql')
  assert.equal(second.rollback, 'DROP INDEX idx_x')
  assert.equal(second.status, 'done')
  assert.equal(second.required, true)
})

// ---------- CLI（进程级） ----------

test('一致性（CLI）：release item upsert 只传 --content 时保留既有字段（原缺陷：被默认值回退）', async (t) => {
  const tmp = await tempHome()
  t.after(() => tmp.cleanup())
  const home = tmp.dir
  await cli(home, ['node', 'upsert', '--path', 'P/R'])
  const first = await cli(home, [
    'release', 'item', 'upsert', 'P/R',
    '--name', 'X', '--kind', 'sql', '--content', 'v1',
    '--rollback', 'DROP INDEX idx_x', '--status', 'done', '--required'
  ])
  assert.equal(first.created, true)
  assert.equal(first.rollback, 'DROP INDEX idx_x')
  assert.equal(first.status, 'done')

  // 只改内容：不得回退 rollback / status / required / kind
  const second = await cli(home, ['release', 'item', 'upsert', 'P/R', '--name', 'X', '--content', 'v2'])
  assert.equal(second.created, false)
  assert.equal(second.content, 'v2')
  assert.equal(second.kind, 'sql')
  assert.equal(second.rollback, 'DROP INDEX idx_x')
  assert.equal(second.status, 'done')
  assert.equal(second.required, true)
})

test('一致性（CLI）：release item upsert 新建时未传字段仍取默认值', async (t) => {
  const tmp = await tempHome()
  t.after(() => tmp.cleanup())
  const home = tmp.dir
  await cli(home, ['node', 'upsert', '--path', 'P/R'])
  const item = await cli(home, ['release', 'item', 'upsert', 'P/R', '--name', '仅名字'])
  assert.equal(item.created, true)
  assert.equal(item.kind, 'config')
  assert.equal(item.content, '')
  assert.equal(item.rollback, null)
  assert.equal(item.status, 'pending')
  assert.equal(item.required, true)
})

test('一致性（CLI）：release item upsert --optional 可把必做改回可选', async (t) => {
  const tmp = await tempHome()
  t.after(() => tmp.cleanup())
  const home = tmp.dir
  await cli(home, ['node', 'upsert', '--path', 'P/R'])
  await cli(home, ['release', 'item', 'upsert', 'P/R', '--name', 'X', '--required'])
  const soft = await cli(home, ['release', 'item', 'upsert', 'P/R', '--name', 'X', '--optional'])
  assert.equal(soft.required, false)
  // 其余字段不受影响
  assert.equal(soft.status, 'pending')
})

// ---------- MCP（真实 in-memory 协议） ----------

test('一致性（MCP）：release_item_upsert 只传 content 时保留既有字段（原缺陷：被默认值回退）', async (t) => {
  const { tmp, store, call, close } = await mcpClient()
  t.after(async () => {
    await close()
    tmp.cleanup()
  })
  const p = store.createNode({ type: 'project', name: 'P' })
  const r = store.createNode({ parentId: p.id, type: 'requirement', name: 'R' })
  // 高风险（AI 变更上线配置 / SQL）需显式确认——本用例关注 upsert 语义，故带 confirm
  const first = await call('release_item_upsert', { node: r.id, name: 'X', ...SEED, confirm: true })
  assert.equal(first.created, true)

  const second = await call('release_item_upsert', { node: r.id, name: 'X', content: 'v2', confirm: true })
  assert.equal(second.created, false)
  assert.equal(second.content, 'v2')
  assert.equal(second.kind, 'sql')
  assert.equal(second.rollback, 'DROP INDEX idx_x')
  assert.equal(second.status, 'done')
  assert.equal(second.required, true)
})

test('一致性（MCP）：release_item_upsert 新建时未传字段仍取默认值', async (t) => {
  const { tmp, store, call, close } = await mcpClient()
  t.after(async () => {
    await close()
    tmp.cleanup()
  })
  const p = store.createNode({ type: 'project', name: 'P' })
  const r = store.createNode({ parentId: p.id, type: 'requirement', name: 'R' })
  const item = await call('release_item_upsert', { node: r.id, name: '仅名字', confirm: true })
  assert.equal(item.created, true)
  assert.equal(item.kind, 'config')
  assert.equal(item.content, '')
  assert.equal(item.rollback, null)
  assert.equal(item.status, 'pending')
  assert.equal(item.required, true)
})
