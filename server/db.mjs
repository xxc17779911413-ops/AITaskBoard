import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { DB_PATH } from './config.mjs'

/**
 * 允许的子节点类型：父节点 type → 可以挂的子节点 type 列表（单一事实来源）
 * 空数组 = 叶子节点（defect 不能再挂子节点；task 只允许挂 defect）
 */
export const CHILD_TYPES = {
  project: ['requirement'],
  requirement: ['group', 'subreq'],
  subreq: ['group', 'task'],
  group: ['group', 'subreq', 'task', 'defect'],
  task: ['defect'],
  defect: []
}
/** 叶子节点（不允许再挂子节点） */
export const LEAF_TYPES = new Set(Object.keys(CHILD_TYPES).filter((t) => CHILD_TYPES[t].length === 0))

const SCHEMA = `
CREATE TABLE IF NOT EXISTS nodes (
  id INTEGER PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('project','requirement','subreq','group','task','defect')),
  parent_id INTEGER REFERENCES nodes(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'todo',
  sort INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  created_by TEXT NOT NULL DEFAULT 'user',
  updated_by TEXT NOT NULL DEFAULT 'user'
);
CREATE INDEX IF NOT EXISTS idx_nodes_parent ON nodes(parent_id, sort);

CREATE TABLE IF NOT EXISTS attr_defs (
  id INTEGER PRIMARY KEY,
  node_type TEXT NOT NULL,
  key TEXT NOT NULL,
  label TEXT NOT NULL,
  data_type TEXT NOT NULL CHECK (data_type IN ('text','textarea','number','date','select','url')),
  options TEXT,
  required INTEGER NOT NULL DEFAULT 0,
  default_value TEXT,
  sort INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(node_type, key)
);

CREATE TABLE IF NOT EXISTS attr_values (
  id INTEGER PRIMARY KEY,
  node_id INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  attr_def_id INTEGER NOT NULL REFERENCES attr_defs(id) ON DELETE CASCADE,
  value TEXT,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL DEFAULT 'user',
  UNIQUE(node_id, attr_def_id)
);

CREATE TABLE IF NOT EXISTS commits (
  id INTEGER PRIMARY KEY,
  node_id INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  repo TEXT,
  sha TEXT NOT NULL,
  branch TEXT,
  note TEXT,
  review_status TEXT NOT NULL DEFAULT 'pending',
  review_note TEXT,
  reviewed_by TEXT,
  reviewed_at TEXT,
  patch_id TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(node_id, sha)
);

CREATE TABLE IF NOT EXISTS mrs (
  id INTEGER PRIMARY KEY,
  node_id INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  project TEXT NOT NULL,
  iid INTEGER NOT NULL,
  title TEXT,
  state TEXT,
  source_branch TEXT,
  web_url TEXT,
  updated_at TEXT,
  fetched_at TEXT NOT NULL,
  UNIQUE(node_id, project, iid)
);

CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY,
  node_id INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  sort INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  created_by TEXT NOT NULL DEFAULT 'user',
  updated_by TEXT NOT NULL DEFAULT 'user',
  UNIQUE(node_id, name)
);
CREATE INDEX IF NOT EXISTS idx_documents_node ON documents(node_id, sort);

-- 文档历史：每次创建 / 改名 / 改正文后保存一份不可变快照。
-- 恢复历史版本会生成一个新快照，不覆盖或删除任何既有版本。
CREATE TABLE IF NOT EXISTS document_versions (
  id INTEGER PRIMARY KEY,
  document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL DEFAULT 'update',
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL DEFAULT 'user'
);
CREATE INDEX IF NOT EXISTS idx_document_versions_doc ON document_versions(document_id, id);

CREATE TABLE IF NOT EXISTS repos (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  local_path TEXT,
  gitlab_project TEXT,
  note TEXT,
  tags TEXT,
  test_branch TEXT,
  pre_branch TEXT,
  release_branch TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS branch_configs (
  id INTEGER PRIMARY KEY,
  tag TEXT NOT NULL UNIQUE,
  test_branch TEXT,
  pre_branch TEXT,
  release_branch TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- agent 运行时（一台机器上的一个 agent CLI 实例；参考 multica agent_runtime）
-- 本机场景下 daemon_id = 主机名，provider = 具体 CLI（qodercli / echo / …）
CREATE TABLE IF NOT EXISTS agent_runtimes (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  daemon_id TEXT,
  runtime_mode TEXT NOT NULL DEFAULT 'local' CHECK (runtime_mode IN ('local','cloud')),
  provider TEXT NOT NULL DEFAULT 'qodercli',
  status TEXT NOT NULL DEFAULT 'offline' CHECK (status IN ('online','offline')),
  device_info TEXT NOT NULL DEFAULT '',
  visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','public')),
  metadata TEXT NOT NULL DEFAULT '{}',
  last_seen_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  created_by TEXT NOT NULL DEFAULT 'user',
  UNIQUE(daemon_id, provider)
);

CREATE INDEX IF NOT EXISTS idx_agent_runtimes_status ON agent_runtimes(status);

-- agent 会话（一个节点 + 一个 agent 上可续跑的连续对话；参考 multica chat_session）
-- cli_session_id 对应 multica 的 session_id，用于 --resume 续跑同一个 CLI 会话
CREATE TABLE IF NOT EXISTS agent_sessions (
  id INTEGER PRIMARY KEY,
  node_id INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  agent TEXT NOT NULL DEFAULT 'qodercli',
  runtime_id INTEGER REFERENCES agent_runtimes(id) ON DELETE SET NULL,
  title TEXT NOT NULL DEFAULT '',
  cli_session_id TEXT,
  work_dir TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  run_count INTEGER NOT NULL DEFAULT 0,
  last_activity_at TEXT,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL DEFAULT 'user'
);

CREATE INDEX IF NOT EXISTS idx_agent_sessions_node ON agent_sessions(node_id);
CREATE INDEX IF NOT EXISTS idx_agent_sessions_activity ON agent_sessions(status, last_activity_at);

-- agent 任务（队列 + 生命周期；参考 multica agent_task_queue）
-- 每次触发 = 一行；重试/续跑通过 parent_run_id + attempt 串起来
CREATE TABLE IF NOT EXISTS agent_runs (
  id INTEGER PRIMARY KEY,
  node_id INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  session_id INTEGER REFERENCES agent_sessions(id) ON DELETE SET NULL,
  runtime_id INTEGER REFERENCES agent_runtimes(id) ON DELETE SET NULL,
  agent TEXT NOT NULL DEFAULT 'qodercli',
  model TEXT NOT NULL DEFAULT 'DeepSeek-Flash',
  prompt TEXT NOT NULL,
  cwd TEXT,
  status TEXT NOT NULL DEFAULT 'running',
  output TEXT,
  exit_code INTEGER,
  attempt INTEGER NOT NULL DEFAULT 1,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  parent_run_id INTEGER REFERENCES agent_runs(id) ON DELETE SET NULL,
  failure_reason TEXT,
  cli_session_id TEXT,
  work_dir TEXT,
  priority INTEGER NOT NULL DEFAULT 0,
  resumed INTEGER NOT NULL DEFAULT 0,
  wait_reason TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  created_by TEXT
);

CREATE INDEX IF NOT EXISTS idx_agent_runs_node ON agent_runs(node_id);
-- idx_agent_runs_session 依赖 session_id，老库在 migrate() 补列后才能建，见 migrate()

-- 任务消息流（参考 multica task_message）：把 agent 输出从单块文本升级成带 seq 的事件流
CREATE TABLE IF NOT EXISTS agent_run_messages (
  id INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  type TEXT NOT NULL,
  tool TEXT,
  content TEXT,
  input TEXT,
  output TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(run_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_agent_run_messages_run ON agent_run_messages(run_id, seq);

CREATE TABLE IF NOT EXISTS ide_requests (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'open-diff',
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  handled_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_ide_requests_status ON ide_requests(status);

CREATE TABLE IF NOT EXISTS merges (
  id INTEGER PRIMARY KEY,
  node_id INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  repo TEXT NOT NULL,
  source_branch TEXT NOT NULL,
  target_branch TEXT NOT NULL,
  base_sha TEXT, source_sha TEXT, target_sha TEXT,
  state TEXT NOT NULL,
  merge_sha TEXT,
  conflict_files TEXT,
  resolved_files TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  created_by TEXT NOT NULL DEFAULT 'user',
  updated_by TEXT NOT NULL DEFAULT 'user'
);

CREATE TABLE IF NOT EXISTS unit_repos (
  id INTEGER PRIMARY KEY,
  node_id INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  repo_id INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  branch TEXT,
  worktree_path TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(node_id, repo_id)
);

CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY,
  node_id INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  repo TEXT,
  file_path TEXT NOT NULL,
  commit_sha TEXT,
  line_start INTEGER NOT NULL DEFAULT 0,
  line_end INTEGER NOT NULL DEFAULT 0,
  snippet TEXT,
  content TEXT NOT NULL,
  author TEXT NOT NULL DEFAULT 'user',
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_comments_node ON comments(node_id, file_path);

-- 回归测试用例（AI 可回归测试）：挂在节点上的、可被 AI 重复执行的测试/验收指令。
-- kind 是「上线配置 / 上线 SQL / 代码检查 / 业务检查」等后续检查的统一扩展轴：
-- v1 只实现 regression / acceptance，其余 kind 值先占位，新增一种检查无需改表。
CREATE TABLE IF NOT EXISTS test_cases (
  id INTEGER PRIMARY KEY,
  node_id INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'regression'
    CHECK (kind IN ('regression','acceptance','code_check','biz_check','release_check')),
  prompt TEXT NOT NULL,
  expectation TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  created_by TEXT NOT NULL DEFAULT 'user',
  updated_by TEXT NOT NULL DEFAULT 'user',
  UNIQUE(node_id, name)
);
CREATE INDEX IF NOT EXISTS idx_test_cases_node ON test_cases(node_id, sort, id);

-- 测试 / 验收报告：一次执行 = 一行（可关联 agent 任务与用例），汇总即成验收报告。
CREATE TABLE IF NOT EXISTS test_reports (
  id INTEGER PRIMARY KEY,
  node_id INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  case_id INTEGER REFERENCES test_cases(id) ON DELETE SET NULL,
  run_id INTEGER REFERENCES agent_runs(id) ON DELETE SET NULL,
  kind TEXT NOT NULL DEFAULT 'regression',
  status TEXT NOT NULL DEFAULT 'running'
    CHECK (status IN ('running','pass','fail','blocked','error','cancelled')),
  summary TEXT,
  detail TEXT,
  auto_finalized INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  updated_at TEXT NOT NULL,
  created_by TEXT NOT NULL DEFAULT 'user'
);
CREATE INDEX IF NOT EXISTS idx_test_reports_node ON test_reports(node_id, id);
CREATE INDEX IF NOT EXISTS idx_test_reports_case ON test_reports(case_id, id);

-- 验收签收：把「测试报告已通过」与「业务/需求方确认验收」分开落库。
-- evidence_fingerprint 绑定签收时的验收证据；后续用例或报告变化会让签收自动失效。
CREATE TABLE IF NOT EXISTS acceptance_signoffs (
  id INTEGER PRIMARY KEY,
  node_id INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  scope TEXT NOT NULL DEFAULT 'self' CHECK (scope IN ('self','subtree')),
  decision TEXT NOT NULL CHECK (decision IN ('accepted','rejected')),
  comment TEXT,
  evidence_fingerprint TEXT NOT NULL,
  signed_by TEXT NOT NULL,
  signed_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(node_id, scope)
);
CREATE INDEX IF NOT EXISTS idx_acceptance_signoffs_node ON acceptance_signoffs(node_id, scope);

-- 上线清单：挂在节点上的上线配置 / 上线 SQL / 上线检查项（结构化登记）。
-- 「代码检查 / 业务检查 / 上线检查」的执行语义复用 test_cases 的 kind 扩展轴，本表只补结构化的上线项。
CREATE TABLE IF NOT EXISTS release_items (
  id INTEGER PRIMARY KEY,
  node_id INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'config'
    CHECK (kind IN ('config','sql','check')),
  content TEXT NOT NULL DEFAULT '',
  rollback TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','ready','done','blocked','skipped')),
  required INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  created_by TEXT NOT NULL DEFAULT 'user',
  updated_by TEXT NOT NULL DEFAULT 'user',
  UNIQUE(node_id, name)
);
CREATE INDEX IF NOT EXISTS idx_release_items_node ON release_items(node_id, sort, id);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`

/** 预置属性定义（设计文档 §4.9） */
const SEED_ATTR_DEFS = [
  ['requirement', 'start_date', '开始时间', 'date', 0],
  ['requirement', 'end_date', '结束时间', 'date', 0],
  ['requirement', 'review_date', '需求评审时间', 'date', 0],
  ['requirement', 'design_review_date', '概设评审时间', 'date', 0],
  ['requirement', 'test_submit_date', '提测时间', 'date', 0],
  ['requirement', 'estimate_hours', '预估工时', 'number', 0],
  ['subreq', 'branch', '分支', 'text', 0],
  ['subreq', 'baseline', '基线', 'text', 0],
  ['subreq', 'gitlab_project', 'GitLab 项目', 'text', 0],
  ['group', 'slug', '英文短名', 'text', 0],
  ['group', 'branch', '分支', 'text', 0],
  ['group', 'base_branch', '基线分支', 'text', 0],
  ['task', 'slug', '英文短名', 'text', 0],
  ['task', 'branch', '分支', 'text', 0],
  ['task', 'base_branch', '基线分支', 'text', 0]
]

function seed(db) {
  const now = new Date().toISOString()
  const has = db.prepare('SELECT COUNT(*) c FROM attr_defs').get().c
  if (has === 0) {
    const ins = db.prepare(
      'INSERT INTO attr_defs (node_type,key,label,data_type,options,required,default_value,sort,enabled,created_at,updated_at) VALUES (?,?,?,?,NULL,?,NULL,?,1,?,?)'
    )
    SEED_ATTR_DEFS.forEach((row, i) => {
      const [nodeType, key, label, dataType, required] = row
      ins.run(nodeType, key, label, dataType, required, (i + 1) * 10, now, now)
    })
  }
  db.prepare("INSERT OR IGNORE INTO meta (key,value) VALUES ('revision','0')").run()
}

export function openDb(file = DB_PATH) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  db.exec('PRAGMA journal_mode = WAL;')
  db.exec('PRAGMA foreign_keys = ON;')
  db.exec('PRAGMA busy_timeout = 5000;')
  db.exec(SCHEMA)
  migrate(db)
  seed(db)
  return db
}

/** 轻量迁移：对已存在的库幂等补列/补表（SCHEMA 里只对新建库生效） */
function migrate(db) {
  addColumns(db, 'repos', [
    ['tags', 'TEXT'],
    ['test_branch', 'TEXT'],
    ['pre_branch', 'TEXT'],
    ['release_branch', 'TEXT']
  ])
  addColumns(db, 'commits', [
    ['review_status', "TEXT NOT NULL DEFAULT 'pending'"],
    ['review_note', 'TEXT'],
    ['reviewed_by', 'TEXT'],
    ['reviewed_at', 'TEXT'],
    ['patch_id', 'TEXT'],
    ['branch', 'TEXT']
  ])
  addColumns(db, 'merges', [
    ['resolved_files', 'TEXT']
  ])
  // agent 运行时管理（v2）：老库补列补表，SCHEMA 只对新库生效
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_runtimes (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      daemon_id TEXT,
      runtime_mode TEXT NOT NULL DEFAULT 'local' CHECK (runtime_mode IN ('local','cloud')),
      provider TEXT NOT NULL DEFAULT 'qodercli',
      status TEXT NOT NULL DEFAULT 'offline' CHECK (status IN ('online','offline')),
      device_info TEXT NOT NULL DEFAULT '',
      visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','public')),
      metadata TEXT NOT NULL DEFAULT '{}',
      last_seen_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      created_by TEXT NOT NULL DEFAULT 'user',
      UNIQUE(daemon_id, provider)
    );
    CREATE INDEX IF NOT EXISTS idx_agent_runtimes_status ON agent_runtimes(status);
    CREATE TABLE IF NOT EXISTS agent_sessions (
      id INTEGER PRIMARY KEY,
      node_id INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      agent TEXT NOT NULL DEFAULT 'qodercli',
      runtime_id INTEGER REFERENCES agent_runtimes(id) ON DELETE SET NULL,
      title TEXT NOT NULL DEFAULT '',
      cli_session_id TEXT,
      work_dir TEXT,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
      run_count INTEGER NOT NULL DEFAULT 0,
      last_activity_at TEXT,
      created_at TEXT NOT NULL,
      created_by TEXT NOT NULL DEFAULT 'user'
    );
    CREATE INDEX IF NOT EXISTS idx_agent_sessions_node ON agent_sessions(node_id);
    CREATE INDEX IF NOT EXISTS idx_agent_sessions_activity ON agent_sessions(status, last_activity_at);
    CREATE TABLE IF NOT EXISTS agent_run_messages (
      id INTEGER PRIMARY KEY,
      run_id INTEGER NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
      seq INTEGER NOT NULL,
      type TEXT NOT NULL,
      tool TEXT,
      content TEXT,
      input TEXT,
      output TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(run_id, seq)
    );
    CREATE INDEX IF NOT EXISTS idx_agent_run_messages_run ON agent_run_messages(run_id, seq);
  `)
  addColumns(db, 'agent_runs', [
    ['session_id', 'INTEGER REFERENCES agent_sessions(id) ON DELETE SET NULL'],
    ['runtime_id', 'INTEGER REFERENCES agent_runtimes(id) ON DELETE SET NULL'],
    ['attempt', 'INTEGER NOT NULL DEFAULT 1'],
    ['max_attempts', 'INTEGER NOT NULL DEFAULT 3'],
    ['parent_run_id', 'INTEGER REFERENCES agent_runs(id) ON DELETE SET NULL'],
    ['failure_reason', 'TEXT'],
    ['cli_session_id', 'TEXT'],
    ['work_dir', 'TEXT'],
    ['priority', 'INTEGER NOT NULL DEFAULT 0'],
    ['resumed', 'INTEGER NOT NULL DEFAULT 0'],
    ['wait_reason', 'TEXT']
  ])
  db.exec('CREATE INDEX IF NOT EXISTS idx_agent_runs_session ON agent_runs(session_id, id)')

  // 回归测试闭环（v3）：老库补表；SCHEMA 只对新库生效
  db.exec(`
    CREATE TABLE IF NOT EXISTS test_cases (
      id INTEGER PRIMARY KEY,
      node_id INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'regression'
        CHECK (kind IN ('regression','acceptance','code_check','biz_check','release_check')),
      prompt TEXT NOT NULL,
      expectation TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      sort INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      created_by TEXT NOT NULL DEFAULT 'user',
      updated_by TEXT NOT NULL DEFAULT 'user',
      UNIQUE(node_id, name)
    );
    CREATE INDEX IF NOT EXISTS idx_test_cases_node ON test_cases(node_id, sort, id);
    CREATE TABLE IF NOT EXISTS test_reports (
      id INTEGER PRIMARY KEY,
      node_id INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      case_id INTEGER REFERENCES test_cases(id) ON DELETE SET NULL,
      run_id INTEGER REFERENCES agent_runs(id) ON DELETE SET NULL,
      kind TEXT NOT NULL DEFAULT 'regression',
      status TEXT NOT NULL DEFAULT 'running'
        CHECK (status IN ('running','pass','fail','blocked','error','cancelled')),
      summary TEXT,
      detail TEXT,
      auto_finalized INTEGER NOT NULL DEFAULT 0,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      updated_at TEXT NOT NULL,
      created_by TEXT NOT NULL DEFAULT 'user'
    );
    CREATE INDEX IF NOT EXISTS idx_test_reports_node ON test_reports(node_id, id);
    CREATE INDEX IF NOT EXISTS idx_test_reports_case ON test_reports(case_id, id);
  `)
  // v5：报告标记「已由 run 终态自动收尾」，与人工回写区分（老库补列，SCHEMA 只对新库生效）
  addColumns(db, 'test_reports', [['auto_finalized', 'INTEGER NOT NULL DEFAULT 0']])

  // 上线清单（v4）：老库补表；SCHEMA 只对新库生效
  db.exec(`
    CREATE TABLE IF NOT EXISTS release_items (
      id INTEGER PRIMARY KEY,
      node_id INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'config'
        CHECK (kind IN ('config','sql','check')),
      content TEXT NOT NULL DEFAULT '',
      rollback TEXT,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','ready','done','blocked','skipped')),
      required INTEGER NOT NULL DEFAULT 1,
      sort INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      created_by TEXT NOT NULL DEFAULT 'user',
      updated_by TEXT NOT NULL DEFAULT 'user',
      UNIQUE(node_id, name)
    );
    CREATE INDEX IF NOT EXISTS idx_release_items_node ON release_items(node_id, sort, id);
  `)

  // 验收签收（v7）：老库补表；SCHEMA 只对新库生效
  db.exec(`
    CREATE TABLE IF NOT EXISTS acceptance_signoffs (
      id INTEGER PRIMARY KEY,
      node_id INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      scope TEXT NOT NULL DEFAULT 'self' CHECK (scope IN ('self','subtree')),
      decision TEXT NOT NULL CHECK (decision IN ('accepted','rejected')),
      comment TEXT,
      evidence_fingerprint TEXT NOT NULL,
      signed_by TEXT NOT NULL,
      signed_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(node_id, scope)
    );
    CREATE INDEX IF NOT EXISTS idx_acceptance_signoffs_node ON acceptance_signoffs(node_id, scope);
  `)

  // 文档历史（v6）：SCHEMA 会为新老库建表；老库中已有文档在首次打开时各回填一份当前快照。
  db.exec(`
    CREATE TABLE IF NOT EXISTS document_versions (
      id INTEGER PRIMARY KEY,
      document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      reason TEXT NOT NULL DEFAULT 'update',
      created_at TEXT NOT NULL,
      created_by TEXT NOT NULL DEFAULT 'user'
    );
    CREATE INDEX IF NOT EXISTS idx_document_versions_doc ON document_versions(document_id, id);
    INSERT INTO document_versions (document_id, name, content, reason, created_at, created_by)
    SELECT d.id, d.name, d.content, 'migrated', d.updated_at, d.updated_by
      FROM documents d
     WHERE NOT EXISTS (SELECT 1 FROM document_versions v WHERE v.document_id = d.id);
  `)

  // max_attempts 从「死字段」升级为硬上限（默认 3）。老库的历史行都带着旧的默认 1，
  // 若直接按硬上限判定会全部不可重试；用 meta 标记做一次性回填（只跑一次，避免误伤显式传 1 的新行）。
  const attemptsMigrated = db.prepare("SELECT value FROM meta WHERE key = 'agent_max_attempts_v2'").get()
  if (!attemptsMigrated) {
    db.prepare('UPDATE agent_runs SET max_attempts = 3 WHERE max_attempts IS NULL OR max_attempts < 3').run()
    db.prepare("INSERT OR REPLACE INTO meta (key,value) VALUES ('agent_max_attempts_v2','1')").run()
  }
}

function addColumns(db, table, additions) {
  const cols = db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .map((c) => c.name)
  for (const [name, ddl] of additions) {
    if (!cols.includes(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${ddl}`)
  }
}
