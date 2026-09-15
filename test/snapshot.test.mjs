import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { DatabaseSync } from 'node:sqlite'
import {
  EXCLUDED_TABLES,
  assertExclusionsDocumented,
  importPlan,
  importOrder,
  listBusinessTables,
  listExistingTables
} from '../scripts/snapshot-tables.mjs'

const execFileP = promisify(execFile)
const root = path.resolve(import.meta.dirname, '..')

/** 造一个隔离的 TASKBOARD_HOME（脚本进程读环境变量，必须走子进程）。 */
function makeHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-snapshot-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

const run = (script, args, home) =>
  execFileP(process.execPath, [path.join(root, script), ...args], {
    env: { ...process.env, TASKBOARD_HOME: home },
    encoding: 'utf8'
  })

/** 用真实 schema 初始化一个空库 */
async function initHome(home) {
  await execFileP(
    process.execPath,
    ['--input-type=module', '-e', "import {openDb} from './server/db.mjs'; openDb()"],
    { env: { ...process.env, TASKBOARD_HOME: home }, cwd: root, encoding: 'utf8' }
  )
}

/** 在隔离 HOME 里执行一段建库脚本（cwd 必须在仓库根，才能 import ./server/*） */
const seed = (home, code) =>
  execFileP(process.execPath, ['--input-type=module', '-e', code], {
    env: { ...process.env, TASKBOARD_HOME: home },
    cwd: root,
    encoding: 'utf8'
  })

const q = (home, sql) => {
  const db = new DatabaseSync(path.join(home, 'data.db'))
  try {
    return db.prepare(sql).all()
  } finally {
    db.close()
  }
}

/**
 * 逐行关系断言用的稳定键映射：把「子 → 父」按业务键（名称/标题）而不是 id 表达，
 * 这样即使导入重建了 id，也能逐行比对关系有没有丢。
 */
const relationMap = (home, sql) => {
  const db = new DatabaseSync(path.join(home, 'data.db'))
  try {
    return db
      .prepare(sql)
      .all()
      .map((r) => `${r.child}=>${r.parent ?? 'NULL'}`)
      .sort()
  } finally {
    db.close()
  }
}

/** nodes 的「子名称 → 父名称」关系（按名称稳定，不依赖 id） */
const nodeRelations = (home) =>
  relationMap(
    home,
    `SELECT c.name AS child, p.name AS parent
       FROM nodes c LEFT JOIN nodes p ON p.id = c.parent_id
      ORDER BY c.name`
  )

/** agent_runs 的重试链关系：用 prompt 作为稳定键（parent_run_id 指向父 run） */
const runRelations = (home) =>
  relationMap(
    home,
    `SELECT c.prompt AS child, p.prompt AS parent
       FROM agent_runs c LEFT JOIN agent_runs p ON p.id = c.parent_run_id
      ORDER BY c.prompt`
  )

// ---------- 表清单登记（回归：新增表不再静默丢） ----------

test('snapshot-tables：被排除的表都必须写明理由', () => {
  assert.doesNotThrow(() => assertExclusionsDocumented())
  assert.ok(Object.values(EXCLUDED_TABLES).every((r) => String(r || '').trim().length > 0))
})

test('snapshot-tables：业务表 = 真实表 − 显式排除（新增表自动进快照）', async (t) => {
  const home = makeHome(t)
  await initHome(home)
  const db = new DatabaseSync(path.join(home, 'data.db'))
  try {
    const existing = listExistingTables(db)
    const business = listBusinessTables(db)
    assert.deepEqual(
      business,
      existing.filter((n) => !(n in EXCLUDED_TABLES)).sort(),
      '业务表集合应与真实表减去排除项一致'
    )
    // 关键：新增一张表后应自动纳入，无需改代码
    db.exec('CREATE TABLE brand_new_feature (id INTEGER PRIMARY KEY)')
    assert.ok(listBusinessTables(db).includes('brand_new_feature'), '新增表应自动进快照清单')
  } finally {
    db.close()
  }
})

test('snapshot-tables：导入顺序满足外键依赖（被引用表在前）', async (t) => {
  const home = makeHome(t)
  await initHome(home)
  const db = new DatabaseSync(path.join(home, 'data.db'))
  try {
    const plan = importPlan(db)
    const pos = new Map(plan.map((t, i) => [t.name, i]))
    for (const entry of plan) {
      for (const fk of entry.fks) {
        if (fk.table === entry.name) {
          assert.equal(entry.selfReferencing, true, `${entry.name} 自引用应被标记`)
          continue
        }
        if (!pos.has(fk.table)) continue
        assert.ok(pos.get(fk.table) < pos.get(entry.name), `${entry.name} 依赖的 ${fk.table} 应排在它前面`)
      }
    }
    // 顺序稳定（同名库两次推导一致）
    assert.deepEqual(importOrder(db), plan.map((t) => t.name))
  } finally {
    db.close()
  }
})

// ---------- 端到端往返（回归：旧实现丢 10+ 张表） ----------

test('快照往返：test_cases / release_items / comments 等此前丢失的表都保留', async (t) => {
  const src = makeHome(t)
  const dst = makeHome(t)
  await initHome(src)
  await initHome(dst)

  // 造覆盖「旧实现会丢」的表的数据：测试用例 / 上线项 / 行级评论 / agent 链路 / 分支配置
  await seed(
    src,
    `
    import { openDb } from './server/db.mjs'
    import { createStore } from './server/store.mjs'
    const db = openDb(); const s = createStore(db)
    const p = s.createNode({ type: 'project', name: 'P' })
    const r = s.createNode({ parentId: p.id, type: 'requirement', name: 'R' })
    const task = s.createNode({ parentId: r.id, type: 'subreq', name: 'S' })
    const c = s.createTestCase(task.id, { name: '登录回归', prompt: '跑单测' })
    s.upsertReleaseItem(task.id, { name: '执行上线SQL', kind: 'sql', content: 'ALTER TABLE t ADD c int', rollback: 'DROP' })
    s.createComment(task.id, { filePath: 'a/b.java', content: '这里有问题', lineStart: 10, lineEnd: 12 })
    s.createTestReport(task.id, { caseId: c.id, status: 'running' })
    const run = s.createAgentRun(task.id, { prompt: '跑', agent: 'echo' })
    s.appendAgentRunMessage(run.id, { type: 'text', content: 'hello' })
    s.upsertBranchConfig('TAG1', { testBranch: 't1', preBranch: 'p1' })
    `
  )

  const snapPath = path.join(src, 'snap.json')
  await run('scripts/export-snapshot.mjs', [snapPath], src)
  await run('scripts/import-snapshot.mjs', [snapPath], dst)

  for (const table of [
    'test_cases',
    'release_items',
    'comments',
    'test_reports',
    'agent_runs',
    'agent_run_messages',
    'branch_configs'
  ]) {
    const n = q(dst, `SELECT COUNT(*) c FROM ${table}`)[0].c
    assert.ok(n >= 1, `${table} 在导入后为空——快照把它丢了`)
  }
})

test('快照往返：父子关系与外键在重映射后仍然完整', async (t) => {
  const src = makeHome(t)
  const dst = makeHome(t)
  await initHome(src)
  await initHome(dst)

  await seed(
    src,
    `
    import { openDb } from './server/db.mjs'
    import { createStore } from './server/store.mjs'
    const db = openDb(); const s = createStore(db)
    const p = s.createNode({ type: 'project', name: 'P' })
    const r = s.createNode({ parentId: p.id, type: 'requirement', name: 'R' })
    const t = s.createNode({ parentId: r.id, type: 'subreq', name: 'S' })
    const c = s.createTestCase(t.id, { name: 'C', prompt: 'p' })
    const run = s.createAgentRun(t.id, { prompt: 'x', agent: 'echo' })
    s.createTestReport(t.id, { caseId: c.id, runId: run.id, status: 'running' })
    s.appendAgentRunMessage(run.id, { type: 'text', content: 'm' })
    `
  )

  const snapPath = path.join(src, 'snap.json')
  await run('scripts/export-snapshot.mjs', [snapPath], src)
  await run('scripts/import-snapshot.mjs', [snapPath], dst)

  // 逐行关系断言（不能只看行数 / 孤儿数：parent_id 被写成 NULL 时两者都发现不了）
  assert.deepEqual(nodeRelations(dst), nodeRelations(src), 'nodes.parent_id 关系在导入后发生变化')
  assert.equal(
    q(dst, 'SELECT COUNT(*) c FROM nodes WHERE parent_id IS NOT NULL AND parent_id NOT IN (SELECT id FROM nodes)')[0].c,
    0,
    '导入后出现孤儿节点'
  )
  assert.equal(q(dst, 'SELECT COUNT(*) c FROM nodes')[0].c, 3)
  // test_reports 同时引用 case 与 run：两者都不能丢，否则外键被置空
  const rep = q(dst, 'SELECT case_id, run_id FROM test_reports')[0]
  assert.ok(rep.case_id != null, 'test_reports.case_id 在重映射后丢失')
  assert.ok(rep.run_id != null, 'test_reports.run_id 在重映射后丢失')
  assert.equal(q(dst, 'SELECT COUNT(*) c FROM agent_run_messages m JOIN agent_runs r ON r.id = m.run_id')[0].c, 1)
})

// ---------- 自引用表：这两条是高级测试复验退回的缺陷回归 ----------

test('自引用回归：子节点 id 小于父节点 id 时 parent_id 不得被置空（原缺陷：7 条关系丢失）', async (t) => {
  const src = makeHome(t)
  const dst = makeHome(t)
  await initHome(src)
  await initHome(dst)

  // 先建子节点、后建父节点 → 子 id 必然小于父 id。
  // 旧实现按 id 升序插入，插子节点时映射表里还没有父 id，parent_id 会被静默写成 NULL。
  await seed(
    src,
    `
    import { openDb } from './server/db.mjs'
    import { createStore } from './server/store.mjs'
    const db = openDb(); const s = createStore(db)
    const project = s.createNode({ type: 'project', name: 'P' })
    const req = s.createNode({ parentId: project.id, type: 'requirement', name: 'R' })
    // 子节点先创建：id 更小（subreq 可直接挂 requirement）
    const childA = s.createNode({ parentId: req.id, type: 'subreq', name: 'childA' })
    const childB = s.createNode({ parentId: req.id, type: 'subreq', name: 'childB' })
    // 父节点后创建：id 更大（group 也可挂 requirement）；把两个早创建的子节点挂到它上面
    const lateParent = s.createNode({ parentId: req.id, type: 'group', name: 'lateParent' })
    s.updateNode(childA.id, { parentId: lateParent.id })
    s.updateNode(childB.id, { parentId: lateParent.id })
    `
  )

  // 前置断言：源库里确实是「子 id < 父 id」，否则用例没测到目标场景
  const srcRows = q(
    src,
    "SELECT c.id cid, p.id pid FROM nodes c JOIN nodes p ON p.id = c.parent_id WHERE c.name LIKE 'child%'"
  )
  assert.equal(srcRows.length, 2)
  for (const r of srcRows) assert.ok(r.cid < r.pid, `前置条件不成立：child ${r.cid} 应小于 parent ${r.pid}`)

  const snapPath = path.join(src, 'snap.json')
  await run('scripts/export-snapshot.mjs', [snapPath], src)
  await run('scripts/import-snapshot.mjs', [snapPath], dst)

  // 逐行关系断言：这是本缺陷的核心，旧实现会在这里挂掉
  assert.deepEqual(
    nodeRelations(dst),
    nodeRelations(src),
    '子 id 小于父 id 时 parent_id 被置空（关系丢失）'
  )
  assert.equal(
    q(dst, "SELECT COUNT(*) c FROM nodes WHERE name LIKE 'child%' AND parent_id IS NULL")[0].c,
    0,
    '子节点的 parent_id 被静默写成 NULL'
  )
})

test('自引用回归：agent_runs.parent_run_id 在「父 run 后创建 / 子 id 更小」时不得被置空', async (t) => {
  const src = makeHome(t)
  const dst = makeHome(t)
  await initHome(src)
  await initHome(dst)

  // 直接构造重试链：先插子 run（id 小、parent_run_id 指向还不存在的 id），再插父 run。
  // 这样即使按 id 升序插入，子 run 也被先插入，旧实现会把 parent_run_id 写成 NULL。
  await seed(
    src,
    `
    import { openDb } from './server/db.mjs'
    import { createStore } from './server/store.mjs'
    const db = openDb(); const s = createStore(db)
    const p = s.createNode({ type: 'project', name: 'P' })
    const now = new Date().toISOString()
    // 造「父 run 后创建」的合法数据形态：现实里这种链来自 id 复用 / 跨库合并，
    // 插入顺序上父 run 还不存在，所以这里临时关掉外键校验来构造源库状态。
    db.exec('PRAGMA foreign_keys = OFF')
    // 子 run：id=100，parent_run_id 先指向未来才会创建的父 run id=101
    db.prepare(
      'INSERT INTO agent_runs (id,node_id,agent,model,prompt,status,attempt,parent_run_id,started_at) VALUES (?,?,?,?,?,?,?,?,?)'
    ).run(100, p.id, 'echo', 'm', 'retry-child', 'running', 2, 101, now)
    // 父 run：id=101（后创建，id 更大）
    db.prepare(
      'INSERT INTO agent_runs (id,node_id,agent,model,prompt,status,attempt,started_at) VALUES (?,?,?,?,?,?,?,?)'
    ).run(101, p.id, 'echo', 'm', 'retry-parent', 'success', 1, now)
    db.exec('PRAGMA foreign_keys = ON')
    `
  )

  const srcRows = q(src, 'SELECT c.id cid, p.id pid FROM agent_runs c JOIN agent_runs p ON p.id = c.parent_run_id')
  assert.equal(srcRows.length, 1)
  assert.ok(srcRows[0].cid < srcRows[0].pid, '前置条件：子 run 的 id 应小于父 run')

  const snapPath = path.join(src, 'snap.json')
  await run('scripts/export-snapshot.mjs', [snapPath], src)
  await run('scripts/import-snapshot.mjs', [snapPath], dst)

  assert.deepEqual(
    runRelations(dst),
    runRelations(src),
    'agent_runs.parent_run_id 重试链在导入后发生变化'
  )
  assert.equal(
    q(dst, "SELECT COUNT(*) c FROM agent_runs WHERE prompt = 'retry-child' AND parent_run_id IS NULL")[0].c,
    0,
    '子 run 的 parent_run_id 被静默写成 NULL'
  )
})

test('快照往返：revision 与文档正文按原值恢复', async (t) => {
  const src = makeHome(t)
  const dst = makeHome(t)
  await initHome(src)
  await initHome(dst)

  const body = '正文内容 ' + 'x'.repeat(500)
  await seed(
    src,
    `
    import { openDb } from './server/db.mjs'
    import { createStore } from './server/store.mjs'
    const db = openDb(); const s = createStore(db)
    const p = s.createNode({ type: 'project', name: 'P' })
    const r = s.createNode({ parentId: p.id, type: 'requirement', name: 'R' })
    s.upsertDocument(r.id, '需求内容', ${JSON.stringify(body)})
    `
  )
  const srcRevision = q(src, "SELECT value v FROM meta WHERE key='revision'")[0].v

  const snapPath = path.join(src, 'snap.json')
  await run('scripts/export-snapshot.mjs', [snapPath], src)
  const snap = JSON.parse(fs.readFileSync(snapPath, 'utf8'))
  assert.equal(snap.version, 2, '快照版本应升到 v2（覆盖全部业务表）')

  await run('scripts/import-snapshot.mjs', [snapPath], dst)
  assert.equal(q(dst, "SELECT value v FROM meta WHERE key='revision'")[0].v, srcRevision)
  assert.equal(q(dst, "SELECT content c FROM documents WHERE name='需求内容'")[0].c, body)
})

// ---------- 防护：新增表自动纳入 / v1 快照必须告警 ----------

test('导出：库里新增的表自动进快照（无需改代码，也不再静默丢表）', async (t) => {
  const home = makeHome(t)
  await initHome(home)
  const db = new DatabaseSync(path.join(home, 'data.db'))
  db.exec('CREATE TABLE brand_new_feature (id INTEGER PRIMARY KEY, note TEXT)')
  db.prepare('INSERT INTO brand_new_feature (note) VALUES (?)').run('hello')
  db.close()

  const snapPath = path.join(home, 's.json')
  await run('scripts/export-snapshot.mjs', [snapPath], home)
  const snap = JSON.parse(fs.readFileSync(snapPath, 'utf8'))
  // 这是本缺陷的根治点：新表不需要人工登记，导出侧也不会漏。
  assert.ok(snap.tables.brand_new_feature, '新增表未进快照')
  assert.equal(snap.tables.brand_new_feature.length, 1)
  assert.ok(snap.plan.some((p) => p.name === 'brand_new_feature'))
})

test('导入：v1 快照缺表时给出显式告警（不静默清库）', async (t) => {
  const home = makeHome(t)
  await initHome(home)
  const v1 = path.join(home, 'v1.json')
  fs.writeFileSync(
    v1,
    JSON.stringify({
      format: 'taskboard-snapshot',
      version: 1,
      exportedAt: 'x',
      revision: 1,
      tables: {
        attr_defs: [],
        repos: [],
        nodes: [],
        attr_values: [],
        documents: [],
        commits: [],
        mrs: [],
        merges: [],
        unit_repos: []
      }
    })
  )
  const out = await run('scripts/import-snapshot.mjs', [v1], home)
  assert.match(out.stderr, /未包含以下表/)
  assert.match(out.stderr, /test_cases/)
  assert.match(out.stderr, /release_items/)
})

test('导入：非 taskboard-snapshot 格式被拒绝', async (t) => {
  const home = makeHome(t)
  await initHome(home)
  const bad = path.join(home, 'bad.json')
  fs.writeFileSync(bad, JSON.stringify({ format: 'something-else', tables: {} }))
  await assert.rejects(() => run('scripts/import-snapshot.mjs', [bad], home), (err) => /格式不匹配/.test(err.stderr))
})
