/**
 * 快照表清单的**单一事实来源**（export / import 共用）。
 *
 * 历史缺陷（XPX-151）：表清单曾硬编码在 `export-snapshot.mjs` 与 `import-snapshot.mjs`
 * 两处，新增业务表（`test_cases` / `test_reports` / `release_items` / `comments` /
 * `branch_configs` / `agent_*` 等）后两处都没同步——快照静默丢表：导出不报错、导入也不报错，
 * 等发现时数据已经不在快照里。并行分支各自手工往清单里补表，正说明「记得改两处」防不住这类回归。
 *
 * 所以这里**不再维护任何手工表清单**：表集合与导入顺序都从库的 schema 推导。
 *
 *   - 表集合 = `sqlite_master` 里的全部业务表 − `EXCLUDED_TABLES`（显式排除 + 理由）；
 *     新增表**自动进快照**，不需要改代码，也就不存在「忘了加」。
 *   - 导入顺序 = 按 `PRAGMA foreign_key_list` 做拓扑排序（被引用表在前）；
 *     自引用表（`nodes.parent_id` / `agent_runs.parent_run_id`）标记为需要按 id 升序插入。
 *   - 外键重映射 = 直接读 `PRAGMA foreign_key_list`，导入时统一按旧 id → 新 id 重建，
 *     不再为每张表手写一段插入逻辑。
 *   - `assertExclusionsDocumented()` 保证「被排除的表」都写了理由——
 *     显式排除与「忘了加」在代码里可区分。
 */

/** 有意不进快照的表 → 理由。放进这里等于显式声明「丢了可以重建」。 */
export const EXCLUDED_TABLES = {
  meta: 'revision 走快照顶层字段单独对齐；其余键（如 agent_max_attempts_v2）是幂等迁移标记，打开库时会重建'
}

/** 运行时真实存在的表名（排除 sqlite 内部表） */
export function listExistingTables(db) {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all()
    .map((r) => r.name)
}

/** 业务表（进快照）= 真实表 − 显式排除 */
export function listBusinessTables(db) {
  return listExistingTables(db)
    .filter((n) => !(n in EXCLUDED_TABLES))
    .sort()
}

/** 该表的外键列：`[{ column, table, refColumn }]`（读 schema，不手写） */
export function tableFks(db, table) {
  return db
    .prepare(`PRAGMA foreign_key_list(${table})`)
    .all()
    .map((r) => ({ column: r.from, table: r.table, refColumn: r.to }))
}

/**
 * 导入顺序：按外键依赖做拓扑排序（被引用表在前）。
 * 自引用（`fk.table === table`）不参与排序，由 `selfReferencing` 标记另行处理。
 * 每个元素：`{ name, fks, selfReferencing }`。
 */
export function importPlan(db) {
  const business = new Set(listBusinessTables(db))
  const order = []
  const visiting = new Set()
  const visited = new Set()

  const visit = (t) => {
    if (visited.has(t) || visiting.has(t)) return
    visiting.add(t)
    for (const fk of tableFks(db, t)) {
      if (fk.table !== t && business.has(fk.table)) visit(fk.table)
    }
    visiting.delete(t)
    visited.add(t)
    order.push(t)
  }

  // 外循环按名称排序，保证同一库每次导出顺序稳定（便于 diff）
  for (const t of [...business].sort()) visit(t)

  return order.map((name) => {
    const fks = tableFks(db, name)
    return { name, fks, selfReferencing: fks.some((f) => f.table === name) }
  })
}

/** 导入顺序的表名数组（调试 / 测试用） */
export function importOrder(db) {
  return importPlan(db).map((t) => t.name)
}

/**
 * 排除表必须都写了理由；理由为空视为未声明，直接抛错。
 * （防止有人为了消掉校验把表名丢进 EXCLUDED_TABLES 却不说明原因。）
 */
export function assertExclusionsDocumented() {
  const undocumented = Object.entries(EXCLUDED_TABLES)
    .filter(([, reason]) => !String(reason || '').trim())
    .map(([name]) => name)
  if (undocumented.length) {
    throw new Error(`以下表被排除出快照但未写明理由：${undocumented.join(', ')}`)
  }
}
