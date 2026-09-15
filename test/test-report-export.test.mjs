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
  const store = tmp.store.createStore(tmp.openDb(path.join(tmp.dir, 'data.db')))
  const p = store.createNode({ type: 'project', name: 'P' })
  const r = store.createNode({ parentId: p.id, type: 'requirement', name: 'R' })
  const testCase = store.createTestCase(r.id, { name: '登录回归', prompt: '跑登录单测' })
  const report = store.createTestReport(r.id, { caseId: testCase.id, kind: 'regression' })
  store.finishTestReport(report.id, { status: 'pass', summary: '17/17 全绿', detail: 'npm test 输出见 run 7' })
  return { tmp, store, p, r, testCase, report: store.getTestReport(report.id) }
}

test('renderTestReportMd：单条报告渲染成可贴进 issue / MR 的 markdown，且只读', async (t) => {
  const { tmp, store, r, testCase, report } = await setup()
  t.after(() => tmp.cleanup())
  const { renderTestReportMd } = await import('../server/ops.mjs')

  const before = store.getRevision()
  const md = renderTestReportMd(store, report)
  assert.equal(store.getRevision(), before)
  assert.match(md, /^# 测试报告 #\d+：登录回归/m)
  assert.ok(md.includes(`- 节点：P/R（requirement）`))
  assert.ok(md.includes('- 类型：回归测试（regression）'))
  assert.ok(md.includes('- 结论：通过（pass）'))
  assert.ok(md.includes('- 结论来源：人工 / 前台回写'))
  assert.ok(md.includes('- agent 任务：未关联'))
  assert.ok(md.includes('## 摘要'))
  assert.ok(md.includes('17/17 全绿'))
  assert.ok(md.includes('## 详情'))
  assert.ok(md.includes('npm test 输出见 run 7'))

  store.deleteTestCase(testCase.id)
  const kept = store.getTestReport(report.id)
  const historyMd = renderTestReportMd(store, kept)
  assert.ok(historyMd.includes('（用例已删除）'))
  assert.equal(kept.caseId, null)
  assert.equal(r.id, report.nodeId)
})

test('HTTP：GET /api/test-reports/:rid 支持 format=md，非法 format 返回 VALIDATION_FAILED', async (t) => {
  const { tmp, store, report } = await setup()
  const { createApp } = await import('../server/http.mjs')
  const app = createApp({ store })
  const server = await new Promise((resolve, reject) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s))
    s.once('error', reject)
  })
  const base = `http://127.0.0.1:${server.address().port}`
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve))
    tmp.cleanup()
  })

  const before = store.getRevision()
  const json = await fetch(`${base}/api/test-reports/${report.id}`).then((res) => res.json())
  assert.equal(json.id, report.id)

  const mdRes = await fetch(`${base}/api/test-reports/${report.id}?format=md`)
  assert.equal(mdRes.status, 200)
  assert.match(mdRes.headers.get('content-type') || '', /text\/markdown/)
  const md = await mdRes.text()
  assert.ok(md.startsWith(`# 测试报告 #${report.id}`))
  assert.ok(md.includes('登录回归'))
  assert.ok(md.includes('17/17 全绿'))

  const bad = await fetch(`${base}/api/test-reports/${report.id}?format=xml`)
  assert.equal(bad.status, 400)
  const body = await bad.json()
  assert.equal(body.error.code, 'VALIDATION_FAILED')
  assert.deepEqual(body.error.details.allowed, ['json', 'md'])
  assert.equal(store.getRevision(), before)
})

test('CLI：test report get --format md 输出 markdown，非法 format 非零退出', async (t) => {
  const { tmp, store, report } = await setup()
  store.db.close()
  t.after(() => tmp.cleanup())

  const { stdout } = await execFileP('node', [CLI, 'test', 'report', 'get', String(report.id), '--format', 'md'], {
    env: { ...process.env, TASKBOARD_HOME: tmp.dir },
    encoding: 'utf8'
  })
  assert.ok(stdout.startsWith(`# 测试报告 #${report.id}`))
  assert.ok(stdout.includes('登录回归'))
  assert.ok(stdout.includes('17/17 全绿'))

  let cliError = null
  try {
    await execFileP('node', [CLI, 'test', 'report', 'get', String(report.id), '--format', 'xml'], {
      env: { ...process.env, TASKBOARD_HOME: tmp.dir },
      encoding: 'utf8'
    })
  } catch (e) {
    cliError = e
  }
  assert.ok(cliError, 'CLI 非法 format 应当非零退出')
  const output = String(cliError.stderr || '') + String(cliError.stdout || '')
  assert.match(output, /VALIDATION_FAILED/)
})

test('MCP：test_report_get 支持 format=md，非法 format 返回 isError + VALIDATION_FAILED', async (t) => {
  const { tmp, store, report } = await setup()
  const { createMcpServer } = await import('../server/mcp.mjs')
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js')
  const mcpServer = createMcpServer({ store })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await mcpServer.connect(serverTransport)
  const client = new Client({ name: 'taskboard-report-export-test', version: '1.0.0' })
  await client.connect(clientTransport)
  t.after(async () => {
    await client.close()
    await mcpServer.close()
    tmp.cleanup()
  })

  const before = store.getRevision()
  const js = await client.callTool({ name: 'test_report_get', arguments: { id: report.id } })
  assert.equal(JSON.parse(js.content[0].text).id, report.id)

  const md = await client.callTool({ name: 'test_report_get', arguments: { id: report.id, format: 'md' } })
  assert.equal(md.isError, undefined)
  assert.ok(md.content[0].text.startsWith(`# 测试报告 #${report.id}`))
  assert.ok(md.content[0].text.includes('登录回归'))

  const bad = await client.callTool({ name: 'test_report_get', arguments: { id: report.id, format: 'xml' } })
  assert.equal(bad.isError, true)
  assert.match(bad.content[0].text, /VALIDATION_FAILED/)
  assert.equal(store.getRevision(), before)
})
