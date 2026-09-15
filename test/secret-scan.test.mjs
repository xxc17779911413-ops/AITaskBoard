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
  const s = store.createNode({ parentId: r.id, type: 'subreq', name: 'S' })
  return { tmp, store, p, r, s }
}

const findingsByRule = (scan) => Object.fromEntries(scan.findings.map((f) => [f.rule, f]))

test('secret_scan：无文档是 ready=null 空态，不伪造成安全通过', async (t) => {
  const { tmp, store, p } = await setup()
  t.after(() => tmp.cleanup())
  store.deleteNode(store.listChildren(p.id)[0].id)
  const scan = store.buildSecretScan(p.id)
  assert.equal(scan.ready, null)
  assert.equal(scan.totals.documents, 0)
  assert.equal(scan.totals.findings, 0)
  assert.deepEqual(scan.blockers, [])
})

test('secret_scan：危险凭据命中阻塞，warn 命中不阻塞', async (t) => {
  const { tmp, store, r } = await setup()
  t.after(() => tmp.cleanup())
  store.upsertDocument(r.id, '联调说明', [
    '更新文档时把 token 写进来了',
    'token=abcdefghijklmnop',
    'Authorization: Bearer abcdefghijklmnopqrstuvwxyz'
  ].join('\n'))
  const scan = store.buildSecretScan(r.id)
  assert.equal(scan.ready, false)
  assert.equal(scan.totals.danger, 1)
  assert.equal(scan.totals.warnings, 1)
  assert.equal(scan.blockers[0].rule, 'generic_secret_assignment')
  assert.equal(scan.warnings[0].rule, 'bearer_token')
})

test('secret_scan：AWS / GitHub / Slack / JWT / 私钥块独立命中', async (t) => {
  const { tmp, store, r } = await setup()
  t.after(() => tmp.cleanup())
  // 运行时拼接测试样例，避免仓库内容被远端 secret scanning 误判成真实凭据。
  const dummy = {
    aws: ['AKIA', '1234567890ABCDEF'].join(''),
    github: ['ghp_', 'abcdefghijklmnopqrstuvwxyz1234567890'].join(''),
    slack: ['xoxb-', '123456789012-abcdefghijklmnop'].join(''),
    jwt: ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', 'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'].join('.'),
    pem: ['-----BEGIN ', 'PRIVATE KEY-----'].join('')
  }
  store.upsertDocument(r.id, '凭据清单', [
    `aws=${dummy.aws}`,
    `github=${dummy.github}`,
    `slack=${dummy.slack}`,
    `jwt=${dummy.jwt}`,
    dummy.pem
  ].join('\n'))
  const scan = store.buildSecretScan(r.id)
  assert.equal(scan.ready, false)
  assert.deepEqual(
    Object.keys(findingsByRule(scan)).sort(),
    ['aws_access_key', 'github_token', 'jwt', 'private_key_block', 'slack_token']
  )
})

test('secret_scan：示例 / 占位值不误伤，避免长期噪声', async (t) => {
  const { tmp, store, r } = await setup()
  t.after(() => tmp.cleanup())
  store.upsertDocument(r.id, '示例', [
    'token=<your-token>',
    'api_key=EXAMPLE_PLACEHOLDER',
    'password=changeme',
    '私钥文件必须是 PEM 格式（正文不粘贴）'
  ].join('\n'))
  const scan = store.buildSecretScan(r.id)
  assert.equal(scan.ready, true)
  assert.equal(scan.totals.findings, 0)
})

test('secret_scan：占位值与真实凭据同一行时仍命中真实值（占位值不提前终止扫描）', async (t) => {
  const { tmp, store, r } = await setup()
  t.after(() => tmp.cleanup())
  store.upsertDocument(r.id, '联调说明', 'token=<your-token>; fallback token=abcdefghijklmnop')
  const scan = store.buildSecretScan(r.id)
  assert.equal(scan.ready, false)
  assert.equal(scan.totals.danger, 1)
  assert.equal(scan.findings[0].rule, 'generic_secret_assignment')
  assert.ok(!JSON.stringify(scan).includes('abcdefghijklmnop'))
})

test('secret_scan：命中证据强制脱敏，接口输出不包含原值', async (t) => {
  const { tmp, store, r } = await setup()
  t.after(() => tmp.cleanup())
  const secret = 'sk-live-abcdefghijklmnopqrstuvwxyz'
  store.upsertDocument(r.id, '联调说明', `token=${secret}`)
  const scan = store.buildSecretScan(r.id)
  const json = JSON.stringify(scan)
  assert.ok(!json.includes(secret), '扫描结果不得回显凭据原文')
  assert.ok(scan.findings[0].redacted.includes('***'))
  assert.match(scan.findings[0].excerpt, /\[REDACTED:generic_secret_assignment\]/)
})

test('D1 回归：同一行两个 generic 凭据时，任一 excerpt 都不泄露另一个原文', async (t) => {
  const { tmp, store, r } = await setup()
  t.after(() => tmp.cleanup())
  const a = 'abcdefghijklmnop'
  const b = 'qrstuvwxyzabcdef'
  store.upsertDocument(r.id, '联调说明', `token=${a} password=${b}`)
  const scan = store.buildSecretScan(r.id)
  assert.equal(scan.totals.danger, 2)
  const json = JSON.stringify(scan)
  assert.ok(!json.includes(a), '第一个凭据原文不得出现在任何输出中')
  assert.ok(!json.includes(b), '第二个凭据原文不得出现在任何输出中')
  for (const f of scan.findings) {
    assert.equal((f.excerpt.match(/\[REDACTED:generic_secret_assignment\]/g) || []).length, 2)
  }
})

test('D1 回归：同一行 AWS + generic 凭据时，两类 excerpt 都完整脱敏', async (t) => {
  const { tmp, store, r } = await setup()
  t.after(() => tmp.cleanup())
  const aws = ['AKIA', '1234567890ABCDEF'].join('')
  const token = 'abcdefghijklmnop'
  store.upsertDocument(r.id, '联调说明', `aws=${aws} token=${token}`)
  const scan = store.buildSecretScan(r.id)
  assert.equal(scan.totals.danger, 2)
  const json = JSON.stringify(scan)
  assert.ok(!json.includes(aws), 'AWS 原文不得出现在任何输出中')
  assert.ok(!json.includes(token), 'generic 原文不得出现在任何输出中')
  assert.ok(scan.findings.every((f) => !f.excerpt.includes('AKIA') && !f.excerpt.includes(token)))
})

test('secret_scan：scope=self 只看本节点；subtree 纳入子树并回填来源节点', async (t) => {
  const { tmp, store, r, s } = await setup()
  t.after(() => tmp.cleanup())
  store.upsertDocument(s.id, '子需求说明', 'token=abcdefghijklmnop')
  assert.equal(store.buildSecretScan(r.id, { scope: 'self' }).ready, null)
  const sub = store.buildSecretScan(r.id, { scope: 'subtree' })
  assert.equal(sub.ready, false)
  assert.equal(sub.findings[0].nodeId, s.id)
  assert.equal(sub.findings[0].nodeName, 'S')
})

test('secret_scan：纯读聚合不产生 revision', async (t) => {
  const { tmp, store, r } = await setup()
  t.after(() => tmp.cleanup())
  const before = store.getRevision()
  store.buildSecretScan(r.id)
  store.buildSecretScan(r.id, { scope: 'subtree' })
  assert.equal(store.getRevision(), before)
})

test('secret_scan：非法 scope / format 一律 VALIDATION_FAILED', async (t) => {
  const { tmp, store, r } = await setup()
  t.after(() => tmp.cleanup())
  assert.throws(() => store.buildSecretScan(r.id, { scope: 'Subtree' }), /VALIDATION_FAILED/)
  assert.throws(() => store.buildSecretScan(r.id, { scope: '' }), /VALIDATION_FAILED/)
  assert.throws(() => store.normalizeFormat('xml'), /VALIDATION_FAILED/)
})

test('secret_scan：markdown 渲染含脱敏证据且转义表格字符', async (t) => {
  const { tmp, store, r } = await setup()
  t.after(() => tmp.cleanup())
  store.upsertDocument(r.id, 'a|b', 'token=abcdefghijklmnop')
  const { renderSecretScanMd } = await import('../server/ops.mjs')
  const md = renderSecretScanMd(store.buildSecretScan(r.id))
  assert.match(md, /^# 文档敏感信息扫描：R/m)
  assert.match(md, /发现高危凭据/)
  assert.ok(!md.includes('abcdefghijklmnop'))
  assert.match(md, /\[REDACTED:generic_secret_assignment\]/)
})

test('secret_scan：能力清单登记 secret_scan', async (t) => {
  const { tmp } = await setup()
  t.after(() => tmp.cleanup())
  const { TOOLS } = await import('../server/ops.mjs')
  assert.ok(TOOLS.includes('secret_scan'))
})

test('HTTP secret-scan：JSON / md / scope / 非法参数与 store 一致', async (t) => {
  const { tmp, store, p, r, s } = await setup()
  t.after(() => tmp.cleanup())
  store.upsertDocument(r.id, '需求内容', 'token=abcdefghijklmnop')
  store.upsertDocument(s.id, '子需求说明', 'token=qrstuvwxyzabcdef')

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

  const jsonOut = await fetch(`${base}/api/nodes/${r.id}/secret-scan`).then((x) => x.json())
  assert.deepEqual(jsonOut, store.buildSecretScan(r.id))
  assert.equal(jsonOut.ready, false)

  const subOut = await fetch(`${base}/api/nodes/${p.id}/secret-scan?scope=subtree`).then((x) => x.json())
  assert.deepEqual(subOut.findings.map((f) => f.nodeName), ['R', 'S'])

  const mdRes = await fetch(`${base}/api/nodes/${r.id}/secret-scan?format=md`)
  assert.match(mdRes.headers.get('content-type'), /text\/markdown/)
  assert.match(await mdRes.text(), /# 文档敏感信息扫描：R/)

  for (const q of ['scope=Subtree', 'format=xml', 'scope=']) {
    const res = await fetch(`${base}/api/nodes/${r.id}/secret-scan?${q}`)
    assert.equal(res.status, 400, `${q} 应当 400`)
    assert.equal((await res.json()).error.code, 'VALIDATION_FAILED')
  }
})

test('D1 回归：同行多凭据在 HTTP / markdown 中不回显任一原值', async (t) => {
  const { tmp, store, r } = await setup()
  t.after(() => tmp.cleanup())
  const a = 'abcdefghijklmnop'
  const b = 'qrstuvwxyzabcdef'
  store.upsertDocument(r.id, '联调说明', `token=${a} password=${b}`)
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

  const jsonText = await fetch(`${base}/api/nodes/${r.id}/secret-scan`).then((x) => x.text())
  assert.ok(!jsonText.includes(a) && !jsonText.includes(b))

  const mdText = await fetch(`${base}/api/nodes/${r.id}/secret-scan?format=md`).then((x) => x.text())
  assert.ok(!mdText.includes(a) && !mdText.includes(b))
  assert.match(mdText, /\[REDACTED:generic_secret_assignment\]/)
})

async function mcpClient() {
  const tmp = await tempHome()
  const store = tmp.store.createStore(tmp.openDb())
  const { createMcpServer } = await import('../server/mcp.mjs')
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js')
  const server = createMcpServer({ store })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: 'taskboard-secret-scan-test', version: '1.0.0' })
  await client.connect(clientTransport)
  return {
    tmp,
    store,
    call: (name, args) => client.callTool({ name, arguments: args }),
    close: async () => {
      await client.close()
      await server.close()
      tmp.cleanup()
    }
  }
}

test('MCP secret_scan：JSON / md / 非法参数 isError 与 store 一致', async (t) => {
  const { store, call, close } = await mcpClient()
  t.after(async () => {
    await close()
  })
  const p = store.createNode({ type: 'project', name: 'P' })
  const r = store.createNode({ parentId: p.id, type: 'requirement', name: 'R' })
  store.upsertDocument(r.id, '需求内容', 'token=abcdefghijklmnop')

  const out = await call('secret_scan', { node: String(r.id) })
  assert.equal(out.isError, undefined)
  assert.deepEqual(JSON.parse(out.content[0].text), store.buildSecretScan(r.id))

  const { renderSecretScanMd } = await import('../server/ops.mjs')
  const md = await call('secret_scan', { node: String(r.id), format: 'md' })
  assert.equal(md.content[0].text, renderSecretScanMd(store.buildSecretScan(r.id)))

  for (const args of [{ node: String(r.id), scope: 'sub' }, { node: String(r.id), format: 'xml' }]) {
    const bad = await call('secret_scan', args)
    assert.equal(bad.isError, true)
    assert.match(bad.content[0].text, /VALIDATION_FAILED/)
    assert.ok(!/MCP error -32602/.test(bad.content[0].text))
  }
})

test('D2 回归：MCP 非字符串 scope / format 返回 VALIDATION_FAILED，不泄漏 -32602', async (t) => {
  const { store, call, close } = await mcpClient()
  t.after(async () => {
    await close()
  })
  const p = store.createNode({ type: 'project', name: 'P' })
  const r = store.createNode({ parentId: p.id, type: 'requirement', name: 'R' })
  store.upsertDocument(r.id, '联调说明', 'token=abcdefghijklmnop')

  for (const args of [
    { node: String(r.id), scope: 1 },
    { node: String(r.id), scope: true },
    { node: String(r.id), format: 1 },
    { node: String(r.id), format: ['md'] }
  ]) {
    const out = await call('secret_scan', args)
    assert.equal(out.isError, true, JSON.stringify(args))
    assert.match(out.content[0].text, /VALIDATION_FAILED/)
    assert.ok(!/MCP error -32602/.test(out.content[0].text), JSON.stringify(args))
  }
})

test('D1 回归：MCP 与 markdown 输出同行多凭据均不回显原值', async (t) => {
  const { store, call, close } = await mcpClient()
  t.after(async () => {
    await close()
  })
  const p = store.createNode({ type: 'project', name: 'P' })
  const r = store.createNode({ parentId: p.id, type: 'requirement', name: 'R' })
  const a = 'abcdefghijklmnop'
  const b = 'qrstuvwxyzabcdef'
  store.upsertDocument(r.id, '联调说明', `token=${a} password=${b}`)

  const jsonOut = await call('secret_scan', { node: String(r.id) })
  assert.ok(!jsonOut.content[0].text.includes(a) && !jsonOut.content[0].text.includes(b))

  const mdOut = await call('secret_scan', { node: String(r.id), format: 'md' })
  assert.ok(!mdOut.content[0].text.includes(a) && !mdOut.content[0].text.includes(b))
})

test('CLI secret scan：JSON / md / 非法参数与 store 一致', async (t) => {
  const { tmp, store, r } = await setup()
  const home = tmp.dir
  t.after(() => tmp.cleanup())
  store.upsertDocument(r.id, '需求内容', 'token=abcdefghijklmnop')
  const expected = store.buildSecretScan(r.id)

  const { stdout } = await execFileP('node', [CLI, 'secret', 'scan', 'P/R'], {
    env: { ...process.env, TASKBOARD_HOME: home },
    encoding: 'utf8'
  })
  assert.deepEqual(JSON.parse(stdout), expected)
  assert.equal(JSON.parse(stdout).ready, false)

  const md = await execFileP('node', [CLI, 'secret', 'scan', 'P/R', '--format', 'md', '--scope', 'subtree'], {
    env: { ...process.env, TASKBOARD_HOME: home },
    encoding: 'utf8'
  })
  assert.match(md.stdout, /# 文档敏感信息扫描：R/)

  await assert.rejects(
    execFileP('node', [CLI, 'secret', 'scan', 'P/R', '--scope', 'Subtree'], {
      env: { ...process.env, TASKBOARD_HOME: home },
      encoding: 'utf8'
    }),
    /VALIDATION_FAILED/
  )
})

test('D1 回归：同行多凭据在 CLI JSON / markdown 中不回显任一原值', async (t) => {
  const { tmp, store, r } = await setup()
  const home = tmp.dir
  t.after(() => tmp.cleanup())
  const a = 'abcdefghijklmnop'
  const b = 'qrstuvwxyzabcdef'
  store.upsertDocument(r.id, '联调说明', `token=${a} password=${b}`)

  const jsonOut = await execFileP('node', [CLI, 'secret', 'scan', 'P/R'], {
    env: { ...process.env, TASKBOARD_HOME: home },
    encoding: 'utf8'
  })
  assert.ok(!jsonOut.stdout.includes(a) && !jsonOut.stdout.includes(b))

  const mdOut = await execFileP('node', [CLI, 'secret', 'scan', 'P/R', '--format', 'md'], {
    env: { ...process.env, TASKBOARD_HOME: home },
    encoding: 'utf8'
  })
  assert.ok(!mdOut.stdout.includes(a) && !mdOut.stdout.includes(b))
  assert.match(mdOut.stdout, /\[REDACTED:generic_secret_assignment\]/)
})
