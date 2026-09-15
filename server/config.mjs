import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const HOME = process.env.TASKBOARD_HOME || path.join(os.homedir(), '.taskboard')

export const HOME_DIR = HOME
export const CONFIG_PATH = path.join(HOME, 'config.json')
export const DB_PATH = path.join(HOME, 'data.db')
export const UPLOAD_DIR = path.join(HOME, 'uploads')

export const DEFAULT_CONFIG = {
  port: 3210,
  gitlab: { base_url: '', token: '' },
  docPresets: {
    project: ['描述'],
    requirement: ['需求内容'],
    subreq: ['需求内容'],
    group: [],
    task: [],
    defect: ['描述', '复现步骤']
  },
  // 需求就绪门禁口径：需求内容 / 概要设计文档名 + 视为「可回归」的用例类型。
  // 与 server/store.mjs 的 DEFAULT_READINESS 保持一致。
  readiness: {
    requirementDoc: '需求内容',
    designDoc: '概要设计',
    caseKinds: ['regression', 'acceptance']
  },
  // 上线 SQL 风险审查：危险级别阻塞、提示级不阻塞（规则集可由 config.json 覆盖）。
  releaseSqlAudit: {
    rules: [
      { key: 'drop_table', severity: 'danger', pattern: '\\bdrop\\s+(table|database)\\b', label: 'DROP TABLE / DROP DATABASE（不可逆）' },
      { key: 'truncate', severity: 'danger', pattern: '\\btruncate\\b', label: 'TRUNCATE（清空表数据）' },
      { key: 'delete_without_where', severity: 'danger', pattern: '\\bdelete\\s+from\\b', requireNoWhere: true, label: 'DELETE 缺少 WHERE 限定' },
      { key: 'update_without_where', severity: 'danger', pattern: '\\bupdate\\b', requireNoWhere: true, label: 'UPDATE 缺少 WHERE 限定' },
      { key: 'drop_column', severity: 'warn', pattern: '\\bdrop\\s+column\\b', label: 'DROP COLUMN（结构不可逆）' }
    ],
    // 缺回滚脚本记一条提示（不阻塞），由 buildReleaseSqlAudit 单独处理。
    requireRollback: true
  },
  worktreeRoot: '',
  branchTemplate: '{base_branch}-{slug}',
  // 提示词模板（各环节派单；变量 {{...}} 由插件/调用方注入）
  promptTemplates: {
    // 缺陷修复派单：{{defectId}} {{title}} {{desc}} {{locationSection}}（位置+选中代码段落，自动生成）
    defect_analyze: [
      '你是 Qoder Agent。请对以下 task-board 缺陷（defect #{{defectId}}）做**根因分析与修复方案设计**（先不要改代码）。',
      '',
      '# 缺陷：{{title}}',
      '',
      '{{desc}}',
      '',
      '{{locationSection}}',
      '## 输出要求',
      '1. 根因（Root Cause）：定位到具体文件/函数/逻辑，解释为什么错',
      '2. 修复方案：改动点清单 + 影响面 + 验证方式',
      '3. 风险与备选方案（如有）',
      '',
      '（请用 task-board MCP 工具将结论回写到节点文档）'
    ].join('\n'),
    // 缺陷修复派单：root cause/方案已批准后才使用
    defect_dispatch: [
      '你是 Qoder Agent。以下 task-board 缺陷（defect #{{defectId}}）的根因与修复方案**已经审核批准**，请按方案实施修复。',
      '',
      '# 缺陷：{{title}}',
      '',
      '{{desc}}',
      '',
      '{{locationSection}}',
      '{{analysisSection}}',
      '## 要求',
      '严格按已批准的修复方案实施；如需偏离请先说明原因；完成后给出变更摘要与验证方式。'
    ].join('\n'),
    // 任务派单（「派给 Qoder」）：{{taskName}} {{taskId}} {{prdSection}} {{docs}} {{commitsSection}} {{filesSection}}
    task_dispatch: [
      '你是 Qoder Agent。请执行下面来自 task-board 的任务。',
      '',
      '# 任务：{{taskName}}',
      '',
      '{{prdSection}}',
      '{{docs}}',
      '{{commitsSection}}',
      '{{filesSection}}',
      '## 要求',
      '先阅读相关代码与上述上下文，按需修改；完成后给出变更摘要。'
    ].join('\n')
  },
  status: {
    labels: { todo: '待开始', doing: '进行中', testing: '提测中', done: '已完成', cancelled: '已取消' },
    allowed: {
      project: ['todo', 'doing', 'done'],
      requirement: ['todo', 'doing', 'testing', 'done', 'cancelled'],
      subreq: ['todo', 'doing', 'done'],
      group: ['todo', 'doing', 'done'],
      task: ['todo', 'doing', 'done'],
      defect: ['todo', 'doing', 'done', 'cancelled']
    }
  }
}

function deepMerge(base, patch) {
  const out = { ...base }
  for (const [k, v] of Object.entries(patch || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v)) out[k] = deepMerge(base[k] || {}, v)
    else out[k] = v
  }
  return out
}

export function loadConfig() {
  fs.mkdirSync(HOME, { recursive: true })
  if (!fs.existsSync(CONFIG_PATH)) {
    writeConfig(DEFAULT_CONFIG)
    return structuredClone(DEFAULT_CONFIG)
  }
  const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
  return deepMerge(DEFAULT_CONFIG, raw)
}

function writeConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 })
  fs.chmodSync(CONFIG_PATH, 0o600)
}

export function saveConfig(patch) {
  const cfg = deepMerge(loadConfig(), patch || {})
  writeConfig(cfg)
  return cfg
}

export function maskToken(cfg) {
  const token = cfg.gitlab && cfg.gitlab.token ? '****' : ''
  return { ...cfg, gitlab: { ...(cfg.gitlab || {}), token } }
}
