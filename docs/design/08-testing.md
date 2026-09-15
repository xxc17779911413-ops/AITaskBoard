# 10. 测试策略

> 本文是主设计文档 [`../design.md`](../design.md) 的拆分章节；索引与章节导航见该文件。


- **单测（`node:test`）**：
  - `store`：建树与父子校验、环校验、级联删除计数、sort 与 reorder、节点移动
  - `attrs`：属性定义 CRUD、属性值 upsert、required / 类型校验、停用定义后不校验
  - `documents`：CRUD、按名 upsert 幂等、重名 409、排序、随节点级联删除
  - `commits`：sha 校验、同节点幂等
  - `gitlab`：分页、401、404、超时（mock `fetch`）
  - `config`：默认值生成、权限 600、token 打码
  - `uploads`：扩展名白名单 / ≤10 MB / **魔数与声明类型交叉校验**（改名与伪装被拦下）/ 落盘命名（时间戳 + 随机串，不覆盖）/ 静态访问可取回原始字节；三入口 1:1（HTTP 201 + `GET /uploads/:name`、CLI 路径与 `--data` 两种用法、MCP `upload_image` 非法值走 `isError` 而非 SDK 报错）；四入口落盘语义逐字段一致；**回归防护**——框架层错误不泄漏成 500（超大 body → 413 `PAYLOAD_TOO_LARGE`、非法 JSON → 400 `VALIDATION_FAILED`）、alt 转义（含 `]` 的文件名不截断 Markdown）、CLI 文件系统错误归一成 `VALIDATION_FAILED`、MCP 类型错误/缺字段走 `isError` 不泄漏 `-32602`（且对外 JSON schema 不退化）
  - `static-spa`：**静态托管与 SPA 回退优先级**（D1/D4 回归）——已存在图片命中 static 且字节一致、**不存在的 `/uploads/*` 必须 404 而不是回落到 SPA 变成 200 HTML**、含点号段的部署布局下深链仍返回 index.html、静态资源命中真实文件；三条契约在同一 app 上同时成立。**用例必须跑在含点号目录段（`<tmp>/.dotseg/…`）的布局下**，因为 `res.sendFile(绝对路径)` 默认拒绝点号段——开发/CI 的 `.worktrees/…` 正是这种布局，历史上曾让 SPA 回退整体失效，使「/uploads 不存在是否为 404」的验收在失效环境中得出错误结论
  - `git`：diff / log 读取、`merge-tree` 预检（构造真冲突用例）、merge 成功与失败、未登记仓库
  - `merges`：状态机（`precheck_conflict` → `resolved` / `merged`）、批量按序合并遇冲突停下、abort 不改分支
  - `conflicts`：三方内容读取、逐块接受 / 拒绝产出、补丁可 `git apply`
  - `workspace-setup`：`unit_repos` CRUD（按 node × repo 幂等 / 只更新显式字段 / 级联删除 / 仅 `group`|`task` 可登记）；分支名与 worktree 路径渲染（`branchTemplate`，`slug` 空退回 `n{id}`）；真 git 下 `setupWorkspace` 建出同名分支 + worktree、**分支从基线当前 tip 派生**、重复调用幂等、`dryRun` 不碰 git 不落库不动 revision、基线不符 `BRANCH_EXISTS_DIFFERENT_BASE`、路径占用 `WORKTREE_PATH_EXISTS`、基线缺失 `BRANCH_NOT_FOUND`；`cleanupWorkspace` 需 confirm、移除 worktree、**未并入基线的分支必须保留**、重复调用幂等、一次操作只 +1 revision；三入口 1:1（HTTP / CLI / MCP）与逐字段一致；MCP `confirm` 缺失走 `isError + CONFIRM_REQUIRED` 不泄漏 `-32602`
  - `workspace-setup` 回归（D1–D5，均以旧实现验证必失败）：**基线不符时拒绝且零副作用、重试仍拒绝**（D1）；**分支并入 HEAD 但未并入基线时必须保留**、已并入基线但基线领先 HEAD 时正常删除（D2，**夹具强制 HEAD ≠ 基线**）；`--keep-branch` 真正保留分支 + 三入口 `removeBranch` 语义一致（D3）；dryRun 能探明路径占用与基线不符且仍零副作用（D4）；纯 no-op 重复 setup 不再 +1 revision（D5）
  - **夹具纪律**：凡「与 HEAD 状态相关」的用例，夹具必须让 HEAD 与声明基线停在不同提交。早期 `workspace-setup` 夹具让三者同 commit，`git branch -d` 与 `merge-base --is-ancestor <branch> <base>` 结论完全一致，使 D2 在 383 条全绿下漏网——**全绿不等于夹具有能力区分**
  - `unit`：分支命名规则（`{base_branch}-{slug}` 与 slug 兜底 `n{id}`）、建分支 / worktree 幂等、清理默认保留、开发提示词内容
  - `test-case`：测试用例 CRUD / 按名唯一与 upsert 幂等 / `kind` 筛选 / 启停 / 排序 / 级联删除；报告开启与终态回写 / 历史保留；验收报告聚合（最近结果 / 通过率 / 未执行口径 / `scope=subtree` / 空态）；编排层 `dryRun` 与提示词拼装
  - `test-report-export`：单条报告 markdown 渲染（节点 / 类型 / 结论 / 结论来源 / run 关联 / 摘要 / 详情）、删除用例后的历史导出、只读不改 revision；REST / CLI / MCP 三入口 `format=md` 与非法 `format` 的 `VALIDATION_FAILED` 契约
  - `cli-regression-loop`：真实 CLI 子进程跑参数契约（`--enabled` / `--run-id` / `--overwrite`）与错误码
  - `test-fanout`：并行派单（`runTestCases` 的 fanout 分支）——缺省 grouped 行为逐字节不变（单 run + N 报告）；fan-out 每用例一个独立 run / 报告 / 提示词（run 提示词不含其它用例）；`maxParallel` 护栏超限**显式拒绝且未留 running 任务 / 报告**（防「假执行中」）、值域 1..16 与缺省 4；`dryRun` 不落库不动 revision；`caseIds` / `kind` 过滤；收尾时每条报告只认自己 run 的结论（一条 fail 不影响另一条 pass）、取消一条只收尾它自己；报告挂回用例所属节点且验收口径不变；HTTP body 与 MCP schema 字段 1:1（MCP 业务错误走 `isError + VALIDATION_FAILED`）；进程级真实 CLI `test run --fanout` 等全部 run 终态并各自回写
  - `test-fanout`（缺陷 2 回归）：`maxParallel` **类型严格性**——非 number（`true` / `"4"` / `[1]` / `{}` / `""` / `0x10` / `1e1`）一律 `VALIDATION_FAILED`，**grouped 下同样拒绝**（不得静默忽略）；`parseMaxParallelCli` 只接受规范十进制整数字面量；HTTP 400 / MCP `isError` 且不泄漏 SDK `-32602`；真实 CLI 子进程覆盖非法字面量
  - `agent` / `run-finalize`（缺陷 1 回归）：**重试刷新用例报告**——重试为同一用例随 child run 新开 `running` 报告、旧结论保留为历史；child 终态刷新该报告且验收报告取到重试后结论；普通任务重试不凭空造报告；grouped 多用例各开一条 child 报告；「child run + 报告」只 +1 revision；进程级真实 CLI `agent run retry` 端到端
  - 回归防护：每条缺陷修复都配一条「在旧实现上会失败」的 UT（`test-case.test.mjs` 缺陷 2/3/4、`http.test.mjs` 缺陷 1/2/3/5、`cli-regression-loop.test.mjs` 缺陷 5）
  - `release-item`：上线项 CRUD / 按名唯一与 upsert 幂等 / `kind` 与 `status` 筛选 / `includeOptional` / 排序 / 级联删除 / revision 语义；上线检查清单聚合（就绪结论 / 阻塞项 / 无必做项 `ready=null` / `scope=subtree` / `blocked` 与 `skipped` 计数）；**检查用例纳入就绪判定**——必做项全 `done` 但 `code_check` 未执行 → `ready=false`（假绿灯回归），最近一次 `pass` 后才就绪，之后 `fail` 重新阻塞，`running`/`not_run` 都不算证据，停用用例不阻塞，`scope=subtree` 纳入子树用例，纯读不产生 revision；编排层 `dryRun`（只挑 `code_check`/`biz_check`/`release_check` 用例、`caseIds` 过滤、`scope=subtree`）与 markdown 渲染
  - `readiness`：需求就绪门禁三条门禁各自独立判定（预置空文档不算通过 / 空白正文不算 / 停用用例与 `code_check` 不算可回归 / `acceptance` 算）；`scope=subtree` 汇总与逐单元结论、阻塞项；非需求类型 `scope=self` 拒绝并提示 `subtree`；**纯读聚合不产生 revision**；markdown 渲染
  - `secret-scan`：文档敏感信息扫描——PEM 私钥 / AWS / GitHub / Slack / JWT / 显式密钥赋值独立命中，高危阻塞而 `Bearer` 提示不阻塞；示例占位值不误伤；**命中证据强制脱敏且序列化结果不含原值**；空白预置文档不算可扫描对象，没有非空文档时 `ready=null`；`scope=subtree` 回填来源节点；纯读不产生 revision；非法 `scope`/`format` 三入口统一拒绝；markdown 渲染与能力清单登记
  - `release-sql-audit`：上线 SQL 风险审查——四条 `danger` 规则各自独立命中（`DROP TABLE/DATABASE` / `TRUNCATE` / 无 `WHERE` 的 `UPDATE` / `DELETE`）；带 `WHERE` 不命中、多语句按语句边界判 `WHERE`；大小写不敏感；注释里的关键字不误伤；`DROP COLUMN` / 缺回滚记 `warn` 不阻塞；非 `sql` 上线项不参与；`scope=subtree` 汇总；空态 `ready=null`；**纯读聚合不产生 revision**；markdown 单元格转义；三入口 1:1 与非法 `scope`/`format` 拒绝；`releaseSqlAudit.rules` 六种输入契约（字段缺省 / 选项缺省 → 默认集；`[]` / `null` / 字符串 / 数字 / 对象 → 显式拒绝）
  - `release-sql-audit` 词法边界固定回归（D1/D2/D3）：字符串字面量里的 `where` 不得洗白无条件 `UPDATE`；字面量里的 `--` / 块注释符号不得吞掉后续 `DROP TABLE` / `TRUNCATE`；字面量里的 `;` 不得错误切段把合法 `UPDATE` 判成缺 `WHERE`；单/双引号 / 反引号与转义、注释里的 `;`、字面量与真实分段混排均覆盖。每条在旧实现（三处各自全文正则 + 先剥注释再切分）上都会失败
  - `scope-validation`：`scope` 值域校验的三入口一致性（D2 回归）——`normalizeScope` 的缺省 / 合法 / 非法取值；四个聚合构建器（readiness / acceptance / release-checklist / delivery-gate）拒绝非法 `scope`；非法 `scope` 不再把「本节点就绪、子树未就绪」翻成 `ready=true`；MCP 由 `z.enum` 在协议层拒绝并返回 `isError`
  - `mindmap`：思维导图只读投影——`scope=self` 与 `subtree` 的节点 / 边 / 深度计数、`edges = nodes - 1` 恒等式；mermaid 首行与逐层 +2 空格缩进、顶层唯一、父先于子；标签转义（`"` / `&`，且 `&amp;` 不二次转义）、空名占位符；`maxDepth` 截断计数与 `maxDepth=0` 只保留根；非法 `maxDepth`（`''` / 负数 / 越界 / 非整数）一律 `VALIDATION_FAILED`；**纯读不产生 revision**；`renderMindmapMd` 渲染与 `TOOLS` 登记
  - `mindmap-entrypoints`：三入口 1:1——HTTP（JSON / md / 非法 scope / 非法 maxDepth / 非法 format）、CLI（单层命令可用 + 路径引用 + `--max-depth`）、MCP（JSON / md / `isError + VALIDATION_FAILED`），并断言同一节点同一 scope 的 mermaid 文本在三入口逐字节一致（覆盖原断点「帮助已列 `mindmap` 却报未知命令」）
  - `e2e-mainline`（`npm run e2e:mainline`）：**主链路端到端回归守门测试**——在独立进程 + 隔离 `TASKBOARD_HOME` 下运行 `scripts/e2e-mainline.mjs`，只走 CLI / HTTP 公开入口，串起需求管理 → 概要设计 → 文档 → 思维导图 → 可回归用例 → 测试/验收报告 → 验收签收 → 上线治理 → 交付门禁九段；关键断言是交付门禁的**两态**（无测试证据 `not_ready`、证据齐备 `ready`），避免把「只会返回 ready 的门禁」误判为通过；并抽查 HTTP 与 CLI 的 readiness / mindmap / delivery-gate 结论一致
  - `code-audit-rules`：代码检查规则引擎（纯函数）——每条规则的命中与不命中（冲突标记 vs markdown 分隔线、`.only` 仅测试文件、注释行不命中、凭据占位值 / 变量引用 / 比较表达式不命中）、**脱敏先于截断**（超长凭据不以明文残留在片段里）、**D1 回归：一行内所有凭据值及其所有出现位置都被掩码**（同值双凭据 / 不同值双凭据 / 同值多次出现 / 短值是长值前缀 / 占位值不误掩）、顶层三态优先级（danger → false / 截断与读取失败 → null / 干净 → true）、`byRule` 聚合
  - `code-audit`：`commitAddedLines` 的新增行与行号口径（修改 / 新增 / 删除文件 / 二进制 / 上下文行不误入）、`getNodeCodeAudit` 的命中 / 干净 / 单条读取失败不拖垮整体 / `scope=subtree` / **纯读不产生 revision**、markdown 表格单元格转义
  - `code-audit-entrypoints`：真实 CLI 子进程、HTTP 服务与 MCP 协议调用 `code_audit`，与 store 结果逐字段一致；非法 `scope` 在 CLI 报 `VALIDATION_FAILED`、在 MCP 返回 `isError`（不泄漏 SDK `-32602`）；**D1 回归：同一行两个凭据赋值（值相同）时 CLI JSON / CLI markdown / HTTP JSON / HTTP markdown / MCP 文本 / Web 消费的 `snippet` 六条输出通道均无明文**
  - `delivery-gate`：交付门禁汇总三段既有结论——空证据 `unknown`（不伪造成可交付）、需求就绪但测试未执行 `not_ready`、`not_run`/`running` 显式分桶与 blocker 明细、三段通过 / 不适用不阻塞 `ready`、必做上线项未完成覆盖测试通过结论、停用用例不参与门禁；`scope=subtree` 联动；阻塞项展平到条目级；`scope`/`format` 非法值三入口统一 `VALIDATION_FAILED`；markdown 单元格转义；**纯读聚合不产生 revision**；能力清单登记
  - `delivery-gate-mcp`：MCP 真实协议调用 `delivery_gate`（JSON / md / subtree）、非法 `scope`/`format` 返回 `isError + VALIDATION_FAILED`、与 store / HTTP / CLI 逐字段一致
  - `document-overview`：需求文档集中检索与缺口对账——核心槽位统计、关键词/文档名/fill 筛选、
    非法 fill、空项目范围；HTTP / CLI / MCP 与 store 逐字段一致；纯读不产生 revision
  - `requirement-management`：需求条目创建时自动关联核心文档、列表筛选与 KPI、文档缺口统计、
    受控状态流转（合法路径 / 非法跳转 / 取消恢复）、通用 `node.update` 不能绕过状态机；
    HTTP / CLI / MCP 三入口一致
  - `delivery-snapshot`：交付证据快照——冻结完整门禁 JSON 与 SHA-256 指纹、写入只 +1 revision、
    无改动时 `current`、源证据变化后 `drifted` 且不回改冻结结论、`scope=subtree` 与列表隔离、
    非法 scope / 不存在快照返回稳定错误码、节点删除级联清理；
    HTTP / CLI / MCP 三入口捕获 / 列表 / 单条读取全链路；MCP 写入操作者记录为 `mcp`（防审计身份被降级成 user）；
    Markdown 导出的标题 / 备注转义（反斜杠、竖线、CommonMark 全行结束符 LF/CRLF/CR）与注入防护；
    指纹只认证据集合：展示字段与时间戳审计元数据不触发漂移，节点 / 上线项改名与 no-op 重存保持 current，status/content 变化仍 drifted
  - `scope-validation`：`scope` 值域与聚合构建器横切校验；MCP 吃 `scope` 的全部工具（含 `node_diffs` / `node_tracks` / `commit_duplicates` / `release_check`）非法值均返回 `isError + VALIDATION_FAILED`，不泄漏 SDK `-32602`
  - `run-finalize`：**派单自动收尾**（`finalizeReportsForRun`）——按输出逐条结论回写 pass/fail、无结论→blocked、失败→error、超时/取消→cancelled、不覆盖人工终态、自动结论可被人工无 `overwrite` 改正、收尾只 +1 revision；**进程级**用真实 CLI 子进程验证 `test run` / `release check` 非 dry-run 收尾到终态并回写报告，`--no-wait` 保留只派单语义；边界（upsert 只传部分字段不清空其余、名称 trim 唯一性、大小写口径、`release check scope=subtree`）
  - `release-upsert-consistency`：**三入口语义对齐**——`release item upsert` 的「新建取默认值 / 已存在只更新显式字段」在 store / HTTP / CLI（真实子进程）/ MCP（in-memory 协议）逐一对齐；重点防「入口补默认值导致 rollback / status / required 被静默回退」，每条断言在旧实现（CLI / MCP 装配处补默认值）上都会失败
  - `snapshot`：数据快照覆盖口径——业务表集合 = 真实表 − 显式排除，**新增表自动进快照**（防未来加表回归）；导入顺序满足外键依赖（拓扑排序）；真实子进程跑 `export → import` 往返，断言 `test_cases` / `test_reports` / `release_items` / `comments` / `agent_runs` / `agent_run_messages` / `branch_configs` 不丢；**逐行关系断言** `nodes.parent_id` / `agent_runs.parent_run_id`（按名称/标题映射比对，不依赖 id），并单列「子 id < 父 id」「父 run 后创建」两条自引用回归用例（`NULL` 是合法外键值，只看行数与孤儿数测不出关系丢失）；revision 与文档正文原值恢复；v1 老快照导入给出缺表告警；非 `taskboard-snapshot` 格式被拒绝。变异验证：改回旧的 9 张硬编码清单挂 5 条；导入端改回「按 id 升序 + 边插边解析」挂 2 条自引用用例
- **API 集成测试**：临时数据库 + `fetch` 直连服务跑主流程与错误分支
- **CLI 集成测试**：`taskboard` 子命令建树 / upsert / batch / import / dry-run / `--confirm` 语义
- **MCP 冒烟**：以 stdio 拉起 MCP server，逐个工具调用并校验返回（含错误码）
- **并发验证**：Web 与 CLI 同时写同一库（WAL + busy_timeout）不报错，`/api/revision` 单调递增
- **冒烟脚本** `npm run smoke`：起服务 → 建五级树 → 建缺陷 → 改属性 + 写文档 → 上传图片 → 建临时 git 仓库（含冲突场景）→ diff 预览 → 合并预检 → mock GitLab 刷新 MR → 登记 commit → 断言树与详情
- **手工验收清单**：拖拽排序、移动节点、抽屉动态表单、表格 📄 数量点击 → 右侧文档渲染、文档新增/重命名/排序/删除、Markdown 编辑与预览、图片粘贴上传、缺陷登记与状态流转、commit 预览（统一 / 分栏 / 全文 + 子树聚合）、Markdown 含 mermaid 图渲染、工作区准备（多仓库建分支 + worktree）、开发提示词复制、冲突处理（逐块接受 / 拒绝 → 补丁可应用）、仓库登记、列显示设置、设置页连通性测试
