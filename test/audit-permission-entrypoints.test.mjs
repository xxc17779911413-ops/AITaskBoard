import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { tempHome } from './helpers.mjs'

const execFileP = promisify(execFile)
const CLI = path.resolve(import.meta.dirname, '../bin/taskboard.js')

test('审计/权限：HTTP 拒绝 AI 未确认的状态流转（PERMISSION_DENIED + denied 审计），确认后放行', async (t) => {
  const tmp = await tempHome()
  const store = tmp.store.createStore(tmp.openDb())
  const p = store.createNode({ type: 'project', name: 'P' })
  const r = store.createNode({ parentId: p.id, type: 'requirement', name: 'R' })
  const { createApp } = await import('../server/http.mjs')
  const app = createApp({ store })
  const server = await new Promise((resolve, reject) => {
    const srv = app.listen(0, '127.0.0.1', () => resolve(srv))
    srv.once('error', reject)
  })
  const base = `http://127.0.0.1:${server.address().port}`
  const post = (p2, body, headers = {}) =>
    fetch(`${base}${p2}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
  t.after(async () => {
    await new Promise((res) => server.close(res))
    tmp.cleanup()
  })

  // AI 通道（x-taskboard-actor: ai）未确认 → 403 PERMISSION_DENIED
  const denied = await post(`/api/requirements/${r.id}/transition`, { status: 'doing' }, { 'x-taskboard-actor': 'ai' })
  assert.equal(denied.status, 403)
  const deniedBody = await denied.json()
  assert.equal(deniedBody.error.code, 'PERMISSION_DENIED')
  assert.equal(deniedBody.error.details.confirmRequired, true)

  // 审计可见：denied 一条
  const logs = await fetch(`${base}/api/audit-logs?action=requirement.transition&decision=denied`).then((x) => x.json())
  assert.equal(logs.length, 1)
  assert.equal(logs[0].actor, 'ai')

  // AI + confirm → 放行
  const ok = await post(`/api/requirements/${r.id}/transition`, { status: 'doing', confirm: true }, { 'x-taskboard-actor': 'ai' })
  assert.equal(ok.status, 200)
  assert.equal((await ok.json()).status, 'doing')

  // 人工（默认 actor=user）无需确认
  const manual = await post(`/api/requirements/${r.id}/transition`, { status: 'testing' })
  assert.equal(manual.status, 200)

  const confirmed = await fetch(`${base}/api/audit-logs?decision=confirmed`).then((x) => x.json())
  assert.equal(confirmed.length, 1)
})

test('审计/权限：HTTP 上线项变更需确认；非法筛选值拒绝', async (t) => {
  const tmp = await tempHome()
  const store = tmp.store.createStore(tmp.openDb())
  const p = store.createNode({ type: 'project', name: 'P' })
  const r = store.createNode({ parentId: p.id, type: 'requirement', name: 'R' })
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

  const put = (body) =>
    fetch(`${base}/api/nodes/${r.id}/release-items/upsert`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-taskboard-actor': 'ai' },
      body: JSON.stringify(body)
    })
  assert.equal((await put({ name: '建索引', kind: 'sql' })).status, 403)
  assert.equal((await put({ name: '建索引', kind: 'sql', confirm: true })).status, 200)
  assert.equal(store.listReleaseItems(r.id).length, 1)

  for (const qs of ['action=bogus', 'decision=bogus']) {
    const res = await fetch(`${base}/api/audit-logs?${qs}`)
    assert.equal(res.status, 400, qs)
    assert.equal((await res.json()).error.code, 'VALIDATION_FAILED', qs)
  }
})

test('审计/权限：CLI 与 MCP 与 store 一致；MCP 不泄漏 -32602', async (t) => {
  const tmp = await tempHome()
  const home = tmp.dir
  const store = tmp.store.createStore(tmp.openDb())
  const p = store.createNode({ type: 'project', name: 'P' })
  const r = store.createNode({ parentId: p.id, type: 'requirement', name: 'R' })
  t.after(() => tmp.cleanup())

  // CLI：AI 未确认 → 非零退出 + PERMISSION_DENIED；确认 → 成功
  const cliRun = async (args, expectFail = false) => {
    try {
      const { stdout } = await execFileP('node', [CLI, ...args], {
        env: { ...process.env, TASKBOARD_HOME: home },
        encoding: 'utf8'
      })
      assert.equal(expectFail, false, `期望失败但成功：${args.join(' ')}`)
      return JSON.parse(stdout)
    } catch (e) {
      if (!expectFail) throw e
      return { failed: true, text: String(e.stderr || '') + String(e.stdout || '') }
    }
  }
  const denied = await cliRun(['requirement', 'transition', String(r.id), '--status', 'doing', '--actor', 'ai'], true)
  assert.match(denied.text, /PERMISSION_DENIED/)
  const ok = await cliRun(['requirement', 'transition', String(r.id), '--status', 'doing', '--actor', 'ai', '--confirm'])
  assert.equal(ok.status, 'doing')

  // CLI audit list 与 store 一致
  const viaCli = await cliRun(['audit', 'list'])
  const viaStore = store.listAuditLogs()
  assert.deepEqual(viaCli, viaStore)

  // MCP：AI 未确认 → isError + PERMISSION_DENIED 且不含 -32602；确认 → 放行
  const { createMcpServer } = await import('../server/mcp.mjs')
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js')
  const server = createMcpServer({ store })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: 'taskboard-audit-test', version: '1.0.0' })
  await client.connect(clientTransport)
  t.after(async () => {
    await client.close()
    await server.close()
  })

  const mcpDenied = await client.callTool({ name: 'requirement_transition', arguments: { ref: String(r.id), status: 'testing' } })
  assert.equal(mcpDenied.isError, true)
  assert.match(mcpDenied.content[0].text, /PERMISSION_DENIED/)
  assert.doesNotMatch(mcpDenied.content[0].text, /-32602/)

  const mcpOk = await client.callTool({ name: 'requirement_transition', arguments: { ref: String(r.id), status: 'testing', confirm: true } })
  assert.equal(mcpOk.isError, undefined)
  assert.equal(JSON.parse(mcpOk.content[0].text).status, 'testing')

  const mcpLogs = await client.callTool({ name: 'audit_list', arguments: { action: 'requirement.transition' } })
  assert.equal(mcpLogs.isError, undefined)
  assert.deepEqual(JSON.parse(mcpLogs.content[0].text), store.listAuditLogs({ action: 'requirement.transition' }))
})

test('审计/权限：MCP audit_list 非法 decision / nodeId / limit 一律 VALIDATION_FAILED，不泄漏 -32602', async (t) => {
  const tmp = await tempHome()
  const store = tmp.store.createStore(tmp.openDb())
  store.recordAudit({ action: 'regression.run', nodeId: 1, actor: 'ai', decision: 'allowed' })
  const { createMcpServer } = await import('../server/mcp.mjs')
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js')
  const server = createMcpServer({ store })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: 'taskboard-audit-domain-test', version: '1.0.0' })
  await client.connect(clientTransport)
  t.after(async () => {
    await client.close()
    await server.close()
    tmp.cleanup()
  })

  // 非法业务值必须走 handler 内 VALIDATION_FAILED，而不是 zod 的 -32602
  for (const args of [
    { decision: 'bogus' },
    { nodeId: 'abc' },
    { nodeId: -1 },
    { limit: 'x' },
    { limit: -1 },
    { limit: 0 },
    { limit: 99999 }
  ]) {
    const out = await client.callTool({ name: 'audit_list', arguments: args })
    assert.equal(out.isError, true, JSON.stringify(args))
    assert.match(out.content[0].text, /VALIDATION_FAILED/, JSON.stringify(args))
    assert.doesNotMatch(out.content[0].text, /-32602/, JSON.stringify(args))
  }

  // 合法值与缺省仍可用
  const ok = await client.callTool({ name: 'audit_list', arguments: { decision: 'allowed', limit: 10 } })
  assert.equal(ok.isError, undefined)
  assert.equal(JSON.parse(ok.content[0].text).length, 1)
})

test('审计/权限：store / HTTP / CLI 对非法 nodeId / limit 显式拒绝，不返回空集或全量', async (t) => {
  const tmp = await tempHome()
  const home = tmp.dir
  const store = tmp.store.createStore(tmp.openDb())
  store.recordAudit({ action: 'regression.run', nodeId: 1, actor: 'ai', decision: 'allowed' })
  t.after(() => tmp.cleanup())

  // store 层
  for (const args of [{ nodeId: 'abc' }, { nodeId: 0 }, { limit: -1 }, { limit: 0 }, { limit: 501 }]) {
    assert.throws(() => store.listAuditLogs(args), /VALIDATION_FAILED/, JSON.stringify(args))
  }

  // HTTP 层
  const { createApp } = await import('../server/http.mjs')
  const app = createApp({ store })
  const server = await new Promise((resolve, reject) => {
    const srv = app.listen(0, '127.0.0.1', () => resolve(srv))
    srv.once('error', reject)
  })
  const base = `http://127.0.0.1:${server.address().port}`
  t.after(async () => {
    await new Promise((res) => server.close(res))
  })
  for (const qs of ['nodeId=abc', 'nodeId=0', 'limit=-1', 'limit=0', 'limit=501']) {
    const res = await fetch(`${base}/api/audit-logs?${qs}`)
    assert.equal(res.status, 400, qs)
    assert.equal((await res.json()).error.code, 'VALIDATION_FAILED', qs)
  }

  // CLI 层：非法值非零退出
  const cliFail = async (args) => {
    try {
      await execFileP('node', [CLI, ...args], { env: { ...process.env, TASKBOARD_HOME: home }, encoding: 'utf8' })
      return false
    } catch (e) {
      return /VALIDATION_FAILED/.test(String(e.stderr || '') + String(e.stdout || ''))
    }
  }
  assert.equal(await cliFail(['audit', 'list', '--node-id', 'abc']), true)
  assert.equal(await cliFail(['audit', 'list', '--limit', '0']), true)
})
