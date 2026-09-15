# 功能设计：文档敏感信息扫描

## 1. 模块职责

- `server/store.mjs`：`buildSecretScan(nodeId, { scope })` 只读聚合。
  选非空文档 → 逐行跑稳定规则 → 产出脱敏证据与三态结论。**不写库，不 bump revision**。
- `server/ops.mjs`：`renderSecretScanMd(scan)` 渲染可粘贴 markdown；`secret_scan` 登记进 `TOOLS`。
- `server/http.mjs` / `cli.mjs` / `mcp.mjs`：三入口 1:1 暴露，只做参数装配与错误映射。

## 2. 关键规则

**R1 扫描结论是推导，不落表**：命中会随文档修改实时变化；落表会产生第二份真相，
还要处理失效与同步。与 `readiness` / `acceptance_report` / `delivery_gate` 同一条只读聚合原则。

**R2 高危与提示分级**：`danger` 是可直接被利用的真实凭据形态，或明确被赋值进文档的秘密；
`warn` 是裸 `Bearer` token 这类需要人工确认的联调示例。只有 `danger` 进入 `blockers` 并让 `ready=false`。

**R3 空态必须是 null**：节点会预置空白「需求内容」等文档。如果把空白文档当成扫描对象，
空需求会得到 `ready=true` 的假绿灯。实现先过滤 `content.trim() === ''`，没有非空文档时返回 `null`。

**R4 输出必须二次脱敏**：安全扫描结果是会进入 issue / MR / agent 上下文的文本。
证据里的 `redacted` 只保留前后少量字符，`excerpt` 用 `[REDACTED:<rule>]` 替换命中片段，
以免扫描报告本身泄露原始 token。

**R4.1 同一行多命中必须整行统一脱敏**：一行出现多个凭据（例如 `token=a password=b`）时，
若每条 finding 只替换自己的命中片段，A 的 `excerpt` 会把 B 的原文一起带出去。因此先收集整行全部命中区间，
合并后一次性替换，再为每条 finding 生成完全脱敏的上下文。回归覆盖同一行双 `generic` 与 `AWS + generic`，
并断言 store / HTTP / CLI / MCP / markdown 均不含任一原值。

**R5 规则按行匹配**：行列号用于定位，位置信息比全文本偏移更便于人修订；
行内正则扫描也避免跨行误配（例如把两行相邻文本拼成一个 token）。

**R6 占位值不过度报错**：`example` / `placeholder` / `<your-token>` / `changeme` 等常见示例值直接跳过。
安全扫描一旦长期噪声化，真实高危项就会被忽略。

**R7 `scope` / `format` 单点校验**：入口透传原始值给 `store.normalizeScope` / `normalizeFormat`；
非法值必须报错，不能先做三元降级。

**R7.1 MCP 非字符串参数也要走业务错误**：`z.string()` 会在 handler 之前抛 SDK `-32602`，
与 HTTP / CLI 的 `VALIDATION_FAILED` 契约不一致。MCP `secret_scan` 的 `scope` / `format` 放宽接收，
再在 handler 内显式拒绝非字符串，统一返回 `isError + VALIDATION_FAILED`。

## 3. 规则集（首版）

| 规则 key | 严重度 | 命中条件 | 处置建议 |
|---|---|---|---|
| `private_key_block` | danger | PEM 私钥起始标记 | 删除正文，改用密钥管理系统 / CI Secret |
| `aws_access_key` | danger | `AKIA` / `ASIA` + 16 位 | 立即轮换并移除 |
| `github_token` | danger | `ghp_` / `gho_` / `github_pat_` 等 | 吊销 token，改用仓库 Secret |
| `slack_token` | danger | `xoxb-` / `xoxp-` 等 | 撤销 token |
| `jwt` | danger | 三段式 `eyJ...` JWT | 真实 token 吊销轮换 |
| `generic_secret_assignment` | danger | `token=...` / `password=...` 等显式赋值 | 改占位符，凭据放本机 config / CI Secret |
| `bearer_token` | warn | `Bearer <长 token>` | 改为 `<token>` 占位符 |

## 4. 踩坑 / 约束

- **空白文档不能算扫描过**：预置空文档会让空态 `null` 变成 `true`，与所有门禁的空态纪律冲突。
- **脱敏必须发生在返回前**：只在 markdown 渲染里脱敏不够，JSON / MCP 同样会暴露。
- **不要做全文本 `includes`**：行列定位与行内匹配能避免跨行误配，也便于输出稳定证据。
- **规则值域是契约**：后续新增规则可以，但已有 `key` / `severity` 语义不要改，消费方据此决定是否阻塞。
- **不把 `secret_scan` 自动并入门禁**：它是安全审查的一部分，但并入交付门禁会改变既有 `totals.sources`
  契约，需要单独决策。

## 5. 关联章节

- 接口表：`docs/design/04-api.md`「文档敏感信息扫描」段
- 接口示例：`docs/api.md`
- 测试策略：`docs/design/08-testing.md`
- 决策：`docs/design/09-decisions.md` 决策 39
- 相邻功能：`../documents/`（扫描对象）、`../requirement-readiness/`、`../delivery-gate/`（下游结论）
