package com.xiaopeng.taskboard;

import org.intellij.markdown.IElementType;
import org.intellij.markdown.ast.ASTNode;
import org.intellij.markdown.flavours.MarkdownFlavourDescriptor;
import org.intellij.markdown.flavours.gfm.GFMFlavourDescriptor;
import org.intellij.markdown.html.GeneratingProvider;
import org.intellij.markdown.html.HtmlGenerator;
import org.intellij.markdown.parser.LinkMap;
import org.intellij.markdown.parser.MarkdownParser;

import java.util.HashMap;
import java.util.Map;

/**
 * 详情面板用：Markdown → HTML，交给 JCEF 渲染。
 *
 * 用 IDEA 自带的 {@code org.intellij.markdown}（GFM 方言：表格 / 任务列表 / 删除线 / 自动链接），
 * 不再走 Swing 的 HTML 布局——JEditorPane 在 IDEA 容器里会 BoxView 死循环（见 features/merge-flow/design.md）。
 *
 * 安全：默认 providers 会把文档里的原始 HTML（{@code <script>}、{@code <img onerror=…>}）原样透传进
 * 渲染页。这里把 HTML_BLOCK / HTML_TAG 换成转义 provider，文档里的原始 HTML 只以文本呈现。
 */
public final class MarkdownRenderer {

    private static final MarkdownFlavourDescriptor FLAVOUR = new GFMFlavourDescriptor();

    private MarkdownRenderer() {
    }

    /** Markdown → 正文 HTML 片段（不含 <html>/<head>；条目自身的 <body> 包装已剥离） */
    public static String toBodyHtml(String markdown) {
        String md = markdown == null ? "" : markdown.replace("\r\n", "\n");
        ASTNode tree = new MarkdownParser(FLAVOUR).buildMarkdownTreeFromString(md);
        Map<IElementType, GeneratingProvider> providers =
                new HashMap<>(FLAVOUR.createHtmlGeneratingProviders(new LinkMap(new HashMap<>()), null));
        for (Map.Entry<IElementType, GeneratingProvider> entry : providers.entrySet()) {
            String name = entry.getKey().getName();
            if (name != null && (name.endsWith("HTML_BLOCK") || name.endsWith("HTML_TAG"))) {
                entry.setValue((visitor, text, node) -> visitor.consumeHtml(
                        escapeHtml(text.subSequence(node.getStartOffset(), node.getEndOffset()).toString())));
            }
        }
        String html = new HtmlGenerator(md, tree, providers, false)
                .generateHtml((node, text, attributes) -> attributes);
        return stripBodyWrapper(html);
    }

    /** Markdown → 可交给 JBCefBrowser.loadHTML 的完整页面（自带样式，随主题亮/暗切换） */
    public static String toPage(String markdown, boolean dark) {
        return "<!DOCTYPE html><html><head><meta charset=\"utf-8\">"
                + styleSheet(dark)
                + "</head><body><div class=\"tb-md\">"
                + toBodyHtml(markdown)
                + "</div></body></html>";
    }

    /** 剥掉生成器最外层的 <body>，避免在自建 <div> 里嵌套 body（浏览器容错但结构非法） */
    private static String stripBodyWrapper(String html) {
        String out = html.trim();
        if (out.startsWith("<body>")) {
            out = out.substring("<body>".length());
        }
        if (out.endsWith("</body>")) {
            out = out.substring(0, out.length() - "</body>".length());
        }
        return out.trim();
    }

    static String escapeHtml(String s) {
        if (s == null) {
            return "";
        }
        StringBuilder sb = new StringBuilder(s.length() + 16);
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '&' -> sb.append("&amp;");
                case '<' -> sb.append("&lt;");
                case '>' -> sb.append("&gt;");
                case '"' -> sb.append("&quot;");
                case '\'' -> sb.append("&#39;");
                default -> sb.append(c);
            }
        }
        return sb.toString();
    }

    private static String styleSheet(boolean dark) {
        String bg = dark ? "#1e1f22" : "#ffffff";
        String fg = dark ? "#bcbec4" : "#1f2329";
        String muted = dark ? "#8b8d91" : "#8a8f99";
        String link = dark ? "#4d9ef7" : "#1a6ddd";
        String border = dark ? "#43454a" : "#e4e7ed";
        String codeBg = dark ? "#2b2d30" : "#f6f8fa";
        String quoteBar = dark ? "#4b4d52" : "#dcdfe6";
        return "<style>"
                + "html,body{margin:0;padding:0;background:" + bg + ";}"
                + "body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;"
                + "font-size:13px;line-height:1.7;color:" + fg + ";}"
                + ".tb-md{padding:12px 16px 24px 16px;word-wrap:break-word;}"
                + "a{color:" + link + ";text-decoration:none;}"
                + "a:hover{text-decoration:underline;}"
                + "h1{font-size:19px;margin:16px 0 8px 0;}"
                + "h2{font-size:17px;margin:14px 0 8px 0;}"
                + "h3{font-size:15px;margin:12px 0 6px 0;}"
                + "h4,h5,h6{font-size:13px;margin:10px 0 6px 0;}"
                + "h1,h2{border-bottom:1px solid " + border + ";padding-bottom:4px;}"
                + "hr{border:none;border-top:1px solid " + border + ";margin:14px 0;}"
                + "p{margin:6px 0;}"
                + "ul,ol{margin:6px 0;padding-left:22px;}"
                + "li{margin:2px 0;}"
                + "li.task-list-item{list-style:none;margin-left:-18px;}"
                + "li.task-list-item input{margin-right:6px;vertical-align:middle;}"
                + "code{font-family:Menlo,Consolas,'Courier New',monospace;font-size:12px;"
                + "background:" + codeBg + ";padding:1px 5px;border-radius:3px;}"
                + "pre{background:" + codeBg + ";padding:10px 12px;border-radius:5px;overflow:auto;}"
                + "pre code{background:none;padding:0;font-size:12px;white-space:pre;}"
                + "blockquote{margin:8px 0;padding:2px 12px;border-left:3px solid " + quoteBar + ";color:" + muted + ";}"
                + "table{border-collapse:collapse;margin:8px 0;}"
                + "th,td{border:1px solid " + border + ";padding:4px 10px;text-align:left;}"
                + "th{background:" + codeBg + ";}"
                + "img{max-width:100%;}"
                + ".del,del,.user-del,s,.tb-md s{color:" + muted + ";text-decoration:line-through;}"
                + "</style>";
    }
}
