/**
 * 本机 git 操作（commit diff 预览用）
 *
 * 实现说明：features/diff-preview/design.md 原计划引入 simple-git；
 * 实际采用 node:child_process.execFile 直接调用本机 git（参数数组、不经 shell），
 * 零新增依赖，保持"纯本地"定位。GitLab API 兜底分支留待计划 5
 * （当前 local_path 缺失即报 REPO_PATH_MISSING，见 features/diff-preview/prd.md）。
 */
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import path from 'node:path'
import { AppError, CODES } from './errors.mjs'

const execFileP = promisify(execFile)
const MAX_BUFFER = 64 * 1024 * 1024 // git 输出上限（大 patch 需要）
const MAX_TEXT = 512 * 1024 // 单文件 patch / old / new 的截断阈值（字符）

async function git(dir, args) {
  try {
    const { stdout } = await execFileP('git', ['-C', dir, ...args], { maxBuffer: MAX_BUFFER, encoding: 'utf8' })
    return stdout
  } catch (e) {
    if (e && e.code === 'ENOENT') {
      throw new AppError(CODES.GIT_UNAVAILABLE, '本机 git 不可用（命令不存在）')
    }
    throw new AppError(CODES.GIT_FAILED, `git ${args[0]} 执行失败`, {
      stderr: String((e && (e.stderr || e.message)) || '').slice(0, 2000)
    })
  }
}

/** 不抛错的 git 执行（用于以退出码表达结果的命令，如 merge-base --is-ancestor） */
async function gitTry(dir, args) {
  try {
    const { stdout } = await execFileP('git', ['-C', dir, ...args], { maxBuffer: MAX_BUFFER, encoding: 'utf8' })
    return { ok: true, code: 0, stdout }
  } catch (e) {
    if (e && e.code === 'ENOENT') {
      throw new AppError(CODES.GIT_UNAVAILABLE, '本机 git 不可用（命令不存在）')
    }
    return {
      ok: false,
      code: typeof e.code === 'number' ? e.code : 1,
      stdout: String((e && e.stdout) || ''),
      stderr: String((e && (e.stderr || e.message)) || '')
    }
  }
}

/** 仓库解析：local_path 存在且是 git 仓库 → 返回目录；否则抛稳定错误码 */
export function resolveRepoDir(repo) {
  if (!repo) throw new AppError(CODES.REPO_NOT_REGISTERED, '仓库未登记（先 repo add）')
  const dir = repo.localPath
  if (!dir) {
    throw new AppError(CODES.REPO_PATH_MISSING, `仓库 ${repo.name} 未登记本地路径（local_path），无法读取本机 git`, { repo: repo.name })
  }
  if (!fs.existsSync(path.join(dir, '.git'))) {
    throw new AppError(CODES.REPO_PATH_MISSING, `本地路径不存在或不是 git 仓库：${dir}`, { repo: repo.name, path: dir })
  }
  return dir
}

function clip(value) {
  if (value == null) return { text: '', truncated: false }
  const s = String(value)
  return s.length > MAX_TEXT ? { text: s.slice(0, MAX_TEXT), truncated: true } : { text: s, truncated: false }
}

function parseNumstat(out) {
  return out
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => {
      const parts = l.split('\t')
      const binary = parts[0] === '-' && parts[1] === '-'
      return {
        path: parts.slice(2).join('\t'),
        additions: binary ? 0 : Number(parts[0]),
        deletions: binary ? 0 : Number(parts[1]),
        binary
      }
    })
}

export async function showFileAt(dir, rev, filePath) {
  try {
    return await git(dir, ['show', `${rev}:${filePath}`])
  } catch {
    return null // 新文件取 ^:path、删除文件取 sha:path 会失败，静默置空
  }
}

/** commit 元信息（轻量：不拉 patch）：sha/作者/邮箱/时间/主题 + 包含该提交的分支 */
export async function commitMeta(dir, sha) {
  const meta = await git(dir, ['show', '-s', '--format=%H%x1f%an%x1f%ae%x1f%ad%x1f%s', '--date=iso', sha])
  const [fullSha, author, authorEmail, date, subject] = meta.trimEnd().split('\x1f')
  return { sha: fullSha, author, authorEmail, date, subject, branches: await branchesContaining(dir, fullSha) }
}

/** 单个 commit 的完整 diff：meta + 文件列表 + 每文件 patch / old / new */
/** git cat-file --batch：批量取内容（specs 如 "sha:path" / "sha^:path"）。返回 Map<spec, string|null> */
async function catFileBatch(dir, specs) {
  if (!specs.length) return new Map()
  return new Promise((resolve) => {
    const proc = spawn('git', ['-C', dir, 'cat-file', '--batch'], { stdio: ['pipe', 'pipe', 'ignore'] })
    const chunks = []
    proc.stdout.on('data', (d) => chunks.push(d))
    proc.on('error', () => resolve(new Map()))
    proc.on('close', () => {
      const buf = Buffer.concat(chunks)
      const out = new Map()
      let pos = 0
      let idx = 0
      while (pos < buf.length && idx < specs.length) {
        const nl = buf.indexOf(10, pos)
        if (nl < 0) break
        const header = buf.slice(pos, nl).toString('utf8')
        pos = nl + 1
        if (header.endsWith(' missing') || header.includes(' ambiguous')) {
          out.set(specs[idx], null)
          idx++
          continue
        }
        const parts = header.split(' ')
        const size = Number(parts[2] ?? -1)
        if (!Number.isFinite(size) || size < 0) {
          out.set(specs[idx], null)
          idx++
          continue
        }
        out.set(specs[idx], buf.slice(pos, pos + size).toString('utf8'))
        pos += size + 1
        idx++
      }
      resolve(out)
    })
    for (const sp of specs) {
      proc.stdin.write(sp + '\n')
    }
    proc.stdin.end()
  })
}

export async function commitDiff(dir, sha) {
  const meta = await commitMeta(dir, sha)

  const entries = parseNumstat(await git(dir, ['show', sha, '--numstat', '--no-renames', '--format=']))

  // ① 一次拿全部 patch，按 "diff --git a/x b/x" 拆分（替代逐文件 git show）
  const patchFull = await gitTry(dir, ['show', sha, '--format=', '--no-renames'])
  const patchByFile = new Map()
  if (patchFull.ok && patchFull.stdout) {
    let curPath = null
    let curLines = []
    const flush = () => {
      if (curPath != null) patchByFile.set(curPath, curLines.join('\n'))
      curPath = null
      curLines = []
    }
    for (const line of patchFull.stdout.split('\n')) {
      const m = line.match(/^diff --git a\/(.+?) b\/(.+)$/)
      if (m) {
        flush()
        curPath = m[2]
        curLines = [line]
      } else if (curPath != null) {
        curLines.push(line)
      }
    }
    flush()
  }

  // ② 一次 cat-file --batch 拿 old/new（父版本 + 本版本；替代每文件 2 次 git）
  const specs = []
  for (const f of entries) {
    if (f.binary) continue
    specs.push(`${sha}^:${f.path}`, `${sha}:${f.path}`)
  }
  const contents = await catFileBatch(dir, specs)

  const files = []
  for (const f of entries) {
    if (f.binary) {
      files.push({ path: f.path, additions: 0, deletions: 0, binary: true, patch: '', patchTruncated: false, old: '', oldTruncated: false, new: '', newTruncated: false })
      continue
    }
    const patch = clip(patchByFile.get(f.path) || '')
    const oldRaw = contents.get(`${sha}^:${f.path}`)
    const newRaw = contents.get(`${sha}:${f.path}`)
    const oldT = oldRaw != null ? clip(oldRaw) : { text: '', truncated: false }
    const newT = newRaw != null ? clip(newRaw) : { text: '', truncated: false }
    files.push({
      path: f.path,
      additions: f.additions,
      deletions: f.deletions,
      binary: false,
      patch: patch.text,
      patchTruncated: patch.truncated,
      old: oldT.text,
      oldTruncated: oldT.truncated,
      new: newT.text,
      newTruncated: newT.truncated
    })
  }

  return { ...meta, shortSha: meta.sha.slice(0, 9), files }
}

/** commit 时间戳（秒） */
export async function commitTime(dir, sha) {
  const r = await git(dir, ['show', '-s', '--format=%at', sha])
  return Number(r.trim())
}

/** 提交的父提交列表 */
export async function commitParents(dir, sha) {
  const r = await git(dir, ['show', '-s', '--format=%P', sha])
  const t = r.trim()
  return t ? t.split(/\s+/) : []
}

/**
 * patch-id（--stable）：同一内容不同 sha（rebase / cherry-pick）得到相同值；
 * merge 提交无意义（调用方先判断 parents 数量跳过）。实现为 git show | git patch-id 管道（不经 shell）。
 */
export function patchId(dir, sha) {
  return new Promise((resolve) => {
    let settled = false
    const done = (v) => {
      if (!settled) {
        settled = true
        resolve(v)
      }
    }
    try {
      const show = spawn('git', ['-C', dir, 'show', sha, '--no-color', '--no-renames', '--format='], {
        stdio: ['ignore', 'pipe', 'ignore']
      })
      const pid = spawn('git', ['-C', dir, 'patch-id', '--stable'], { stdio: ['pipe', 'pipe', 'ignore'] })
      show.stdout.pipe(pid.stdin)
      let out = ''
      pid.stdout.on('data', (d) => {
        out += d.toString()
      })
      pid.on('close', () => done(out.trim().split(/\s+/)[0] || null))
      pid.on('error', () => done(null))
      show.on('error', () => done(null))
      setTimeout(() => done(null), 30000)
    } catch {
      done(null)
    }
  })
}

/** merge 提交的第二父分支独有提交（被合入的提交集）：rev-list <sha>^2 --not <sha>^1 */
export async function mergedInCommits(dir, parents) {
  if (!parents || parents.length < 2) return []
  const r = await gitTry(dir, ['rev-list', parents[1], '--not', parents[0]])
  if (!r.ok) return []
  return r.stdout
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
}

/** 包含该提交的分支（本地 + 远程，去重去 origin/ 前缀，限 8 个） */
export async function branchesContaining(dir, sha) {
  const r = await gitTry(dir, ['branch', '-a', '--contains', sha, '--format=%(refname:short)'])
  if (!r.ok) return []
  const out = []
  const seen = new Set()
  for (const raw of r.stdout.split('\n')) {
    let b = raw.trim()
    if (!b || b.includes('HEAD detached')) continue
    b = b.replace(/^remotes\/origin\//, '').replace(/^origin\//, '')
    if (seen.has(b)) continue
    seen.add(b)
    out.push(b)
    if (out.length >= 8) break
  }
  return out
}

/** 提交 subject（如 feat(26Q3-3.5.4): …）；取不到返回 null */
async function commitSubject(dir, sha) {
  const r = await gitTry(dir, ['log', '-1', '--format=%s', sha])
  if (!r.ok) return null
  return String(r.stdout || '').trim() || null
}

/** 版本号边界正则：`1.1.1` 不匹配 `11.1.1` / `1.1.10`，避免子串碰撞把集成分支误判成开发分支 */
function versionBoundaryRe(version) {
  const esc = String(version).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|[^\\d.])${esc}([^\\d.]|$)`)
}

/** 从若干候选分支里，按版本号边界匹配挑一个（命中多条取最具体的）；无命中返回 null */
function pickByVersion(branches, version) {
  if (!version) return null
  const re = versionBoundaryRe(version)
  const hit = branches.filter((b) => re.test(b))
  return hit.length ? hit.sort((a, b) => b.length - a.length)[0] : null
}

/**
 * 为提交挑选"开发分支"：
 * ① GitHub PR merge → 归属 subject 里的源分支（`Merge pull request #12 from org/feature-login-1.1.1`）；
 * ② 经典 merge → 归属其合入目标分支（`Merge branch 'x' into feature-merge` → feature-merge）；
 * ③ 普通提交 → 排除 feature-merge 后，优先分支名与提交 message 中需求编号（如 3.5.4）**按版本号边界**匹配的
 *    feature-*，其次最具体的 feature-*（最长），否则回退第一个。
 *
 * 约束：squash merge（GitHub「Squash and merge」）把多个提交压成一个普通提交，subject 里不再有 merge 元数据，
 * 无法可靠推断源分支——只能退化为需求编号边界匹配 / 最长 feature-*。走 squash 流程时请在登记 commit 时
 * **显式传 `branch`**（HTTP/MCP `branch` 参数、CLI `commit add --branch`）纠正归属。
 *
 * 注意：仅按长度取最长会把长命集成分支（如 feature-transfer-3.4.1-material-apply-id-fix）误判成开发分支。
 */
export async function pickBranchForCommit(dir, sha) {
  const all = await branchesContaining(dir, sha)
  if (!all.length) return null
  const subject = await commitSubject(dir, sha)
  const feats = all.filter((b) => b.startsWith('feature-') && b !== 'feature-merge')
  const ticket = subject && subject.match(/\b(\d+\.\d+\.\d+)\b/)

  // ① GitHub PR merge：subject 只带源分支（`from <owner>/<branch>`），据此归属开发分支。
  //    注意源分支是 merge 提交的祖先，`branch --contains <merge>` 不会列出它，因此以 subject 为准直接返回。
  const pr = subject && subject.match(/^Merge pull request #\d+ from (\S+)/)
  if (pr) {
    // `from <owner>/<branch>`：只去掉第一段 owner，保留 branch 自身可能含的斜杠
    const head = pr[1].replace(/^[^/]+\//, '')
    if (head && head !== pr[1] && head !== 'main' && head !== 'master') return head
  }

  // ② 经典 merge：归属合入目标分支
  const mergeTarget = subject && subject.match(/^Merge (?:branch|remote-tracking branch) '[^']+' into (\S+)/)
  if (mergeTarget && all.includes(mergeTarget[1])) return mergeTarget[1]

  const pool = feats.length ? feats : all
  if (!feats.length) return all[0]

  // ③ 普通提交：需求编号按版本号边界匹配（避免 1.1.1 命中 11.1.1）
  const byTicket = pickByVersion(pool, ticket && ticket[1])
  if (byTicket) return byTicket

  // 最具体 = 最长（如 feature-send-receive-3.1.1-inner-buy-flag > feature-send-receive）
  return feats.sort((a, b) => b.length - a.length)[0]
}

/**
 * 合并预览（MR 式）：将合入的变更统计 + 冲突预判（git merge-tree --write-tree）。
 * 返回：{ willIntroduce: [{file,add,del}], conflictFiles: [..], conflicted: bool, stat: string }
 */
export async function previewMerge(dir, source, target) {
  const stat = await gitTry(dir, ['diff', '--stat', `${target}...${source}`])
  const files = []
  if (stat.ok) {
    for (const line of stat.stdout.split('\n')) {
      const m = line.match(/^ (.+?)\s+\|\s+(\d+)\s*([+-]*)$/)
      if (m) {
        const plus = (m[3].match(/\+/g) || []).length
        const minus = (m[3].match(/-/g) || []).length
        files.push({ file: m[1].trim(), add: plus, del: minus })
      }
    }
  }
  // 用 --name-only：Git 2.39+ 的裸 --write-tree 会输出 stage 行（含 oid/mode），
  // 直接当文件名落库会把「100644 <sha> 1\tpath」整行写进 conflict_files。
  const mt = await gitTry(dir, ['merge-tree', '--write-tree', '--name-only', target, source])
  let conflicted = false
  const conflictFiles = []
  // gitTry 以退出码非 0 返回 ok:false；`merge-tree` 有冲突时正是 exit=1，
  // 旧判定 `mt.ok && mt.code !== 0` 因此永远拿不到冲突文件清单。
  const output = String(mt.stdout || '').trim()
  if (!mt.ok && mt.code !== 0 && output) {
    conflicted = true
    for (const line of output.split('\n').slice(1)) {
      const t = line.trim()
      if (!t) continue
      // stdout 末尾会混入 "Auto-merging ..." / "CONFLICT ..." 的人类可读信息；
      // 冲突文件清单只保留真正的路径行（stage 行即使未加 --name-only 也不会误收）。
      if (/^(Auto-merging|CONFLICT|CONFLICT \()/i.test(t)) continue
      if (/^\d{6} [0-9a-f]+ [123]\t/.test(t)) {
        conflictFiles.push(t.split('\t').slice(1).join('\t').replace(/\x00.*$/, ''))
        continue
      }
      conflictFiles.push(t.replace(/\x00.*$/, ''))
    }
  }
  return {
    willIntroduce: files.slice(0, 80),
    conflicted,
    conflictFiles: conflictFiles.slice(0, 30),
    stat: String(stat.ok ? stat.stdout : '').slice(-3000)
  }
}

/**
 * 批量提交元信息：一次 git log --no-walk 拿多条的 stat/作者/时间/分支。
 * 返回 Map<完整sha, {sha,author,authorEmail,date,branches,stat:[{path,additions,deletions,binary}]}>
 */
export async function commitMetasBatch(dir, shas) {
  const list = (shas || []).filter(Boolean)
  if (list.length === 0) return new Map()
  const SEP = '\u0001'
  const r = await gitTry(dir, [
    'log',
    '--no-walk=unsorted',
    '--numstat',
    `--format=@@@%H${SEP}%an${SEP}%ae${SEP}%aI${SEP}%D`,
    ...list
  ])
  if (!r.ok) return new Map()
  const out = new Map()
  let cur = null
  for (const line of r.stdout.split('\n')) {
    if (line.startsWith('@@@')) {
      const parts = line.slice(3).split(SEP)
      cur = {
        sha: parts[0] || '',
        author: parts[1] || '',
        authorEmail: parts[2] || '',
        date: parts[3] || '',
        branches: parts[4] ? parts[4].split(',').map((x) => x.trim()).filter(Boolean) : [],
        stat: []
      }
      if (cur.sha) out.set(cur.sha, cur)
    } else if (cur && line.trim()) {
      const cells = line.split('\t')
      if (cells.length >= 3) {
        const binary = cells[0] === '-' && cells[1] === '-'
        cur.stat.push({
          path: cells.slice(2).join('\t'),
          additions: binary ? 0 : Number(cells[0]) || 0,
          deletions: binary ? 0 : Number(cells[1]) || 0,
          binary
        })
      }
    }
  }
  return out
}

/** 一次 git log 拿分支上的全部 sha（Set）；ref 不存在返回 null */
export async function branchLogShas(dir, branch, maxCount = 5000) {
  const ref = await resolveBranchRef(dir, branch)
  if (!ref) return null
  const r = await gitTry(dir, ['log', ref, '--format=%H', `--max-count=${maxCount}`])
  if (!r.ok) return null
  return new Set(r.stdout.split('\n').map((s) => s.trim()).filter(Boolean))
}

/**
 * 主仓库合并：把 source 合入 target（--no-ff）。
 * 前置安全判定：① 当前工作区无未解决冲突（UU/AA/DD 等）② 能切到 target。
 * 返回：{ ok, alreadyMerged?, conflict?, reason?, unmerged?, mergeSha?, message? }
 */
export async function mergeBranch(dir, source, target, message) {
  // ① 未解决冲突检查
  const st = await gitTry(dir, ['status', '--porcelain'])
  if (st.ok) {
    const unmerged = st.stdout
      .split('\n')
      .filter((l) => /^(UU|AA|DD|AU|UA|DU|UD) /.test(l))
      .slice(0, 10)
    if (unmerged.length) {
      return { ok: false, conflict: true, reason: 'unresolved_conflicts', unmerged }
    }
  }
  // ② 已合入判定（source 的 tip 是否为 target 祖先）
  const anc = await gitTry(dir, ['merge-base', '--is-ancestor', source, target])
  if (anc.ok && anc.code === 0) {
    return { ok: true, alreadyMerged: true, reason: 'already_merged' }
  }
  // ③ 切到 target
  const co = await gitTry(dir, ['checkout', target])
  if (!co.ok) {
    return { ok: false, conflict: false, reason: 'checkout_failed', message: String(co.stderr || '').slice(0, 1000) }
  }
  // ④ merge --no-ff
  const m = await gitTry(dir, ['merge', '--no-ff', source, '-m', message || `merge: ${source} -> ${target}`])
  if (m.ok) {
    const head = await gitTry(dir, ['rev-parse', 'HEAD'])
    return { ok: true, mergeSha: head.ok ? head.stdout.trim() : null, message: String(m.stdout || '').slice(0, 500) }
  }
  const out = String(m.stderr || '') + String(m.stdout || '')
  const conflicted = /CONFLICT|Automatic merge failed/i.test(out)
  return {
    ok: false,
    conflict: conflicted,
    reason: conflicted ? 'merge_conflict' : 'merge_failed',
    message: out.slice(0, 2000)
  }
}

/** 仅变更文件统计（子树聚合用，避免拉取全量 patch / old / new） */
export async function commitStat(dir, sha) {
  return parseNumstat(await git(dir, ['show', sha, '--numstat', '--no-renames', '--format=']))
}

/** 解析追踪目标 ref：优先 origin/<name>，其次本地分支，再次 tag，最后按原样交给 git（name 可为分支名或 tag 名） */
async function resolveBranchRef(dir, branch) {
  for (const ref of [`refs/remotes/origin/${branch}`, `refs/heads/${branch}`, `refs/tags/${branch}`, branch]) {
    const r = await gitTry(dir, ['rev-parse', '--verify', '--quiet', ref])
    if (r.ok && r.stdout.trim()) return ref
  }
  return null
}

/**
 * 检测 commit 是否已合并/包含在指定目标（分支或 tag）中：
 * - 未配置 → { contained: null, reason: 'not-configured' }
 * - 本地无该 ref（未 fetch）→ { contained: null, reason: 'ref-not-found' }
 * - 是/否包含 → { contained: true|false, ref }
 */
export async function branchContains(dir, sha, branch) {
  if (!branch) return { branch: null, ref: null, contained: null, reason: 'not-configured' }
  const ref = await resolveBranchRef(dir, branch)
  if (!ref) return { branch, ref: null, contained: null, reason: 'ref-not-found' }
  const r = await gitTry(dir, ['merge-base', '--is-ancestor', sha, ref])
  if (r.code === 0) return { branch, ref, contained: true, reason: null }
  if (r.code === 1) return { branch, ref, contained: false, reason: null }
  return { branch, ref, contained: null, reason: 'git-error' }
}

/** 检测 commit 对三个目标（测试/预发/上线，可为分支或 tag）的包含状态 */
export async function commitTrack(dir, sha, branches) {
  const out = {}
  for (const [key, branch] of Object.entries(branches || {})) {
    out[key] = await branchContains(dir, sha, branch)
  }
  return out
}

// ---------- 工作区（分支 / worktree）----------

/** 某 ref（分支 / tag / sha）是否存在且指向一个 commit；返回 sha 或 null */
export async function revParse(dir, ref) {
  if (!ref) return null
  const r = await gitTry(dir, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])
  return r.ok && r.stdout.trim() ? r.stdout.trim() : null
}

/** 某本地分支当前指向的 sha（只看 refs/heads，不落到远端跟踪分支）；不存在返回 null */
export async function localBranchSha(dir, branch) {
  if (!branch) return null
  const r = await gitTry(dir, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])
  return r.ok && r.stdout.trim() ? r.stdout.trim() : null
}

/** 两个 ref 的 merge-base sha；无共同祖先或 ref 缺失时返回 null */
export async function mergeBase(dir, a, b) {
  if (!a || !b) return null
  const r = await gitTry(dir, ['merge-base', a, b])
  return r.ok && r.stdout.trim() ? r.stdout.trim() : null
}

/** 已登记的 worktree 列表：{ path, branch, head } */
export async function listWorktrees(dir) {
  const r = await gitTry(dir, ['worktree', 'list', '--porcelain'])
  if (!r.ok) return []
  const out = []
  let cur = {}
  for (const line of r.stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (cur.path) out.push(cur)
      cur = { path: line.slice('worktree '.length).trim() }
    } else if (line.startsWith('HEAD ')) {
      cur.head = line.slice('HEAD '.length).trim()
    } else if (line.startsWith('branch ')) {
      cur.branch = line.slice('branch '.length).trim().replace(/^refs\/heads\//, '')
    } else if (line.startsWith('detached')) {
      cur.detached = true
    }
  }
  if (cur.path) out.push(cur)
  return out
}

/** 路径的 worktree 占用情况：'same'（就是本分支）| 'other'（被别人占）| null（未占用） */
export async function worktreeOccupancy(dir, worktreePath, branch) {
  const list = await listWorktrees(dir)
  const hit = list.find((w) => samePath(w.path, worktreePath))
  if (!hit) return null
  return hit.branch && hit.branch === branch ? 'same' : 'other'
}

/**
 * 路径等价判定。git 会把符号链接解析后的真实路径写进 `worktree list`
 * （macOS 上 `/tmp/...` → `/private/tmp/...`），直接比字符串会漏判成「未占用」，
 * 进而把幂等复用误报成 409、或在清理时找不到目标。两侧都做 realpath 归一。
 */
function samePath(a, b) {
  if (!a || !b) return false
  const norm = (p) => {
    try {
      return fs.realpathSync.native ? fs.realpathSync.native(p) : fs.realpathSync(p)
    } catch {
      return path.resolve(p)
    }
  }
  return norm(a) === norm(b)
}

/**
 * 只读探查「创建工作区」会发生什么，不做任何 git 写操作。
 * 真实路径（addWorktree）与 dryRun 共用这一份判定，保证「预演」与「真跑」结论一致（D4）。
 * 返回：
 *   { ok:true, alreadyExists:true }        路径已是本分支的 worktree（幂等）
 *   { ok:true, branchExists, branchSha }   可以创建（branchExists=false）或复用
 *   { ok:false, reason:'base-not-found' }  基线分支不存在
 *   { ok:false, reason:'base-mismatch' }   同名分支已存在但 tip ≠ 基线（拒绝且零副作用）
 *   { ok:false, reason:'path-occupied' }   路径被其他分支或普通目录占用
 */
export async function checkWorktreePlan(dir, { worktreePath, branch, baseBranch }) {
  const baseSha = await revParse(dir, baseBranch)
  if (!baseSha) return { ok: false, reason: 'base-not-found', baseBranch, worktreePath, branch }

  const occupied = await worktreeOccupancy(dir, worktreePath, branch)
  if (occupied === 'same') return { ok: true, alreadyExists: true, baseSha, worktreePath, branch }
  if (occupied === 'other') return { ok: false, reason: 'path-occupied', worktreePath, branch }
  if (fs.existsSync(worktreePath)) {
    // 路径存在但不是本仓库登记的 worktree（普通目录）→ 一律视为占用，避免误用/误删
    return { ok: false, reason: 'path-occupied', worktreePath, branch, message: '路径已存在但不是本仓库的 worktree' }
  }

  const branchSha = await localBranchSha(dir, branch)
  // 基线一致性必须在**动手之前**判定：否则首次拒绝会留下 worktree，
  // 重试时 occupancy 变成 same 直接 alreadyExists，把「不静默复用」绕过（D1 回归点）。
  if (branchSha && branchSha !== baseSha) {
    return { ok: false, reason: 'base-mismatch', branch, branchSha, baseSha, baseBranch, worktreePath }
  }
  return { ok: true, branchExists: !!branchSha, branchSha, baseSha, worktreePath, branch }
}

/**
 * 创建工作区（分支 + worktree）。
 * ① 路径已存在且就是本分支 → 幂等跳过（alreadyExists）
 * ② 路径被其他分支占用，或存在同名普通目录 → path-occupied（调用方映射 409 WORKTREE_PATH_EXISTS）
 * ③ 分支不存在 → 从 baseBranch 的**当前最新提交**派生（这正是「以创建时刻为基」的语义）
 * ④ 分支已存在但 tip ≠ 基线 → base-mismatch，**在任何 git 写操作之前**返回，拒绝时零副作用
 */
export async function addWorktree(dir, { worktreePath, branch, baseBranch }) {
  const plan = await checkWorktreePlan(dir, { worktreePath, branch, baseBranch })
  if (!plan.ok) return { ...plan, worktreePath, branch }
  if (plan.alreadyExists) {
    return { ok: true, alreadyExists: true, worktreePath, branch, reason: 'already_exists' }
  }

  if (plan.branchExists) {
    const r = await gitTry(dir, ['worktree', 'add', worktreePath, branch])
    if (!r.ok) return { ok: false, reason: 'worktree-add-failed', message: String(r.stderr || '').slice(0, 1000) }
    return { ok: true, branchReused: true, branchSha: plan.branchSha, worktreePath, branch, reason: 'reused_branch' }
  }

  const r = await gitTry(dir, ['worktree', 'add', '-b', branch, worktreePath, baseBranch])
  if (!r.ok) return { ok: false, reason: 'worktree-add-failed', message: String(r.stderr || '').slice(0, 1000) }
  return { ok: true, created: true, branchSha: plan.baseSha, baseSha: plan.baseSha, worktreePath, branch, reason: 'created' }
}

/** 移除 worktree（不删分支）；未登记为 worktree 时按「已不存在」处理（幂等） */
export async function removeWorktree(dir, worktreePath) {
  const list = await listWorktrees(dir)
  if (!list.some((w) => samePath(w.path, worktreePath))) {
    return { ok: true, alreadyRemoved: true, worktreePath }
  }
  const r = await gitTry(dir, ['worktree', 'remove', worktreePath, '--force'])
  if (!r.ok) return { ok: false, reason: 'worktree-remove-failed', message: String(r.stderr || '').slice(0, 1000) }
  return { ok: true, removed: true, worktreePath }
}

/**
 * 删除本地分支，**相对声明的基线**判定是否已合并。
 *
 * 不能用 `git branch -d`：它比较的是「是否已并入当前 HEAD」，而清理时 HEAD 往往是
 * `main` 之类，与声明的基线分支无关。结果会**删掉未并入基线的开发分支**（真实数据丢失）——
 * 反过来「已并入基线但基线领先 HEAD」又会被保守拒绝。两种误判都源自这个隐式比较。
 * 因此这里显式用 `merge-base --is-ancestor <branch> <baseBranch>`，
 * 未并入基线一律不删（reason='branch-not-merged'），交由人工决定。
 */
export async function deleteLocalBranch(dir, branch, { baseBranch = null } = {}) {
  const exists = await localBranchSha(dir, branch)
  if (!exists) return { ok: true, alreadyRemoved: true, branch }
  if (!baseBranch) return { ok: false, reason: 'base-not-configured', branch }
  const merged = await gitTry(dir, ['merge-base', '--is-ancestor', branch, baseBranch])
  if (!merged.ok) {
    return {
      ok: false,
      reason: 'branch-not-merged',
      branch,
      baseBranch,
      message: String(merged.stderr || '').slice(0, 1000)
    }
  }
  // 已并入基线 → 用 -D 直接删（-d 在这里会拿 HEAD 再判一次，重新引入同一个坑）
  const r = await gitTry(dir, ['branch', '-D', branch])
  if (!r.ok) return { ok: false, reason: 'branch-delete-failed', message: String(r.stderr || '').slice(0, 1000) }
  return { ok: true, removed: true, branch, baseBranch }
}
