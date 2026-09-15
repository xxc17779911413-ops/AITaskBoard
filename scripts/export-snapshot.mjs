/**
 * 导出本地库为文本快照（便于入 git / 迁移 / 备份）
 *
 * 用法：
 *   node scripts/export-snapshot.mjs [输出路径]
 *   默认输出到 <repo>/data/snapshot.json
 *
 * 为什么导出文本而不是直接提交 data.db：
 *   - data.db 是二进制，git 无法 diff，每次改动都产生整份新副本
 *   - 旁边还有 data.db-wal / data.db-shm，直接拷 .db 会丢掉未 checkpoint 的数据
 *
 * 安全：**不导出 config.json**（内含 GitLab token，属本机凭据，永不入库）
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { EXCLUDED_TABLES, assertExclusionsDocumented, importPlan } from './snapshot-tables.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const home = process.env.TASKBOARD_HOME || path.join(os.homedir(), '.taskboard')
const dbPath = path.join(home, 'data.db')
const outPath = process.argv[2] ? path.resolve(process.argv[2]) : path.join(root, 'data', 'snapshot.json')

if (!fs.existsSync(dbPath)) {
  console.error(`[export] 找不到数据库：${dbPath}（先跑一次 npm start 初始化）`)
  process.exit(1)
}

// 只读打开：读 WAL 中的数据，但不改动源库
const db = new DatabaseSync(dbPath)
db.exec('PRAGMA foreign_keys = OFF')

try {
  assertExclusionsDocumented()
} catch (e) {
  console.error(`[export] ${e.message}`)
  process.exit(1)
}

// 表集合与顺序都从 schema 推导（见 scripts/snapshot-tables.mjs）：
// 新增业务表自动进快照，不存在「忘了加进清单」而静默丢数据的可能（历史缺陷 XPX-151）。
const PLAN = importPlan(db)
const TABLE_ORDER = PLAN.map((t) => t.name)

const tables = {}
for (const t of TABLE_ORDER) {
  tables[t] = db.prepare(`SELECT * FROM ${t}`).all()
}
const revision = Number(db.prepare("SELECT value FROM meta WHERE key = 'revision'").get()?.value ?? 0)

const snapshot = {
  format: 'taskboard-snapshot',
  // v2：表集合与顺序由 schema 推导，覆盖全部业务表（v1 只导 9 张，丢失 test_cases / release_items 等）
  version: 2,
  exportedAt: new Date().toISOString(),
  source: { dbPath, size: fs.statSync(dbPath).size },
  revision,
  // 记下本次导出的表清单，导入端据此判断「快照缺表」还是「表本来为空」
  plan: PLAN.map((t) => ({ name: t.name, fks: t.fks, selfReferencing: t.selfReferencing })),
  excluded: Object.keys(EXCLUDED_TABLES),
  counts: Object.fromEntries(Object.entries(tables).map(([k, v]) => [k, v.length])),
  tables
}

fs.mkdirSync(path.dirname(outPath), { recursive: true })
fs.writeFileSync(outPath, JSON.stringify(snapshot, null, 2) + '\n')

const bytes = fs.statSync(outPath).size
console.log(`[export] 已导出 → ${path.relative(root, outPath)}（${(bytes / 1024).toFixed(1)} KB）`)
for (const [k, v] of Object.entries(snapshot.counts)) console.log(`  ${k.padEnd(12)} ${v}`)
