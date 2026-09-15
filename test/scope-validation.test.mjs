import test from 'node:test'
import assert from 'node:assert/strict'
import { tempHome } from './helpers.mjs'

async function setup() {
  const tmp = await tempHome()
  const db = tmp.openDb()
  const store = tmp.store.createStore(db)
  const p = store.createNode({ type: 'project', name: 'P' })
  const r = store.createNode({ parentId: p.id, type: 'requirement', name: 'R' })
  const s = store.createNode({ parentId: r.id, type: 'subreq', name: 'S' })
  return { tmp, store, p, r, s }
}

// 各入口的 scope 值域必须一致：合法值正常，非法值必须 VALIDATION_FAILED。
// 回归背景（D2）：三入口此前都是 `scope === 'subtree' ? 'subtree' : 'self'`，
// 把 `Subtree`（大小写错）/ `xyz` / 空串一律吞成 self，让未就绪子树被汇报成 ready=true。
const LEGAL = ['self', 'subtree']
const ILLEGAL = ['Subtree', 'SUBTREE', 'subtre', 'Sub tree', 'xyz', '', ' ']

test('scope：缺省（undefined/null）按 self 处理，合法值原样返回', async (t) => {
  const { tmp, store } = await setup()
  t.after(() => tmp.cleanup())
  assert.equal(store.normalizeScope(undefined), 'self')
  assert.equal(store.normalizeScope(null), 'self')
  for (const v of LEGAL) assert.equal(store.normalizeScope(v), v)
  // fallback 可覆盖缺省值
  assert.equal(store.normalizeScope(undefined, 'subtree'), 'subtree')
})

test('scope：非法值一律 VALIDATION_FAILED，details 带合法值域', async (t) => {
  const { tmp, store } = await setup()
  t.after(() => tmp.cleanup())
  for (const v of ILLEGAL) {
    assert.throws(
      () => store.normalizeScope(v),
      (e) => e.code === 'VALIDATION_FAILED' && Array.isArray(e.details.allowed) && e.details.allowed.join(',') === 'self,subtree',
      `scope=${JSON.stringify(v)} 应当被拒绝`
    )
  }
})

test('scope：聚合构建器全部拒绝非法值（不再静默降级 self）', async (t) => {
  const { tmp, store, p, r } = await setup()
  t.after(() => tmp.cleanup())
  const builders = [
    ['buildRequirementReadiness', () => store.buildRequirementReadiness(r.id, { scope: 'Subtree' })],
    ['buildAcceptanceReport', () => store.buildAcceptanceReport(r.id, { scope: 'Subtree' })],
    ['buildReleaseChecklist', () => store.buildReleaseChecklist(r.id, { scope: 'Subtree' })],
    ['buildDeliveryGate', () => store.buildDeliveryGate(r.id, { scope: 'Subtree' })],
    ['buildWorkflowMap', () => store.buildWorkflowMap(r.id, { scope: 'Subtree' })]
  ]
  for (const [name, fn] of builders) {
    assert.throws(fn, /VALIDATION_FAILED/, `${name} 应当拒绝非法 scope`)
  }
  // 项目节点 + subtree 同理
  assert.throws(() => store.buildRequirementReadiness(p.id, { scope: 'xyz' }), /VALIDATION_FAILED/)
})

test('scope：非法值不再让未就绪子树变成 ready=true（D2 核心回归）', async (t) => {
  const { tmp, store, r, s } = await setup()
  t.after(() => tmp.cleanup())
  // R 就绪、S 未就绪 —— 子树实际未就绪
  store.upsertDocument(r.id, '需求内容', '正文')
  store.upsertDocument(r.id, '概要设计', '设计')
  store.upsertTestCase(r.id, { name: '回归用例', prompt: '跑单测' })

  assert.equal(store.buildRequirementReadiness(r.id, { scope: 'subtree' }).ready, false)
  // 旧实现下这里会静默变成 self → ready=true（假绿）
  for (const bad of ['Subtree', 'subtre', 'xyz', '']) {
    assert.throws(
      () => store.buildRequirementReadiness(r.id, { scope: bad }),
      /VALIDATION_FAILED/,
      `scope=${JSON.stringify(bad)} 不得静默降级`
    )
  }
  // 合法 self 仍只看本节点（这里 R 自身就绪）
  assert.equal(store.buildRequirementReadiness(r.id, { scope: 'self' }).ready, true)
  assert.equal(store.buildRequirementReadiness(r.id, { scope: 'self' }).totals.units, 1)
  assert.equal(store.buildRequirementReadiness(r.id, { scope: 'subtree' }).totals.units, 2)
  assert.ok(s.id > 0)
})

// ---------- MCP 入口（真实 in-memory 协议）：非法 scope 同样不得静默降级 ----------

async function mcpClient() {
  const tmp = await tempHome()
  const store = tmp.store.createStore(tmp.openDb())
  const { createMcpServer } = await import('../server/mcp.mjs')
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js')
  const server = createMcpServer({ store })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: 'taskboard-scope-test', version: '1.0.0' })
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

test('scope：MCP 聚合工具对非法 scope 报错（三入口契约一致）', async (t) => {
  const { tmp, store, call, close } = await mcpClient()
  t.after(async () => {
    await close()
    tmp.cleanup()
  })
  const p = store.createNode({ type: 'project', name: 'P' })
  const r = store.createNode({ parentId: p.id, type: 'requirement', name: 'R' })
  for (const tool of ['requirement_readiness', 'acceptance_report', 'release_checklist', 'delivery_gate', 'workflow_map']) {
    // handler 内统一业务校验：返回 isError + VALIDATION_FAILED，不泄漏 SDK -32602
    const out = await call(tool, { node: r.id, scope: 'Subtree' })
    assert.equal(out.isError, true, `${tool} 应当拒绝非法 scope`)
    assert.match(out.content[0].text, /VALIDATION_FAILED/)
    assert.match(out.content[0].text, /\["self","subtree"\]/)
  }
})

test('scope：其余 MCP 工具也不泄漏 -32602（横切契约）', async (t) => {
  const { tmp, store, call, close } = await mcpClient()
  t.after(async () => {
    await close()
    tmp.cleanup()
  })
  const p = store.createNode({ type: 'project', name: 'P' })
  for (const [tool, args] of [
    ['node_diffs', { ref: 'P', scope: 'sub' }],
    ['node_tracks', { ref: 'P', scope: 'sub' }],
    ['commit_duplicates', { ref: 'P', scope: 'sub' }],
    ['release_check', { node: p.id, scope: 'sub', dryRun: true }]
  ]) {
    const out = await call(tool, args)
    assert.equal(out.isError, true, `${tool} 应当拒绝非法 scope`)
    assert.match(out.content[0].text, /VALIDATION_FAILED/, tool)
    assert.ok(!/MCP error -32602/.test(out.content[0].text), `${tool} 不得泄漏 SDK -32602`)
  }
})
