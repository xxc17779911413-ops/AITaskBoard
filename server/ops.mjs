import { CODES, AppError } from './errors.mjs'
import { CHILD_TYPES } from './db.mjs'
import path from 'node:path'
import { startAgentRun } from './agent.mjs'
import { resolveRepoDir, commitDiff as gitCommitDiff, commitStat as gitCommitStat, commitTrack as gitCommitTrack, commitTime as gitCommitTime, commitMeta as gitCommitMeta, showFileAt as gitShowFileAt, commitParents as gitCommitParents, patchId as gitPatchId, mergedInCommits as gitMergedInCommits, branchesContaining as gitBranchesContaining, branchContains as gitBranchContains, mergeBranch as gitMergeBranch, previewMerge as gitPreviewMerge, branchLogShas as gitBranchLogShas, commitMetasBatch as gitCommitMetasBatch } from './git.mjs'
import { addWorktree as gitAddWorktree, removeWorktree as gitRemoveWorktree, deleteLocalBranch as gitDeleteLocalBranch, checkWorktreePlan as gitCheckWorktreePlan } from './git.mjs'
import { loadConfig } from './config.mjs'

/** 能力清单：MCP 工具 / CLI 命令 / REST 路由 三者 1:1 对应 */
export const TOOLS = [
  'schema',
  'tree',
  'node_get',
  'node_upsert',
  'node_update',
  'node_delete',
  'node_reorder',
  'requirement_list',
  'requirement_create',
  'requirement_transition',
  'attr_defs',
  'attr_add',
  'attr_update',
  'attr_remove',
  'attr_set',
  'doc_list',
  'doc_upsert',
  'doc_create',
  'doc_update',
  'doc_remove',
  'doc_reorder',
  'doc_version_list',
  'doc_version_restore',
  'commit_list',
  'commit_diff',
  'commit_track',
  'node_diffs',
  'node_tracks',
  'commit_add',
  'commit_remove',
  'commit_review',
  'commit_combined_diff',
  'commit_duplicates',
  'commit_dedupe',
  'test_case_list',
  'test_case_upsert',
  'test_case_update',
  'test_case_remove',
  'test_case_reorder',
  'test_run',
  'test_report_list',
  'test_report_get',
  'test_report_finish',
  'acceptance_report',
  'acceptance_status',
  'acceptance_sign',
  'requirement_readiness',
  'design_outline',
  'design_outline_apply',
  'mindmap',
  'delivery_gate',
  'release_item_list',
  'release_item_upsert',
  'release_item_update',
  'release_item_remove',
  'release_item_reorder',
  'release_check',
  'release_checklist',
  'runtime_list',
  'runtime_register',
  'runtime_heartbeat',
  'runtime_status',
  'runtime_remove',
  'agent_session_list',
  'agent_session_new',
  'agent_session_archive',
  'agent_run',
  'agent_runs_list',
  'agent_run_get',
  'agent_run_messages',
  'agent_run_cancel',
  'agent_run_retry',
  'agent_run_update',
  'repo_list',
  'repo_add',
  'repo_update',
  'repo_remove',
  'unit_repo_list',
  'unit_repo_add',
  'unit_repo_remove',
  'unit_setup',
  'unit_prompt',
  'unit_cleanup',
  'import_outline',
  'batch',
  'config_get',
  'config_set',
  'upload_image'
]

/** /api/schema：AI 的能力发现入口（节点类型 / 状态值域 / 属性定义 / 工具清单） */
export function buildSchema(store, config) {
  return {
    version: 1,
    nodeTypes: Object.entries(CHILD_TYPES).map(([type, children]) => ({ type, allowedChildren: children })),
    status: config.status,
    docPresets: config.docPresets,
    readiness: config.readiness,
    branchTemplate: config.branchTemplate,
    attrDefs: store.listAttrDefs(undefined, { includeDisabled: true }),
    tools: TOOLS
  }
}

const TYPE_BY_DEPTH = ['project', 'requirement', 'subreq', 'group']

/** 树 → markdown 大纲（与 import_outline 的输入格式一致，可往返） */
export function renderTreeMd(store, tree, { withAttrs = true } = {}) {
  const lines = []
  const walk = (list, depth) => {
    for (const n of list) {
      const tag = n.type === 'task' || n.type === 'defect' ? `[${n.type}] ` : ''
      lines.push(`${'  '.repeat(depth)}- ${tag}${n.name}`)
      if (withAttrs) {
        const attrs = store.getAttrs(n.id)
        for (const [k, v] of Object.entries(attrs)) {
          if (v != null && v !== '') lines.push(`${'  '.repeat(depth + 1)}- ${k}: ${v}`)
        }
      }
      if (n.children && n.children.length) walk(n.children, depth + 1)
    }
  }
  walk(tree, 0)
  return lines.join('\n') + '\n'
}

function findChildByName(store, parent, name) {
  const siblings = store.listChildren(parent ? parent.id : null)
  return siblings.find((n) => n.name === name) || null
}

/**
 * 按路径 get-or-create（幂等）：`项目A/需求1/子需求2`
 * 中间层级不存在会按父节点的第一个允许子类型自动创建；根必须是 project。
 */
export function upsertByPath(store, path, { type = null, attrs = null, by = 'user', dryRun = false } = {}) {
  const parts = String(path || '')
    .split('/')
    .map((s) => s.trim())
    .filter(Boolean)
  if (!parts.length) throw new AppError(CODES.VALIDATION_FAILED, 'path 不能为空', { field: 'path' })
  let parent = null
  const steps = []
  for (let i = 0; i < parts.length; i += 1) {
    const isLast = i === parts.length - 1
    const name = parts[i]
    let node = findChildByName(store, parent, name)
    if (!node) {
      const nodeType = parent === null ? 'project' : isLast && type ? type : CHILD_TYPES[parent.type][0]
      if (dryRun) {
        node = { id: null, type: nodeType, name, path: parts.slice(0, i + 1).join('/') }
        steps.push({ path: node.path, type: nodeType, action: 'create' })
      } else {
        node = store.createNode({
          parentId: parent ? parent.id : null,
          type: nodeType,
          name,
          attrs: isLast ? attrs : undefined,
          actor: by
        })
        steps.push({ path: node.path, type: node.type, action: 'create' })
      }
    } else if (isLast && attrs) {
      if (!dryRun) store.setAttrs(node.id, attrs, by)
      steps.push({ path: node.path, type: node.type, action: 'attr' })
    }
    parent = node
  }
  return { node: parent, steps }
}

/** markdown 缩进大纲 → 节点树（解析） */
export function parseOutline(md) {
  const roots = []
  const stack = []
  for (const raw of String(md || '').split(/\r?\n/)) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue // 空行与 # 注释忽略
    const indent = raw.match(/^\s*/)[0].length
    const body = raw.trim().replace(/^-\s*/, '')
    const depth = Math.floor(indent / 2)
    const attr = body.match(/^([^\s:：]+)\s*[:：]\s*(.+)$/)
    if (attr && stack.length) {
      stack[stack.length - 1].node.attrs[attr[1]] = attr[2].trim()
      continue
    }
    let type = null
    let name = body
    const tag = body.match(/^\[(project|requirement|subreq|group|task|defect)\]\s*(.+)$/)
    if (tag) {
      type = tag[1]
      name = tag[2]
    }
    const node = { name: String(name).trim(), type, attrs: {}, children: [] }
    if (!node.type) node.type = TYPE_BY_DEPTH[Math.min(depth, TYPE_BY_DEPTH.length - 1)]
    while (stack.length && stack[stack.length - 1].depth >= depth) stack.pop()
    if (stack.length === 0) roots.push(node)
    else stack[stack.length - 1].node.children.push(node)
    stack.push({ depth, node })
  }
  return roots
}

/** 大纲导入：一次落成整棵子树（parentPath 下），idempotent */
export function importOutline(store, md, { parentPath = null, dryRun = false, by = 'user' } = {}) {
  const outline = parseOutline(md)
  let parent = null
  if (parentPath) {
    parent = store.resolveRef(parentPath)
  }
  // parentPath 给出的父节点下：清除 outline 解析的类型，全由 visit 按父子约束推导
  const clearOutlineType = (nodes) => { for (const n of nodes) { delete n.type; if (n.children.length) clearOutlineType(n.children) } }
  const steps = []
  const visit = (nodes, parentNode) => {
    for (const spec of nodes) {
      const type =
        spec.type || (parentNode ? CHILD_TYPES[parentNode.type][0] : 'project')
      let node = findChildByName(store, parentNode, spec.name)
      if (!node) {
        if (dryRun) {
          node = { id: null, type, name: spec.name, path: `${parentNode ? parentNode.path + '/' : ''}${spec.name}` }
          steps.push({ path: node.path, type, action: 'create' })
        } else {
          node = store.createNode({
            parentId: parentNode ? parentNode.id : null,
            type,
            name: spec.name,
            attrs: Object.keys(spec.attrs).length ? spec.attrs : undefined,
            actor: by
          })
          steps.push({ path: node.path, type: node.type, action: 'create' })
        }
      } else {
        steps.push({ path: node.path, type: node.type, action: 'exist' })
        if (Object.keys(spec.attrs).length) {
          if (!dryRun) store.setAttrs(node.id, spec.attrs, by)
          steps.push({ path: node.path, type: node.type, action: 'attr' })
        }
      }
      if (spec.children.length) visit(spec.children, node)
    }
  }
  if (parent) {
    clearOutlineType(outline)
    const rootType = CHILD_TYPES[parent.type][0]
    const normalised = outline.map((n) => ({ ...n, type: rootType }))
    visit(normalised, parent)
  } else {
    visit(outline, null)
  }
  return { dryRun, count: steps.length, steps }
}

/** 单个 commit 的 diff 预览（HTTP / CLI / MCP 共用） */
export async function getCommitDiff(store, cid) {
  const commit = store.getCommit(cid)
  const repo = commit.repo ? store.listRepos().find((r) => r.name === commit.repo) : null
  if (!repo) {
    throw new AppError(
      CODES.REPO_NOT_REGISTERED,
      commit.repo ? `仓库 ${commit.repo} 未登记（先 repo add）` : '该提交未标注仓库，无法定位本地仓库',
      { repo: commit.repo }
    )
  }
  const dir = resolveRepoDir(repo)
  const diff = await gitCommitDiff(dir, commit.sha)
  return { commit, repo: { name: repo.name, localPath: repo.localPath }, ...diff }
}

const COMBINED_TEXT_LIMIT = 200 * 1024

/**
 * 多 commit 合并 diff（MR 式 review）：按仓库分组、文件取并集；
 * 每个文件的 old = 涉及它最早的 commit 的父版本，new = 最新的 commit 的版本（净变更）；
 * 统计为各 commit 该文件增删之和（近似值，用于概览）。
 */
export async function getCombinedDiff(store, cids) {
  const idList = (Array.isArray(cids) ? cids : []).map((n) => Number(n)).filter((n) => Number.isFinite(n))
  if (idList.length === 0) {
    throw new AppError(CODES.VALIDATION_FAILED, 'cids 不能为空', {})
  }
  const commits = idList.map((id) => store.getCommit(id))
  const reposByName = new Map(store.listRepos().map((r) => [r.name, r]))
  const byRepo = new Map()
  for (const c of commits) {
    if (!c.repo) throw new AppError(CODES.REPO_NOT_REGISTERED, `提交 ${c.sha} 未标注仓库`, { sha: c.sha })
    if (!byRepo.has(c.repo)) byRepo.set(c.repo, [])
    byRepo.get(c.repo).push(c)
  }

  const out = []
  const allMeta = []
  for (const [repoName, list] of byRepo) {
    const repo = reposByName.get(repoName)
    if (!repo) throw new AppError(CODES.REPO_NOT_REGISTERED, `仓库 ${repoName} 未登记（先 repo add）`, { repo: repoName })
    const dir = resolveRepoDir(repo)

    // 【批量】一次 git log 拿全部提交的 stat/时间/元信息（替代逐条 3 次 git；64 条 192 次 → 1 次）
    const metaBatch = await gitCommitMetasBatch(dir, list.map((c) => c.sha))
    const findMeta = (sha) => {
      if (metaBatch.has(sha)) return metaBatch.get(sha)
      for (const [k, v] of metaBatch) {
        if (k.startsWith(sha)) return v
      }
      return null
    }
    const withStat = list.map((c) => {
      const b = findMeta(c.sha)
      return { commit: c, stat: b ? b.stat : [], ts: b && b.date ? Date.parse(b.date) || 0 : 0, meta: b }
    })
    withStat.sort((a, b) => a.ts - b.ts)

    // 文件并集
    const filesMap = new Map()
    withStat.forEach((item, idx) => {
      for (const f of item.stat) {
        let agg = filesMap.get(f.path)
        if (!agg) {
          agg = { path: f.path, additions: 0, deletions: 0, binary: false, shas: [], firstIdx: idx, lastIdx: idx }
          filesMap.set(f.path, agg)
        }
        agg.additions += f.additions || 0
        agg.deletions += f.deletions || 0
        agg.binary = agg.binary || !!f.binary
        agg.shas.push(item.commit.sha)
        agg.lastIdx = idx
      }
    })

    // 逐文件计算净变更 old/new（并发 8，替代串行）
    const files = []
    const aggList = [...filesMap.values()]
    const CONCURRENCY = 8
    for (let i = 0; i < aggList.length; i += CONCURRENCY) {
      const chunk = aggList.slice(i, i + CONCURRENCY)
      const chunkResults = await Promise.all(
        chunk.map(async (agg) => {
          const first = withStat[agg.firstIdx].commit
          const last = withStat[agg.lastIdx].commit
          let oldText = ''
          let newText = ''
          if (!agg.binary) {
            const oldRaw = await gitShowFileAt(dir, `${first.sha}^`, agg.path)
            if (oldRaw != null) oldText = oldRaw.slice(0, COMBINED_TEXT_LIMIT)
            const newRaw = await gitShowFileAt(dir, last.sha, agg.path)
            if (newRaw != null) newText = newRaw.slice(0, COMBINED_TEXT_LIMIT)
          }
          return {
            path: agg.path,
            additions: agg.additions,
            deletions: agg.deletions,
            binary: agg.binary,
            old: oldText,
            new: newText,
            shas: agg.shas,
            firstSha: first.sha,
            lastSha: last.sha
          }
        })
      )
      files.push(...chunkResults)
    }
    out.push({ repo: { name: repo.name, localPath: repo.localPath }, files })
    for (const w of withStat) {
      allMeta.push({
        cid: w.commit.id,
        sha: w.commit.sha,
        note: w.commit.note,
        repo: repoName,
        author: w.meta ? w.meta.author : null,
        authorEmail: w.meta ? w.meta.authorEmail : null,
        date: w.meta ? w.meta.date : null,
        branches: w.meta ? w.meta.branches : []
      })
    }
  }

  allMeta.sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')))
  return { count: commits.length, commits: allMeta, repos: out }
}

/**
 * 节点（含子树）聚合 diff：按 (repo, sha) 去重、回填来源节点；
 * 单条失败不影响整体（该项带 error 字段，便于部分仓库不可用时仍可浏览其他提交）
 */
export async function getNodeDiffs(store, nodeRef, { scope = 'self' } = {}) {
  const node = store.resolveRef(nodeRef)
  scope = store.normalizeScope(scope)
  const commits = store.listCommits(node.id, { subtree: scope === 'subtree' })
  const repos = new Map(store.listRepos().map((r) => [r.name, r]))
  const items = []
  const byKey = new Map()
  for (const c of commits) {
    const key = `${c.repo || ''}@${c.sha}`
    const sourcePath = store.getNode(c.nodeId).path
    const existing = byKey.get(key)
    if (existing) {
      existing.sourceNodes.push({ nodeId: c.nodeId, path: sourcePath })
      continue
    }
    const item = { commit: c, sourceNodes: [{ nodeId: c.nodeId, path: sourcePath }], repo: null, files: [], error: null }
    byKey.set(key, item)
    items.push(item)
    try {
      const repo = c.repo ? repos.get(c.repo) : null
      if (!repo) {
        throw new AppError(
          CODES.REPO_NOT_REGISTERED,
          c.repo ? `仓库 ${c.repo} 未登记（先 repo add）` : '该提交未标注仓库'
        )
      }
      const dir = resolveRepoDir(repo)
      item.repo = { name: repo.name, localPath: repo.localPath }
      item.files = await gitCommitStat(dir, c.sha)
    } catch (e) {
      item.error = { code: e.code || 'ERROR', message: e.message }
    }
  }
  return { scope, count: items.length, items }
}

/** 单个 commit 的分支合并状态（测试 / 预发 / 上线；需仓库配置 testBranch/preBranch/releaseBranch） */
export async function getCommitTrack(store, cid) {
  const commit = store.getCommit(cid)
  const repo = commit.repo ? store.listRepos().find((r) => r.name === commit.repo) : null
  if (!repo) {
    throw new AppError(
      CODES.REPO_NOT_REGISTERED,
      commit.repo ? `仓库 ${commit.repo} 未登记（先 repo add）` : '该提交未标注仓库，无法定位本地仓库',
      { repo: commit.repo }
    )
  }
  const dir = resolveRepoDir(repo)
  const targets = store.resolveBranchTargets(repo)
  const branches = { test: targets.test, pre: targets.pre, release: targets.release }
  const track = await gitCommitTrack(dir, commit.sha, branches)
  return { commit, repo: { name: repo.name, localPath: repo.localPath, ...branches, targetSource: targets.source }, track }
}

/**
 * 节点（含子树）聚合分支合并状态：按 (repo, sha) 去重、回填来源节点；
 * contained=null 表示分支未配置或本地无该 ref（先 fetch）；单条失败带 error 不拖垮整体
 */
export async function getNodeTracks(store, nodeRef, { scope = 'self', branches = false, light = false } = {}) {
  const node = store.resolveRef(nodeRef)
  scope = store.normalizeScope(scope)
  const commits = store.listCommits(node.id, { subtree: scope === 'subtree' })
  const repos = new Map(store.listRepos().map((r) => [r.name, r]))
  const items = []
  const byKey = new Map()
  for (const c of commits) {
    const key = `${c.repo || ''}@${c.sha}`
    const sourcePath = store.getNode(c.nodeId).path
    const existing = byKey.get(key)
    if (existing) {
      existing.sourceNodes.push({ nodeId: c.nodeId, path: sourcePath })
      continue
    }
    const item = { commit: c, sourceNodes: [{ nodeId: c.nodeId, path: sourcePath }], repo: null, track: null, error: null }
    byKey.set(key, item)
    items.push(item)
    try {
      const repo = c.repo ? repos.get(c.repo) : null
      if (!repo) {
        throw new AppError(
          CODES.REPO_NOT_REGISTERED,
          c.repo ? `仓库 ${c.repo} 未登记（先 repo add）` : '该提交未标注仓库'
        )
      }
      const dir = resolveRepoDir(repo)
      const targets = store.resolveBranchTargets(repo)
      const trackBranches = { test: targets.test, pre: targets.pre, release: targets.release }
      item.repo = { name: repo.name, ...trackBranches, targetSource: targets.source }
      // light 模式：跳过逐条 commitTrack（快 10 倍；插件 Review 不需要测试/预发追踪）
      item.track = light ? null : await gitCommitTrack(dir, c.sha, trackBranches)
    } catch (e) {
      item.error = { code: e.code || 'ERROR', message: e.message }
    }
  }

  // 分支标注：批量模式（每仓库一次 git log <需求分支> → Set(sha) 比对，避免逐条 git 进程）
  if (branches) {
    const shaSets = new Map() // key: repo||branch → Set | null
    const getShas = async (repoName, branch) => {
      const key = `${repoName}||${branch}`
      if (!shaSets.has(key)) {
        const repoRow = repos.get(repoName)
        let set = null
        if (repoRow) {
          try {
            set = await gitBranchLogShas(resolveRepoDir(repoRow), branch)
          } catch (ignore) {
            set = null
          }
        }
        shaSets.set(key, set)
      }
      return shaSets.get(key)
    }
    for (const item of items) {
      const c = item.commit
      if (!c.repo) continue
      // 需求分支取值：① 节点自身 branch（分支组）② 子需求 reqBranch ③ 需求 demandBranch
      const selfBranch = (store.getAttrs(node.id) || {}).branch || null
      const subreqAnc = store.findAncestorOfType(item.sourceNodes[0].nodeId, 'subreq')
      const subreqBranch = subreqAnc ? ((store.getAttrs(subreqAnc.id) || {}).reqBranch || null) : null
      const ancestor = store.findAncestorOfType(item.sourceNodes[0].nodeId, 'requirement')
      const demandRaw = selfBranch || subreqBranch || (ancestor ? store.getAttrs(ancestor.id).demandBranch : null) || null
      c.demandBranch = demandRaw
      if (!demandRaw) {
        c.mergedToReq = null
        continue
      }
      const shas = await getShas(c.repo, demandRaw)
      if (!shas) {
        c.demandContained = null
      } else if (shas.has(c.sha)) {
        c.demandContained = true
      } else {
        // 登记的可能是短 sha → 前缀匹配
        let found = false
        for (const full of shas) {
          if (full.startsWith(c.sha)) {
            found = true
            break
          }
        }
        c.demandContained = found
      }
      c.mergedToReq = c.demandContained
    }
  }

  return { scope, count: items.length, items }
}

/** 批量补齐 patch-id（merge 提交标记为 __merge__；写入 DB 缓存与内存对象） */
async function ensurePatchIds(store, commits, repos) {
  for (const c of commits) {
    if (c.patchId) continue
    const repo = c.repo ? repos.get(c.repo) : null
    if (!repo) continue
    let dir
    try {
      dir = resolveRepoDir(repo)
    } catch {
      continue
    }
    try {
      const parents = await gitCommitParents(dir, c.sha)
      const pid = parents.length >= 2 ? '__merge__' : await gitPatchId(dir, c.sha)
      if (pid) {
        store.setCommitPatchId(c.id, pid)
        c.patchId = pid
      }
    } catch {
      // 单条失败跳过
    }
  }
}

/**
 * 重复检测（节点子树内），三类关系：
 * - same-sha：同 repo 同 sha 重复登记（worktree 与需求分支都登了同一条）
 * - patch-id：同 repo 同内容不同 sha（rebase / cherry-pick）
 * - merge-covers / covered-by：merge 提交覆盖了库中已登记的其他提交（worktree 提交被合入需求分支）
 * 返回有关系的提交 items（related 含对端 sha/节点路径/关系）
 */
export async function getNodeDuplicates(store, nodeRef, { scope = 'self' } = {}) {
  const node = store.resolveRef(nodeRef)
  scope = store.normalizeScope(scope)
  const commits = store.listCommits(node.id, { subtree: scope === 'subtree' })
  const repos = new Map(store.listRepos().map((r) => [r.name, r]))
  if (commits.length === 0) return { scope, groupCount: 0, itemCount: 0, items: [] }

  // 全库（涉及 repo）索引：patch-id 补齐 + sha / patch-id 索引（另一半可能在别的节点）
  const repoNames = new Set(commits.map((c) => c.repo).filter(Boolean))
  const libCommits = []
  for (const repoName of repoNames) libCommits.push(...store.listCommitsWithNode({ repo: repoName }))
  await ensurePatchIds(store, libCommits, repos)
  const libById = new Map(libCommits.map((c) => [c.id, c]))
  const libBySha = new Map()
  const libByPatch = new Map()
  const pushIdx = (map, key, c) => {
    if (!map.has(key)) map.set(key, [])
    map.get(key).push(c)
  }
  for (const c of libCommits) {
    pushIdx(libBySha, `${c.repo}@${c.sha}`, c)
    if (c.patchId && c.patchId !== '__merge__') pushIdx(libByPatch, `${c.repo}@${c.patchId}`, c)
  }
  // 范围内提交统一用全库对象（含 nodePath / patchId）
  const scopeCommits = commits.map((c) => {
    const lib = libById.get(c.id)
    if (lib) return lib
    c.nodePath = store.getNode(c.nodeId).path
    return c
  })

  const rel = new Map() // cid -> Map(otherCid -> related)
  const seenPair = new Set()
  const groupKeys = new Set()
  const addRel = (a, b, relation) => {
    if (a.id === b.id) return
    const pk = `${relation}|${a.id}|${b.id}`
    if (seenPair.has(pk)) return
    seenPair.add(pk)
    const push = (from, to, r) => {
      if (!rel.has(from.id)) rel.set(from.id, new Map())
      rel.get(from.id).set(to.id, {
        cid: to.id,
        sha: to.sha,
        repo: to.repo,
        note: to.note,
        nodeId: to.nodeId,
        nodePath: to.nodePath,
        relation: r
      })
    }
    push(a, b, relation)
    push(b, a, relation === 'merge-covers' ? 'covered-by' : relation)
  }

  // 1) same-sha：范围内提交 ↔ 全库同 (repo, sha) 的其他登记
  for (const c of scopeCommits) {
    const others = (libBySha.get(`${c.repo}@${c.sha}`) || []).filter((o) => o.id !== c.id)
    if (others.length > 0) {
      groupKeys.add(`sha:${c.repo}@${c.sha}`)
      for (const o of others) addRel(c, o, 'same-sha')
    }
  }

  // 2) patch-id：范围内提交 ↔ 全库同 (repo, patch-id) 的其他登记（排除同 sha 对）
  for (const c of scopeCommits) {
    if (!c.patchId || c.patchId === '__merge__') continue
    const others = (libByPatch.get(`${c.repo}@${c.patchId}`) || []).filter((o) => o.id !== c.id && o.sha !== c.sha)
    if (others.length > 0) {
      groupKeys.add(`patch:${c.repo}@${c.patchId}`)
      for (const o of others) addRel(c, o, 'patch-id')
    }
  }

  // 3) merge 覆盖：范围内 merge 提交的第二父分支独有提交 ∩ 全库已登记（同 repo）
  const mergeCommits = scopeCommits.filter((c) => c.patchId === '__merge__')
  for (const m of mergeCommits) {
    const repo = repos.get(m.repo)
    if (!repo) continue
    let dir
    try {
      dir = resolveRepoDir(repo)
    } catch {
      continue
    }
    const parents = await gitCommitParents(dir, m.sha).catch(() => [])
    const inner = await gitMergedInCommits(dir, parents)
    for (const sha of inner) {
      const others = (libBySha.get(`${m.repo}@${sha}`) || []).filter((o) => o.id !== m.id)
      for (const o of others) addRel(m, o, 'merge-covers')
    }
  }

  const items = []
  for (const c of scopeCommits) {
    const m = rel.get(c.id)
    if (!m || m.size === 0) continue
    items.push({
      cid: c.id,
      sha: c.sha,
      repo: c.repo,
      note: c.note,
      nodeId: c.nodeId,
      nodePath: c.nodePath,
      patchId: c.patchId,
      related: Array.from(m.values())
    })
  }
  return { scope, groupCount: groupKeys.size, itemCount: items.length, items }
}

/**
 * 合并预览（MR 式）：对每个待合并的 (repo, source→target) 给出将引入的变更统计与冲突预判。
 */
export async function previewMerges(store, nodeRef) {
  const node = store.resolveRef(String(nodeRef))
  const subreq = node.type === 'subreq' ? node : store.findAncestorOfType(node.id, 'subreq')
  const reqBranch = subreq ? ((store.getAttrs(subreq.id) || {}).reqBranch || null) : null
  if (!reqBranch) {
    throw new AppError(CODES.VALIDATION_FAILED, '未配置需求分支（subreq.attrs.reqBranch）', {})
  }
  const commits = store.listCommits(node.id, { subtree: true })
  const pairs = new Map()
  for (const c of commits) {
    if (!c.repo || !c.branch) continue
    pairs.set(`${c.repo}||${c.branch}`, { repo: c.repo, branch: c.branch })
  }
  const items = []
  for (const { repo, branch } of pairs.values()) {
    const repoRow = store.listRepos().find((r) => r.name === repo)
    if (!repoRow || !repoRow.localPath) {
      items.push({ repo, source: branch, target: reqBranch, ok: false, reason: 'no_local_path' })
      continue
    }
    try {
      const dir = resolveRepoDir(repoRow)
      if (branch === reqBranch) {
        items.push({ repo, source: branch, target: reqBranch, ok: true, alreadyMerged: true })
        continue
      }
      const anc = await gitBranchContains(dir, branch, reqBranch)
      if (anc.contained === true) {
        items.push({ repo, source: branch, target: reqBranch, ok: true, alreadyMerged: true })
        continue
      }
      const pv = await gitPreviewMerge(dir, branch, reqBranch)
      items.push({ repo, source: branch, target: reqBranch, ok: true, ...pv })
    } catch (e) {
      items.push({ repo, source: branch, target: reqBranch, ok: false, reason: 'error', message: String((e && e.message) || e).slice(0, 300) })
    }
  }
  return { node: { id: node.id, name: node.name }, subreq: subreq ? { id: subreq.id, name: subreq.name } : null, reqBranch, items }
}

/**
 * 合入状态（组/子需求级）：列出该节点子树下每个子任务的开发分支是否已合入所属子需求的「需求分支」。
 */
export async function getMergeStatus(store, nodeRef) {
  const node = store.resolveRef(String(nodeRef))
  const subreq = node.type === 'subreq' ? node : store.findAncestorOfType(node.id, 'subreq')
  const reqBranch = subreq ? ((store.getAttrs(subreq.id) || {}).reqBranch || null) : null
  const commits = store.listCommits(node.id, { subtree: true })
  const byNode = new Map()
  for (const c of commits) {
    if (!c.repo || !c.branch) continue
    if (!byNode.has(c.nodeId)) byNode.set(c.nodeId, new Set())
    byNode.get(c.nodeId).add(`${c.repo}||${c.branch}`)
  }
  const cache = new Map()
  const items = []
  for (const [nid, pairs] of byNode) {
    let name = `#${nid}`
    try { name = store.resolveRef(String(nid)).name } catch (ignore) { /* keep */ }
    const details = []
    let allMerged = true
    for (const key of pairs) {
      const [repo, branch] = key.split('||')
      let merged = false
      if (reqBranch && branch === reqBranch) {
        merged = true
      } else if (reqBranch) {
        const ck = `${repo}||${branch}||${reqBranch}`
        if (cache.has(ck)) {
          merged = cache.get(ck)
        } else {
          try {
            const repoRow = store.listRepos().find((r) => r.name === repo)
            if (repoRow && repoRow.localPath) {
              const r = await gitBranchContains(resolveRepoDir(repoRow), branch, reqBranch)
              merged = r.contained === true
            }
          } catch (ignore) {
            merged = false
          }
          cache.set(ck, merged)
        }
      }
      if (!merged) allMerged = false
      details.push({ repo, branch, merged })
    }
    items.push({ nodeId: nid, name, allMerged, details })
  }
  return {
    node: { id: node.id, name: node.name },
    subreq: subreq ? { id: subreq.id, name: subreq.name } : null,
    reqBranch,
    mergedCount: items.filter((i) => i.allMerged).length,
    total: items.length,
    items
  }
}

/**
 * 上跳合并：把子需求的「需求分支」合并到集成分支（默认 feature-merge）。
 * 支持增量重复合：首次全量、后续只合新增（is-ancestor 已合入→跳过；有新内容→再 merge）。
 */
export async function mergeUpstream(store, nodeRef, { targetBranch = 'feature-merge' } = {}) {
  const node = store.resolveRef(String(nodeRef))
  const subreq = node.type === 'subreq' ? node : store.findAncestorOfType(node.id, 'subreq')
  const sourceBranch = subreq ? ((store.getAttrs(subreq.id) || {}).reqBranch || null) : null
  if (!sourceBranch) {
    throw new AppError(CODES.VALIDATION_FAILED, '未配置需求分支（subreq.attrs.reqBranch）', {})
  }
  // 收集子树提交出现过的仓库
  const commits = store.listCommits(node.id, { subtree: true })
  const repos = [...new Set(commits.map((c) => c.repo).filter(Boolean))]
  const results = []
  for (const repo of repos) {
    const repoRow = store.listRepos().find((r) => r.name === repo)
    if (!repoRow || !repoRow.localPath) {
      results.push({ repo, source: sourceBranch, target: targetBranch, ok: false, reason: 'no_local_path' })
      continue
    }
    try {
      const dir = resolveRepoDir(repoRow)
      const r = await gitMergeBranch(dir, sourceBranch, targetBranch, `merge: ${sourceBranch} -> ${targetBranch}（task-board 上跳合并）`)
      results.push({ repo, source: sourceBranch, target: targetBranch, ...r })
    } catch (e) {
      results.push({ repo, source: sourceBranch, target: targetBranch, ok: false, reason: 'error', message: String((e && e.message) || e).slice(0, 500) })
    }
  }
  return { node: { id: node.id, name: node.name }, subreq: subreq ? { id: subreq.id, name: subreq.name } : null, sourceBranch, targetBranch, results }
}

/**
 * 审批合并：把子任务（含子树）的提交所在开发分支，合并到所属子需求的「需求分支」（主仓库执行）。
 * 安全判定：① 已合入→跳过（防重复 merge）② 未解决冲突→拒绝（防带冲突 merge）。
 */
export async function approveAndMerge(store, nodeRef, { by = 'user' } = {}) {
  const node = store.resolveRef(String(nodeRef))
  const subreq = store.findAncestorOfType(node.id, 'subreq')
  if (!subreq) {
    throw new AppError(CODES.VALIDATION_FAILED, '未找到所属子需求（无法确定需求分支）', { node: node.name })
  }
  const reqBranch = (store.getAttrs(subreq.id) || {}).reqBranch
  if (!reqBranch) {
    throw new AppError(CODES.VALIDATION_FAILED, `子需求「${subreq.name}」未填「需求分支」`, { subreq: subreq.name })
  }
  // 收集该子任务（含子树）的提交，按 (repo, branch) 去重
  const commits = store.listCommits(node.id, { subtree: true })
  const pairs = new Map()
  for (const c of commits) {
    if (!c.repo || !c.branch) continue
    pairs.set(`${c.repo}||${c.branch}`, { repo: c.repo, branch: c.branch })
  }
  if (pairs.size === 0) {
    return { node: { id: node.id, name: node.name }, subreq: { id: subreq.id, name: subreq.name }, reqBranch, results: [], note: '无带分支的提交（先登记提交/补分支）' }
  }
  const results = []
  for (const { repo, branch } of pairs.values()) {
    if (branch === reqBranch) {
      results.push({ repo, branch, target: reqBranch, ok: true, alreadyMerged: true, reason: 'same_branch' })
      continue
    }
    const repoRow = store.listRepos().find((r) => r.name === repo)
    if (!repoRow || !repoRow.localPath) {
      results.push({ repo, branch, target: reqBranch, ok: false, reason: 'no_local_path' })
      continue
    }
    try {
      const dir = resolveRepoDir(repoRow)
      const r = await gitMergeBranch(dir, branch, reqBranch, `merge: ${branch} -> ${reqBranch}（task-board 审批合并）`)
      results.push({ repo, branch, target: reqBranch, ...r })
    } catch (e) {
      results.push({ repo, branch, target: reqBranch, ok: false, reason: 'error', message: String((e && e.message) || e).slice(0, 500) })
    }
  }
  return { node: { id: node.id, name: node.name }, subreq: { id: subreq.id, name: subreq.name }, reqBranch, results }
}

/**
 * AI 可回归测试的执行编排：把选中的用例组合成一段可执行的 agent 提示词，
 * 派单到该节点（复用 agent 运行时 / 会话），并立刻为每个用例开一条 running 报告。
 *
 * 返回 { run, reports }：调用方拿 run.id 轮询任务消息流；任务结束后用
 * finishTestReport 回写每个报告的 pass/fail（前台执行者或收尾钩子调用）。
 * dryRun 只返回将要执行的用例与提示词，不落库、不派单。
 */
export function runTestCases(
  store,
  nodeRef,
  { caseIds = null, kind = null, prompt = null, agent = undefined, model = undefined, cwd = null, dryRun = false } = {},
  by = 'user'
) {
  const node = store.resolveRef(String(nodeRef))
  const cases = store
    .listTestCases(node.id, { kind: kind || null })
    .filter((c) => (caseIds && caseIds.length ? caseIds.map(Number).includes(c.id) : true))
  if (cases.length === 0) {
    throw new AppError(CODES.VALIDATION_FAILED, '没有可执行的测试用例（先 test_case_upsert）', { nodeId: node.id, kind })
  }
  const effectiveKind = kind || cases[0].kind
  const composed = composeTestPrompt(node, cases, prompt)
  if (dryRun) {
    return {
      dryRun: true,
      node: { id: node.id, name: node.name },
      kind: effectiveKind,
      cases: cases.map((c) => ({ id: c.id, name: c.name, kind: c.kind })),
      prompt: composed
    }
  }
  const run = startAgentRun(store, node.id, { prompt: composed, agent, model, cwd }, by)
  const reports = cases.map((c) =>
    store.createTestReport(node.id, { caseId: c.id, runId: run.id, kind: c.kind, status: 'running', summary: `已派单执行：${c.name}` }, by)
  )
  return { node: { id: node.id, name: node.name }, kind: effectiveKind, run, reports }
}

/** 把用例拼成给 agent 的回归提示词：显式列出每条用例的期望，要求逐条给出结论 */
export function composeTestPrompt(node, cases, extra = null) {
  const lines = [
    `请在当前工作目录对节点「${node.name}」（${node.type}）执行以下回归测试，并逐条给出结论。`,
    '每条用例输出一行：`<用例名>: PASS|FAIL|BLOCKED - <依据>`；不确定时用 BLOCKED 并说明缺什么。',
    ''
  ]
  cases.forEach((c, i) => {
    lines.push(`## 用例 ${i + 1}：${c.name}（${c.kind}）`)
    lines.push(c.prompt)
    if (c.expectation) lines.push(`期望结果：${c.expectation}`)
    lines.push('')
  })
  if (extra) lines.push('额外要求：', extra)
  return lines.join('\n')
}

/**
 * 验收报告导出：在聚合结果之上补 markdown 渲染，便于直接贴进 issue / MR。
 */
export function renderAcceptanceMd(report) {
  const t = report.totals
  const lines = [
    `# 验收报告：${report.node.name}`,
    '',
    `- 范围：${report.scope === 'subtree' ? '含子树' : '仅本节点'}`,
    `- 用例：${t.cases} · 已完结：${t.settled} · 通过：${t.pass} · 失败：${t.fail} · 阻塞：${t.blocked} · 错误：${t.error} · 取消：${t.cancelled} · 执行中：${t.running} · 未执行：${t.notRun}`,
    `- 通过率（已完结口径，running/未执行不计入分母）：${report.passRate == null ? '—' : `${Math.round(report.passRate * 100)}%`}`,
    '',
    '| 用例 | 类型 | 最近结果 | 报告 |',
    '|---|---|---|---|'
  ]
  for (const i of report.items) {
    lines.push(`| ${i.name} | ${i.kind} | ${i.latestStatus} | ${i.latestReportId ?? '—'} |`)
  }
  return lines.join('\n')
}

/** 验收签收状态导出：把测试证据与业务签收放在同一份可贴进 issue / 验收记录的记录里。 */
export function renderAcceptanceStatusMd(status) {
  const t = status.report.totals
  const stateLabels = {
    not_applicable: '不适用（没有可验收用例）',
    pending: '待签收',
    accepted: '已验收',
    rejected: '已驳回',
    stale: '签收已失效'
  }
  const lines = [
    `# 验收签收：${status.node.name}`,
    '',
    `- 范围：${status.scope === 'subtree' ? '含子树' : '仅本节点'}`,
    `- 用例：${t.cases} · 已完结：${t.settled} · 通过：${t.pass} · 未通过：${t.fail + t.blocked + t.error + t.cancelled + t.running + t.notRun}`,
    `- 签收状态：${stateLabels[status.state] || status.state}`,
    `- 证据指纹：${status.report.evidenceFingerprint}`
  ]
  if (status.signoff) {
    lines.push(
      `- 签收人：${status.signoff.signedBy}`,
      `- 签收时间：${status.signoff.signedAt}`,
      `- 验收意见：${status.signoff.comment || '—'}`
    )
  }
  return lines.join('\n')
}

/**
 * 需求就绪门禁导出：把 buildRequirementReadiness 的聚合结果渲染成可贴进 issue / 评审记录的 markdown。
 * 与 renderAcceptanceMd / renderReleaseChecklistMd 同风格，便于三段结论一起贴进同一条记录。
 */
export function renderReadinessMd(readiness) {
  const t = readiness.totals
  const lines = [
    `# 需求就绪门禁：${readiness.node.name}`,
    '',
    `- 范围：${readiness.scope === 'subtree' ? '含子树' : '仅本节点'}`,
    `- 需求：${t.units} · 就绪：${t.readyUnits} · 未就绪：${t.pendingUnits} · 门禁项：${t.checks}（通过 ${t.passed} / 未过 ${t.failed}）`,
    `- 就绪结论：${readiness.ready == null ? '—（没有可判定的需求）' : readiness.ready ? '可进入回归测试' : '尚不可进入回归测试'}`,
    ''
  ]
  if (readiness.blockers.length > 0) {
    lines.push('## 阻塞项', '', '| 需求 | 门禁 | 说明 |', '|---|---|---|')
    for (const b of readiness.blockers) lines.push(`| ${b.name} | ${b.label} | ${b.detail} |`)
    lines.push('')
  }
  lines.push('## 需求明细', '', '| 需求 | 类型 | 就绪 | 未过门禁 |', '|---|---|---|---|')
  for (const u of readiness.units) {
    const failed = u.checks.filter((c) => !c.passed).map((c) => c.label)
    lines.push(`| ${u.name} | ${u.type} | ${u.ready ? '是' : '否'} | ${failed.length ? failed.join('、') : '—'} |`)
  }
  return lines.join('\n')
}

/**
 * 思维导图导出：把树投影渲染成可直接贴进 issue / 设计文档的 markdown。
 * 正文是一段 ```mermaid mindmap 代码块（Vditor / GitHub / 飞书等均支持渲染），
 * 下面附一行统计；复杂到不适合贴图的调用方可以直接取 `buildMindmap` 的结构化 `nodes`/`edges`。
 *
 * 与 renderReadinessMd / renderDeliveryGateMd 同风格：**标题 + 一段结论 + 可复制正文**，纯读。
 */
export function renderMindmapMd(mindmap) {
  const t = mindmap.totals
  const lines = [
    `# 思维导图：${mindmap.node.name}`,
    '',
    `- 范围：${mindmap.scope === 'subtree' ? '含子树' : '仅本节点'}`,
    `- 节点：${t.nodes} · 连接：${t.edges} · 深度：${t.depth}${
      t.truncated ? ` · 已截断 ${t.truncated} 个子节点（超出 maxDepth）` : ''
    }`,
    '',
    '```mermaid',
    mindmap.mermaid.trimEnd(),
    '```',
    ''
  ]
  return lines.join('\n')
}

/**
 * 交付门禁导出：把三段既有结论收敛成一张可贴进 issue / 上线单的最终判定。
 * 与 renderReadinessMd / renderAcceptanceMd / renderReleaseChecklistMd 同风格。
 */
export function renderDeliveryGateMd(gate) {
  // 用例名 / 阻塞项可能来自 AI 或用户输入；进入 markdown 表格前必须转义，
  // 否则 `|` 会多分一列、换行会直接截断表格。
  const cell = (v) =>
    String(v == null ? '' : v)
      .replace(/\\/g, '\\\\')
      .replace(/\|/g, '\\|')
      .replace(/\r?\n/g, ' ')
  const t = gate.totals
  const statusLabels = { pass: '通过', fail: '未通过', not_applicable: '不适用' }
  const decisionText = {
    ready: '可交付',
    not_ready: '不可交付',
    unknown: '—（没有可判定的交付证据）'
  }[gate.decision] || gate.decision
  const lines = [
    `# 交付门禁：${gate.node.name}`,
    '',
    `- 范围：${gate.scope === 'subtree' ? '含子树' : '仅本节点'}`,
    `- 证据源：${t.sources} · 适用：${t.applicable} · 通过：${t.passed} · 未通过：${t.failed} · 不适用：${t.notApplicable}`,
    `- 交付结论：${decisionText}`,
    '',
    '## 结论来源',
    '',
    '| 来源 | 结论 | 说明 |',
    '|---|---|---|'
  ]
  for (const s of gate.sources) {
    lines.push(`| ${cell(s.label)} | ${cell(statusLabels[s.status] || s.status)} | ${cell(s.detail)} |`)
  }
  if (gate.blockers.length > 0) {
    lines.push('', '## 阻塞项', '', '| 来源 | 阻塞项 | 说明 |', '|---|---|---|')
    for (const b of gate.blockers) lines.push(`| ${cell(b.label)} | ${cell(b.name)} | ${cell(b.detail)} |`)
  }
  return lines.join('\n')
}

/** mermaid 节点文本转义：双引号 / 换行会破坏 `id["text"]` 语法 */
function mermaidText(name) {
  return String(name == null ? '' : name)
    .replace(/"/g, "'")
    .replace(/\r?\n/g, ' ')
    .replace(/[\[\]{}()]/g, '')
    .trim()
}

/** 概要设计骨架里的层级标题：按节点类型给稳定的小节名 */
const DESIGN_SECTION_BY_TYPE = {
  requirement: '目标与范围',
  subreq: '子需求设计',
  group: '任务组拆分',
  task: '实现要点',
  defect: '缺陷处理'
}

/**
 * 概要设计大纲导出：
 * - `format=md`（或 `renderDesignOutlineMd`）产出可直接 upsert 进「概要设计」文档的 markdown 骨架，
 *   内含一张 mermaid 思维导图 + 逐层小节（结构与需求树一致）；
 * - 骨架里标注「待补充」，避免把它当成「设计已写完」——门禁判的是正文非空白，
 *   所以调用方仍需让 AI / 人补上真正的设计内容（apply 的 `overwrite:false` 也不会覆盖已有正文）。
 */
export function renderDesignOutlineMd(outline) {
  const nodeLabel = (n) => (DESIGN_SECTION_BY_TYPE[n.type] || '节点')
  const lines = [`# 概要设计：${outline.node.name}`, '']

  if (outline.totals.nodes === 0) {
    lines.push('_（没有可推导的节点结构——请先补充子需求 / 任务组 / 子任务）_')
    return lines.join('\n')
  }

  // mermaid 思维导图：直接复用需求树，AI / 人一眼看到拆分结构。
  // 单需求（scope=self）时根节点本身就是待推导的需求，避免多画一层重复分支。
  const selfAsRoot = outline.units.length === 1 && outline.units[0].nodeId === outline.node.id
  lines.push('## 结构思维导图', '', '```mermaid', 'mindmap', `  root(("${mermaidText(outline.node.name)}"))`)
  const walkMind = (n, depth) => {
    const indent = '  '.repeat(depth + 1)
    lines.push(`${indent}["${mermaidText(n.name)}"]`)
    for (const c of n.children) walkMind(c, depth + 1)
  }
  if (selfAsRoot) {
    for (const c of outline.units[0].tree.children) walkMind(c, 1)
  } else {
    for (const unit of outline.units) {
      // 需求本身作为根下的第一层分支
      lines.push(`    ["${mermaidText(unit.name)}"]`)
      for (const c of unit.tree.children) walkMind(c, 2)
    }
  }
  lines.push('```', '')

  const walkSections = (n, depth) => {
    const prefix = '#'.repeat(Math.min(depth + 2, 6))
    lines.push(`${prefix} ${n.name}`, '', `_${nodeLabel(n)}｜待补充：目标 / 方案 / 影响面 / 验证方式_`, '')
    for (const c of n.children) walkSections(c, depth + 1)
  }
  if (selfAsRoot) walkSections(outline.units[0].tree, 1)
  else for (const unit of outline.units) walkSections(unit.tree, 1)
  return lines.join('\n').trimEnd()
}

/**
 * 把推导出的概要设计骨架**写入**「概要设计」文档（三入口共用，AI 主要入口）。
 * - 默认 `overwrite:false`：已有非空内容不覆盖，只回报 `written:false`——避免把人工写好的设计冲掉；
 * - `overwrite:true` 才覆盖；
 * - 文档名取 `config.readiness.designDoc`，与需求就绪门禁判定的是同一份文档名，写对才算数。
 * 返回值区分 `created`（文档是否新建）与 `written`（内容是否真的变了）。
 */
export function applyDesignOutline(store, nodeRef, { scope = 'self', overwrite = false, dryRun = false, by = 'user' } = {}) {
  const node = store.resolveRef(String(nodeRef))
  const outline = store.buildDesignOutline(node.id, { scope })
  const designDocName = (store.getReadinessConfig && store.getReadinessConfig().designDoc) || '概要设计'

  const results = []
  for (const unit of outline.units) {
    const docs = store.listDocuments(unit.nodeId)
    const existing = docs.find((d) => d.name === designDocName)
    const hasContent = !!existing && String(existing.content || '').trim() !== ''
    if (hasContent && !overwrite) {
      results.push({ nodeId: unit.nodeId, name: unit.name, doc: designDocName, created: false, written: false, reason: 'already_filled' })
      continue
    }
    if (dryRun) {
      results.push({ nodeId: unit.nodeId, name: unit.name, doc: designDocName, created: !existing, written: false, reason: 'dry_run' })
      continue
    }
    const content = renderDesignOutlineMd({
      node: { id: unit.nodeId, name: unit.name, type: unit.type },
      scope: 'self',
      totals: { units: 1, nodes: unit.nodeCount },
      units: [unit]
    })
    const r = store.upsertDocument(unit.nodeId, designDocName, content, by)
    results.push({ nodeId: unit.nodeId, name: unit.name, doc: designDocName, created: !!r.created, written: true })
  }

  return {
    node: outline.node,
    scope: outline.scope,
    dryRun: !!dryRun,
    designDoc: designDocName,
    overwrite: !!overwrite,
    written: results.filter((r) => r.written).length,
    skipped: results.filter((r) => !r.written).length,
    results
  }
}

// ---------- 工作区准备（分支 / worktree / 开发提示词）----------

const UNIT_TYPES = new Set(['group', 'task'])

function assertUnit(store, nodeRef) {
  const node = store.resolveRef(String(nodeRef))
  if (!UNIT_TYPES.has(node.type)) {
    throw new AppError(CODES.VALIDATION_FAILED, `只有任务组 / 子任务才能准备工作区，当前为 ${node.type}`, {
      node: node.name,
      type: node.type,
      allowed: [...UNIT_TYPES]
    })
  }
  return node
}

/**
 * 解析工作区的基线分支：显式传入 > 工作单元自身 `base_branch` > 所属子需求分支。
 * 需求分支取值与 merge-flow 对齐：优先节点自身/分支组的 `branch`，其次子需求 `branch`，
 * 这样「分支从当前子需求分支派生」对两种数据形态都成立。
 */
function resolveBaseBranch(store, node, explicit) {
  if (explicit) return explicit
  const own = store.getAttrs(node.id) || {}
  if (own.base_branch) return own.base_branch
  const subreq = store.findAncestorOfType(node.id, 'subreq')
  const subreqAttrs = subreq ? store.getAttrs(subreq.id) || {} : {}
  return subreqAttrs.branch || subreqAttrs.reqBranch || null
}

/** 渲染分支名：`config.branchTemplate`（默认 `{base_branch}-{slug}`）；slug 为空退回 `n{id}` */
export function renderBranchName(template, { baseBranch, slug, nodeId }) {
  const t = template || '{base_branch}-{slug}'
  const s = (slug && String(slug).trim()) || `n${nodeId}`
  return String(t).replace(/\{base_branch\}/g, baseBranch || '').replace(/\{slug\}/g, s)
}

/** worktree 路径：`config.worktreeRoot`（缺省与主仓库同级）下 `<仓库目录名>-wt-<slug>` */
export function renderWorktreePath(repoDir, worktreeRoot, slug, nodeId) {
  const s = (slug && String(slug).trim()) || `n${nodeId}`
  const name = `${path.basename(repoDir)}-wt-${s}`
  const root = (worktreeRoot && String(worktreeRoot).trim()) || path.dirname(repoDir)
  return path.join(root, name)
}

/**
 * 生成**开发提示词**（可直接投喂 AI 的开工包）。
 * 设计文档 §7.10 要求至少包含：节点路径与 id、涉及仓库与工作区路径、工作分支与基线、
 * 文档清单、常用命令、提交与合并约定。
 */
export function composeWorkspacePrompt(store, node, { branch, baseBranch, repos, branchTemplate }) {
  const docs = store.listDocuments(node.id).filter((d) => String(d.content || '').trim() !== '')
  const lines = [
    `# 工作区：${node.name}`,
    '',
    `- 节点：${node.path}（id=${node.id}，类型=${node.type}）`,
    `- 工作分支：${branch}`,
    `- 基线分支：${baseBranch}`,
    `- 分支命名模板：${branchTemplate}`,
    '',
    '## 涉及仓库与工作区',
    ''
  ]
  if (repos.length === 0) {
    lines.push('_（尚未登记涉及仓库：先 `unit repo add` 再 `unit setup`）_')
  } else {
    lines.push('| 仓库 | 工作区路径 | 分支 | 状态 |', '|---|---|---|---|')
    for (const r of repos) {
      const state = r.ok === false ? `失败：${r.reason}` : r.alreadyExists ? '已存在（幂等跳过）' : '已创建'
      lines.push(`| ${r.repo} | ${r.worktreePath || '-'} | ${r.branch || branch} | ${state} |`)
    }
  }
  lines.push('', '## 该节点的文档', '')
  if (docs.length === 0) lines.push('_（暂无有内容的文档）_')
  else for (const d of docs) lines.push(`- ${d.name}（${String(d.content || '').length} 字）`)

  lines.push(
    '',
    '## 常用命令',
    '',
    '```bash',
    `node bin/taskboard.js node get "${node.path}"`,
    `node bin/taskboard.js doc list "${node.path}"`,
    `node bin/taskboard.js commit add "${node.path}" --sha <sha> --repo <仓库> --note "<说明>"`,
    `node bin/taskboard.js merge run "${node.path}"        # 合并回子需求分支`,
    '```',
    '',
    '## 提交与合并约定',
    '',
    '- 提交信息用 Conventional Commits：`type(scope): 描述`，scope 取功能目录名',
    `- 在工作分支 \`${branch}\` 上开发，提交后回到本节点登记 commit（含 branch），供交付门禁判定推送状态`,
    `- 完成后合并回子需求分支 \`${baseBranch}\`（显式触发、不 push），再按需 \`unit cleanup\``,
    '- 合并后默认**保留**工作区与分支，避免 Diff 入口消失；清理需显式 confirm'
  )
  return lines.join('\n')
}

/**
 * 准备工作区（三入口共用）：逐仓库建分支 + worktree，回填 unit_repos 与节点属性，返回开发提示词。
 *
 * - `dryRun` 只做规划（渲染分支名与路径、检查仓库可用性），**不碰本机 git、不落库**；
 * - 分支名与基线由 `resolveBaseBranch` / `renderBranchName` 决定，多仓库共用同一个分支名（决策 24）；
 * - 基线不一致时抛 `BRANCH_EXISTS_DIFFERENT_BASE`（不静默复用，避免开发分支挂到错误基线）；
 * - 任一路径被占用抛 `WORKTREE_PATH_EXISTS`；
 * - 组合写入（unit_repos + 属性）合并为一次 revision 递增。
 */
export async function setupWorkspace(store, nodeRef, { repoIds = null, branch = null, baseBranch = null, dryRun = false, by = 'user' } = {}) {
  const node = assertUnit(store, nodeRef)
  const config = loadConfig()
  const base = resolveBaseBranch(store, node, baseBranch)
  if (!base) {
    throw new AppError(CODES.VALIDATION_FAILED, '未配置基线分支（请填工作单元 base_branch 或所属子需求 branch）', { node: node.name })
  }
  const attrs = store.getAttrs(node.id) || {}
  const branchName = branch || attrs.branch || renderBranchName(config.branchTemplate, { baseBranch: base, slug: attrs.slug, nodeId: node.id })

  const all = store.listUnitRepos(node.id)
  const selected = repoIds && repoIds.length ? all.filter((u) => repoIds.map(Number).includes(u.repoId)) : all
  if (all.length === 0) {
    throw new AppError(CODES.VALIDATION_FAILED, '该工作单元尚未登记涉及仓库（先单元登记仓库）', { node: node.name })
  }
  if (selected.length === 0) {
    throw new AppError(CODES.VALIDATION_FAILED, '选中的仓库不在该工作单元的登记列表里', { repoIds })
  }

  const repos = []
  for (const ur of selected) {
    const repoRow = store.listRepos().find((r) => r.id === ur.repoId)
    if (!repoRow) {
      repos.push({ repoId: ur.repoId, repo: ur.repoName, ok: false, reason: 'repo-not-registered' })
      continue
    }
    let dir
    try {
      dir = resolveRepoDir(repoRow)
    } catch (e) {
      repos.push({ repoId: repoRow.id, repo: repoRow.name, ok: false, reason: e.code === CODES.REPO_PATH_MISSING ? 'repo-path-missing' : 'repo-not-registered' })
      continue
    }
    const worktreePath = ur.worktreePath || renderWorktreePath(dir, config.worktreeRoot, attrs.slug, node.id)
    if (dryRun) {
      // 复用与真跑同一份只读探查，让「预演」真的能报出占用/基线冲突（D4）
      const plan = await gitCheckWorktreePlan(dir, { worktreePath, branch: branchName, baseBranch: base })
      if (!plan.ok) {
        repos.push({
          repoId: repoRow.id,
          repo: repoRow.name,
          repoDir: dir,
          worktreePath,
          branch: branchName,
          baseBranch: base,
          ok: false,
          planned: true,
          reason: plan.reason,
          message: plan.message || null
        })
        continue
      }
      repos.push({
        repoId: repoRow.id,
        repo: repoRow.name,
        repoDir: dir,
        worktreePath,
        branch: branchName,
        baseBranch: base,
        ok: true,
        planned: true,
        alreadyExists: !!plan.alreadyExists,
        branchExists: !!plan.branchExists
      })
      continue
    }
    const r = await gitAddWorktree(dir, { worktreePath, branch: branchName, baseBranch: base })
    if (!r.ok) {
      if (r.reason === 'path-occupied') {
        throw new AppError(CODES.WORKTREE_PATH_EXISTS, `worktree 路径已被占用（且非分支 ${branchName}）：${worktreePath}`, {
          repo: repoRow.name,
          worktreePath,
          branch: branchName
        })
      }
      if (r.reason === 'base-not-found') {
        throw new AppError(CODES.BRANCH_NOT_FOUND, `基线分支不存在：${base}`, { repo: repoRow.name, baseBranch: base })
      }
      if (r.reason === 'base-mismatch') {
        // 由 checkWorktreePlan 在**任何 git 写操作之前**判定，拒绝时不会留下 worktree（D1）
        throw new AppError(
          CODES.BRANCH_EXISTS_DIFFERENT_BASE,
          `分支 ${branchName} 已存在但基线不是 ${base}（如需复用请显式确认）`,
          { repo: repoRow.name, branch: branchName, baseBranch: base, branchSha: r.branchSha }
        )
      }
      throw new AppError(CODES.GIT_FAILED, `创建 worktree 失败：${repoRow.name}`, { repo: repoRow.name, stderr: r.message })
    }
    repos.push({
      repoId: repoRow.id,
      repo: repoRow.name,
      repoDir: dir,
      worktreePath,
      branch: branchName,
      baseBranch: base,
      ok: true,
      created: !!r.created,
      branchReused: !!r.branchReused,
      alreadyExists: !!r.alreadyExists
    })
  }

  const prompt = composeWorkspacePrompt(store, node, {
    branch: branchName,
    baseBranch: base,
    repos,
    branchTemplate: config.branchTemplate
  })

  if (dryRun) {
    return {
      dryRun: true,
      node: { id: node.id, name: node.name, path: node.path },
      branch: branchName,
      baseBranch: base,
      repos,
      prompt
    }
  }

  // 回填 unit_repos 与节点属性（组合写入 = 一次 revision）。
  // 先算「是否真的有变化」：纯 no-op 重复调用不 bump，避免制造无意义的 revision 噪声（D5）。
  const pending = []
  for (const r of repos) {
    if (r.ok === false) continue
    const ur = store.listUnitRepos(node.id).find((u) => u.repoId === r.repoId)
    if (ur && (ur.branch !== branchName || ur.worktreePath !== r.worktreePath)) {
      pending.push({ id: ur.id, worktreePath: r.worktreePath })
    }
  }
  const branchChanged = attrs.branch !== branchName
  const baseChanged = !attrs.base_branch
  const changed = pending.length > 0 || branchChanged || baseChanged
  if (changed) {
    store.withoutBump(() => {
      for (const p of pending) {
        store.updateUnitRepo(p.id, { branch: branchName, worktreePath: p.worktreePath })
      }
      if (branchChanged) store.setAttrs(node.id, { branch: branchName }, by)
      if (baseChanged) store.setAttrs(node.id, { base_branch: base }, by)
    })
    store.bumpRevision()
  }

  return {
    dryRun: false,
    node: { id: node.id, name: node.name, path: node.path },
    branch: branchName,
    baseBranch: base,
    repos,
    prompt
  }
}

/** 生成 / 刷新开发提示词（纯读，不碰 git、不落库） */
export function getWorkspacePrompt(store, nodeRef) {
  const node = assertUnit(store, nodeRef)
  const config = loadConfig()
  const attrs = store.getAttrs(node.id) || {}
  const base = resolveBaseBranch(store, node, attrs.base_branch || null)
  const branch = attrs.branch || renderBranchName(config.branchTemplate, { baseBranch: base, slug: attrs.slug, nodeId: node.id })
  const repos = store.listUnitRepos(node.id).map((u) => ({
    repoId: u.repoId,
    repo: u.repoName,
    branch: u.branch || branch,
    worktreePath: u.worktreePath,
    ok: true
  }))
  return {
    node: { id: node.id, name: node.name, path: node.path },
    branch,
    baseBranch: base,
    repos,
    prompt: composeWorkspacePrompt(store, node, { branch, baseBranch: base, repos, branchTemplate: config.branchTemplate })
  }
}

/**
 * 清理工作区：移除各仓库 worktree，并尝试删除「已并入基线」的分支。
 * 默认策略是**合并后保留**，因此这是显式动作；`confirm` 是硬性校验（与删除/移动同口径）。
 * 未并入的分支不删（git `-d` 会自动拒绝），回报 `branch-not-merged` 供人工决定。
 */
export async function cleanupWorkspace(store, nodeRef, { confirm = false, removeBranch = true, by = 'user' } = {}) {
  const node = assertUnit(store, nodeRef)
  if (!confirm) {
    throw new AppError(CODES.CONFIRM_REQUIRED, '清理工作区需要 confirm（会移除 worktree，并可能删除分支）', { node: node.name })
  }
  const attrs = store.getAttrs(node.id) || {}
  const base = resolveBaseBranch(store, node, attrs.base_branch || null)
  const branchName = attrs.branch || null
  const unitRepos = store.listUnitRepos(node.id)
  const results = []
  for (const ur of unitRepos) {
    const repoRow = store.listRepos().find((r) => r.id === ur.repoId)
    const out = { repoId: ur.repoId, repo: ur.repoName, worktreePath: ur.worktreePath, branch: ur.branch || branchName }
    if (!repoRow || !repoRow.localPath) {
      results.push({ ...out, ok: false, reason: 'repo-not-registered' })
      continue
    }
    let dir
    try {
      dir = resolveRepoDir(repoRow)
    } catch (e) {
      results.push({ ...out, ok: false, reason: 'repo-path-missing' })
      continue
    }
    if (ur.worktreePath) {
      const rm = await gitRemoveWorktree(dir, ur.worktreePath)
      out.worktreeRemoved = !!rm.ok
      if (!rm.ok) {
        results.push({ ...out, ok: false, reason: rm.reason, message: rm.message })
        continue
      }
      out.worktreeAlreadyRemoved = !!rm.alreadyRemoved
    } else {
      // 上一次 cleanup 已清空 worktree_path：本次视为「已移除」，保证重复调用幂等可观测
      out.worktreeAlreadyRemoved = true
    }
    if (removeBranch && branchName && base) {
      // 传入声明基线：删除判定必须相对基线，而不是当前 HEAD（D2）
      const del = await gitDeleteLocalBranch(dir, branchName, { baseBranch: base })
      out.branchRemoved = !!del.ok && !!del.removed
      if (!del.ok) out.branchNote = del.reason
    } else if (!removeBranch) {
      // 显式保留分支：如实回报「没删」，避免调用方把 undefined 当成未知
      out.branchRemoved = false
      out.branchNote = 'kept_by_request'
    }
    results.push({ ...out, ok: true })
  }

  store.withoutBump(() => {
    for (const r of results) {
      if (r.ok !== true) continue
      const ur = store.listUnitRepos(node.id).find((u) => u.repoId === r.repoId)
      if (ur) store.updateUnitRepo(ur.id, { worktreePath: null })
    }
    if (attrs.branch) store.setAttrs(node.id, { branch: '' }, by)
  })
  store.bumpRevision()

  return {
    node: { id: node.id, name: node.name, path: node.path },
    branch: branchName,
    baseBranch: base,
    removeBranch: !!removeBranch,
    removed: results.filter((r) => r.worktreeRemoved || r.worktreeAlreadyRemoved).length,
    results
  }
}

/**
 * 上线清单导出：把 buildReleaseChecklist 的聚合结果渲染成可贴进 issue / 上线单的 markdown。
 * 与 renderAcceptanceMd 同风格，便于一起贴进同一个验收 / 上线记录。
 */
export function renderReleaseChecklistMd(checklist) {
  const t = checklist.totals
  const kindLabels = { config: '上线配置', sql: '上线 SQL', check: '上线检查' }
  const lines = [
    `# 上线检查：${checklist.node.name}`,
    '',
    `- 范围：${checklist.scope === 'subtree' ? '含子树' : '仅本节点'}`,
    `- 上线项：${t.items} · 必做：${t.required} · 可选：${t.optional} · 完成：${t.done} · 跳过：${t.skipped} · 阻塞：${t.blocked} · 待处理：${t.pending}`,
    `- 上线就绪：${checklist.ready == null ? '—（无必做项）' : checklist.ready ? '是' : '否'}`,
    ''
  ]
  if (checklist.blockers.length > 0) {
    lines.push('## 阻塞项', '', '| 上线项 | 类型 | 状态 |', '|---|---|---|')
    for (const b of checklist.blockers) lines.push(`| ${b.name} | ${kindLabels[b.kind] || b.kind} | ${b.status} |`)
    lines.push('')
  }
  lines.push('## 上线项明细', '', '| 上线项 | 类型 | 状态 | 必做 | 回滚 |', '|---|---|---|---|---|')
  for (const i of checklist.items) {
    lines.push(
      `| ${i.name} | ${kindLabels[i.kind] || i.kind} | ${i.status} | ${i.required ? '是' : '否'} | ${i.rollback ? '有' : '—'} |`
    )
  }
  return lines.join('\n')
}

/**
 * 上线前置检查编排：把上线清单 + 已登记的 code_check / biz_check / release_check 用例
 * 拼成一段可执行提示词派单给 agent（复用 agent 运行时），并开 running 报告。
 * dryRun 只回将要检查的内容，不派单、不落库。
 */
export function runReleaseChecks(
  store,
  nodeRef,
  { caseIds = null, scope = 'self', prompt = null, agent = undefined, model = undefined, cwd = null, dryRun = false } = {},
  by = 'user'
) {
  const node = store.resolveRef(String(nodeRef))
  // scope=self 只看本节点，scope=subtree 连子树的上线项与检查用例一起纳入——
  // 与 release_checklist 的 scope 口径对齐，避免「子树有上线项却没进检查」的误解。
  const effectiveScope = store.normalizeScope(scope)
  const checkNodeIds = effectiveScope === 'subtree' ? store.subtreeIds(node.id) : [node.id]
  const checks = checkNodeIds
    .flatMap((nid) => store.listTestCases(nid, {}))
    .filter((c) => c.kind === 'code_check' || c.kind === 'biz_check' || c.kind === 'release_check')
    .filter((c) => (caseIds && caseIds.length ? caseIds.map(Number).includes(c.id) : true))
  const checklist = store.buildReleaseChecklist(node.id, { scope: effectiveScope })
  if (checks.length === 0 && checklist.items.length === 0) {
    // 若本节点没东西、但子树有，明确提示用 scope=subtree：避免「子树有上线项却没进检查」的误解
    const subtreeChecklist = effectiveScope === 'self' ? store.buildReleaseChecklist(node.id, { scope: 'subtree' }) : null
    const hintSubtree = subtreeChecklist && subtreeChecklist.items.length > 0
    throw new AppError(
      CODES.VALIDATION_FAILED,
      hintSubtree
        ? `本节点没有可执行的上线检查，但子树有 ${subtreeChecklist.items.length} 个上线项——如需纳入请用 scope=subtree`
        : '没有可执行的上线检查（先登记上线项或 code_check/biz_check/release_check 用例）',
      { nodeId: node.id, scope: effectiveScope, subtreeItems: hintSubtree ? subtreeChecklist.items.length : 0 }
    )
  }
  const composed = composeReleaseCheckPrompt(node, checks, checklist, prompt)
  if (dryRun) {
    return {
      dryRun: true,
      node: { id: node.id, name: node.name },
      scope: effectiveScope,
      cases: checks.map((c) => ({ id: c.id, name: c.name, kind: c.kind })),
      items: checklist.items.map((i) => ({ id: i.id, name: i.name, kind: i.kind, status: i.status })),
      ready: checklist.ready,
      prompt: composed
    }
  }
  const run = startAgentRun(store, node.id, { prompt: composed, agent, model, cwd }, by)
  // 报告挂回各自用例所属节点，保证 acceptance / checklist 聚合能按节点正确归位
  const reports = checks.map((c) =>
    store.createTestReport(c.nodeId, { caseId: c.id, runId: run.id, kind: c.kind, status: 'running', summary: `已派单检查：${c.name}` }, by)
  )
  return { node: { id: node.id, name: node.name }, scope: effectiveScope, run, reports, checklist }
}

/** 把上线清单与检查用例拼成给 agent 的上线前置检查指令 */
export function composeReleaseCheckPrompt(node, cases, checklist, extra = null) {
  const kindLabels = { config: '上线配置', sql: '上线 SQL', check: '上线检查' }
  const lines = [
    `请在当前工作目录对节点「${node.name}」（${node.type}）执行上线前检查，并给出上线就绪结论。`,
    '逐条输出一行：`<检查项>: PASS|FAIL|BLOCKED - <依据>`；不确定时用 BLOCKED 并说明缺什么。',
    ''
  ]
  if (checklist.items.length > 0) {
    lines.push('## 上线清单')
    checklist.items.forEach((i, n) => {
      lines.push(`${n + 1}. [${kindLabels[i.kind] || i.kind}] ${i.name}（${i.required ? '必做' : '可选'}，当前状态 ${i.status}）`)
      if (i.content) lines.push(`   - 内容：${i.content}`)
      if (i.rollback) lines.push(`   - 回滚：${i.rollback}`)
    })
    lines.push('')
  }
  if (cases.length > 0) {
    lines.push('## 检查用例')
    cases.forEach((c, i) => {
      lines.push(`### 用例 ${i + 1}：${c.name}（${c.kind}）`)
      lines.push(c.prompt)
      if (c.expectation) lines.push(`期望结果：${c.expectation}`)
      lines.push('')
    })
  }
  if (extra) lines.push('额外要求：', extra)
  return lines.join('\n')
}

/**
 * 批量操作：`{ ops: [...], dryRun }`；单个 op 失败不影响其余，逐条返回状态。
 * op：node.create / node.upsert / node.update / node.delete / attr.set / doc.upsert / doc.update /
 *     doc.remove / commit.add / commit.remove / repo.add / attr_add
 */
export function applyBatch(store, ops, { dryRun = false, by = 'user' } = {}) {
  const results = []
  for (const [index, op] of (ops || []).entries()) {
    try {
      results.push({ index, op: op.op, ok: true, result: runOp(store, op, { dryRun, by }) })
    } catch (e) {
      results.push({
        index,
        op: op.op,
        ok: false,
        error: { code: e.code || 'ERROR', message: e.message, details: e.details }
      })
    }
  }
  return { dryRun, total: results.length, failed: results.filter((r) => !r.ok).length, results }
}

function runOp(store, op, { dryRun, by }) {
  switch (op.op) {
    case 'node.create':
      if (dryRun) return { planned: 'node.create', name: op.name }
      return store.createNode({
        parentId: op.parentId ?? (op.parentPath ? store.resolveRef(op.parentPath).id : null),
        type: op.type,
        name: op.name,
        status: op.status,
        attrs: op.attrs,
        actor: by
      })
    case 'node.upsert':
      return upsertByPath(store, op.path, { type: op.type, attrs: op.attrs, by, dryRun }).node
    case 'node.update': {
      const node = store.resolveRef(op.ref)
      if (op.confirm !== true && (op.patch?.parentId !== undefined || op.patch?.parentPath !== undefined)) {
        throw new AppError(CODES.CONFIRM_REQUIRED, `移动节点 ${node.path} 需要 confirm: true`, { ref: op.ref })
      }
      if (dryRun) return { planned: 'node.update', path: node.path, patch: op.patch }
      const patch = { ...op.patch }
      if (patch.parentPath !== undefined) {
        patch.parentId = patch.parentPath === null ? null : store.resolveRef(patch.parentPath).id
        delete patch.parentPath
      }
      return store.updateNode(node.id, patch, by)
    }
    case 'node.delete': {
      const node = store.resolveRef(op.ref)
      if (op.confirm !== true) throw new AppError(CODES.CONFIRM_REQUIRED, `删除节点 ${node.path} 需要 confirm: true`, { ref: op.ref })
      if (dryRun) return { planned: 'node.delete', path: node.path }
      return store.deleteNode(node.id)
    }
    case 'attr.set': {
      const node = store.resolveRef(op.ref)
      if (dryRun) return { planned: 'attr.set', path: node.path, attrs: op.attrs }
      return store.setAttrs(node.id, op.attrs, by)
    }
    case 'attr_add':
      if (dryRun) return { planned: 'attr_add', key: op.key }
      return store.addAttrDef({ ...op, nodeType: op.nodeType, dataType: op.dataType })
    case 'doc.upsert': {
      const node = store.resolveRef(op.ref)
      if (dryRun) return { planned: 'doc.upsert', path: node.path, name: op.name }
      return store.upsertDocument(node.id, op.name, op.content ?? null, by)
    }
    case 'doc.create': {
      const node = store.resolveRef(op.ref)
      if (dryRun) return { planned: 'doc.create', path: node.path, name: op.name }
      return store.createDocument(node.id, op.name, op.content ?? '', by)
    }
    case 'doc.update':
      if (dryRun) return { planned: 'doc.update', id: op.docId }
      return store.updateDocument(op.docId, { name: op.name, content: op.content }, by)
    case 'doc.remove':
      if (dryRun) return { planned: 'doc.remove', id: op.docId }
      return store.deleteDocument(op.docId)
    case 'commit.add': {
      const node = store.resolveRef(op.ref)
      if (dryRun) return { planned: 'commit.add', path: node.path, sha: op.sha }
      return store.addCommit(node.id, { repo: op.repo, sha: op.sha, note: op.note }, by)
    }
    case 'commit.remove':
      if (dryRun) return { planned: 'commit.remove', id: op.commitId }
      return store.removeCommit(op.commitId)
    case 'repo.add':
      if (dryRun) return { planned: 'repo.add', name: op.name }
      return store.addRepo({ name: op.name, localPath: op.localPath, gitlabProject: op.gitlabProject, note: op.note })
    default:
      throw new AppError(CODES.VALIDATION_FAILED, `不支持的 op：${op.op}`, { op: op.op })
  }
}
