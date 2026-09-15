/**
 * 从文本快照恢复到本地库（幂等）
 *
 * 用法：
 *   node scripts/import-snapshot.mjs [快照路径] [--replace]
 *   默认读 <repo>/data/snapshot.json，写入 $TASKBOARD_HOME 或 ~/.taskboard/data.db
 *
 * --replace：先清空目标库的业务表再导入（默认行为；不加该参数则先清空以避免主键冲突）
 *
 * 安全：**不恢复 config.json**（token 属本机凭据，需各自在设置页填写）
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { importPlan, listExistingTables } from './snapshot-tables.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const snapArg = args.find((a) => !a.startsWith('--'))
const snapPath = snapArg ? path.resolve(snapArg) : path.join(root, 'data', 'snapshot.json')
const home = process.env.TASKBOARD_HOME || path.join(os.homedir(), '.taskboard')
const dbPath = path.join(home, 'data.db')

if (!fs.existsSync(snapPath)) {
  console.error(`[import] 找不到快照：${snapPath}`)
  process.exit(1)
}
if (!fs.existsSync(dbPath)) {
  console.error(`[import] 找不到目标库：${dbPath}（先跑一次 npm start 初始化）`)
  process.exit(1)
}

const snap = JSON.parse(fs.readFileSync(snapPath, 'utf8'))
if (snap.format !== 'taskboard-snapshot') {
  console.error(`[import] 快照格式不匹配：${snap.format}`)
  process.exit(1)
}

const db = new DatabaseSync(dbPath)
db.exec('PRAGMA foreign_keys = OFF') // 导入期间自行保证顺序，避免逐条外键校验

// 导入计划优先用快照里记录的 plan（v2+），保证按「导出时那张库」的表集合与外键重建；
// v1 老快照没有 plan，退回按目标库当前 schema 推导。
let PLAN = Array.isArray(snap.plan) && snap.plan.length ? snap.plan : importPlan(db)

// 快照可能来自 schema 更全 / 更旧的库：只重建目标库真实存在的表，
// 其余显式提示（否则 INSERT 会因缺表直接抛错，报错信息也难以理解）。
const targetTables = new Set(listExistingTables(db))
const notInTarget = PLAN.filter((t) => !targetTables.has(t.name)).map((t) => t.name)
if (notInTarget.length) {
  console.warn(`[import] 警告：目标库没有以下表，已跳过：${notInTarget.join(', ')}（快照来自 schema 不同的库）。`)
  PLAN = PLAN.filter((t) => targetTables.has(t.name))
}
const IMPORT_ORDER = PLAN.map((t) => t.name)
const DELETE_ORDER = [...IMPORT_ORDER].reverse()

// 「快照本身就没有这张表」与「快照有但为空」后果完全不同：前者导入会清空目标库对应数据。
// 必须显式提示，不能静默清库（历史缺陷 XPX-151）。
const absent = IMPORT_ORDER.filter((t) => !Array.isArray(snap.tables?.[t]))
if (absent.length) {
  console.warn(
    `[import] 警告：快照 v${snap.version ?? 1} 未包含以下表，导入后会清空目标库对应数据：${absent.join(', ')}。` +
      `如需保留，请先用新版导出脚本重新生成快照。`
  )
}

const insert = (table, row) => {
  const cols = Object.keys(row)
  const sql = `INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`
  return db.prepare(sql).run(...cols.map((c) => row[c]))
}

db.exec('BEGIN')
try {
  for (const t of DELETE_ORDER) db.prepare(`DELETE FROM ${t}`).run()

  // 主键重映射：旧 id → 新 id（父子 / 外键关系靠它重建，不依赖旧 id）
  const idMaps = Object.fromEntries(IMPORT_ORDER.map((t) => [t, new Map()]))

  const mapId = (table, value) => {
    if (value == null) return null
    return idMaps[table]?.get(value) ?? null
  }

  // 按计划顺序（外键依赖在前）逐表重建。表集合与外键都来自 schema，新增表无需改这里。
  //
  // 自引用列（nodes.parent_id / agent_runs.parent_run_id）**不能边插边解析**：
  // 父节点可能比子节点晚插入（例如「父节点后创建」或导入后重新分配 id），
  // 按 id 升序也修不了——「子 id < 父 id」时先插子节点，映射表里还没有父 id，
  // 会把合法外键静默写成 NULL（行数守恒、孤儿检查都发现不了）。
  // 因此分两阶段：先按计划插入全部行，把这些列留空，全部插完后再统一回填。
  const deferred = []

  // 各表的 NOT NULL 列：外键指向的行不在快照里时，NOT NULL 列无法用 NULL 落库，
  // 只能丢弃该行（见下面 dangling 判定）。
  const notNullColumns = new Set()
  for (const t of IMPORT_ORDER) {
    for (const c of db.prepare(`PRAGMA table_info(${t})`).all()) {
      if (c.notnull) notNullColumns.add(`${t}.${c.name}`)
    }
  }
  const dropped = []

  for (const { name, fks } of PLAN) {
    const selfCols = new Set(fks.filter((f) => f.table === name).map((f) => f.column))

    for (const r of [...(snap.tables[name] || [])]) {
      const row = { ...r }
      for (const fk of fks) {
        // 自引用列先留空，全部行插入完成后再回填（见下）
        row[fk.column] = selfCols.has(fk.column) ? null : mapId(fk.table, r[fk.column])
      }
      // 外键在快照里找不到目标行（孤儿行：数据被裁过 / 跨 schema）时：
      // 该列 NOT NULL 的行无法落库，只能丢弃——不能用 NULL 冒充，否则要么报约束错、
      // 要么在可空列上静默串到别的行。丢弃的行数显式汇总，不静默吞掉。
      const dangling = fks.filter(
        (fk) => !selfCols.has(fk.column) && r[fk.column] != null && row[fk.column] == null
      )
      const requiredDangling = dangling.filter((fk) => notNullColumns.has(`${name}.${fk.column}`))
      if (requiredDangling.length) {
        dropped.push(`${name}（${requiredDangling.map((f) => f.column).join('/')} 指向的行不在快照里）`)
        continue
      }
      const info = insert(name, row)
      const newId = Number(info.lastInsertRowid)
      idMaps[name].set(r.id, newId)

      // 记下「新行 → 原本的自引用旧 id」，回填阶段再翻译成新 id
      if (selfCols.size) {
        const pending = {}
        for (const col of selfCols) {
          if (r[col] != null) pending[col] = r[col]
        }
        if (Object.keys(pending).length) deferred.push({ table: name, newId, cols: pending })
      }
    }
  }

  // 统一回填自引用列：此时所有行都已插入，映射表完整，父子顺序不再影响结果。
  const unresolved = []
  for (const { table, newId, cols } of deferred) {
    const sets = Object.keys(cols)
    const sql = `UPDATE ${table} SET ${sets.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`
    const values = sets.map((c) => {
      const mapped = mapId(table, cols[c])
      // 引用在快照里找不到（跨 schema / 数据被裁过）：不能像过去那样静默写 NULL
      if (mapped == null) unresolved.push(`${table}.${c} 旧 id ${cols[c]}`)
      return mapped
    })
    db.prepare(sql).run(...values, newId)
  }
  if (unresolved.length) {
    console.warn(
      `[import] 警告：以下自引用关系在快照里找不到目标行，已置空（非静默处理）：${unresolved.join(', ')}。`
    )
  }
  if (dropped.length) {
    console.warn(
      `[import] 警告：以下行因外键目标不在快照里且该列为 NOT NULL，已丢弃：${dropped.join('、')}。`
    )
  }

  // revision 对齐快照（前端轮询据此刷新）
  db.prepare("UPDATE meta SET value = ? WHERE key = 'revision'").run(String(snap.revision ?? 0))

  db.exec('COMMIT')
} catch (e) {
  db.exec('ROLLBACK')
  throw e
}

const count = (t) => db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c
console.log(`[import] 已从 ${path.relative(root, snapPath)} 恢复 → ${dbPath}`)
for (const t of IMPORT_ORDER) console.log(`  ${t.padEnd(12)} ${count(t)}`)
console.log(`  revision     ${db.prepare("SELECT value FROM meta WHERE key='revision'").get().value}`)
console.log(`  （快照导出于 ${snap.exportedAt}）`)
