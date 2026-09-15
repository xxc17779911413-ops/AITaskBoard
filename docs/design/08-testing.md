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
  - `conflicts`：三方内容读取（base / ours / theirs）、resolve 最终内容 + `contentHash`、统一补丁可 `git apply`、可选写入 worktree 且路径越界防护、resolve 不改分支也不自动置 resolved
  - `conflicts` 回归（N6–N8）：内容行以 `-- ` / `++ ` 开头时补丁仍可 apply 且不写坏；worktree 内目标 / 父目录是符号链接时拒绝写入且外部文件不变；resolve 与目标一致时 `changed:false`、不产出空补丁
  - `merge-integration`：`merges` 状态机 CRUD 与 state 校验；真 git 下 `precheckMerge` **只读**（冲突时 `merge-tree` exit=1 也能解析出冲突文件，不改目标/源分支）；`runMerge` 无冲突 `merge --no-ff` 落 `merged` + `merge_sha`、重复调用幂等、成功后恢复发起前 HEAD；冲突落 `precheck_conflict` 且不改分支；缺 `confirm` / 分支缺失 / 非工作单元类型给稳定错误码
  - `merge-integration` 回归（N2–N4）：冲突清单按 `merge-tree --name-only -z` 的 NUL 分隔解析——`conflict.txt` / `ConflictPane.vue` / `Auto-merging.md` 前缀型命名不被误删，`中文.txt` 原样 UTF-8 落库；`merged`/`aborted` 行拒绝 `confirm`、未显式给 `mergeSha` 不拿 `target_sha` 冒充；从第三分支发起合并成功后 HEAD 恢复到原分支
  - `merge-integration` 回归（N5）：detached HEAD 发起合并时用 `rev-parse HEAD` 记录具体 sha、用 `symbolic-ref -q HEAD` 判定 detached；成功后 `checkout --detach <sha>` 恢复，`restoredHead` 报该 sha
  - `workspace-setup`：`unit_repos` CRUD（按 node × repo 幂等 / 只更新显式字段 / 级联删除 / 仅 `group`|`task` 可登记）；分支名与 worktree 路径渲染（`branchTemplate`，`slug` 空退回 `n{id}`）；真 git 下 `setupWorkspace` 建出同名分支 + worktree、**分支从基线当前 tip 派生**、重复调用幂等、`dryRun` 不碰 git 不落库不动 revision、基线不符 `BRANCH_EXISTS_DIFFERENT_BASE`、路径占用 `WORKTREE_PATH_EXISTS`、基线缺失 `BRANCH_NOT_FOUND`；`cleanupWorkspace` 需 confirm、移除 worktree、**未并入基线的分支必须保留**、重复调用幂等、一次操作只 +1 revision；三入口 1:1（HTTP / CLI / MCP）与逐字段一致；MCP `confirm` 缺失走 `isError + CONFIRM_REQUIRED` 不泄漏 `-32602`
  - `workspace-setup` 回归（D1–D5，均以旧实现验证必失败）：**基线不符时拒绝且零副作用、重试仍拒绝**（D1）；**分支并入 HEAD 但未并入基线时必须保留**、已并入基线但基线领先 HEAD 时正常删除（D2，**夹具强制 HEAD ≠ 基线**）；`--keep-branch` 真正保留分支 + 三入口 `removeBranch` 语义一致（D3）；dryRun 能探明路径占用与基线不符且仍零副作用（D4）；纯 no-op 重复 setup 不再 +1 revision（D5）
  - **夹具纪律**：凡「与 HEAD 状态相关」的用例，夹具必须让 HEAD 与声明基线停在不同提交。早期 `workspace-setup` 夹具让三者同 commit，`git branch -d` 与 `merge-base --is-ancestor <branch> <base>` 结论完全一致，使 D2 在 383 条全绿下漏网——**全绿不等于夹具有能力区分**
  - `unit`：分支命名规则（`{base_branch}-{slug}` 与 slug 兜底 `n{id}`）、建分支 / worktree 幂等、清理默认保留、开发提示词内容
  - `test-case`：测试用例 CRUD / 按名唯一与 upsert 幂等 / `kind` 筛选 / 启停 / 排序 / 级联删除；报告开启与终态回写 / 历史保留；验收报告聚合（最近结果 / 通过率 / 未执行口径 / `scope=subtree` / 空态）；编排层 `dryRun` 与提示词拼装
  - `cli-regression-loop`：真实 CLI 子进程跑参数契约（`--enabled` / `--run-id` / `--overwrite`）与错误码
  - 回归防护：每条缺陷修复都配一条「在旧实现上会失败」的 UT（`test-case.test.mjs` 缺陷 2/3/4、`http.test.mjs` 缺陷 1/2/3/5、`cli-regression-loop.test.mjs` 缺陷 5）
  - `release-item`：上线项 CRUD / 按名唯一与 upsert 幂等 / `kind` 与 `status` 筛选 / `includeOptional` / 排序 / 级联删除 / revision 语义；上线检查清单聚合（就绪结论 / 阻塞项 / 无必做项 `ready=null` / `scope=subtree` / `blocked` 与 `skipped` 计数）；编排层 `dryRun`（只挑 `code_check`/`biz_check`/`release_check` 用例、`caseIds` 过滤、`scope=subtree`）与 markdown 渲染
  - `readiness`：需求就绪门禁三条门禁各自独立判定（预置空文档不算通过 / 空白正文不算 / 停用用例与 `code_check` 不算可回归 / `acceptance` 算）；`scope=subtree` 汇总与逐单元结论、阻塞项；非需求类型 `scope=self` 拒绝并提示 `subtree`；**纯读聚合不产生 revision**；markdown 渲染
  - `scope-validation`：`scope` 值域校验的三入口一致性（D2 回归）——`normalizeScope` 的缺省 / 合法 / 非法取值；四个聚合构建器（readiness / acceptance / release-checklist / delivery-gate）拒绝非法 `scope`；非法 `scope` 不再把「本节点就绪、子树未就绪」翻成 `ready=true`；MCP 由 `z.enum` 在协议层拒绝并返回 `isError`
  - `mindmap`：思维导图只读投影——`scope=self` 与 `subtree` 的节点 / 边 / 深度计数、`edges = nodes - 1` 恒等式；mermaid 首行与逐层 +2 空格缩进、顶层唯一、父先于子；标签转义（`"` / `&`，且 `&amp;` 不二次转义）、空名占位符；`maxDepth` 截断计数与 `maxDepth=0` 只保留根；非法 `maxDepth`（`''` / 负数 / 越界 / 非整数）一律 `VALIDATION_FAILED`；**纯读不产生 revision**；`renderMindmapMd` 渲染与 `TOOLS` 登记
  - `mindmap-entrypoints`：三入口 1:1——HTTP（JSON / md / 非法 scope / 非法 maxDepth / 非法 format）、CLI（单层命令可用 + 路径引用 + `--max-depth`）、MCP（JSON / md / `isError + VALIDATION_FAILED`），并断言同一节点同一 scope 的 mermaid 文本在三入口逐字节一致（覆盖原断点「帮助已列 `mindmap` 却报未知命令」）
  - `e2e-mainline`（`npm run e2e:mainline`）：**主链路端到端回归守门测试**——在独立进程 + 隔离 `TASKBOARD_HOME` 下运行 `scripts/e2e-mainline.mjs`，只走 CLI / HTTP 公开入口，串起需求管理 → 概要设计 → 文档 → 思维导图 → 可回归用例 → 测试/验收报告 → 验收签收 → 上线治理 → 交付门禁九段；关键断言是交付门禁的**两态**（无测试证据 `not_ready`、证据齐备 `ready`），避免把「只会返回 ready 的门禁」误判为通过；并抽查 HTTP 与 CLI 的 readiness / mindmap / delivery-gate 结论一致
  - `delivery-gate`：交付门禁汇总三段既有结论——空证据 `unknown`（不伪造成可交付）、需求就绪但测试未执行 `not_ready`、`not_run`/`running` 显式分桶与 blocker 明细、三段通过 / 不适用不阻塞 `ready`、必做上线项未完成覆盖测试通过结论、停用用例不参与门禁；`scope=subtree` 联动；阻塞项展平到条目级；`scope`/`format` 非法值三入口统一 `VALIDATION_FAILED`；markdown 单元格转义；**纯读聚合不产生 revision**；能力清单登记
  - `delivery-gate-mcp`：MCP 真实协议调用 `delivery_gate`（JSON / md / subtree）、非法 `scope`/`format` 返回 `isError + VALIDATION_FAILED`、与 store / HTTP / CLI 逐字段一致
  - `requirement-management`：需求条目创建时自动关联核心文档、列表筛选与 KPI、文档缺口统计、
    受控状态流转（合法路径 / 非法跳转 / 取消恢复）、通用 `node.update` 不能绕过状态机；
    HTTP / CLI / MCP 三入口一致
  - `scope-validation`：`scope` 值域与聚合构建器横切校验；MCP 吃 `scope` 的全部工具（含 `node_diffs` / `node_tracks` / `commit_duplicates` / `release_check`）非法值均返回 `isError + VALIDATION_FAILED`，不泄漏 SDK `-32602`
  - `run-finalize`：**派单自动收尾**（`finalizeReportsForRun`）——按输出逐条结论回写 pass/fail、无结论→blocked、失败→error、超时/取消→cancelled、不覆盖人工终态、自动结论可被人工无 `overwrite` 改正、收尾只 +1 revision；**进程级**用真实 CLI 子进程验证 `test run` / `release check` 非 dry-run 收尾到终态并回写报告，`--no-wait` 保留只派单语义；边界（upsert 只传部分字段不清空其余、名称 trim 唯一性、大小写口径、`release check scope=subtree`）
  - `release-upsert-consistency`：**三入口语义对齐**——`release item upsert` 的「新建取默认值 / 已存在只更新显式字段」在 store / HTTP / CLI（真实子进程）/ MCP（in-memory 协议）逐一对齐；重点防「入口补默认值导致 rollback / status / required 被静默回退」，每条断言在旧实现（CLI / MCP 装配处补默认值）上都会失败
- **API 集成测试**：临时数据库 + `fetch` 直连服务跑主流程与错误分支
- **CLI 集成测试**：`taskboard` 子命令建树 / upsert / batch / import / dry-run / `--confirm` 语义
- **MCP 冒烟**：以 stdio 拉起 MCP server，逐个工具调用并校验返回（含错误码）
- **并发验证**：Web 与 CLI 同时写同一库（WAL + busy_timeout）不报错，`/api/revision` 单调递增
- **冒烟脚本** `npm run smoke`：起服务 → 建五级树 → 建缺陷 → 改属性 + 写文档 → 上传图片 → 建临时 git 仓库（含冲突场景）→ diff 预览 → 合并预检 → mock GitLab 刷新 MR → 登记 commit → 断言树与详情
- **手工验收清单**：拖拽排序、移动节点、抽屉动态表单、表格 📄 数量点击 → 右侧文档渲染、文档新增/重命名/排序/删除、Markdown 编辑与预览、图片粘贴上传、缺陷登记与状态流转、commit 预览（统一 / 分栏 / 全文 + 子树聚合）、Markdown 含 mermaid 图渲染、工作区准备（多仓库建分支 + worktree）、开发提示词复制、冲突处理（逐块接受 / 拒绝 → 补丁可应用）、仓库登记、列显示设置、设置页连通性测试
