# 设计：工程基座与配置（foundation）

## 1. 模块与职责

| 文件 | 职责 | 不做 |
|---|---|---|
| `server/errors.mjs` | 稳定错误码 `CODES`、`AppError`、`fail()` | 不做 HTTP 状态码映射（计划 2） |
| `server/config.mjs` | `config.json` 读写、默认值、600 权限、token 打码；导出 `DB_PATH` / `UPLOAD_DIR` | 不校验业务字段 |
| `server/db.mjs` | `openDb()` 打开库、建表建索引、预置；导出 `CHILD_TYPES` / `LEAF_TYPES` | 不做业务校验（属 store） |
| `test/helpers.mjs` | 每个用例一个临时 HOME + 独立库文件 | 不含断言 |

## 2. 关键设计

- **HOME 在模块 import 时确定**：`const HOME = process.env.TASKBOARD_HOME || path.join(os.homedir(), '.taskboard')`。ESM 模块只求值一次，所以同一测试文件内改 `TASKBOARD_HOME` 不会换目录；用例隔离靠 `openDb(file)` 显式指向本次临时目录下的 `data.db`。
- **错误码写进 `err.name`**：`String(err)` 输出 `PARENT_TYPE_INVALID: <人话>`；`err.message` 不重复码值（HTTP 层的 `message` 保持干净）。
- **建表 + 预置幂等**：`CREATE TABLE IF NOT EXISTS`；以「`attr_defs` 计数为 0」作为播种条件；后续 schema 变更在 `db.mjs` 内追加幂等迁移块。
- **快照主键重映射**：文本快照导入统一清空后按依赖顺序重建；除 nodes/attrs/repos 外，documents 也建立旧→新 id 映射，供 `document_versions` 重写外键；test_cases 建立映射供 `test_reports.case_id` 重写（`run_id` 指向的 agent 运行日志不随快照迁移，导入置 null）；`acceptance_signoffs` 随 nodes 重映射。
- **父子类型单一事实来源**：`CHILD_TYPES`（父 → 允许的子类型数组），空数组即叶子；store 的类型校验只读它，不在别处重复定义。

## 3. 对外接口

```js
// errors.mjs
CODES                       // { VALIDATION_FAILED, PARENT_TYPE_INVALID, LEAF_NODE, CYCLE_DETECTED, NOT_FOUND, PATH_NOT_FOUND, PATH_AMBIGUOUS, DOC_NAME_EXISTS, CONFIRM_REQUIRED }
class AppError extends Error // .name = 错误码, .code, .details
fail(code, message, details) // 抛 AppError

// config.mjs
HOME_DIR, CONFIG_PATH, DB_PATH, UPLOAD_DIR, DEFAULT_CONFIG
loadConfig()  // 不存在则生成默认并返回
saveConfig(patch) // 局部深度合并后落盘（600）
maskToken(cfg)    // token → '****'

// db.mjs
CHILD_TYPES, LEAF_TYPES
openDb(file = DB_PATH) // DatabaseSync，已开 WAL / 外键 / busy_timeout，已建表与预置
```

## 4. 与主设计文档的对应

§4.9（预置属性定义逐条对应 `SEED_ATTR_DEFS`）、§4.10（config 默认值逐字段对应 `DEFAULT_CONFIG`）、§4.11–4.12（`merges` / `unit_repos` 建表已就位，读写留给计划 4）、§9（错误码清单，本功能只落数据层需要的那些）。

## 5. 数据快照的覆盖口径（XPX-151 缺陷修复）

**缺陷**：表清单曾硬编码在 `scripts/export-snapshot.mjs` 与 `scripts/import-snapshot.mjs` 两处，
且停在新库最早的 9 张表。后续新增的 `test_cases` / `test_reports` / `release_items` / `comments` /
`branch_configs` / `agent_runtimes` / `agent_sessions` / `agent_runs` / `agent_run_messages` /
`ide_requests` 都不在清单里——**导出不报错、导入也不报错，快照静默丢表**。
靠「记得改两处」防不住这类回归：已有两个并行分支各自手工往清单里补过表，正是这个原因；
修复过程中又立刻撞到第三个（并行分支新加的 `delivery_snapshots` 不在任何清单里）——
说明**任何人工维护的表清单都会漂移**，所以最终没有选择「再手写一份更全的清单」。

**修复：表集合与顺序从 schema 推导，不再维护手工清单**（`scripts/snapshot-tables.mjs`）

- `listBusinessTables(db)`：业务表 = `sqlite_master` 全部表 − `EXCLUDED_TABLES`。
  **新增表自动进快照**，不存在「忘了加」这条路径——这是根治点。
- `EXCLUDED_TABLES`：有意不进快照的表 + 理由（目前只有 `meta`：
  `revision` 走快照顶层字段对齐，其余键是打开库时重建的幂等迁移标记）。
  `assertExclusionsDocumented()` 要求理由非空，「显式排除」与「忘了加」因此可区分。
- `importPlan(db)`：导入顺序按 `PRAGMA foreign_key_list` 做**拓扑排序**（被引用表在前）；
  自引用表（`nodes.parent_id` / `agent_runs.parent_run_id`）标记 `selfReferencing`，
  由导入端**两阶段处理**（见下）。
- 外键映射直接读 `PRAGMA foreign_key_list`（不再手写）：每张表统一按旧 id → 新 id 重建，
  原实现「漏表就连带漏掉外键映射」的问题不复存在。

**自引用列必须「先插入、后回填」（复验退回的缺陷）**：第一版把自引用表按 id 升序插入，
隐含假设「父 id 必然小于子 id」。真实库里不成立——有 7 条 `子 id < 父 id` 的记录
（`98/109/119 → 158`、`130/141/148 → 159`、`153 → 160`），先插入子行时映射表里还没有父 id，
`parent_id` 被**静默写成 `NULL`**。行数守恒、`IS NOT NULL` 孤儿检查都发现不了（`NULL` 是合法外键值），
只有逐行关系断言能测出。现改为两阶段：第一阶段按计划插入全部行、自引用列先留空，
第二阶段在**同一个事务内**统一回填，父子顺序不再影响结果。`agent_runs.parent_run_id`
走同一条路径（不只为 `nodes` 打补丁）。

**版本与兼容**：快照 `version` 升到 2，并自带 `plan`（导出时的表与外键）。
导入优先按快照的 `plan` 重建；导入 v1 老快照（无 `plan`）时按目标库 schema 推导，
且缺表会显式告警（列出将被清空的表），不再静默清库。
若快照提到的表在当前目标库不存在（schema 不同），跳过并显式告警。

**回归防护**：`test/snapshot.test.mjs` 断言「业务表集合 = 真实表 − 显式排除，新增表自动纳入」、
「端到端往返不丢表」，并对 `nodes.parent_id` / `agent_runs.parent_run_id` 做**逐行关系断言**
（按名称/标题映射比对，不依赖 id）；另外单列「子 id < 父 id」「父 run 后创建」两条回归用例。
变异验证：把实现改回旧的 9 张硬编码清单会挂 5 条；把导入端改回「按 id 升序 + 边插边解析」
会挂上面 2 条自引用用例。
