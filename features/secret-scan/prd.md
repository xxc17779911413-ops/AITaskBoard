# 功能：文档敏感信息扫描（只读安全前置判定）

- 代码：`server/store.mjs`（`buildSecretScan`）、`server/ops.mjs`（`renderSecretScanMd`）
- 入口：HTTP（`GET /api/nodes/:id/secret-scan`）· CLI（`secret scan <ref>`）· MCP（`secret_scan`）
- 主设计文档：`../../docs/design.md` §2.1；相邻功能：`../documents/`、`../requirement-readiness/`、`../delivery-gate/`

## 1. 目标

TaskBoard 的文档会被 AI 与人在需求、设计、联调、验收各环节反复写入，也会被继续贴进 issue、MR 与测试报告。
把真实 token / 私钥 / 密码写进这些文档，等于让凭据进入整条研发协作链路。

本功能补上一层**只读安全前置判定**：扫描节点（含子树）文档正文中的高风险凭据模式，
给出稳定的规则名、脱敏证据与处置建议；不新增写入路径，不改变文档内容。

AI 编码代理使用工具、读取 `.env`、生成 curl 示例已很普遍；业界建议是把秘密留给专用 Secret 管理，
而不是让代理读写明文凭据。该功能把这条原则落到 TaskBoard 的文档入口，先“看得见”，再决定是否轮换。

## 2. 需求点

- R1 扫描对象是既有 `documents`，`scope=self` 只扫本节点，`scope=subtree` 纳入子树；
  空白预置文档不计入可扫描对象。
- R2 规则按严重度分两级：
  - `danger`（高危，阻塞）：PEM 私钥块、AWS Access Key、GitHub Token、Slack Token、JWT、显式密钥赋值；
  - `warn`（提示，不阻塞）：`Bearer <token>` 形式的联调示例。
- R3 顶层三态：有 `danger` → `ready=false`；扫描到文档且无 `danger` → `ready=true`；
  范围内没有非空文档 → `ready=null`（没有可扫描对象，不是安全通过）。
- R4 输出逐条命中（节点 / 文档 / 规则 / 严重度 / 行列 / 脱敏值 / 脱敏上下文 / 处置建议）、
  `blockers`、`warnings`、`totals` 与 `byRule`；支持 `format=md`。
- R5 **绝不回显原值**：所有命中证据都要先脱敏，否则安全扫描本身会成为第二条泄露通道。
- R6 只读聚合：**不写库、不动 revision**。
- R7 `scope` / `format` 复用 `store.normalizeScope` / `normalizeFormat`，非法值一律 `VALIDATION_FAILED`，
  三入口一致，不静默降级。

## 3. 非目标（首版）

- 不自动删除 / 改写命中的文档内容；
- 不做熵值检测与二进制扫描，首版只覆盖稳定的高置信模式；
- 不扫描 `~/.taskboard/config.json` 或本机文件系统；
- 不把扫描结论并入交付门禁，留给后续显式决策。

## 4. 验收标准

- `test/secret-scan.test.mjs`：空态 `ready=null`；高危阻塞与 `warn` 不阻塞；
  私钥 / AWS / GitHub / Slack / JWT / 显式赋值独立命中；示例占位值不误伤；
  **命中证据强制脱敏且序列化结果不含原值**；`scope=subtree` 回填来源节点；
  纯读不产生 revision；非法 `scope` / `format` 拒绝；markdown 渲染与转义；能力清单登记。
- 三入口 1:1：HTTP `?scope=&format=`、CLI `secret scan`、MCP `secret_scan` 与 store 结果一致；
  非法参数 HTTP 400 / CLI 非零 / MCP `isError + VALIDATION_FAILED`。
- `npm test` 全绿；`npm run build` 通过；文档同步更新（本目录三件套 + `docs/design/04-api.md`
  + `docs/api.md` + `docs/design/08-testing.md` + `docs/design/09-decisions.md` + `features/README.md`）。

## 5. 产品 / AI 风向依据

- Auth0 2026-06 的观点是「不要把 secret 放进 tool schema 或 skill prompt，让代理表达意图而不是持有凭据」：
  https://auth0.com/blog/want-ai-agents-that-don-t-spill-secrets-don-t-give-them-secrets/
- Bitwarden 2026-04 指出编码代理能读到 `.env`，因此需要专用 Secret 访问边界，而不是让密钥散落在可读写文件里：
  https://bitwarden.com/blog/secure-ai-agent-access-with-secrets-manager/

落到 TaskBoard：文档是 AI 最常读写、也最容易被贴进 issue / MR 的载体，
因此先把「文档里有没有明文凭据」变成可见、可定位、可脱敏报告的只读检查，再走向自动清理或门禁接入。
