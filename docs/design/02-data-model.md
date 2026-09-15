# 4. 数据模型

> 本文是主设计文档 [`../design.md`](../design.md) 的拆分章节；索引与章节导航见该文件。


存储：SQLite（Node 内置 `node:sqlite`），开启 WAL 与外键；数据文件 `~/.taskboard/data.db`。

> **审计 actor 值域**：各表 `created_by` / `updated_by` 的允许值为
> `user`（Web）· `ai`（MCP 早期工具）· `mcp`（MCP 入口）· `cli`（命令行）· `import`（导入），
> 由 `store.mjs` 的 `ACTORS` 单点校验；**值域外的 actor 回退 `user`**（见 `test/store-revision.test.mjs`）。
> `ai` 与 `mcp` 都表示「AI 经 MCP 写入」，两个值都保留以免改写历史审计语义，新工具统一用 `mcp`。

### 4.1 nodes（节点，结构表）

| 字段 | 类型 | 说明 |
|---|---|---|
| id | INTEGER PK | |
| type | TEXT NOT NULL | `project` / `requirement` / `subreq` / `group` / `task` / `defect`（CHECK 约束） |
| parent_id | INTEGER NULL | 自引用 FK，`ON DELETE CASCADE`；`project` 为 NULL |
| name | TEXT NOT NULL | 显示名，必填，≤200 字符 |
| status | TEXT NOT NULL | 状态码，见 4.8 |
| sort | INTEGER NOT NULL | 同级排序，升序展示，默认取当前最大 +10 |
| created_at / updated_at | TEXT | ISO 时间 |
| created_by / updated_by | TEXT | 操作者：`user` / `ai` / `cli` / `import`（审计用） |

索引：`idx_nodes_parent(parent_id, sort)`。

名称 / 状态 / 排序保留在节点表（不进属性表）：树渲染、排序、筛选是高频操作，走属性表会导致每次列树都要联表。

### 4.2 attr_defs（属性定义，按节点类型扩展）

| 字段 | 类型 | 说明 |
|---|---|---|
| id | INTEGER PK | |
| node_type | TEXT NOT NULL | 所属节点类型 |
| key | TEXT NOT NULL | 稳定标识（同类型内唯一） |
| label | TEXT NOT NULL | 显示名 |
| data_type | TEXT NOT NULL | `text` / `textarea` / `number` / `date` / `select` / `url` |
| options | TEXT | `select` 的选项，JSON 数组 `[{value,label}]` |
| required | INTEGER NOT NULL DEFAULT 0 | 是否必填 |
| default_value | TEXT | 新建节点时的默认值 |
| sort | INTEGER NOT NULL | 表单/列展示顺序 |
| enabled | INTEGER NOT NULL DEFAULT 1 | 停用后不展示、不校验，历史值保留 |
| created_at / updated_at | TEXT | |

约束：`UNIQUE(node_type, key)`。新增属性 = 插入一行，表结构与前端都不需要改动。

属性只承载结构化短字段（含多行纯文本 `textarea`）；长文本 / 富文本一律用文档实体（见 §4.6），属性不再提供 markdown 类型。

### 4.3 attr_values（属性值，按节点）

| 字段 | 类型 | 说明 |
|---|---|---|
| id | INTEGER PK | |
| node_id | INTEGER NOT NULL | FK → nodes(id) ON DELETE CASCADE |
| attr_def_id | INTEGER NOT NULL | FK → attr_defs(id) ON DELETE CASCADE |
| value | TEXT | 统一以 TEXT 存储，读取按 `data_type` 解析 |
| updated_at | TEXT | |
| updated_by | TEXT | 操作者：`user` / `ai` / `cli` / `import` |

约束：`UNIQUE(node_id, attr_def_id)`。

排序 / 过滤：`number` 用 `CAST(value AS REAL)`，`date` 按 ISO 文本（`YYYY-MM-DD`）排序。

v1 中所有属性值均由用户编辑；系统自动写入的数据只有 MR 列表（见 4.5）。

### 4.4 commits（关联 commit，用户手工登记）

| 字段 | 类型 | 说明 |
|---|---|---|
| id | INTEGER PK | |
| node_id | INTEGER NOT NULL | FK → nodes(id) ON DELETE CASCADE |
| repo | TEXT | 仓库名，可空 |
| sha | TEXT NOT NULL | 7–40 位十六进制 |
| note | TEXT | 说明，可空 |
| created_at | TEXT | |

约束：`UNIQUE(node_id, sha)`（同节点重复登记幂等）。挂载对象：`group` / `task` / `defect`。

`repo` 为仓库名，需与 `repos.name` 对应（见 §4.7）；未登记时预览 / 合并报 400 `REPO_NOT_REGISTERED`。

### 4.5 mrs（自动拉取的 MR，系统写入）

| 字段 | 类型 | 说明 |
|---|---|---|
| id | INTEGER PK | |
| node_id | INTEGER NOT NULL | FK → nodes(id) ON DELETE CASCADE |
| project | TEXT NOT NULL | GitLab 项目路径，如 `charging/xp-charge` |
| iid | INTEGER NOT NULL | 项目内 MR 序号 |
| title | TEXT | |
| state | TEXT | `opened` / `merged` / `closed` / `locked` |
| source_branch | TEXT | |
| web_url | TEXT | |
| updated_at | TEXT | 来自 GitLab |
| fetched_at | TEXT | 本地拉取时间 |

约束：`UNIQUE(node_id, project, iid)`。挂载对象：`subreq`。

### 4.6 documents（节点文档，可多份）

| 字段 | 类型 | 说明 |
|---|---|---|
| id | INTEGER PK | |
| node_id | INTEGER NOT NULL | FK → nodes(id) ON DELETE CASCADE |
| name | TEXT NOT NULL | 文档名（自由文本，不做枚举约束；同节点内唯一） |
| content | TEXT | markdown 正文 |
| sort | INTEGER NOT NULL | 展示顺序 |
| created_at / updated_at | TEXT | |
| created_by / updated_by | TEXT | 操作者：`user` / `ai` / `cli` / `import` |

约束：`UNIQUE(node_id, name)`；索引 `idx_documents_node(node_id, sort)`。

预置文档名（新建节点时自动创建空文档，可在 `config.json` 的 `docPresets` 覆盖）：

| node_type | 预置文档名 |
|---|---|
| project | 描述 |
| requirement | 需求内容 |
| subreq | 需求内容 |
| group | 无 |
| task | 无 |
| defect | 描述、复现步骤 |

文档重名返回 409 `DOC_NAME_EXISTS`；UI 新增文档时自动加序号规避（新文档 / 新文档2…）。

### 4.6.1 document_versions（文档历史，不可变快照）

| 字段 | 类型 | 说明 |
|---|---|---|
| id | INTEGER PK | |
| document_id | INTEGER NOT NULL | FK → documents(id) ON DELETE CASCADE |
| name | TEXT NOT NULL | 当时的文档名 |
| content | TEXT NOT NULL | 当时的 markdown 正文 |
| reason | TEXT NOT NULL | `create` / `update` / `restore` / `migrated` |
| created_at | TEXT NOT NULL | 快照时间 |
| created_by | TEXT NOT NULL | 操作者 |

索引：`idx_document_versions_doc(document_id, id)`。

规则：创建 / 更新 / 恢复自动追加快照；恢复不改写历史，而是再追加一条 `restore`；老库首次打开为已有文档回填一条 `migrated` 基线。恢复旧名称撞到现存文档时仍返回 `DOC_NAME_EXISTS`。

### 4.7 repos（仓库登记）

| 字段 | 类型 | 说明 |
|---|---|---|
| id | INTEGER PK | |
| name | TEXT NOT NULL | 仓库名（`commits.repo` 引用它，同时作为显示名） |
| local_path | TEXT | 本地仓库绝对路径（diff / 合并 / 冲突预检用） |
| gitlab_project | TEXT | GitLab 项目路径（如 `charging/xp-charge`；本地缺失时兜底读取） |
| note | TEXT | 备注 |
| created_at / updated_at | TEXT | |

约束：`UNIQUE(name)`。读取优先级：`local_path` 存在 → 本机 git；否则用 `gitlab_project` 调 GitLab API；两者都无 → 400 `REPO_NOT_REGISTERED`。

### 4.8 状态值域

默认枚举（可在 config 覆盖标签与可用集合）：

| 码 | 标签 |
|---|---|
| `todo` | 待开始 |
| `doing` | 进行中 |
| `testing` | 提测中 |
| `done` | 已完成 |
| `cancelled` | 已取消 |

每类节点默认可用集合：

- `project`：todo / doing / done
- `requirement`：全部五项
- `subreq`：todo / doing / done
- `group`：todo / doing / done
- `task`：todo / doing / done
- `defect`：todo / doing / done / cancelled

状态码是配置驱动的：如需为缺陷增加「已修复 `fixed` / 已验证 `verified`」等，只需在设置页（config）添加，无需改表。

### 4.9 预置属性定义

| node_type | key | label | data_type | required |
|---|---|---|---|---|
| requirement | start_date | 开始时间 | date | 否 |
| requirement | end_date | 结束时间 | date | 否 |
| requirement | review_date | 需求评审时间 | date | 否 |
| requirement | design_review_date | 概设评审时间 | date | 否 |
| requirement | test_submit_date | 提测时间 | date | 否 |
| requirement | estimate_hours | 预估工时 | number | 否 |
| subreq | branch | 分支 | text | 否 |
| subreq | baseline | 基线 | text | 否 |
| subreq | gitlab_project | GitLab 项目 | text | 否 |
| group | slug | 英文短名 | text | 否 |
| group | branch | 分支 | text | 否 |
| group | base_branch | 基线分支 | text | 否 |
| task | slug | 英文短名 | text | 否 |
| task | branch | 分支 | text | 否 |
| task | base_branch | 基线分支 | text | 否 |

`gitlab_project` 非必填；点「刷新 MR」时若该属性或「分支」为空，接口返回提示要求先补填。

`defect` 无预置属性（缺陷的「描述」「复现步骤」是**文档**，见 §4.6）；`group` / `task` 预置 `slug` / `branch` / `base_branch`（工作区与代码集成用，见 §7.10 / §7.11）。后续要加「严重程度 / 发现版本 / 负责人 / 优先级 / 标签」等，只插入 `attr_defs`（或在属性定义管理页添加）即可。

### 4.10 config（本机配置文件）

路径 `~/.taskboard/config.json`，权限 `600`：

```json
{
  "port": 3210,
  "gitlab": { "base_url": "", "token": "" },
  "docPresets": { "project": ["描述"], "requirement": ["需求内容"], "subreq": ["需求内容"], "group": [], "task": [], "defect": ["描述", "复现步骤"] },
  "readiness": { "requirementDoc": "需求内容", "designDoc": "概要设计", "caseKinds": ["regression", "acceptance"] },
  "worktreeRoot": "",
  "branchTemplate": "{base_branch}-{slug}",
  "status": {
    "labels": { "todo": "待开始", "doing": "进行中", "testing": "提测中", "done": "已完成", "cancelled": "已取消" },
    "allowed": { "project": ["todo", "doing", "done"], "requirement": ["todo", "doing", "testing", "done", "cancelled"], "subreq": ["todo", "doing", "done"], "group": ["todo", "doing", "done"], "task": ["todo", "doing", "done"], "defect": ["todo", "doing", "done", "cancelled"] }
  }
}
```

约束：token 只存本机文件，不写库、不进 git；接口返回时打码。

`readiness` 是**需求就绪门禁**的口径（见 §4.16）：文档名与「视为可回归」的用例类型都是值域，
团队改用「详细设计」等命名时只改配置、不改代码。

### 4.11 merges（合并尝试与冲突）

| 字段 | 类型 | 说明 |
|---|---|---|
| id | INTEGER PK | |
| node_id | INTEGER NOT NULL | 工作单元（`group` / `task`）的节点 id |
| repo | TEXT NOT NULL | 仓库名（对应 `repos.name`） |
| source_branch | TEXT NOT NULL | 工作单元分支 |
| target_branch | TEXT NOT NULL | 集成分支（子需求 `branch`） |
| base_sha / source_sha / target_sha | TEXT | 预检时的三方 sha |
| state | TEXT NOT NULL | `precheck_conflict` / `merged` / `resolved` / `aborted` |
| merge_sha | TEXT | 实际合并产生的 commit sha |
| conflict_files | TEXT | 冲突文件清单（JSON 字符串数组） |
| resolved_files | TEXT | 冲突处理结果（JSON：[{path, content, contentHash, wroteWorktree}]） |
| created_at / updated_at | TEXT | |
| created_by / updated_by | TEXT | 操作者：`user` / `ai` / `cli` / `import` |

约束：一次「合并回集成分支」按仓库各产生一行；`state = precheck_conflict` 的行即待处理冲突，处理完成后置 `resolved` 并回填 `merge_sha`。
成功合并置 `merged`；显式放弃置 `aborted`。`conflict_files` 存 `merge-tree` 解出的文件路径数组（JSON）。

### 4.12 unit_repos（工作单元 × 仓库）

| 字段 | 类型 | 说明 |
|---|---|---|
| id | INTEGER PK | |
| node_id | INTEGER NOT NULL | 工作单元（`group` / `task`）的节点 id |
| repo_id | INTEGER NOT NULL | FK → repos(id) |
| branch | TEXT | 该仓库上的工作单元分支（默认 `{base_branch}-{slug}`，多仓库同名） |
| worktree_path | TEXT | 该仓库的 worktree 本地路径（工具创建后回填） |
| created_at / updated_at | TEXT | |

约束：`UNIQUE(node_id, repo_id)`。一个工作单元可覆盖多个仓库（同一条分支名），`worktree_path` 是「工作区状态」的唯一来源。

### 4.13 agent_runtimes / agent_sessions / agent_runs / agent_run_messages（agent 运行时与任务）

对齐 multica 的三层模型：**运行时（机器级执行环境）→ 会话（可续跑的连续对话）→ 任务（一次执行）**，
任务之上再挂一层**消息流**（事件流，按 seq 增量拉取）。旧版只有一张扁平的 `agent_runs` 表，
无法回答「这次跑的是哪台机器 / 哪个 CLI 实例」「上次的 CLI 会话能不能续跑」「同一个节点的多次派单是不是同一段对话」。

**agent_runtimes（运行时）**

| 字段 | 类型 | 说明 |
|---|---|---|
| id | INTEGER PK | |
| name | TEXT NOT NULL | 显示名，如 `MacBook-Pro · qodercli` |
| daemon_id | TEXT | daemon 标识（本机服务用主机名） |
| runtime_mode | TEXT NOT NULL | `local` / `cloud` |
| provider | TEXT NOT NULL | 具体 CLI：`qodercli` / `echo` / … |
| status | TEXT NOT NULL | `online` / `offline`（心跳驱动） |
| device_info | TEXT | 设备信息，如 `MacBook-Pro · darwin-arm64` |
| visibility | TEXT NOT NULL | `private`（仅 owner 可用）/ `public`（工作区共享） |
| metadata | TEXT | JSON，登记时的附加信息（pid / node 版本等） |
| last_seen_at | TEXT | 最近心跳时间；超阈值读时降级为 offline |
| created_at / updated_at / created_by | TEXT | |

约束：`UNIQUE(daemon_id, provider)` —— 一台机器上一个 CLI 实例只有一行（upsert 幂等）。
index：`idx_agent_runtimes_status(status)`。

**agent_sessions（会话）**

| 字段 | 类型 | 说明 |
|---|---|---|
| id | INTEGER PK | |
| node_id | INTEGER NOT NULL | FK → nodes(id) ON DELETE CASCADE |
| agent | TEXT NOT NULL | 该会话绑定的 CLI |
| runtime_id | INTEGER NULL | FK → agent_runtimes(id) ON DELETE SET NULL |
| title | TEXT | 会话标题（可空） |
| cli_session_id | TEXT | CLI 自己的会话号（qodercli 的 `--resume <id>`），任务结束后沉淀 |
| work_dir | TEXT | 会话工作目录（任务结束后沉淀） |
| status | TEXT NOT NULL | `active` / `archived` |
| run_count | INTEGER NOT NULL | 会话内任务数 |
| last_activity_at | TEXT | 最近活动时间（列表排序用） |
| created_at / created_by | TEXT | |

index：`idx_agent_sessions_node(node_id)`、`idx_agent_sessions_activity(status, last_activity_at)`。
取/建活动会话是幂等的：`ensureAgentSession` 复用该 `(node, agent)` 最新的 active 会话。

**agent_runs（任务 / 队列条目）**

| 字段 | 类型 | 说明 |
|---|---|---|
| id | INTEGER PK | |
| node_id | INTEGER NOT NULL | FK → nodes(id) ON DELETE CASCADE |
| session_id | INTEGER NULL | FK → agent_sessions(id) ON DELETE SET NULL |
| runtime_id | INTEGER NULL | FK → agent_runtimes(id) ON DELETE SET NULL |
| agent / model | TEXT | 执行者与模型 |
| prompt | TEXT NOT NULL | 提示词 |
| cwd | TEXT | 执行目录（缺省从节点子树内已登记仓库推导） |
| status | TEXT | `running` / `success` / `failed` / `timeout` / `cancelled` |
| output | TEXT | 合并输出（限 200KB，兼容旧读取方式） |
| exit_code | INTEGER | 子进程退出码 |
| attempt / max_attempts | INTEGER | 第几次尝试 / 重试硬上限（缺省 3，含首次执行；用满后重试被 `VALIDATION_FAILED` 拒绝，沿重试链继承） |
| parent_run_id | INTEGER NULL | FK → agent_runs(id) ON DELETE SET NULL，重试链回指 |
| failure_reason | TEXT | 失败分类（`timeout` / `runtime_recovery` / `agent_error.*` …） |
| cli_session_id / work_dir | TEXT | 本次任务落定的 CLI 会话号 / 工作目录（回填到 session） |
| priority | INTEGER | 队列优先级 |
| resumed | INTEGER | 是否续跑（`--resume`） |
| wait_reason | TEXT | 等待原因（预留：如工作目录被占用） |
| started_at / finished_at / created_by | TEXT | |

index：`idx_agent_runs_node(node_id)`、`idx_agent_runs_session(session_id, id)`。

**agent_run_messages（任务消息流）**

| 字段 | 类型 | 说明 |
|---|---|---|
| id | INTEGER PK | |
| run_id | INTEGER NOT NULL | FK → agent_runs(id) ON DELETE CASCADE |
| seq | INTEGER NOT NULL | 任务内自增序号（服务端生成，保证顺序稳定） |
| type | TEXT NOT NULL | `text` / `tool_use` / `tool_result` / `thinking` / `error` |
| tool | TEXT | `type=tool_use` 时的工具名 |
| content / output | TEXT | 消息正文 / 工具输出 |
| input | TEXT | 工具入参（JSON 字符串） |
| created_at | TEXT | |

约束：`UNIQUE(run_id, seq)`；index：`idx_agent_run_messages_run(run_id, seq)`。
有了 seq，UI 只需按 `sinceSeq` 增量拉取，而不是每次把整块 output 重读一遍。

### 4.14 test_cases / test_reports（回归测试闭环）

打通「需求 → 概要设计/文档 → AI 可回归测试 → 测试/验收报告」的后两段。
需求与设计由节点树与 `documents` 承载；本组表补齐**可被 AI 重复执行的测试指令**与**每次执行的结果**。

**test_cases（测试用例）**

| 字段 | 类型 | 说明 |
|---|---|---|
| id | INTEGER PK | |
| node_id | INTEGER NOT NULL | FK → nodes(id) ON DELETE CASCADE；可挂任意节点类型 |
| name | TEXT NOT NULL | 用例名（同节点内唯一） |
| kind | TEXT NOT NULL | `regression` / `acceptance` / `code_check` / `biz_check` / `release_check`（CHECK 约束） |
| prompt | TEXT NOT NULL | 给 AI 的执行指令（回归/验收步骤） |
| expectation | TEXT | 期望结果（可空） |
| enabled | INTEGER NOT NULL DEFAULT 1 | 停用后不参与 `test_run` 默认选用 |
| sort | INTEGER NOT NULL | 展示 / 执行顺序 |
| created_at / updated_at | TEXT | |
| created_by / updated_by | TEXT | 操作者（user / ai / cli / import / mcp） |

约束：`UNIQUE(node_id, name)`；index：`idx_test_cases_node(node_id, sort, id)`。
`kind` 是**统一扩展轴**：上线配置 / 上线 SQL / 代码检查 / 业务检查先以 `release_check` / `code_check` / `biz_check`
作为分类值落地，后续接入专用执行器时**无需改表**。

**test_reports（测试 / 验收报告）**

| 字段 | 类型 | 说明 |
|---|---|---|
| id | INTEGER PK | |
| node_id | INTEGER NOT NULL | FK → nodes(id) ON DELETE CASCADE |
| case_id | INTEGER NULL | FK → test_cases(id) ON DELETE SET NULL；删用例后历史报告保留 |
| run_id | INTEGER NULL | FK → agent_runs(id) ON DELETE SET NULL；关联本次执行日志 |
| kind | TEXT NOT NULL | 与用例 kind 对齐（同 CHECK 值域） |
| status | TEXT NOT NULL | `running` / `pass` / `fail` / `blocked` / `error` / `cancelled` |
| summary / detail | TEXT | 结论摘要 / 详细依据 |
| auto_finalized | INTEGER NOT NULL DEFAULT 0 | 1 = 该终态由 agent 任务的终态**自动收尾**得出（机器兜底，人工无需 `overwrite` 即可改正；人工回写后清零） |
| started_at / finished_at / updated_at | TEXT | |
| created_by | TEXT | 操作者 |

约束：一次执行 = 一行；`case_id` 必须与 `node_id` 同节点，`run_id` 必须指向存在的 agent 任务（应用层校验）；
index：`idx_test_reports_node(node_id, id)`、`idx_test_reports_case(case_id, id)`。

**状态机**（应用层强制，见 `features/regression-loop/design.md` R5）：`running → 终态` 单向；
终态重复提交**同状态**幂等（只更新摘要、不改 `finished_at`）；终态互转 / 回退 `running` 默认拒绝
（`REPORT_STATUS_IMMUTABLE`，409），需显式 `overwrite:true` 才覆盖。非法 `status` 由应用层拦成
`VALIDATION_FAILED`，不落到 DB CHECK（避免泄漏 `ERR_SQLITE_ERROR`）。
`auto_finalized=1` 的终态是例外：它只是派单后的机器兜底，人工可以直接改正而无需 `overwrite`。

**派单自动收尾**：任务落终态时 `finalizeReportsForRun` 扫该 run 下仍 `running` 的报告并收尾，
优先解析 agent 输出里的 `用例名: PASS|FAIL|BLOCKED - 依据`；解析不到时按 run 终态回落
（`success → blocked`，**不**伪造成 `pass`）。收尾不覆盖人工结论，并与任务收尾合并为一次 revision 递增。

**验收报告**不落表，由 `buildAcceptanceReport` 按节点（`self` / `subtree`）聚合每个用例的**最近一次**结果。
只聚合 `enabled=1` 的用例；停用用例不进入门禁（与需求就绪门禁「启用中的可回归用例」口径一致）。

**acceptance_signoffs（验收签收）**

| 字段 | 类型 | 说明 |
|---|---|---|
| id | INTEGER PK | |
| node_id | INTEGER NOT NULL | FK → nodes(id) ON DELETE CASCADE |
| scope | TEXT NOT NULL | `self` / `subtree` |
| decision | TEXT NOT NULL | `accepted` / `rejected` |
| comment | TEXT | 验收意见 / 驳回原因 |
| evidence_fingerprint | TEXT NOT NULL | 签收时验收报告的 sha256 指纹 |
| signed_by / signed_at | TEXT | 签收人 / 时间 |
| created_at / updated_at | TEXT | |

约束：`UNIQUE(node_id, scope)`；index：`idx_acceptance_signoffs_node(node_id, scope)`。
签收绑定证据指纹：用例、执行指令、期望或最近报告结论一旦变化，既有签收自动视为 `stale`，交付门禁重新阻塞；
指纹按稳定 `caseId` 排序构造 canonical 集合，仅调整展示顺序不会失效。
分桶总数守恒：`pass + fail + blocked + error + cancelled + running + notRun = cases`；
`running`（已派单未回写）与 `notRun`（从未派单）都不计入通过率分母，
通过率 = `pass / settled`（`settled` = 五种终态之和），无完结时 `passRate = null`。

### 4.15 release_items（上线清单：上线配置 / 上线 SQL / 上线检查项）

补齐「需求 → 概要设计/文档 → 回归测试 → 上线治理」的最后一段：把上线要做的**配置变更 / SQL / 检查项**
结构化成清单，并为「上线就绪」提供一个可查询的确定结论。

| 字段 | 类型 | 说明 |
|---|---|---|
| id | INTEGER PK | |
| node_id | INTEGER NOT NULL | FK → nodes(id) ON DELETE CASCADE；可挂任意节点类型 |
| name | TEXT NOT NULL | 上线项名（同节点内唯一） |
| kind | TEXT NOT NULL | `config`（上线配置）/ `sql`（上线 SQL）/ `check`（上线检查）（CHECK 约束） |
| content | TEXT NOT NULL DEFAULT '' | 上线内容（SQL 正文 / 开关项 / 检查说明） |
| rollback | TEXT | 回滚方案（可空） |
| status | TEXT NOT NULL | `pending` / `ready` / `done` / `blocked` / `skipped`（CHECK 约束） |
| required | INTEGER NOT NULL DEFAULT 1 | 是否必做；只有必做项参与「就绪」判定 |
| sort | INTEGER NOT NULL | 展示 / 执行顺序 |
| created_at / updated_at | TEXT | |
| created_by / updated_by | TEXT | 操作者（user / ai / cli / import / mcp） |

约束：`UNIQUE(node_id, name)`；index：`idx_release_items_node(node_id, sort, id)`。

**上线检查清单**不落表，由 `buildReleaseChecklist` 按节点（`self` / `subtree`）聚合：
完成度 + 按类型分布 + 就绪结论 `ready` + 阻塞项 `blockers`。
只有必做项全部落在 `done` / `skipped` 才 `ready=true`；**无必做项时 `ready=null`**
（与验收报告 `passRate=null` 同口径，避免「没有项 = 未就绪」误判）。

**执行语义复用 `test_cases` 的 kind 扩展轴**：`code_check` / `biz_check` / `release_check` 三类用例
经 `runReleaseChecks` 拼提示词派单给 agent（复用 agent 运行时），与 `release_items` 的清单一起进上线单；
上线 SQL / 配置的**真正执行**不在本工具内，本表只做登记与检查。

### 4.16 需求就绪门禁（需求管理闭环的前置判定，不落表）

闭环后半段已有结论：验收报告（测完没有）、上线清单（能不能上线）。本节补**起点判定**——
一份需求进入回归测试前，需求内容 / 概要设计 / 可回归用例是否齐备。

门禁**不建表**：它从既有数据推导结论（文档在不在、用例有没有），落库会造成两处真相并需同步维护。
由 `buildRequirementReadiness(nodeId, { scope })` 纯读聚合，**不写库、不动 revision**
（与 `buildAcceptanceReport` 不落表同一条设计原则）。

| 门禁 | 判定依据 | 口径 |
|---|---|---|
| 需求内容文档 | 节点下存在 `config.readiness.requirementDoc` 同名文档 | **存在 ≠ 写完**：`createNode` 会预置空白文档，必须 `content.trim()` 非空才通过 |
| 概要设计文档 | 节点下存在 `config.readiness.designDoc` 同名文档 | 同上，正文非空白才通过 |
| 可回归测试用例 | 节点下存在 ≥1 条启用中的用例，`kind ∈ config.readiness.caseKinds` | 默认 `regression` / `acceptance`；停用用例与 `code_check` 等不算 |

判定单元只有 `requirement` / `subreq` 两类（项目不承载需求正文，任务组 / 子任务 / 缺陷是拆分产物）；
`scope=subtree` 在子树里挑出这两类逐单元判定。结论口径：全部单元就绪 → `ready=true`，
任一未就绪 → `false`，**无待判定需求 → `null`**（不用 `false` 冒充未就绪）。
