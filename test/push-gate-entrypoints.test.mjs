import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { tempHome } from './helpers.mjs'

const execFileP = promisify(execFile)
const CLI = path.resolve(import.meta.dirname, '../bin/taskboard.js')

/** 临时仓库：main 已 push、feature 未 push */
function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'taskboard-push-ep-'))
  const dir = path.join(root, 'work')
  fs.mkdirSync(dir)
  const g = (args, cwd = dir) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' })
  g(['init', '-q', '-b', 'main'])
  g(['config', 'user.email', 't@t.local'])
  g(['config', 'user.name', 't'])
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n')
  g(['add', '.'])
  g(['commit', '-q', '-m', 'init'])
  const remoteDir = path.join(root, 'remote.git')
  g(['init', '-q', '--bare', remoteDir], root)
  g(['remote', 'add', 'origin', remoteDir])
  g(['push', '-q', '-u', 'origin', 'main'])
  g(['checkout', '-q', '-b', 'feature'])
  fs.writeFileSync(path.join(dir, 'b.txt'), 'b\n')
  g(['add', '.'])
  g(['commit', '-q', '-m', 'feat: b'])
  return { root, dir, mainSha: g(['rev-parse', 'main']).trim(), featureSha: g(['rev-parse', 'HEAD']).trim() }
}

async function mcpClient(store) {
  const { createMcpServer } = await import('../server/mcp.mjs')
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js')
  const server = createMcpServer({ store })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: 'taskboard-push-gate-test', version: '1.0.0' })
  await client.connect(clientTransport)
  return {
    call: (name, args) => client.callTool({ name, arguments: args }),
    close: async () => {
      await client.close()
      await server.close()
    }
  }
}

/** 建一条含「已推送 + 未推送」提交的需求，返回四项读入口需要的句柄 */
async function setup() {
  const tmp = await tempHome()
  const store = tmp.store.createStore(tmp.openDb())
  const repo = makeRepo()
  const p = store.createNode({ type: 'project', name: 'P' })
  const r = store.createNode({ parentId: p.id, type: 'requirement', name: 'R' })
  store.addRepo({ name: 'repo', localPath: repo.dir })
  store.addCommit(r.id, { repo: 'repo', sha: repo.mainSha })
  store.addCommit(r.id, { repo: 'repo', sha: repo.featureSha })
  return { tmp, store, repo, p, r }
}

test('HTTP push-gate：返回 JSON / md，非法 scope 与 format 400 VALIDATION_FAILED', async (t) => {
  const { tmp, store, repo, r } = await setup()
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
    fs.rmSync(repo.root, { recursive: true, force: true })
  })

  const json = await fetch(`${base}/api/nodes/${r.id}/push-gate`).then((x) => x.json())
  assert.equal(json.ready, false)
  assert.equal(json.totals.commits, 2)

  // markdown 走 text/markdown
  const mdRes = await fetch(`${base}/api/nodes/${r.id}/push-gate?format=md`)
  assert.match(mdRes.headers.get('content-type'), /text\/markdown/)
  assert.match(await mdRes.text(), /# 代码推送门禁：R/)

  for (const q of ['scope=Subtree', 'format=xml']) {
    const res = await fetch(`${base}/api/nodes/${r.id}/push-gate?${q}`)
    assert.equal(res.status, 400, `${q} 应当 400`)
    assert.equal((await res.json()).error.code, 'VALIDATION_FAILED')
  }
})

test('MCP commit_push_gate：JSON / md 与 store 一致；非法 scope/format 返回 isError', async (t) => {
  const { tmp, store, repo, r } = await setup()
  const { call, close } = await mcpClient(store)
  t.after(async () => {
    await close()
    tmp.cleanup()
    fs.rmSync(repo.root, { recursive: true, force: true })
  })

  const out = await call('commit_push_gate', { ref: String(r.id) })
  assert.equal(out.isError, undefined)
  assert.deepEqual(JSON.parse(out.content[0].text), await (await import('../server/ops.mjs')).getNodePushGate(store, r.id))

  const { renderPushGateMd, getNodePushGate } = await import('../server/ops.mjs')
  const md = await call('commit_push_gate', { ref: String(r.id), format: 'md' })
  assert.equal(md.content[0].text, renderPushGateMd(await getNodePushGate(store, r.id)))

  for (const args of [{ ref: String(r.id), scope: 'sub' }, { ref: String(r.id), format: 'xml' }]) {
    const bad = await call('commit_push_gate', args)
    assert.equal(bad.isError, true)
    assert.match(bad.content[0].text, /VALIDATION_FAILED/)
    assert.ok(!/MCP error -32602/.test(bad.content[0].text))
  }
})

test('四入口一致性：store / HTTP / CLI / MCP 的 push gate 返回逐字段一致', async (t) => {
  const { tmp, store, repo, r } = await setup()
  const home = tmp.dir
  const { createApp } = await import('../server/http.mjs')
  const app = createApp({ store })
  const server = await new Promise((resolve, reject) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s))
    s.once('error', reject)
  })
  const base = `http://127.0.0.1:${server.address().port}`
  const { call, close } = await mcpClient(store)
  t.after(async () => {
    await close()
    await new Promise((res) => server.close(res))
    tmp.cleanup()
    fs.rmSync(repo.root, { recursive: true, force: true })
  })

  const expected = await (await import('../server/ops.mjs')).getNodePushGate(store, r.id)
  const httpOut = await fetch(`${base}/api/nodes/${r.id}/push-gate`).then((x) => x.json())
  const mcpOut = JSON.parse((await call('commit_push_gate', { ref: String(r.id) })).content[0].text)
  const { stdout } = await execFileP('node', [CLI, 'push', 'gate', 'P/R'], {
    env: { ...process.env, TASKBOARD_HOME: home },
    encoding: 'utf8'
  })
  const cliOut = JSON.parse(stdout)

  assert.deepEqual(httpOut, expected)
  assert.deepEqual(mcpOut, expected)
  assert.deepEqual(cliOut, expected)
  assert.equal(cliOut.ready, false)
  assert.equal(cliOut.totals.notPushed, 1)
})

test('CLI push gate --scope subtree 与 store 一致', async (t) => {
  const { tmp, store, repo, r } = await setup()
  const home = tmp.dir
  t.after(() => {
    tmp.cleanup()
    fs.rmSync(repo.root, { recursive: true, force: true })
  })
  const { getNodePushGate } = await import('../server/ops.mjs')
  const expected = await getNodePushGate(store, r.id, { scope: 'subtree' })
  const { stdout } = await execFileP('node', [CLI, 'push', 'gate', 'P/R', '--scope', 'subtree'], {
    env: { ...process.env, TASKBOARD_HOME: home },
    encoding: 'utf8'
  })
  assert.deepEqual(JSON.parse(stdout), expected)
  assert.equal(JSON.parse(stdout).scope, 'subtree')
})
