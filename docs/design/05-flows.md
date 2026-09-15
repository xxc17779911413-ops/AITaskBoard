# 7. 关键流程

> 本文是主设计文档 [`../design.md`](../design.md) 的拆分章节；索引与章节导航见该文件。


### 7.1 建树

1. 工具条「新建项目」→ `POST /api/nodes {type:"project", name}`
2. 行悬浮「+」→ 按父节点类型推导子类型（project→requirement→subreq→group→task）→ 校验后创建；`task` / `group` 行还可选择「+ 添加缺陷」（`defect`）
3. 父子校验失败、或把节点移动到自身后代 → 400 并给出明确原因

### 7.2 属性编辑（右侧抽屉）

1. 点行 → 抽屉请求 `GET /api/nodes/:id`
2. 按节点 `type` 过滤 `attr_defs`（`enabled=1`，按 `sort`）渲染表单（text/textarea/number/date/select/url）；文档不在这里，见 §7.7
3. 保存 → `PATCH /api/nodes/:id { attrs: {key: value} }` → `store` 按 key 找 `attr_def_id` → upsert `attr_values`
4. 校验：`required` 不能为空；`number` 必须可解析为数字；`date` 必须为 `YYYY-MM-DD`；`select` 必须命中 options

### 7.3 MR 刷新

1. 前置：`config.gitlab.base_url` 与 `token` 已配置；节点为 `subreq`，且 `branch`、`gitlab_project` 属性非空
2. 调用：`GET {base_url}/api/v4/projects/{urlencode(project)}/merge_requests?source_branch={branch}&state=all&per_page=100`，带 `PRIVATE-TOKEN` 头；分页最多 3 页（300 条）
3. 映射：`iid` / `title` / `state` / `source_branch` / `web_url` / `updated_at`
4. 写入：按 `(node_id, project, iid)` upsert；本次未返回的既有记录**保留不删**，前端以「上次拉取时间」提示可能过期
5. 失败：未配置 → 400 + 引导；401 → 提示 token 无效；404 → 提示项目路径错误；网络异常 → 502；任何失败都不改动既有 MR 数据

### 7.4 commit 登记

1. 抽屉输入 `repo`（可选）/ `sha` / `note`
2. 校验 sha 为 7–40 位十六进制 → `INSERT OR IGNORE`（同节点同 sha 幂等）
3. 返回该节点最新 commits 列表

### 7.5 排序与移动

- **同级拖拽排序**：前端用 `sortablejs` 绑定表格行，`onMove` 限制同父同级；落库调 `POST /api/nodes/reorder { parentId, orderedIds }`
- **移动**：抽屉 / 行菜单「移动到…」选择目标父节点 → `PATCH /api/nodes/:id { parentId }`，校验目标父类型合法且不是自身后代

### 7.6 缺陷登记

1. 在 `task` / `group` 行的「+ 添加缺陷」或抽屉的子节点区选择「缺陷」→ `POST /api/nodes { parentId, type: "defect", name }`
2. 抽屉「文档」区填写预置文档「描述」「复现步骤」（Markdown 编辑器）；其余字段可在属性定义管理页扩展
3. 缺陷为叶子节点，接口拒绝在其下建子节点；状态流转沿用节点状态（可在设置页添加 `fixed` / `verified` 等状态码）
4. 缺陷与任务 / 任务组一样支持手工登记关联 commit（修复提交）

### 7.7 文档的打开、渲染与编辑

1. 表格「文档」列显示 📄 数量；点击该单元格 → 抽屉切到**文档区**并默认选中第一份文档
2. 文档区布局：左列文档名列表（＋新增、重命名、↑↓ 排序、删除），右侧为内容区（顶部「预览 / 编辑」切换；默认预览，点「编辑」进编辑器）
3. 新建节点时按 `docPresets` 自动创建空文档；AI 用 `POST /api/nodes/:id/documents/upsert` 按文档名 get-or-create 写入内容（幂等）
4. 保存：`PATCH /api/documents/:docId`；顺序：`POST /api/nodes/:id/documents/reorder`；删除需二次确认
5. 图片：粘贴或选择图片 → 前端用 Vditor 自定义 `upload.handler` 以 base64 JSON 调 `POST /api/uploads` → 存 `~/.taskboard/uploads/<时间戳>-<随机>.<ext>` → 返回 `/uploads/...`，编辑器把地址写入 markdown
6. 图片限制：仅 `png` / `jpg` / `jpeg` / `gif` / `webp`，单文件 ≤ 10 MB；超限或类型不符返回 400
7. 表格内与折叠态只展示文档名与数量，不渲染正文

### 7.8 启动

1. `npm start` → 读 `~/.taskboard/config.json`（不存在则生成默认值，权限 600）
2. 打开 / 初始化 `~/.taskboard/data.db`（建表 + 预置 attr_defs，幂等）
3. 监听端口（默认 3210；被占用则依次尝试 +1，最多到 3220，并在终端打印实际端口）
4. 自动打开浏览器（macOS `open`）；前端使用 Vite 构建产物，由后端静态托管

### 7.9 AI 操作流程（MCP / CLI）

1. AI 先 `schema` 发现节点类型、状态值域与属性定义（避免猜字段）
2. `tree --format md` 读取现状（缩进 markdown 树，直接可读）
3. 规划后写入：结构用 `import --format md` 一次落库，或 `batch` 执行多步；不确定的先 `--dry-run` 预演
4. 单点更新用 `node upsert --path ...`、`attr set`，重复调用安全（幂等）
5. 破坏性操作（删除 / 移动）必须带 `--confirm`
6. 写入后 `GET /api/revision` 递增，前端轮询自动刷新，无需人工刷新

**大纲导入格式**（`import --format md`）：

```text
- 项目A
  - 需求1
    - 子需求1
      - 任务组A
        - [task] 子任务1
          - 预估工时: 8
        - [defect] 登录报错
```

规则：缩进 2 空格；`- ` 列表项为一个节点；`[task]` / `[defect]` 必须显式标注，其余类型按层级推导（第 1 层项目 / 第 2 层需求 / 第 3 层子需求 / 第 4 层及更深为任务组）；节点下更深缩进的 `键: 值` 行为属性（匹配属性 `label` 或 `key`）；`#` 开头行忽略（便于 AI 写注释）；长文本用 `doc upsert`（按文档名写入正文）或 `batch` 写入。

### 7.10 工作区准备（建分支 / worktree + 开发提示词）

1. 在工作单元（`group` / `task`）抽屉选择**涉及仓库**（多选，写入 `unit_repos`），填 `slug`（可空）；`base_branch` 默认取**当前子需求分支**（如需基于其他分支可覆盖）
2. 「创建工作区」/ `unit setup`：
   - 分支名 = `config.branchTemplate` 渲染（默认 `{base_branch}-{slug}`；`slug` 为空时用 `n{id}`）
   - 逐仓库执行 `git worktree add <path> -b <branch> <base_branch>`：**分支从子需求分支派生**，即以创建时刻 `base_branch` 的最新提交为基；分支已存在则复用（基线不同则报 `BRANCH_EXISTS_DIFFERENT_BASE`）
   - worktree 路径：`config.worktreeRoot`（默认空 = 与主仓库同级）下 `<仓库目录名>-wt-<slug>`
   - 幂等：路径已存在且是同一分支 → 跳过；已占用且非本分支 → 409 `WORKTREE_PATH_EXISTS`
3. 回填工作单元属性 `branch` 与 `unit_repos.branch` / `worktree_path`
4. 返回**开发提示词**（可直接复制给 AI）：节点路径与 id、涉及仓库与工作区路径、工作分支与基线、该节点的文档清单、常用命令（`doc upsert` / `commit add` / `merge run`）、提交与合并约定
5. 清理：`unit cleanup`（移除 worktree、删除已并入集成分支的分支）；**合并后默认保留**工作区与分支，避免 Diff 入口消失；清理需 `confirm`

### 7.11 代码集成与合并（显式）

1. 工作单元（`group` / `task`）已填 `branch` / `base_branch` 并登记涉及仓库（见 §7.10）；即使未创建工作区，只要本地已存在该分支也可直接合并
2. 「合并回子需求分支」（抽屉按钮或 `merge run`）→ 对每个相关仓库执行 `git merge-tree --write-tree --name-only -z` 预检（内存三方合并，不碰工作区）
3. 预检无冲突 → 在本机仓库执行 `git merge --no-ff <source_branch>`（目标为集成分支；**不 push**）→ 写 `merges` 行（`state = merged` + `merge_sha`）
4. 预检有冲突 → 写 `merges` 行（`state = precheck_conflict` + 冲突文件），进入 §7.12
5. 冲突处理后 `merge confirm <mergeId>`（可显式带真实 `merge_sha`）置 `resolved`；放弃则 `merge abort <mergeId>` 置 `aborted`（不改分支）。已 `merged` 的尝试不可再 `confirm`
6. 全程只读 + 本地写；不 push、不动远端分支

### 7.12 冲突处理

1. `GET /api/merges/:mid/conflicts` 返回每个冲突文件的 base / ours / theirs 与冲突块
2. 工具内：`ConflictPane`（CodeMirror MergeView）逐块「保留当前 / 采用传入 / 手改」
3. 产出：合并后的文件内容 + unified 补丁；可复制 / 下载 / 写入对应仓库的 worktree（`unit_repos.worktree_path`，若已填）
4. AI：`conflict show` 读三方 → `conflict resolve` 写回合并结果（同一能力暴露给 MCP / CLI）
5. 本地应用完成后「确认合并完成」→ 回填 `merge_sha`，`merges.state = resolved`；也可生成「交给 IDE 的提示词」
6. 放弃则调 `abort` → `aborted`（不改任何分支）

### 7.13 commit 预览

1. 节点抽屉「提交」区列出该节点**与子树**的 commits（按 commit 分组、标注来源节点与仓库）
2. 点某个 commit 或文件 → `GET /api/commits/:cid/diff`（或 `GET /api/nodes/:id/diffs`）→ 文件列表 + 每文件 diff
3. 视图：统一 / 分栏 / 全文（CodeMirror，行级高亮 + 未变行折叠）
4. 仓库解析：`repos.local_path` → 本机 git；否则 `repos.gitlab_project` → GitLab API；都没有 → `REPO_NOT_REGISTERED`
