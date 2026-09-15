import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { tempHome } from './helpers.mjs'

const execFileP = promisify(execFile)
const CLI = path.resolve(import.meta.dirname, '../bin/taskboard.js')

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
  const client = new Client({ name: 'taskboard-biz-gate-test', version: '1.0.0' })
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

test('CLI business gate：真实子进程输出 JSON，与 store 逐字段一致', async (t) => {
  const tmp = await tempHome()
  t.after(() => tmp.cleanup())
  await cli(tmp.dir, ['node', 'upsert', '--path', 'P/R'])
  await cli(tmp.dir, ['node', 'upsert', '--path', 'P/R/S', '--type', 'subreq'])
  await cli(tmp.dir, ['test', 'case', 'upsert', 'P/R', '--name', '业务检查项', '--prompt', 'p', '--kind', 'biz_check'])

  const out = JSON.parse(await cli(tmp.dir, ['business', 'gate', 'P/R']))
  const store = tmp.store.createStore(tmp.openDb())
  const expected = store.buildBusinessGate(store.resolveRef('P/R').id)
  assert.deepEqual(out, expected)
  assert.equal(out.ready, false)
  assert.equal(out.totals.notRun, 1)
})

test('CLI business gate：--format md 输出可贴的 markdown', async (t) => {
  const tmp = await tempHome()
  t.after(() => tmp.cleanup())
  await cli(tmp.dir, ['node', 'upsert', '--path', 'P/R'])
  await cli(tmp.dir, ['test', 'case', 'upsert', 'P/R', '--name', 'C', '--prompt', 'p', '--kind', 'biz_check'])
  const md = await cli(tmp.dir, ['business', 'gate', 'P/R', '--format', 'md'])
  assert.ok(md.startsWith('# 业务检查：R'))
  assert.ok(md.includes('业务检查用例'))
})

test('CLI business gate：非法 --scope 非零退出且报 VALIDATION_FAILED', async (t) => {
  const tmp = await tempHome()
  t.after(() => tmp.cleanup())
  await cli(tmp.dir, ['node', 'upsert', '--path', 'P/R'])
  await assert.rejects(
    () => cli(tmp.dir, ['business', 'gate', 'P/R', '--scope', 'Subtree']),
    (e) => String(e.stderr || '').includes('VALIDATION_FAILED') || String(e.stdout || '').includes('VALIDATION_FAILED')
  )
})

test('MCP business_gate：真实协议输出与 store 一致；非法 scope 返回 isError 而非 SDK -32602', async (t) => {
  const { tmp, store, call, close } = await mcpClient()
  t.after(async () => {
    await close()
    tmp.cleanup()
  })
  const p = store.createNode({ type: 'project', name: 'P' })
  const r = store.createNode({ parentId: p.id, type: 'requirement', name: 'R' })
  const c = store.createTestCase(r.id, { name: '业务检查项', prompt: 'p', kind: 'biz_check' })

  const res = await call('business_gate', { node: r.id })
  const text = res.content.map((x) => x.text).join('')
  const parsed = JSON.parse(text)
  assert.deepEqual(parsed, store.buildBusinessGate(r.id))
  assert.equal(parsed.ready, false)

  // 完结为 pass 后放行
  const rep = store.createTestReport(r.id, { caseId: c.id, kind: 'biz_check' })
  store.finishTestReport(rep.id, { status: 'pass' })
  const ok = await call('business_gate', { node: r.id })
  assert.equal(JSON.parse(ok.content.map((x) => x.text).join('')).ready, true)

  // 非法 scope 走业务校验（isError + VALIDATION_FAILED），不泄漏 SDK -32602
  const bad = await call('business_gate', { node: r.id, scope: 'Subtree' })
  assert.equal(bad.isError, true)
  assert.ok(bad.content.map((x) => x.text).join('').includes('VALIDATION_FAILED'))

  // md 形态
  const md = await call('business_gate', { node: r.id, format: 'md' })
  assert.ok(md.content.map((x) => x.text).join('').startsWith('# 业务检查：R'))
})
