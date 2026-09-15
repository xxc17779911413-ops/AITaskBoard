import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
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
  const { createApp } = await import('../server/http.mjs')
  const app = createApp({ store })
  const server = await new Promise((resolve, reject) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s))
    s.once('error', reject)
  })
  const base = `http://127.0.0.1:${server.address().port}`
  return {
    tmp,
    home,
    store,
    base,
    close: async () => new Promise((r) => server.close(r))
  }
}

test('HTTP 需求管理：列表、创建、状态流转、文档更新后就绪状态可见', async (t) => {
  const ctx = await setup()
  t.after(async () => {
    await ctx.close()
    ctx.tmp.cleanup()
  })
  const p = ctx.store.createNode({ type: 'project', name: 'P' })

  const created = await fetch(`${ctx.base}/api/requirements`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ projectId: p.id, name: '需求A' })
  }).then((r) => r.json())
  assert.equal(created.status, 'todo')
  assert.deepEqual(created.canTransitionTo, ['doing', 'cancelled'])

  let list = await fetch(`${ctx.base}/api/requirements?projectId=${p.id}`).then((r) => r.json())
  assert.equal(list.items.length, 1)
  assert.equal(list.summary.byStatus.todo, 1)

  const moved = await fetch(`${ctx.base}/api/requirements/${created.id}/transition`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ status: 'doing' })
  }).then((r) => r.json())
  assert.equal(moved.status, 'doing')

  const rejected = await fetch(`${ctx.base}/api/requirements/${created.id}/transition`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ status: 'done' })
  }).then(async (r) => ({ status: r.status, body: await r.json() }))
  assert.equal(rejected.status, 400)
  assert.equal(rejected.body.error.code, 'VALIDATION_FAILED')

  await fetch(`${ctx.base}/api/nodes/${created.id}/documents/upsert`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: '需求内容', content: '正文' })
  })
  list = await fetch(`${ctx.base}/api/requirements?projectId=${p.id}`).then((r) => r.json())
  assert.equal(list.items[0].docState.find((d) => d.name === '需求内容').filled, true)
  assert.equal(list.summary.missingRequirementDoc, 0)
})

test('CLI 需求管理：create / list / transition 全链路', async (t) => {
  const ctx = await setup()
  t.after(() => ctx.tmp.cleanup())
  await ctx.close()
  const cli = (args) =>
    execFileP('node', [CLI, ...args], { env: { ...process.env, TASKBOARD_HOME: ctx.home }, encoding: 'utf8' }).then((r) =>
      JSON.parse(r.stdout)
    )

  await cli(['node', 'upsert', '--path', 'P'])
  const created = await cli(['requirement', 'create', '--project', 'P', '--name', 'R'])
  assert.equal(created.type, 'requirement')
  const list = await cli(['requirement', 'list', '--project', 'P'])
  assert.equal(list.items.length, 1)
  const moved = await cli(['requirement', 'transition', 'P/R', '--status', 'doing'])
  assert.equal(moved.status, 'doing')
  const filtered = await cli(['requirement', 'list', '--project', 'P', '--status', 'doing'])
  assert.equal(filtered.items.length, 1)
  assert.equal(filtered.summary.total, 1)
})

test('MCP 需求管理：真实协议调用与 store 返回一致', async (t) => {
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
  const client = new Client({ name: 'taskboard-requirement-test', version: '1.0.0' })
  await client.connect(clientTransport)
  t.after(async () => {
    await client.close()
    await server.close()
  })
  const call = (name, args) => client.callTool({ name, arguments: args })

  const p = ctx.store.createNode({ type: 'project', name: 'P' })
  const createdOut = await call('requirement_create', { project: 'P', name: 'R' })
  assert.equal(createdOut.isError, undefined)
  const created = JSON.parse(createdOut.content[0].text)
  assert.deepEqual(created, ctx.store.listRequirements({ projectId: p.id })[0])

  const bad = await call('requirement_transition', { ref: 'P/R', status: 'done' })
  assert.equal(bad.isError, true)
  assert.match(bad.content[0].text, /VALIDATION_FAILED/)

  const listOut = await call('requirement_list', { project: 'P' })
  const list = JSON.parse(listOut.content[0].text)
  assert.equal(list.items.length, 1)
  assert.equal(list.summary.byStatus.todo, 1)
})

test('通用创建/更新、batch、upsert、MCP 枚举外状态值统一回归', async (t) => {
  const ctx = await setup()
  t.after(async () => {
    await ctx.close()
    ctx.tmp.cleanup()
  })
  const p = ctx.store.createNode({ type: 'project', name: 'P' })
  const raw = (method, pth, body) =>
    fetch(`${ctx.base}${pth}`, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    }).then(async (r) => ({ status: r.status, body: await r.json() }))

  const genericCreate = await raw('POST', '/api/nodes', { parentId: p.id, type: 'requirement', name: '通用创建' })
  assert.equal(genericCreate.status, 201)
  const genericList = await fetch(`${ctx.base}/api/requirements?projectId=${p.id}`).then((r) => r.json())
  assert.deepEqual(
    genericList.items[0].docState.map((d) => [d.name, d.linked, d.filled]),
    [
      ['需求内容', true, false],
      ['概要设计', true, false]
    ]
  )
  assert.equal(genericList.items[0].status, 'todo')

  const badCreate = await raw('POST', '/api/nodes', { parentId: p.id, type: 'requirement', name: '非法创建', status: 'DONE' })
  assert.equal(badCreate.status, 400)
  assert.equal(badCreate.body.error.code, 'VALIDATION_FAILED')
  const badCreateDone = await raw('POST', '/api/nodes', { parentId: p.id, type: 'requirement', name: '非法创建 done', status: 'done' })
  assert.equal(badCreateDone.status, 400)
  assert.equal(badCreateDone.body.error.code, 'VALIDATION_FAILED')

  const badUpdate = await raw('PATCH', `/api/nodes/${genericCreate.body.id}`, { status: 'DONE' })
  assert.equal(badUpdate.status, 400)
  assert.equal(badUpdate.body.error.code, 'VALIDATION_FAILED')
  const badUpdateDone = await raw('PATCH', `/api/nodes/${genericCreate.body.id}`, { status: 'done' })
  assert.equal(badUpdateDone.status, 400)
  assert.equal(badUpdateDone.body.error.code, 'VALIDATION_FAILED')

  const badTransition = await raw('POST', `/api/requirements/${genericCreate.body.id}/transition`, { status: 'done' })
  assert.equal(badTransition.status, 400)
  assert.equal(badTransition.body.error.code, 'VALIDATION_FAILED')

  const viaUpsert = await raw('POST', '/api/nodes/upsert', { path: 'P/upsert需求', type: 'requirement' })
  assert.equal(viaUpsert.status, 200)
  const upsertList = await fetch(`${ctx.base}/api/requirements?projectId=${p.id}`).then((r) => r.json())
  const upserted = upsertList.items.find((r) => r.name === 'upsert需求')
  assert.deepEqual(
    upserted.docState.map((d) => [d.name, d.linked, d.filled]),
    [
      ['需求内容', true, false],
      ['概要设计', true, false]
    ]
  )

  const viaBatch = await raw('POST', '/api/batch', {
    ops: [{ op: 'node.create', parentId: p.id, type: 'requirement', name: 'batch需求' }]
  })
  assert.equal(viaBatch.status, 200)
  assert.equal(viaBatch.body.failed, 0)
  const batchList = await fetch(`${ctx.base}/api/requirements?projectId=${p.id}`).then((r) => r.json())
  const batched = batchList.items.find((r) => r.name === 'batch需求')
  assert.deepEqual(
    batched.docState.map((d) => [d.name, d.linked, d.filled]),
    [
      ['需求内容', true, false],
      ['概要设计', true, false]
    ]
  )
  const badBatch = await raw('POST', '/api/batch', {
    ops: [
      { op: 'node.create', parentId: p.id, type: 'requirement', name: 'batch非法状态', status: 'DONE' },
      { op: 'node.create', parentId: p.id, type: 'requirement', name: 'batch非法状态 done', status: 'done' },
      { op: 'node.update', ref: String(batched.id), patch: { status: 'bogus' } }
    ]
  })
  assert.equal(badBatch.body.failed, 3)
  assert.ok(badBatch.body.results.every((r) => r.error?.code === 'VALIDATION_FAILED'))

  const filtered = await fetch(`${ctx.base}/api/requirements?projectId=${p.id}&status=todo`).then((r) => r.json())
  assert.equal(filtered.items.length, filtered.summary.total)
  assert.equal(filtered.summary.byStatus.doing, 0)

  for (const qs of ['projectId=abc', 'projectId=']) {
    const bad = await raw('GET', `/api/requirements?${qs}`)
    assert.equal(bad.status, 400, qs)
    assert.equal(bad.body.error.code, 'VALIDATION_FAILED')
  }

  const { createMcpServer } = await import('../server/mcp.mjs')
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js')
  const server = createMcpServer({ store: ctx.store })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: 'taskboard-requirement-regression', version: '1.0.0' })
  await client.connect(clientTransport)
  t.after(async () => {
    await client.close()
    await server.close()
  })
  const badMcp = await client.callTool({ name: 'requirement_transition', arguments: { ref: String(genericCreate.body.id), status: 'bogus' } })
  assert.equal(badMcp.isError, true)
  assert.match(badMcp.content[0].text, /VALIDATION_FAILED/)
  assert.ok(!/MCP error -32602/.test(badMcp.content[0].text))
})

test('CLI 枚举外状态值与通用更新统一拒绝', async (t) => {
  const ctx = await setup()
  t.after(() => ctx.tmp.cleanup())
  await ctx.close()
  const cli = (args) =>
    execFileP('node', [CLI, ...args], { env: { ...process.env, TASKBOARD_HOME: ctx.home }, encoding: 'utf8' }).then((r) =>
      JSON.parse(r.stdout)
    )
  const cliFail = async (args) => {
    try {
      await execFileP('node', [CLI, ...args], { env: { ...process.env, TASKBOARD_HOME: ctx.home }, encoding: 'utf8' })
      return null
    } catch (e) {
      return String(e.stderr || '') + String(e.stdout || '')
    }
  }

  await cli(['node', 'upsert', '--path', 'P'])
  const created = await cli(['requirement', 'create', '--project', 'P', '--name', 'R'])
  for (const args of [
    ['requirement', 'transition', 'P/R', '--status', 'bogus'],
    ['node', 'update', String(created.id), '--status', 'DONE']
  ]) {
    const out = await cliFail(args)
    assert.ok(out, args.join(' '))
    assert.match(out, /VALIDATION_FAILED/)
  }
})

test('CLI + config.json：自定义图外状态启动期拒绝，收窄配置的下一步保持可执行', async (t) => {
  const tmp = await tempHome()
  t.after(() => tmp.cleanup())
  const cli = (args) =>
    execFileP('node', [CLI, ...args], { env: { ...process.env, TASKBOARD_HOME: tmp.dir }, encoding: 'utf8' }).then((r) =>
      JSON.parse(r.stdout)
    )
  const cliFail = async (args) => {
    try {
      await execFileP('node', [CLI, ...args], { env: { ...process.env, TASKBOARD_HOME: tmp.dir }, encoding: 'utf8' })
      return null
    } catch (e) {
      return String(e.stderr || '') + String(e.stdout || '')
    }
  }

  const writeAllowed = (allowed) => {
    const file = path.join(tmp.dir, 'config.json')
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8'))
    cfg.status.allowed.requirement = allowed
    fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n')
  }

  await cli(['node', 'upsert', '--path', 'P'])
  writeAllowed(['todo', 'doing', 'testing', 'done', 'cancelled', 'blocked'])
  const bad = await cliFail(['node', 'upsert', '--path', 'P'])
  assert.ok(bad)
  assert.match(bad, /VALIDATION_FAILED/)

  writeAllowed(['todo', 'doing', 'testing', 'done'])
  await cli(['node', 'upsert', '--path', 'P'])
  const created = await cli(['requirement', 'create', '--project', 'P', '--name', 'R'])
  assert.deepEqual(created.canTransitionTo, ['doing'])

  const doing = await cli(['requirement', 'transition', 'P/R', '--status', 'doing'])
  assert.deepEqual(doing.canTransitionTo, ['testing'])
  const cancelled = await cliFail(['requirement', 'transition', 'P/R', '--status', 'cancelled'])
  assert.ok(cancelled)
  assert.match(cancelled, /VALIDATION_FAILED/)

  const list = await cli(['requirement', 'list', '--project', 'P'])
  assert.equal(list.summary.total, 1)
  assert.equal(list.summary.byStatus.cancelled, undefined)
  assert.equal(list.items[0].canTransitionTo[0], 'testing')
})

test('HTTP /api/requirements 与 MCP 启动路径拒绝终态不可达 workflow', async (t) => {
  const tmp = await tempHome()
  t.after(() => tmp.cleanup())
  const cli = (args) =>
    execFileP('node', [CLI, ...args], { env: { ...process.env, TASKBOARD_HOME: tmp.dir }, encoding: 'utf8' })
  await cli(['node', 'upsert', '--path', 'P'])

  const configFile = path.join(tmp.dir, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(configFile, 'utf8'))
  cfg.status.allowed.requirement = ['todo', 'doing', 'done']
  fs.writeFileSync(configFile, JSON.stringify(cfg, null, 2) + '\n')

  const runProbe = (source) =>
    execFileP('node', ['-e', source], {
      cwd: path.resolve(import.meta.dirname, '..'),
      env: { ...process.env, TASKBOARD_HOME: tmp.dir },
      encoding: 'utf8'
    }).then(
      () => null,
      (e) => e
    )

  const httpFail = await runProbe(`
    const { startServer } = await import('./server/index.mjs')
    try {
      await startServer({ port: 0, open: false })
      process.exit(0)
    } catch (e) {
      console.error(e.code || 'ERROR')
      process.exit(1)
    }
  `)
  assert.ok(httpFail)
  assert.match(String(httpFail.stderr || ''), /VALIDATION_FAILED/)

  const mcpFail = await runProbe(`
    const { runMcp } = await import('./server/mcp.mjs')
    try {
      await runMcp()
      process.exit(0)
    } catch (e) {
      console.error(e.code || 'ERROR')
      process.exit(1)
    }
  `)
  assert.ok(mcpFail)
  assert.match(String(mcpFail.stderr || ''), /VALIDATION_FAILED/)
})
