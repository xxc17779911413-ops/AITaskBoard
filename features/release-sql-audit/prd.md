# 功能：上线 SQL 风险审查（上线检查的静态前置判定）

- 代码：`server/store.mjs`（`buildReleaseSqlAudit`）、`server/ops.mjs`（`renderReleaseSqlAuditMd`）、
  `server/config.mjs`（`releaseSqlAudit` 阈值配置）
- 入口：HTTP（`/api/nodes/:id/release-sql-audit`）· CLI（`release sql-audit <ref>`）· MCP（`release_sql_audit`）
- 主设计文档：`../../docs/design.md` §4.15（release_items）；相邻功能：`../release-governance/`（上线项与检查清单）、
  `../delivery-gate/`（交付结论）

## 1. 目标

上线治理现在能回答「上线项做完了没有」，但登记为 `kind=sql` 的 DDL / DML **内容本身有没有风险**，
仍要靠人在上线前逐条读 SQL。漏掉一条 `DROP TABLE` / 无 `WHERE` 的 `UPDATE` 就可能在生产上造成不可逆损失。

本功能补上这层**静态前置判定**：把节点（含子树）下所有 `kind=sql` 的上线项正文扫一遍，
按稳定的规则集给出「有没有高危写法」的确定结论，让上线前审查不再依赖人工肉眼。

统一口径：`ready=true` 表示范围内所有 SQL 上线项均无高危项；`ready=false` 表示至少有一条高危；
`ready=null` 表示**范围内没有 SQL 上线项**（不是「通过」，也不是「没通过」）。

## 2. 需求点

- R1 审查对象是 `release_items` 里 `kind=sql` 的上线项（复用既有登记，不新增表、不改上线项结构）；
  `scope=self` 只审本节点，`scope=subtree` 纳入子树。
- R2 规则命中按**严重度**分两级：
  - `danger`（高危，阻塞）：`DROP TABLE` / `DROP DATABASE`、`TRUNCATE`、无 `WHERE` 的 `DELETE`、无 `WHERE` 的 `UPDATE`；
  - `warn`（提示，不阻塞）：`ALTER TABLE ... DROP COLUMN`、`kind=sql` 但缺回滚脚本。
- R2a 注释剥离、`;` 分段、`WHERE` 判定共享**一次词法扫描**：只在字符串 / 注释之外识别
  `;`、`WHERE` 与规则关键字，统一处理单引号 / 双引号 / 反引号、转义符与注释状态。
  字符串字面量里的 `where` / `--` / 块注释符号 / `;` 不得影响判定。
- R3 `DROP` / `TRUNCATE` / 无 `WHERE` 的更新删除是**不可逆**操作，必须阻塞（`ready=false`）；
  仅有 `warn` 时结论仍为可继续（`ready=true`），但要在 `blockers` 之外单列 `warnings`。
- R4 每个上线项要**附回滚脚本**才是完整的可执行 SQL 项；`kind=sql` 且 `rollback` 为空时记一条 `warn`。
- R5 `ready=null` 空态：范围内没有任何 `kind=sql` 上线项时返回 `null`，
  与验收报告 `passRate=null`、就绪门禁 / 上线清单 / 交付门禁的 `ready=null` 同口径。
- R6 输出 `items`（逐项 SQL + 命中规则作为依据）/ `blockers`（高危项）/ `warnings`（提示项）/
  `totals`（SQL 项数与危险 / 提示计数），并支持 `format=md` 直接贴进上线单 / 评审记录。
- R7 只读聚合：**不写库、不动 revision**——审查是从已登记内容推导出的结论，
  与 `acceptance_report` / `readiness` / `release_checklist` / `delivery_gate` / 推送门禁同一条原则。
- R7a `config.releaseSqlAudit.rules` 缺省用默认规则集；非数组或**空数组显式拒绝**
  （`VALIDATION_FAILED`），不静默回退默认，避免「配置写错」与「想放宽规则」都变成悄悄用默认集。
  只有 `undefined`（字段不写）算「未配置」；**显式 `null` 属于非数组，同样拒绝**。
- R8 `scope` / `format` 一律透传给 `store.normalizeScope` / `normalizeFormat` 单点校验，
  **不得在入口先做三元降级**；非法值返回 `VALIDATION_FAILED`（MCP 返回 `isError`，不泄漏 SDK `-32602`）。

## 3. 非目标（首版）

- 不真正执行 / 连库校验：只做**静态文本规则**审查，不做语义分析；
- 不自动改写 SQL 或补回滚脚本（由 AI / 人通过 `release_item_upsert` 修订）；
- 不改 `release_items` 表结构、不新增表、不改上线清单与交付门禁的来源集合；
- 不做 SQL 方言适配（MySQL / PostgreSQL 语法差异留给后续按需扩展规则集）。
  已知风险：PostgreSQL 的嵌套块注释（`/* outer /* inner */ ... */`）首版按单层处理，
  内层语句可能被误判为真实语句——按非目标声明不在本轮实现。

## 4. 验收标准

- `test/release-sql-audit.test.mjs`：四条 `danger` 规则各自独立命中；`danger` 阻塞、仅 `warn` 不阻塞；
  缺回滚脚本记 `warn`；`scope=subtree` 汇总与逐项明细；空态 `ready=null`；
  大小写 / 多行 / 注释不误伤；纯读不改 revision；markdown 渲染（含表格单元格转义）。
- **词法边界固定回归（D1/D2/D3）**：`UPDATE t SET note = 'where';` 必须判缺 `WHERE`；
  `SELECT '--'; DROP TABLE t;` 必须命中 `drop_table`；`UPDATE t SET note = ';' WHERE id = 1;`
  必须判为安全；并覆盖 `/* */` 同类场景与注释里的 `;`。
- **规则集契约**：六种输入各钉一条——`rules` 缺省与整个 `releaseSqlAudit` 选项缺省仍用默认规则集；
  `[]` / `null` / 字符串 / 数字 / 对象一律 `VALIDATION_FAILED`（`null` 不得当缺省处理）。
- 三入口 1:1：HTTP `?scope=&format=`、CLI `--scope --format`、MCP 字段集一致；
  非法 `scope` / `format` 一律 `VALIDATION_FAILED`（MCP 返回 `isError`）。
- `npm test` 全绿；文档同步更新（本目录 + `docs/design/02-data-model.md` + `docs/design/04-api.md`
  + `docs/api.md` + `docs/design/08-testing.md` + `docs/design/09-decisions.md` + `features/README.md`）。
