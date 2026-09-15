# 设计 · 审批合并

## 数据

- `commits.branch`：开发分支（登记时自动推断或显式传入）
- `subreq.attrs.reqBranch`：需求分支（必填，如 feature-send-receive）

## 后端

**git.mjs**
- `pickBranchForCommit(dir, sha)`：`branch -a --contains` → `git log -1 --format=%s` 取 subject，按序判定：
  1. **GitHub PR merge**（`Merge pull request #12 from org/feature-login-1.1.1`）→ 归属 subject 里的源分支。
     源分支是 merge 提交的祖先，不在 `branch --contains` 结果里，因此以 subject 为准直接返回。
  2. **经典 merge**（`Merge branch 'x' into feature-merge`）→ 归属其合入目标分支 `feature-merge`。
  3. **普通提交** → 排除 `feature-merge` 后，优先分支名与 subject 中需求编号（如 `3.1.1`）**按版本号边界**
     匹配的 `feature-*`，其次最具体的 `feature-*`。

  两个易错点：① 需求编号必须按版本号边界匹配，`includes('1.1.1')` 会命中 `11.1.1`，命中多条又按长度取最长，
     正好挑中最长的集成分支——与本函数要修的问题同类；用 `(^|[^\d.])1\.1\.1([^\d.]|$)` 语义的边界正则替代。
  ② 仅按长度取最长会把长命集成分支（如 `feature-transfer-3.4.1-material-apply-id-fix`）误判成开发分支。

  **约束（squash merge）**：GitHub「Squash and merge」把多个提交压成一条普通提交，subject 里不再有 merge
  元数据、也不带源分支名，无法可靠推断归属——只能退化为需求编号边界匹配 / 最长 `feature-*`。走 squash
  流程时请在登记 commit 时**显式传 `branch`**（HTTP/MCP `branch` 参数、CLI `commit add --branch`）；
  显式传入视为纠正（`overwriteBranch`），可覆盖已有值。
- `mergeBranch(dir, source, target, message)`：
  1. `status --porcelain` 检查未解决冲突（UU|AA|DD|AU|UA|DU|UD）→ 有则 `{conflict:true, reason:'unresolved_conflicts'}`
  2. `merge-base --is-ancestor source target` → 是则 `{alreadyMerged:true}`
  3. `checkout target` → 失败 `{reason:'checkout_failed'}`
  4. `merge --no-ff source -m msg` → 成功 `{ok, mergeSha}`；失败按 CONFLICT 判别 `merge_conflict` / `merge_failed`

**ops.mjs**
- `approveAndMerge(store, nodeRef)`：`findAncestorOfType(task,'subreq')` → `reqBranch` →
  `listCommits(node,{subtree})` 按 (repo,branch) 去重 → 逐仓库 `mergeBranch` → 汇总 results
- `getMergeStatus(store, nodeRef)`：子树各 task 的 (repo,branch) → `branchContains(dir, branch, reqBranch)`
  → `{items:[{nodeId,name,allMerged,details}], mergedCount, total, reqBranch}`

**http.mjs**
- `POST /api/nodes/:id/merge` → approveAndMerge
- `GET /api/nodes/:id/merge-status` → getMergeStatus

## 插件

- `TaskBoardApi.mergeNode/mergeStatus`
- `markApproved()`：issue 拦截 → 后台 merge → 成功才 `markChecked("approved", null)`；
  失败/冲突弹「无法标记通过」+ 明细
- 「合入状态」按钮：弹窗（需求分支 / 已合入 N/M / 逐任务 ✓✗ 逐分支明细）

## MR 式合并预览与分支展示（已交付）

- **需求分支展示**：进节点时状态栏显示 `【4.1】xxx　🌿 需求分支：feature-transfer`
  （`findReqBranch`：沿父链找 subreq.attrs.reqBranch）
- **合并预览**（「合并预览」按钮）：对每个待合并 (repo, source→target)：
  - 已合入 → `✓ …（已合入，无需合并）`
  - `git diff --stat <target>...<source>` → 将引入的变更文件与 +/- 统计
  - `git merge-tree --write-tree <target> <source>` → **冲突预判**（⚠ 冲突文件清单）
  - 越权/无本地路径 → ✗ 原因
  - API：`POST /api/nodes/:id/merge-preview`（ops.previewMerges / git.previewMerge）

## 上跳合并：子需求 → feature-merge（已交付）

两跳合并链：**子任务 → 子需求分支（reqBranch）→ feature-merge**。

- **入口**：子需求节点 Review →「**合并到 feature-merge**」按钮
- **行为**（`ops.mergeUpstream`）：source = subreq.reqBranch，target = feature-merge（可传参覆盖）
  - 收集子树提交涉及的仓库 → 逐仓库 `mergeBranch(source, target)`
  - **已合入 → 跳过**；**有新内容 → 再 merge**（增量重复合）
  - 冲突/失败 → 弹窗报明细
- **API**：`POST /api/nodes/:id/merge-upstream { targetBranch? }`（默认 feature-merge）
- **实测**（子需求 119）：2 仓库"已合入跳过"（xp-thor-project/xp-thor-par-construction）+
  1 仓库有新内容实合并（xp-thor-mgnt，mergeSha f4afa21c）——正是"增量再合"行为

## 子需求 Review 的需求分支视角（已交付）

- 进子需求节点 → 提交列表带 **`mergedToReq`**（是否已合入需求分支；优先 subreq.reqBranch，回退 demandBranch）
- **状态栏**：`【3】… 🌿 需求分支：feature-send-receive　⚠ 未合并 3`（或 `✓ 全部已合入`）
- **列表项**：未合并的提交前缀 **`⚠未合并`**（`CommitItem.display()`）
- API：`GET /api/nodes/:id/tracks?scope=subtree&branches=true` → commit 级 `mergedToReq`

## 分支组层（已交付）

按 dsh-charge 三层架构对齐：**分支组 → 子需求 → 子任务**。

```
【平台】立项工程&资产管理26Q3迭代（requirement）
 ├── feature-send-receive 🌿（group + attrs.branch）→ 1 / 2 / 3 子需求
 ├── feature-transfer 🌿                              → 4 / 5 / 6 子需求
 └── feature-station-operation 🌿                     → 7 子需求
```

- **双击分支组** → 该分支视角的提交列表（子树全部提交 + `mergedToReq` 标记 + 状态栏「⚠ 未合并 N」）
- 需求分支取值优先级：**① 节点自身 `branch`（分支组）② `subreq.reqBranch` ③ `requirement.demandBranch`**
- CHILD_TYPES 放开：`requirement → [group, subreq]`、`group → [group, subreq, task, defect]`
- 实测：分支组 158（feature-send-receive）→ 64 条提交 / 未合并 15

## 性能优化（分支组视图 20.7s → 0.6s，33 倍）

- **问题**：64 条提交 × (is-ancestor × 1 + commitTrack × 3) ≈ 256 次 git 进程
- **修复**：
  1. **分支标注批量化**：每仓库一次 `git log <需求分支> --format=%H` → Set(sha)，
     提交用**前缀匹配**（登记可能是短 sha）——替代逐条 `merge-base --is-ancestor`
  2. **light 模式**：`?light=true` 跳过逐条 `commitTrack`（测试/预发/上线追踪，插件 Review 不需要），
     插件 `nodeTracks` 默认带 light；网页保持全量
  3. **bug 修复**：短 sha 直接 `Set.has(40位sha)` 永不命中 → 改为前缀匹配
- 实测：分支组 158 → 20.7s → **0.62s**（48 已合入 / 16 未合并）

## 合并变更（combined diff）性能优化

- **问题**：64 条 × 3 次 git（stat/time/meta）≈192 次 + 53 文件 × 2 次（old/new）≈106 次 ≈ **300 次 git 进程**
- **修复**：
  1. `commitMetasBatch`：一次 `git log --no-walk=unsorted --numstat --format=...` 拿全部提交的 stat/作者/时间
  2. 文件 old/new 串行 → **并发 8**
- 实测：64 条合并变更 → **≈1.5s**

### 单提交 diff 优化

- **问题**：每文件 3 次 git（patch / 父版本 / 本版本）——10 文件提交 = 30 次进程
- **修复**：
  1. 一次 `git show <sha> --format= --no-renames` 拿全量 patch，按 `diff --git` 拆分
  2. `git cat-file --batch`（spawn + stdin）一次取全部 `sha^:path` / `sha:path` 内容
- 实测：300-600ms（与文件数基本无关）

## Review 交互增强（单击/全选/着色）

- **单击提交 → 只看这一个**：自动清空勾选，右侧切到单提交详情（回勾选模式即回到合并视图）
- **顶栏「全选⇄全不选」**：已全选时点一下变全不选（toggle）
- **顶栏「反选」**：已勾选与未勾选互换
- **提着色**（`mergedToReq` 驱动）：
  - 已合入需求分支 → **绿色**（#2E7D32）
  - 未合并 → **黄橙色**（#B8860B）
  - 未知 → 默认色

## 踩坑：单击节点 EDT 卡死（JEditorPane HTML 布局死循环）

- **现象**：单击节点（如 26Q3 需求）后右侧"加载中…"永不消失，IDE 整体卡死
- **排查**：日志打点显示 `数据到达` 后第三条 `已 setText` 缺失 → EDT 被堵；
  **jstack 实锤**：`AWT-EventQueue` RUNNABLE，栈为
  `DefaultCaret.repaintNewCaret → modelToView → BoxView.layout` 递归 10+ 层，CPU 36s+
- **根因**：`selectDetailPane.setCaretPosition(0)`（JEditorPane + text/html）触发
  `DefaultCaret.repaintNewCaret` → HTML BoxView 布局**死循环**（经典 Swing bug）
- **修复**：去掉 `setCaretPosition(0)`，改 `invokeLater + scrollRectToVisible(new Rectangle(0,0,1,1))`
- **教训**：JEditorPane 渲染 HTML 时**避免 setCaretPosition**；排查 EDT 卡死用 **jstack 直接看 AWT-EventQueue 栈**最快

### 修复升级：JEditorPane → JTextArea（彻底）

- **第一轮**（去 setCaretPosition）无效；**第二轮**（禁 caret）仍无效——
  jstack 二次实锤：`BasicTextUI.getPreferredSize → BoxView.layout → View.append` 死循环
  （HTML 布局在 IDEA 容器反复询问尺寸时无限追加 view）
- **最终方案**：详情面板改 **JTextArea 纯文本**（`mdToText` 净化 markdown：去 # 与代码围栏），
  **彻底绕开 HTML 布局**；PRD 改顶栏「PRD」按钮（内置 JCEF tab 打开）
- **教训**：**Swing JEditorPane 的 HTML 渲染（尤其 text/html + 复杂样式/中文）在 IDEA 嵌套容器里不可靠**，
  只读展示场景优先 JTextArea/Browser（JCEF）；排查 EDT 卡死第一步永远是 **jstack 看 AWT-EventQueue 栈**

### 收口：详情面板改用 JCEF 渲染 Markdown（纯文本方案的回退）

- **现象**（用户反馈截图）：右侧详情把文档**原样当纯文本**贴出来 —— `## 标题`、`- [立项资料库](https://…)`、
  `---`、`**粗体**` 全部裸露，链接不可点。
- **根因**：上游为绕开 JEditorPane 的 BoxView 死循环，把渲染降级成 `mdToText`
  （只做「去 `#` + 去代码围栏」），**Markdown 语义整体丢失**；同一文件里另有一份 `mdToHtml`
  但从未被调用（死代码），修 bug 时容易误改错路径。
- **修复**：新增 `MarkdownRenderer`（IDEA 自带 `org.intellij.markdown`，GFM 方言），详情面板改用 **JCEF**
  呈现（正是下面「教训」里推荐的 Browser 路线），不再碰 Swing 的 HTML 布局；
  JCEF 不可用时仍降级为 `JTextArea` 纯文本。旧死代码 `mdToHtml` / `inlineMd` 一并删除。
- **转义**（安全）：默认 providers 会把文档里的原始 HTML 原样透传进渲染页
  （实测 `<script>`、`<img onerror=…>` 均可执行）。`MarkdownRenderer` 把 `HTML_BLOCK` / `HTML_TAG`
  换成转义 provider，文档中的原始 HTML 只以**文本**呈现；链接仍可点，且经
  `setOpenLinksInExternalBrowser(true)` 走外部浏览器，不在面板内导航。
- **验收**：真实节点 id=100 的「需求内容 / 设计方案」渲染出标题层级、可点链接、列表、引用、行内代码、
  分隔线；`npm test` 243 用例全绿；`idea-plugin/build.sh` 编译通过。

## Review 布局微调

- **commit 列表操作移入列表头**：左列 commit 列表上方一行 —— 「全选⇄」「反选」「仅看待审」
- **顶栏**：左侧=导航组（退出返回/提交列表）+ 摘要；右侧=其余功能按钮组（右对齐）

## 节点树增删改（右键菜单）

- **右键节点树** → 「新建子节点…」（按 CHILD_TYPES 约束选类型 + 输名）/「重命名…」（带现名初值）/「删除节点…」（级联警告 + 确认）
- Api：`renameNode`（PATCH name）/`deleteNode`（DELETE ?confirm=true）；完成后 `reloadTree()` 自动刷新
- 类型约束与后端一致：project→requirement；requirement→[group, subreq]；subreq→[group, task]；group→[group, subreq, task, defect]；task→[defect]

## 边界与候选

- merge 在主仓库执行（会改本地分支状态；**不 push**——推送仍由人工/GitLab 流程）
- 冲突解决：用户在终端解决后重新点「标记通过」（此时工作区有冲突会先被拒；解决并 commit 后可合并）
- 候选：合并结果回写 commit（mergeSha 关联）、失败自动回滚（merge --abort）
