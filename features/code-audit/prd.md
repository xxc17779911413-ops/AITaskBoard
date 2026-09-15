# 功能：代码检查（已登记提交新增行的只读静态审查）

- 代码：`server/code-audit.mjs`（规则引擎与汇总）、`server/git.mjs`（`commitAddedLines`）、`server/ops.mjs`（`getNodeCodeAudit` / `renderCodeAuditMd`）
- 入口：HTTP（`GET /api/nodes/:id/code-audit`）· CLI（`code audit <ref>`）· MCP（`code_audit`）· Web（节点抽屉「代码检查」页签）
- 主设计文档：`../../docs/design/04-api.md`；相邻功能：`../commit-registry/`（提交登记）、`../diff-preview/`（diff 读取）、`../release-governance/`（上线检查用例）

## 1. 目标

TaskBoard 已经能登记提交、预览 diff、追踪合并与推送，但「这次改动**本身**有没有问题」仍然只能靠人肉读 diff，
或派一个 AI 任务去跑（数分钟、要模型、结果不确定）。本功能补上一条**确定性**的代码检查：
对节点（含可选子树）已登记提交的**新增代码行**做只读静态审查，产出一个稳定可复算的结论。

它复用「`test_cases.kind` 预留 `code_check`」这一扩展轴：`kind=code_check` 的用例仍走 AI 派单做需要理解的检查，
本功能负责**不需要模型、必须每次都跑**的那部分机械规则，两者互补而非替代。

## 2. 需求点

- R1 扫描对象是**已登记提交的新增行**（`git show --unified=0` 的 `+` 行），不扫既有代码：
  代码检查要回答「本次改动引入了什么风险」，扫全文件会把历史遗留问题算到本次交付头上。
- R2 规则按严重度分两级：
  - `danger`（高危，阻塞）：未解决的合并冲突标记 / 私钥内容 / 疑似硬编码凭据 / `eval` 或 `new Function` /
    测试被 `.only`、`fit`、`fdescribe` 聚焦；
  - `warn`（仅提示）：遗留 `debugger` / `console.log`、新增 lint 抑制、新增 TODO / FIXME / HACK。
- R3 顶层三态：有 `danger` → `ready=false`；扫到新增行且无 `danger` → `ready=true`；
  范围内没有提交、没有新增行、有提交读不到、或扫描被截断 → `ready=null`（「不知道」不冒充「通过」）。
- R4 逐条证据包含节点来源 / 提交 / 文件 / 行号 / 规则 / 严重度 / 片段 / 建议；
  `blockers`（仅 danger）/ `warnings` / `totals.byRule`；支持 `format=md`。
- R5 **硬编码凭据必须先脱敏再截断，且覆盖一行内所有凭据值**：任何输出（含 markdown / MCP 文本 / Web 片段）
  都不得回显原值；一行有多个凭据赋值（哪怕值相同）时逐个掩码，同值在本行多次出现也一并掩码——
  否则代码检查本身会成为第二条泄露通道。
- R6 只读聚合：**不写库、不动 revision**（与 `acceptance_report` / `readiness` / `release_checklist` 同一条原则）。
- R7 单条提交读取失败（仓库未登记 / 路径无效 / sha 不存在）不拖垮整体，记 `item.error` 并让结论落到 `ready=null`。
- R8 `scope` / `format` 复用 `store.normalizeScope` / `store.normalizeFormat`，非法值一律 `VALIDATION_FAILED`，三入口一致。
- R9 单次扫描提交数有上限（`CODE_AUDIT_MAX_COMMITS`）；超过即截断并返回 `ready=null`，
  避免子树很大时把开销打爆，也避免「没扫完却报通过」。

## 3. 非目标（首版）

- 不做语义级 / 跨文件数据流分析（那类由 `kind=code_check` 的 AI 用例承担）；
- 不做依赖漏洞 / 许可证扫描（后续可作独立规则集接入）；
- 不自动改写代码或删除命中的内容；
- 不并入交付门禁（作为独立可查结论先落地，是否成为交付来源留给后续显式决策）。

## 4. 验收标准

- `test/code-audit-rules.test.mjs`：每条规则的命中与不命中（含冲突标记 vs markdown 分隔线、
  `.only` 仅测试文件、注释行不命中、凭据占位值 / 变量引用不命中、比较表达式不误判成赋值）、
  脱敏先于截断、顶层三态的优先级、`byRule` 聚合、截断降级。
- `test/code-audit.test.mjs`：`commitAddedLines` 的行号与新增行口径（新增 / 修改 / 删除 / 二进制）、
  `getNodeCodeAudit` 的命中 / 干净 / 单条失败 / `scope=subtree` / 纯读不产生 revision、markdown 表格转义。
- `test/code-audit-entrypoints.test.mjs`：CLI 真实子进程、MCP 真实协议与 store 逐字段一致、非法 scope 契约。
- `test/http.test.mjs`：全链路（登记提交 → 命中 → md → 400 `VALIDATION_FAILED`）。
- `npm test` 全绿；三入口 1:1；文档同步更新（本目录 + `docs/design/04-api.md` + `docs/design/08-testing.md` + `docs/design/09-decisions.md` + `docs/api.md` + `features/README.md`）。
