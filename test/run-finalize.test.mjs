import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { tempHome } from './helpers.mjs'

const execFileP = promisify(execFile)

async function setup() {
  const tmp = await tempHome()
  const db = tmp.openDb()
  const store = tmp.store.createStore(db)
  const p = store.createNode({ type: 'project', name: 'P' })
  const r = store.createNode({ parentId: p.id, type: 'requirement', name: 'R' })
  const s = store.createNode({ parentId: r.id, type: 'subreq', name: 'S' })
  const task = store.createNode({ parentId: s.id, type: 'task', name: 'T' })
  return { tmp, store, p, r, s, task }
}

/** 造一个把固定台词写到 stdout 的可执行脚本，替代真实 agent CLI */
function makeAgentScript(t, body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-agent-script-'))
  const file = path.join(dir, 'agent.sh')
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 })
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return file
}

// ---------- finalizeReportsForRun：run 终态自动收尾报告 ----------

test('auto-finalize：run 成功后按输出里的逐条结论回写 pass / fail', async (t) => {
  const { tmp, store, task } = await setup()
  t.after(() => tmp.cleanup())
  const a = store.createTestCase(task.id, { name: '登录回归', prompt: '跑 A' })
  const b = store.createTestCase(task.id, { name: '支付回归', prompt: '跑 B' })
  const run = store.createAgentRun(task.id, { prompt: 'x', agent: 'echo' }, 'user')
  const ra = store.createTestReport(task.id, { caseId: a.id, runId: run.id })
  const rb = store.createTestReport(task.id, { caseId: b.id, runId: run.id })

  store.appendAgentRunOutput(run.id, '登录回归: PASS - 全绿\n支付回归: FAIL - 断言挂了\n')
  const done = store.finishAgentRun(run.id, { status: 'success', exitCode: 0 })
  assert.equal(done.status, 'success')

  const after1 = store.getTestReport(ra.id)
  const after2 = store.getTestReport(rb.id)
  assert.equal(after1.status, 'pass')
  assert.equal(after2.status, 'fail')
  assert.equal(after1.autoFinalized, true)
  assert.match(after1.summary, /全绿/)
  assert.match(after2.summary, /断言挂了/)
  assert.ok(after1.finishedAt)
})

test('auto-finalize：run 成功但无显式结论 → blocked，不伪造成 pass', async (t) => {
  const { tmp, store, task } = await setup()
  t.after(() => tmp.cleanup())
  const c = store.createTestCase(task.id, { name: '登录回归', prompt: '跑 A' })
  const run = store.createAgentRun(task.id, { prompt: 'x', agent: 'echo' }, 'user')
  const rep = store.createTestReport(task.id, { caseId: c.id, runId: run.id })

  store.appendAgentRunOutput(run.id, '我跑完了，看起来没啥问题\n')
  store.finishAgentRun(run.id, { status: 'success', exitCode: 0 })

  const after = store.getTestReport(rep.id)
  assert.equal(after.status, 'blocked')
  assert.equal(after.autoFinalized, true)
  assert.match(after.summary, /未在输出中解析到/)
})

test('auto-finalize：run 失败 → error；超时 → cancelled', async (t) => {
  const { tmp, store, task } = await setup()
  t.after(() => tmp.cleanup())
  const c1 = store.createTestCase(task.id, { name: 'A', prompt: 'p' })
  const c2 = store.createTestCase(task.id, { name: 'B', prompt: 'p' })
  const r1 = store.createAgentRun(task.id, { prompt: 'x', agent: 'echo' }, 'user')
  const r2 = store.createAgentRun(task.id, { prompt: 'x', agent: 'echo' }, 'user')
  const rep1 = store.createTestReport(task.id, { caseId: c1.id, runId: r1.id })
  const rep2 = store.createTestReport(task.id, { caseId: c2.id, runId: r2.id })

  store.finishAgentRun(r1.id, { status: 'failed', exitCode: 1 })
  store.finishAgentRun(r2.id, { status: 'timeout' })

  assert.equal(store.getTestReport(rep1.id).status, 'error')
  assert.equal(store.getTestReport(rep2.id).status, 'cancelled')
})

test('auto-finalize：取消 run 时把关联 running 报告置 cancelled', async (t) => {
  const { tmp, store, task } = await setup()
  t.after(() => tmp.cleanup())
  const c = store.createTestCase(task.id, { name: 'A', prompt: 'p' })
  const run = store.createAgentRun(task.id, { prompt: 'x', agent: 'echo' }, 'user')
  const rep = store.createTestReport(task.id, { caseId: c.id, runId: run.id })

  store.cancelAgentRun(run.id, { reason: 'manual' })
  assert.equal(store.getTestReport(rep.id).status, 'cancelled')
  assert.equal(store.getTestReport(rep.id).autoFinalized, true)
})

test('auto-finalize：只碰 running 报告，不覆盖人工已回写的终态', async (t) => {
  const { tmp, store, task } = await setup()
  t.after(() => tmp.cleanup())
  const c = store.createTestCase(task.id, { name: 'A', prompt: 'p' })
  const run = store.createAgentRun(task.id, { prompt: 'x', agent: 'echo' }, 'user')
  const rep = store.createTestReport(task.id, { caseId: c.id, runId: run.id })
  // 人工先回写 fail（模拟前台执行者已经给了结论）
  store.finishTestReport(rep.id, { status: 'fail', summary: '人工判定' }, 'user')

  store.appendAgentRunOutput(run.id, 'A: PASS - 机器说绿\n')
  store.finishAgentRun(run.id, { status: 'success', exitCode: 0 })

  const after = store.getTestReport(rep.id)
  assert.equal(after.status, 'fail')
  assert.equal(after.summary, '人工判定')
  assert.equal(after.autoFinalized, false)
})

test('auto-finalize：人工可无 overwrite 改正自动结论；改正后归人所有（再改需 overwrite）', async (t) => {
  const { tmp, store, task } = await setup()
  t.after(() => tmp.cleanup())
  const c = store.createTestCase(task.id, { name: 'A', prompt: 'p' })
  const run = store.createAgentRun(task.id, { prompt: 'x', agent: 'echo' }, 'user')
  const rep = store.createTestReport(task.id, { caseId: c.id, runId: run.id })
  store.finishAgentRun(run.id, { status: 'success', exitCode: 0 })
  assert.equal(store.getTestReport(rep.id).status, 'blocked')

  // 人工确认其实通过了：无需 overwrite
  const refined = store.finishTestReport(rep.id, { status: 'pass', summary: '人工复核通过' }, 'user')
  assert.equal(refined.status, 'pass')
  assert.equal(refined.autoFinalized, false)

  // 归属人之后照旧受终态保护
  assert.throws(
    () => store.finishTestReport(rep.id, { status: 'fail' }, 'user'),
    /REPORT_STATUS_IMMUTABLE/
  )
})

test('auto-finalize：一次收尾只递增一次 revision', async (t) => {
  const { tmp, store, task } = await setup()
  t.after(() => tmp.cleanup())
  const c1 = store.createTestCase(task.id, { name: 'A', prompt: 'p' })
  const c2 = store.createTestCase(task.id, { name: 'B', prompt: 'p' })
  const run = store.createAgentRun(task.id, { prompt: 'x', agent: 'echo' }, 'user')
  store.createTestReport(task.id, { caseId: c1.id, runId: run.id })
  store.createTestReport(task.id, { caseId: c2.id, runId: run.id })

  const before = store.getRevision()
  store.finishAgentRun(run.id, { status: 'success', exitCode: 0 })
  assert.equal(store.getRevision(), before + 1)
})

test('auto-finalize：无关联报告的 run 收尾不产生额外 revision', async (t) => {
  const { tmp, store, task } = await setup()
  t.after(() => tmp.cleanup())
  const run = store.createAgentRun(task.id, { prompt: 'x', agent: 'echo' }, 'user')
  const before = store.getRevision()
  store.finishAgentRun(run.id, { status: 'success', exitCode: 0 })
  assert.equal(store.getRevision(), before + 1)
})

test('auto-finalize：服务重启中断 stale run 时同样收尾其 running 报告', async (t) => {
  const { tmp, store, task } = await setup()
  t.after(() => tmp.cleanup())
  const c = store.createTestCase(task.id, { name: 'A', prompt: 'p' })
  const run = store.createAgentRun(task.id, { prompt: 'x', agent: 'echo' }, 'user')
  const rep = store.createTestReport(task.id, { caseId: c.id, runId: run.id })
  assert.equal(store.getTestReport(rep.id).status, 'running')

  const res = store.failStaleAgentRuns()
  assert.equal(res.cleared, 1)
  assert.equal(store.getAgentRun(run.id).status, 'failed')
  assert.equal(store.getTestReport(rep.id).status, 'error')
  assert.equal(store.getTestReport(rep.id).autoFinalized, true)
})

// ---------- 进程级：真实 CLI 非 dry-run 派单后自动收尾（复现独立测试的缺陷） ----------

test('进程级：CLI test run 非 dry-run 收尾到终态并回写报告（原缺陷：退出后仍 running）', async (t) => {
  const { tmp, store, task } = await setup()
  t.after(() => tmp.cleanup())
  const script = makeAgentScript(t, 'echo "登录回归: PASS - 全绿"')
  store.createTestCase(task.id, { name: '登录回归', prompt: '跑 A' })
  store.db.close()

  const out = await execFileP(process.execPath, [
    path.resolve(import.meta.dirname, '../bin/taskboard.js'),
    'test', 'run', 'P/R/S/T',
    '--agent', script,
    '--cwd', path.dirname(script)
  ], { env: { ...process.env, TASKBOARD_HOME: tmp.dir }, encoding: 'utf8' })

  const parsed = JSON.parse(out.stdout)
  assert.equal(parsed.waited, true)
  assert.equal(parsed.run.status, 'success')
  assert.equal(parsed.reports.length, 1)
  assert.equal(parsed.reports[0].status, 'pass')
  assert.equal(parsed.reports[0].autoFinalized, true)
})

test('进程级：CLI release check 非 dry-run 收尾到终态并回写检查报告', async (t) => {
  const { tmp, store, task } = await setup()
  t.after(() => tmp.cleanup())
  const script = makeAgentScript(t, 'echo "静态检查: PASS - 无告警"')
  store.createTestCase(task.id, { name: '静态检查', prompt: '跑 lint', kind: 'code_check' })
  store.createReleaseItem(task.id, { name: '开灰度开关', kind: 'config' })
  store.db.close()

  const out = await execFileP(process.execPath, [
    path.resolve(import.meta.dirname, '../bin/taskboard.js'),
    'release', 'check', 'P/R/S/T',
    '--agent', script,
    '--cwd', path.dirname(script)
  ], { env: { ...process.env, TASKBOARD_HOME: tmp.dir }, encoding: 'utf8' })

  const parsed = JSON.parse(out.stdout)
  assert.equal(parsed.waited, true)
  assert.equal(parsed.run.status, 'success')
  assert.equal(parsed.reports.length, 1)
  assert.equal(parsed.reports[0].status, 'pass')
})

test('进程级：CLI test run --fanout 每条用例一个独立任务，各自收尾到自己的结论', async (t) => {
  const { tmp, store, task } = await setup()
  t.after(() => tmp.cleanup())
  // 两条独立任务各自跑同一个脚本：报告按自己的用例名取结论，
  // 证明 fan-out 下每条报告只认自己那条结论，不会被另一条带偏。
  const script = makeAgentScript(t, 'echo "用例A: PASS - 全绿"\necho "用例B: FAIL - 断言挂了"')
  store.createTestCase(task.id, { name: '用例A', prompt: '跑 A' })
  store.createTestCase(task.id, { name: '用例B', prompt: '跑 B' })
  store.db.close()

  const out = await execFileP(process.execPath, [
    path.resolve(import.meta.dirname, '../bin/taskboard.js'),
    'test', 'run', 'P/R/S/T',
    '--agent', script,
    '--cwd', path.dirname(script),
    '--fanout'
  ], { env: { ...process.env, TASKBOARD_HOME: tmp.dir }, encoding: 'utf8' })

  const parsed = JSON.parse(out.stdout)
  assert.equal(parsed.mode, 'fanout')
  assert.equal(parsed.waited, true)
  assert.equal(parsed.runs.length, 2, '两条用例各派一个任务')
  assert.equal(parsed.reports.length, 2)
  assert.ok(parsed.runs.every((r) => r.status === 'success'))
  // 每个 run 只带自己的用例名：fan-out 确实拆开了提示词
  assert.ok(parsed.runs.every((r) => (r.prompt.match(/用例\d/g) || []).length <= 1))
  assert.equal(parsed.reports.filter((r) => r.status === 'pass').length, 1)
  assert.equal(parsed.reports.filter((r) => r.status === 'fail').length, 1)
  assert.ok(parsed.reports.every((r) => r.autoFinalized === true))
})

test('进程级：CLI agent run retry 后用例报告随 child run 刷新（缺陷1回归）', async (t) => {
  const { tmp, store, task } = await setup()
  t.after(() => tmp.cleanup())
  // 重试继承父 run 的 agent / cwd，无法换脚本；用「首次失败、二次成功」的同一脚本，
  // 验证「重试 = 新执行」：报告必须跟到 child run 的结果，而不是停在旧 error。
  const scriptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-retry-agent-'))
  t.after(() => fs.rmSync(scriptDir, { recursive: true, force: true }))
  const marker = path.join(scriptDir, 'ran-once')
  const script = path.join(scriptDir, 'agent.sh')
  fs.writeFileSync(
    script,
    [
      '#!/bin/sh',
      `if [ ! -f "${marker}" ]; then`,
      `  touch "${marker}"`,
      '  echo "第一次执行失败" >&2',
      '  exit 1',
      'fi',
      'echo "登录回归: PASS - 重试后恢复"'
    ].join('\n') + '\n',
    { mode: 0o755 }
  )
  const c = store.createTestCase(task.id, { name: '登录回归', prompt: '跑 A' })
  store.db.close()

  // 第一次派单（失败）
  const first = JSON.parse(
    (await execFileP(process.execPath, [
      path.resolve(import.meta.dirname, '../bin/taskboard.js'),
      'test', 'run', 'P/R/S/T',
      '--agent', script,
      '--cwd', scriptDir
    ], { env: { ...process.env, TASKBOARD_HOME: tmp.dir }, encoding: 'utf8' })).stdout
  )
  assert.equal(first.run.status, 'failed')
  assert.equal(first.reports[0].status, 'error', '首次失败 → 报告 error')

  // 重试：同一脚本这次走成功分支。CLI agent run retry 新建 child run，
  // （本轮修复后）为用例随 child 开新 running 报告，child 终态再把它收尾。
  const retried = JSON.parse(
    (await execFileP(process.execPath, [
      path.resolve(import.meta.dirname, '../bin/taskboard.js'),
      'agent', 'run', 'retry', String(first.run.id),
      '--wait-timeout', '30'
    ], { env: { ...process.env, TASKBOARD_HOME: tmp.dir }, encoding: 'utf8' })).stdout
  )

  // 重新打开库核对：用例报告应随 child run 刷新为 pass，且验收报告取到重试结论。
  const db2 = tmp.openDb()
  const store2 = tmp.store.createStore(db2)
  assert.equal(retried.run.status, 'success', '重试的 child run 跑到成功')
  const childRunId = retried.run.id
  const reports = store2.listTestReports(task.id, {})
  assert.equal(reports.length, 2, '旧结论 + 重试执行各一条报告')
  const child = reports.find((r) => r.runId === childRunId)
  assert.ok(child, 'child run 上必须有该用例的报告（缺陷1回归点）')
  assert.equal(child.status, 'pass', 'child 报告随 child 终态刷新')
  assert.equal(child.caseId, c.id)
  const acceptance = store2.buildAcceptanceReport(task.id)
  assert.equal(acceptance.items[0].latestStatus, 'pass', '验收报告取重试后的结论')
  assert.equal(acceptance.totals.cases, 1, '仍是一条用例')
  store2.db.close()
})

test('进程级：CLI --no-wait 保留只派单语义（立即返回 running）', async (t) => {
  const { tmp, store, task } = await setup()
  t.after(() => tmp.cleanup())
  // 用 sleep 保证「不等」时进程一定还在跑
  const script = makeAgentScript(t, 'sleep 2\necho "登录回归: PASS"')
  store.createTestCase(task.id, { name: '登录回归', prompt: '跑 A' })
  store.db.close()

  const out = await execFileP(process.execPath, [
    path.resolve(import.meta.dirname, '../bin/taskboard.js'),
    'test', 'run', 'P/R/S/T',
    '--agent', script,
    '--cwd', path.dirname(script),
    '--no-wait'
  ], { env: { ...process.env, TASKBOARD_HOME: tmp.dir }, encoding: 'utf8' })

  const parsed = JSON.parse(out.stdout)
  assert.equal(parsed.waited, false)
  assert.equal(parsed.run.status, 'running')
})

test('进程级：CLI agent run 非前台任务同样收尾到终态（原缺陷：退出后永远 running）', async (t) => {
  const { tmp, store } = await setup()
  t.after(() => tmp.cleanup())
  const script = makeAgentScript(t, 'sleep 0.3\necho 跑完了')
  store.db.close()

  const out = await execFileP(process.execPath, [
    path.resolve(import.meta.dirname, '../bin/taskboard.js'),
    'agent', 'run', 'P/R/S/T',
    '--prompt', 'x',
    '--agent', script,
    '--cwd', path.dirname(script)
  ], { env: { ...process.env, TASKBOARD_HOME: tmp.dir }, encoding: 'utf8' })

  const parsed = JSON.parse(out.stdout)
  assert.equal(parsed.waited, true)
  assert.equal(parsed.run.status, 'success')
  assert.match(parsed.run.output, /跑完了/)
})

test('进程级：CLI agent run --no-wait 只派单，立即返回 running', async (t) => {
  const { tmp, store } = await setup()
  t.after(() => tmp.cleanup())
  const script = makeAgentScript(t, 'sleep 2')
  store.db.close()

  const out = await execFileP(process.execPath, [
    path.resolve(import.meta.dirname, '../bin/taskboard.js'),
    'agent', 'run', 'P/R/S/T',
    '--prompt', 'x',
    '--agent', script,
    '--cwd', path.dirname(script),
    '--no-wait'
  ], { env: { ...process.env, TASKBOARD_HOME: tmp.dir }, encoding: 'utf8' })

  const parsed = JSON.parse(out.stdout)
  assert.equal(parsed.waited, false)
  assert.equal(parsed.run.status, 'running')
})

test('进程级：CLI agent run --wait-timeout 到点如实返回 running + waitTimedOut', async (t) => {
  const { tmp, store } = await setup()
  t.after(() => tmp.cleanup())
  const script = makeAgentScript(t, 'sleep 5')
  store.db.close()

  const out = await execFileP(process.execPath, [
    path.resolve(import.meta.dirname, '../bin/taskboard.js'),
    'agent', 'run', 'P/R/S/T',
    '--prompt', 'x',
    '--agent', script,
    '--cwd', path.dirname(script),
    '--wait-timeout', '1'
  ], { env: { ...process.env, TASKBOARD_HOME: tmp.dir }, encoding: 'utf8' })

  // 超时不算失败：正常退出，如实标注仍在 running
  const parsed = JSON.parse(out.stdout)
  assert.equal(parsed.waited, true)
  assert.equal(parsed.waitTimedOut, true)
  assert.equal(parsed.run.status, 'running')
})

// ---------- checklist skipped 展示口径 ----------

test('checklist：必做项全部 skipped 时 ready=true，且 totals 单列 skipped 不误报「已完成 0」', async (t) => {
  const { tmp, store, r } = await setup()
  t.after(() => tmp.cleanup())
  store.createReleaseItem(r.id, { name: '本次不上线的 SQL', kind: 'sql', status: 'skipped' })
  const checklist = store.buildReleaseChecklist(r.id)
  assert.equal(checklist.ready, true)
  assert.equal(checklist.totals.done, 0)
  assert.equal(checklist.totals.skipped, 1)
  const { renderReleaseChecklistMd } = await import('../server/ops.mjs')
  const md = renderReleaseChecklistMd(checklist)
  assert.ok(md.includes('完成：0'))
  assert.ok(md.includes('跳过：1'))
})

test('checklist：done 与 skipped 混合时分别计数', async (t) => {
  const { tmp, store, r } = await setup()
  t.after(() => tmp.cleanup())
  store.createReleaseItem(r.id, { name: 'SQL', kind: 'sql', status: 'done' })
  store.createReleaseItem(r.id, { name: '开关', kind: 'config', status: 'skipped' })
  store.createReleaseItem(r.id, { name: '监控', kind: 'check', status: 'pending' })
  const checklist = store.buildReleaseChecklist(r.id)
  assert.equal(checklist.ready, false)
  assert.equal(checklist.totals.done, 1)
  assert.equal(checklist.totals.skipped, 1)
  assert.equal(checklist.totals.pending, 1)
})

// ---------- 测试第 6 节建议：低成本边界用例 ----------

test('边界：upsert 只传 content 时不静默清掉 rollback / status / required（第 6 节第 3 点）', async (t) => {
  const { tmp, store, r } = await setup()
  t.after(() => tmp.cleanup())
  const first = store.upsertReleaseItem(r.id, {
    name: '执行上线 SQL',
    kind: 'sql',
    content: 'v1',
    rollback: 'DROP 语句',
    status: 'ready',
    required: 1
  })
  assert.equal(first.created, true)

  // 只想改正文，不该把回滚 / 状态 / 必做清掉
  const second = store.upsertReleaseItem(r.id, { name: '执行上线 SQL', content: 'v2' })
  assert.equal(second.created, false)
  assert.equal(second.content, 'v2')
  assert.equal(second.rollback, 'DROP 语句')
  assert.equal(second.status, 'ready')
  assert.equal(second.required, true)
  assert.equal(second.kind, 'sql')
})

test('边界：upsert 新建时未传字段仍取默认值', async (t) => {
  const { tmp, store, r } = await setup()
  t.after(() => tmp.cleanup())
  const item = store.upsertReleaseItem(r.id, { name: '仅名字' })
  assert.equal(item.created, true)
  assert.equal(item.kind, 'config')
  assert.equal(item.content, '')
  assert.equal(item.rollback, null)
  assert.equal(item.status, 'pending')
  assert.equal(item.required, true)
})

test('边界：名称首尾空白视作同名（唯一性按 trim 后判定）', async (t) => {
  const { tmp, store, r } = await setup()
  t.after(() => tmp.cleanup())
  const a = store.createReleaseItem(r.id, { name: '  执行上线 SQL  ' })
  assert.equal(a.name, '执行上线 SQL')
  assert.throws(() => store.createReleaseItem(r.id, { name: '执行上线 SQL' }), /RELEASE_ITEM_NAME_EXISTS/)
  // upsert 同样命中同一条，不新建
  const up = store.upsertReleaseItem(r.id, { name: ' 执行上线 SQL ', content: 'x' })
  assert.equal(up.created, false)
  assert.equal(up.id, a.id)
})

test('边界：大小写不同视作不同名（当前为大小写敏感，与文档一致）', async (t) => {
  const { tmp, store, r } = await setup()
  t.after(() => tmp.cleanup())
  store.createReleaseItem(r.id, { name: 'DeploySQL' })
  // 明确当前口径：大小写敏感，二者共存；改口径需连同文档与 UI 一起动
  const other = store.createReleaseItem(r.id, { name: 'deploysql' })
  assert.ok(other.id > 0)
  assert.equal(store.listReleaseItems(r.id).length, 2)
})

test('边界：release check scope=subtree 纳入子树的上线项与检查用例（第 6 节第 5 点）', async (t) => {
  const { tmp, store, r, s } = await setup()
  t.after(() => tmp.cleanup())
  store.createReleaseItem(s.id, { name: '子树的上线 SQL', kind: 'sql' })
  store.createTestCase(s.id, { name: '子树静态检查', prompt: '跑 lint', kind: 'code_check' })
  const { runReleaseChecks } = await import('../server/ops.mjs')

  // self 下「本节点空、子树有」应给出去用 subtree 的明确提示，而不是笼统报空
  assert.throws(
    () => runReleaseChecks(store, r.id, { dryRun: true }),
    (e) => e.code === 'VALIDATION_FAILED' && /scope=subtree/.test(e.message)
  )

  const subtree = runReleaseChecks(store, r.id, { dryRun: true, scope: 'subtree' })
  assert.equal(subtree.scope, 'subtree')
  assert.equal(subtree.items.length, 1)
  assert.equal(subtree.cases.length, 1)
  assert.ok(subtree.prompt.includes('子树的上线 SQL'))
  assert.ok(subtree.prompt.includes('子树静态检查'))
  assert.equal(subtree.ready, false)
})
