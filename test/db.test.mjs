import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { tempHome } from './helpers.mjs'

test('openDb 建出全部表并开启 WAL / 外键', async () => {
  const tmp = await tempHome()
  const db = tmp.openDb()
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()
    .map((r) => r.name)
  for (const t of ['nodes', 'attr_defs', 'attr_values', 'commits', 'mrs', 'documents', 'document_versions', 'repos', 'merges', 'unit_repos', 'test_cases', 'test_reports', 'acceptance_signoffs', 'release_items', 'delivery_snapshots', 'meta']) {
    assert.ok(tables.includes(t), `缺表 ${t}`)
  }
  assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal')
  assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1)
  db.close()
  tmp.cleanup()
})

test('预置 attr_defs 与 meta.revision 幂等', async () => {
  const tmp = await tempHome()
  const db1 = tmp.openDb()
  const defs = db1.prepare('SELECT node_type, key FROM attr_defs').all()
  assert.ok(defs.some((d) => d.node_type === 'requirement' && d.key === 'test_submit_date'))
  assert.ok(defs.some((d) => d.node_type === 'task' && d.key === 'base_branch'))
  assert.equal(db1.prepare("SELECT value FROM meta WHERE key='revision'").get().value, '0')
  db1.close()

  const db2 = tmp.openDb() // 再次打开不应重复预置
  assert.equal(db2.prepare('SELECT COUNT(*) c FROM attr_defs').get().c, defs.length)
  db2.close()
  tmp.cleanup()
})

// 旧版 schema：agent_runs 没有 session_id/runtime_id 等列（取自迁移前的 server/db.mjs）
const LEGACY_SCHEMA = `
CREATE TABLE IF NOT EXISTS nodes (
  id INTEGER PRIMARY KEY,
  type TEXT NOT NULL,
  parent_id INTEGER REFERENCES nodes(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'todo',
  sort INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  created_by TEXT NOT NULL DEFAULT 'user',
  updated_by TEXT NOT NULL DEFAULT 'user'
);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS agent_runs (
  id INTEGER PRIMARY KEY,
  node_id INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  agent TEXT NOT NULL DEFAULT 'qodercli',
  model TEXT NOT NULL DEFAULT 'DeepSeek-Flash',
  prompt TEXT NOT NULL,
  cwd TEXT,
  status TEXT NOT NULL DEFAULT 'running',
  output TEXT,
  exit_code INTEGER,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  created_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_agent_runs_node ON agent_runs(node_id);
`

test('旧库迁移：旧 schema 直接打开，补出新列与索引且保留历史数据', async () => {
  const tmp = await tempHome()
  const file = path.join(tmp.dir, 'legacy.db')
  const now = new Date().toISOString()

  // 造一个「旧版」数据库：老 agent_runs 结构 + 一条历史任务
  const legacy = new DatabaseSync(file)
  legacy.exec(LEGACY_SCHEMA)
  legacy
    .prepare('INSERT INTO nodes (id,type,parent_id,name,status,sort,created_at,updated_at) VALUES (1,?,NULL,?,?,0,?,?)')
    .run('project', '历史项目', 'todo', now, now)
  legacy
    .prepare('INSERT INTO agent_runs (id,node_id,agent,model,prompt,cwd,status,output,exit_code,started_at,created_by) VALUES (7,1,?,?,?,?,?,?,?,?,?)')
    .run('qodercli', 'DeepSeek-Flash', '历史任务', '/tmp', 'success', '历史输出', 0, now, 'user')
  legacy.close()

  // 用当前 openDb 打开同一个库：修复前会在 db.exec(SCHEMA) 抛 no such column: session_id
  const db = tmp.openDb(file)
  const cols = db.prepare('PRAGMA table_info(agent_runs)').all().map((c) => c.name)
  for (const c of ['session_id', 'runtime_id', 'attempt', 'max_attempts', 'parent_run_id', 'failure_reason', 'cli_session_id', 'work_dir', 'priority', 'resumed', 'wait_reason']) {
    assert.ok(cols.includes(c), `agent_runs 缺迁移列 ${c}`)
  }
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_agent_runs_session'").get().name, 'idx_agent_runs_session')
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='agent_run_messages'").get().name, 'agent_run_messages')
  // v3 / v4 迁移：老库也要补出回归测试与上线清单两张新表
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='test_cases'").get().name, 'test_cases')
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='test_reports'").get().name, 'test_reports')
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='acceptance_signoffs'").get().name, 'acceptance_signoffs')
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='release_items'").get().name, 'release_items')
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='delivery_snapshots'").get().name, 'delivery_snapshots')
  assert.equal(
    db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_release_items_node'").get().name,
    'idx_release_items_node'
  )
  // v5 迁移：老库的 test_reports 缺 auto_finalized 列（派单自动收尾标记）
  const reportCols = db.prepare('PRAGMA table_info(test_reports)').all().map((c) => c.name)
  assert.ok(reportCols.includes('auto_finalized'), 'test_reports 缺迁移列 auto_finalized')

  // 历史数据保留，并且新旧列可一起读取
  const row = db.prepare('SELECT * FROM agent_runs WHERE id = 7').get()
  assert.equal(row.prompt, '历史任务')
  assert.equal(row.output, '历史输出')
  assert.equal(row.status, 'success')
  assert.equal(row.attempt, 1)
  // max_attempts 从旧默认 1 回填为新的硬上限默认 3（否则历史行会被硬上限锁死不能重试）
  assert.equal(row.max_attempts, 3)
  assert.equal(row.session_id, null)
  assert.equal(db.prepare('SELECT name FROM nodes WHERE id = 1').get().name, '历史项目')
  assert.equal(db.prepare("SELECT value FROM meta WHERE key='agent_max_attempts_v2'").get().value, '1')

  // 再次打开幂等
  db.close()
  const db2 = tmp.openDb(file)
  assert.equal(db2.prepare('SELECT prompt FROM agent_runs WHERE id = 7').get().prompt, '历史任务')
  // 二次打开不再回填：显式传 1 的新行不会被误升级
  db2.prepare('UPDATE agent_runs SET max_attempts = 1 WHERE id = 7').run()
  db2.close()
  const db3 = tmp.openDb(file)
  assert.equal(db3.prepare('SELECT max_attempts FROM agent_runs WHERE id = 7').get().max_attempts, 1)
  db3.close()
  tmp.cleanup()
})

test('v5 迁移：已存在 test_reports（无 auto_finalized）的老库补列且保留历史报告', async () => {
  const tmp = await tempHome()
  const file = path.join(tmp.dir, 'v4.db')
  const now = new Date().toISOString()

  // 造一个 v4 形态的库：test_reports 存在但没有 auto_finalized 列
  const legacy = new DatabaseSync(file)
  legacy.exec(`
    CREATE TABLE nodes (
      id INTEGER PRIMARY KEY, type TEXT NOT NULL, parent_id INTEGER, name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'todo', sort INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      created_by TEXT NOT NULL DEFAULT 'user', updated_by TEXT NOT NULL DEFAULT 'user'
    );
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE test_reports (
      id INTEGER PRIMARY KEY,
      node_id INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      case_id INTEGER,
      run_id INTEGER,
      kind TEXT NOT NULL DEFAULT 'regression',
      status TEXT NOT NULL DEFAULT 'running',
      summary TEXT, detail TEXT,
      started_at TEXT NOT NULL, finished_at TEXT, updated_at TEXT NOT NULL,
      created_by TEXT NOT NULL DEFAULT 'user'
    );
  `)
  legacy
    .prepare('INSERT INTO nodes (id,type,parent_id,name,status,sort,created_at,updated_at) VALUES (1,?,NULL,?,?,0,?,?)')
    .run('project', '历史项目', 'todo', now, now)
  legacy
    .prepare('INSERT INTO test_reports (id,node_id,kind,status,summary,started_at,updated_at) VALUES (5,1,?,?,?,?,?)')
    .run('regression', 'pass', '历史报告', now, now)
  legacy.close()

  const db = tmp.openDb(file)
  const cols = db.prepare('PRAGMA table_info(test_reports)').all().map((c) => c.name)
  assert.ok(cols.includes('auto_finalized'))
  const row = db.prepare('SELECT * FROM test_reports WHERE id = 5').get()
  assert.equal(row.summary, '历史报告')
  assert.equal(row.status, 'pass')
  // 历史行回填为「非自动收尾」，避免误判成机器兜底结论
  assert.equal(row.auto_finalized, 0)
  db.close()
  tmp.cleanup()
})
