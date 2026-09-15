import fs from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { openDb } from './db.mjs'
import { createStore } from './store.mjs'
import { loadConfig, saveConfig, maskToken, DB_PATH } from './config.mjs'
import { buildSchema, renderTreeMd, upsertByPath, importOutline, applyBatch, getCommitDiff, getNodeDiffs, getCommitTrack, getNodeTracks, getCombinedDiff, getNodeDuplicates, runTestCases, renderAcceptanceMd, renderAcceptanceStatusMd, runReleaseChecks, renderReleaseChecklistMd, renderReadinessMd, renderMindmapMd, renderDeliveryGateMd, renderDesignOutlineMd, applyDesignOutline, renderTestReportMd, setupWorkspace, getWorkspacePrompt, cleanupWorkspace, parseMaxParallelCli, renderSecretScanMd, renderDeliverySnapshotMd, renderReleaseSqlAuditMd, renderCodeAuditMd, getNodeCodeAudit } from './ops.mjs'
import { startAgentRun, retryAndDispatch, waitForAgentRun } from './agent.mjs'
import { saveUpload } from './uploads.mjs'

const OPTIONS = {
  path: { type: 'string' },
  type: { type: 'string' },
  name: { type: 'string' },
  status: { type: 'string' },
  parent: { type: 'string' },
  project: { type: 'string' },
  to: { type: 'string' },
  attr: { type: 'string', multiple: true },
  format: { type: 'string' },
  content: { type: 'string' },
  file: { type: 'string' },
  sha: { type: 'string' },
  repo: { type: 'string' },
  note: { type: 'string' },
  branch: { type: 'string' },
  'overwrite-branch': { type: 'boolean' },
  subtree: { type: 'boolean' },
  scope: { type: 'string' },
  'review-status': { type: 'string' },
  'review-note': { type: 'string' },
  kind: { type: 'string' },
  expectation: { type: 'string' },
  rollback: { type: 'string' },
  optional: { type: 'boolean' },
  'case-ids': { type: 'string' },
  'case-id': { type: 'string' },
  fanout: { type: 'boolean' },
  'max-parallel': { type: 'string' },
  'run-id': { type: 'string' },
  enabled: { type: 'string' },
  overwrite: { type: 'boolean' },
  limit: { type: 'string' },
  summary: { type: 'string' },
  detail: { type: 'string' },
  decision: { type: 'string' },
  comment: { type: 'string' },
  prompt: { type: 'string' },
  model: { type: 'string' },
  cwd: { type: 'string' },
  agent: { type: 'string' },
  session: { type: 'string' },
  resume: { type: 'boolean' },
  runtime: { type: 'string' },
  daemon: { type: 'string' },
  provider: { type: 'string' },
  'device-info': { type: 'string' },
  visibility: { type: 'string' },
  id: { type: 'string' },
  'runtime-mode': { type: 'string' },
  reason: { type: 'string' },
  'failure-reason': { type: 'string' },
  'cli-session': { type: 'string' },
  'work-dir': { type: 'string' },
  'exit-code': { type: 'string' },
  'max-attempts': { type: 'string' },
  'max-depth': { type: 'string' },
  title: { type: 'string' },
  'since-seq': { type: 'string' },
  ids: { type: 'string' },
  version: { type: 'string' },
  branches: { type: 'boolean' },
  keep: { type: 'string' },
  remove: { type: 'string' },
  q: { type: 'string' },
  'doc-name': { type: 'string' },
  fill: { type: 'string' },
  confirm: { type: 'boolean' },
  'dry-run': { type: 'boolean' },
  'no-wait': { type: 'boolean' },
  'wait-timeout': { type: 'string' },
  actor: { type: 'string' },
  key: { type: 'string' },
  label: { type: 'string' },
  'data-type': { type: 'string' },
  options: { type: 'string' },
  required: { type: 'boolean' },
  sort: { type: 'string' },
  'local-path': { type: 'string' },
  'gitlab-project': { type: 'string' },
  tags: { type: 'string' },
  'repo-id': { type: 'string' },
  'repo-ids': { type: 'string' },
  'worktree-path': { type: 'string' },
  'base-branch': { type: 'string' },
  // 用 --keep-branch 而不是 --remove-branch false：
  // parseArgs 的 boolean 选项无法表达「显式 false」（`--x false` 会把 false 当位置参数、
  // `--x=false` 直接抛错），会导致开关形同虚设、与 HTTP/MCP 的 removeBranch:false 不一致（D3）。
  'keep-branch': { type: 'boolean' },
  'test-branch': { type: 'string' },
  'pre-branch': { type: 'string' },
  'release-branch': { type: 'string' },
  port: { type: 'string' },
  'gitlab-base': { type: 'string' },
  'gitlab-token': { type: 'string' },
  data: { type: 'string' },
  'include-disabled': { type: 'boolean' },
  help: { type: 'boolean', short: 'h' }
}

const HELP = `task-board <命令>

读取
  tree [--format md|json]            打印整棵树（md 可再喂给 import）
  schema                             节点类型 / 状态值域 / 属性定义 / 工具清单
  node get <ref>                     ref = 节点 id 或路径（项目A/需求1）
  attr list [--type <nodeType>]
  doc list <ref>
  doc history <docId>                    列出文档历史版本（新版本在前）
  doc restore <docId> --version <vid>    恢复文档到指定历史版本（追加新版本，不改写历史）
  commit list <ref> [--subtree]
  commit diff <cid>                  单个 commit 的 diff（文件列表 + patch）
  commit track <cid>                 检测提交是否已合入测试/预发/上线分支
  node diffs <ref> [--scope self|subtree]   节点（含子树）聚合 diff（含来源节点）
  node tracks <ref> [--scope self|subtree]  节点（含子树）分支合并状态聚合
  repo list
  unit repo list <ref>                                   工作单元登记的涉及仓库
  unit prompt <ref>                  生成 / 刷新开发提示词（纯读）
  config get

写入（默认 actor=cli，可用 --actor ai|user）
  node upsert --path <path> [--type t] [--name n] [--attr k=v ...] [--dry-run]
  node update <ref> [--name n] [--status s] [--parent <path>] [--attr k=v ...] [--confirm]
  node move <ref> --to <path> --confirm
  node delete <ref> --confirm
  requirement list [--project <ref>] [--status todo|doing|testing|done|cancelled]
  requirement create --project <ref> --name <名> [--attr k=v ...]
  requirement transition <ref> --status todo|doing|testing|done|cancelled
  document overview [--project <ref>] [--status <s>] [--q <关键词>] [--doc-name <文档名>] [--fill filled|empty]
  attr set <ref> k=v [k2=v2 ...]
  attr-def add --type t --key k --label l [--data-type text|textarea|number|date|select|url] [--options '[...]'] [--required]
  doc upsert <ref> --name <文档名> [--content <正文>|--file <path>]    # 按文档名幂等
  upload <图片路径> [--name <文件名>] [--data <base64>]   上传文档图片 → { url: "/uploads/..." }
  commit add <ref> --sha <sha> [--repo <名>] [--note <说明>] [--branch <分支>] [--overwrite-branch]
  commit review <cid> --review-status pending|approved|issue [--review-note "意见"]
  commit combined-diff --ids "1,2,3"   多个 commit 的合并变更（按仓库分组、文件并集、净 old/new）
  commit duplicates <ref> [--scope self|subtree]   重复检测（same-sha / patch-id / merge 覆盖）
  commit dedupe --keep <cid> --remove "1,2,3"      一键去重（保留 keep，删除重复登记）
  test case list <ref> [--kind regression|acceptance]    该节点的测试用例
  test case upsert <ref> --name <名> --prompt <内容> [--kind regression|acceptance] [--expectation <期望>] [--enabled true|false]
  test case update <cid> [--name n] [--kind k] [--prompt p] [--expectation e] [--enabled true|false]
  test case remove <cid>
  test case reorder <ref> --ids "1,2,3"
  test run <ref> [--kind k] [--case-ids "1,2"] [--prompt "额外要求"] [--dry-run] [--no-wait] [--wait-timeout 秒]
                                    派单执行用例（自动开报告）；默认等到 run 终态并自动收尾报告，--no-wait 只派单
                                    --fanout 每条用例派独立 agent 任务（并行）; --max-parallel N 设并行护栏（缺省 4，上限 16）
  test report list <ref> [--kind k] [--case-id <id>]      测试报告列表
  test report get <rid> [--format json|md] / test report finish <rid> --status pass|fail|blocked|error|cancelled [--summary s] [--detail d] [--run-id N] [--overwrite]
  test acceptance <ref> [--scope self|subtree] [--format json|md]   验收报告（聚合最近结果）
  test acceptance-status <ref> [--scope self|subtree] [--format json|md]   验收签收状态（测试证据 + 业务签收）
  test acceptance-sign <ref> --decision accepted|rejected [--scope self|subtree] [--comment "验收意见"]   签收 / 驳回
  readiness check <ref> [--scope self|subtree] [--format json|md]   需求就绪门禁（需求内容 + 概要设计 + 可回归用例）
  delivery gate <ref> [--scope self|subtree] [--format json|md]     交付门禁（需求就绪 + 测试验收 + 上线治理的最终汇总）
  delivery snapshot <ref> [--scope self|subtree] [--note <备注>]    冻结当前交付证据快照
  delivery snapshots <ref> [--scope self|subtree] [--limit N]       交付快照列表（含当前 / 已偏离核对）
  delivery snapshot-get <sid> [--format json|md]                    读取单条交付快照
  release item list <ref> [--kind config|sql|check] [--status pending|ready|done|blocked|skipped]
  release item upsert <ref> --name <名> [--kind config|sql|check] [--content <内容>|--file <path>] [--rollback <回滚>] [--status s] [--optional]
  release item update <rid> [--name n] [--kind k] [--content c] [--rollback r] [--status s] [--required|--optional]
  release item remove <rid>
  release item reorder <ref> --ids "1,2,3"
  release checklist <ref> [--scope self|subtree] [--format json|md]   上线检查清单（完成度 + 阻塞项 + 就绪结论）
  release sql-audit <ref> [--scope self|subtree] [--format json|md]   上线 SQL 风险审查（静态扫描高危写法）
  release check <ref> [--case-ids "1,2"] [--scope self|subtree] [--prompt "额外要求"] [--dry-run] [--no-wait] [--wait-timeout 秒]
                                    派单执行上线前置检查（含 code/biz/release_check 用例）；默认等终态并自动收尾
  runtime list [--status online|offline]        运行时列表（含本机 CLI 实例状态）
  runtime register [--daemon <主机名>] [--provider qodercli] [--name <名>] [--visibility private|public]
  runtime heartbeat <id>                        运行时心跳（刷新 last_seen_at + 置 online）
  runtime status <id> --status online|offline   手动改运行时状态
  runtime remove <id>                           删除运行时（有未完成任务时拒绝）
  agent session list <ref> [--status active|archived]    节点上的 agent 会话
  agent session new <ref> [--agent qodercli] [--title <标题>]   新建会话（不复用旧的）
  agent session get <sid> / agent session archive <sid>
  agent run <ref> --prompt "..." [--model DeepSeek-Flash] [--cwd <dir>] [--agent qodercli]
                                    [--session <sid>] [--resume] [--runtime <id>] [--max-attempts N] [--no-wait] [--wait-timeout 秒]
                                    触发任务（默认等到终态；--no-wait 只派单；前台 Qoder IDE 任务不等待）
  agent runs <ref> [--session <sid>]              任务历史（含输出与状态）
  agent run get <rid> / agent run messages <rid> [--since-seq N]
  agent run cancel <rid> [--reason <原因>] / agent run retry <rid>
  agent run update <rid> --status success|failed|timeout|cancelled [--exit-code N] [--failure-reason r] [--cli-session s] [--work-dir d]
  repo add --name <名> [--local-path <路径>] [--gitlab-project <路径>] [--tags 前端,后端]
  repo update <名|id> [--local-path p] [--tags t] [--test-branch b] [--pre-branch b] [--release-branch b]
  unit repo add <ref> --repo-id <id> [--branch b] [--worktree-path p]   登记工作单元涉及仓库
  unit repo remove <urid>
  unit setup <ref> [--repo-ids "1,2"] [--branch b] [--base-branch b] [--dry-run]
                                    创建工作区（分支 + worktree）并返回开发提示词
  unit cleanup <ref> --confirm [--keep-branch]   清理工作区（移除 worktree / 删除已并入基线的分支）
  branch-config list                 标签级追踪目标列表（测试/预发/上线）
  branch-config set <标签> [--test-branch b] [--pre-branch b] [--release-branch b]
  branch-config remove <标签>
  import --file <md 大纲> [--parent <path>] [--dry-run]
  batch --file <ops.json> [--dry-run]
  config set [--port 3210] [--gitlab-base <url>] [--gitlab-token <token>]

数据文件：${DB_PATH}（可用 TASKBOARD_HOME 覆盖）`

function parseAttrPairs(list) {
  const out = {}
  for (const item of list || []) {
    const i = item.indexOf('=')
    if (i < 0) throw new Error(`--attr 需要 k=v 形式：${item}`)
    out[item.slice(0, i)] = item.slice(i + 1)
  }
  return out
}

function readMaybeFile({ content, file }) {
  if (file) return fs.readFileSync(file, 'utf8')
  return content
}

/**
 * 读取图片文件并转 base64。把 fs 的裸错误（ENOENT / EISDIR / EACCES）归一成
 * 稳定业务码 `VALIDATION_FAILED`，与其他入口的错误契约保持一致——
 * 否则 CLI 会打出 `ENOENT: …` 这种没有 code 的裸错误，AI 无法按码自纠。
 */
function readFileAsBase64(file) {
  let buf
  try {
    buf = fs.readFileSync(file)
  } catch (e) {
    const hint =
      e.code === 'ENOENT' ? '文件不存在'
      : e.code === 'EISDIR' ? '这是一个目录，不是图片文件'
      : e.code === 'EACCES' ? '没有读取权限'
      : '文件不可读'
    throw Object.assign(new Error(`${hint}：${file}`), {
      code: 'VALIDATION_FAILED',
      details: { path: file, reason: e.code || 'READ_FAILED' }
    })
  }
  return buf.toString('base64')
}

/** --enabled 取值：true/1/yes → 1，false/0/no → 0，未提供 → undefined；非法值抛错 */
function parseEnabled(v) {
  if (v === undefined) return undefined
  const s = String(v).trim().toLowerCase()
  if (['true', '1', 'yes', 'on'].includes(s)) return 1
  if (['false', '0', 'no', 'off'].includes(s)) return 0
  throw Object.assign(new Error(`--enabled 需要 true|false，收到：${v}`), { code: 'VALIDATION_FAILED' })
}

/**
 * CLI 派单收尾：非 dry-run 时把派单结果等成「任务终态 + 报告终态」再返回。
 *
 * 边界（本函数就是这轮修复的核心约定）：
 * - 等待发生在**同一次前台进程内**（这是唯一能保证收尾的地方）；
 * - 默认等待到任务终态为止（上限 `--wait-timeout` 秒，缺省 30 分钟，
 *   与 agent 执行超时 10 分钟留足余量）；
 * - `--no-wait` 显式退回旧的「只派单」语义，立即返回 running（供脚本自行轮询）；
 * - 等待超时不算失败：返回当前状态并在 `waitTimedOut` 上如实标注，
 *   因为派单本身已经成功，把它做成非零退出会误导调用方。
 * 返回值会把 run / reports 刷新成收尾后的最新状态。
 */
async function settleCliDispatch(store, out, values) {
  if (!out || out.dryRun) return out
  const runs = out.mode === 'fanout' ? out.runs || [] : out.run ? [out.run] : []
  if (runs.length === 0) return out
  // 前台（Qoder IDE）任务设计上就停在 running，等 IDE 回写；在这里等待只会白等到超时。
  if (runs.some((r) => r.agent === 'qoder-ide')) return { ...out, waited: false, foreground: true }
  if (values['no-wait']) return { ...out, waited: false }
  const timeoutSec = values['wait-timeout'] != null ? Number(values['wait-timeout']) : 30 * 60
  const timeoutMs = Number.isFinite(timeoutSec) && timeoutSec > 0 ? timeoutSec * 1000 : 30 * 60 * 1000
  // fan-out 是多个并行任务：逐个等（waitForAgentRun 是纯轮询，不占用 agent 槽位，串行等待不影响并行执行）。
  const settled = []
  for (const r of runs) settled.push(await waitForAgentRun(store, r.id, { timeoutMs }))
  const reports = (out.reports || []).map((r) => store.getTestReport(r.id))
  const timedOut = settled.some((r) => ['running', 'queued'].includes(r.status))
  return out.mode === 'fanout'
    ? { ...out, runs: settled, reports, waited: true, waitTimedOut: timedOut }
    : { ...out, run: settled[0], reports, waited: true, waitTimedOut: timedOut }
}

export async function run(argv) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: OPTIONS })

  if (values.help || positionals.length === 0) {
    console.log(HELP)
    return 0
  }

  const cfg = loadConfig()
  const db = openDb()
  const store = createStore(db, { docPresets: cfg.docPresets, readiness: cfg.readiness, status: cfg.status, releaseSqlAudit: cfg.releaseSqlAudit })
  const by = values.actor || 'cli'
  let [group, action, ref] = positionals
  // `mindmap <ref>` 是单层命令（帮助如此，PM 口径亦如此），与 `readiness check <ref>` /
  // `delivery gate <ref>` 的两层结构不同：不经归一化时 parseArgs 会把 ref 落在 action 位，
  // switch key 变成 `mindmap <ref>` 而永远匹配不到 `case 'mindmap'`——正是本次要修的断点。
  if (group === 'mindmap' && ref === undefined) {
    ref = action
    action = ''
  }
  const json = (v) => console.log(JSON.stringify(v, null, 2))

  // `upload <图片路径>`：第二段是路径而不是子命令，必须在拼 `group action` 之前拦下
  if (group === 'upload') {
    const imgPath = action || values.file
    let name = values.name
    let data = values.data
    if (imgPath) {
      name = name || path.basename(imgPath)
      data = readFileAsBase64(imgPath)
    }
    json(saveUpload({ name, data }))
    return 0
  }

  switch (`${group} ${action || ''}`.trim()) {
    case 'tree': {
      const tree = store.listTree()
      if (values.format === 'md') {
        process.stdout.write(renderTreeMd(store, tree))
      } else json({ revision: store.getRevision(), nodes: tree })
      break
    }
    case 'schema':
      json(buildSchema(store, cfg))
      break
    case 'node get':
      json({
        ...store.resolveRef(ref),
        attrs: store.getAttrs(store.resolveRef(ref).id),
        documents: store.listDocuments(store.resolveRef(ref).id).map((d) => ({ id: d.id, name: d.name })),
        commits: store.listCommits(store.resolveRef(ref).id),
        children: store.listChildren(store.resolveRef(ref).id)
      })
      break
    case 'node upsert': {
      const out = upsertByPath(store, values.path, {
        type: values.type,
        attrs: parseAttrPairs(values.attr),
        by,
        dryRun: !!values['dry-run']
      })
      json({ node: out.node, steps: out.steps })
      break
    }
    case 'node update': {
      const node = store.resolveRef(ref)
      const moving = values.parent !== undefined
      if (moving && !values.confirm) throw Object.assign(new Error('移动节点需要 --confirm'), { code: 'CONFIRM_REQUIRED' })
      const patch = { name: values.name, status: values.status, attrs: parseAttrPairs(values.attr) }
      if (moving) patch.parentId = store.resolveRef(values.parent).id
      json(store.updateNode(node.id, patch, by))
      break
    }
    case 'node move': {
      if (!values.to || !values.confirm) {
        throw Object.assign(new Error('移动需要 --to <path> 与 --confirm'), { code: 'CONFIRM_REQUIRED' })
      }
      const node = store.resolveRef(ref)
      json(store.updateNode(node.id, { parentId: store.resolveRef(values.to).id }, by))
      break
    }
    case 'node delete': {
      if (!values.confirm) throw Object.assign(new Error('删除需要 --confirm'), { code: 'CONFIRM_REQUIRED' })
      json(store.deleteNode(store.resolveRef(ref).id))
      break
    }
    // ---------- 需求管理（条目 / 状态流转 / 文档关联） ----------
    case 'requirement list': {
      const projectId = values.project ? store.resolveRef(values.project).id : null
      json({
        revision: store.getRevision(),
        summary: store.requirementSummary({ projectId, status: values.status || null }),
        items: store.listRequirements({ projectId, status: values.status || null })
      })
      break
    }
    case 'requirement create': {
      if (!values.project) throw Object.assign(new Error('创建需求需要 --project <ref>'), { code: 'VALIDATION_FAILED' })
      json(
        store.createRequirement({
          projectId: store.resolveRef(values.project).id,
          name: values.name,
          attrs: parseAttrPairs(values.attr),
          actor: by
        })
      )
      break
    }
    case 'requirement transition':
      json(store.transitionRequirement(store.resolveRef(ref).id, { status: values.status, actor: by }))
      break
    case 'document overview': {
      const projectId = values.project ? store.resolveRef(values.project).id : null
      json(
        store.documentOverview({
          projectId,
          status: values.status || null,
          q: values.q || null,
          docName: values['doc-name'] || null,
          fill: values.fill || null
        })
      )
      break
    }
    case 'attr list':
      json(store.listAttrDefs(values.type, { includeDisabled: !!values['include-disabled'] }))
      break
    case 'attr set': {
      const node = store.resolveRef(ref)
      const pairs = parseAttrPairs(positionals.slice(3))
      json(store.setAttrs(node.id, pairs, by))
      break
    }
    case 'attr-def add':
      json(
        store.addAttrDef({
          nodeType: values.type,
          key: values.key,
          label: values.label,
          dataType: values['data-type'],
          options: values.options ? JSON.parse(values.options) : null,
          required: !!values.required,
          sort: values.sort ? Number(values.sort) : undefined
        })
      )
      break
    case 'doc list':
      json(store.listDocuments(store.resolveRef(ref).id))
      break
    case 'doc upsert': {
      const node = store.resolveRef(ref)
      const body = readMaybeFile({ content: values.content, file: values.file }) ?? null
      json(store.upsertDocument(node.id, values.name, body, by))
      break
    }
    case 'doc history':
      json(store.listDocumentVersions(Number(ref)))
      break
    case 'doc restore':
      json(store.restoreDocumentVersion(Number(ref), Number(values.version), by))
      break
    case 'commit list':
      json(store.listCommits(store.resolveRef(ref).id, { subtree: !!values.subtree }))
      break
    case 'commit add': {
      const node = store.resolveRef(ref)
      json(
        store.addCommit(
          node.id,
          {
            repo: values.repo,
            sha: values.sha,
            note: values.note,
            branch: values.branch,
            overwriteBranch: !!values['overwrite-branch']
          },
          by
        )
      )
      break
    }
    case 'commit review':
      json(store.updateCommitReview(Number(ref), { reviewStatus: values['review-status'], note: values['review-note'] }, by))
      break
    case 'commit combined-diff':
      json(await getCombinedDiff(store, String(values.ids || '').split(',').map((s) => Number(s.trim()))))
      break
    case 'commit duplicates':
      json(await getNodeDuplicates(store, ref, { scope: values.scope }))
      break
    case 'commit dedupe':
      json(store.dedupeCommits({
        keepId: Number(values.keep),
        removeIds: String(values.remove || '').split(',').map((s) => Number(s.trim()))
      }, by))
      break
    // ---------- 回归测试闭环（`test case|run|report|acceptance ...`） ----------
    case 'test case': {
      const sub = ref
      const arg = positionals[3]
      const enabled = parseEnabled(values.enabled)
      if (sub === 'list') json(store.listTestCases(store.resolveRef(arg).id, { kind: values.kind || null, includeDisabled: !!values['include-disabled'] }))
      else if (sub === 'upsert')
        json(
          store.upsertTestCase(
            store.resolveRef(arg).id,
            {
              name: values.name,
              kind: values.kind || 'regression',
              prompt: readMaybeFile({ content: values.prompt, file: values.file }) ?? values.prompt,
              expectation: values.expectation ?? null,
              enabled: enabled === undefined ? 1 : enabled
            },
            by
          )
        )
      else if (sub === 'update')
        json(
          store.updateTestCase(Number(arg), {
            name: values.name ?? null,
            kind: values.kind ?? null,
            prompt: values.prompt ?? null,
            expectation: values.expectation !== undefined ? values.expectation : undefined,
            enabled: enabled === undefined ? null : enabled
          }, by)
        )
      else if (sub === 'remove') {
        store.deleteTestCase(Number(arg))
        json({ ok: true, id: Number(arg) })
      } else if (sub === 'reorder')
        json(store.reorderTestCases(store.resolveRef(arg).id, String(values.ids || '').split(',').map((s) => Number(s.trim()))))
      else throw new Error(`test case 支持 list|upsert|update|remove|reorder，收到：${sub}`)
      break
    }
    case 'test run': {
      const node = store.resolveRef(ref)
      const out = runTestCases(store, node.id, {
        caseIds: values['case-ids'] ? String(values['case-ids']).split(',').map((s) => Number(s.trim())) : null,
        kind: values.kind || null,
        prompt: values.prompt || null,
        agent: values.agent,
        model: values.model,
        cwd: values.cwd,
        dryRun: !!values['dry-run'],
        fanout: !!values.fanout,
        // argv 是文本：由 ops.parseMaxParallelCli 做规范整数字面量校验，
        // 保证与 HTTP / MCP 一样严格拒绝 `1.5` / `true` / `0x10` / 空串等非 number 输入。
        maxParallel: parseMaxParallelCli(values['max-parallel'])
      }, by)
      json(await settleCliDispatch(store, out, values))
      break
    }
    case 'test report': {
      const sub = ref
      const arg = positionals[3]
      if (sub === 'list')
        json(
          store.listTestReports(store.resolveRef(arg).id, {
            kind: values.kind || null,
            caseId: values['case-id'] ? Number(values['case-id']) : null,
            limit: values.limit ? Number(values.limit) : 100
          })
        )
      else if (sub === 'get') {
        const report = store.getTestReport(Number(arg))
        if (store.normalizeFormat(values.format) === 'md') process.stdout.write(renderTestReportMd(store, report) + '\n')
        else json(report)
      }
      else if (sub === 'finish')
        json(
          store.finishTestReport(Number(arg), {
            status: values.status,
            summary: values.summary,
            detail: values.detail,
            runId: values['run-id'] ? Number(values['run-id']) : undefined,
            overwrite: !!values.overwrite
          }, by)
        )
      else throw new Error(`test report 支持 list|get|finish，收到：${sub}`)
      break
    }
    case 'test acceptance': {
      const node = store.resolveRef(ref)
      const report = store.buildAcceptanceReport(node.id, { scope: values.scope })
      if (store.normalizeFormat(values.format) === 'md') process.stdout.write(renderAcceptanceMd(report) + '\n')
      else json(report)
      break
    }
    case 'test acceptance-status': {
      const node = store.resolveRef(ref)
      const status = store.buildAcceptanceStatus(node.id, { scope: values.scope })
      if (store.normalizeFormat(values.format) === 'md') process.stdout.write(renderAcceptanceStatusMd(status) + '\n')
      else json(status)
      break
    }
    case 'test acceptance-sign': {
      const node = store.resolveRef(ref)
      json(
        store.upsertAcceptanceSignoff(
          node.id,
          { scope: values.scope, decision: values.decision, comment: values.comment ?? null },
          by
        )
      )
      break
    }
    // ---------- 需求就绪门禁（`readiness check <ref>`） ----------
    case 'readiness check': {
      const node = store.resolveRef(ref)
      const readiness = store.buildRequirementReadiness(node.id, {
        scope: values.scope
      })
      if (store.normalizeFormat(values.format) === 'md') process.stdout.write(renderReadinessMd(readiness) + '\n')
      else json(readiness)
      break
    }
    // ---------- 思维导图（`mindmap <ref>`，树 → mermaid mindmap 只读投影） ----------
    case 'mindmap': {
      const node = store.resolveRef(ref)
      const mindmap = store.buildMindmap(node.id, {
        scope: values.scope,
        maxDepth: values['max-depth']
      })
      if (store.normalizeFormat(values.format) === 'md') process.stdout.write(renderMindmapMd(mindmap) + '\n')
      else json(mindmap)
      break
    }
        // ---------- 文档敏感信息扫描（`secret scan <ref>`，只读且输出脱敏） ----------
    case 'secret scan': {
      const node = store.resolveRef(ref)
      const scan = store.buildSecretScan(node.id, {
        scope: values.scope
      })
      if (store.normalizeFormat(values.format) === 'md') process.stdout.write(renderSecretScanMd(scan) + '\n')
      else json(scan)
      break
    }
        // ---------- 代码检查（`code audit <ref>`） ----------
    case 'code audit': {
      const node = store.resolveRef(ref)
      const audit = await getNodeCodeAudit(store, node.id, { scope: values.scope })
      if (store.normalizeFormat(values.format) === 'md') process.stdout.write(renderCodeAuditMd(audit) + '\n')
      else json(audit)
      break
    }
    // ---------- 交付门禁（`delivery gate <ref>`） ----------
    case 'delivery gate': {
      const node = store.resolveRef(ref)
      const gate = store.buildDeliveryGate(node.id, {
        scope: values.scope
      })
      if (store.normalizeFormat(values.format) === 'md') process.stdout.write(renderDeliveryGateMd(gate) + '\n')
      else json(gate)
      break
    }
    // ---------- 概要设计大纲 / 思维导图（`design outline|apply <ref>`） ----------
    case 'design outline': {
      const node = store.resolveRef(ref)
      const outline = store.buildDesignOutline(node.id, { scope: values.scope })
      if (store.normalizeFormat(values.format) === 'md') process.stdout.write(renderDesignOutlineMd(outline) + '\n')
      else json(outline)
      break
    }
    case 'design apply': {
      const out = applyDesignOutline(store, ref, {
        scope: values.scope,
        overwrite: !!values.overwrite,
        dryRun: !!values['dry-run'],
        by
      })
      json(out)
      break
    }
    case 'delivery snapshot': {
      const node = store.resolveRef(ref)
      json(store.captureDeliverySnapshot(node.id, { scope: values.scope, note: values.note }, by))
      break
    }
    case 'delivery snapshots': {
      const node = store.resolveRef(ref)
      json(store.listDeliverySnapshots(node.id, { scope: values.scope ?? null, limit: values.limit }))
      break
    }
    case 'delivery snapshot-get': {
      // 这里 positionals[2] 是快照 id；沿用 CLI 通用的 `<group> <action> <ref>` 位置约定。
      const snapshot = store.getDeliverySnapshot(Number(ref))
      if (store.normalizeFormat(values.format) === 'md') process.stdout.write(renderDeliverySnapshotMd(snapshot) + '\n')
      else json(snapshot)
      break
    }
    // ---------- 上线治理（`release item|checklist|check ...`） ----------
    case 'release item': {
      const sub = ref
      const arg = positionals[3]
      if (sub === 'list')
        json(
          store.listReleaseItems(store.resolveRef(arg).id, {
            kind: values.kind || null,
            status: values.status || null,
            includeOptional: !values.optional
          })
        )
      else if (sub === 'upsert')
        json(
          store.upsertReleaseItem(
            store.resolveRef(arg).id,
            {
              name: values.name,
              // 只传显式给出的字段：未传的交给 store 决定（新建取默认值、已存在保持原样）。
              // 入口若在这里补默认值，会把既有的 rollback / status / required 静默回退（独立测试发现的三入口语义不一致）。
              kind: values.kind,
              content:
                values.content !== undefined || values.file !== undefined
                  ? readMaybeFile({ content: values.content, file: values.file })
                  : undefined,
              rollback: values.rollback,
              status: values.status,
              required: values.optional ? 0 : values.required ? 1 : undefined
            },
            by
          )
        )
      else if (sub === 'update')
        json(
          store.updateReleaseItem(
            Number(arg),
            {
              name: values.name ?? null,
              kind: values.kind ?? null,
              content: values.content !== undefined ? readMaybeFile({ content: values.content, file: values.file }) ?? values.content : undefined,
              rollback: values.rollback !== undefined ? values.rollback : undefined,
              status: values.status ?? null,
              required: values.optional ? 0 : values.required ? 1 : null
            },
            by
          )
        )
      else if (sub === 'remove') json(store.deleteReleaseItem(Number(arg)))
      else if (sub === 'reorder')
        json(store.reorderReleaseItems(store.resolveRef(arg).id, String(values.ids || '').split(',').map((s) => Number(s.trim()))))
      else throw new Error(`release item 支持 list|upsert|update|remove|reorder，收到：${sub}`)
      break
    }
    case 'release checklist': {
      const node = store.resolveRef(ref)
      const checklist = store.buildReleaseChecklist(node.id, { scope: values.scope })
      if (store.normalizeFormat(values.format) === 'md') process.stdout.write(renderReleaseChecklistMd(checklist) + '\n')
      else json(checklist)
      break
    }
    case 'release sql-audit': {
      const node = store.resolveRef(ref)
      const audit = store.buildReleaseSqlAudit(node.id, { scope: values.scope })
      if (store.normalizeFormat(values.format) === 'md') process.stdout.write(renderReleaseSqlAuditMd(audit) + '\n')
      else json(audit)
      break
    }
    case 'release check': {
      const node = store.resolveRef(ref)
      const out = runReleaseChecks(store, node.id, {
        caseIds: values['case-ids'] ? String(values['case-ids']).split(',').map((s) => Number(s.trim())) : null,
        scope: values.scope,
        prompt: values.prompt || null,
        agent: values.agent,
        model: values.model,
        cwd: values.cwd,
        dryRun: !!values['dry-run']
      }, by)
      json(await settleCliDispatch(store, out, values))
      break
    }
    // ---------- 运行时 ----------
    case 'runtime list':
      json({ summary: store.agentRuntimeSummary(), items: store.listRuntimes({ status: values.status || null }) })
      break
    case 'runtime register':
      json(
        store.upsertRuntime(
          {
            name: values.name,
            daemonId: values.daemon,
            provider: values.provider,
            runtimeMode: values['runtime-mode'] || 'local',
            status: values.status || 'online',
            deviceInfo: values['device-info'] || '',
            visibility: values.visibility || 'private'
          },
          by
        )
      )
      break
    case 'runtime heartbeat':
      json(store.heartbeatRuntime(Number(ref || values.id)))
      break
    case 'runtime status':
      json(store.setRuntimeStatus(Number(ref || values.id), values.status))
      break
    case 'runtime remove':
      json(store.deleteRuntime(Number(ref || values.id)))
      break
    // ---------- 会话（`agent session <list|new|get|archive> [arg]`） ----------
    case 'agent session': {
      const sub = ref
      const arg = positionals[3]
      if (sub === 'list') json(store.listAgentSessions(store.resolveRef(arg).id, { status: values.status || null }))
      else if (sub === 'new')
        json(
          store.createAgentSession(
            store.resolveRef(arg).id,
            { agent: values.agent || undefined, title: values.title, workDir: values.cwd },
            by
          )
        )
      else if (sub === 'get') json(store.getAgentSession(Number(arg)))
      else if (sub === 'archive') json(store.archiveAgentSession(Number(arg)))
      else throw new Error(`agent session 支持 list|new|get|archive，收到：${sub}`)
      break
    }
    // ---------- 任务（runs） ----------
    case 'agent run': {
      // 既支持 `agent run <ref> --prompt ...`，也支持 `agent run get|cancel|retry|update|messages <rid>`
      const sub = ref
      if (['get', 'cancel', 'retry', 'update', 'messages'].includes(sub)) {
        const rid = Number(positionals[3] || values.id)
        if (sub === 'get') json(store.getAgentRun(rid))
        else if (sub === 'cancel') json(store.cancelAgentRun(rid, { reason: values.reason || 'manual' }))
        // retry 同样拉起子进程：非前台任务要等终态，理由同下面的派单分支
        else if (sub === 'retry') json(await settleCliDispatch(store, { run: retryAndDispatch(store, rid, by) }, values))
        else if (sub === 'messages') json(store.listAgentRunMessages(rid, { sinceSeq: Number(values['since-seq']) || 0 }))
        else {
          if (!values.status) throw new Error('agent run update 需要 --status')
          json(
            store.finishAgentRun(rid, {
              status: values.status,
              exitCode: values['exit-code'] !== undefined ? Number(values['exit-code']) : null,
              failureReason: values['failure-reason'] ?? null,
              cliSessionId: values['cli-session'] ?? null,
              workDir: values['work-dir'] ?? null
            })
          )
        }
        break
      }
      const node = store.resolveRef(sub)
      const run = startAgentRun(
        store,
        node.id,
        {
          prompt: values.prompt,
          agent: values.agent,
          model: values.model,
          cwd: values.cwd,
          sessionId: values.session ? Number(values.session) : null,
          resume: !!values.resume,
          runtimeId: values.runtime ? Number(values.runtime) : null,
          maxAttempts: values['max-attempts'] != null ? Number(values['max-attempts']) : null
        },
        by
      )
      // 与 test run / release check 同样的收尾边界：本进程一退出，子进程 close 监听器就再也不触发，
      // 所以非前台（ideMode）派单必须在这里等到终态，否则任务会永远停在 running。
      json(await settleCliDispatch(store, { run }, values))
      break
    }
    case 'agent runs':
      json(store.listAgentRuns(store.resolveRef(ref).id, { sessionId: values.session ? Number(values.session) : null }))
      break
    case 'commit diff':
      json(await getCommitDiff(store, Number(ref)))
      break
    case 'node diffs':
      json(await getNodeDiffs(store, ref, { scope: values.scope }))
      break
    case 'commit track':
      json(await getCommitTrack(store, Number(ref)))
      break
    case 'node tracks':
      json(await getNodeTracks(store, ref, { scope: values.scope, branches: !!values.branches }))
      break
    case 'repo list':
      json(store.listRepos())
      break
    // ---------- 工作区准备（分支 / worktree / 开发提示词） ----------
    // `unit repo <list|add|remove> ...`：switch key 只有两段，子命令落在 ref
    case 'unit repo': {
      const sub = ref
      const arg = positionals[3]
      if (sub === 'list') {
        if (!arg) throw new Error('unit repo list 需要 <ref>')
        json(store.listUnitRepos(store.resolveRef(arg).id))
      } else if (sub === 'add') {
        if (!arg) throw new Error('unit repo add 需要 <ref>')
        const repoIdsRaw = values['repo-ids'] ?? values['repo-id']
        const ids = String(repoIdsRaw || '').split(',').map((s) => Number(s.trim())).filter(Boolean)
        if (ids.length === 0) throw new Error('unit repo add 需要 --repo-id <id>')
        const out = []
        for (const rid of ids) {
          out.push(store.addUnitRepo(store.resolveRef(arg).id, { repoId: rid, branch: values.branch, worktreePath: values['worktree-path'] }, by))
        }
        json(out.length === 1 ? out[0] : out)
      } else if (sub === 'remove') {
        if (!arg) throw new Error('unit repo remove 需要 <urid>')
        json(store.deleteUnitRepo(Number(arg)))
      } else {
        throw new Error(`unit repo 支持 list|add|remove，收到：${sub}`)
      }
      break
    }
    case 'unit setup': {
      const ids = values['repo-ids'] ? String(values['repo-ids']).split(',').map((s) => Number(s.trim())).filter(Boolean) : null
      json(await setupWorkspace(store, ref, {
        repoIds: ids,
        branch: values.branch,
        baseBranch: values['base-branch'],
        dryRun: !!values['dry-run'],
        by
      }))
      break
    }
    case 'unit prompt':
      json(getWorkspacePrompt(store, ref))
      break
    case 'unit cleanup':
      json(await cleanupWorkspace(store, ref, {
        confirm: !!values.confirm,
        // --keep-branch 表示「保留分支」；缺省是删除已并入基线的分支
        removeBranch: !values['keep-branch'],
        by
      }))
      break
    case 'repo add':
      json(store.addRepo({ name: values.name, localPath: values['local-path'], gitlabProject: values['gitlab-project'], tags: values.tags, testBranch: values['test-branch'], preBranch: values['pre-branch'], releaseBranch: values['release-branch'] }))
      break
    case 'repo update': {
      const repo = store.listRepos().find((r) => r.name === ref || String(r.id) === String(ref))
      if (!repo) throw new Error(`仓库不存在：${ref}`)
      const patch = {}
      if (values['local-path'] !== undefined) patch.localPath = values['local-path']
      if (values['gitlab-project'] !== undefined) patch.gitlabProject = values['gitlab-project']
      if (values.note !== undefined) patch.note = values.note
      if (values.tags !== undefined) patch.tags = values.tags
      if (values['test-branch'] !== undefined) patch.testBranch = values['test-branch']
      if (values['pre-branch'] !== undefined) patch.preBranch = values['pre-branch']
      if (values['release-branch'] !== undefined) patch.releaseBranch = values['release-branch']
      json(store.updateRepo(repo.id, patch))
      break
    }
    case 'branch-config list':
      json(store.listBranchConfigs())
      break
    case 'branch-config set':
      json(store.upsertBranchConfig(ref, {
        testBranch: values['test-branch'] ?? null,
        preBranch: values['pre-branch'] ?? null,
        releaseBranch: values['release-branch'] ?? null
      }))
      break
    case 'branch-config remove':
      json(store.deleteBranchConfig(ref))
      break
    case 'import': {
      const md = readMaybeFile({ content: values.content, file: values.file })
      json(importOutline(store, md, { parentPath: values.parent, dryRun: !!values['dry-run'], by }))
      break
    }
    case 'batch': {
      const opsRaw = readMaybeFile({ content: values.content, file: values.file })
      if (!opsRaw) throw new Error('需要 --file <ops.json> 或 --content')
      const parsed = JSON.parse(opsRaw)
      json(applyBatch(store, Array.isArray(parsed) ? parsed : parsed.ops, { dryRun: !!values['dry-run'], by }))
      break
    }
    case 'config get':
      json(maskToken(cfg))
      break
    case 'config set': {
      const patch = {}
      if (values.port) patch.port = Number(values.port)
      if (values['gitlab-base'] !== undefined || values['gitlab-token'] !== undefined) {
        patch.gitlab = {}
        if (values['gitlab-base'] !== undefined) patch.gitlab.base_url = values['gitlab-base']
        if (values['gitlab-token'] !== undefined) patch.gitlab.token = values['gitlab-token']
      }
      json(maskToken(saveConfig(patch)))
      break
    }
    default:
      console.error(`未知命令：${positionals.join(' ')}`)
      console.log(HELP)
      return 2
  }
  return 0
}

const isDirect = process.argv[1] && process.argv[1].endsWith('server/cli.mjs')
if (isDirect) {
  run(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((e) => {
      console.error(`${e.code || 'ERROR'}: ${e.message}`)
      process.exit(1)
    })
}
