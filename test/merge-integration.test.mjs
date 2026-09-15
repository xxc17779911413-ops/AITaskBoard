import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { tempHome } from './helpers.mjs'

let repoSeq = 0
const execFileP = promisify(execFile)
const CLI = path.resolve(import.meta.dirname, '../bin/taskboard.js')

function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'taskboard-merge-'))
  const dir = path.join(root, 'work')
  fs.mkdirSync(dir)
  const g = (args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' })
  g(['init', '-q', '-b', 'main'])
  g(['config', 'user.email', 't@t.local'])
  g(['config', 'user.name', 't'])
  fs.writeFileSync(path.join(dir, 'a.txt'), 'base\n')
  g(['add', '.'])
  g(['commit', '-q', '-m', 'init'])
  g(['checkout', '-q', '-b', 'feature-send-receive'])
  fs.writeFileSync(path.join(dir, 'base.txt'), 'baseline\n')
  g(['add', '.'])
  g(['commit', '-q', '-m', 'baseline'])
  g(['checkout', '-q', '-b', 'feature-send-receive-login'])
  fs.writeFileSync(path.join(dir, 'login.txt'), 'login\n')
  g(['add', '.'])
  g(['commit', '-q', '-m', 'feat(login): work'])
  g(['checkout', '-q', 'feature-send-receive'])
  return { root, dir, g }
}

async function setup({ withRepo = true } = {}) {
  const tmp = await tempHome()
  const { createStore } = await import('../server/store.mjs')
  const store = createStore(tmp.openDb())
  const repo = withRepo ? makeRepo() : null
  const p = store.createNode({ type: 'project', name: 'P' })
  const r = store.createNode({ parentId: p.id, type: 'requirement', name: 'R' })
  const s = store.createNode({ parentId: r.id, type: 'subreq', name: 'S' })
  store.setAttrs(s.id, { branch: 'feature-send-receive' })
  const task = store.createNode({ parentId: s.id, type: 'task', name: 'T' })
  store.setAttrs(task.id, { slug: 'login', branch: 'feature-send-receive-login', base_branch: 'feature-send-receive' })
  let repoRow = null
  if (repo) {
    repoRow = store.addRepo({ name: `demo-${++repoSeq}`, localPath: repo.dir })
    store.addUnitRepo(task.id, { repoId: repoRow.id, branch: 'feature-send-receive-login', worktreePath: null })
  }
  const ops = await import('../server/ops.mjs')
  return { tmp, store, ops, repo, repoRow, p, r, s, task }
}

async function entrySetup() {
  const tmp = await tempHome()
  const { createStore } = await import('../server/store.mjs')
  const { createApp } = await import('../server/http.mjs')
  const { createMcpServer } = await import('../server/mcp.mjs')
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js')

  const repo = makeRepo()
  const store = createStore(tmp.openDb())
  const p = store.createNode({ type: 'project', name: 'P' })
  const r = store.createNode({ parentId: p.id, type: 'requirement', name: 'R' })
  const s = store.createNode({ parentId: r.id, type: 'subreq', name: 'S' })
  store.setAttrs(s.id, { branch: 'feature-send-receive' })
  const task = store.createNode({ parentId: s.id, type: 'task', name: 'T' })
  store.setAttrs(task.id, { slug: 'login', branch: 'feature-send-receive-login', base_branch: 'feature-send-receive' })
  const repoRow = store.addRepo({ name: `demo-${++repoSeq}`, localPath: repo.dir })
  store.addUnitRepo(task.id, { repoId: repoRow.id, branch: 'feature-send-receive-login', worktreePath: null })

  const app = createApp({ store })
  const server = await new Promise((resolve, reject) => {
    const srv = app.listen(0, '127.0.0.1', () => resolve(srv))
    srv.once('error', reject)
  })
  const base = `http://127.0.0.1:${server.address().port}`

  const mcpServer = createMcpServer({ store })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await mcpServer.connect(serverTransport)
  const client = new Client({ name: 'taskboard-merge-test', version: '1.0.0' })
  await client.connect(clientTransport)

  return {
    tmp,
    store,
    repo,
    repoRow,
    s,
    task,
    base,
    http: async (method, pth, body) => {
      const res = await fetch(`${base}${pth}`, {
        method,
        headers: { 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      })
      return { status: res.status, body: await res.json() }
    },
    mcp: (name, args) => client.callTool({ name, arguments: args }),
    mcpTools: async () => (await client.listTools()).tools.map((x) => x.name),
    cli: (args) => execFileP('node', [CLI, ...args], { env: { ...process.env, TASKBOARD_HOME: tmp.dir } }),
    cleanup: async () => {
      await client.close()
      await mcpServer.close()
      await new Promise((resolve) => server.close(resolve))
      tmp.cleanup()
      fs.rmSync(repo.root, { recursive: true, force: true })
    }
  }
}

function makeConflict(repo) {
  repo.g(['checkout', '-q', 'feature-send-receive'])
  fs.writeFileSync(path.join(repo.dir, 'a.txt'), 'target\n')
  repo.g(['add', '.'])
  repo.g(['commit', '-q', '-m', 'target change'])
  repo.g(['checkout', '-q', 'feature-send-receive-login'])
  fs.writeFileSync(path.join(repo.dir, 'a.txt'), 'source\n')
  repo.g(['add', '.'])
  repo.g(['commit', '-q', '-m', 'source change'])
}

function makeNamedConflict(repo, name) {
  fs.writeFileSync(path.join(repo.dir, name), 'base\n')
  repo.g(['add', '.'])
  repo.g(['commit', '-q', '-m', `base ${name}`])
  repo.g(['checkout', '-q', 'feature-send-receive'])
  fs.writeFileSync(path.join(repo.dir, name), 'target\n')
  repo.g(['add', '.'])
  repo.g(['commit', '-q', '-m', `target ${name}`])
  repo.g(['checkout', '-q', 'feature-send-receive-login'])
  fs.writeFileSync(path.join(repo.dir, name), 'source\n')
  repo.g(['add', '.'])
  repo.g(['commit', '-q', '-m', `source ${name}`])
}

function makeNestedConflict(repo, relPath) {
  const abs = path.join(repo.dir, relPath)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, 'base\n')
  repo.g(['add', '-A'])
  repo.g(['commit', '-q', '-m', `base ${relPath}`])
  repo.g(['checkout', '-q', 'feature-send-receive'])
  fs.writeFileSync(abs, 'target\n')
  repo.g(['add', '-A'])
  repo.g(['commit', '-q', '-m', `target ${relPath}`])
  repo.g(['checkout', '-q', 'feature-send-receive-login'])
  fs.writeFileSync(abs, 'source\n')
  repo.g(['add', '-A'])
  repo.g(['commit', '-q', '-m', `source ${relPath}`])
}

function makeDirConflict(repo, relDir) {
  const abs = path.join(repo.dir, relDir, 'a.txt')
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, 'base\n')
  repo.g(['add', '-A'])
  repo.g(['commit', '-q', '-m', `base ${relDir}`])
  repo.g(['checkout', '-q', 'feature-send-receive'])
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, 'target\n')
  repo.g(['add', '-A'])
  repo.g(['commit', '-q', '-m', `target ${relDir}`])
  repo.g(['checkout', '-q', 'feature-send-receive-login'])
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, 'source\n')
  repo.g(['add', '-A'])
  repo.g(['commit', '-q', '-m', `source ${relDir}`])
}

test('store merges：状态机 CRUD 与 state 校验', async (t) => {
  const { tmp, store, task } = await setup({ withRepo: false })
  t.after(() => tmp.cleanup())

  const row = store.addMerge(task.id, {
    repo: 'demo',
    sourceBranch: 'feature-x',
    targetBranch: 'feature-y',
    state: 'merged',
    mergeSha: 'abcdef1'
  })
  assert.equal(row.state, 'merged')
  assert.equal(store.getMerge(row.id).mergeSha, 'abcdef1')
  assert.equal(store.listMerges({ nodeId: task.id }).length, 1)

  const conflicted = store.addMerge(task.id, {
    repo: 'demo',
    sourceBranch: 'feature-x',
    targetBranch: 'feature-y',
    state: 'precheck_conflict',
    conflictFiles: ['a.txt']
  })
  assert.deepEqual(conflicted.conflictFiles, ['a.txt'])
  assert.equal(store.listMerges({ state: 'precheck_conflict' }).length, 1)
  assert.throws(() => store.listMerges({ state: 'nope' }), (e) => e.code === 'VALIDATION_FAILED')

  const resolved = store.confirmMerge(conflicted.id, { mergeSha: 'abcdef1' })
  assert.equal(resolved.state, 'resolved')
  assert.equal(resolved.mergeSha, 'abcdef1')
  assert.throws(() => store.confirmMerge(resolved.id, { mergeSha: 'zz' }), (e) => e.code === 'VALIDATION_FAILED')

  // N4：不拿预检 target_sha 冒充 merge_sha；已 merged 的行拒绝 confirm 降级
  const noSha = store.addMerge(task.id, {
    repo: 'demo',
    sourceBranch: 'feature-x',
    targetBranch: 'feature-y',
    targetSha: 'targetsha',
    state: 'precheck_conflict'
  })
  assert.equal(store.confirmMerge(noSha.id).mergeSha, null)
  assert.throws(() => store.confirmMerge(row.id), (e) => e.code === 'VALIDATION_FAILED')

  const aborted = store.abortMerge(resolved.id)
  assert.equal(aborted.state, 'aborted')
  assert.throws(() => store.confirmMerge(aborted.id), (e) => e.code === 'VALIDATION_FAILED')
  assert.throws(() => store.abortMerge(row.id), (e) => e.code === 'VALIDATION_FAILED')
})

test('ops merge：预检只读——有冲突时落 precheck_conflict，不改分支', async (t) => {
  const { tmp, store, ops, repo, task } = await setup()
  t.after(() => {
    tmp.cleanup()
    fs.rmSync(repo.root, { recursive: true, force: true })
  })
  makeConflict(repo)
  const beforeTarget = repo.g(['rev-parse', 'feature-send-receive']).trim()
  const beforeSource = repo.g(['rev-parse', 'feature-send-receive-login']).trim()
  const beforeRev = store.getRevision()

  const out = await ops.precheckMerge(store, task.id, {})
  assert.equal(out.sourceBranch, 'feature-send-receive-login')
  assert.equal(out.targetBranch, 'feature-send-receive')
  assert.equal(out.conflicted, true)
  assert.ok(out.items[0].conflictFiles.includes('a.txt'))
  assert.equal(store.getRevision(), beforeRev, '预检不得改库')
  assert.equal(repo.g(['rev-parse', 'feature-send-receive']).trim(), beforeTarget, '预检不得改目标分支')
  assert.equal(repo.g(['rev-parse', 'feature-send-receive-login']).trim(), beforeSource, '预检不得改源分支')

  const run = await ops.runMerge(store, task.id, { confirm: true })
  assert.equal(run.conflicts.length, 1)
  assert.equal(run.merged.length, 0)
  assert.equal(repo.g(['rev-parse', 'feature-send-receive']).trim(), beforeTarget, '冲突时不得改目标分支')
  const pending = store.listMerges({ nodeId: task.id, state: 'precheck_conflict' })
  assert.equal(pending.length, 1)
  assert.deepEqual(pending[0].conflictFiles, ['a.txt'])
})

test('ops merge：无冲突时 merge --no-ff 并落 merged 行；已合入幂等', async (t) => {
  const { tmp, store, ops, repo, task } = await setup()
  t.after(() => {
    tmp.cleanup()
    fs.rmSync(repo.root, { recursive: true, force: true })
  })
  repo.g(['checkout', '-q', 'feature-send-receive'])

  const out = await ops.runMerge(store, task.id, { confirm: true })
  assert.equal(out.merged.length, 1)
  assert.equal(out.merged[0].state, 'merged')
  assert.ok(out.merged[0].mergeSha)
  assert.equal(repo.g(['rev-parse', '--abbrev-ref', 'HEAD']).trim(), 'feature-send-receive')
  repo.g(['merge-base', '--is-ancestor', 'feature-send-receive-login', 'feature-send-receive'])

  const again = await ops.runMerge(store, task.id, { confirm: true })
  assert.equal(again.merged.length, 1)
  assert.equal(again.merged[0].alreadyMerged, true)
  assert.equal(store.listMerges({ nodeId: task.id, state: 'merged' }).length, 2)
})

test('ops merge：合并成功后恢复发起前的 HEAD（不在集成分支留下用户）', async (t) => {
  const { tmp, store, ops, repo, task } = await setup()
  t.after(() => {
    tmp.cleanup()
    fs.rmSync(repo.root, { recursive: true, force: true })
  })
  // 发起合同时 HEAD 在第三个分支（不是 source、也不是 target）
  repo.g(['branch', 'third', 'feature-send-receive'])
  repo.g(['checkout', '-q', 'third'])

  const out = await ops.runMerge(store, task.id, { confirm: true })
  assert.equal(out.merged.length, 1)
  assert.equal(repo.g(['rev-parse', '--abbrev-ref', 'HEAD']).trim(), 'third', '成功后应恢复原 HEAD')
  assert.equal(out.merged[0].restoredHead, 'third')
  repo.g(['merge-base', '--is-ancestor', 'feature-send-receive-login', 'feature-send-receive'])
})

test('ops merge：detached HEAD 发起合并后恢复到原 sha（N5 回归）', async (t) => {
  const { tmp, store, ops, repo, task } = await setup()
  t.after(() => {
    tmp.cleanup()
    fs.rmSync(repo.root, { recursive: true, force: true })
  })
  // detached 到第三个提交（不是 source、也不是 target），并确保它仍包含基线，
  // 这样工作单元的分支解析不受影响，但 HEAD 已不是任何分支。
  repo.g(['checkout', '-q', '-B', 'third', 'feature-send-receive'])
  fs.writeFileSync(path.join(repo.dir, 'third.txt'), 'third\n')
  repo.g(['add', '.'])
  repo.g(['commit', '-q', '-m', 'third work'])
  const detachedSha = repo.g(['rev-parse', 'HEAD']).trim()
  repo.g(['checkout', '-q', '--detach', detachedSha])

  const out = await ops.runMerge(store, task.id, { confirm: true })
  assert.equal(out.merged.length, 1)
  assert.equal(repo.g(['rev-parse', '--abbrev-ref', 'HEAD']).trim(), 'HEAD', '应仍为 detached')
  assert.equal(repo.g(['rev-parse', 'HEAD']).trim(), detachedSha, 'detached 应恢复到原 sha')
  assert.equal(out.merged[0].restoredHead, detachedSha)
  repo.g(['merge-base', '--is-ancestor', 'feature-send-receive-login', 'feature-send-receive'])
})

test('ops merge：冲突清单按分隔符解析——前缀型 / 大小写型 / 非 ASCII 路径都不丢（N2/N3 回归）', async (t) => {
  for (const name of ['conflict.txt', 'ConflictPane.vue', 'Auto-merging.md', '中文.txt']) {
    const { tmp, store, ops, repo, task } = await setup()
    t.after(() => {
      tmp.cleanup()
      fs.rmSync(repo.root, { recursive: true, force: true })
    })
    makeNamedConflict(repo, name)
    const out = await ops.runMerge(store, task.id, { confirm: true })
    assert.equal(out.conflicts.length, 1, `${name} 应产生冲突`)
    assert.deepEqual(out.conflicts[0].conflictFiles, [name], `${name} 必须原样落库，不被前缀过滤或引号转义`)
    const row = store.listMerges({ nodeId: task.id, state: 'precheck_conflict' })[0]
    assert.deepEqual(row.conflictFiles, [name])
  }
})

test('conflict：三方详情读取 + resolve 产出可 apply 的统一补丁（不自动改分支）', async (t) => {
  const { tmp, store, ops, repo, repoRow, task } = await setup()
  t.after(() => {
    tmp.cleanup()
    fs.rmSync(repo.root, { recursive: true, force: true })
  })
  makeConflict(repo)
  const run = await ops.runMerge(store, task.id, { confirm: true })
  const mid = run.conflicts[0].id
  const beforeTarget = repo.g(['rev-parse', 'feature-send-receive']).trim()

  const detail = await ops.getMergeConflicts(store, mid)
  assert.equal(detail.files.length, 1)
  assert.equal(detail.files[0].file, 'a.txt')
  assert.equal(detail.files[0].base, 'base\n')
  assert.equal(detail.files[0].ours, 'target\n')
  assert.equal(detail.files[0].theirs, 'source\n')
  assert.deepEqual(detail.files[0].stages, { base: true, ours: true, theirs: true })

  const content = 'resolved\n'
  const out = await ops.resolveMergeConflicts(store, mid, { files: [{ path: 'a.txt', content }] })
  assert.equal(out.merge.state, 'precheck_conflict', 'resolve 只写回结果，不自动置 resolved')
  assert.equal(out.files[0].contentHash, createHash('sha1').update(content).digest('hex'))
  assert.equal(repo.g(['rev-parse', 'feature-send-receive']).trim(), beforeTarget, 'resolve 不得改分支')
  assert.deepEqual(store.getMerge(mid).resolvedFiles, [
    { path: 'a.txt', content, contentHash: out.files[0].contentHash, wroteWorktree: false, changed: true }
  ])

  // 补丁面向 target 版本生成；checkout target 后应能直接 git apply。
  repo.g(['checkout', '-q', 'feature-send-receive'])
  fs.writeFileSync(path.join(repo.dir, 'a.txt'), 'target\n')
  const patchFile = path.join(repo.root, 'resolve.patch')
  fs.writeFileSync(patchFile, out.patches[0].patch)
  repo.g(['apply', '--check', patchFile])
  repo.g(['apply', patchFile])
  assert.equal(fs.readFileSync(path.join(repo.dir, 'a.txt'), 'utf8'), content)
})

test('conflict：resolve 可写入已登记的 worktree；未登记 worktree 时拒绝', async (t) => {
  const { tmp, store, ops, repo, repoRow, task } = await setup()
  t.after(() => {
    tmp.cleanup()
    fs.rmSync(repo.root, { recursive: true, force: true })
  })
  makeConflict(repo)
  const run = await ops.runMerge(store, task.id, { confirm: true })
  const mid = run.conflicts[0].id
  const wt = path.join(repo.root, 'work-wt-resolve')
  const { addWorktree } = await import('../server/git.mjs')
  // resolve 阶段不必真的把冲突分支挂进 worktree；用一个独立分支占位，
  // 只验证「写入已登记 worktree」这条落盘链路。
  repo.g(['branch', 'resolve-holder', 'feature-send-receive'])
  await addWorktree(repo.dir, { worktreePath: wt, branch: 'resolve-holder', baseBranch: 'feature-send-receive' })
  store.updateUnitRepo(store.listUnitRepos(task.id)[0].id, { worktreePath: wt })

  const out = await ops.resolveMergeConflicts(store, mid, {
    files: [{ path: 'a.txt', content: 'worktree resolved\n' }],
    writeToWorktree: true
  })
  assert.equal(out.files[0].wroteWorktree, true)
  assert.equal(fs.readFileSync(path.join(wt, 'a.txt'), 'utf8'), 'worktree resolved\n')

  // 未登记 / 路径不存在时拒绝，而不是静默不写。
  store.updateUnitRepo(store.listUnitRepos(task.id)[0].id, { worktreePath: null })
  const run2 = await ops.runMerge(store, task.id, { confirm: true })
  await assert.rejects(
    ops.resolveMergeConflicts(store, run2.conflicts[0]?.id || mid, { files: [{ path: 'a.txt', content: 'x\n' }], writeToWorktree: true }),
    (e) => e.code === 'VALIDATION_FAILED'
  )
})

test('N6 回归：内容行以 `-- ` / `++ ` 开头时补丁仍可 apply 且不写坏', async (t) => {
  for (const [fixture, content] of [
    ['-- target comment\n', '-- resolved comment\n'],
    ['++ target note\n', '++ resolved note\n']
  ]) {
    const { tmp, store, ops, repo, task } = await setup()
    t.after(() => {
      tmp.cleanup()
      fs.rmSync(repo.root, { recursive: true, force: true })
    })
    repo.g(['checkout', '-q', 'feature-send-receive'])
    fs.writeFileSync(path.join(repo.dir, 'a.txt'), fixture)
    repo.g(['add', '.'])
    repo.g(['commit', '-q', '-m', 'target fixture'])
    repo.g(['checkout', '-q', 'feature-send-receive-login'])
    fs.writeFileSync(path.join(repo.dir, 'a.txt'), 'source\n')
    repo.g(['add', '.'])
    repo.g(['commit', '-q', '-m', 'source fixture'])

    const run = await ops.runMerge(store, task.id, { confirm: true })
    const out = await ops.resolveMergeConflicts(store, run.conflicts[0].id, { files: [{ path: 'a.txt', content }] })
    repo.g(['checkout', '-q', 'feature-send-receive'])
    fs.writeFileSync(path.join(repo.dir, 'a.txt'), fixture)
    const patchFile = path.join(repo.root, 'n6.patch')
    fs.writeFileSync(patchFile, out.patches[0].patch)
    repo.g(['apply', '--check', patchFile])
    repo.g(['apply', patchFile])
    assert.equal(fs.readFileSync(path.join(repo.dir, 'a.txt'), 'utf8'), content)
  }
})

test('N7 回归：worktree 内目标 / 父目录为符号链接时拒绝写入，外部文件不被覆盖', async (t) => {
  for (const kind of ['target', 'parent']) {
    const { tmp, store, ops, repo, task } = await setup()
    t.after(() => {
      tmp.cleanup()
      fs.rmSync(repo.root, { recursive: true, force: true })
    })
    if (kind === 'target') makeConflict(repo)
    else makeDirConflict(repo, 'dir')
    const run = await ops.runMerge(store, task.id, { confirm: true })
    const wt = path.join(repo.root, `wt-${kind}`)
    const { addWorktree } = await import('../server/git.mjs')
    repo.g(['branch', `holder-${kind}`, 'feature-send-receive'])
    await addWorktree(repo.dir, { worktreePath: wt, branch: `holder-${kind}`, baseBranch: 'feature-send-receive' })
    store.updateUnitRepo(store.listUnitRepos(task.id)[0].id, { worktreePath: wt })

    const outside = path.join(repo.root, `outside-${kind}.txt`)
    fs.writeFileSync(outside, 'SAFE\n')
    if (kind === 'target') {
      fs.rmSync(path.join(wt, 'a.txt'))
      fs.symlinkSync(outside, path.join(wt, 'a.txt'))
      await assert.rejects(
        ops.resolveMergeConflicts(store, run.conflicts[0].id, { files: [{ path: 'a.txt', content: 'PWNED\n' }], writeToWorktree: true }),
        (e) => e.code === 'VALIDATION_FAILED'
      )
    } else {
      fs.rmSync(path.join(wt, 'dir'), { recursive: true, force: true })
      fs.symlinkSync(path.dirname(outside), path.join(wt, 'dir'))
      await assert.rejects(
        ops.resolveMergeConflicts(store, run.conflicts[0].id, { files: [{ path: 'dir/a.txt', content: 'PWNED\n' }], writeToWorktree: true }),
        (e) => e.code === 'VALIDATION_FAILED'
      )
    }
    assert.equal(fs.readFileSync(outside, 'utf8'), 'SAFE\n', '外部文件不得被改写')
  }
})

test('N8：resolve 内容与目标一致时 changed=false，不返回会被误 apply 的空补丁', async (t) => {
  const { tmp, store, ops, repo, task } = await setup()
  t.after(() => {
    tmp.cleanup()
    fs.rmSync(repo.root, { recursive: true, force: true })
  })
  makeConflict(repo)
  const run = await ops.runMerge(store, task.id, { confirm: true })
  const out = await ops.resolveMergeConflicts(store, run.conflicts[0].id, { files: [{ path: 'a.txt', content: 'target\n' }] })
  assert.equal(out.files[0].changed, false)
  assert.equal(out.patches[0].changed, false)
  assert.equal(out.patches[0].patch, '')
  assert.match(out.patches[0].note, /无需应用补丁/)
})

test('ops merge：缺 confirm / 分支缺失 / 类型非法给稳定错误码', async (t) => {
  const { tmp, store, ops, repo, task, s } = await setup()
  t.after(() => {
    tmp.cleanup()
    fs.rmSync(repo.root, { recursive: true, force: true })
  })
  await assert.rejects(ops.runMerge(store, task.id, {}), (e) => e.code === 'CONFIRM_REQUIRED')

  store.setAttrs(task.id, { branch: 'feature-send-receive-login', base_branch: 'feature-send-receive' })
  store.updateUnitRepo(store.listUnitRepos(task.id)[0].id, { branch: 'feature-send-receive-login' })
  await assert.rejects(ops.runMerge(store, s.id, { confirm: true }), (e) => e.code === 'VALIDATION_FAILED')

  store.setAttrs(task.id, { branch: 'no-such-branch' })
  await assert.rejects(ops.runMerge(store, task.id, { confirm: true }), (e) => e.code === 'BRANCH_NOT_FOUND')
})

test('N1 回归：--keep-branch / removeBranch:false 保留 attrs.branch，后续 cleanup 与 prompt 仍指向真实分支', async (t) => {
  const { tmp, store, ops, repo, repoRow, task } = await setup()
  t.after(() => {
    tmp.cleanup()
    fs.rmSync(repo.root, { recursive: true, force: true })
  })
  // 这条用例走工作区生命周期，夹具不要复用在基线前进入的开发分支；
  // 给一个干净分支名，确保 setupWorkspace 能正常派生。
  store.setAttrs(task.id, { branch: '', slug: 'n1' })
  await ops.setupWorkspace(store, task.id, {})
  const branch = store.getAttrs(task.id).branch
  assert.equal(branch, 'feature-send-receive-n1')

  const kept = await ops.cleanupWorkspace(store, task.id, { confirm: true, removeBranch: false })
  assert.equal(kept.results[0].branchRemoved, false)
  assert.equal(store.getAttrs(task.id).branch, branch, '显式保留分支时必须保留 attrs.branch')
  assert.equal(ops.getWorkspacePrompt(store, task.id).branch, branch, 'prompt 必须仍指向真实分支')
  assert.ok(repo.g(['branch', '--list', branch]).trim(), '分支必须仍在磁盘上')

  // 旧实现会把 attrs.branch 清空，导致这里取不到分支名、无法再删除该分支。
  const cleaned = await ops.cleanupWorkspace(store, task.id, { confirm: true })
  assert.equal(cleaned.results[0].branchRemoved, true)
  assert.equal(repo.g(['branch', '--list', branch]).trim(), '')
  assert.equal(store.getAttrs(task.id).branch || '', '')
})

test('三入口 1:1：merge precheck / run / list / confirm / abort 与 store 一致', async (t) => {
  const s = await entrySetup()
  t.after(() => s.cleanup())

  const tools = await s.mcpTools()
  for (const name of ['merge_precheck', 'merge_run', 'merge_list', 'merge_conflicts', 'merge_resolve', 'merge_confirm', 'merge_abort']) {
    assert.ok(tools.includes(name), `${name} 应注册`)
  }

  // HTTP：预检只读
  const pre = await s.http('POST', `/api/nodes/${s.task.id}/merges/precheck`, {})
  assert.equal(pre.status, 200)
  assert.equal(pre.body.conflicted, false)
  assert.equal(s.store.listMerges({ nodeId: s.task.id }).length, 0, '预检不得落库')

  // CLI：无 confirm 拒绝
  await assert.rejects(s.cli(['merge', 'run', String(s.task.id)]), (e) => /CONFIRM_REQUIRED/.test(String(e.stderr || e.message)))

  // MCP：真实合并成功并落 merged 行
  const mcpRun = JSON.parse((await s.mcp('merge_run', { node: s.task.id, confirm: true })).content[0].text)
  assert.equal(mcpRun.merged.length, 1)
  assert.equal(mcpRun.merged[0].state, 'merged')

  // CLI：记录列表与 HTTP/MCP 一致
  const listed = JSON.parse((await s.cli(['merge', 'list', '--id', String(s.task.id)])).stdout)
  assert.equal(listed.items.length, 1)
  assert.equal(listed.items[0].repo, s.repoRow.name)
  const httpList = await s.http('GET', `/api/merges?nodeId=${s.task.id}`)
  assert.equal(httpList.body.items.length, 1)
  assert.equal(httpList.body.items[0].mergeSha, listed.items[0].mergeSha)

  // HTTP：冲突场景落 precheck_conflict，confirm / abort 与 MCP 语义一致
  const s2 = await entrySetup()
  t.after(() => s2.cleanup())
  makeConflict(s2.repo)
  const conflict = await s2.http('POST', `/api/nodes/${s2.task.id}/merges`, { confirm: true })
  assert.equal(conflict.status, 200)
  assert.equal(conflict.body.conflicts.length, 1)
  const mid = conflict.body.conflicts[0].id
  assert.deepEqual(conflict.body.conflicts[0].conflictFiles, ['a.txt'])

  const detail = await s2.http('GET', `/api/merges/${mid}/conflicts`)
  assert.equal(detail.status, 200)
  assert.equal(detail.body.files[0].ours, 'target\n')
  const resolved = await s2.http('POST', `/api/merges/${mid}/resolve`, { files: [{ path: 'a.txt', content: 'resolved\n' }] })
  assert.equal(resolved.status, 200)
  assert.match(resolved.body.patches[0].patch, /^diff --git a\/a\.txt b\/a\.txt/m)

  const confirmed = JSON.parse((await s2.cli(['merge', 'confirm', String(mid), '--merge-sha', 'abcdef1'])).stdout)
  assert.equal(confirmed.state, 'resolved')
  assert.equal(confirmed.resolvedFiles[0].contentHash, resolved.body.files[0].contentHash)
  const aborted = JSON.parse((await s2.mcp('merge_abort', { id: mid })).content[0].text)
  assert.equal(aborted.state, 'aborted')
})
