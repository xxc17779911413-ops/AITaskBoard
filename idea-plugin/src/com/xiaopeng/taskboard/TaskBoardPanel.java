package com.xiaopeng.taskboard;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.intellij.ide.BrowserUtil;
import com.intellij.icons.AllIcons;
import com.intellij.openapi.actionSystem.ActionManager;
import com.intellij.openapi.actionSystem.ActionToolbar;
import com.intellij.openapi.actionSystem.AnAction;
import com.intellij.openapi.actionSystem.AnActionEvent;
import com.intellij.openapi.actionSystem.DefaultActionGroup;
import com.intellij.openapi.actionSystem.Separator;
import com.intellij.openapi.actionSystem.ToggleAction;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.fileEditor.OpenFileDescriptor;
import com.intellij.openapi.fileEditor.ex.FileEditorManagerEx;
import com.intellij.openapi.fileEditor.impl.EditorWindow;
import com.intellij.openapi.fileTypes.FileTypeManager;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.ide.CopyPasteManager;
import com.intellij.openapi.ui.Messages;
import com.intellij.openapi.vfs.LocalFileSystem;
import com.intellij.openapi.vfs.VirtualFile;
import com.intellij.ui.CheckboxTree;
import com.intellij.ui.CheckedTreeNode;
import com.intellij.ui.JBColor;
import com.intellij.ui.ScrollPaneFactory;
import com.intellij.ui.components.JBCheckBox;
import com.intellij.ui.components.JBLabel;
import org.jetbrains.annotations.NotNull;

import javax.swing.*;
import javax.swing.event.TreeSelectionEvent;
import javax.swing.tree.DefaultMutableTreeNode;
import javax.swing.tree.DefaultTreeCellRenderer;
import javax.swing.tree.DefaultTreeModel;
import javax.swing.tree.TreePath;
import javax.swing.tree.TreeSelectionModel;
import java.awt.*;
import java.awt.event.MouseAdapter;
import java.awt.event.MouseEvent;
import java.awt.datatransfer.StringSelection;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Enumeration;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * task-board 工具窗口（Git Log 式、平台原生风格）：
 * 视图 A（节点选择）：双击节点进入 Review；
 * 视图 B（节点 Review）：默认全部勾选 → 右侧直接展示全部 commit 的合并变更（文件并集 + 净 old/new）；
 *   「提交列表」按钮可展开/收起左侧 commit 列表（勾选/取消调整参与合并的范围）；
 *   双击文件 → IDEA 原生 Diff；勾选后批量审查（✓通过 / ✗有问题 / ○重置）；[← 退出] 返回节点选择。
 */
public class TaskBoardPanel extends JPanel {

    private final Project project;
    private final TaskBoardApi api = new TaskBoardApi(TaskBoardApi.DEFAULT_BASE);

    // ---------- 视图切换 ----------
    private final CardLayout cardLayout = new CardLayout();
    private final JPanel cards = new JPanel(cardLayout);
    private static final String CARD_SELECT = "select";
    private static final String CARD_REVIEW = "review";

    // ---------- 视图 A：节点选择 ----------
    private final DefaultMutableTreeNode selectRoot = new DefaultMutableTreeNode("task-board");
    private final DefaultTreeModel selectModel = new DefaultTreeModel(selectRoot);
    private final JTree selectTree = new JTree(selectModel);
    private final JBLabel selectStatus = new JBLabel(" ");

    // ---------- 视图 B：节点 Review ----------
    private final CheckedTreeNode reviewRoot = new CheckedTreeNode("review");
    private CheckboxTree reviewTree;
    private final JBLabel reviewSummary = new JBLabel(" ");
    private JBCheckBox onlyPending;
    private final List<CommitItem> commitItems = new ArrayList<>();
    private long requestToken = 0;
    private long currentNodeId = -1;
    private String currentNodeName = "";
    private JSplitPane reviewSplit;
    private JScrollPane commitScroll;
    private boolean commitListVisible = false;
    private static final int COMMIT_LIST_WIDTH = 330;

    // 详情区
    private final DefaultMutableTreeNode detailRoot = new DefaultMutableTreeNode("files");
    private final DefaultTreeModel detailModel = new DefaultTreeModel(detailRoot);
    private final JTree detailTree = new JTree(detailModel);
    private final JPanel commitInfoPanel = new JPanel();
    private JSplitPane detailVertSplit;
    private final Map<Long, JsonObject> diffCache = new HashMap<>();
    private long detailToken = 0;
    private Timer checksDebounce;
    // 当前聚合变更（供链 diff 打开时使用）
    private List<DiffOpener.FileDiff> aggregateFiles = new ArrayList<>();
    private String aggregateTitle = "";

    public TaskBoardPanel(Project project) {
        super(new BorderLayout());
        this.project = project;
        // 合理的偏好尺寸：避免底部停靠时被“内容偏好”（树/表格的巨量 preferred）撑高
        setPreferredSize(new Dimension(900, 320));
        setMinimumSize(new Dimension(320, 120));
        cards.add(buildSelectView(), CARD_SELECT);
        cards.add(buildReviewView(), CARD_REVIEW);
        add(cards, BorderLayout.CENTER);
        startIdeBridgePolling();
        startSelectionCapture();
    }

    // ---------- Qoder 联动：自动捕获编辑器选中（零点击） ----------

    /** 注册全局选区监听：任意编辑器（含 diff 视图）里选中代码后自动写入"最近选中"，供 Qoder Hook 注入 */
    private void startSelectionCapture() {
        try {
            com.intellij.openapi.editor.EditorFactory.getInstance().getEventMulticaster()
                    .addSelectionListener(new com.intellij.openapi.editor.event.SelectionListener() {
                        @Override
                        public void selectionChanged(@NotNull com.intellij.openapi.editor.event.SelectionEvent e) {
                            captureSelectionDebounced(e.getEditor());
                        }
                    }, project);
        } catch (Throwable ignore) {
            // 监听注册失败不影响插件主体
        }
    }

    /** 防抖（700ms）：避免拖选过程中频繁写盘 */
    private void captureSelectionDebounced(com.intellij.openapi.editor.Editor editor) {
        if (selectionTimer != null) {
            selectionTimer.stop();
        }
        selectionTimer = new Timer(700, ev -> {
            ((Timer) ev.getSource()).stop();
            captureSelection(editor);
        });
        selectionTimer.setRepeats(false);
        selectionTimer.start();
    }

    /** 把"最近一次选中"（≥10 字符）覆盖写入 ~/.taskboard/last-selection.md（Qoder Hook 自动注入） */
    private void captureSelection(com.intellij.openapi.editor.Editor editor) {
        try {
            if (editor == null || editor.isDisposed()) {
                return;
            }
            if (editor.getSelectionModel().hasSelection()) {
                lastSelectionEditor = editor;
            }
            String text = editor.getSelectionModel().hasSelection()
                    ? editor.getSelectionModel().getSelectedText() : null;
            if (text == null || text.trim().length() < 10) {
                return;
            }
            String fileName = "";
            try {
                VirtualFile vf = editor.getVirtualFile();
                if (vf instanceof com.intellij.diff.editor.ChainDiffVirtualFile) {
                    // 链式 diff 的 tab 自身：取"当前显示的变更文件路径"
                    String diffPath = DiffOpener.currentDiffFilePath(vf);
                    fileName = diffPath != null ? diffPath : "（当前 review diff）";
                } else if (vf instanceof com.intellij.testFramework.LightVirtualFile) {
                    // diff 的左右编辑器（内容 vf）或其它虚拟文件：回退到"当前链式 diff"取真实文件路径
                    String diffPath = null;
                    VirtualFile chainVf = DiffOpener.currentFile();
                    if (chainVf != null && chainVf.isValid()) {
                        diffPath = DiffOpener.currentDiffFilePath(chainVf);
                    }
                    fileName = diffPath != null ? diffPath : "（当前 review diff）";
                } else {
                    fileName = vf.getName();
                }
            } catch (Throwable ignore) {
                // 虚拟文件时忽略
            }
            StringBuilder block = new StringBuilder();
            block.append("### 最近选中（").append(java.time.LocalTime.now().withNano(0))
                    .append(fileName.isEmpty() ? "" : "，来自 " + fileName).append("）\n```\n")
                    .append(text).append("\n```\n");
            Path dir = java.nio.file.Paths.get(System.getProperty("user.home"), ".taskboard");
            Files.createDirectories(dir);
            Files.writeString(dir.resolve("last-selection.md"), block.toString());
        } catch (Throwable ignore) {
            // 捕获失败不影响使用
        }
    }

    // ---------- 需求 + 概设 / PRD ----------

    /** 一键对照布局：左 diff + 中 需求+概设 + 右 PRD（飞书），并调整宽度比例 */
    private void openReviewLayout() {
        if (currentNodeId < 0) {
            reviewSummary.setText("请先从节点树进入一个节点");
            return;
        }
        final long nodeId = currentNodeId;
        final String nodeName = currentNodeName;
        ApplicationManager.getApplication().executeOnPooledThread(() -> {
            try {
                JsonArray docs = api.nodeDocuments(nodeId);
                String prdUrl = null;
                try {
                    prdUrl = findPrdUrl(nodeId);
                } catch (Exception ignore) {
                    // 无 PRD 链接不阻断
                }
                // 实时拉取当前节点（子树）全量变更：不依赖面板缓存（切节点后立即点击也正确）
                List<DiffOpener.FileDiff> layoutFiles = new ArrayList<>();
                String layoutTitle = nodeName + " · 全部变更";
                try {
                    JsonObject tracks = api.nodeTracks(nodeId, "subtree");
                    JsonArray items = tracks != null ? tracks.getAsJsonArray("items") : null;
                    if (items != null && items.size() > 0) {
                        long[] cids = new long[items.size()];
                        for (int i = 0; i < items.size(); i++) {
                            cids[i] = items.get(i).getAsJsonObject()
                                    .getAsJsonObject("commit").get("id").getAsLong();
                        }
                        JsonObject combined = api.combinedDiff(cids);
                        JsonArray repos = combined.getAsJsonArray("repos");
                        if (repos != null) {
                            for (JsonElement rel : repos) {
                                JsonArray fs = rel.getAsJsonObject().getAsJsonArray("files");
                                if (fs == null) continue;
                                for (JsonElement fe : fs) {
                                    JsonObject f = fe.getAsJsonObject();
                                    if (f.has("binary") && f.get("binary").getAsBoolean()) continue;
                                    layoutFiles.add(new DiffOpener.FileDiff(
                                            f.get("path").getAsString(),
                                            str(f, "old", ""),
                                            str(f, "new", "")));
                                }
                            }
                        }
                    }
                } catch (Exception ignore) {
                    // 实时失败时退回面板当前缓存
                }
                if (layoutFiles.isEmpty() && aggregateFiles != null && !aggregateFiles.isEmpty()) {
                    layoutFiles = aggregateFiles;
                    layoutTitle = aggregateTitle;
                }
                final List<DiffOpener.FileDiff> finalFiles = layoutFiles;
                final String finalLayoutTitle = layoutTitle;
                final JsonArray finalDocs = docs;
                final String finalPrdUrl = prdUrl;
                SwingUtilities.invokeLater(() -> {
                    // 0) 清场：关掉上次开的三类 tab + 合并分屏 → 保证每次都是干净三栏（不堆叠）
                    try {
                        DiffOpener.closeCurrent(project);
                        PrdOpener.closeAll(project);
                        String docsPath = java.nio.file.Paths.get(System.getProperty("java.io.tmpdir"),
                                "taskboard-docs", "taskboard-需求概设.md").toString();
                        VirtualFile docsOld = LocalFileSystem.getInstance().findFileByPath(docsPath);
                        if (docsOld != null) {
                            FileEditorManagerEx.getInstanceEx(project).closeFile(docsOld);
                        }
                        FileEditorManagerEx.getInstanceEx(project).unsplitAllWindow();
                    } catch (Throwable ignore) {
                        // 清场失败不阻断重铺
                    }
                    // 1) 左侧：diff（当前节点全量变更）
                    if (finalFiles != null && !finalFiles.isEmpty()) {
                        DiffOpener.openCombined(project, finalLayoutTitle, finalFiles, null);
                    } else {
                        CommitItem sel = selectedCommit();
                        if (sel != null) DiffOpener.open(project, api, sel.cid, sel.sha, null);
                    }
                    // 2) 中间：需求+概设文档（右分屏）
                    FileEditorManagerEx femEx = FileEditorManagerEx.getInstanceEx(project);
                    EditorWindow main = femEx.getCurrentWindow();
                    VirtualFile docsVf = (finalDocs != null && finalDocs.size() > 0)
                            ? buildDocsFile(finalDocs, finalPrdUrl) : null;
                    EditorWindow docWin = null;
                    if (docsVf != null && main != null) {
                        docWin = main.split(JSplitPane.HORIZONTAL_SPLIT, true, docsVf, true);
                    }
                    // 3) 右侧同一组：PRD 作为第二个 tab（与需求概设切换展示，用顶栏「文档/PRD」按钮切）
                    if (finalPrdUrl != null) {
                        try {
                            PrdVirtualFile prdVf = PrdOpener.prepare(project, finalPrdUrl, nodeName);
                            if (prdVf != null) {
                                // focus=false：打开为 tab 但不抢激活（默认展示需求概设）
                                FileEditorManagerEx.getInstanceEx(project).openFile(prdVf, false);
                            }
                        } catch (Throwable ignore) {
                            // PRD 打开失败不阻断
                        }
                    }
                    // 4) 宽度：diff 主组约 70%；并把 TaskBoard 工具窗停靠到底部（与 diff 上下）后设高度约 30%
                    final EditorWindow mainRef = main;
                    Timer t = new Timer(500, ev -> {
                        ((Timer) ev.getSource()).stop();
                        applyTopSplitterProportion(mainRef, LayoutPrefs.diffRatio());
                        applyTaskBoardBottom(project);
                    });
                    t.setRepeats(false);
                    t.start();
                    reviewSummary.setText("已铺对照布局：diff（" + finalFiles.size() + " 文件，宽70%） + 右列（需求概设⇄PRD 用顶栏按钮切） + TaskBoard底部（高30%）");
                    // 打开布局即注入当前上下文（任务/编号/当前+勾选 commit/文件/当前文件）给 Qoder
                    writeReviewContext(true);
                });
            } catch (Exception ex) {
                SwingUtilities.invokeLater(() -> reviewSummary.setText("铺布局失败：" + ex.getMessage()));
            }
        });
    }

    // ---------- Qoder 联动：当前 review 上下文 ----------

    /** 把"当前 review 上下文"（节点/编号/当前+勾选提交/文件/当前展示文件）写到固定文件，供 Qoder hook 桥注入 */
    private void writeReviewContext() {
        writeReviewContext(false);
    }

    /** layoutOpened=true 时额外记录 layoutOpenedAt（打开布局后 hook 无条件注入） */
    private void writeReviewContext(boolean layoutOpened) {
        try {
            JsonObject o = new JsonObject();
            o.addProperty("updatedAt", System.currentTimeMillis());
            if (layoutOpened) {
                o.addProperty("layoutOpenedAt", System.currentTimeMillis());
            } else {
                // 保留上一次的 layoutOpenedAt（非布局写入不覆盖）
                try {
                    JsonObject old = JsonParser.parseString(
                            Files.readString(java.nio.file.Paths.get(System.getProperty("user.home"),
                                    ".taskboard", "current-review.json"))).getAsJsonObject();
                    if (old.has("layoutOpenedAt")) {
                        o.addProperty("layoutOpenedAt", old.get("layoutOpenedAt").getAsLong());
                    }
                } catch (Throwable ignore) {
                    // 读旧失败不阻断
                }
            }
            o.addProperty("nodeId", currentNodeId);
            o.addProperty("nodeName", currentNodeName);
            o.addProperty("nodeNo", currentNodeNo());
            JsonArray commits = new JsonArray();
            for (CommitItem it : checkedCommits()) {
                JsonObject c = new JsonObject();
                c.addProperty("sha", it.sha == null ? "" : it.sha);
                c.addProperty("note", it.note == null ? "" : it.note);
                c.addProperty("repo", it.repo == null ? "" : it.repo);
                c.addProperty("reviewStatus", it.reviewStatus == null ? "pending" : it.reviewStatus);
                commits.add(c);
            }
            o.add("checkedCommits", commits);
            // 当前选中/查看的 commit
            CommitItem cur = selectedCommit();
            if (cur != null) {
                JsonObject cc = new JsonObject();
                cc.addProperty("sha", cur.sha == null ? "" : cur.sha);
                cc.addProperty("note", cur.note == null ? "" : cur.note);
                cc.addProperty("repo", cur.repo == null ? "" : cur.repo);
                o.add("currentCommit", cc);
            }
            JsonArray files = new JsonArray();
            if (aggregateFiles != null) {
                for (DiffOpener.FileDiff f : aggregateFiles) {
                    files.add(f.path);
                }
            }
            o.add("files", files);
            // 当前 diff 正在展示的文件路径
            String curFile = currentDiffFile();
            if (curFile != null && !curFile.isEmpty()) {
                o.addProperty("currentFile", curFile);
            }
            Path dir = java.nio.file.Paths.get(System.getProperty("user.home"), ".taskboard");
            Files.createDirectories(dir);
            Files.writeString(dir.resolve("current-review.json"), o.toString());
        } catch (Exception ignore) {
            // 上下文写入失败不影响 UI
        }
    }

    /** 当前 diff 正在展示的文件路径（链式 diff 当前页；回退内容反查） */
    private String currentDiffFile() {
        try {
            VirtualFile chain = DiffOpener.currentFile();
            if (chain != null && chain.isValid()) {
                String p = DiffOpener.currentDiffFilePath(chain);
                if (p != null && !p.isEmpty()) {
                    return p;
                }
            }
            com.intellij.openapi.editor.Editor ed =
                    FileEditorManagerEx.getInstanceEx(project).getSelectedTextEditor();
            if (ed == null || ed.isDisposed()) {
                ed = lastSelectionEditor;
            }
            if (ed != null && !ed.isDisposed()) {
                return DiffOpener.filePathForEditor(ed);
            }
        } catch (Throwable ignore) {
            // 忽略
        }
        return null;
    }

    // ---------- Qoder 联动：派任务给 Qoder IDE（前台 Agent） ----------

    /** 派给 Qoder（IDE 前台）：生成任务提示词 → 打开 Qoder 面板 + 剪贴板就绪（⌘V+回车即发） */
    private void dispatchToQoder() {
        if (currentNodeId < 0) {
            reviewSummary.setText("请先从节点树进入一个节点");
            return;
        }
        final long nodeId = currentNodeId;
        final String nodeName = currentNodeName;
        ApplicationManager.getApplication().executeOnPooledThread(() -> {
            try {
                JsonArray docs = api.nodeDocuments(nodeId);
                String prdUrl = null;
                try {
                    prdUrl = findPrdUrl(nodeId);
                } catch (Exception ignore) {
                    // 无 PRD 不阻断
                }
                String prompt = buildDispatchPrompt(nodeName, docs, prdUrl);
                SwingUtilities.invokeLater(() -> {
                    boolean ok = QoderOpener.dispatch(project, prompt);
                    reviewSummary.setText(ok
                            ? "已打开 Qoder 面板并复制任务提示词（" + nodeName + "）——粘贴（⌘V）+ 回车发送"
                            : "任务提示词已复制（" + nodeName + "）——请手动打开 Qoder 面板粘贴发送");
                });
            } catch (Exception ex) {
                SwingUtilities.invokeLater(() -> reviewSummary.setText("生成提示词失败：" + ex.getMessage()));
            }
        });
    }

    /** 生成派单提示词：任务上下文（文档/PRD/已登记提交/当前变更文件）+ 执行要求 */
    private String buildDispatchPrompt(String nodeName, JsonArray docs, String prdUrl) {
        StringBuilder md = new StringBuilder();
        md.append("你是 Qoder Agent。请执行下面来自 task-board 的任务。\n\n");
        md.append("# 任务：").append(nodeName).append("\n\n");
        if (prdUrl != null) {
            md.append("- PRD（飞书）：").append(prdUrl).append("\n\n");
        }
        if (docs != null) {
            for (JsonElement el : docs) {
                JsonObject d = el.getAsJsonObject();
                md.append("## ").append(str(d, "name", "文档")).append("\n\n");
                md.append(str(d, "content", "")).append("\n\n---\n\n");
            }
        }
        List<CommitItem> sel = checkedCommits();
        if (!sel.isEmpty()) {
            md.append("## 已登记提交（供参考）\n\n");
            for (CommitItem it : sel) {
                md.append("- `").append(it.sha == null ? "" : it.sha).append("` ")
                        .append(it.note == null ? "" : it.note)
                        .append("（").append(it.repo == null ? "" : it.repo).append("）\n");
            }
            md.append("\n");
        }
        if (aggregateFiles != null && !aggregateFiles.isEmpty()) {
            md.append("## 当前变更文件（").append(aggregateFiles.size()).append("）\n\n");
            for (DiffOpener.FileDiff f : aggregateFiles) {
                md.append("- ").append(f.path).append("\n");
            }
            md.append("\n");
        }
        md.append("## 要求\n\n先阅读相关代码与上述上下文，按需修改；完成后给出变更摘要。\n");
        md.append("\n（本提示词由 TaskBoard 插件生成，可继续在终端对话追问）\n");
        return md.toString();
    }

    // ---------- diff 行级评论 ----------

    /** 取"当前 diff 编辑器的文件路径 + 选中行范围 + 片段"（非 diff 编辑或取不到返回 null） */
    private String[] diffFileAndLines(com.intellij.openapi.editor.Editor editor) {
        try {
            VirtualFile vf = editor.getVirtualFile();
            String path = null;
            if (vf instanceof com.intellij.diff.editor.ChainDiffVirtualFile) {
                path = DiffOpener.currentDiffFilePath(vf);
            } else if (vf instanceof com.intellij.testFramework.LightVirtualFile) {
                VirtualFile chainVf = DiffOpener.currentFile();
                if (chainVf != null && chainVf.isValid()) {
                    path = DiffOpener.currentDiffFilePath(chainVf);
                }
            } else if (vf != null) {
                path = vf.getPath();
            }
            // 兜底：用编辑器内容反查（MyLightVirtualFile 等 diff 内容 vf 场景）
            if (path == null) {
                path = DiffOpener.filePathForEditor(editor);
            }
            if (path == null) {
                return null;
            }
            int startLine = editor.getSelectionModel().getSelectionStartPosition() != null
                    ? editor.getSelectionModel().getSelectionStartPosition().line + 1 : 1;
            int endLine = editor.getSelectionModel().getSelectionEndPosition() != null
                    ? editor.getSelectionModel().getSelectionEndPosition().line + 1 : startLine;
            String snippet = editor.getSelectionModel().hasSelection()
                    ? editor.getSelectionModel().getSelectedText() : "";
            if (snippet != null && snippet.length() > 500) {
                snippet = snippet.substring(0, 500);
            }
            return new String[]{path, String.valueOf(startLine), String.valueOf(endLine), snippet == null ? "" : snippet};
        } catch (Throwable t) {
            return null;
        }
    }

    /** 在当前 diff 选中处添加评论（文件 + 行号 + 片段 → task-board） */
    private void addCommentOnDiff() {
        if (currentNodeId < 0) {
            reviewSummary.setText("请先从节点树进入一个节点");
            return;
        }
        com.intellij.openapi.editor.Editor editor =
                FileEditorManagerEx.getInstanceEx(project).getSelectedTextEditor();
        if (editor == null || editor.isDisposed() || !editor.getSelectionModel().hasSelection()) {
            // 回退：点按钮时焦点已离开编辑器，用"最近有选区"的编辑器
            com.intellij.openapi.editor.Editor fallback = lastSelectionEditor;
            if (fallback != null && !fallback.isDisposed() && fallback.getSelectionModel().hasSelection()) {
                editor = fallback;
            }
        }
        if (editor == null || editor.isDisposed() || !editor.getSelectionModel().hasSelection()) {
            reviewSummary.setText("请在 diff 编辑器里选中要评论的行");
            return;
        }
        String[] info = diffFileAndLines(editor);
        if (info == null) {
            String vfDesc;
            try {
                VirtualFile vf0 = editor.getVirtualFile();
                vfDesc = vf0 == null ? "null" : vf0.getClass().getSimpleName() + ":" + vf0.getName();
            } catch (Throwable t) {
                vfDesc = "err";
            }
            VirtualFile chainVf = DiffOpener.currentFile();
            String chainDesc = chainVf == null ? "null" : chainVf.getClass().getSimpleName();
            diag("addComment: 未定位到变更文件 vf=" + vfDesc + ", chain=" + chainDesc);
            reviewSummary.setText("未定位到变更文件（vf=" + vfDesc + "）——已记日志");
            return;
        }
        String content = Messages.showMultilineInputDialog(project,
                "评论内容（" + info[0] + " 第 " + info[1] + "-" + info[2] + " 行）：",
                "添加评论", "", null, null);
        if (content == null || content.trim().isEmpty()) {
            return;
        }
        final long nodeId = currentNodeId;
        final String[] finfo = info;
        ApplicationManager.getApplication().executeOnPooledThread(() -> {
            try {
                String sha = null;
                List<CommitItem> sel = checkedCommits();
                if (sel.size() == 1) {
                    sha = sel.get(0).sha;
                }
                api.addComment(nodeId, finfo[0], sha, Integer.parseInt(finfo[1]), Integer.parseInt(finfo[2]), finfo[3], content.trim());
                SwingUtilities.invokeLater(() -> reviewSummary.setText("评论已保存：" + finfo[0] + " 第 " + finfo[1] + " 行"));
            } catch (Exception ex) {
                SwingUtilities.invokeLater(() -> reviewSummary.setText("保存评论失败：" + ex.getMessage()));
            }
        });
    }

    /** 查看本节点的全部评论（弹窗列表） */
    private void showComments() {
        if (currentNodeId < 0) {
            reviewSummary.setText("请先从节点树进入一个节点");
            return;
        }
        final long nodeId = currentNodeId;
        ApplicationManager.getApplication().executeOnPooledThread(() -> {
            try {
                JsonArray list = api.listComments(nodeId);
                StringBuilder sb = new StringBuilder();
                int open = 0;
                for (JsonElement el : list) {
                    JsonObject c = el.getAsJsonObject();
                    String st = str(c, "status", "open");
                    if ("open".equals(st)) {
                        open++;
                    }
                    sb.append("open".equals(st) ? "●" : "✓").append(" ")
                            .append(str(c, "filePath", "")).append(" L")
                            .append(c.get("lineStart").getAsInt());
                    if (c.get("lineEnd").getAsInt() > c.get("lineStart").getAsInt()) {
                        sb.append("-").append(c.get("lineEnd").getAsInt());
                    }
                    sb.append("  ").append(str(c, "content", "")).append("\n");
                }
                final String text = sb.length() == 0 ? "（暂无评论——在 diff 里选中行后点「评论」添加）" : sb.toString();
                final int openCount = open;
                final int total = list.size();
                SwingUtilities.invokeLater(() -> Messages.showMultilineInputDialog(project,
                        "本节点评论（待处理 " + openCount + " / 共 " + total + "）：",
                        "评论列表", text, null, null));
            } catch (Exception ex) {
                SwingUtilities.invokeLater(() -> reviewSummary.setText("加载评论失败：" + ex.getMessage()));
            }
        });
    }

    // ---------- 缺陷登记与 AI 修复 ----------

    /** 登记缺陷：在当前节点下创建 defect 节点（自动带 diff 位置/片段），可一键派给 Qoder 修复 */
    private void reportDefect() {
        if (currentNodeId < 0) {
            reviewSummary.setText("请先从节点树进入一个节点");
            return;
        }
        // 取 diff 上下文（可无——非 diff 场景也可登记）
        String[] info = null;
        com.intellij.openapi.editor.Editor editor =
                FileEditorManagerEx.getInstanceEx(project).getSelectedTextEditor();
        if (editor == null || editor.isDisposed() || !editor.getSelectionModel().hasSelection()) {
            com.intellij.openapi.editor.Editor fb = lastSelectionEditor;
            if (fb != null && !fb.isDisposed() && fb.getSelectionModel().hasSelection()) {
                editor = fb;
            }
        }
        if (editor != null && !editor.isDisposed()) {
            info = diffFileAndLines(editor);
        }
        // 单窗口填写标题+描述（位置只读展示）
        DefectDialog dlg = new DefectDialog(project, info);
        if (!dlg.showAndGet()) {
            return;
        }
        final String[] finfo = info;
        final long parentId = currentNodeId;
        final String fTitle = dlg.getDefectTitle();
        final String fDesc = dlg.getDefectDesc();
        ApplicationManager.getApplication().executeOnPooledThread(() -> {
            try {
                JsonObject created = api.createNode(parentId, "defect", fTitle);
                long defectId = created.get("id").getAsLong();
                StringBuilder md = new StringBuilder();
                md.append("# ").append(fTitle).append("\n\n");
                if (!fDesc.trim().isEmpty()) {
                    md.append(fDesc).append("\n\n");
                }
                if (finfo != null) {
                    md.append("## 位置\n\n- 文件：`").append(finfo[0]).append("`\n- 行号：L")
                            .append(finfo[1]).append("-").append(finfo[2]).append("\n\n");
                    if (!finfo[3].isEmpty()) {
                        md.append("## 选中代码\n\n```\n").append(finfo[3]).append("\n```\n");
                    }
                }
                api.upsertDocument(defectId, "缺陷描述", md.toString());
                SwingUtilities.invokeLater(() -> {
                    reviewSummary.setText("已登记缺陷 #" + defectId + "：" + fTitle + "（可在树中查看）");
                    SwingUtilities.invokeLater(() -> {
                        int r = Messages.showDialog(project,
                                "缺陷 #" + defectId + " 已登记：\n" + fTitle + "\n\n下一步：派 Qoder 做根因分析与修复方案（批准后才允许修复）",
                                "登记缺陷", new String[]{"分析根因", "稍后"}, 0, null);
                        if (r == 0) {
                            // 进入缺陷流程：先分析根因（批准后才允许修复）
                            currentNodeId = defectId;
                            currentNodeName = fTitle;
                            analyzeDefectWithQoder();
                        }
                    });
                });
            } catch (Exception ex) {
                SwingUtilities.invokeLater(() -> reviewSummary.setText("登记缺陷失败：" + ex.getMessage()));
            }
        });
    }

    /** 拉取提示词模板（服务不可用等失败时用内置兜底） */
    private String loadPromptTemplate(String key, String fallback) {
        try {
            JsonObject tpls = api.getPromptTemplates();
            if (tpls.has(key) && !tpls.get(key).isJsonNull()) {
                String t = tpls.get(key).getAsString();
                if (t != null && !t.trim().isEmpty()) {
                    return t;
                }
            }
        } catch (Exception ignore) {
            // 用兜底
        }
        return fallback;
    }

    /** 模板变量注入（{{key}} → 值） */
    private static String applyTemplate(String tpl, java.util.Map<String, String> vars) {
        String out = tpl;
        for (java.util.Map.Entry<String, String> e : vars.entrySet()) {
            out = out.replace("{" + "{" + e.getKey() + "}}", e.getValue() == null ? "" : e.getValue());
        }
        return out;
    }

    /** 构建「位置」段落（文件/行号/选中代码） */
    private static String buildLocationSection(String[] info) {
        if (info == null) {
            return "";
        }
        StringBuilder sb = new StringBuilder("## 位置\n\n- 文件：`").append(info[0])
                .append("`\n- 行号：L").append(info[1]).append("-").append(info[2]).append("\n");
        if (!info[3].isEmpty()) {
            sb.append("\n## 选中代码\n\n```\n").append(info[3]).append("\n```\n");
        }
        return sb.toString();
    }

    /** 读缺陷节点的某份文档内容（不存在返回空串） */
    private String defectDocContent(long defectId, String docName) {
        try {
            JsonArray docs = api.nodeDocuments(defectId);
            for (JsonElement el : docs) {
                JsonObject d = el.getAsJsonObject();
                if (docName.equals(str(d, "name", ""))) {
                    return str(d, "content", "");
                }
            }
        } catch (Exception ignore) {
            // 忽略
        }
        return "";
    }

    /** 缺陷：派 Qoder 做根因分析（defect_analyze 模板）——结果由 Qoder 经 MCP 回写"根因与修复方案"文档 */
    private void analyzeDefectWithQoder() {
        if (currentNodeId < 0) {
            reviewSummary.setText("请先从节点树进入一个缺陷节点");
            return;
        }
        final long defectId = currentNodeId;
        final String nodeName = currentNodeName;
        ApplicationManager.getApplication().executeOnPooledThread(() -> {
            try {
                String desc = defectDocContent(defectId, "缺陷描述");
                String[] info = null;
                com.intellij.openapi.editor.Editor editor =
                        FileEditorManagerEx.getInstanceEx(project).getSelectedTextEditor();
                if (editor == null || editor.isDisposed() || !editor.getSelectionModel().hasSelection()) {
                    com.intellij.openapi.editor.Editor fb = lastSelectionEditor;
                    if (fb != null && !fb.isDisposed() && fb.getSelectionModel().hasSelection()) {
                        editor = fb;
                    }
                }
                if (editor != null && !editor.isDisposed()) {
                    info = diffFileAndLines(editor);
                }
                String tpl = loadPromptTemplate("defect_analyze", DEFAULT_DEFECT_ANALYZE);
                java.util.Map<String, String> vars = new java.util.HashMap<>();
                vars.put("defectId", String.valueOf(defectId));
                vars.put("title", nodeName);
                vars.put("desc", desc.trim().isEmpty() ? "（见节点文档「缺陷描述」）" : desc);
                vars.put("locationSection", buildLocationSection(info));
                final String prompt = applyTemplate(tpl, vars);
                SwingUtilities.invokeLater(() -> {
                    boolean ok = QoderOpener.dispatch(project, prompt);
                    reviewSummary.setText(ok
                            ? "已派 Qoder 分析根因（defect #" + defectId + "）——⌘V+回车发送；分析结果请回写到文档「根因与修复方案」"
                            : "分析提示词已复制——请手动打开 Qoder 粘贴");
                });
            } catch (Exception ex) {
                SwingUtilities.invokeLater(() -> reviewSummary.setText("派分析失败：" + ex.getMessage()));
            }
        });
    }

    /** 缺陷：批准修复方案（需已存在「根因与修复方案」文档）——合法提交的前置环节 */
    private void approveDefectFix() {
        if (currentNodeId < 0) {
            reviewSummary.setText("请先从节点树进入一个缺陷节点");
            return;
        }
        final long defectId = currentNodeId;
        ApplicationManager.getApplication().executeOnPooledThread(() -> {
            try {
                String analysis = defectDocContent(defectId, "根因与修复方案");
                if (analysis.trim().isEmpty()) {
                    SwingUtilities.invokeLater(() -> reviewSummary.setText(
                            "尚无「根因与修复方案」——请先「分析根因」（或手动写入该文档）再批准"));
                    return;
                }
                int r = Messages.showDialog(project,
                        "确认批准以下修复方案？\n\n" + (analysis.length() > 800 ? analysis.substring(0, 800) + "…" : analysis),
                        "批准修复方案", new String[]{"批准", "取消"}, 0, null);
                if (r != 0) {
                    return;
                }
                String who = System.getProperty("user.name", "user");
                String stamp = java.time.LocalDateTime.now().withNano(0).toString();
                api.upsertDocument(defectId, "修复方案审批",
                        "已批准\n\n- 审批人：" + who + "\n- 时间：" + stamp + "\n");
                SwingUtilities.invokeLater(() -> reviewSummary.setText(
                        "已批准修复方案（defect #" + defectId + "）——现在可「按方案修复」"));
            } catch (Exception ex) {
                SwingUtilities.invokeLater(() -> reviewSummary.setText("批准失败：" + ex.getMessage()));
            }
        });
    }

    /** 缺陷：按已批准方案修复（未批准拦截）——派 Qoder 实施（defect_dispatch 模板） */
    private void fixDefectWithQoder() {
        if (currentNodeId < 0) {
            reviewSummary.setText("请先从节点树进入一个缺陷节点");
            return;
        }
        final long defectId = currentNodeId;
        final String nodeName = currentNodeName;
        ApplicationManager.getApplication().executeOnPooledThread(() -> {
            try {
                String approval = defectDocContent(defectId, "修复方案审批");
                if (!approval.contains("已批准")) {
                    SwingUtilities.invokeLater(() -> reviewSummary.setText(
                            "该缺陷尚未批准修复方案——请先「分析根因」并「批准修复方案」（合法提交前置要求）"));
                    return;
                }
                String desc = defectDocContent(defectId, "缺陷描述");
                String analysis = defectDocContent(defectId, "根因与修复方案");
                String[] info = null;
                com.intellij.openapi.editor.Editor editor =
                        FileEditorManagerEx.getInstanceEx(project).getSelectedTextEditor();
                if (editor == null || editor.isDisposed() || !editor.getSelectionModel().hasSelection()) {
                    com.intellij.openapi.editor.Editor fb = lastSelectionEditor;
                    if (fb != null && !fb.isDisposed() && fb.getSelectionModel().hasSelection()) {
                        editor = fb;
                    }
                }
                if (editor != null && !editor.isDisposed()) {
                    info = diffFileAndLines(editor);
                }
                String tpl = loadPromptTemplate("defect_dispatch", DEFAULT_DEFECT_DISPATCH);
                java.util.Map<String, String> vars = new java.util.HashMap<>();
                vars.put("defectId", String.valueOf(defectId));
                vars.put("title", nodeName);
                vars.put("desc", desc.trim().isEmpty() ? "（见节点文档「缺陷描述」）" : desc);
                vars.put("locationSection", buildLocationSection(info));
                vars.put("analysisSection", analysis.trim().isEmpty() ? "" : ("## 已批准的根因与修复方案\n\n" + analysis + "\n"));
                final String prompt = applyTemplate(tpl, vars);
                SwingUtilities.invokeLater(() -> {
                    boolean ok = QoderOpener.dispatch(project, prompt);
                    reviewSummary.setText(ok
                            ? "已派 Qoder 修复（defect #" + defectId + "）——⌘V+回车发送；修复提交后登记到该缺陷节点"
                            : "修复提示词已复制——请手动打开 Qoder 粘贴");
                });
            } catch (Exception ex) {
                SwingUtilities.invokeLater(() -> reviewSummary.setText("派修复失败：" + ex.getMessage()));
            }
        });
    }

    private static final String DEFAULT_DEFECT_ANALYZE =
            "你是 Qoder Agent。请对以下 task-board 缺陷（defect #{{defectId}}）做根因分析与修复方案设计（先不要改代码）。\n\n"
                    + "# 缺陷：{{title}}\n\n{{desc}}\n\n{{locationSection}}\n"
                    + "## 输出要求\n\n1. 根因（Root Cause）：定位到具体文件/函数/逻辑\n2. 修复方案：改动点清单 + 影响面 + 验证方式\n3. 风险与备选方案（如有）\n";

    private static final String DEFAULT_DEFECT_DISPATCH =
            "你是 Qoder Agent。以下 task-board 缺陷（defect #{{defectId}}）的根因与修复方案已经审核批准，请按方案实施修复。\n\n"
                    + "# 缺陷：{{title}}\n\n{{desc}}\n\n{{locationSection}}\n{{analysisSection}}\n"
                    + "## 要求\n\n严格按已批准的修复方案实施；完成后给出变更摘要与验证方式。\n";

    /** 把缺陷派给 Qoder（提示词 = 缺陷 + 位置 + 选中代码 + 要求） */
    private void dispatchDefectToQoder(long defectId, String title, String desc, String[] info) {
        StringBuilder md = new StringBuilder();
        md.append("你是 Qoder Agent。请修复以下 task-board 缺陷（defect #").append(defectId).append("）。\n\n");
        md.append("# 缺陷：").append(title).append("\n\n");
        if (desc != null && !desc.trim().isEmpty()) {
            md.append(desc).append("\n\n");
        }
        if (info != null) {
            md.append("## 位置\n\n- 文件：`").append(info[0]).append("`\n- 行号：L")
                    .append(info[1]).append("-").append(info[2]).append("\n\n");
            if (!info[3].isEmpty()) {
                md.append("## 选中代码\n\n```\n").append(info[3]).append("\n```\n\n");
            }
        }
        md.append("## 要求\n\n定位并修复；修复后给出变更摘要与验证方式（可使用 task-board MCP 工具回写状态）。\n");
        final String prompt = md.toString();
        SwingUtilities.invokeLater(() -> {
            boolean ok = QoderOpener.dispatch(project, prompt);
            reviewSummary.setText(ok
                    ? "已派给 Qoder（缺陷 #" + defectId + "）——⌘V+回车发送，修复后可在树中看到该 defect 节点"
                    : "缺陷提示词已复制——请手动打开 Qoder 面板粘贴");
        });
    }

    /** 查看合入状态（组/子需求：各子任务开发分支是否已合入需求分支） */
    private void showMergeStatus() {
        if (currentNodeId < 0) {
            reviewSummary.setText("请先从节点树进入一个节点");
            return;
        }
        final long nodeId = currentNodeId;
        final String nodeName = currentNodeName;
        ApplicationManager.getApplication().executeOnPooledThread(() -> {
            try {
                JsonObject d = api.mergeStatus(nodeId);
                JsonArray items = d.getAsJsonArray("items");
                StringBuilder sb = new StringBuilder();
                sb.append("需求分支：").append(str(d, "reqBranch", "(未配置)")).append("\n");
                sb.append("已合入：").append(d.get("mergedCount").getAsInt()).append("/").append(d.get("total").getAsInt()).append("\n\n");
                if (items != null) {
                    for (JsonElement el : items) {
                        JsonObject it = el.getAsJsonObject();
                        boolean ok = it.has("allMerged") && it.get("allMerged").getAsBoolean();
                        sb.append(ok ? "✓ " : "✗ ").append(str(it, "name", "")).append("\n");
                        JsonArray details = it.getAsJsonArray("details");
                        if (details != null) {
                            for (JsonElement de : details) {
                                JsonObject dt = de.getAsJsonObject();
                                boolean m = dt.has("merged") && dt.get("merged").getAsBoolean();
                                sb.append("    ").append(m ? "已合入" : "未合入").append("  ")
                                        .append(str(dt, "repo", "")).append(" / ").append(str(dt, "branch", "")).append("\n");
                            }
                        }
                    }
                }
                final String text = sb.toString();
                SwingUtilities.invokeLater(() -> Messages.showMultilineInputDialog(project,
                        "合入状态（" + nodeName + "）：", "合入状态", text, null, null));
            } catch (Exception ex) {
                SwingUtilities.invokeLater(() -> reviewSummary.setText("加载合入状态失败：" + ex.getMessage()));
            }
        });
    }

    /** 合并预览（MR 式）：待合并分支将引入的变更文件/增删统计 + 冲突预判 */
    private void showMergePreview() {
        if (currentNodeId < 0) {
            reviewSummary.setText("请先从节点树进入一个子任务");
            return;
        }
        final long nodeId = currentNodeId;
        final String nodeName = currentNodeName;
        ApplicationManager.getApplication().executeOnPooledThread(() -> {
            try {
                JsonObject d = api.mergePreview(nodeId);
                JsonArray items = d.getAsJsonArray("items");
                StringBuilder sb = new StringBuilder();
                sb.append("需求分支（target）：").append(str(d, "reqBranch", "")).append("\n\n");
                if (items == null || items.size() == 0) {
                    sb.append("（无待合并的提交/分支）\n");
                } else {
                    for (JsonElement el : items) {
                        JsonObject it = el.getAsJsonObject();
                        String repo = str(it, "repo", "");
                        String src = str(it, "source", "");
                        if (it.has("alreadyMerged") && it.get("alreadyMerged").getAsBoolean()) {
                            sb.append("✓ ").append(repo).append("  ").append(src).append("  （已合入，无需合并）\n");
                            continue;
                        }
                        if (!it.has("ok") || !it.get("ok").getAsBoolean()) {
                            sb.append("✗ ").append(repo).append("  ").append(src).append("  ：")
                                    .append(str(it, "reason", ""));
                            if (it.has("message")) {
                                sb.append(" ").append(str(it, "message", "").split("\n")[0]);
                            }
                            sb.append("\n");
                            continue;
                        }
                        boolean conflicted = it.has("conflicted") && it.get("conflicted").getAsBoolean();
                        sb.append(conflicted ? "⚠ " : "→ ").append(repo).append("  ").append(src)
                                .append(" → ").append(str(it, "target", "")).append("\n");
                        if (conflicted) {
                            sb.append("    ⚠ 有冲突（需先解决）：\n");
                            JsonArray cf = it.getAsJsonArray("conflictFiles");
                            if (cf != null) {
                                for (JsonElement ce : cf) {
                                    sb.append("      - ").append(ce.getAsString()).append("\n");
                                }
                            }
                        }
                        JsonArray wi = it.getAsJsonArray("willIntroduce");
                        if (wi != null && wi.size() > 0) {
                            sb.append("    将引入变更（").append(wi.size()).append("）：\n");
                            int cnt = 0;
                            for (JsonElement we : wi) {
                                if (cnt++ >= 20) {
                                    sb.append("      …\n");
                                    break;
                                }
                                JsonObject w = we.getAsJsonObject();
                                sb.append("      ").append(str(w, "file", ""))
                                        .append("  +" ).append(w.get("add").getAsInt())
                                        .append(" -").append(w.get("del").getAsInt()).append("\n");
                            }
                        }
                    }
                }
                final String text = sb.toString();
                SwingUtilities.invokeLater(() -> Messages.showMultilineInputDialog(project,
                        "合并预览（" + nodeName + "）：", "合并预览（将合入的变更与冲突预判）", text, null, null));
            } catch (Exception ex) {
                SwingUtilities.invokeLater(() -> reviewSummary.setText("合并预览失败：" + ex.getMessage()));
            }
        });
    }

    /** 上跳合并：子需求「需求分支」→ feature-merge（可增量重复合：已合入跳过，有新内容再合） */
    private void mergeToFeatureMerge() {
        if (currentNodeId < 0) {
            reviewSummary.setText("请先从节点树进入一个子需求节点");
            return;
        }
        final long nodeId = currentNodeId;
        final String nodeName = currentNodeName;
        ApplicationManager.getApplication().executeOnPooledThread(() -> {
            try {
                JsonObject res = api.mergeUpstream(nodeId, "feature-merge");
                JsonArray results = res.getAsJsonArray("results");
                StringBuilder sb = new StringBuilder();
                boolean anyFail = false;
                boolean anyMerged = false;
                if (results != null) {
                    for (JsonElement el : results) {
                        JsonObject r = el.getAsJsonObject();
                        String repo = str(r, "repo", "");
                        boolean ok = r.has("ok") && r.get("ok").getAsBoolean();
                        if (ok && r.has("alreadyMerged") && r.get("alreadyMerged").getAsBoolean()) {
                            sb.append("✓ ").append(repo).append("（已合入，跳过）\n");
                        } else if (ok) {
                            anyMerged = true;
                            sb.append("✓ ").append(repo).append(" 已合并（mergeSha ")
                                    .append(str(r, "mergeSha", "").length() > 9 ? str(r, "mergeSha", "").substring(0, 9) : str(r, "mergeSha", ""))
                                    .append("）\n");
                        } else {
                            anyFail = true;
                            sb.append("✗ ").append(repo).append("：").append(str(r, "reason", ""));
                            if (r.has("message")) {
                                sb.append(" ").append(str(r, "message", "").split("\n")[0]);
                            }
                            sb.append("\n");
                        }
                    }
                }
                final String text = "上跳合并（" + str(res, "sourceBranch", "") + " → " + str(res, "targetBranch", "") + "）：\n\n" + sb;
                final boolean fail = anyFail;
                final boolean merged = anyMerged;
                SwingUtilities.invokeLater(() -> {
                    if (fail) {
                        Messages.showWarningDialog(project, text + "\n有冲突/失败——请先在终端解决后重试。", "合并到 feature-merge");
                        return;
                    }
                    if (!merged) {
                        reviewSummary.setText("已是最新（无新增内容需合并）：" + nodeName);
                        Messages.showInfoMessage(project, text + "\n无新增内容，无需重复合并。", "合并到 feature-merge");
                        return;
                    }
                    reviewSummary.setText("已合并到 feature-merge：" + nodeName);
                    Messages.showInfoMessage(project, text, "合并到 feature-merge 完成");
                });
            } catch (Exception ex) {
                SwingUtilities.invokeLater(() -> reviewSummary.setText("上跳合并失败：" + ex.getMessage()));
            }
        });
    }

    /** 复制当前 review 上下文 markdown 到剪贴板（可粘贴到 Qoder 对话） */
    private void copyReviewContext() {
        try {
            StringBuilder md = new StringBuilder();
            md.append("## task-board 当前 review 上下文\n");
            md.append("- **节点**：").append(currentNodeName).append("（id=").append(currentNodeId).append("）\n");
            List<CommitItem> sel = checkedCommits();
            md.append("- **勾选提交（").append(sel.size()).append("）**\n");
            for (CommitItem it : sel) {
                String sha = it.sha == null ? "" : it.sha;
                md.append("  - `").append(sha.length() > 10 ? sha.substring(0, 10) : sha).append("` ")
                        .append(it.note == null ? "" : it.note)
                        .append("（").append(it.repo == null ? "" : it.repo).append("）\n");
            }
            int fileCount = aggregateFiles == null ? 0 : aggregateFiles.size();
            if (fileCount > 0) {
                md.append("- **变更文件（").append(fileCount).append("）**\n");
                for (DiffOpener.FileDiff f : aggregateFiles) {
                    md.append("  - ").append(f.path).append("\n");
                }
            }
            CopyPasteManager.getInstance().setContents(new StringSelection(md.toString()));
            reviewSummary.setText("已复制当前 review 上下文（" + sel.size() + " 提交 / " + fileCount
                    + " 文件），可直接粘贴给 Qoder");
        } catch (Throwable t) {
            reviewSummary.setText("复制失败：" + t.getMessage());
        }
    }

    /** diff 栏显隐（开关回调）：勾选=显示 */
    private void setDiffPaneVisible(boolean visible) {
        try {
            if (visible) {
                showDiffPane();
            } else {
                DiffOpener.closeCurrent(project);
                reviewSummary.setText("已隐藏 diff 栏（勾选「diff」可恢复）");
            }
        } catch (Exception ex) {
            reviewSummary.setText("切换 diff 栏失败：" + ex.getMessage());
        }
    }

    /** 显示 diff 栏：无并排布局时重铺对照布局；否则打开当前聚合变更 */
    private void showDiffPane() {
        try {
            FileEditorManagerEx fem = FileEditorManagerEx.getInstanceEx(project);
            // 已有实例：直接激活，避免在新组再开一份副本
            VirtualFile existing = DiffOpener.currentFile();
            if (existing != null && existing.isValid() && fem.getEditors(existing).length > 0) {
                fem.openFile(existing, true);
                reviewSummary.setText("已显示 diff 栏");
                return;
            }
            // 只开 diff（不重铺、不连带文档；需要完整布局时用「对照布局」）
            List<DiffOpener.FileDiff> files = aggregateFiles;
            if (files != null && !files.isEmpty()) {
                DiffOpener.openCombined(project, aggregateTitle, files, null);
            } else {
                CommitItem sel = selectedCommit();
                if (sel != null) {
                    DiffOpener.open(project, api, sel.cid, sel.sha, null);
                } else {
                    reviewSummary.setText("当前没有可展示的变更（先选节点/勾选提交）");
                    return;
                }
            }
            reviewSummary.setText("已显示 diff 栏");
        } catch (Exception ex) {
            reviewSummary.setText("显示 diff 失败：" + ex.getMessage());
        }
    }

    /** 诊断日志（/tmp/taskboard-plugin.log；定位 tab 残留问题用） */
    private static void diag(String msg) {
        try {
            Files.writeString(
                    java.nio.file.Paths.get(System.getProperty("java.io.tmpdir"), "taskboard-plugin.log"),
                    "[" + java.time.LocalTime.now().withNano(0) + "] " + msg + "\n",
                    java.nio.file.StandardOpenOption.CREATE, java.nio.file.StandardOpenOption.APPEND);
        } catch (Throwable ignore) {
            // 诊断失败不影响业务
        }
    }

    /** 枚举当前所有编辑器组的文件（诊断用） */
    private String dumpWindows() {
        try {
            StringBuilder sb = new StringBuilder();
            FileEditorManagerEx femEx = FileEditorManagerEx.getInstanceEx(project);
            int i = 0;
            for (EditorWindow w : femEx.getWindows()) {
                sb.append("  [组").append(i++).append("] ");
                for (VirtualFile f : w.getFiles()) {
                    sb.append(f.getName()).append("(").append(f.getClass().getSimpleName()).append(") ");
                }
                sb.append("\n");
            }
            return sb.length() == 0 ? "  （无编辑器组）\n" : sb.toString();
        } catch (Throwable t) {
            return "  dump error: " + t + "\n";
        }
    }

    /** 文档窗口显隐（开关回调）：勾选=显示 */
    private void setDocsPaneVisible(boolean visible) {
        if (visible) {
            showDocsPane();
            return;
        }
        try {
            diag("hideDocsPane 开始：\n" + dumpWindows());
            FileEditorManagerEx fem = FileEditorManagerEx.getInstanceEx(project);
            String docsPath = java.nio.file.Paths.get(System.getProperty("java.io.tmpdir"),
                    "taskboard-docs", "taskboard-需求概设.md").toString();
            VirtualFile docsVf = LocalFileSystem.getInstance().findFileByPath(docsPath);
            // 先定位"文档所在的编辑器组"（关内容前）
            EditorWindow docWin = null;
            VirtualFile prdBef = PrdOpener.currentFile();
            for (EditorWindow w : fem.getWindows()) {
                for (VirtualFile f : w.getFiles()) {
                    if ((docsVf != null && f.equals(docsVf))
                            || (prdBef != null && prdBef.isValid() && f.equals(prdBef))) {
                        docWin = w;
                        break;
                    }
                }
                if (docWin != null) {
                    break;
                }
            }
            if (docsVf != null) {
                fem.closeFile(docsVf);
            }
            PrdOpener.closeAll(project);
            diag("closeAll 完成：\n" + dumpWindows());
            // 清理：若该组里残留"我们的 diff 副本"，关掉它（避免收起文档后露出重复 diff）
            VirtualFile diff = DiffOpener.currentFile();
            if (docWin != null && diff != null && diff.isValid()) {
                try {
                    for (VirtualFile f : docWin.getFiles()) {
                        if (f.equals(diff)) {
                            fem.closeFile(diff, docWin);
                            break;
                        }
                    }
                } catch (Throwable ignore) {
                    // 组已失效等情况忽略
                }
            }
            // 该组已空则移除空分屏
            if (docWin != null) {
                try {
                    if (docWin.getFiles().length == 0) {
                        docWin.removeFromSplitter();
                    }
                } catch (Throwable ignore) {
                    // 平台可能已自动移除
                }
            }
            // 收起后把焦点落回 diff（避免平台跳到无关文件，如用户之前打开过的源码）
            try {
                VirtualFile diffKeep = DiffOpener.currentFile();
                if (diffKeep != null && diffKeep.isValid() && fem.getEditors(diffKeep).length > 0) {
                    fem.openFile(diffKeep, true);
                }
            } catch (Throwable ignore) {
                // 焦点恢复失败不影响主体
            }
            diag("hideDocsPane 完成：\n" + dumpWindows());
            reviewSummary.setText("已隐藏文档窗口（勾选「文档」可恢复）");
        } catch (Exception ex) {
            reviewSummary.setText("隐藏文档窗口失败：" + ex.getMessage());
        }
    }

    /** 显示文档窗口：重建右列（需求概设 + PRD 两个 tab，点 tab 切换） */
    private void showDocsPane() {
        ApplicationManager.getApplication().executeOnPooledThread(() -> {
            try {
                JsonArray docs = currentNodeId >= 0 ? api.nodeDocuments(currentNodeId) : null;
                String prdUrl = null;
                try {
                    prdUrl = currentNodeId >= 0 ? findPrdUrl(currentNodeId) : null;
                } catch (Exception ignore) {
                    // 无 PRD 不阻断
                }
                final JsonArray finalDocs = docs;
                final String finalPrdUrl = prdUrl;
                SwingUtilities.invokeLater(() -> {
                    try {
                        if ((finalDocs == null || finalDocs.size() == 0) && finalPrdUrl == null) {
                            reviewSummary.setText("该节点暂无文档且未配置 PRD 链接");
                            if (reviewToolbar != null) {
                                reviewToolbar.updateActionsImmediately();
                            }
                            return;
                        }
                        FileEditorManagerEx fem = FileEditorManagerEx.getInstanceEx(project);
                        EditorWindow main = fem.getCurrentWindow();
                        EditorWindow docWin = null;
                        if (finalDocs != null && finalDocs.size() > 0 && main != null) {
                            VirtualFile vf = buildDocsFile(finalDocs, finalPrdUrl);
                            if (vf != null) {
                                docWin = main.split(JSplitPane.HORIZONTAL_SPLIT, true, vf, true);
                            }
                        }
                        if (finalPrdUrl != null) {
                            PrdVirtualFile prd = PrdOpener.prepare(project, finalPrdUrl, currentNodeName);
                            if (prd != null) {
                                if (docWin != null) {
                                    fem.openFile(prd, false);
                                } else {
                                    fem.openFile(prd, true);
                                }
                            }
                        }
                        // 宽度与「布局设置」一致
                        final EditorWindow mainRef = main;
                        Timer t = new Timer(400, ev -> {
                            ((Timer) ev.getSource()).stop();
                            applyTopSplitterProportion(mainRef, LayoutPrefs.diffRatio());
                        });
                        t.setRepeats(false);
                        t.start();
                        reviewSummary.setText("已显示文档窗口（需求概设/PRD 两个 tab，点 tab 切换）");
                    } catch (Exception ex) {
                        reviewSummary.setText("显示文档窗口失败：" + ex.getMessage());
                    }
                });
            } catch (Exception ex) {
                SwingUtilities.invokeLater(() -> reviewSummary.setText("显示文档窗口失败：" + ex.getMessage()));
            }
        });
    }

    /** 在「需求概设」与「飞书 PRD」之间切换（右列同一组内的两个 tab） */
    private void toggleDocsPrd() {
        if (currentNodeId < 0) {
            reviewSummary.setText("请先从节点树进入一个节点");
            return;
        }
        final long nodeId = currentNodeId;
        final String nodeName = currentNodeName;
        ApplicationManager.getApplication().executeOnPooledThread(() -> {
            try {
                JsonArray docs = api.nodeDocuments(nodeId);
                String prdUrl = null;
                try {
                    prdUrl = findPrdUrl(nodeId);
                } catch (Exception ignore) {
                    // 无 PRD 不阻断
                }
                final JsonArray finalDocs = docs;
                final String finalPrdUrl = prdUrl;
                SwingUtilities.invokeLater(() -> {
                    try {
                        FileEditorManagerEx fem = FileEditorManagerEx.getInstanceEx(project);
                        String docsPath = java.nio.file.Paths.get(System.getProperty("java.io.tmpdir"),
                                "taskboard-docs", "taskboard-需求概设.md").toString();
                        VirtualFile docsVf = LocalFileSystem.getInstance().findFileByPath(docsPath);
                        if (docsVf == null) {
                            docsVf = buildDocsFile(finalDocs, finalPrdUrl);
                        }
                        VirtualFile prdVf = PrdOpener.currentFile();
                        boolean prdActive = prdVf != null && isActiveFile(fem, prdVf);
                        boolean docsAvailable = docsVf != null;
                        if (!docsAvailable && (finalPrdUrl == null || !finalPrdUrl.isEmpty())) {
                            // 还可尝试开 PRD
                        }
                        if (!docsAvailable && finalPrdUrl == null) {
                            reviewSummary.setText("该节点暂无文档且未配置 PRD 链接");
                            return;
                        }
                        if (prdActive && docsAvailable) {
                            fem.openFile(docsVf, true);
                            reviewSummary.setText("已切换到：需求概设");
                            return;
                        }
                        // 切换到 PRD
                        if (prdVf == null || !prdVf.isValid()) {
                            if (finalPrdUrl == null) {
                                if (docsAvailable) {
                                    fem.openFile(docsVf, true);
                                    reviewSummary.setText("未配置 PRD 链接，保持需求概设");
                                }
                                return;
                            }
                            prdVf = PrdOpener.prepare(project, finalPrdUrl, nodeName);
                        }
                        if (prdVf != null) {
                            fem.openFile(prdVf, true);
                            reviewSummary.setText("已切换到：飞书 PRD");
                        } else if (docsAvailable) {
                            fem.openFile(docsVf, true);
                        }
                    } catch (Exception ex) {
                        reviewSummary.setText("切换失败：" + ex.getMessage());
                    }
                });
            } catch (Exception ex) {
                SwingUtilities.invokeLater(() -> reviewSummary.setText("切换失败：" + ex.getMessage()));
            }
        });
    }

    /** 指定文件是否当前激活 */
    private static boolean isActiveFile(FileEditorManagerEx fem, VirtualFile vf) {
        try {
            for (VirtualFile f : fem.getSelectedFiles()) {
                if (f == vf || f.equals(vf)) {
                    return true;
                }
            }
        } catch (Throwable ignore) {
            // 忽略
        }
        return false;
    }

    /** 把 TaskBoard 工具窗停靠到底部并占约配置比例高度（与上方 diff 形成上下结构） */
    private void applyTaskBoardBottom(Project project) {
        try {
            final com.intellij.openapi.wm.ToolWindow tw = com.intellij.openapi.wm.ToolWindowManager.getInstance(project)
                    .getToolWindow("TaskBoard");
            if (tw == null) {
                return;
            }
            if (tw.getAnchor() != com.intellij.openapi.wm.ToolWindowAnchor.BOTTOM) {
                // postRunnable：停靠完成后立即设一次高度
                tw.setAnchor(com.intellij.openapi.wm.ToolWindowAnchor.BOTTOM, () -> setToolWindowHeight(tw));
            }
            tw.show();
            // 停靠动画可能延迟回写尺寸：多个时间点重复设置高度
            for (int delay : new int[]{350, 1000, 1800, 2800}) {
                Timer t = new Timer(delay, ev -> {
                    ((Timer) ev.getSource()).stop();
                    setToolWindowHeight(tw);
                });
                t.setRepeats(false);
                t.start();
            }
        } catch (Throwable ignore) {
            // 工具窗停靠失败不阻断布局
        }
    }

    /** 按配置比例设置 TaskBoard 高度（仅当已停靠底部时生效） */
    private void setToolWindowHeight(com.intellij.openapi.wm.ToolWindow tw) {
        try {
            if (tw.getAnchor() != com.intellij.openapi.wm.ToolWindowAnchor.BOTTOM) {
                return;
            }
            if (tw instanceof com.intellij.openapi.wm.ex.ToolWindowEx twEx) {
                java.awt.Window win = SwingUtilities.getWindowAncestor(tw.getComponent());
                int frameH = win != null ? win.getHeight() : 900;
                int target = Math.max(200, (int) (frameH * LayoutPrefs.toolWindowRatio()));
                // 平台语义：stretchHeight 是「增量」（当前高度 + value）——因此传目标与当前的差值
                int current = tw.getComponent() != null ? tw.getComponent().getHeight() : 0;
                int delta = target - current;
                if (delta != 0) {
                    twEx.stretchHeight(delta);
                }
            }
        } catch (Throwable ignore) {
            // 忽略
        }
    }

    /** 把窗口所在最外层 Splitter 的比例设为 p（调整分屏宽度分配），失败静默 */
    private static void applyTopSplitterProportion(EditorWindow window, float p) {
        try {
            if (window == null) return;
            java.awt.Component c = window.getComponent$intellij_platform_ide_impl();
            com.intellij.openapi.ui.Splitter top = null;
            while (c != null) {
                if (c instanceof com.intellij.openapi.ui.Splitter s) {
                    top = s;
                }
                c = c.getParent();
            }
            if (top != null) {
                top.setProportion(p);
                // 记录并监听拖动（自动记住比例）
                lastTopSplitter = top;
                top.removePropertyChangeListener(RATIO_SAVER);
                top.addPropertyChangeListener(RATIO_SAVER);
            }
        } catch (Throwable ignore) {
            // 平台差异时忽略
        }
    }

    /** 布局比例设置：保存后即时应用到已铺布局 */
    private void openLayoutSettings() {
        new LayoutSettingsDialog(project, () -> {
            if (lastTopSplitter != null) {
                try {
                    lastTopSplitter.setProportion(LayoutPrefs.diffRatio());
                } catch (Throwable ignore) {
                    // 忽略
                }
            }
            applyTaskBoardBottom(project);
            reviewSummary.setText("布局比例已更新：diff " + Math.round(LayoutPrefs.diffRatio() * 100)
                    + "% / TaskBoard " + Math.round(LayoutPrefs.toolWindowRatio() * 100) + "%");
        }).show();
    }

    /** 上溯到需求节点取飞书 PRD 链接；节点（或需求节点）配置 prdAnchor 时拼接锚点 */
    private String findPrdUrl(long startId) throws Exception {
        long id = startId;
        for (int depth = 0; depth < 10 && id > 0; depth++) {
            JsonObject node = api.nodeGet(id);
            if ("requirement".equals(str(node, "type", ""))) {
                JsonObject reqAttrs = node.has("attrs") && node.get("attrs").isJsonObject()
                        ? node.getAsJsonObject("attrs") : null;
                String url = null;
                if (reqAttrs != null && reqAttrs.has("feishu_url") && !reqAttrs.get("feishu_url").isJsonNull()) {
                    url = reqAttrs.get("feishu_url").getAsString();
                }
                if (url == null) return null;
                String anchor = attr(startId, "prdAnchor");
                if (anchor == null) anchor = reqAttrs != null ? attrOf(reqAttrs, "prdAnchor") : null;
                if (anchor != null && !anchor.isEmpty()) {
                    url = url + (anchor.startsWith("#") ? anchor : "#" + anchor);
                }
                return url;
            }
            if (!node.has("parentId") || node.get("parentId").isJsonNull()) return null;
            id = node.get("parentId").getAsLong();
        }
        return null;
    }

    private String attr(long nodeId, String key) {
        try {
            JsonObject node = api.nodeGet(nodeId);
            if (node.has("attrs") && node.get("attrs").isJsonObject()) {
                return attrOf(node.getAsJsonObject("attrs"), key);
            }
        } catch (Exception ignore) {
            // 忽略
        }
        return null;
    }

    private static String attrOf(JsonObject attrs, String key) {
        return attrs != null && attrs.has(key) && !attrs.get(key).isJsonNull() ? attrs.get(key).getAsString() : null;
    }

    /** 构建合并 markdown（固定单文件，含 PRD 链接行与节点标题）并返回 VirtualFile；失败返回 null */
    private VirtualFile buildDocsFile(JsonArray docs, String prdUrl) {
        try {
            if (docs == null || docs.size() == 0) {
                return null;
            }
            StringBuilder md = new StringBuilder();
            md.append("# ").append(currentNodeName).append("\n\n");
            if (prdUrl != null) {
                md.append("> 📄 **PRD（飞书）**：[打开需求文档](").append(prdUrl).append(")　·　本节点对应章节：**")
                        .append(currentNodeName).append("**\n\n");
            }
            for (JsonElement el : docs) {
                JsonObject d = el.getAsJsonObject();
                md.append("## ").append(str(d, "name", "文档")).append("\n\n");
                md.append(str(d, "content", "")).append("\n\n---\n\n");
            }
            // 固定单文件（所有节点共用同一文件 → openFile 自动复用 tab，不会堆积）
            Path dir = java.nio.file.Paths.get(System.getProperty("java.io.tmpdir"), "taskboard-docs");
            Files.createDirectories(dir);
            Path file = dir.resolve("taskboard-需求概设.md");
            Files.writeString(file, md.toString());
            return LocalFileSystem.getInstance().refreshAndFindFileByPath(file.toString());
        } catch (Exception ex) {
            reviewSummary.setText("构建文档失败：" + ex.getMessage());
            return null;
        }
    }

    // ---------- 网页 → IDEA 桥（轮询领取打开请求） ----------

    /** 每 3 秒轮询一次是否有网页发来的打开请求（本地轻量 GET，无请求时静默） */
    private void startIdeBridgePolling() {
        Timer timer = new Timer(3000, e -> pollIdeRequest());
        timer.setInitialDelay(1500);
        timer.start();
    }

    private void pollIdeRequest() {
        ApplicationManager.getApplication().executeOnPooledThread(() -> {
            try {
                JsonObject req = api.getNextIdeRequest();
                if (req == null || !req.has("id")) return;
                long id = req.get("id").getAsLong();
                SwingUtilities.invokeLater(() -> openIdeRequest(req));
                api.completeIdeRequest(id); // 请求已受理（打开动作已发起）
            } catch (Exception ignore) {
                // 服务不可用/网络异常：静默，下轮重试
            }
        });
    }

    /** 打开网页请求的 diff：单 commit 直接定位文件；多 commit 走合并变更链 */
    private void openIdeRequest(JsonObject req) {
        JsonArray cids = req.getAsJsonArray("cids");
        if (cids == null || cids.size() == 0) return;
        String path = str(req, "path", null);
        String title = str(req, "title", null);
        if (cids.size() == 1) {
            long cid = cids.get(0).getAsLong();
            String sha = "";
            JsonArray commits = req.getAsJsonArray("commits");
            if (commits != null && commits.size() > 0) {
                sha = str(commits.get(0).getAsJsonObject(), "sha", "");
            }
            DiffOpener.open(project, api, cid, sha, path);
            return;
        }
        long[] ids = new long[cids.size()];
        for (int i = 0; i < cids.size(); i++) ids[i] = cids.get(i).getAsLong();
        final String finalTitle = (title == null || title.isEmpty())
                ? "网页请求 · " + ids.length + " commits" : title;
        final String finalPath = path;
        ApplicationManager.getApplication().executeOnPooledThread(() -> {
            try {
                JsonObject res = api.combinedDiff(ids);
                List<DiffOpener.FileDiff> files = new ArrayList<>();
                JsonArray repos = res.getAsJsonArray("repos");
                if (repos != null) {
                    for (JsonElement rel : repos) {
                        JsonArray fs = rel.getAsJsonObject().getAsJsonArray("files");
                        if (fs == null) continue;
                        for (JsonElement fe : fs) {
                            JsonObject f = fe.getAsJsonObject();
                            if (f.has("binary") && f.get("binary").getAsBoolean()) continue;
                            files.add(new DiffOpener.FileDiff(
                                    f.get("path").getAsString(),
                                    str(f, "old", ""),
                                    str(f, "new", "")));
                        }
                    }
                }
                SwingUtilities.invokeLater(() -> DiffOpener.openCombined(project, finalTitle, files, finalPath));
            } catch (Exception ex) {
                SwingUtilities.invokeLater(() -> Messages.showErrorDialog(project,
                        "打开网页请求的 diff 失败：" + ex.getMessage(), "TaskBoard"));
            }
        });
    }

    /** 上次铺设的顶层 Splitter（供实时应用/记忆比例用） */
    private static com.intellij.openapi.ui.Splitter lastTopSplitter;
    /** Review 工具条（开关点击后刷新勾选状态） */
    private ActionToolbar reviewToolbar;
    /** Select 视图右侧详情面板：Markdown → HTML，交给 JCEF 渲染（Swing 的 JEditorPane HTML 布局会 BoxView 死循环） */
    private com.intellij.ui.jcef.JBCefBrowser selectDetailBrowser;
    /** 详情区降级面（JCEF 不可用时用纯文本，去 # 与代码围栏） */
    private javax.swing.JTextArea selectDetailFallback;
    /** 当前详情节点的飞书 PRD 链接（「PRD」按钮用） */
    private String selectDetailPrdUrl;
    /** 详情已加载的节点 id（避免重复拉取） */
    private long selectDetailLoadedId = -1;
    /** 详情已加载的节点名（供内置打开 PRD 时作 tab 标题） */
    private String selectDetailLoadedName = "";
    /** 选区捕获防抖定时器 */
    private Timer selectionTimer;
    /** 最近一次有选区的编辑器（点按钮时焦点已离开编辑器，getSelectedTextEditor 会变 null） */
    private volatile com.intellij.openapi.editor.Editor lastSelectionEditor;
    /** 用户拖动分隔条时自动记住 diff 宽度比例 */
    private static final java.beans.PropertyChangeListener RATIO_SAVER = evt -> {
        if ("proportion".equals(evt.getPropertyName()) && evt.getSource() == lastTopSplitter
                && evt.getNewValue() instanceof Float f) {
            LayoutPrefs.setDiffRatio(f);
        }
    };

    /** 便捷：往动作组加一个带图标的开关（勾选=显示；点击后立即刷新工具条状态） */
    private void addToggle(DefaultActionGroup group, String text, String desc, Icon icon,
                           java.util.function.BooleanSupplier isOn,
                           java.util.function.Consumer<Boolean> setOn) {
        group.add(new ToggleAction(text, desc, icon) {
            @Override
            public boolean isSelected(@NotNull AnActionEvent e) {
                try {
                    return isOn.getAsBoolean();
                } catch (Throwable t) {
                    return false;
                }
            }

            @Override
            public void update(@NotNull AnActionEvent e) {
                super.update(e);
                // 勾选态可视化：☑/☐ 前缀 + 选中时的 Checked 图标
                boolean on = isSelected(e);
                e.getPresentation().setText((on ? "☑ " : "☐ ") + text);
                e.getPresentation().setIcon(on ? AllIcons.Actions.Checked : null);
            }

            @Override
            public void setSelected(@NotNull AnActionEvent e, boolean state) {
                setOn.accept(state);
                if (reviewToolbar != null) {
                    reviewToolbar.updateActionsImmediately();
                }
            }
        });
    }

    /** 便捷：往动作组加一个带图标动作 */
    private void addAction(DefaultActionGroup group, String text, String desc, Icon icon, Runnable runnable) {
        group.add(new AnAction(text, desc, icon) {
            @Override
            public void actionPerformed(@NotNull AnActionEvent e) {
                runnable.run();
            }
        });
    }

    // ================= 视图 A：节点选择 =================

    private JPanel buildSelectView() {
        JPanel p = new JPanel(new BorderLayout());

        DefaultActionGroup group = new DefaultActionGroup();
        addAction(group, "刷新", "重新加载需求树（" + api.base() + "）", AllIcons.Actions.Refresh, this::reloadTree);
        addAction(group, "拷贝上下文", "复制选中节点的上下文（节点信息+文档+PRD）到剪贴板", AllIcons.Actions.Copy, this::copySelectContext);
        addAction(group, "拷贝节点ID", "复制选中节点的 id 与名称（如 114 · 1.4 新增…）", AllIcons.Actions.Show, this::copySelectNodeId);
        addAction(group, "搜索", "按名称搜索节点并定位", AllIcons.Actions.Find, this::searchSelectNode);
        addAction(group, "PRD", "在 IDEA 内置 PRD tab（JCEF）打开当前节点的飞书 PRD", AllIcons.General.Web, this::openSelectPrd);
        ActionToolbar toolbar = ActionManager.getInstance().createActionToolbar("TaskBoardSelect", group, true);
        toolbar.setTargetComponent(this);

        JPanel row1 = new JPanel(new BorderLayout(8, 0));
        row1.add(toolbar.getComponent(), BorderLayout.WEST);
        JPanel row2 = new JPanel(new BorderLayout(8, 0));
        row2.add(selectStatus, BorderLayout.WEST);
        JPanel north = new JPanel(new BorderLayout());
        north.add(row1, BorderLayout.NORTH);
        north.add(row2, BorderLayout.CENTER);
        p.add(north, BorderLayout.NORTH);

        selectTree.setRootVisible(false);
        selectTree.setShowsRootHandles(true);
        selectTree.getSelectionModel().setSelectionMode(TreeSelectionModel.SINGLE_TREE_SELECTION);
        selectTree.setCellRenderer(new SelectTreeRenderer());
        selectTree.setToolTipText("单击查看详情，双击进入 Review");
        selectTree.addMouseListener(new MouseAdapter() {
            @Override
            public void mouseClicked(MouseEvent e) {
                if (e.getClickCount() == 2) enterReviewOnSelection();
            }

            @Override
            public void mousePressed(MouseEvent e) {
                maybeShowNodeMenu(e);
            }

            @Override
            public void mouseReleased(MouseEvent e) {
                maybeShowNodeMenu(e);
            }
        });
        // 单击选中 → 右侧详情（需求/设计/文档/PRD）
        selectTree.getSelectionModel().addTreeSelectionListener(e -> loadSelectDetail());
        // 布局：左树右详情。详情用 JCEF 渲染 Markdown（JEditorPane 的 HTML 布局在 IDEA 容器里会 BoxView 死循环）
        selectDetailFallback = new javax.swing.JTextArea();
        selectDetailFallback.setEditable(false);
        selectDetailFallback.setLineWrap(true);
        selectDetailFallback.setWrapStyleWord(true);
        selectDetailFallback.setFont(new java.awt.Font("Menlo", java.awt.Font.PLAIN, 12));
        selectDetailFallback.setMargin(new java.awt.Insets(10, 10, 10, 10));
        selectDetailFallback.setText(HINT_TEXT);
        JComponent detailComponent = buildSelectDetailComponent();
        JSplitPane selectSplit = new JSplitPane(JSplitPane.HORIZONTAL_SPLIT,
                ScrollPaneFactory.createScrollPane(selectTree, true),
                detailComponent);
        selectSplit.setDividerLocation(420);
        selectSplit.setResizeWeight(0.45);
        p.add(selectSplit, BorderLayout.CENTER);
        return p;
    }

    private static final String HINT_TEXT = "单击节点查看详情（需求 / 设计 / 文档 / PRD）\n" +
            "双击进入 Review\n\n（PRD 链接用顶栏「PRD」按钮打开）";

    /** 详情区组件：优先 JCEF（可渲染 Markdown 与超链接）；不可用时降级为纯文本 JTextArea */
    private JComponent buildSelectDetailComponent() {
        try {
            if (com.intellij.ui.jcef.JBCefApp.isSupported()) {
                selectDetailBrowser = new com.intellij.ui.jcef.JBCefBrowser();
                selectDetailBrowser.setOpenLinksInExternalBrowser(true);
                // 面板随工具窗长期存活，浏览器交给项目 Disposer 统一释放
                com.intellij.openapi.util.Disposer.register(project, selectDetailBrowser);
                selectDetailBrowser.loadHTML(renderSelectDetailPage(HINT_TEXT, false));
                return selectDetailBrowser.getComponent();
            }
        } catch (Throwable t) {
            diag("详情面板 JCEF 初始化失败，降级纯文本：" + t);
            selectDetailBrowser = null;
        }
        return ScrollPaneFactory.createScrollPane(selectDetailFallback, true);
    }

    /** 详情页：把「节点头 + 各文档」拼成一份 Markdown，再渲染成 JCEF 页面 */
    private String renderSelectDetailPage(String markdown, boolean dark) {
        try {
            return MarkdownRenderer.toPage(markdown, dark);
        } catch (Throwable t) {
            diag("Markdown 渲染失败，降级纯文本：" + t);
            // 最后一道兜底：不再调用渲染器，直接转义成 <pre>，保证自己不会二次抛异常
            return "<!DOCTYPE html><html><head><meta charset=\"utf-8\"></head><body>"
                    + "<pre style=\"white-space:pre-wrap;font-family:Menlo,monospace;font-size:12px;padding:12px\">"
                    + MarkdownRenderer.escapeHtml(markdown)
                    + "</pre></body></html>";
        }
    }

    /** 把详情文字写进当前有效组件（JCEF 优先，纯文本降级） */
    private void setSelectDetailText(String markdownText) {
        if (selectDetailBrowser != null) {
            selectDetailBrowser.loadHTML(renderSelectDetailPage(markdownText, !JBColor.isBright()));
            return;
        }
        selectDetailFallback.setText(mdToText(markdownText));
        selectDetailFallback.setCaretPosition(0);
    }

    /** markdown → 纯文本（去 # 标记与代码围栏，保留正文；供 JTextArea 详情面板） */
    private static String mdToText(String md) {
        if (md == null) {
            return "";
        }
        StringBuilder sb = new StringBuilder();
        for (String line : md.replace("\r\n", "\n").split("\n", -1)) {
            String t = line;
            if (t.trim().startsWith("```")) {
                continue;
            }
            if (t.startsWith("#")) {
                t = t.replaceAll("^#+\\s*", "");
            }
            sb.append(t).append("\n");
        }
        return sb.toString();
    }

    /** 单击节点 → 加载详情（需求 / 设计 / 文档 / PRD）到右侧面板 */
    private void loadSelectDetail() {
        NodeData d = selectedSelectNode();
        if (d == null || d.id == selectDetailLoadedId) {
            return;
        }
        diag("loadSelectDetail 开始 id=" + d.id + " name=" + d.name);
        selectDetailLoadedId = d.id;
        selectDetailLoadedName = d.name;
        setSelectDetailText("加载中…（" + d.name + "）");
        final long id = d.id;
        ApplicationManager.getApplication().executeOnPooledThread(() -> {
            try {
                long t0 = System.currentTimeMillis();
                JsonArray docs = api.nodeDocuments(id);
                String prdUrl = null;
                try {
                    prdUrl = findPrdUrl(id);
                } catch (Exception ignore) {
                    // 无 PRD 不阻断
                }
                diag("loadSelectDetail 数据到达 id=" + id + " " + (System.currentTimeMillis() - t0) + "ms docs=" + (docs == null ? 0 : docs.size()));
                final JsonArray finalDocs = docs;
                final String finalPrdUrl = prdUrl;
                SwingUtilities.invokeLater(() -> {
                    if (id != selectDetailLoadedId) {
                        diag("loadSelectDetail 丢弃（已切到 " + selectDetailLoadedId + "）id=" + id);
                        return;
                    }
                    StringBuilder t = new StringBuilder();
                    t.append("## ").append(d.name).append("\n\n");
                    t.append("`id=").append(d.id).append("` · `").append(d.type).append("`\n");
                    if (finalPrdUrl != null) {
                        selectDetailPrdUrl = finalPrdUrl;
                        t.append("\n📄 飞书 PRD：<").append(finalPrdUrl).append(">\n");
                    } else {
                        selectDetailPrdUrl = null;
                    }
                    t.append("\n---\n");
                    if (finalDocs != null && finalDocs.size() > 0) {
                        for (JsonElement el : finalDocs) {
                            JsonObject doc = el.getAsJsonObject();
                            t.append("\n### ").append(str(doc, "name", "文档")).append("\n\n");
                            t.append(str(doc, "content", ""));
                            t.append("\n");
                        }
                    } else {
                        t.append("\n（该节点暂无文档）\n");
                    }
                    long t1 = System.currentTimeMillis();
                    setSelectDetailText(t.toString());
                    diag("loadSelectDetail 已 setText id=" + id + " 渲染 " + (System.currentTimeMillis() - t1) + "ms len=" + t.length());
                });
            } catch (Exception ex) {
                SwingUtilities.invokeLater(() -> setSelectDetailText(
                        "加载详情失败：" + ex.getMessage()));
            }
        });
    }

    /** 打开当前详情节点的飞书 PRD（内置 JCEF tab） */
    private void openSelectPrd() {
        if (selectDetailPrdUrl == null || selectDetailPrdUrl.isEmpty()) {
            selectStatus.setText("当前节点未配置飞书 PRD 链接");
            return;
        }
        PrdOpener.open(project, selectDetailPrdUrl, selectDetailLoadedName);
        selectStatus.setText("已在内置 tab 打开 PRD：" + selectDetailLoadedName);
    }

    /** Select 视图：当前选中的节点（未选中返回 null） */
    private NodeData selectedSelectNode() {
        Object o = selectTree.getLastSelectedPathComponent();
        if (o instanceof DefaultMutableTreeNode n && n.getUserObject() instanceof NodeData d) {
            return d;
        }
        return null;
    }

    /** 拷贝选中节点 id（id · 名称） */
    private void copySelectNodeId() {
        NodeData d = selectedSelectNode();
        if (d == null) {
            selectStatus.setText("请先在树里选中一个节点");
            return;
        }
        CopyPasteManager.getInstance().setContents(new StringSelection(d.id + " · " + d.name));
        selectStatus.setText("已复制节点 ID：" + d.id + " · " + d.name);
    }

    /** 拷贝选中节点的上下文（节点 + 文档 + PRD） */
    private void copySelectContext() {
        final NodeData d = selectedSelectNode();
        if (d == null) {
            selectStatus.setText("请先在树里选中一个节点");
            return;
        }
        selectStatus.setText("正在生成上下文…");
        ApplicationManager.getApplication().executeOnPooledThread(() -> {
            try {
                JsonArray docs = api.nodeDocuments(d.id);
                String prdUrl = null;
                try {
                    prdUrl = findPrdUrl(d.id);
                } catch (Exception ignore) {
                    // 无 PRD 不阻断
                }
                StringBuilder md = new StringBuilder();
                md.append("## task-board 节点：").append(d.name).append("（id=").append(d.id).append("）\n");
                if (prdUrl != null) {
                    md.append("- PRD（飞书）：").append(prdUrl).append("\n");
                }
                if (docs != null) {
                    for (JsonElement el : docs) {
                        JsonObject doc = el.getAsJsonObject();
                        md.append("\n### ").append(str(doc, "name", "文档")).append("\n\n");
                        md.append(str(doc, "content", "")).append("\n");
                    }
                }
                final String text = md.toString();
                SwingUtilities.invokeLater(() -> {
                    CopyPasteManager.getInstance().setContents(new StringSelection(text));
                    selectStatus.setText("已复制「" + d.name + "」上下文（" + text.length() + " 字）——可直接粘贴给 Qoder");
                });
            } catch (Exception ex) {
                SwingUtilities.invokeLater(() -> selectStatus.setText("生成上下文失败：" + ex.getMessage()));
            }
        });
    }

    /** 搜索节点（按名称包含，定位并展开选中） */
    private void searchSelectNode() {
        String kw = Messages.showInputDialog(project, "输入节点名称关键词（支持部分匹配）：", "搜索节点", null);
        if (kw == null || kw.trim().isEmpty()) {
            return;
        }
        String k = kw.trim();
        List<TreePath> hits = new ArrayList<>();
        collectMatches(new TreePath(selectRoot), k, hits);
        if (hits.isEmpty()) {
            selectStatus.setText("未找到包含「" + k + "」的节点");
            return;
        }
        TreePath first = hits.get(0);
        selectTree.setSelectionPath(first);
        selectTree.scrollPathToVisible(first);
        String firstName = "";
        Object last = first.getLastPathComponent();
        if (last instanceof DefaultMutableTreeNode n && n.getUserObject() instanceof NodeData nd) {
            firstName = nd.name;
        }
        selectStatus.setText("找到 " + hits.size() + " 个匹配，已定位到：「" + firstName + "」");
    }

    /** 递归收集名称包含关键词的节点路径 */
    private void collectMatches(TreePath path, String kw, List<TreePath> out) {
        Object last = path.getLastPathComponent();
        if (last instanceof DefaultMutableTreeNode n) {
            if (n.getUserObject() instanceof NodeData d && d.name != null && d.name.contains(kw)) {
                out.add(path);
            }
            for (int i = 0; i < n.getChildCount(); i++) {
                collectMatches(path.pathByAddingChild(n.getChildAt(i)), kw, out);
            }
        }
    }

    public void reloadTree() {
        selectStatus.setText("加载中…");
        ApplicationManager.getApplication().executeOnPooledThread(() -> {
            try {
                JsonObject res = api.tree();
                JsonArray nodes = res.getAsJsonArray("nodes");
                DefaultMutableTreeNode newRoot = new DefaultMutableTreeNode("task-board");
                if (nodes != null) {
                    for (JsonElement el : nodes) buildSelectNode(newRoot, el.getAsJsonObject());
                }
                SwingUtilities.invokeLater(() -> {
                    selectRoot.removeAllChildren();
                    while (newRoot.getChildCount() > 0) {
                        selectRoot.add((DefaultMutableTreeNode) newRoot.getChildAt(0));
                    }
                    selectModel.reload();
                    for (int i = 0; i < selectTree.getRowCount(); i++) selectTree.expandRow(i);
                    selectStatus.setText("就绪 · 共 " + countNodes(newRoot) + " 个节点（双击进入）");
                });
            } catch (Exception e) {
                SwingUtilities.invokeLater(() -> selectStatus.setText(
                        "加载失败：" + e.getMessage() + "（task-board 服务是否已在 " + api.base() + " 运行？）"));
            }
        });
    }

    private int countNodes(DefaultMutableTreeNode n) {
        int c = n != selectRoot ? 1 : 0;
        for (int i = 0; i < n.getChildCount(); i++) c += countNodes((DefaultMutableTreeNode) n.getChildAt(i));
        return c;
    }

    private void buildSelectNode(DefaultMutableTreeNode parent, JsonObject o) {
        NodeData d = new NodeData();
        d.id = o.get("id").getAsLong();
        d.type = o.get("type").getAsString();
        d.name = o.get("name").getAsString();
        d.status = o.has("status") ? o.get("status").getAsString() : "";
        DefaultMutableTreeNode n = new DefaultMutableTreeNode(d);
        parent.add(n);
        if (o.has("children") && !o.get("children").isJsonNull()) {
            for (JsonElement c : o.getAsJsonArray("children")) buildSelectNode(n, c.getAsJsonObject());
        }
    }

    /** 节点树右键菜单：新建子节点 / 重命名 / 删除 */
    private void maybeShowNodeMenu(MouseEvent e) {
        if (!e.isPopupTrigger()) {
            return;
        }
        TreePath path = selectTree.getPathForLocation(e.getX(), e.getY());
        if (path == null) {
            return;
        }
        selectTree.setSelectionPath(path);
        JPopupMenu menu = new JPopupMenu();
        JMenuItem addItem = new JMenuItem("新建子节点…", AllIcons.General.Add);
        addItem.addActionListener(a -> addChildNodeDialog());
        menu.add(addItem);
        JMenuItem renameItem = new JMenuItem("重命名…", AllIcons.Actions.Edit);
        renameItem.addActionListener(a -> renameNodeDialog());
        menu.add(renameItem);
        menu.addSeparator();
        JMenuItem delItem = new JMenuItem("删除节点…", AllIcons.Actions.GC);
        delItem.addActionListener(a -> deleteNodeDialog());
        menu.add(delItem);
        menu.show(selectTree, e.getX(), e.getY());
    }

    /** 子节点类型约束（与后端 CHILD_TYPES 对齐） */
    private static String[] childTypesOf(String type) {
        return switch (type) {
            case "project" -> new String[]{"requirement"};
            case "requirement" -> new String[]{"group", "subreq"};
            case "subreq" -> new String[]{"group", "task"};
            case "group" -> new String[]{"group", "task", "defect"};
            case "task" -> new String[]{"defect"};
            default -> new String[0];
        };
    }

    /** 新建子节点（类型选择 + 名称输入） */
    private void addChildNodeDialog() {
        NodeData d = selectedSelectNode();
        if (d == null) {
            selectStatus.setText("请先选中一个节点");
            return;
        }
        String[] types = childTypesOf(d.type);
        if (types.length == 0) {
            selectStatus.setText("「" + d.type + "」是叶子节点，不能再挂子节点");
            return;
        }
        String type = types[0];
        if (types.length > 1) {
            Object sel = JOptionPane.showInputDialog(selectTree, "子节点类型：", "新建子节点",
                    JOptionPane.PLAIN_MESSAGE, null, types, types[0]);
            if (sel == null) {
                return;
            }
            type = sel.toString();
        }
        String name = Messages.showInputDialog(project, "节点名称：", "新建 " + type, null);
        if (name == null || name.trim().isEmpty()) {
            return;
        }
        final String fType = type;
        final String fName = name.trim();
        final long pid = d.id;
        final String pname = d.name;
        ApplicationManager.getApplication().executeOnPooledThread(() -> {
            try {
                api.createNode(pid, fType, fName);
                SwingUtilities.invokeLater(() -> {
                    selectStatus.setText("已新建 " + fType + "「" + fName + "」（父：" + pname + "）");
                    reloadTree();
                });
            } catch (Exception ex) {
                SwingUtilities.invokeLater(() -> selectStatus.setText("新建失败：" + ex.getMessage()));
            }
        });
    }

    /** 重命名节点 */
    private void renameNodeDialog() {
        NodeData d = selectedSelectNode();
        if (d == null) {
            selectStatus.setText("请先选中一个节点");
            return;
        }
        String name = Messages.showInputDialog(project, "新名称：", "重命名「" + d.name + "」", null, d.name, null);
        if (name == null || name.trim().isEmpty() || name.trim().equals(d.name)) {
            return;
        }
        final String fName = name.trim();
        final long nid = d.id;
        final String oldName = d.name;
        ApplicationManager.getApplication().executeOnPooledThread(() -> {
            try {
                api.renameNode(nid, fName);
                SwingUtilities.invokeLater(() -> {
                    selectStatus.setText("已重命名：「" + oldName + "」→「" + fName + "」");
                    reloadTree();
                });
            } catch (Exception ex) {
                SwingUtilities.invokeLater(() -> selectStatus.setText("重命名失败：" + ex.getMessage()));
            }
        });
    }

    /** 删除节点（级联警告 + 确认） */
    private void deleteNodeDialog() {
        NodeData d = selectedSelectNode();
        if (d == null) {
            selectStatus.setText("请先选中一个节点");
            return;
        }
        int r = Messages.showYesNoDialog(project,
                "确认删除节点「" + d.name + "」（" + d.type + " · id=" + d.id + "）？\n\n"
                        + "⚠ 其下所有子节点与提交登记将一并删除（级联），不可恢复。",
                "删除节点", Messages.getWarningIcon());
        if (r != Messages.YES) {
            return;
        }
        final long nid = d.id;
        final String name = d.name;
        ApplicationManager.getApplication().executeOnPooledThread(() -> {
            try {
                api.deleteNode(nid);
                SwingUtilities.invokeLater(() -> {
                    selectStatus.setText("已删除节点：「" + name + "」");
                    selectDetailLoadedId = -1; // 让详情可重新加载
                    reloadTree();
                });
            } catch (Exception ex) {
                SwingUtilities.invokeLater(() -> selectStatus.setText("删除失败：" + ex.getMessage()));
            }
        });
    }

    private void enterReviewOnSelection() {
        Object sel = selectTree.getLastSelectedPathComponent();
        if (sel instanceof DefaultMutableTreeNode n && n.getUserObject() instanceof NodeData d) {
            enterReview(d);
        }
    }

    // ================= 视图 B：节点 Review =================

    private JPanel buildReviewView() {
        JPanel p = new JPanel(new BorderLayout());

        // ---- 顶部：导航组（退出/提交列表，左侧） + 功能按钮组（右侧） + 汇总 ----
        DefaultActionGroup navGroup = new DefaultActionGroup();
        addAction(navGroup, "退出", "返回节点选择", AllIcons.Actions.Back, () -> cardLayout.show(cards, CARD_SELECT));
        navGroup.add(Separator.getInstance());
        navGroup.add(new ToggleAction("提交列表", "展开/收起左侧 commit 列表（勾选/取消调整参与合并的范围）", AllIcons.Actions.ListFiles) {
            @Override
            public boolean isSelected(@NotNull AnActionEvent e) {
                return commitListVisible;
            }

            @Override
            public void setSelected(@NotNull AnActionEvent e, boolean state) {
                setCommitListVisible(state);
            }
        });
        navGroup.add(Separator.getInstance());

        DefaultActionGroup group = new DefaultActionGroup();
        addAction(group, "标记通过", "对勾选的 commit 标记审查通过（存在\"有问题\"的 commit 时会被拦截）", AllIcons.Actions.Checked, this::markApproved);
        addAction(group, "标记有问题…", "对勾选的 commit 标记有问题（可填写意见）", AllIcons.Actions.Cancel, this::markCheckedWithNote);
        addAction(group, "重置待审", "对勾选的 commit 重置为待审", AllIcons.Actions.Rollback, () -> markChecked("pending", null));
        group.add(Separator.getInstance());
        addAction(group, "Agent", "Agent 控制台：运行时 / 会话 / 任务（写提示词派单，可续跑、取消、重试）", AllIcons.Actions.Execute, () -> {
            if (currentNodeId < 0) {
                reviewSummary.setText("请先从节点树进入一个节点");
                return;
            }
            new AgentConsoleDialog(project, api, currentNodeId, currentNodeName).show();
        });
        group.add(Separator.getInstance());
        addAction(group, "对照布局", "一键铺排：左 diff + 右列（需求概设⇄PRD） + TaskBoard底部（比例可在「布局设置」中调整）", AllIcons.Actions.SplitVertically, this::openReviewLayout);
        group.add(Separator.getInstance());
        addToggle(group, "diff", "勾选显示左侧 diff 栏；取消勾选则隐藏", AllIcons.Actions.Diff,
                () -> {
                    VirtualFile vf = DiffOpener.currentFile();
                    return vf != null && vf.isValid()
                            && FileEditorManagerEx.getInstanceEx(project).getEditors(vf).length > 0;
                },
                this::setDiffPaneVisible);
        addToggle(group, "文档", "勾选显示右侧文档窗口（需求概设/飞书 PRD）；取消勾选则隐藏", AllIcons.Actions.Preview,
                () -> {
                    FileEditorManagerEx fem = FileEditorManagerEx.getInstanceEx(project);
                    String docsPath = java.nio.file.Paths.get(System.getProperty("java.io.tmpdir"),
                            "taskboard-docs", "taskboard-需求概设.md").toString();
                    VirtualFile docsVf = LocalFileSystem.getInstance().findFileByPath(docsPath);
                    if (docsVf != null && fem.getEditors(docsVf).length > 0) {
                        return true;
                    }
                    VirtualFile prdVf = PrdOpener.currentFile();
                    return prdVf != null && prdVf.isValid() && fem.getEditors(prdVf).length > 0;
                },
                this::setDocsPaneVisible);
        group.add(Separator.getInstance());
        addAction(group, "布局设置", "设置对照布局比例（diff 宽度 / TaskBoard 高度；拖动分隔条也会自动记住）", AllIcons.General.Settings, this::openLayoutSettings);
        addAction(group, "复制上下文", "复制当前任务+review 上下文（节点/勾选提交/变更文件）到剪贴板，可直接粘贴给 Qoder", AllIcons.Actions.Copy, this::copyReviewContext);
        addAction(group, "派给 Qoder", "生成任务提示词并打开 Qoder IDE 面板（提示词已复制，粘贴+回车即发送）", AllIcons.Actions.RunAll, this::dispatchToQoder);
        group.add(Separator.getInstance());
        addAction(group, "评论", "在 diff 选中处添加评论（记录文件+行号，存入 task-board）", AllIcons.General.Note, this::addCommentOnDiff);
        addAction(group, "评论列表", "查看本节点的全部评论", AllIcons.Actions.Show, this::showComments);
        addAction(group, "合入状态", "查看子任务开发分支是否已合入需求分支（组/子需求级）", AllIcons.Actions.Diff, this::showMergeStatus);
        addAction(group, "合并预览", "MR 式预览：将合入的变更文件/增删统计 + 冲突预判（同意前先看）", AllIcons.Actions.Preview, this::showMergePreview);
        addAction(group, "合并到 feature-merge", "子需求：把需求分支合入集成分支（已合入跳过；有新内容可再次合并）", AllIcons.Actions.Upload, this::mergeToFeatureMerge);
        addAction(group, "登记缺陷", "在当前节点下登记缺陷（自动带 diff 位置与片段，可一键派给 Qoder 修复）", AllIcons.General.InspectionsError, this::reportDefect);
        addAction(group, "分析根因", "缺陷节点：派 Qoder 做根因分析与修复方案（结果回写文档）", AllIcons.Actions.Find, this::analyzeDefectWithQoder);
        addAction(group, "批准修复", "缺陷节点：批准「根因与修复方案」（批准后才允许派单修复）", AllIcons.Actions.Checked, this::approveDefectFix);
        addAction(group, "按方案修复", "缺陷节点：按已批准的方案派 Qoder 实施修复（未批准会被拦截）", AllIcons.Actions.Execute, this::fixDefectWithQoder);

        reviewToolbar = ActionManager.getInstance().createActionToolbar("TaskBoardReview", group, true);
        ActionToolbar toolbar = reviewToolbar;
        toolbar.setTargetComponent(this);

        ActionToolbar navToolbar = ActionManager.getInstance().createActionToolbar("TaskBoardReviewNav", navGroup, true);
        navToolbar.setTargetComponent(this);
        JPanel navPart = new JPanel(new BorderLayout(6, 0));
        navPart.add(navToolbar.getComponent(), BorderLayout.WEST);
        navPart.add(reviewSummary, BorderLayout.CENTER);

        JPanel north = new JPanel(new BorderLayout(8, 0));
        north.add(navPart, BorderLayout.CENTER);
        north.add(toolbar.getComponent(), BorderLayout.EAST);
        p.add(north, BorderLayout.NORTH);

        // ---- 左侧：commit 列表（默认收起） ----
        reviewTree = new CheckboxTree(new CheckboxTree.CheckboxTreeCellRenderer() {
            @Override
            public void customizeRenderer(JTree tree, Object value, boolean selected, boolean expanded,
                                          boolean leaf, int row, boolean hasFocus) {
                Object user = value instanceof DefaultMutableTreeNode n ? n.getUserObject() : null;
                if (user instanceof CommitItem ci) {
                    getTextRenderer().append(ci.display());
                    // 着色：已合入需求分支 → 绿色；未合并 → 黄橙色（亮底可读）
                    if (ci.mergedToReq != null) {
                        getTextRenderer().setForeground(ci.mergedToReq
                                ? new java.awt.Color(0x2E7D32)
                                : new java.awt.Color(0xB8860B));
                    }
                }
            }
        }, reviewRoot);
        reviewTree.setRootVisible(false);
        reviewTree.setShowsRootHandles(true);
        reviewTree.addTreeSelectionListener(this::onCommitSelected);
        reviewTree.addMouseListener(new MouseAdapter() {
            @Override
            public void mouseClicked(MouseEvent e) {
                if (e.getClickCount() == 2) {
                    CommitItem ci = selectedCommit();
                    if (ci != null) DiffOpener.open(project, api, ci.cid, ci.sha);
                }
            }

            @Override
            public void mouseReleased(MouseEvent e) {
                if (checksDebounce == null) {
                    checksDebounce = new Timer(350, ev -> onChecksChanged());
                    checksDebounce.setRepeats(false);
                }
                checksDebounce.restart();
            }
        });
        commitScroll = ScrollPaneFactory.createScrollPane(reviewTree, true);

        // ---- 右侧：详情（文件变更树 + 信息） ----
        JPanel detailPanel = new JPanel(new BorderLayout());
        detailTree.setRootVisible(false);
        detailTree.setShowsRootHandles(true);
        detailTree.setCellRenderer(new DetailTreeRenderer());
        detailTree.setToolTipText("双击文件查看 IDEA Diff");
        detailTree.addMouseListener(new MouseAdapter() {
            @Override
            public void mouseClicked(MouseEvent e) {
                if (e.getClickCount() != 2) return;
                TreePath path = detailTree.getPathForLocation(e.getX(), e.getY());
                if (path == null) return;
                Object last = path.getLastPathComponent();
                if (last instanceof DefaultMutableTreeNode n && n.getUserObject() instanceof FileNode fn) {
                    if (fn.oldText != null || fn.newText != null) {
                        // 聚合模式 → 打开整批合并变更的链 diff（定位到该文件，可上/下一文件切换）
                        DiffOpener.openCombined(project, aggregateTitle, aggregateFiles, fn.path);
                    } else {
                        DiffOpener.open(project, api, fn.cid, fn.sha, fn.path);
                    }
                }
            }
        });
        // 文件树（上）+ commit 信息区（下，独立滚动，可拖动分割）
        commitInfoPanel.setLayout(new BoxLayout(commitInfoPanel, BoxLayout.Y_AXIS));
        detailVertSplit = new JSplitPane(JSplitPane.VERTICAL_SPLIT,
                ScrollPaneFactory.createScrollPane(detailTree, true),
                ScrollPaneFactory.createScrollPane(commitInfoPanel, true));
        detailVertSplit.setResizeWeight(0.72);
        detailVertSplit.setDividerSize(6);
        detailVertSplit.setDividerLocation(0.72);
        detailPanel.add(detailVertSplit, BorderLayout.CENTER);

        // 列表头行：全选⇄ / 反选 / 仅看待审（放在 commit 列表上方）
        onlyPending = new JBCheckBox("仅看待审");
        onlyPending.setToolTipText("只显示审查状态为「待审 ○」的提交（勾选/取消调整范围）");
        onlyPending.addActionListener(e -> rebuildReviewTree());
        JButton btnSelectAll = new JButton("全选⇄");
        btnSelectAll.setToolTipText("勾选全部提交（已全选时点一下变全不选）");
        btnSelectAll.setMargin(new java.awt.Insets(1, 6, 1, 6));
        btnSelectAll.addActionListener(e -> toggleSelectAll());
        JButton btnInvert = new JButton("反选");
        btnInvert.setToolTipText("已勾选与未勾选互换");
        btnInvert.setMargin(new java.awt.Insets(1, 6, 1, 6));
        btnInvert.addActionListener(e -> invertChecks());
        JPanel listHeader = new JPanel(new java.awt.FlowLayout(java.awt.FlowLayout.LEFT, 4, 2));
        listHeader.add(btnSelectAll);
        listHeader.add(btnInvert);
        listHeader.add(onlyPending);
        JPanel leftCol = new JPanel(new BorderLayout());
        leftCol.add(listHeader, BorderLayout.NORTH);
        leftCol.add(commitScroll, BorderLayout.CENTER);

        reviewSplit = new JSplitPane(JSplitPane.HORIZONTAL_SPLIT, leftCol, detailPanel);
        reviewSplit.setDividerSize(6);
        reviewSplit.setResizeWeight(0.0);
        p.add(reviewSplit, BorderLayout.CENTER);
        setCommitListVisible(false);
        return p;
    }

    /** 展开/收起左侧 commit 列表 */
    private void setCommitListVisible(boolean visible) {
        commitListVisible = visible;
        if (reviewSplit == null) return;
        commitScroll.setVisible(visible);
        reviewSplit.setDividerLocation(visible ? COMMIT_LIST_WIDTH : 0);
        reviewSplit.revalidate();
        reviewSplit.repaint();
    }

    /** 沿父链找「需求分支」：① 节点自身 branch（分支组）② 子需求 reqBranch */
    private String findReqBranch(long startId) {
        try {
            long id = startId;
            for (int depth = 0; depth < 10 && id > 0; depth++) {
                JsonObject node = api.nodeGet(id);
                // 节点自身带 branch 属性（分支组节点）→ 直接用
                if (node.has("attrs") && node.get("attrs").isJsonObject()) {
                    String own = attrOf(node.getAsJsonObject("attrs"), "branch");
                    if (depth == 0 && own != null && !own.isEmpty()) {
                        return own;
                    }
                }
                if ("subreq".equals(str(node, "type", ""))) {
                    if (node.has("attrs") && node.get("attrs").isJsonObject()) {
                        return attrOf(node.getAsJsonObject("attrs"), "reqBranch");
                    }
                    return null;
                }
                if (!node.has("parentId") || node.get("parentId").isJsonNull()) {
                    return null;
                }
                id = node.get("parentId").getAsLong();
            }
        } catch (Exception ignore) {
            // 忽略
        }
        return null;
    }

    private void enterReview(NodeData d) {
        currentNodeId = d.id;
        currentNodeName = d.name;
        // 切换节点时清空聚合缓存，避免对照布局误用上一个节点的数据
        aggregateFiles = new ArrayList<>();
        aggregateTitle = "";
        writeReviewContext();
        reviewSummary.setText("加载中…（" + d.name + "）");
        detailRoot.removeAllChildren();
        detailModel.reload();
        setCommitInfos(java.util.Collections.emptyList());
        diffCache.clear();
        // 默认收起 commit 列表（全勾选下直接看合并变更）；由用户点「提交列表」展开
        setCommitListVisible(false);
        cardLayout.show(cards, CARD_REVIEW);
        long token = ++requestToken;
        ApplicationManager.getApplication().executeOnPooledThread(() -> {
            try {
                long t0 = System.currentTimeMillis();
                // 所属子需求的「需求分支」（subreq/自己的属性），拼到状态栏
                String reqBranch = findReqBranch(d.id);
                diag("enterReview findReqBranch " + (System.currentTimeMillis() - t0) + "ms");
                long t1 = System.currentTimeMillis();
                JsonObject res = api.nodeTracks(d.id, "subtree", true);
                JsonArray items = res.getAsJsonArray("items");
                diag("enterReview nodeTracks " + (System.currentTimeMillis() - t1) + "ms items=" + (items == null ? 0 : items.size()));
                SwingUtilities.invokeLater(() -> {
                    if (token != requestToken) return;
                    diag("enterReview invokeLater 开始");
                    long t2 = System.currentTimeMillis();
                    commitItems.clear();
                    if (items != null) {
                        for (JsonElement el : items) commitItems.add(CommitItem.from(el.getAsJsonObject()));
                    }
                    rebuildReviewTree();
                    diag("enterReview rebuildReviewTree " + (System.currentTimeMillis() - t2) + "ms");
                    int unmerged = 0;
                    for (CommitItem ci : commitItems) {
                        if (ci.mergedToReq != null && !ci.mergedToReq) unmerged++;
                    }
                    if (reqBranch != null && !reqBranch.isEmpty()) {
                        String u = unmerged > 0 ? "　⚠ 未合并 " + unmerged : "　✓ 全部已合入";
                        reviewSummary.setText("【" + currentNodeNo() + "】" + d.name + "　🌿 需求分支：" + reqBranch + u);
                    } else {
                        reviewSummary.setText("【" + currentNodeNo() + "】" + d.name);
                    }
                });
            } catch (Exception e) {
                SwingUtilities.invokeLater(() -> {
                    if (token == requestToken) reviewSummary.setText("加载失败：" + e.getMessage());
                });
            }
        });
    }

    /** CheckboxTree 内部创建的 model（必须用它发变更通知，否则界面不刷新） */
    private DefaultTreeModel reviewModel() {
        return (DefaultTreeModel) reviewTree.getModel();
    }

    /** 重建 commit 列表（默认全部勾选；「仅看待审」过滤后同样全勾选） */
    private void rebuildReviewTree() {
        reviewRoot.removeAllChildren();
        for (CommitItem ci : commitItems) {
            if (onlyPending != null && onlyPending.isSelected() && !"pending".equals(ci.reviewStatus)) continue;
            CheckedTreeNode cn = new CheckedTreeNode(ci);
            cn.setChecked(true); // 默认全选 → 右侧直接展示全部合并变更
            reviewRoot.add(cn);
        }
        reviewModel().reload();
        updateReviewSummary(null);
        refreshDetailForChecked();
    }

    /** 勾选集合决定右侧：≥2 合并变更；1 该 commit；0 按当前选中 */
    private void refreshDetailForChecked() {
        List<CommitItem> checked = checkedCommits();
        if (checked.size() >= 2) {
            loadCombined(checked);
        } else if (checked.size() == 1) {
            showCommitDetail(checked.get(0));
        } else {
            CommitItem ci = selectedCommit();
            if (ci != null) {
                showCommitDetail(ci);
            } else {
                detailRoot.removeAllChildren();
                detailModel.reload();
                setCommitInfos(java.util.Collections.singletonList("<html><i>" + (commitItems.isEmpty() ? "暂无提交" : "未勾选任何提交") + "</i></html>"));
            }
        }
    }

    private void updateReviewSummary(String prefix) {
        long pending = 0, approved = 0, issue = 0;
        for (CommitItem ci : commitItems) {
            if ("approved".equals(ci.reviewStatus)) approved++;
            else if ("issue".equals(ci.reviewStatus)) issue++;
            else pending++;
        }
        reviewSummary.setText((prefix == null ? "" : prefix + " · ")
                + currentNodeName + " · 共 " + commitItems.size() + " 条 · ○" + pending + " / ✓" + approved + " / ✗" + issue);
    }

    private List<CommitItem> checkedCommits() {
        List<CommitItem> out = new ArrayList<>();
        Enumeration<?> e = reviewRoot.breadthFirstEnumeration();
        while (e.hasMoreElements()) {
            Object o = e.nextElement();
            if (o instanceof CheckedTreeNode cn && cn.isChecked() && cn.getUserObject() instanceof CommitItem ci) {
                out.add(ci);
            }
        }
        return out;
    }

    private CommitItem selectedCommit() {
        Object last = reviewTree.getLastSelectedPathComponent();
        if (last instanceof DefaultMutableTreeNode n && n.getUserObject() instanceof CommitItem ci) return ci;
        return null;
    }

    private void markChecked(String statusValue, String note) {
        List<CommitItem> sel = checkedCommits();
        if (sel.isEmpty()) {
            reviewSummary.setText("请先在「提交列表」中勾选要操作的 commit");
            return;
        }
        int count = sel.size();
        reviewSummary.setText("更新审查状态中…");
        ApplicationManager.getApplication().executeOnPooledThread(() -> {
            try {
                for (CommitItem ci : sel) {
                    JsonObject res = api.updateCommitReview(ci.cid, statusValue, note);
                    ci.reviewStatus = res.has("reviewStatus") && !res.get("reviewStatus").isJsonNull()
                            ? res.get("reviewStatus").getAsString() : statusValue;
                    ci.reviewNote = res.has("reviewNote") && !res.get("reviewNote").isJsonNull()
                            ? res.get("reviewNote").getAsString() : ci.reviewNote;
                }
                SwingUtilities.invokeLater(() -> {
                    reviewModel().reload();
                    updateReviewSummary("已更新 " + count + " 条");
                });
            } catch (Exception e) {
                SwingUtilities.invokeLater(() -> reviewSummary.setText("审查操作失败：" + e.getMessage()));
            }
        });
    }

    /** 标记通过（带"有问题"拦截：需先解决并重置后再通过） */
    private void markApproved() {
        List<CommitItem> sel = checkedCommits();
        if (sel.isEmpty()) {
            reviewSummary.setText("请先勾选要操作的 commit");
            return;
        }
        List<CommitItem> issues = new ArrayList<>();
        for (CommitItem ci : sel) {
            if ("issue".equals(ci.reviewStatus)) {
                issues.add(ci);
            }
        }
        if (!issues.isEmpty()) {
            StringBuilder sb = new StringBuilder("<html>以下 commit 处于<font color='#D43A3A'><b>「有问题」</b></font>状态，请先解决并「重置待审」后再通过：<br><br>");
            for (CommitItem ci : issues) {
                String sha = ci.sha == null ? "" : ci.sha;
                sb.append("• ").append(esc(sha.length() > 10 ? sha.substring(0, 10) : sha))
                        .append(" ").append(esc(ci.note == null ? "" : ci.note));
                if (ci.reviewNote != null && !ci.reviewNote.isEmpty()) {
                    sb.append("<br>&nbsp;&nbsp;<font color='#D43A3A'>⚠ ").append(esc(ci.reviewNote)).append("</font>");
                }
                sb.append("<br>");
            }
            sb.append("</html>");
            Messages.showWarningDialog(project, sb.toString(), "无法标记通过");
            return;
        }
        // ② 合并：把子任务开发分支合入所属子需求的「需求分支」（主仓库；已合入跳过、冲突拒绝）
        final long mergeNid = currentNodeId;
        ApplicationManager.getApplication().executeOnPooledThread(() -> {
            try {
                JsonObject res = api.mergeNode(mergeNid);
                JsonArray results = res.getAsJsonArray("results");
                StringBuilder sb = new StringBuilder();
                boolean anyFail = false;
                if (results != null) {
                    for (JsonElement el : results) {
                        JsonObject r = el.getAsJsonObject();
                        String repo = str(r, "repo", "");
                        String br = str(r, "branch", "");
                        boolean ok = r.has("ok") && r.get("ok").getAsBoolean();
                        if (ok) {
                            if (r.has("alreadyMerged") && r.get("alreadyMerged").getAsBoolean()) {
                                sb.append("✓ ").append(repo).append(" ").append(br).append("（已合入，跳过）\n");
                            } else {
                                sb.append("✓ ").append(repo).append(" ").append(br).append(" → ").append(str(r, "target", "")).append("\n");
                            }
                        } else {
                            anyFail = true;
                            sb.append("✗ ").append(repo).append(" ").append(br).append("：").append(str(r, "reason", "")).append("\n");
                            String msg = str(r, "message", "");
                            if (!msg.isEmpty()) {
                                sb.append("    ").append(msg.split("\n")[0]).append("\n");
                            }
                        }
                    }
                } else if (res.has("note")) {
                    sb.append(res.get("note").getAsString());
                }
                final String text = "合并结果（目标分支 " + str(res, "reqBranch", "") + "）：\n\n" + sb;
                final boolean fail = anyFail;
                SwingUtilities.invokeLater(() -> {
                    if (fail) {
                        Messages.showWarningDialog(project,
                                text + "\n有冲突/失败——请先在终端解决（或修复后重试），解决后再标记通过。",
                                "无法标记通过");
                        return;
                    }
                    reviewSummary.setText("合并完成，已标记通过");
                    markChecked("approved", null);
                });
            } catch (Exception ex) {
                SwingUtilities.invokeLater(() -> reviewSummary.setText("合并失败（未通过）：" + ex.getMessage()));
            }
        });
    }

    private void markCheckedWithNote() {
        if (checkedCommits().isEmpty()) {
            reviewSummary.setText("请先在「提交列表」中勾选要操作的 commit");
            return;
        }
        String note = JOptionPane.showInputDialog(reviewTree, "问题说明（可空）：", "标记有问题", JOptionPane.PLAIN_MESSAGE);
        if (note == null) return;
        markChecked("issue", note.isEmpty() ? null : note);
    }

    // ================= 详情区 =================

    private void onCommitSelected(TreeSelectionEvent e) {
        CommitItem ci = selectedCommit();
        if (ci == null) return;
        // 单击提交：只看这一个（先清空勾选，右侧切到单提交详情）
        if (!checkedCommits().isEmpty()) {
            clearAllChecks();
        }
        showCommitDetail(ci);
    }

    /** 全部取消勾选（界面同步） */
    private void clearAllChecks() {
        setAllChecked(false);
    }

    /** 全选 ⇄ 全不选（按钮 toggle） */
    private void toggleSelectAll() {
        int visible = 0;
        Enumeration<?> e = reviewRoot.breadthFirstEnumeration();
        while (e.hasMoreElements()) {
            if (e.nextElement() instanceof CheckedTreeNode cn && cn.getUserObject() instanceof CommitItem) visible++;
        }
        boolean allChecked = visible > 0 && checkedCommits().size() >= visible;
        setAllChecked(!allChecked);
    }

    /** 反选（已勾选与未勾选互换） */
    private void invertChecks() {
        Enumeration<?> e = reviewRoot.breadthFirstEnumeration();
        while (e.hasMoreElements()) {
            Object o = e.nextElement();
            if (o instanceof CheckedTreeNode cn && cn.getUserObject() instanceof CommitItem) {
                cn.setChecked(!cn.isChecked());
            }
        }
        reviewModel().nodeStructureChanged(reviewRoot);
        refreshDetailForChecked();
        writeReviewContext();
    }

    /** 将所有可见提交勾选状态统一置为 checked（界面同步） */
    private void setAllChecked(boolean checked) {
        Enumeration<?> e = reviewRoot.breadthFirstEnumeration();
        while (e.hasMoreElements()) {
            Object o = e.nextElement();
            if (o instanceof CheckedTreeNode cn && cn.getUserObject() instanceof CommitItem) {
                cn.setChecked(checked);
            }
        }
        reviewModel().nodeStructureChanged(reviewRoot);
        refreshDetailForChecked();
        writeReviewContext();
    }

    /** 勾选变化（防抖后） */
    private void onChecksChanged() {
        refreshDetailForChecked();
        writeReviewContext();
    }

    // ---------- 多 commit 合并变更 ----------

    private void loadCombined(List<CommitItem> sel) {
        detailRoot.removeAllChildren();
        detailModel.reload();
        setCommitInfos(java.util.Collections.singletonList("<html><i>加载 " + sel.size() + " 个 commit 的合并变更…</i></html>"));
        long token = ++detailToken;
        long[] cids = new long[sel.size()];
        for (int i = 0; i < sel.size(); i++) cids[i] = sel.get(i).cid;
        ApplicationManager.getApplication().executeOnPooledThread(() -> {
            try {
                JsonObject res = api.combinedDiff(cids);
                SwingUtilities.invokeLater(() -> {
                    if (token != detailToken) return;
                    buildCombinedDetail(res, sel);
                });
            } catch (Exception ex) {
                SwingUtilities.invokeLater(() -> {
                    if (token == detailToken) {
                        setCommitInfos(java.util.Collections.singletonList("<html><font color='#D43A3A'>加载合并变更失败：" + esc(ex.getMessage()) + "</font></html>"));
                    }
                });
            }
        });
    }

    private void buildCombinedDetail(JsonObject res, List<CommitItem> sel) {
        DefaultMutableTreeNode root = new DefaultMutableTreeNode("root");
        JsonArray repos = res.getAsJsonArray("repos");
        int totalFiles = 0;
        aggregateTitle = "合并变更（" + sel.size() + " commits）";
        List<DiffOpener.FileDiff> agg = new ArrayList<>();
        if (repos != null) {
            for (JsonElement rel : repos) {
                JsonObject repoObj = rel.getAsJsonObject();
                String repoName = repoObj.getAsJsonObject("repo").get("name").getAsString();
                DefaultMutableTreeNode repoNode = new DefaultMutableTreeNode(new DirNode(repoName, true));
                root.add(repoNode);
                Map<String, DefaultMutableTreeNode> dirs = new LinkedHashMap<>();
                JsonArray files = repoObj.getAsJsonArray("files");
                if (files != null) {
                    for (JsonElement el : files) {
                        JsonObject f = el.getAsJsonObject();
                        FileNode fn = new FileNode();
                        fn.path = f.get("path").getAsString();
                        String[] parts = fn.path.split("/");
                        fn.name = parts[parts.length - 1];
                        fn.additions = f.has("additions") ? f.get("additions").getAsInt() : 0;
                        fn.deletions = f.has("deletions") ? f.get("deletions").getAsInt() : 0;
                        fn.binary = f.has("binary") && f.get("binary").getAsBoolean();
                        fn.title = aggregateTitle;
                        fn.oldText = f.has("old") && !f.get("old").isJsonNull() ? f.get("old").getAsString() : "";
                        fn.newText = f.has("new") && !f.get("new").isJsonNull() ? f.get("new").getAsString() : "";
                        if (!fn.binary) agg.add(new DiffOpener.FileDiff(fn.path, fn.oldText, fn.newText));
                        addFileUnder(repoNode, dirs, repoName, fn);
                        totalFiles++;
                    }
                }
                int cnt = 0;
                for (int i = 0; i < repoNode.getChildCount(); i++) {
                    DefaultMutableTreeNode c = (DefaultMutableTreeNode) repoNode.getChildAt(i);
                    if (isDirNode(c)) cnt += countAndCollapse(c);
                    else cnt++;
                }
                ((DirNode) repoNode.getUserObject()).fileCount = cnt;
            }
        }
        aggregateFiles = agg;
        writeReviewContext();
        detailRoot.removeAllChildren();
        while (root.getChildCount() > 0) detailRoot.add((DefaultMutableTreeNode) root.getChildAt(0));
        detailModel.reload();
        for (int i = 0; i < detailTree.getRowCount(); i++) detailTree.expandRow(i);

        // 信息区：列出参与合并的多个 commit（最新在前）
        JsonArray commits = res.getAsJsonArray("commits");
        List<String> infos = new ArrayList<>();
        if (commits != null) {
            for (int i = commits.size() - 1; i >= 0; i--) {
                JsonObject c = commits.get(i).getAsJsonObject();
                infos.add(commitInfoHtml(str(c, "note", ""), str(c, "sha", ""), str(c, "author", ""), str(c, "date", ""), c.getAsJsonArray("branches"), currentNodeNo()));
            }
        }
        if (infos.isEmpty()) {
            infos.add("<html><i>合并变更 · 已选 " + sel.size() + " 个 commit · 共 " + totalFiles + " 个文件</i></html>");
        }
        // 问题汇总（"有问题"状态的 commit 与意见）——置顶
        List<CommitItem> issueItems = new ArrayList<>();
        for (CommitItem ci : sel) {
            if ("issue".equals(ci.reviewStatus)) {
                issueItems.add(ci);
            }
        }
        if (!issueItems.isEmpty()) {
            StringBuilder ib = new StringBuilder("<html><font color='#D43A3A'><b>⚠ 待解决问题（" + issueItems.size() + "）</b></font><br>");
            for (CommitItem ci : issueItems) {
                String sha = ci.sha == null ? "" : ci.sha;
                ib.append("• ").append(esc(sha.length() > 10 ? sha.substring(0, 10) : sha))
                        .append(" ").append(esc(ci.note == null ? "" : ci.note));
                if (ci.reviewNote != null && !ci.reviewNote.isEmpty()) {
                    ib.append("<br>&nbsp;&nbsp;<font color='#D43A3A'>").append(esc(ci.reviewNote)).append("</font>");
                }
                ib.append("<br>");
            }
            ib.append("</html>");
            infos.add(0, ib.toString());
        }
        setCommitInfos(infos);
    }

    private void showCommitDetail(CommitItem ci) {
        JsonObject cached = diffCache.get(ci.cid);
        if (cached != null) {
            buildDetail(cached, ci);
            return;
        }
        detailRoot.removeAllChildren();
        detailModel.reload();
        setCommitInfos(java.util.Collections.singletonList("<html><i>加载变更中… " + esc(ci.sha) + "</i></html>"));
        long token = ++detailToken;
        ApplicationManager.getApplication().executeOnPooledThread(() -> {
            try {
                JsonObject diff = api.commitDiff(ci.cid);
                SwingUtilities.invokeLater(() -> {
                    if (token != detailToken) return;
                    diffCache.put(ci.cid, diff);
                    buildDetail(diff, ci);
                });
            } catch (Exception ex) {
                SwingUtilities.invokeLater(() -> {
                    if (token == detailToken) {
                        setCommitInfos(java.util.Collections.singletonList("<html><font color='#D43A3A'>加载失败：" + esc(ex.getMessage()) + "</font></html>"));
                    }
                });
            }
        });
    }

    /** 构建 Git Log 式详情：目录层级文件树（路径压缩）+ commit 信息 */
    private void buildDetail(JsonObject diff, CommitItem ci) {
        String repoName = ci.repo == null || ci.repo.isEmpty() ? "changes" : ci.repo;
        DefaultMutableTreeNode root = new DefaultMutableTreeNode("root");
        DefaultMutableTreeNode repoNode = new DefaultMutableTreeNode(new DirNode(repoName, true));
        root.add(repoNode);
        Map<String, DefaultMutableTreeNode> dirs = new LinkedHashMap<>();
        JsonArray files = diff.getAsJsonArray("files");
        if (files != null) {
            for (JsonElement el : files) {
                JsonObject f = el.getAsJsonObject();
                FileNode fn = new FileNode();
                fn.cid = ci.cid;
                fn.sha = ci.sha;
                fn.path = f.get("path").getAsString();
                String[] parts = fn.path.split("/");
                fn.name = parts[parts.length - 1];
                fn.additions = f.has("additions") ? f.get("additions").getAsInt() : 0;
                fn.deletions = f.has("deletions") ? f.get("deletions").getAsInt() : 0;
                fn.binary = f.has("binary") && f.get("binary").getAsBoolean();
                addFileUnder(repoNode, dirs, repoName, fn);
            }
        }
        int total = 0;
        for (int i = 0; i < repoNode.getChildCount(); i++) {
            DefaultMutableTreeNode c = (DefaultMutableTreeNode) repoNode.getChildAt(i);
            if (isDirNode(c)) total += countAndCollapse(c);
            else total++;
        }
        ((DirNode) repoNode.getUserObject()).fileCount = total;

        detailRoot.removeAllChildren();
        while (root.getChildCount() > 0) detailRoot.add((DefaultMutableTreeNode) root.getChildAt(0));
        detailModel.reload();
        for (int i = 0; i < detailTree.getRowCount(); i++) detailTree.expandRow(i);

        List<String> infos = new ArrayList<>();
        infos.add(commitInfoHtml(ci.note, ci.sha, str(diff, "author", ""), str(diff, "date", ""), diff.getAsJsonArray("branches"), currentNodeNo()));
        if ("issue".equals(ci.reviewStatus) && ci.reviewNote != null && !ci.reviewNote.isEmpty()) {
            infos.add("<html><font color='#D43A3A'><b>⚠ 问题：</b></font>" + esc(ci.reviewNote) + "</html>");
        }
        setCommitInfos(infos);
    }

    // ---------- 信息区（下方 commit 信息列表） ----------

    /** 当前节点编号（节点名开头 N / N.M / N.M.P；无则空）——编号直接取自节点名，无需人工维护 */
    private String currentNodeNo() {
        try {
            java.util.regex.Matcher m = java.util.regex.Pattern
                    .compile("^\\s*(\\d+(?:\\.\\d+)*)").matcher(currentNodeName == null ? "" : currentNodeName);
            return m.find() ? m.group(1) : "";
        } catch (Throwable t) {
            return "";
        }
    }

    /** 展示一组 commit 信息（每项一段 HTML；空列表显示占位） */
    private void setCommitInfos(List<String> htmls) {
        commitInfoPanel.removeAll();
        if (htmls.isEmpty()) {
            JBLabel empty = new JBLabel(" ");
            empty.setBorder(BorderFactory.createEmptyBorder(6, 8, 6, 8));
            commitInfoPanel.add(empty);
        } else {
            for (int i = 0; i < htmls.size(); i++) {
                if (i > 0) {
                    JSeparator sep = new JSeparator();
                    sep.setMaximumSize(new Dimension(Integer.MAX_VALUE, sep.getPreferredSize().height));
                    commitInfoPanel.add(sep);
                }
                JBLabel label = new JBLabel(htmls.get(i));
                label.setBorder(BorderFactory.createEmptyBorder(6, 8, 6, 8));
                label.setVerticalAlignment(SwingConstants.TOP);
                commitInfoPanel.add(label);
            }
        }
        commitInfoPanel.revalidate();
        commitInfoPanel.repaint();
    }

    /** 单条 commit 信息 HTML：标题 / sha·作者·时间 / 分支 */
    private static String commitInfoHtml(String note, String sha, String author, String dateIso, JsonArray branches, String nodeNo) {
        StringBuilder h = new StringBuilder("<html>");
        if (nodeNo != null && !nodeNo.isEmpty()) {
            h.append("<font color='#5C6BC0'>[").append(esc(nodeNo)).append("]</font> ");
        }
        h.append("<b>").append(esc(note == null ? "" : note)).append("</b>");
        StringBuilder line2 = new StringBuilder();
        if (sha != null && !sha.isEmpty()) line2.append(sha.length() > 9 ? sha.substring(0, 9) : sha);
        if (author != null && !author.isEmpty()) {
            if (line2.length() > 0) line2.append("  ·  ");
            line2.append(esc(author));
        }
        String d = fmtDate(dateIso == null ? "" : dateIso);
        if (!d.isEmpty()) {
            if (line2.length() > 0) line2.append("  ·  ");
            line2.append(d);
        }
        if (line2.length() > 0) h.append("<br><font color='#808080'>").append(line2).append("</font>");
        if (branches != null && branches.size() > 0) {
            h.append("<br><font color='#5C6BC0'>🏷 ");
            for (int i = 0; i < Math.min(branches.size(), 4); i++) {
                if (i > 0) h.append("  ");
                h.append(esc(branches.get(i).getAsString()));
            }
            h.append("</font>");
        }
        h.append("</html>");
        return h.toString();
    }

    /** 按路径把文件挂到目录树（自动建目录节点） */
    private void addFileUnder(DefaultMutableTreeNode repoNode, Map<String, DefaultMutableTreeNode> dirs, String repoKey, FileNode fn) {
        String[] parts = fn.path.split("/");
        DefaultMutableTreeNode parent = repoNode;
        StringBuilder key = new StringBuilder(repoKey);
        for (int i = 0; i < parts.length - 1; i++) {
            key.append('/').append(parts[i]);
            DefaultMutableTreeNode dirNode = dirs.get(key.toString());
            if (dirNode == null) {
                dirNode = new DefaultMutableTreeNode(new DirNode(parts[i], false));
                parent.add(dirNode);
                dirs.put(key.toString(), dirNode);
            }
            parent = dirNode;
        }
        parent.add(new DefaultMutableTreeNode(fn));
    }

    private static boolean isDirNode(Object o) {
        return o instanceof DefaultMutableTreeNode n && n.getUserObject() instanceof DirNode;
    }

    /** 递归：压缩单链目录（唯一子节点为目录且无文件时合并名称）+ 统计子树文件数 */
    private static int countAndCollapse(DefaultMutableTreeNode dirNode) {
        while (dirNode.getChildCount() == 1 && isDirNode(dirNode.getChildAt(0))) {
            DefaultMutableTreeNode child = (DefaultMutableTreeNode) dirNode.getChildAt(0);
            DirNode pd = (DirNode) dirNode.getUserObject();
            DirNode cd = (DirNode) child.getUserObject();
            dirNode.setUserObject(new DirNode(pd.name + "/" + cd.name, pd.repo));
            dirNode.removeAllChildren();
            while (child.getChildCount() > 0) dirNode.add((DefaultMutableTreeNode) child.getChildAt(0));
        }
        int count = 0;
        for (int i = 0; i < dirNode.getChildCount(); i++) {
            DefaultMutableTreeNode c = (DefaultMutableTreeNode) dirNode.getChildAt(i);
            if (isDirNode(c)) count += countAndCollapse(c);
            else count++;
        }
        ((DirNode) dirNode.getUserObject()).fileCount = count;
        return count;
    }

    private static String fmtDate(String iso) {
        if (iso == null || iso.length() < 16) return iso == null ? "" : iso;
        return iso.substring(0, 10).replace('-', '/') + " " + iso.substring(11, 16);
    }

    private static String str(JsonObject o, String key, String def) {
        return o.has(key) && !o.get(key).isJsonNull() ? o.get(key).getAsString() : def;
    }

    private static String esc(String s) {
        if (s == null) return "";
        return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("\"", "&quot;");
    }

    // ================= 数据模型 =================

    private static class NodeData {
        long id;
        String type;
        String name;
        String status;

        @Override
        public String toString() {
            return name;
        }
    }

    private static class CommitItem {
        long cid;
        String sha;
        String note;
        String repo;
        String reviewStatus = "pending";
        String reviewNote;
        String reviewedBy;
        String test = "—";
        String pre = "—";
        String release = "—";
        /** 是否已合入需求分支（branches=true 时服务端返回；null=未知） */
        Boolean mergedToReq;

        static CommitItem from(JsonObject item) {
            CommitItem ci = new CommitItem();
            JsonObject c = item.getAsJsonObject("commit");
            ci.cid = c.get("id").getAsLong();
            ci.sha = c.get("sha").getAsString();
            ci.note = c.has("note") && !c.get("note").isJsonNull() ? c.get("note").getAsString() : "";
            ci.repo = c.has("repo") && !c.get("repo").isJsonNull() ? c.get("repo").getAsString() : "";
            ci.reviewStatus = c.has("reviewStatus") && !c.get("reviewStatus").isJsonNull()
                    ? c.get("reviewStatus").getAsString() : "pending";
            ci.reviewNote = c.has("reviewNote") && !c.get("reviewNote").isJsonNull() ? c.get("reviewNote").getAsString() : null;
            ci.reviewedBy = c.has("reviewedBy") && !c.get("reviewedBy").isJsonNull() ? c.get("reviewedBy").getAsString() : null;
            JsonObject track = item.has("track") && !item.get("track").isJsonNull() ? item.getAsJsonObject("track") : null;
            ci.test = stateOf(track, "test");
            ci.pre = stateOf(track, "pre");
            ci.release = stateOf(track, "release");
            // 是否已合入需求分支（branches=true 时服务端返回；null=未知）
            if (c.has("mergedToReq") && !c.get("mergedToReq").isJsonNull()) {
                ci.mergedToReq = c.get("mergedToReq").getAsBoolean();
            }
            return ci;
        }

        String reviewMark() {
            return switch (reviewStatus) {
                case "approved" -> "✓";
                case "issue" -> "✗";
                default -> "○";
            };
        }

        String display() {
            String flag = (mergedToReq != null && !mergedToReq) ? "⚠未合并 " : "";
            return flag + reviewMark() + " " + sha + "  " + note;
        }

        String reviewTooltip() {
            StringBuilder sb = new StringBuilder();
            switch (reviewStatus) {
                case "approved" -> sb.append("已审查通过");
                case "issue" -> sb.append("审查有问题");
                default -> sb.append("待审查");
            }
            if (reviewedBy != null) sb.append(" · 审者: ").append(reviewedBy);
            if (reviewNote != null && !reviewNote.isEmpty()) sb.append(" · 意见: ").append(reviewNote);
            return sb.toString();
        }

        private static String stateOf(JsonObject track, String key) {
            if (track == null || !track.has(key) || track.get(key).isJsonNull()) return "—";
            JsonObject t = track.getAsJsonObject(key);
            if (!t.has("contained") || t.get("contained").isJsonNull()) return "—";
            return t.get("contained").getAsBoolean() ? "✓" : "✗";
        }
    }

    private static class DirNode {
        String name;
        final boolean repo;
        int fileCount;

        DirNode(String name, boolean repo) {
            this.name = name;
            this.repo = repo;
        }

        @Override
        public String toString() {
            return name;
        }
    }

    private static class FileNode {
        long cid;
        String sha;
        String path;
        String name;
        int additions;
        int deletions;
        boolean binary;
        // 聚合模式（多 commit 合并变更）：非 null 时直接打开本地 old/new，不再走 API
        String title;
        String oldText;
        String newText;

        @Override
        public String toString() {
            String stat = binary ? "  (二进制)" : "  (+" + additions + " / -" + deletions + ")";
            return name + stat;
        }
    }

    // ================= 渲染 =================

    private static class SelectTreeRenderer extends DefaultTreeCellRenderer {
        @Override
        public Component getTreeCellRendererComponent(JTree tree, Object value, boolean sel,
                                                      boolean expanded, boolean leaf, int row, boolean hasFocus) {
            super.getTreeCellRendererComponent(tree, value, sel, expanded, leaf, row, hasFocus);
            if (value instanceof DefaultMutableTreeNode n && n.getUserObject() instanceof NodeData d) {
                setText(d.name);
                setIcon(iconFor(d.type));
                setToolTipText("[" + d.type + "] " + d.name + "（双击进入 Review）");
            } else {
                setIcon(AllIcons.Nodes.Folder);
            }
            return this;
        }

        /** 按节点类型给平台图标（项目/需求/子需求/任务组/任务） */
        private static Icon iconFor(String type) {
            return switch (type) {
                case "project" -> AllIcons.Nodes.Project;
                case "requirement" -> AllIcons.Nodes.Module;
                case "subreq", "group" -> AllIcons.Nodes.Folder;
                case "task" -> AllIcons.General.TodoDefault;
                default -> AllIcons.Nodes.NodePlaceholder;
            };
        }
    }

    /** Git 风格渲染：原生文件夹/文件图标 + 灰色 N files + 绿加/红减统计 */
    private static class DetailTreeRenderer extends DefaultTreeCellRenderer {
        @Override
        public Component getTreeCellRendererComponent(JTree tree, Object value, boolean sel,
                                                      boolean expanded, boolean leaf, int row, boolean hasFocus) {
            super.getTreeCellRendererComponent(tree, value, sel, expanded, leaf, row, hasFocus);
            Object user = value instanceof DefaultMutableTreeNode n ? n.getUserObject() : null;
            if (user instanceof DirNode d) {
                setIcon(AllIcons.Nodes.Folder);
                String count = d.fileCount > 0
                        ? "&nbsp;&nbsp;<font color='#999999'>" + d.fileCount + " file" + (d.fileCount == 1 ? "" : "s") + "</font>"
                        : "";
                setText("<html>" + esc(d.name) + count + "</html>");
                setToolTipText(d.name);
            } else if (user instanceof FileNode f) {
                setIcon(FileTypeManager.getInstance().getFileTypeByFileName(f.name).getIcon());
                String stat = f.binary
                        ? ""
                        : "&nbsp;&nbsp;<font color='#57965C'>+" + f.additions + "</font> <font color='#C75450'>-" + f.deletions + "</font>";
                setText("<html>" + esc(f.name) + stat + "</html>");
                setToolTipText(f.path + "（双击查看 IDEA Diff）");
            }
            return this;
        }
    }
}
