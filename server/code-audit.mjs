/**
 * 代码检查（code audit）：对「已登记提交新增的代码行」做只读静态审查。
 *
 * 设计要点（与 features/code-audit/design.md 对齐）：
 * - 只扫描 **diff 里的新增行**，不看既有代码：代码检查要回答的是「这次改动引入了什么风险」，
 *   扫全文件会把历史遗留问题算到本次交付头上，噪声大到没人看。
 * - 本模块是**纯函数**（输入若干行文本，输出命中项），不碰 db / git / 网络，便于单测与复用。
 * - 结论不落库：与 acceptance_report / readiness / release_checklist 同一条「只读聚合」原则。
 * - 证据必须脱敏：命中硬编码凭据时只回显掩码，避免代码检查本身成为第二条泄露通道。
 */

/** 扫描声明为代码 / 配置的扩展名（这些才做 console.log / eval 之类的语言级规则） */
const CODE_EXTENSIONS = new Set([
  'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'vue', 'svelte',
  'py', 'java', 'kt', 'kts', 'scala', 'go', 'rs', 'rb', 'php', 'cs', 'swift',
  'c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'm', 'mm',
  'sh', 'bash', 'zsh', 'sql'
])

/** 疑似测试文件的路径（`.only` / `fit` 只在这类文件里判危险） */
const TEST_PATH_RE = /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[a-z0-9]+$/i

/** 纯注释行：不参与语言级规则，避免把注释掉的代码 / 示例误判成风险 */
const COMMENT_LINE_RE = /^\s*(\/\/|#|\*|\/\*|--\b|<!--)/

/** 占位符 / 环境变量 / 明显非真实凭据的值：命中硬编码规则时排除 */
const PLACEHOLDER_VALUE_RE =
  /(xxx|your[-_]?|example|sample|placeholder|changeme|change[-_]?me|dummy|fake|test[-_]?|redacted|\*\*\*|process\.env|\$\{|\{\{|<[^>]+>|%s|\.\.\.)/i

/**
 * `key: value` / `key = value` / `KEY=value` 形式，值是可观测的字符串字面量。
 * 不锚定行首：真实写法常带声明关键字或类型（`const password = '…'` / `String apiKey = "…"`）。
 * 值至少 8 个字符且不含空白，避免把 `password === x` 这类比较误判成赋值。
 */
const SECRET_ASSIGN_RE =
  /[A-Za-z0-9_.-]*(?<key>password|passwd|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|accesskey|private[_-]?key|credential)[A-Za-z0-9_.-]*\s*["']?\s*[:=]\s*(?<quote>['"]?)(?<value>[^\s'"]{8,})\k<quote>/i

/**
 * 全行扫描用副本：`g` 找出**一行里的所有**凭据赋值。
 * 直接复用上面的 source，保证命中口径与单条版一致（改一边不会漂移）。
 */
const SECRET_ASSIGN_SCAN_RE = new RegExp(SECRET_ASSIGN_RE.source, 'gi')

/**
 * 收集一行里所有「非占位」的凭据字面值（去重）。
 *
 * 必须扫**全部**匹配而不是只取第一条：一行两个凭据赋值时只看第一条会漏掉后面的。
 */
function collectSecretValues(line) {
  const values = new Set()
  for (const m of line.matchAll(SECRET_ASSIGN_SCAN_RE)) {
    const value = m.groups.value
    if (PLACEHOLDER_VALUE_RE.test(value)) continue
    values.add(value)
  }
  return [...values]
}

/** 该行是否至少有一个非占位的凭据赋值（命中判定与掩码共用同一套扫描） */
function hasHardcodedSecret(line) {
  return collectSecretValues(line).length > 0
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 掩码一行里**所有**凭据值的出现位置，返回新的行文本。
 *
 * 三条约束决定了实现方式：
 * 1. 一行可能有多个凭据赋值，必须逐个处理，不能只看第一条；
 * 2. 不能用 `line.replace(value, mask)` 裸替换——那是**按文本**命中第一个相同文本，
 *    当第二个凭据的值与前面的普通字符串相同时（QA D1 最小复现
 *    `const note = 'leakvalue999'; const token = 'leakvalue999'`），被掩码的会是无辜的
 *    `note`，真正的凭据反而保持明文；
 * 3. 只掩码「赋值处那一个区间」仍然不够：同一个值若在本行别处也出现，凭据明文依旧可从
 *    片段里读出来。所以这里把**该值的所有出现位置**一起掩码——宁可多脱敏，不可漏脱敏。
 *
 * 用「一次正则交替 + 回调」而不是逐个 `replace` 串行处理，是为了避免短值先替换把长值
 * 打断（如同时存在 `abcdefgh` 与 `abcdefghij`），也不会二次处理已生成的掩码文本。
 */
function maskSecretValues(line) {
  const values = collectSecretValues(line)
  if (values.length === 0) return line
  // 长值优先，避免短值是长值前缀时先命中
  const pattern = [...values].sort((a, b) => b.length - a.length).map(escapeRegExp).join('|')
  const re = new RegExp(pattern, 'g')
  return line.replace(re, (hit) => maskSecret(hit))
}

/** 私钥块起始行：命中即高危（covers PEM / OpenSSH / PKCS8） */
const PRIVATE_KEY_RE = /-----BEGIN [A-Z ]*PRIVATE KEY-----/

export function fileExtension(filePath) {
  const m = /\.([A-Za-z0-9]+)$/.exec(String(filePath || ''))
  return m ? m[1].toLowerCase() : ''
}

export function isCodeFile(filePath) {
  return CODE_EXTENSIONS.has(fileExtension(filePath))
}

export function isTestFile(filePath) {
  return TEST_PATH_RE.test(String(filePath || ''))
}

function isCommentLine(text) {
  return COMMENT_LINE_RE.test(String(text || ''))
}

/** 命中硬编码凭据时给出掩码值（保留 2 个字符 + 长度提示，绝不回显原值） */
function maskSecret(value) {
  const s = String(value || '')
  if (!s) return '***'
  return `${s.slice(0, 2)}***(${s.length})`
}

/**
 * 规则集。`test(line, path)` 返回 true 即命中；`mask` 可选，用于改写信道证据。
 * 值域稳定：`severity` 只有 danger（阻塞就绪）/ warn（仅提示）两档。
 *
 * 与上线 SQL 风险审查同一套分级纪律（决策 40）：不可逆 / 会静默吞掉验证的风险才阻塞，
 * 遗留调试输出、待办标记这类只提示，不让「有一条 console.log」把交付结论拦成红灯。
 */
export const CODE_AUDIT_RULES = [
  {
    key: 'merge_conflict_marker',
    severity: 'danger',
    title: '未解决的合并冲突标记',
    suggestion: '解决冲突并移除 <<<<<<< / ||||||| / >>>>>>> 标记后再提交',
    // 只认这三类唯一的冲突标记；不把单独的 ======= 当冲突（markdown 分隔线会误伤）
    test: (line) => /^(<<<<<<<|\|\|\|\|\|\|\||>>>>>>>)(\s|$)/.test(line)
  },
  {
    key: 'private_key_block',
    severity: 'danger',
    title: '私钥内容被写入代码',
    suggestion: '从提交历史中移除私钥、改用密钥服务读取，并立即轮换该密钥',
    test: (line) => PRIVATE_KEY_RE.test(line)
  },
  {
    key: 'focused_test',
    severity: 'danger',
    title: '测试被 .only / fit / fdescribe 聚焦',
    suggestion: '移除 .only / fit / fdescribe，避免其余用例被静默跳过',
    test: (line, path) => isTestFile(path) && /(\.only\s*\(|\bfit\s*\(|\bfdescribe\s*\()/.test(line)
  },
  {
    key: 'eval_usage',
    severity: 'danger',
    title: '用 eval / new Function 动态执行代码',
    suggestion: '改用显式分支或解析库，避免任意代码执行面',
    test: (line) => !isCommentLine(line) && /(\beval\s*\(|new\s+Function\s*\()/.test(line)
  },
  {
    key: 'hardcoded_secret',
    severity: 'danger',
    title: '疑似硬编码凭据',
    suggestion: '改为从环境变量 / 密钥服务读取，并轮换已进入提交历史的凭据',
    test: (line) => hasHardcodedSecret(line),
    mask: (line) => maskSecretValues(line)
  },
  {
    key: 'debugger_statement',
    severity: 'warn',
    title: '遗留 debugger 语句',
    suggestion: '移除调试断点',
    test: (line) => !isCommentLine(line) && /(^|[^\w.])debugger(\s*;|\s*$)/.test(line)
  },
  {
    key: 'console_log',
    severity: 'warn',
    title: '遗留 console.log 调试输出',
    suggestion: '改用统一日志或移除调试输出',
    test: (line, path) => isCodeFile(path) && !isTestFile(path) && !isCommentLine(line) && /\bconsole\.log\s*\(/.test(line)
  },
  {
    key: 'lint_suppression',
    severity: 'warn',
    title: '新增 lint / 类型检查抑制',
    suggestion: '说明抑制原因或修复根因，避免长期静默压制告警',
    test: (line) => /(eslint-disable|@ts-ignore|@ts-nocheck|@ts-expect-error|\bnolint\b|#\s*noqa\b)/.test(line)
  },
  {
    key: 'todo_marker',
    severity: 'warn',
    title: '新增 TODO / FIXME / HACK 标记',
    suggestion: '登记为待办或缺陷，避免遗留标记进入交付',
    test: (line) => /\b(TODO|FIXME|HACK|XXX)\b/.test(line)
  }
]

/** 规则字典（按 key 取元信息，供渲染层复用标题 / 建议） */
export const CODE_AUDIT_RULE_MAP = new Map(CODE_AUDIT_RULES.map((r) => [r.key, r]))

/** 证据片段上限：够看清是什么，又不至于把整行长文本塞进报告 */
const SNIPPET_MAX = 200

function clipSnippet(text) {
  const s = String(text == null ? '' : text)
  return s.length > SNIPPET_MAX ? `${s.slice(0, SNIPPET_MAX)}…` : s
}

/**
 * 扫描一批新增行。输入 [{ path, line, text }]，输出命中项：
 * [{ rule, severity, title, suggestion, path, line, snippet }]
 *
 * 同一行命中多条规则就产出多条；不做去重（不同规则的修复动作不同）。
 */
export function auditAddedLines(entries) {
  const findings = []
  for (const entry of entries || []) {
    const text = String(entry.text == null ? '' : entry.text)
    for (const rule of CODE_AUDIT_RULES) {
      if (!rule.test(text, entry.path)) continue
      findings.push({
        rule: rule.key,
        severity: rule.severity,
        title: rule.title,
        suggestion: rule.suggestion,
        path: entry.path,
        line: entry.line,
        // 命中硬编码凭据时先脱敏再截断：脱敏必须在截断**之前**，
        // 否则被截断的长值会以明文留在片段里（安全扫描不能成为泄露通道）。
        snippet: clipSnippet(rule.mask ? rule.mask(text) : text)
      })
    }
  }
  return findings
}

/**
 * 汇总扫描结果 → 顶层结论。
 *
 * 就绪三态（与 readiness / release-checklist / 验收报告同口径）：
 * - 有任一 danger 命中 → `ready=false`（确定不可交付）；
 * - 有读不到的提交（repo 未登记 / 路径无效 / sha 不存在）→ `ready=null`：
 *   看不到 ≠ 没问题，不能因为「有部分提交读失败」给出绿灯；
 * - 扫到了新增行且无 danger → `ready=true`；
 * - 范围内没有提交或没有任何新增行 → `ready=null`（没有可审查的代码，不是「检查通过」）。
 */
export function summarizeCodeAudit({ node, scope, items, truncated = false }) {
  const findings = []
  let addedLines = 0
  let errors = 0
  const files = new Set()
  for (const item of items || []) {
    addedLines += item.addedLines || 0
    if (item.error) errors += 1
    for (const f of item.files || []) files.add(`${(item.commit && item.commit.repo) || ''}@${(item.commit && item.commit.sha) || ''}:${f.path}`)
    for (const f of item.findings || []) findings.push(f)
  }
  const danger = findings.filter((f) => f.severity === 'danger')
  const warnings = findings.filter((f) => f.severity === 'warn')
  const byRule = {}
  for (const f of findings) byRule[f.rule] = (byRule[f.rule] || 0) + 1

  let ready
  if (danger.length > 0) ready = false
  else if (truncated) ready = null
  else if (errors > 0) ready = null
  else if (addedLines > 0) ready = true
  else ready = null

  return {
    node: { id: node.id, name: node.name, type: node.type },
    scope,
    ready,
    totals: {
      commits: (items || []).length,
      files: files.size,
      addedLines,
      findings: findings.length,
      danger: danger.length,
      warn: warnings.length,
      errors,
      truncated,
      byRule
    },
    blockers: danger,
    warnings,
    findings,
    items: items || []
  }
}
