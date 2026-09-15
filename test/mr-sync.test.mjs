import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { tempHome } from './helpers.mjs'

const CLI = path.resolve(import.meta.dirname, '../bin/taskboard.js')
const execFileP = promisify(execFile)

/** 本地 GitLab stub：按 page / source_branch 返回 MR；可编程状态码。 */
function startGitlabStub() {
  const state = { status: 200, pages: {}, calls: [] }
  const server = http.createServer((req, res) => {
    state.calls.push(req.url)
    if (state.status !== 200) {
      res.writeHead(state.status, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ message: 'stub error' }))
      return
    }
    const url = new URL(req.url, 'http://127.0.0.1')
    const page = Number(url.searchParams.get('page') || 1)
    const rows = state.pages[page] || []
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(rows))
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, state, base: `http://127.0.0.1:${server.address().port}` })
    })
  })
}

async function setup() {
  const tmp = await tempHome()
  const store = tmp.store.createStore(tmp.openDb())
  const p = store.createNode({ type: 'project', name: 'P' })
  const r = store.createNode({ parentId: p.id, type: 'requirement', name: 'R' })
  const s = store.createNode({ parentId: r.id, type: 'subreq', name: 'S' })
  store.setAttrs(s.id, { branch: 'feature-login', gitlab_project: 'charging/xp-charge' })
  return { tmp, store, s }
}

function configureGitlab(tmp, base, token = 'tok') {
  tmp.config.loadConfig()
  tmp.config.saveConfig({ gitlab: { base_url: base, token } })
}

test('mr-sync：分页拉取 + upsert 幂等；本次未返回的既有记录保留', async (t) => {
  const { tmp, store, s } = await setup()
  const stub = await startGitlabStub()
  t.after(() => {
    stub.server.close()
    tmp.cleanup()
  })
  configureGitlab(tmp, stub.base)

  stub.state.pages[1] = [
    { iid: 1, title: 'MR one', state: 'opened', source_branch: 'feature-login', web_url: 'https://g/mr/1', updated_at: '2026-01-01T00:00:00Z' }
  ]
  const { refreshMergeRequests, listMergeRequests } = await import('../server/ops.mjs')
  const first = await refreshMergeRequests(store, s.id)
  assert.equal(first.pulled, 1)
  assert.equal(first.created, 1)
  assert.equal(first.items.length, 1)

  // 同 iid 再次刷新 → 更新而非新增
  stub.state.pages[1] = [
    { iid: 1, title: 'MR one updated', state: 'merged', source_branch: 'feature-login', web_url: 'https://g/mr/1', updated_at: '2026-01-02T00:00:00Z' },
    { iid: 2, title: 'MR two', state: 'opened', source_branch: 'feature-login', web_url: 'https://g/mr/2', updated_at: '2026-01-03T00:00:00Z' }
  ]
  const second = await refreshMergeRequests(store, s.id)
  assert.equal(second.created, 1)
  assert.equal(second.updated, 1)
  assert.equal(listMergeRequests(store, s.id).items.length, 2)

  // 本次只返回 iid=2 → iid=1 保留（不删除）
  stub.state.pages[1] = [
    { iid: 2, title: 'MR two', state: 'closed', source_branch: 'feature-login', web_url: 'https://g/mr/2', updated_at: '2026-01-04T00:00:00Z' }
  ]
  await refreshMergeRequests(store, s.id)
  const after = listMergeRequests(store, s.id).items
  assert.equal(after.length, 2)
  assert.equal(after.find((m) => m.iid === 1).title, 'MR one updated')
})

test('mr-sync：401 / 404 / 未配置 / 缺属性都稳定报错且既有数据不变', async (t) => {
  const { tmp, store, s } = await setup()
  const stub = await startGitlabStub()
  t.after(() => {
    stub.server.close()
    tmp.cleanup()
  })
  const { refreshMergeRequests } = await import('../server/ops.mjs')

  // 未配置
  await assert.rejects(refreshMergeRequests(store, s.id), (e) => e.code === 'GITLAB_NOT_CONFIGURED')

  configureGitlab(tmp, stub.base)
  // 先写入一条基线数据
  stub.state.pages[1] = [
    { iid: 9, title: 'base', state: 'opened', source_branch: 'feature-login', web_url: 'https://g/mr/9', updated_at: '2026-01-01T00:00:00Z' }
  ]
  await refreshMergeRequests(store, s.id)
  const before = store.listMrs(s.id)

  stub.state.status = 401
  await assert.rejects(refreshMergeRequests(store, s.id), (e) => e.code === 'GITLAB_AUTH_FAILED')
  assert.deepEqual(store.listMrs(s.id), before)

  stub.state.status = 404
  await assert.rejects(refreshMergeRequests(store, s.id), (e) => e.code === 'GITLAB_PROJECT_NOT_FOUND')
  assert.deepEqual(store.listMrs(s.id), before)

  // 缺属性
  const p = store.createNode({ type: 'project', name: 'P2' })
  const r = store.createNode({ parentId: p.id, type: 'requirement', name: 'R2' })
  const s2 = store.createNode({ parentId: r.id, type: 'subreq', name: 'S2' })
  await assert.rejects(refreshMergeRequests(store, s2.id), (e) => e.code === 'VALIDATION_FAILED')
  await assert.rejects(refreshMergeRequests(store, p.id), (e) => e.code === 'VALIDATION_FAILED')
})

test('mr-sync：HTTP / CLI / MCP 三入口 1:1 且 MR 区数据一致', async (t) => {
  const { tmp, store, s } = await setup()
  const stub = await startGitlabStub()
  const { createApp } = await import('../server/http.mjs')
  const { createMcpServer } = await import('../server/mcp.mjs')
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js')

  const app = createApp({ store })
  const server = await new Promise((resolve, reject) => {
    const srv = app.listen(0, '127.0.0.1', () => resolve(srv))
    srv.once('error', reject)
  })
  const base = `http://127.0.0.1:${server.address().port}`
  const mcpServer = createMcpServer({ store })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await mcpServer.connect(serverTransport)
  const client = new Client({ name: 'taskboard-mr-test', version: '1.0.0' })
  await client.connect(clientTransport)

  t.after(async () => {
    await client.close()
    await mcpServer.close()
    await new Promise((r) => server.close(r))
    stub.server.close()
    tmp.cleanup()
  })
  configureGitlab(tmp, stub.base)
  stub.state.pages[1] = [
    { iid: 7, title: 'MR seven', state: 'opened', source_branch: 'feature-login', web_url: 'https://g/mr/7', updated_at: '2026-02-01T00:00:00Z' }
  ]

  const tools = (await client.listTools()).tools.map((x) => x.name)
  for (const name of ['mr_list', 'mr_refresh']) assert.ok(tools.includes(name), `${name} 应注册`)

  const httpRefresh = await (await fetch(`${base}/api/nodes/${s.id}/mrs/refresh`, { method: 'POST' })).json()
  assert.equal(httpRefresh.created, 1)
  const httpList = await (await fetch(`${base}/api/nodes/${s.id}/mrs`)).json()
  const cliList = JSON.parse((await execFileP('node', [CLI, 'mr', 'list', String(s.id)], { env: { ...process.env, TASKBOARD_HOME: tmp.dir } })).stdout)
  const mcpList = JSON.parse((await client.callTool({ name: 'mr_list', arguments: { node: s.id } })).content[0].text)
  assert.deepEqual(httpList.items, cliList.items)
  assert.deepEqual(cliList.items, mcpList.items)

  const detail = await (await fetch(`${base}/api/nodes/${s.id}`)).json()
  assert.deepEqual(detail.mrs, httpList.items, '节点详情应内嵌 MR 列表')
})
