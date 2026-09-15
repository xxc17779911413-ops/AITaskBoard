import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import fs from 'node:fs'
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

/** 登记一条 kind=sql 上线项（默认带回滚，便于只测规则本身） */
function addSql(store, nodeId, name, content, { rollback = 'ROLLBACK SCRIPT' } = {}) {
  return store.createReleaseItem(nodeId, { name, kind: 'sql', content, rollback })
}

async function mcpClient(existing) {
  const tmp = existing ? null : await tempHome()
  const store = existing || tmp.store.createStore(tmp.openDb())
  const { createMcpServer } = await import('../server/mcp.mjs')
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js')
  const server = createMcpServer({ store })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: 'taskboard-sql-audit-test', version: '1.0.0' })
  await client.connect(clientTransport)
  const call = (name, args) => client.callTool({ name, arguments: args })
  return {
    tmp,
    store,
    call,
    close: async () => {
      await client.close()
      await server.close()
      if (tmp) tmp.cleanup()
    }
  }
}

// ---------- store：规则集 ----------

test('sql audit：四条 danger 规则各自独立命中并阻塞', async (t) => {
  const { tmp, store, r } = await setup()
  t.after(() => tmp.cleanup())
  addSql(store, r.id, 'drop', 'DROP TABLE t_user;')
  addSql(store, r.id, 'truncate', 'TRUNCATE TABLE t_order;')
  addSql(store, r.id, 'delete', 'DELETE FROM t_order;')
  addSql(store, r.id, 'update', 'UPDATE t_user SET name = "x";')

  const audit = store.buildReleaseSqlAudit(r.id)
  assert.equal(audit.ready, false)
  assert.equal(audit.totals.sqlItems, 4)
  assert.equal(audit.totals.danger, 4)
  const keys = audit.blockers.map((b) => b.key).sort()
  assert.deepEqual(keys, ['delete_without_where', 'drop_table', 'truncate', 'update_without_where'])
})

test('sql audit：带 WHERE 的 UPDATE/DELETE 不命中；DROP 只在 DROP TABLE/DATABASE 命中', async (t) => {
  const { tmp, store, r } = await setup()
  t.after(() => tmp.cleanup())
  addSql(store, r.id, 'safe', 'UPDATE t_user SET name = "x" WHERE id = 1; DELETE FROM t_order WHERE id = 2;')
  const audit = store.buildReleaseSqlAudit(r.id)
  assert.equal(audit.ready, true)
  assert.equal(audit.totals.danger, 0)
  assert.equal(audit.blockers.length, 0)
})

test('sql audit：多语句按语句边界判 WHERE，不被同段带 WHERE 的语句洗白', async (t) => {
  const { tmp, store, r } = await setup()
  t.after(() => tmp.cleanup())
  // 一段里同时有无条件 DELETE 与带 WHERE 的 UPDATE —— 无条件 DELETE 必须被拦
  addSql(store, r.id, 'mixed', 'DELETE FROM t_a; UPDATE t_b SET x = 1 WHERE id = 2;')
  const audit = store.buildReleaseSqlAudit(r.id)
  assert.equal(audit.ready, false)
  assert.deepEqual(audit.blockers.map((b) => b.key), ['delete_without_where'])
})

test('sql audit：大小写不敏感', async (t) => {
  const { tmp, store, r } = await setup()
  t.after(() => tmp.cleanup())
  addSql(store, r.id, 'lower', 'drop table t_x;')
  const audit = store.buildReleaseSqlAudit(r.id)
  assert.equal(audit.ready, false)
  assert.equal(audit.blockers[0].key, 'drop_table')
})

test('sql audit：注释里的关键字不误伤（行注释 + 块注释）', async (t) => {
  const { tmp, store, r } = await setup()
  t.after(() => tmp.cleanup())
  addSql(store, r.id, 'commented', '-- DROP TABLE foo\n/* TRUNCATE TABLE bar */\nUPDATE t SET x = 1 WHERE id = 1;')
  const audit = store.buildReleaseSqlAudit(r.id)
  assert.equal(audit.ready, true)
  assert.equal(audit.totals.danger, 0)
})

// ---------- 词法边界反例（独立测试 D1/D2/D3 的固定回归） ----------
// 三处判定必须共享同一份词法状态：字符串字面量不得影响注释剥离 / `;` 分段 / `WHERE` 判定。

test('D1 回归：字符串字面量里的 where 不能洗白无条件的 UPDATE', async (t) => {
  const { tmp, store, r } = await setup()
  t.after(() => tmp.cleanup())
  addSql(store, r.id, 'd1', "UPDATE t SET note = 'where';")
  const audit = store.buildReleaseSqlAudit(r.id)
  assert.equal(audit.ready, false, "字面量 'where' 不是真正的 WHERE，必须判定为缺 WHERE")
  assert.deepEqual(audit.blockers.map((b) => b.key), ['update_without_where'])
})

test('D1 回归：双引号 / 反引号字面量里的 where 同样不能洗白', async (t) => {
  const { tmp, store, r } = await setup()
  t.after(() => tmp.cleanup())
  addSql(store, r.id, 'd1-dq', 'UPDATE t SET note = "where";')
  addSql(store, r.id, 'd1-bq', 'UPDATE t SET note = `where`;')
  addSql(store, r.id, 'd1-esc', "UPDATE t SET note = 'it''s where';")
  const audit = store.buildReleaseSqlAudit(r.id)
  assert.equal(audit.ready, false)
  assert.equal(audit.totals.danger, 3)
  assert.ok(audit.blockers.every((b) => b.key === 'update_without_where'))
})

test('D2 回归：字符串字面量里的 -- 不能吞掉后续 DROP TABLE', async (t) => {
  const { tmp, store, r } = await setup()
  t.after(() => tmp.cleanup())
  addSql(store, r.id, 'd2', "SELECT '--'; DROP TABLE t;")
  const audit = store.buildReleaseSqlAudit(r.id)
  assert.equal(audit.ready, false, "字面量里的 -- 是字符串内容，不是行注释")
  assert.deepEqual(audit.blockers.map((b) => b.key), ['drop_table'])
})

test('D2 回归：字符串字面量里的 /* */ 不能吞掉后续 TRUNCATE', async (t) => {
  const { tmp, store, r } = await setup()
  t.after(() => tmp.cleanup())
  addSql(store, r.id, 'd2-block', "SELECT '/* hidden */'; TRUNCATE TABLE t;")
  const audit = store.buildReleaseSqlAudit(r.id)
  assert.equal(audit.ready, false)
  assert.deepEqual(audit.blockers.map((b) => b.key), ['truncate'])
})

test('D2 回归：真实行注释 / 块注释仍然不误伤后续危险语句识别', async (t) => {
  const { tmp, store, r } = await setup()
  t.after(() => tmp.cleanup())
  // 注释本身被掩掉，但注释之后的 DROP TABLE 必须照常命中
  addSql(store, r.id, 'd2-real-comment', "-- 说明：这次要删表\n/* 迁移脚本 */\nDROP TABLE t;")
  const audit = store.buildReleaseSqlAudit(r.id)
  assert.equal(audit.ready, false)
  assert.deepEqual(audit.blockers.map((b) => b.key), ['drop_table'])
})

test('D3 回归：字符串字面量里的 ; 不能切断语句（合法 UPDATE 不得误报）', async (t) => {
  const { tmp, store, r } = await setup()
  t.after(() => tmp.cleanup())
  addSql(store, r.id, 'd3', "UPDATE t SET note = ';' WHERE id = 1;")
  const audit = store.buildReleaseSqlAudit(r.id)
  assert.equal(audit.ready, true, "字面量里的 ; 不应切段，整条 UPDATE 仍带 WHERE")
  assert.equal(audit.blockers.length, 0)
})

test('D3 回归：字面量里的 ; 与真实分段混排时各自正确', async (t) => {
  const { tmp, store, r } = await setup()
  t.after(() => tmp.cleanup())
  // 第一条带真 WHERE（字面量里还有 ;），第二条无条件 DELETE —— 只有第二条该被拦
  addSql(store, r.id, 'd3-mixed', "UPDATE a SET x = ';' WHERE id = 1; DELETE FROM b;")
  const audit = store.buildReleaseSqlAudit(r.id)
  assert.equal(audit.ready, false)
  assert.deepEqual(audit.blockers.map((b) => b.key), ['delete_without_where'])
})

test('D2/D3 回归：注释里的 ; 也不参与分段', async (t) => {
  const { tmp, store, r } = await setup()
  t.after(() => tmp.cleanup())
  addSql(store, r.id, 'd23', 'UPDATE t SET x = 1 /* a; b */ WHERE id = 2;')
  const audit = store.buildReleaseSqlAudit(r.id)
  assert.equal(audit.ready, true)
  assert.equal(audit.blockers.length, 0)
})

/**
 * S3 规则集契约：六种输入各钉一条。
 * - 缺省（字段不写 / 整个选项不传）→ 用默认规则集；
 * - 空数组 / null / 字符串 / 数字 / 对象 → 非数组显式拒绝 VALIDATION_FAILED，不静默回退默认。
 */
async function sqlAuditStoreFor(t, releaseSqlAudit) {
  const tmp = await tempHome()
  t.after(() => tmp.cleanup())
  const opts = releaseSqlAudit === undefined ? {} : { releaseSqlAudit }
  const store = tmp.store.createStore(tmp.openDb(), opts)
  const p = store.createNode({ type: 'project', name: 'P' })
  const r = store.createNode({ parentId: p.id, type: 'requirement', name: 'R' })
  addSql(store, r.id, 'x', 'DROP TABLE t;')
  return { store, r }
}

test('S3 契约 1/6：rules 缺省（字段不写）→ 用默认规则集', async (t) => {
  const { store, r } = await sqlAuditStoreFor(t, { requireRollback: false })
  const audit = store.buildReleaseSqlAudit(r.id)
  assert.equal(audit.ready, false)
  assert.deepEqual(audit.blockers.map((b) => b.key), ['drop_table'])
})

test('S3 契约 2/6：releaseSqlAudit 整个选项缺省 → 用默认规则集', async (t) => {
  const { store, r } = await sqlAuditStoreFor(t, undefined)
  const audit = store.buildReleaseSqlAudit(r.id)
  assert.equal(audit.ready, false)
  assert.deepEqual(audit.blockers.map((b) => b.key), ['drop_table'])
})

for (const [label, value] of [
  ['空数组', []],
  ['null', null],
  ['字符串', 'drop_table'],
  ['数字', 1],
  ['对象', { key: 'drop_table' }]
]) {
  test(`S3 契约：rules = ${label} → 非数组显式拒绝 VALIDATION_FAILED`, async (t) => {
    const { store, r } = await sqlAuditStoreFor(t, { rules: value })
    assert.throws(
      () => store.buildReleaseSqlAudit(r.id),
      (e) => e.code === 'VALIDATION_FAILED',
      `rules = ${label} 必须显式拒绝，而不是静默回退默认规则集`
    )
  })
}

test('sql audit：DROP COLUMN 与缺回滚是 warn，不阻塞', async (t) => {
  const { tmp, store, r } = await setup()
  t.after(() => tmp.cleanup())
  store.createReleaseItem(r.id, { name: 'column', kind: 'sql', content: 'ALTER TABLE t DROP COLUMN c;', rollback: 'ALTER TABLE t ADD COLUMN c;' })
  store.createReleaseItem(r.id, { name: 'no-rollback', kind: 'sql', content: 'UPDATE t SET x = 1 WHERE id = 1;', rollback: '' })
  const audit = store.buildReleaseSqlAudit(r.id)
  assert.equal(audit.ready, true)
  assert.equal(audit.totals.danger, 0)
  const keys = audit.warnings.map((w) => w.key).sort()
  assert.deepEqual(keys, ['drop_column', 'sql_no_rollback'])
  assert.equal(audit.warnings.length, 2)
})

test('sql audit：非 sql 上线项不参与审查', async (t) => {
  const { tmp, store, r } = await setup()
  t.after(() => tmp.cleanup())
  store.createReleaseItem(r.id, { name: 'config', kind: 'config', content: 'switch=on' })
  store.createReleaseItem(r.id, { name: 'check', kind: 'check', content: '人工确认' })
  const audit = store.buildReleaseSqlAudit(r.id)
  assert.equal(audit.ready, null)
  assert.equal(audit.totals.sqlItems, 0)
})

test('sql audit：空态 ready=null（无 SQL 上线项 ≠ 未通过）', async (t) => {
  const { tmp, store, r } = await setup()
  t.after(() => tmp.cleanup())
  const audit = store.buildReleaseSqlAudit(r.id)
  assert.equal(audit.ready, null)
  assert.equal(audit.totals.sqlItems, 0)
  assert.deepEqual(audit.blockers, [])
})

test('sql audit：scope=self 只看本节点；subtree 纳入子树并汇总', async (t) => {
  const { tmp, store, r, s } = await setup()
  t.after(() => tmp.cleanup())
  addSql(store, r.id, 'root-safe', 'UPDATE t SET x = 1 WHERE id = 1;')
  addSql(store, s.id, 'child-danger', 'DROP TABLE t_child;')
  assert.equal(store.buildReleaseSqlAudit(r.id, { scope: 'self' }).ready, true)
  const sub = store.buildReleaseSqlAudit(r.id, { scope: 'subtree' })
  assert.equal(sub.ready, false)
  assert.equal(sub.totals.sqlItems, 2)
  assert.equal(sub.blockers[0].name, 'child-danger')
})

test('sql audit：纯读聚合，不 bump revision', async (t) => {
  const { tmp, store, r } = await setup()
  t.after(() => tmp.cleanup())
  addSql(store, r.id, 'x', 'DROP TABLE t;')
  const before = store.getRevision()
  store.buildReleaseSqlAudit(r.id)
  store.buildReleaseSqlAudit(r.id, { scope: 'subtree' })
  assert.equal(store.getRevision(), before)
})

test('sql audit：非法 scope 报 VALIDATION_FAILED，不静默降级', async (t) => {
  const { tmp, store, r } = await setup()
  t.after(() => tmp.cleanup())
  assert.throws(() => store.buildReleaseSqlAudit(r.id, { scope: 'Subtree' }), /VALIDATION_FAILED/)
  assert.throws(() => store.buildReleaseSqlAudit(r.id, { scope: 'sub' }), /VALIDATION_FAILED/)
})

test('sql audit：markdown 渲染，转义 SQL 里的 | 与换行', async (t) => {
  const { tmp, store, r } = await setup()
  t.after(() => tmp.cleanup())
  addSql(store, r.id, 'weird|name', 'DELETE FROM t WHERE a = 1 | 2;')
  const { renderReleaseSqlAuditMd } = await import('../server/ops.mjs')
  const md = renderReleaseSqlAuditMd(store.buildReleaseSqlAudit(r.id))
  assert.match(md, /# 上线 SQL 风险审查：R/)
  assert.match(md, /weird\\\|name/)
})

test('sql audit：能力清单登记 release_sql_audit', async (t) => {
  const { tmp } = await setup()
  t.after(() => tmp.cleanup())
  const { TOOLS } = await import('../server/ops.mjs')
  assert.ok(TOOLS.includes('release_sql_audit'))
})

// ---------- 三入口 1:1 ----------

test('HTTP release-sql-audit：JSON / md 与 store 一致；非法 scope/format 400', async (t) => {
  const { tmp, store, r } = await setup()
  t.after(() => tmp.cleanup())
  addSql(store, r.id, 'danger', 'DROP TABLE t;')

  const { createApp } = await import('../server/http.mjs')
  const app = createApp({ store })
  const server = await new Promise((resolve, reject) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s))
    s.once('error', reject)
  })
  const base = `http://127.0.0.1:${server.address().port}`
  t.after(async () => {
    await new Promise((res) => server.close(res))
  })

  const jsonOut = await fetch(`${base}/api/nodes/${r.id}/release-sql-audit`).then((x) => x.json())
  assert.deepEqual(jsonOut, store.buildReleaseSqlAudit(r.id))
  assert.equal(jsonOut.ready, false)

  const mdRes = await fetch(`${base}/api/nodes/${r.id}/release-sql-audit?format=md`)
  assert.match(mdRes.headers.get('content-type'), /text\/markdown/)
  assert.match(await mdRes.text(), /# 上线 SQL 风险审查：R/)

  for (const q of ['scope=Subtree', 'format=xml']) {
    const res = await fetch(`${base}/api/nodes/${r.id}/release-sql-audit?${q}`)
    assert.equal(res.status, 400, `${q} 应当 400`)
    assert.equal((await res.json()).error.code, 'VALIDATION_FAILED')
  }
})

test('MCP release_sql_audit：JSON / md 与 store 一致；非法 scope/format 返回 isError', async (t) => {
  const { store, call, close } = await mcpClient()
  t.after(async () => {
    await close()
  })
  const p = store.createNode({ type: 'project', name: 'P' })
  const r = store.createNode({ parentId: p.id, type: 'requirement', name: 'R' })
  addSql(store, r.id, 'danger', 'TRUNCATE TABLE t;')

  const out = await call('release_sql_audit', { node: String(r.id) })
  assert.equal(out.isError, undefined)
  assert.deepEqual(JSON.parse(out.content[0].text), store.buildReleaseSqlAudit(r.id))

  const { renderReleaseSqlAuditMd } = await import('../server/ops.mjs')
  const md = await call('release_sql_audit', { node: String(r.id), format: 'md' })
  assert.equal(md.content[0].text, renderReleaseSqlAuditMd(store.buildReleaseSqlAudit(r.id)))

  for (const args of [{ node: String(r.id), scope: 'sub' }, { node: String(r.id), format: 'xml' }]) {
    const bad = await call('release_sql_audit', args)
    assert.equal(bad.isError, true)
    assert.match(bad.content[0].text, /VALIDATION_FAILED/)
    assert.ok(!/MCP error -32602/.test(bad.content[0].text))
  }
})

test('CLI release sql-audit：JSON / md 与 store 一致', async (t) => {
  const { tmp, store, r } = await setup()
  const home = tmp.dir
  t.after(() => tmp.cleanup())
  addSql(store, r.id, 'danger', 'DELETE FROM t;')
  const expected = store.buildReleaseSqlAudit(r.id)

  const { stdout } = await execFileP('node', [CLI, 'release', 'sql-audit', 'P/R'], {
    env: { ...process.env, TASKBOARD_HOME: home },
    encoding: 'utf8'
  })
  assert.deepEqual(JSON.parse(stdout), expected)
  assert.equal(JSON.parse(stdout).ready, false)

  const md = await execFileP('node', [CLI, 'release', 'sql-audit', 'P/R', '--format', 'md'], {
    env: { ...process.env, TASKBOARD_HOME: home },
    encoding: 'utf8'
  })
  assert.match(md.stdout, /# 上线 SQL 风险审查：R/)
})

test('CLI release sql-audit --scope subtree 与 store 一致', async (t) => {
  const { tmp, store, r, s } = await setup()
  const home = tmp.dir
  t.after(() => tmp.cleanup())
  addSql(store, s.id, 'child', 'DROP TABLE t;')
  const expected = store.buildReleaseSqlAudit(r.id, { scope: 'subtree' })
  const { stdout } = await execFileP('node', [CLI, 'release', 'sql-audit', 'P/R', '--scope', 'subtree'], {
    env: { ...process.env, TASKBOARD_HOME: home },
    encoding: 'utf8'
  })
  assert.deepEqual(JSON.parse(stdout), expected)
  assert.equal(JSON.parse(stdout).scope, 'subtree')
})

test('HTTP / MCP / CLI 三入口与 store 逐字段一致（self）', async (t) => {
  const { tmp, store, r } = await setup()
  const home = tmp.dir
  t.after(() => tmp.cleanup())
  addSql(store, r.id, 'safe', 'UPDATE t SET x = 1 WHERE id = 1;')
  addSql(store, r.id, 'danger', 'TRUNCATE t;')
  const expected = store.buildReleaseSqlAudit(r.id)

  const { createApp } = await import('../server/http.mjs')
  const app = createApp({ store })
  const server = await new Promise((resolve, reject) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s))
    s.once('error', reject)
  })
  const base = `http://127.0.0.1:${server.address().port}`
  t.after(async () => {
    await new Promise((res) => server.close(res))
  })
  const httpOut = await fetch(`${base}/api/nodes/${r.id}/release-sql-audit`).then((x) => x.json())

  const { call, close } = await mcpClient(store)
  t.after(() => close())
  const mcpOut = JSON.parse((await call('release_sql_audit', { node: String(r.id) })).content[0].text)

  const { stdout } = await execFileP('node', [CLI, 'release', 'sql-audit', 'P/R'], {
    env: { ...process.env, TASKBOARD_HOME: home },
    encoding: 'utf8'
  })
  const cliOut = JSON.parse(stdout)

  assert.deepEqual(httpOut, expected)
  assert.deepEqual(mcpOut, expected)
  assert.deepEqual(cliOut, expected)
})
