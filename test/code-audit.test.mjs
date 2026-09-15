import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { tempHome } from './helpers.mjs'

/**
 * 临时 git 仓库：main 上有一个基线提交，随后在分支上追加若干提交以制造新增行。
 * 返回可继续 `commit(files, message)` 的写入器，便于每个用例自造 diff。
 */
function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'taskboard-codeaudit-'))
  const dir = path.join(root, 'work')
  fs.mkdirSync(dir)
  const g = (args, cwd = dir) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' })
  g(['init', '-q', '-b', 'main'])
  g(['config', 'user.email', 't@t.local'])
  g(['config', 'user.name', 't'])
  fs.writeFileSync(path.join(dir, 'README.md'), '# base\n')
  g(['add', '.'])
  g(['commit', '-q', '-m', 'init'])
  const mainSha = g(['rev-parse', 'HEAD']).trim()

  /** 写若干文件并提交，返回 sha */
  const commit = (files, message) => {
    for (const [p, content] of Object.entries(files)) {
      const full = path.join(dir, p)
      fs.mkdirSync(path.dirname(full), { recursive: true })
      fs.writeFileSync(full, content)
    }
    g(['add', '.'])
    g(['commit', '-q', '-m', message])
    return g(['rev-parse', 'HEAD']).trim()
  }
  return { root, dir, g, mainSha, commit }
}

async function setup() {
  const tmp = await tempHome()
  const db = tmp.openDb()
  const store = tmp.store.createStore(db)
  const ops = await import('../server/ops.mjs')
  const git = await import('../server/git.mjs')
  return { tmp, store, ops, git }
}

/** 建 项目/需求/子需求 三层，并把仓库登记到需求节点上 */
function seed(store, repoName, localPath) {
  const p = store.createNode({ type: 'project', name: 'P' })
  const r = store.createNode({ parentId: p.id, type: 'requirement', name: 'R' })
  const s = store.createNode({ parentId: r.id, type: 'subreq', name: 'S' })
  store.addRepo({ name: repoName, localPath })
  return { p, r, s }
}

// ---------- git 层：commitAddedLines ----------

test('commitAddedLines：只取新增行，带新文件侧行号，排除被删行', async (t) => {
  const { git } = await setup()
  const { root, dir, g, commit } = makeRepo()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  // 基线提交里已有 a.js（3 行），本次改动删一行、加两行
  fs.writeFileSync(path.join(dir, 'a.js'), 'line1\nline2\nline3\n')
  g(['add', '.'])
  g(['commit', '-q', '-m', 'base a.js'])
  const sha = commit({ 'a.js': 'line1\nINSERTED_A\nINSERTED_B\n' }, 'change a.js')

  const entries = await git.commitAddedLines(dir, sha)
  const texts = entries.filter((e) => e.path === 'a.js').map((e) => e.text)
  assert.deepEqual(texts, ['INSERTED_A', 'INSERTED_B'])
  // 行号是新文件侧：line1=1, INSERTED_A=2, INSERTED_B=3
  assert.deepEqual(entries.filter((e) => e.path === 'a.js').map((e) => e.line), [2, 3])
  assert.ok(!texts.includes('line1'), '未改动的上下文行不应出现')
})

test('commitAddedLines：新增文件从第 1 行开始计数', async (t) => {
  const { git } = await setup()
  const { root, dir, commit } = makeRepo()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  const sha = commit({ 'new/dir/x.js': 'a\nb\n' }, 'add x.js')
  const entries = await git.commitAddedLines(dir, sha)
  const x = entries.filter((e) => e.path === 'new/dir/x.js')
  assert.deepEqual(x.map((e) => [e.line, e.text]), [[1, 'a'], [2, 'b']])
})

test('commitAddedLines：删除文件不产出新增行；二进制文件不炸', async (t) => {
  const { git } = await setup()
  const { root, dir, g, commit } = makeRepo()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  fs.writeFileSync(path.join(dir, 'gone.txt'), 'bye\n')
  fs.writeFileSync(path.join(dir, 'blob.bin'), Buffer.from([0, 1, 2, 3, 0, 255]))
  g(['add', '.'])
  g(['commit', '-q', '-m', 'base files'])
  g(['rm', '-q', 'gone.txt'])
  fs.writeFileSync(path.join(dir, 'keep.js'), 'ok()\n')
  g(['add', '.'])
  g(['commit', '-q', '-m', 'remove + add'])
  const sha = g(['rev-parse', 'HEAD']).trim()

  const entries = await git.commitAddedLines(dir, sha)
  assert.ok(!entries.some((e) => e.path === 'gone.txt'), '被删除文件不该有新增行')
  assert.ok(entries.some((e) => e.path === 'keep.js' && e.text === 'ok()'))
})

// ---------- ops 层：getNodeCodeAudit ----------

test('code audit：命中高危 → ready=false，且证据已脱敏', async (t) => {
  const { tmp, store, ops } = await setup()
  const repo = makeRepo()
  t.after(() => {
    tmp.cleanup()
    fs.rmSync(repo.root, { recursive: true, force: true })
  })
  const { r } = seed(store, 'demo', repo.dir)
  const sha = repo.commit({ 'conf.js': "const password = 'hunter2hunter2'\n" }, 'add conf')
  store.addCommit(r.id, { repo: 'demo', sha })

  const audit = await ops.getNodeCodeAudit(store, r.id)
  assert.equal(audit.ready, false)
  assert.equal(audit.totals.danger, 1)
  assert.equal(audit.blockers[0].rule, 'hardcoded_secret')
  assert.ok(!JSON.stringify(audit).includes('hunter2hunter2'), '输出任何位置都不得含原值')
})

test('code audit：干净的新增行 → ready=true', async (t) => {
  const { tmp, store, ops } = await setup()
  const repo = makeRepo()
  t.after(() => {
    tmp.cleanup()
    fs.rmSync(repo.root, { recursive: true, force: true })
  })
  const { r } = seed(store, 'demo', repo.dir)
  const sha = repo.commit({ 'calc.js': 'export const add = (a, b) => a + b\n' }, 'add calc')
  store.addCommit(r.id, { repo: 'demo', sha })

  const audit = await ops.getNodeCodeAudit(store, r.id)
  assert.equal(audit.ready, true)
  assert.equal(audit.totals.findings, 0)
  assert.equal(audit.totals.addedLines, 1)
})

test('code audit：仓库未登记本地路径 → 单条记 error，ready=null（看不到 ≠ 通过）', async (t) => {
  const { tmp, store, ops } = await setup()
  t.after(() => tmp.cleanup())
  const { r } = seed(store, 'demo', null)
  store.addCommit(r.id, { repo: 'demo', sha: 'a'.repeat(40) })

  const audit = await ops.getNodeCodeAudit(store, r.id)
  assert.equal(audit.ready, null)
  assert.equal(audit.totals.errors, 1)
  assert.equal(audit.items[0].error.code, 'REPO_PATH_MISSING')
})

test('code audit：sha 不存在 → 该条记 error，不拖垮同节点的其它提交', async (t) => {
  const { tmp, store, ops } = await setup()
  const repo = makeRepo()
  t.after(() => {
    tmp.cleanup()
    fs.rmSync(repo.root, { recursive: true, force: true })
  })
  const { r } = seed(store, 'demo', repo.dir)
  const good = repo.commit({ 'ok.js': 'export const v = 1\n' }, 'good')
  store.addCommit(r.id, { repo: 'demo', sha: good })
  store.addCommit(r.id, { repo: 'demo', sha: 'deadbeefdeadbeef' })

  const audit = await ops.getNodeCodeAudit(store, r.id)
  assert.equal(audit.totals.commits, 2)
  assert.equal(audit.totals.errors, 1)
  // 有读不到的提交时不给绿灯，哪怕另一条提交是干净的
  assert.equal(audit.ready, null)
  assert.equal(audit.items.find((i) => i.commit.sha === good).addedLines, 1)
})

test('code audit：scope=subtree 纳入子树提交，self 不纳入', async (t) => {
  const { tmp, store, ops } = await setup()
  const repo = makeRepo()
  t.after(() => {
    tmp.cleanup()
    fs.rmSync(repo.root, { recursive: true, force: true })
  })
  const { r, s } = seed(store, 'demo', repo.dir)
  const sha = repo.commit({ 'sub.js': 'eval(userInput)\n' }, 'sub change')
  store.addCommit(s.id, { repo: 'demo', sha })

  const self = await ops.getNodeCodeAudit(store, r.id)
  assert.equal(self.totals.commits, 0)
  assert.equal(self.ready, null)

  const subtree = await ops.getNodeCodeAudit(store, r.id, { scope: 'subtree' })
  assert.equal(subtree.totals.commits, 1)
  assert.equal(subtree.ready, false)
  assert.equal(subtree.blockers[0].rule, 'eval_usage')
})

test('code audit：非法 scope 报 VALIDATION_FAILED；空提交（无新增行）→ ready=null', async (t) => {
  const { tmp, store, ops } = await setup()
  const repo = makeRepo()
  t.after(() => {
    tmp.cleanup()
    fs.rmSync(repo.root, { recursive: true, force: true })
  })
  const { r } = seed(store, 'demo', repo.dir)
  await assert.rejects(() => ops.getNodeCodeAudit(store, r.id, { scope: 'Subtree' }), /VALIDATION_FAILED/)

  // 允许空的提交：读过但没有任何新增行 → ready=null（没有可审查的代码，不是通过）
  repo.g(['commit', '-q', '--allow-empty', '-m', 'empty'])
  const emptySha = repo.g(['rev-parse', 'HEAD']).trim()
  store.addCommit(r.id, { repo: 'demo', sha: emptySha })
  const audit = await ops.getNodeCodeAudit(store, r.id)
  assert.equal(audit.ready, null)
  assert.equal(audit.totals.addedLines, 0)
})

test('D1 回归：一行两个凭据赋值且值相同，JSON 与 markdown 均不得出现任一明文', async (t) => {
  const { tmp, store, ops } = await setup()
  const repo = makeRepo()
  t.after(() => {
    tmp.cleanup()
    fs.rmSync(repo.root, { recursive: true, force: true })
  })
  const { r } = seed(store, 'demo', repo.dir)
  // QA 最小复现 + 两个凭据赋值同值，一起落进同一个提交
  const sha = repo.commit(
    {
      'leak.js': [
        "const note = 'leakvalue999'; const token = 'leakvalue999'",
        "const token = 'samevalue123'; const apiKey = 'samevalue123'"
      ].join('\n') + '\n'
    },
    'risky one-liners'
  )
  store.addCommit(r.id, { repo: 'demo', sha })

  const audit = await ops.getNodeCodeAudit(store, r.id)
  assert.equal(audit.ready, false)
  assert.equal(audit.totals.danger, 2, '两行各命中一次')

  // ① JSON（HTTP / CLI / MCP / Web 都消费这一份结构）
  const json = JSON.stringify(audit)
  for (const secret of ['leakvalue999', 'samevalue123']) {
    assert.ok(!json.includes(secret), `JSON 泄漏明文 ${secret}`)
    assert.ok(!audit.blockers.some((b) => b.snippet.includes(secret)), `blockers 泄漏明文 ${secret}`)
  }

  // ② markdown（可粘贴输出）
  const md = ops.renderCodeAuditMd(audit)
  for (const secret of ['leakvalue999', 'samevalue123']) {
    assert.ok(!md.includes(secret), `markdown 泄漏明文 ${secret}`)
  }
  // 两处都应留下掩码
  assert.ok(md.includes('le***(12)'), md)
  assert.ok(md.includes('sa***(12)'), md)
})

test('code audit：纯读，不产生 revision', async (t) => {
  const { tmp, store, ops } = await setup()
  const repo = makeRepo()
  t.after(() => {
    tmp.cleanup()
    fs.rmSync(repo.root, { recursive: true, force: true })
  })
  const { r } = seed(store, 'demo', repo.dir)
  store.addCommit(r.id, { repo: 'demo', sha: repo.commit({ 'a.js': 'export const a = 1\n' }, 'a') })
  const before = store.getRevision()
  await ops.getNodeCodeAudit(store, r.id)
  await ops.getNodeCodeAudit(store, r.id, { scope: 'subtree' })
  assert.equal(store.getRevision(), before)
})

test('code audit：renderCodeAuditMd 转义表格里的竖线与反斜杠', async (t) => {
  const { tmp, store, ops } = await setup()
  const repo = makeRepo()
  t.after(() => {
    tmp.cleanup()
    fs.rmSync(repo.root, { recursive: true, force: true })
  })
  const { r } = seed(store, 'demo', repo.dir)
  // 片段里同时含 | 与结尾反斜杠：不转义会把表格切歪
  const sha = repo.commit({ 'weird.js': 'console.log("a|b\\\\")\n' }, 'weird')
  store.addCommit(r.id, { repo: 'demo', sha })

  const audit = await ops.getNodeCodeAudit(store, r.id)
  const md = ops.renderCodeAuditMd(audit)
  const row = md.split('\n').find((l) => l.startsWith('| 提示 |'))
  assert.ok(row, `应有提示行：\n${md}`)
  assert.ok(row.includes('\\|'), `竖线应转义：${row}`)
  // 每一行数据的竖线数应与表头一致（5 列 → 6 个未转义竖线）
  const countUnescaped = (s) => (s.match(/(^|[^\\])\|/g) || []).length
  assert.equal(countUnescaped(row), 6, `列数应与表头一致：${row}`)
})
