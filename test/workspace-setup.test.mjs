import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)
const CLI = path.resolve(import.meta.dirname, '../bin/taskboard.js')

/** 入口测试共用一个 HOME（config 在模块首次 import 时固定，换 HOME 不生效） */
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'taskboard-unit-home-'))
process.env.TASKBOARD_HOME = HOME
test.after(() => fs.rmSync(HOME, { recursive: true, force: true }))

/**
 * 真 git 仓库：`main`（HEAD）+ `feature-send-receive`（子需求基线）。
 *
 * **夹具要点：基线与 HEAD 必须停在不同提交**。
 * 早期版本的夹具让 HEAD(main)、基线、工作分支三者同一个 commit，
 * 于是 `git merge-base --is-ancestor <branch> <base>` 与 `git branch -d`
 * 拿 HEAD 比较的结果完全一致——「并入 HEAD 但未并入基线」这个真实场景
 * 在几何上无法被表达，D2（误删未合并分支）因此逃过了 376 条全绿用例。
 * 现在让基线领先 HEAD 一个提交，使二者可区分。
 */
function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'taskboard-unit-repo-'))
  const dir = path.join(root, 'work')
  fs.mkdirSync(dir)
  const g = (args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' })
  g(['init', '-q', '-b', 'main'])
  g(['config', 'user.email', 't@t.local'])
  g(['config', 'user.name', 't'])
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n')
  g(['add', '.'])
  g(['commit', '-q', '-m', 'init'])
  // 基线从 main 派生后继续前进 → 基线 tip ≠ HEAD(main) tip
  g(['checkout', '-q', '-b', 'feature-send-receive'])
  fs.writeFileSync(path.join(dir, 'baseline.txt'), 'baseline\n')
  g(['add', '.'])
  g(['commit', '-q', '-m', 'baseline work'])
  g(['checkout', '-q', 'main'])
  return { root, dir, g }
}

let repoSeq = 0

/** 建「项目→需求→子需求（branch=feature-send-receive）→任务（slug=login）」 */
function makeUnit(store, { repoPath, repoName } = {}) {
  // 入口测试共用同一个 HOME，仓库名必须逐次唯一，否则第二次 addRepo 会撞唯一约束
  const name = repoName || `unit-repo-${++repoSeq}`
  const p = store.createNode({ type: 'project', name: 'P' })
  const r = store.createNode({ parentId: p.id, type: 'requirement', name: 'R' })
  const s = store.createNode({ parentId: r.id, type: 'subreq', name: 'S' })
  store.setAttrs(s.id, { branch: 'feature-send-receive' })
  const t = store.createNode({ parentId: s.id, type: 'task', name: 'T' })
  store.setAttrs(t.id, { slug: 'login' })
  let repoRow = null
  if (repoPath) repoRow = store.addRepo({ name, localPath: repoPath })
  return { p, r, s, t, repoRow, repoName: name }
}

async function coreSetup({ withRepo = false } = {}) {
  const { openDb } = await import('../server/db.mjs')
  const { createStore } = await import('../server/store.mjs')
  const store = createStore(openDb())
  const repo = withRepo ? makeRepo() : null
  const unit = makeUnit(store, { repoPath: repo && repo.dir })
  // 注意：`repo` 是 git 仓库对象（含 .dir/.root），`repoRow` 是 store 里的仓库记录（含 .id）
  return { store, repo, ...unit }
}

// ---------- store：unit_repos CRUD ----------

test('store：登记 / 列出 / 更新 / 删除 unit_repo；按 node × repo 幂等', async (t) => {
  const { store, repo, repoRow, repoName, t: task } = await coreSetup({ withRepo: true })
  t.after(() => fs.rmSync(repo.root, { recursive: true, force: true }))

  const a = store.addUnitRepo(task.id, { repoId: repoRow.id })
  assert.equal(a.repoId, repoRow.id)
  assert.equal(a.repoName, repoName)

  // 幂等：同 node × repo 不新增
  const again = store.addUnitRepo(task.id, { repoId: repoRow.id })
  assert.equal(again.id, a.id)
  assert.equal(store.listUnitRepos(task.id).length, 1)

  // 只更新显式传入的字段（覆盖 vs 保留）
  const upd = store.updateUnitRepo(a.id, { branch: 'b1' })
  assert.equal(upd.branch, 'b1')
  assert.equal(upd.worktreePath, null)
  const upd2 = store.updateUnitRepo(a.id, { worktreePath: '/tmp/x' })
  assert.equal(upd2.branch, 'b1', '只传 worktreePath 不应清掉 branch')

  store.deleteUnitRepo(a.id)
  assert.equal(store.listUnitRepos(task.id).length, 0)
})

test('store：只有 group / task 能登记工作单元仓库（project / requirement / subreq 拒绝）', async (t) => {
  const { store, repo, repoRow, p, r, s } = await coreSetup({ withRepo: true })
  t.after(() => fs.rmSync(repo.root, { recursive: true, force: true }))
  for (const n of [p, r, s]) {
    assert.throws(
      () => store.addUnitRepo(n.id, { repoId: repoRow.id }),
      (e) => e.code === 'VALIDATION_FAILED' && e.details.allowed.includes('task')
    )
  }
})

test('store：未登记的 repoId → REPO_NOT_REGISTERED；缺 repoId → VALIDATION_FAILED', async (t) => {
  const { store, t: task } = await coreSetup()
  assert.throws(() => store.addUnitRepo(task.id, { repoId: 99999 }), /REPO_NOT_REGISTERED/)
  assert.throws(() => store.addUnitRepo(task.id, {}), /VALIDATION_FAILED/)
})

test('store：随节点级联删除（删任务后 unit_repos 一并清理）', async (t) => {
  const { store, repo, repoRow, t: task } = await coreSetup({ withRepo: true })
  t.after(() => fs.rmSync(repo.root, { recursive: true, force: true }))
  const repoCountBefore = store.listRepos().length
  store.addUnitRepo(task.id, { repoId: repoRow.id })
  store.deleteNode(task.id)
  assert.throws(() => store.listUnitRepos(task.id), /NOT_FOUND/)
  assert.equal(store.listRepos().length, repoCountBefore, '删节点不应误删仓库登记本身')
})

// ---------- ops：纯函数 ----------

test('ops：分支名渲染走 branchTemplate，slug 为空退回 n{id}', async () => {
  const { renderBranchName, renderWorktreePath } = await import('../server/ops.mjs')
  assert.equal(renderBranchName('{base_branch}-{slug}', { baseBranch: 'feature-x', slug: 'login', nodeId: 7 }), 'feature-x-login')
  assert.equal(renderBranchName('{base_branch}-{slug}', { baseBranch: 'feature-x', slug: '', nodeId: 7 }), 'feature-x-n7')
  assert.equal(renderBranchName('dev/{slug}', { baseBranch: 'ignored', slug: 'login', nodeId: 7 }), 'dev/login')
  assert.equal(renderBranchName(null, { baseBranch: 'b', slug: 's', nodeId: 1 }), 'b-s')
  assert.equal(renderWorktreePath('/repo/myrepo', '', 'login', 7), '/repo/myrepo-wt-login')
  assert.equal(renderWorktreePath('/repo/myrepo', '/wt-root', 'login', 7), '/wt-root/myrepo-wt-login')
})

// ---------- ops：setup / prompt / cleanup（真 git） ----------

test('ops setup：建出同名分支 + worktree，回填 unit_repos 与节点属性，返回开发提示词', async (t) => {
  const { store, repo, repoRow, t: task } = await coreSetup({ withRepo: true })
  t.after(() => fs.rmSync(repo.root, { recursive: true, force: true }))
  const { setupWorkspace } = await import('../server/ops.mjs')
  store.addUnitRepo(task.id, { repoId: repoRow.id })

  const out = await setupWorkspace(store, task.id, {})
  assert.equal(out.branch, 'feature-send-receive-login')
  assert.equal(out.baseBranch, 'feature-send-receive')
  assert.equal(out.repos.length, 1)
  assert.equal(out.repos[0].ok, true)
  assert.equal(fs.existsSync(out.repos[0].worktreePath), true, 'worktree 应真的建出来')

  // unit_repos 与节点属性都回填了
  const ur = store.listUnitRepos(task.id)[0]
  assert.equal(ur.branch, out.branch)
  assert.equal(ur.worktreePath, out.repos[0].worktreePath)
  const attrs = store.getAttrs(task.id)
  assert.equal(attrs.branch, out.branch)
  assert.equal(attrs.base_branch, 'feature-send-receive')

  // 提示词包含设计文档 §7.10 要求的要素
  assert.match(out.prompt, /工作分支：feature-send-receive-login/)
  assert.match(out.prompt, /基线分支：feature-send-receive/)
  assert.match(out.prompt, new RegExp(`id=${task.id}`))
  assert.match(out.prompt, /-wt-login/)
  assert.match(out.prompt, /commit add/)
  assert.match(out.prompt, /merge/)

  // 分支真的从基线当前 tip 派生（以创建时刻为准）
  const g = (a) => execFileSync('git', ['-C', repo.dir, ...a], { encoding: 'utf8' }).trim()
  assert.equal(g(['rev-parse', out.branch]), g(['rev-parse', 'feature-send-receive']))
})

test('ops setup：重复调用幂等（同分支同路径跳过，不报错）', async (t) => {
  const { store, repo, repoRow, t: task } = await coreSetup({ withRepo: true })
  t.after(() => fs.rmSync(repo.root, { recursive: true, force: true }))
  const { setupWorkspace } = await import('../server/ops.mjs')
  store.addUnitRepo(task.id, { repoId: repoRow.id })

  const first = await setupWorkspace(store, task.id, {})
  assert.equal(first.repos[0].created, true)
  const second = await setupWorkspace(store, task.id, {})
  assert.equal(second.repos[0].alreadyExists, true)
  assert.equal(second.branch, first.branch)
})

test('ops setup：dryRun 只做规划——不碰 git、不落库', async (t) => {
  const { store, repo, repoRow, t: task } = await coreSetup({ withRepo: true })
  t.after(() => fs.rmSync(repo.root, { recursive: true, force: true }))
  const { setupWorkspace } = await import('../server/ops.mjs')
  store.addUnitRepo(task.id, { repoId: repoRow.id })
  const before = store.getRevision()

  const out = await setupWorkspace(store, task.id, { dryRun: true })
  assert.equal(out.dryRun, true)
  assert.equal(out.branch, 'feature-send-receive-login')
  assert.equal(out.repos[0].planned, true)
  assert.equal(fs.existsSync(out.repos[0].worktreePath), false, 'dryRun 不得真的建 worktree')
  assert.equal(store.getAttrs(task.id).branch, undefined, 'dryRun 不得回填属性')
  assert.equal(store.getRevision(), before, 'dryRun 不得产生 revision 变更')
})

test('ops setup：worktree 路径被其他分支占用 → WORKTREE_PATH_EXISTS', async (t) => {
  const { store, repo, repoRow, t: task } = await coreSetup({ withRepo: true })
  t.after(() => fs.rmSync(repo.root, { recursive: true, force: true }))
  const { setupWorkspace } = await import('../server/ops.mjs')
  const { addWorktree } = await import('../server/git.mjs')

  const wp = path.join(repo.root, 'work-wt-login')
  const occupied = await addWorktree(repo.dir, { worktreePath: wp, branch: 'someone-else', baseBranch: 'feature-send-receive' })
  assert.equal(occupied.ok, true)
  store.addUnitRepo(task.id, { repoId: repoRow.id, worktreePath: wp })

  await assert.rejects(setupWorkspace(store, task.id, {}), (e) => {
    assert.equal(e.code, 'WORKTREE_PATH_EXISTS')
    assert.equal(e.details.worktreePath, wp)
    return true
  })
})

test('ops setup：基线分支不存在 → BRANCH_NOT_FOUND', async (t) => {
  const { store, repo, repoRow, s, t: task } = await coreSetup({ withRepo: true })
  t.after(() => fs.rmSync(repo.root, { recursive: true, force: true }))
  const { setupWorkspace } = await import('../server/ops.mjs')
  store.setAttrs(s.id, { branch: 'no-such-branch' })
  store.addUnitRepo(task.id, { repoId: repoRow.id })
  await assert.rejects(setupWorkspace(store, task.id, {}), (e) => e.code === 'BRANCH_NOT_FOUND')
})

test('ops setup：分支已存在但基线不同 → BRANCH_EXISTS_DIFFERENT_BASE（不静默复用）', async (t) => {
  const { store, repo, repoRow, t: task } = await coreSetup({ withRepo: true })
  t.after(() => fs.rmSync(repo.root, { recursive: true, force: true }))
  const { setupWorkspace } = await import('../server/ops.mjs')
  // 夹具里基线已领先 HEAD；再造一个同名但基于 main 的分支（与基线不同源）
  repo.g(['branch', 'feature-send-receive-login', 'main'])
  store.addUnitRepo(task.id, { repoId: repoRow.id })

  await assert.rejects(setupWorkspace(store, task.id, {}), (e) => {
    assert.equal(e.code, 'BRANCH_EXISTS_DIFFERENT_BASE')
    assert.equal(e.details.baseBranch, 'feature-send-receive')
    return true
  })
})

test('ops setup：基线不符时**拒绝且零副作用**，且重试仍拒绝（D1 回归）', async (t) => {
  const { store, repo, repoRow, t: task } = await coreSetup({ withRepo: true })
  t.after(() => fs.rmSync(repo.root, { recursive: true, force: true }))
  const { setupWorkspace } = await import('../server/ops.mjs')
  const { listWorktrees } = await import('../server/git.mjs')
  const wt = path.join(repo.root, 'work-wt-login')
  repo.g(['branch', 'feature-send-receive-login', 'main'])
  store.addUnitRepo(task.id, { repoId: repoRow.id })
  const revBefore = store.getRevision()

  // 首次：必须拒绝
  await assert.rejects(setupWorkspace(store, task.id, {}), (e) => e.code === 'BRANCH_EXISTS_DIFFERENT_BASE')
  // 关键：拒绝不得留下任何副作用——否则重试时 occupancy 变 same、直接 alreadyExists，把保证绕过
  assert.equal(fs.existsSync(wt), false, '拒绝时不得把 worktree 建出来')
  assert.equal((await listWorktrees(repo.dir)).some((w) => w.path.endsWith('work-wt-login')), false)
  assert.equal(store.getAttrs(task.id).branch, undefined, '拒绝时不得回填 branch 属性')
  assert.equal(store.getRevision(), revBefore, '拒绝时不得产生 revision 变更')

  // 重试：仍必须拒绝（旧实现第二次会 200 alreadyExists=true 并回填错误基线）
  await assert.rejects(setupWorkspace(store, task.id, {}), (e) => e.code === 'BRANCH_EXISTS_DIFFERENT_BASE')
  assert.equal(store.getAttrs(task.id).branch, undefined, '重试也不得回填 branch 属性')
})

test('ops setup：dryRun 能探明路径占用与基线不符，且仍零副作用（D4 回归）', async (t) => {
  const { store, repo, repoRow, t: task } = await coreSetup({ withRepo: true })
  t.after(() => fs.rmSync(repo.root, { recursive: true, force: true }))
  const { setupWorkspace } = await import('../server/ops.mjs')
  const { addWorktree } = await import('../server/git.mjs')
  const wt = path.join(repo.root, 'work-wt-login')

  // ① 路径被其他分支占用 → dryRun 应报出冲突，而不是乐观 ok:true
  await addWorktree(repo.dir, { worktreePath: wt, branch: 'someone-else', baseBranch: 'feature-send-receive' })
  store.addUnitRepo(task.id, { repoId: repoRow.id, worktreePath: wt })
  const occupied = await setupWorkspace(store, task.id, { dryRun: true })
  assert.equal(occupied.repos[0].ok, false)
  assert.equal(occupied.repos[0].reason, 'path-occupied')

  // ② 同名分支基线不符 → dryRun 也报出来
  const s2 = await coreSetup({ withRepo: true })
  t.after(() => fs.rmSync(s2.repo.root, { recursive: true, force: true }))
  s2.repo.g(['branch', 'feature-send-receive-login', 'main'])
  s2.store.addUnitRepo(s2.t.id, { repoId: s2.repoRow.id })
  const mismatch = await setupWorkspace(s2.store, s2.t.id, { dryRun: true })
  assert.equal(mismatch.repos[0].ok, false)
  assert.equal(mismatch.repos[0].reason, 'base-mismatch')

  // ③ dryRun 仍然零副作用
  assert.equal(fs.existsSync(path.join(s2.repo.root, 'work-wt-login')), false)
  assert.equal(s2.store.getAttrs(s2.t.id).branch, undefined)
})

test('ops setup：纯 no-op 重复调用不再 +1 revision（D5 回归）', async (t) => {
  const { store, repo, repoRow, t: task } = await coreSetup({ withRepo: true })
  t.after(() => fs.rmSync(repo.root, { recursive: true, force: true }))
  const { setupWorkspace } = await import('../server/ops.mjs')
  store.addUnitRepo(task.id, { repoId: repoRow.id })
  await setupWorkspace(store, task.id, {})
  const after1 = store.getRevision()
  const again = await setupWorkspace(store, task.id, {})
  assert.equal(again.repos[0].alreadyExists, true)
  assert.equal(store.getRevision(), after1, '完全相同的重复 setup 不应制造 revision 噪声')
})

test('ops setup：分支已存在但正是基线本身 → 允许复用（不算基线不符）', async (t) => {
  const { store, repo, repoRow, t: task } = await coreSetup({ withRepo: true })
  t.after(() => fs.rmSync(repo.root, { recursive: true, force: true }))
  const { setupWorkspace } = await import('../server/ops.mjs')
  // 预先把分支建在与基线相同的提交上 → 复用是安全的
  repo.g(['branch', 'feature-send-receive-login', 'feature-send-receive'])
  store.addUnitRepo(task.id, { repoId: repoRow.id })

  const out = await setupWorkspace(store, task.id, {})
  assert.equal(out.repos[0].branchReused, true)
  assert.equal(out.repos[0].ok, true)
})

test('ops setup：未登记仓库 / 非工作单元类型 → VALIDATION_FAILED', async (t) => {
  const { store, s, t: task } = await coreSetup()
  const { setupWorkspace } = await import('../server/ops.mjs')
  await assert.rejects(setupWorkspace(store, task.id, {}), (e) => e.code === 'VALIDATION_FAILED')
  await assert.rejects(setupWorkspace(store, s.id, {}), (e) => e.code === 'VALIDATION_FAILED')
})

test('ops setup：repoIds 过滤只对选中仓库建工作区；不在列表里的 → 拒绝', async (t) => {
  const { store, repo, repoRow, t: task } = await coreSetup({ withRepo: true })
  t.after(() => fs.rmSync(repo.root, { recursive: true, force: true }))
  const { setupWorkspace } = await import('../server/ops.mjs')
  const repo2 = makeRepo()
  t.after(() => fs.rmSync(repo2.root, { recursive: true, force: true }))
  store.addRepo({ name: 'second', localPath: repo2.dir })
  const r2 = store.listRepos().find((r) => r.name === 'second')
  store.addUnitRepo(task.id, { repoId: repoRow.id })
  store.addUnitRepo(task.id, { repoId: r2.id })

  const out = await setupWorkspace(store, task.id, { repoIds: [repoRow.id] })
  assert.equal(out.repos.length, 1)
  assert.equal(out.repos[0].repoId, repoRow.id)

  await assert.rejects(setupWorkspace(store, task.id, { repoIds: [99999] }), (e) => e.code === 'VALIDATION_FAILED')
})

test('ops prompt：纯读生成开发提示词，不碰 git、不动 revision', async (t) => {
  const { store, repo, repoRow, t: task } = await coreSetup({ withRepo: true })
  t.after(() => fs.rmSync(repo.root, { recursive: true, force: true }))
  const { setupWorkspace, getWorkspacePrompt } = await import('../server/ops.mjs')
  store.addUnitRepo(task.id, { repoId: repoRow.id })
  await setupWorkspace(store, task.id, {})
  const rev = store.getRevision()

  const out = getWorkspacePrompt(store, task.id)
  assert.equal(out.branch, 'feature-send-receive-login')
  assert.match(out.prompt, /工作分支/)
  assert.match(out.prompt, /-wt-login/)
  assert.equal(store.getRevision(), rev, 'prompt 是纯读，不得改 revision')
})

test('ops cleanup：移除 worktree 并删除已并入基线的分支；需 confirm', async (t) => {
  const { store, repo, repoRow, t: task } = await coreSetup({ withRepo: true })
  t.after(() => fs.rmSync(repo.root, { recursive: true, force: true }))
  const { setupWorkspace, cleanupWorkspace } = await import('../server/ops.mjs')
  store.addUnitRepo(task.id, { repoId: repoRow.id })
  const out = await setupWorkspace(store, task.id, {})
  const wt = out.repos[0].worktreePath

  await assert.rejects(cleanupWorkspace(store, task.id, {}), (e) => e.code === 'CONFIRM_REQUIRED')

  const cl = await cleanupWorkspace(store, task.id, { confirm: true })
  assert.equal(cl.results[0].ok, true)
  assert.equal(cl.results[0].worktreeRemoved, true)
  assert.equal(fs.existsSync(wt), false, 'worktree 应被移除')
  assert.equal(cl.results[0].branchRemoved, true, '已并入基线的分支应被删除')
  assert.equal(store.listUnitRepos(task.id)[0].worktreePath, null)
})

test('ops cleanup：未并入基线的分支不被删除（保留开发成果）', async (t) => {
  const { store, repo, repoRow, t: task } = await coreSetup({ withRepo: true })
  t.after(() => fs.rmSync(repo.root, { recursive: true, force: true }))
  const { setupWorkspace, cleanupWorkspace } = await import('../server/ops.mjs')
  store.addUnitRepo(task.id, { repoId: repoRow.id })
  const out = await setupWorkspace(store, task.id, {})
  // 在工作区分支上补一个提交 → 不再等于基线 → git branch -d 会拒绝删除
  const wt = out.repos[0].worktreePath
  execFileSync('git', ['-C', wt, 'config', 'user.email', 't@t.local'])
  execFileSync('git', ['-C', wt, 'config', 'user.name', 't'])
  fs.writeFileSync(path.join(wt, 'b.txt'), 'b\n')
  execFileSync('git', ['-C', wt, 'add', '.'])
  execFileSync('git', ['-C', wt, 'commit', '-q', '-m', 'work'])

  const cl = await cleanupWorkspace(store, task.id, { confirm: true })
  assert.equal(cl.results[0].worktreeRemoved, true)
  assert.equal(cl.results[0].branchRemoved, false)
  assert.equal(cl.results[0].branchNote, 'branch-not-merged')
  const g = (a) => execFileSync('git', ['-C', repo.dir, ...a], { encoding: 'utf8' }).trim()
  assert.ok(g(['branch', '--list', out.branch]), '未合并分支必须保留')
})

test('ops cleanup：分支并入 HEAD 但**未并入基线**时必须保留（D2 回归，夹具 HEAD≠基线）', async (t) => {
  const { store, repo, repoRow, t: task } = await coreSetup({ withRepo: true })
  t.after(() => fs.rmSync(repo.root, { recursive: true, force: true }))
  const { cleanupWorkspace } = await import('../server/ops.mjs')
  const g = (a) => execFileSync('git', ['-C', repo.dir, ...a], { encoding: 'utf8' }).trim()
  const isAncestor = (a, b) => {
    try {
      g(['merge-base', '--is-ancestor', a, b])
      return true
    } catch {
      return false
    }
  }

  // 开发分支基于 HEAD(main) 的新提交 → 已并入 HEAD，但**不在**基线 feature-send-receive 上
  repo.g(['checkout', '-q', 'main'])
  fs.writeFileSync(path.join(repo.dir, 'dev.txt'), 'd\n')
  repo.g(['add', '.'])
  repo.g(['commit', '-q', '-m', 'dev work'])
  repo.g(['branch', 'feature-send-receive-login'])

  // 前置断言：夹具确实构造成「并入 HEAD、未并入基线」，否则这条用例没有保护力
  assert.equal(isAncestor('feature-send-receive-login', 'main'), true, '夹具：分支应已并入 HEAD')
  assert.equal(isAncestor('feature-send-receive-login', 'feature-send-receive'), false, '夹具：分支不应并入基线')

  store.setAttrs(task.id, { slug: 'login', branch: 'feature-send-receive-login', base_branch: 'feature-send-receive' })
  store.addUnitRepo(task.id, { repoId: repoRow.id })

  const cl = await cleanupWorkspace(store, task.id, { confirm: true })
  assert.equal(cl.results[0].branchRemoved, false, '未并入基线的分支不得被删除（旧的 -d 会因已并入 HEAD 而误删）')
  assert.equal(cl.results[0].branchNote, 'branch-not-merged')
  assert.ok(g(['branch', '--list', 'feature-send-receive-login']), '分支必须保留')
})

test('ops cleanup：分支已并入基线但基线领先 HEAD 时正常删除（不保守泄漏）', async (t) => {
  const { store, repo, repoRow, t: task } = await coreSetup({ withRepo: true })
  t.after(() => fs.rmSync(repo.root, { recursive: true, force: true }))
  const { cleanupWorkspace } = await import('../server/ops.mjs')
  const g = (a) => execFileSync('git', ['-C', repo.dir, ...a], { encoding: 'utf8' }).trim()
  const isAncestor = (a, b) => {
    try {
      g(['merge-base', '--is-ancestor', a, b])
      return true
    } catch {
      return false
    }
  }

  // dev 从 main 派生 → 合入基线 feature-send-receive → 基线再前进（于是基线领先 HEAD）
  repo.g(['checkout', '-q', '-b', 'dev', 'main'])
  fs.writeFileSync(path.join(repo.dir, 'dev.txt'), 'd\n')
  repo.g(['add', '.'])
  repo.g(['commit', '-q', '-m', 'dev work'])
  repo.g(['checkout', '-q', 'feature-send-receive'])
  repo.g(['merge', '-q', '--no-ff', '-m', 'merge dev', 'dev'])
  repo.g(['checkout', '-q', 'main'])

  assert.equal(isAncestor('dev', 'feature-send-receive'), true, '夹具：分支应已并入基线')
  assert.equal(isAncestor('dev', 'main'), false, '夹具：分支不应并入 HEAD（否则退化成旧夹具）')

  store.setAttrs(task.id, { slug: 'x', branch: 'dev', base_branch: 'feature-send-receive' })
  store.addUnitRepo(task.id, { repoId: repoRow.id })
  const cl = await cleanupWorkspace(store, task.id, { confirm: true })
  assert.equal(cl.results[0].branchRemoved, true, '已并入基线就该删（旧的 -d 会因 HEAD 不含它而保守保留）')
  assert.equal(g(['branch', '--list', 'dev']), '', '分支应已删除')
})

test('ops cleanup：重复调用幂等；一次 cleanup 只 +1 revision（组合写入）', async (t) => {
  const { store, repo, repoRow, t: task } = await coreSetup({ withRepo: true })
  t.after(() => fs.rmSync(repo.root, { recursive: true, force: true }))
  const { setupWorkspace, cleanupWorkspace } = await import('../server/ops.mjs')
  store.addUnitRepo(task.id, { repoId: repoRow.id })
  await setupWorkspace(store, task.id, {})
  const before = store.getRevision()
  await cleanupWorkspace(store, task.id, { confirm: true })
  assert.equal(store.getRevision() - before, 1, '一次 cleanup = 一次 revision 递增')

  const again = await cleanupWorkspace(store, task.id, { confirm: true })
  assert.equal(again.results[0].ok, true)
  assert.equal(again.results[0].worktreeAlreadyRemoved, true)
})

// ---------- 三入口 1:1 ----------

async function entrySetup() {
  const { openDb } = await import('../server/db.mjs')
  const { createStore } = await import('../server/store.mjs')
  const { createApp } = await import('../server/http.mjs')
  const { createMcpServer } = await import('../server/mcp.mjs')
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js')

  const repo = makeRepo()
  const store = createStore(openDb())
  const unit = makeUnit(store, { repoPath: repo.dir })

  const app = createApp({ store })
  const server = await new Promise((resolve, reject) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s))
    s.once('error', reject)
  })
  const base = `http://127.0.0.1:${server.address().port}`

  const mcpServer = createMcpServer({ store })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await mcpServer.connect(serverTransport)
  const client = new Client({ name: 'taskboard-unit-test', version: '1.0.0' })
  await client.connect(clientTransport)

  return {
    store,
    repo,
    ...unit,
    base,
    http: async (method, p, body) => {
      const r = await fetch(`${base}${p}`, {
        method,
        headers: { 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      })
      return { status: r.status, body: await r.json() }
    },
    mcp: (name, args) => client.callTool({ name, arguments: args }),
    mcpTools: async () => (await client.listTools()).tools.map((x) => x.name),
    cli: (args) => execFileP('node', [CLI, ...args], { env: { ...process.env, TASKBOARD_HOME: HOME } }),
    cleanup: async () => {
      await client.close()
      await mcpServer.close()
      await new Promise((r) => server.close(r))
      fs.rmSync(repo.root, { recursive: true, force: true })
    }
  }
}

test('HTTP：unit-repos CRUD + setup(dryRun) + prompt + cleanup(需 confirm)', async (t) => {
  const s = await entrySetup()
  t.after(() => s.cleanup())

  const add = await s.http('POST', `/api/nodes/${s.t.id}/unit-repos`, { repoId: s.repoRow.id })
  assert.equal(add.status, 201)
  assert.equal(add.body.repoName, s.repoName)

  const list = await s.http('GET', `/api/nodes/${s.t.id}/unit-repos`)
  assert.equal(list.body.length, 1)

  const dry = await s.http('POST', `/api/nodes/${s.t.id}/setup`, { dryRun: true })
  assert.equal(dry.body.dryRun, true)
  assert.equal(dry.body.branch, 'feature-send-receive-login')

  const prompt = await s.http('GET', `/api/nodes/${s.t.id}/prompt`)
  assert.match(prompt.body.prompt, /工作分支/)

  const noConfirm = await s.http('POST', `/api/nodes/${s.t.id}/cleanup`, {})
  assert.equal(noConfirm.status, 400)
  assert.equal(noConfirm.body.error.code, 'CONFIRM_REQUIRED')

  const del = await s.http('DELETE', `/api/unit-repos/${add.body.id}`)
  assert.equal(del.body.id, add.body.id)
  assert.equal((await s.http('GET', `/api/nodes/${s.t.id}/unit-repos`)).body.length, 0)
})

test('HTTP：非工作单元类型 → 400 VALIDATION_FAILED；未登记仓库 → 400 REPO_NOT_REGISTERED', async (t) => {
  const s = await entrySetup()
  t.after(() => s.cleanup())
  const badType = await s.http('POST', `/api/nodes/${s.s.id}/unit-repos`, { repoId: s.repoRow.id })
  assert.equal(badType.status, 400)
  assert.equal(badType.body.error.code, 'VALIDATION_FAILED')

  const badRepo = await s.http('POST', `/api/nodes/${s.t.id}/unit-repos`, { repoId: 99999 })
  assert.equal(badRepo.status, 400)
  assert.equal(badRepo.body.error.code, 'REPO_NOT_REGISTERED')
})

test('HTTP：worktree 路径占用 → 409 WORKTREE_PATH_EXISTS；基线缺失 → 400 BRANCH_NOT_FOUND', async (t) => {
  const s = await entrySetup()
  t.after(() => s.cleanup())
  const { addWorktree } = await import('../server/git.mjs')
  const wp = path.join(s.repo.root, 'work-wt-login')
  await addWorktree(s.repo.dir, { worktreePath: wp, branch: 'other-branch', baseBranch: 'feature-send-receive' })
  await s.http('POST', `/api/nodes/${s.t.id}/unit-repos`, { repoId: s.repoRow.id, worktreePath: wp })
  const conflict = await s.http('POST', `/api/nodes/${s.t.id}/setup`, {})
  assert.equal(conflict.status, 409)
  assert.equal(conflict.body.error.code, 'WORKTREE_PATH_EXISTS')

  const s2 = await entrySetup()
  t.after(() => s2.cleanup())
  s2.store.setAttrs(s2.s.id, { branch: 'nope-branch' })
  await s2.http('POST', `/api/nodes/${s2.t.id}/unit-repos`, { repoId: s2.repoRow.id })
  const noBase = await s2.http('POST', `/api/nodes/${s2.t.id}/setup`, {})
  assert.equal(noBase.status, 400)
  assert.equal(noBase.body.error.code, 'BRANCH_NOT_FOUND')
})

test('MCP：unit_* 工具注册进能力清单；setup/prompt/cleanup 与 store 一致且错误走 isError', async (t) => {
  const s = await entrySetup()
  t.after(() => s.cleanup())

  const tools = await s.mcpTools()
  for (const name of ['unit_repo_list', 'unit_repo_add', 'unit_repo_remove', 'unit_setup', 'unit_prompt', 'unit_cleanup']) {
    assert.ok(tools.includes(name), `${name} 应注册`)
  }
  const schema = await s.mcp('schema', {})
  for (const name of ['unit_setup', 'unit_prompt', 'unit_cleanup']) {
    assert.match(schema.content[0].text, new RegExp(name), '能力清单应登记')
  }

  const add = await s.mcp('unit_repo_add', { node: s.t.id, repoId: s.repoRow.id })
  assert.ok(!add.isError)
  const urId = JSON.parse(add.content[0].text).id

  const list = await s.mcp('unit_repo_list', { node: s.t.id })
  assert.equal(JSON.parse(list.content[0].text).length, 1)

  const setup = await s.mcp('unit_setup', { node: s.t.id, dryRun: true })
  assert.equal(JSON.parse(setup.content[0].text).branch, 'feature-send-receive-login')

  const prompt = await s.mcp('unit_prompt', { node: s.t.id })
  assert.match(JSON.parse(prompt.content[0].text).prompt, /工作分支/)

  // 缺 confirm 是业务错误 → isError + 稳定码（不泄漏 SDK 协议错误）
  const noConfirm = await s.mcp('unit_cleanup', { node: s.t.id })
  assert.equal(noConfirm.isError, true)
  assert.match(noConfirm.content[0].text, /CONFIRM_REQUIRED/)
  assert.doesNotMatch(noConfirm.content[0].text, /-32602/)

  const rm = await s.mcp('unit_repo_remove', { id: urId })
  assert.ok(!rm.isError)
})

test('CLI：unit repo add/list/remove + setup/prompt/cleanup 全链路（含错误码）', async (t) => {
  const s = await entrySetup()
  t.after(() => s.cleanup())

  const add = await s.cli(['unit', 'repo', 'add', String(s.t.id), '--repo-id', String(s.repoRow.id)])
  assert.equal(JSON.parse(add.stdout).repoName, s.repoName)

  const list = await s.cli(['unit', 'repo', 'list', String(s.t.id)])
  assert.equal(JSON.parse(list.stdout).length, 1)

  const dry = await s.cli(['unit', 'setup', String(s.t.id), '--dry-run'])
  assert.equal(JSON.parse(dry.stdout).branch, 'feature-send-receive-login')

  const real = JSON.parse((await s.cli(['unit', 'setup', String(s.t.id)])).stdout)
  assert.equal(real.repos[0].created, true)

  const prompt = JSON.parse((await s.cli(['unit', 'prompt', String(s.t.id)])).stdout)
  assert.match(prompt.prompt, /工作分支/)

  await assert.rejects(s.cli(['unit', 'cleanup', String(s.t.id)]), (e) => {
    assert.match(String(e.stderr || e.message), /CONFIRM_REQUIRED/)
    return true
  })

  const cl = JSON.parse((await s.cli(['unit', 'cleanup', String(s.t.id), '--confirm'])).stdout)
  assert.equal(cl.results[0].ok, true)
  assert.equal(cl.results[0].worktreeRemoved, true)

  const urId = JSON.parse((await s.cli(['unit', 'repo', 'list', String(s.t.id)])).stdout)[0].id
  const rm = JSON.parse((await s.cli(['unit', 'repo', 'remove', String(urId)])).stdout)
  assert.equal(rm.id, urId)
})

test('CLI：--keep-branch 真正保留分支（D3 回归，旧写法 --remove-branch false 恒失效）', async (t) => {
  const s = await entrySetup()
  t.after(() => s.cleanup())
  await s.cli(['unit', 'repo', 'add', String(s.t.id), '--repo-id', String(s.repoRow.id)])
  await s.cli(['unit', 'setup', String(s.t.id)])

  const out = JSON.parse((await s.cli(['unit', 'cleanup', String(s.t.id), '--confirm', '--keep-branch'])).stdout)
  assert.equal(out.removeBranch, false, 'CLI 应把「保留分支」意图透传下去')
  assert.equal(out.results[0].branchRemoved, false)
  // 分支必须真的还在
  const g = (a) => execFileSync('git', ['-C', s.repo.dir, ...a], { encoding: 'utf8' }).trim()
  assert.ok(g(['branch', '--list', 'feature-send-receive-login']), '--keep-branch 必须保留分支')
})

test('CLI / HTTP / MCP：removeBranch 语义一致（默认删、显式保留则不删）', async (t) => {
  // HTTP：removeBranch:false 保留分支
  const h = await entrySetup()
  t.after(() => h.cleanup())
  await h.http('POST', `/api/nodes/${h.t.id}/unit-repos`, { repoId: h.repoRow.id })
  await h.http('POST', `/api/nodes/${h.t.id}/setup`, {})
  const httpKeep = await h.http('POST', `/api/nodes/${h.t.id}/cleanup`, { confirm: true, removeBranch: false })
  assert.equal(httpKeep.body.results[0].branchRemoved, false)

  // MCP：removeBranch:false 保留分支
  const m = await entrySetup()
  t.after(() => m.cleanup())
  await m.mcp('unit_repo_add', { node: m.t.id, repoId: m.repoRow.id })
  await m.mcp('unit_setup', { node: m.t.id })
  const mcpKeep = JSON.parse((await m.mcp('unit_cleanup', { node: m.t.id, confirm: true, removeBranch: false })).content[0].text)
  assert.equal(mcpKeep.results[0].branchRemoved, false)
})

test('三入口一致：同一条链在 HTTP / CLI / MCP 上得到相同的分支名与落盘路径', async (t) => {
  const s = await entrySetup()
  t.after(() => s.cleanup())
  await s.http('POST', `/api/nodes/${s.t.id}/unit-repos`, { repoId: s.repoRow.id })

  const viaHttp = await s.http('POST', `/api/nodes/${s.t.id}/setup`, { dryRun: true })
  const viaCli = JSON.parse((await s.cli(['unit', 'setup', String(s.t.id), '--dry-run'])).stdout)
  const viaMcp = JSON.parse((await s.mcp('unit_setup', { node: s.t.id, dryRun: true })).content[0].text)

  for (const out of [viaHttp.body, viaCli, viaMcp]) {
    assert.equal(out.branch, 'feature-send-receive-login')
    assert.equal(out.baseBranch, 'feature-send-receive')
    assert.equal(out.repos.length, 1)
    assert.match(out.repos[0].worktreePath, /-wt-login$/)
  }
  assert.equal(viaHttp.body.repos[0].worktreePath, viaCli.repos[0].worktreePath)
  assert.equal(viaCli.repos[0].worktreePath, viaMcp.repos[0].worktreePath)
})
