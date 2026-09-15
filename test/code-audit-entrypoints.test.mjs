import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { execFileSync } from 'node:child_process'
import { tempHome } from './helpers.mjs'

const execFileP = promisify(execFile)
const CLI = path.resolve(import.meta.dirname, '../bin/taskboard.js')

/** 临时 git 仓库 + 一个包含高危新增行的提交 */
function makeRepo({ riskyLine = 'const token = "abcdefghijkl"' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'taskboard-codeaudit-ep-'))
  const dir = path.join(root, 'work')
  fs.mkdirSync(dir)
  const g = (args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' })
  g(['init', '-q', '-b', 'main'])
  g(['config', 'user.email', 't@t.local'])
  g(['config', 'user.name', 't'])
  fs.writeFileSync(path.join(dir, 'base.js'), 'export const a = 1\n')
  g(['add', '.'])
  g(['commit', '-q', '-m', 'init'])
  fs.writeFileSync(path.join(dir, 'x.js'), `${riskyLine}\n`)
  g(['add', '.'])
  g(['commit', '-q', '-m', 'risky'])
  return { root, dir, sha: g(['rev-parse', 'HEAD']).trim() }
}

/**
 * 用既有 store 起一个真实 HTTP 服务（代码检查这条链路里唯一没被 CLI/MCP 覆盖的通道）。
 * 复用调用方自己的 store，避免 ESM 模块级 TASKBOARD_HOME 被其它用例先导入而串库。
 */
async function httpClient(store) {
  const { createApp } = await import('../server/http.mjs')
  const app = createApp({ store })
  const server = await new Promise((resolve, reject) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s))
    s.once('error', reject)
  })
  const base = `http://127.0.0.1:${server.address().port}`
  return {
    store,
    get: (p) => fetch(`${base}${p}`).then((r) => r.json()),
    text: (p) => fetch(`${base}${p}`).then((r) => r.text()),
    close: () => new Promise((r) => server.close(r))
  }
}

/** D1 的最小复现：一行两个凭据赋值，且第二个的值与前面一个普通字符串相同 */
const D1_RISKY_LINE = "const note = 'leakvalue999'; const token = 'leakvalue999'"
const D1_SECRETS = ['leakvalue999']

function assertNoPlaintext(label, text) {
  for (const secret of D1_SECRETS) {
    assert.ok(!String(text).includes(secret), `${label} 泄漏明文 ${secret}`)
  }
}

async function cli(home, args) {
  const { stdout } = await execFileP('node', [CLI, ...args], {
    env: { ...process.env, TASKBOARD_HOME: home },
    encoding: 'utf8'
  })
  return stdout
}

async function mcpClient() {
  const tmp = await tempHome()
  const store = tmp.store.createStore(tmp.openDb())
  const { createMcpServer } = await import('../server/mcp.mjs')
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js')
  const server = createMcpServer({ store })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: 'taskboard-code-audit-test', version: '1.0.0' })
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

test('CLI code audit：真实子进程输出 JSON，三入口字段与 store 一致', async (t) => {
  const tmp = await tempHome()
  const home = tmp.dir
  const repo = makeRepo()
  t.after(() => {
    tmp.cleanup()
    fs.rmSync(repo.root, { recursive: true, force: true })
  })

  await cli(home, ['node', 'upsert', '--path', 'P/R'])
  await cli(home, ['repo', 'add', '--name', 'demo', '--local-path', repo.dir])
  await cli(home, ['commit', 'add', 'P/R', '--repo', 'demo', '--sha', repo.sha])

  const out = JSON.parse(await cli(home, ['code', 'audit', 'P/R']))
  assert.equal(out.ready, false)
  assert.equal(out.totals.danger, 1)
  assert.equal(out.blockers[0].rule, 'hardcoded_secret')
  assert.ok(!JSON.stringify(out).includes('abcdefghijkl'), '不得回显原值')

  // 子需求上跑 subtree 也一致
  const subtree = JSON.parse(await cli(home, ['code', 'audit', 'P/R', '--scope', 'subtree']))
  assert.equal(subtree.ready, false)
  assert.equal(subtree.scope, 'subtree')
})

test('CLI code audit：--format md 输出可贴的 markdown 表格', async (t) => {
  const tmp = await tempHome()
  const home = tmp.dir
  const repo = makeRepo()
  t.after(() => {
    tmp.cleanup()
    fs.rmSync(repo.root, { recursive: true, force: true })
  })
  await cli(home, ['node', 'upsert', '--path', 'P/R'])
  await cli(home, ['repo', 'add', '--name', 'demo', '--local-path', repo.dir])
  await cli(home, ['commit', 'add', 'P/R', '--repo', 'demo', '--sha', repo.sha])

  const md = await cli(home, ['code', 'audit', 'P/R', '--format', 'md'])
  assert.match(md, /^# 代码检查：R/m)
  assert.match(md, /结论：未通过/)
  assert.match(md, /\| 高危 \|/)
})

test('CLI code audit：非法 scope 报 VALIDATION_FAILED（不是崩溃）', async (t) => {
  const tmp = await tempHome()
  const home = tmp.dir
  t.after(() => tmp.cleanup())
  await cli(home, ['node', 'upsert', '--path', 'P/R'])
  await assert.rejects(
    () => cli(home, ['code', 'audit', 'P/R', '--scope', 'Subtree']),
    (e) => /VALIDATION_FAILED/.test(String(e.stderr || '') + String(e.stdout || ''))
  )
})

test('MCP code_audit：真实协议调用返回 JSON，与 store 结果逐字段一致', async (t) => {
  const { tmp, store, call, close } = await mcpClient()
  const repo = makeRepo()
  t.after(async () => {
    await close()
    tmp.cleanup()
    fs.rmSync(repo.root, { recursive: true, force: true })
  })
  const p = store.createNode({ type: 'project', name: 'P' })
  const r = store.createNode({ parentId: p.id, type: 'requirement', name: 'R' })
  store.addRepo({ name: 'demo', localPath: repo.dir })
  store.addCommit(r.id, { repo: 'demo', sha: repo.sha })

  const out = await call('code_audit', { node: r.id })
  assert.equal(out.isError, undefined)
  const viaMcp = JSON.parse(out.content[0].text)
  const ops = await import('../server/ops.mjs')
  const viaStore = await ops.getNodeCodeAudit(store, r.id)
  assert.deepEqual(viaMcp, viaStore)
  assert.equal(viaMcp.ready, false)
})

test('MCP code_audit：非法 scope 返回 isError + VALIDATION_FAILED（不泄漏 SDK -32602）', async (t) => {
  const { tmp, store, call, close } = await mcpClient()
  t.after(async () => {
    await close()
    tmp.cleanup()
  })
  const p = store.createNode({ type: 'project', name: 'P' })
  const r = store.createNode({ parentId: p.id, type: 'requirement', name: 'R' })

  const out = await call('code_audit', { node: r.id, scope: 'Subtree' })
  assert.equal(out.isError, true)
  assert.match(out.content[0].text, /VALIDATION_FAILED/)
})

test('D1 回归：同一行两个凭据赋值（值相同），CLI / HTTP / MCP / Web 四条输出通道均无明文', async (t) => {
  const tmp = await tempHome()
  const home = tmp.dir
  const repo = makeRepo({ riskyLine: D1_RISKY_LINE })
  t.after(() => {
    tmp.cleanup()
    fs.rmSync(repo.root, { recursive: true, force: true })
  })

  await cli(home, ['node', 'upsert', '--path', 'P/R'])
  await cli(home, ['repo', 'add', '--name', 'demo', '--local-path', repo.dir])
  await cli(home, ['commit', 'add', 'P/R', '--repo', 'demo', '--sha', repo.sha])

  // ① CLI JSON
  const cliJsonRaw = await cli(home, ['code', 'audit', 'P/R'])
  assertNoPlaintext('CLI JSON', cliJsonRaw)
  assert.equal(JSON.parse(cliJsonRaw).ready, false)

  // ② CLI markdown
  const cliMd = await cli(home, ['code', 'audit', 'P/R', '--format', 'md'])
  assertNoPlaintext('CLI markdown', cliMd)

  // ③ HTTP（JSON + markdown）——CLI 子进程写入的正是 tmp.dir/data.db，这里开同一文件
  const httpStore = tmp.store.createStore(tmp.openDb())
  const node = httpStore.resolveRef('P/R')
  const http = await httpClient(httpStore)
  t.after(() => http.close())
  const httpJson = await http.get(`/api/nodes/${node.id}/code-audit`)
  assertNoPlaintext('HTTP JSON', JSON.stringify(httpJson))
  assert.equal(httpJson.ready, false)
  const httpMd = await http.text(`/api/nodes/${node.id}/code-audit?format=md`)
  assertNoPlaintext('HTTP markdown', httpMd)

  // ④ MCP（真实协议文本）
  const { store: mcpStore, call, close } = await mcpClient()
  t.after(async () => {
    await close()
  })
  const mp = mcpStore.createNode({ type: 'project', name: 'P' })
  const mr = mcpStore.createNode({ parentId: mp.id, type: 'requirement', name: 'R' })
  mcpStore.addRepo({ name: 'demo', localPath: repo.dir })
  mcpStore.addCommit(mr.id, { repo: 'demo', sha: repo.sha })
  const mcpOut = await call('code_audit', { node: mr.id })
  assert.equal(mcpOut.isError, undefined)
  assertNoPlaintext('MCP text', mcpOut.content[0].text)

  // ⑤ Web 页签消费的契约：findings[*].snippet / blockers[*].snippet 就是渲染源，
  //    这两处不得含明文（UI 无二次脱敏，store 返回什么就显示什么）
  const webPayload = JSON.parse(mcpOut.content[0].text)
  for (const finding of webPayload.findings) {
    assertNoPlaintext('Web findings.snippet', finding.snippet)
  }
  for (const blocker of webPayload.blockers) {
    assertNoPlaintext('Web blockers.snippet', blocker.snippet)
  }
})
