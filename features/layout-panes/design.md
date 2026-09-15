# 设计 · 对照布局与面板显隐

## 布局模型

```
┌─────────────────────┬───────────────┐
│  diff（宽 ratio1）    │ 需求概设 / PRD │ ← 同一组内双 tab 切换
├─────────────────────┴───────────────┤
│  TaskBoard（底部，高 ratio2）          │
└─────────────────────────────────────┘
```

- **比例持久化**：`LayoutPrefs`（`PropertiesComponent`：`taskboard.layout.diffRatio` / `toolWindowRatio`），默认 **50% / 30%**
- **拖拽记忆**：顶层 `Splitter` 挂 `propertyChangeListener`（仅 `lastTopSplitter`，防误存）
- **工具窗高度**：`ToolWindowEx.stretchHeight(delta)` 传**差值**（平台增量语义，见踩坑 ②）；面板显式 `preferredSize` 防内容撑高
- **清场重铺**：`openReviewLayout` 先关三件套 tab（diff/docs/PRD）+ `unsplitAllWindow()` 再重建；`showDiffPane/showDocsPane` 为"只动自己"的轻量版
- **显隐开关**：`ToggleAction` 覆写 `update()`（☑/☐ 前缀 + Checked 图标），点击后 `updateActionsImmediately()` 刷新；`isSelected` 实时检测（diff = ChainDiff 实例存在；文档 = docs 或 PRD tab 存在）

## 节点树按钮行（Select 视图）

- 一行 `ActionToolbar`（刷新 / 拷贝上下文 / 拷贝节点ID / 搜索）+ 第二行状态文本
- 拷贝上下文：`api.nodeDocuments` + `findPrdUrl` → markdown（节点信息 + 文档 + PRD）→ 剪贴板
- 拷贝节点ID：`<id> · <name>`（供在 Qoder/聊天里指代任务）
- 搜索：输入关键词 → 递归匹配 `NodeData.name` → `setSelectionPath` + `scrollPathToVisible`

## 右侧详情面板（Markdown 渲染）

- 单击节点 → 右栏渲染「节点头 + 各文档」，**Markdown 由 JCEF 承载**（`MarkdownRenderer`，
  IDEA 自带 `org.intellij.markdown` GFM 方言：标题 / 列表 / 表格 / 引用 / 行内代码 / 链接 / 分隔线）
- 链接走 `setOpenLinksInExternalBrowser(true)`，点击不在工具窗内导航
- 文档里的原始 HTML（`<script>` / `<img onerror=…>`）经转义 provider 只作文本显示，不进渲染页
- JCEF 不可用（模块被禁用）时降级为 `JTextArea` 纯文本，保证面板始终可用
- 不用 Swing `JEditorPane` 渲染 HTML：在 IDEA 嵌套容器里会 BoxView 布局死循环（详见 `features/merge-flow/design.md`）

## 踩坑记录（三连击，全部日志实锤）

### ① PRD tab「关不干净」——三个版本才到底
| 版本 | 策略 | 漏点 |
|---|---|---|
| v1 `closeCurrent` | 只关静态引用 `current` 的**最后实例** | 会话恢复/多实例全漏 |
| v2 `instanceof PrdVirtualFile` 通杀 | 关自家 JCEF tab | **残留实为 `HttpVirtualFileImpl`**（点 PRD 链接时 IDEA 创建的"飞书网页"编辑器，`getPath()`=feishu URL） |
| **v3（现行）`closeAll`** | 关 `PrdVirtualFile` **或** 路径含 `feishu.cn` 的一切 | ✓ |

**教训**：清理 tab 要按**内容特征（URL/路径）**识别，**不能只按"自家类"**；判断依据来自诊断日志（枚举编辑器组 + 类名）。

### ② 工具窗高度「越设越高」
- `stretchHeight(value)` 平台实现为**增量**（当前高度 + value）而非目标值 → 多时间点连设累加溢出
- 修复：传 `target - current` 差值（幂等）；并给面板合理 `preferredSize`（大树 preferred 会把工具窗撑高）

### ③ 收起面板后的两个"连带"问题
- **跳无关文件**：关掉活跃 tab 后平台把焦点给相邻 tab（用户曾打开的 DetailView.vue 冒出）→ 修复：收起后主动 `fem.openFile(diffKeep, true)` 落回 diff
- **勾 diff 连带文档**：`showDiffPane` 旧有"组数≤1 → 重铺对照布局"分支 → 修复：**删除分支**，显示 diff 只显示 diff（完整布局走「对照布局」）

## 诊断工具（已随代码保留）

- `TaskBoardPanel.diag(msg)` + `dumpWindows()`：写 `<java.io.tmpdir>/taskboard-plugin.log`（macOS 实际在 `/var/folders/.../T/`）
- `hideDocsPane` 前后各 dump 一次（开始 / closeAll 完成 / 完成），记录每组文件名 + **类名**
- 排查 tab 类问题先用它抓现场（本次三连击均靠它定位），确认稳定后可摘除
