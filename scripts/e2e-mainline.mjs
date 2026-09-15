/**
 * 主链路端到端回归（需求 → 交付门禁）。
 *
 * 覆盖本轮集成的五条能力：需求管理 → 概要设计大纲 → 文档 → 思维导图 → 用例/报告 →
 * 验收签收 → 上线治理 → 交付门禁。全流程只走 **CLI / HTTP 公开入口**（不直接调 store），
 * 因此它验证的是「用户与 AI 真实能跑通的链路」，而不是内部函数。
 *
 * 用法：
 *   TASKBOARD_HOME=$(mktemp -d) node scripts/e2e-mainline.mjs
 * 退出码 0 = 全链路通过；非 0 = 有断言失败（打印首个失败点）。
 *
 * 设计原则：每一步都打印 `✓ <步骤>` 便于人工核对；断言失败立刻抛错并带上上下文。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)
const CLI = path.resolve(import.meta.dirname, '../bin/taskboard.js')
const HOME = process.env.TASKBOARD_HOME || fs.mkdtempSync(path.join(os.tmpdir(), 'tb-e2e-'))
// 关键：本进程随后会 openDb() 做 HTTP 入口抽查，必须与 CLI 子进程指向同一个隔离库，
// 否则会落到真实 ~/.taskboard 读数据（测试污染 + 断言错乱）。
process.env.TASKBOARD_HOME = HOME

const step = (msg) => console.log(`✓ ${msg}`)
const fail = (msg, extra) => {
  console.error(`✗ ${msg}`)
  if (extra !== undefined) console.error('  ', typeof extra === 'string' ? extra : JSON.stringify(extra, null, 2))
  process.exit(1)
}

async function cli(args, { expectFail = false } = {}) {
  try {
    const { stdout } = await execFileP('node', [CLI, ...args], {
      env: { ...process.env, TASKBOARD_HOME: HOME },
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024
    })
    return stdout.trim() ? JSON.parse(stdout) : null
  } catch (e) {
    if (expectFail) return { error: String(e.stderr || e.stdout || e.message) }
    fail(`CLI 失败：taskboard ${args.join(' ')}`, String(e.stderr || e.stdout || e.message))
  }
}

async function cliRaw(args) {
  const { stdout } = await execFileP('node', [CLI, ...args], {
    env: { ...process.env, TASKBOARD_HOME: HOME },
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024
  })
  return stdout
}

function assert(cond, msg, extra) {
  if (!cond) fail(msg, extra)
}

async function httpServer(store) {
  const { createApp } = await import('../server/http.mjs')
  const server = await new Promise((resolve, reject) => {
    const s = createApp({ store }).listen(0, '127.0.0.1', () => resolve(s))
    s.once('error', reject)
  })
  return { server, base: `http://127.0.0.1:${server.address().port}` }
}

async function main() {
  console.log(`# 主链路端到端回归\n# TASKBOARD_HOME=${HOME}\n`)

  // ---------- 1. 需求管理：建项目 / 建需求（受控状态流转） ----------
  await cli(['node', 'upsert', '--path', 'E2E项目', '--type', 'project'])
  const req = await cli(['requirement', 'create', '--project', 'E2E项目', '--name', '端到端需求'])
  step(`需求管理：requirement_create 建需求 #${req.id}，初始状态 ${req.status}`)
  assert(req.type === 'requirement', '需求类型应为 requirement', req)

  const moved = await cli(['requirement', 'transition', String(req.id), '--status', 'doing'])
  step(`需求管理：受控状态流转 → ${moved.status}`)
  assert(moved.status === 'doing', '状态应流转为 doing', moved)

  // 非法状态必须被拦（不静默接受）
  const bad = await cli(['requirement', 'transition', String(req.id), '--status', '不存在的状态'], { expectFail: true })
  assert(/VALIDATION_FAILED/.test(bad.error), '非法状态应返回 VALIDATION_FAILED', bad.error)
  step('需求管理：非法状态被拒（VALIDATION_FAILED）')

  // 需求创建时自动关联两份核心文档（需求内容 / 概要设计）
  const reqDocs = await cli(['doc', 'list', String(req.id)])
  const docNames = reqDocs.map((d) => d.name)
  assert(docNames.includes('需求内容') && docNames.includes('概要设计'), '需求应自动关联两份核心文档', docNames)
  step(`需求管理：核心文档槽位齐备 [${docNames.join(', ')}]`)

  // ---------- 2. 文档：写需求内容 ----------
  await cli(['doc', 'upsert', String(req.id), '--name', '需求内容', '--content', '## 背景\n端到端回归用的需求正文。'])
  step('文档：写入「需求内容」正文')

  // ---------- 3. 概要设计大纲（从需求树推导 → 写入「概要设计」文档） ----------
  await cli(['node', 'upsert', '--path', 'E2E项目/端到端需求/子需求A', '--type', 'subreq'])
  await cli(['node', 'upsert', '--path', 'E2E项目/端到端需求/子需求A/任务组', '--type', 'group'])
  // 子需求也要各自具备需求内容 / 概要设计 / 可回归用例，scope=subtree 才会整体就绪
  const sub = await cli(['node', 'get', 'E2E项目/端到端需求/子需求A'])
  await cli(['doc', 'upsert', String(sub.id), '--name', '需求内容', '--content', '## 子需求\n拆解说明。'])
  await cli(['test', 'case', 'upsert', String(sub.id), '--name', '子需求回归用例', '--prompt', '跑子需求单测'])
  const outline = await cli(['design', 'outline', String(req.id), '--scope', 'subtree'])
  assert(outline.totals.units >= 1, '概要设计大纲应至少推导出 1 个需求单元', outline.totals)
  const outlineMd = await cliRaw(['design', 'outline', String(req.id), '--scope', 'subtree', '--format', 'md'])
  assert(/```mermaid/.test(outlineMd), '大纲 markdown 应含 mermaid 脑图', outlineMd.slice(0, 300))
  step(`概要设计：推导大纲（${outline.totals.units} 单元 / ${outline.totals.nodes} 节点）且含 mermaid 脑图`)

  const applied = await cli(['design', 'apply', String(req.id), '--scope', 'subtree'])
  assert(applied.written >= 1, '概要设计应至少写入 1 份文档', applied)
  step(`概要设计：写入「概要设计」文档（written=${applied.written}）`)

  // 幂等与安全：再次 apply 不应覆盖已填内容
  const reapply = await cli(['design', 'apply', String(req.id), '--scope', 'subtree'])
  assert(reapply.written === 0 && reapply.skipped >= 1, '重复 apply 应跳过已填内容', reapply)
  step('概要设计：重复 apply 不覆盖已填内容（written=0）')

  // ---------- 4. 思维导图（树 → mermaid mindmap 只读投影） ----------
  const mindmap = await cli(['mindmap', String(req.id), '--scope', 'subtree'])
  assert(mindmap.mermaid.startsWith('mindmap'), '导图首行应为 mindmap', mindmap.mermaid)
  assert(mindmap.totals.nodes >= 3, '导图应包含需求 / 子需求 / 任务组', mindmap.totals)
  assert(mindmap.totals.edges === mindmap.totals.nodes - 1, '树性质：edges = nodes - 1', mindmap.totals)
  step(`思维导图：${mindmap.totals.nodes} 节点 / ${mindmap.totals.edges} 连接 / 深度 ${mindmap.totals.depth}`)

  // 深度截断 + 非法参数
  const truncated = await cli(['mindmap', String(req.id), '--scope', 'subtree', '--max-depth', '1'])
  assert(truncated.totals.truncated >= 1, 'max-depth=1 应发生截断', truncated.totals)
  const badDepth = await cli(['mindmap', String(req.id), '--max-depth', '999'], { expectFail: true })
  assert(/VALIDATION_FAILED/.test(badDepth.error), '非法 maxDepth 应返回 VALIDATION_FAILED', badDepth.error)
  step('思维导图：深度截断计数 + 非法 maxDepth 被拒')

  // ---------- 5. AI 可回归测试：登记用例 → 派单（dry-run） ----------
  const tc = await cli(['test', 'case', 'upsert', String(req.id), '--name', '端到端回归用例', '--prompt', '跑主链路冒烟'])
  const tcCode = await cli(['test', 'case', 'upsert', String(req.id), '--name', '代码检查用例', '--prompt', '跑 lint', '--kind', 'code_check'])
  const tcBiz = await cli(['test', 'case', 'upsert', String(req.id), '--name', '业务检查用例', '--prompt', '跑业务校验', '--kind', 'biz_check'])
  step(`AI 可回归测试：登记 ${[tc.kind, tcCode.kind, tcBiz.kind].join(' / ')} 三类用例`)

  const dry = await cli(['test', 'run', String(req.id), '--kind', 'regression', '--dry-run'])
  assert(dry.dryRun === true && dry.cases.length === 1, 'dry-run 应只回待跑用例、不落库', dry)
  step('AI 可回归测试：test run dry-run 命中 1 条 regression 用例且不派单')

  // ---------- 6. 需求就绪门禁（需求内容 + 概要设计 + 可回归用例） ----------
  const readiness = await cli(['readiness', 'check', String(req.id), '--scope', 'subtree'])
  assert(readiness.ready === true, '三条门禁齐备后 readiness 应为 true', readiness.items)
  step(`需求管理：需求就绪门禁通过（${readiness.totals.checks} 项门禁，通过 ${readiness.totals.passed}）`)

  // ---------- 7. 测试报告 + 验收报告 + 验收签收 ----------
  const cases = await cli(['test', 'case', 'list', String(req.id)])
  const regressionCase = cases.find((c) => c.kind === 'regression')
  const report = await cli(['test', 'report', 'list', String(req.id)])
  assert(Array.isArray(report), '报告列表应可读', report)
  step(`测试报告：可读报告列表（${report.length} 条）`)

  const acceptance = await cli(['test', 'acceptance', String(req.id), '--scope', 'subtree'])
  assert(acceptance && typeof acceptance.passRate !== 'undefined', '验收报告应可聚合', acceptance)
  step(`验收报告：passRate=${acceptance.passRate}（${acceptance.totals.cases} 条用例）`)

  // 签收按 (node, scope) 存储；交付门禁用 subtree 口径查，因此签收视必须同 scope，
  // 否则会出现「签了 self、门禁查 subtree」的错配（这里刻意显式带上 scope）。
  const sign = await cli(['test', 'acceptance-sign', String(req.id), '--decision', 'accepted', '--scope', 'subtree', '--comment', '端到端回归通过'])
  assert(sign.decision === 'accepted' && sign.stale === false, '验收签收应记录 accepted 且未失效', sign)
  assert(sign.scope === 'subtree', '签收 scope 应为 subtree（与交付门禁口径一致）', sign.scope)
  step(`验收签收：accepted（证据指纹 ${String(sign.evidenceFingerprint).slice(0, 12)}…）`)

  const signStatus = await cli(['test', 'acceptance-status', String(req.id), '--scope', 'subtree'])
  assert(signStatus.state === 'accepted', '签收状态应可查询', signStatus)
  step(`验收签收：状态可查询（state=${signStatus.state}）`)

  // ---------- 8. 上线治理：上线配置 / 上线 SQL / 上线检查 ----------
  await cli(['release', 'item', 'upsert', String(req.id), '--name', '上线配置项', '--kind', 'config', '--content', 'feature.e2e=true'])
  await cli(['release', 'item', 'upsert', String(req.id), '--name', '上线 SQL', '--kind', 'sql', '--content', 'ALTER TABLE e2e ADD COLUMN x INT', '--rollback', 'ALTER TABLE e2e DROP COLUMN x'])
  const items = await cli(['release', 'item', 'list', String(req.id)])
  assert(items.length === 2, '应登记 2 条上线项', items)
  step(`上线治理：登记 ${items.map((i) => i.kind).join(' / ')} 上线项`)

  let checklist = await cli(['release', 'checklist', String(req.id), '--scope', 'subtree'])
  assert(checklist.ready === false, '必做项未完成时上线清单不应 ready', checklist.totals)
  step(`上线检查：必做项未完成 → ready=${checklist.ready}（阻塞 ${checklist.blockers.length} 项）`)

  for (const it of items) await cli(['release', 'item', 'update', String(it.id), '--status', 'done'])
  checklist = await cli(['release', 'checklist', String(req.id), '--scope', 'subtree'])
  // 决策 42：就绪 = 必做项全完成 **且** 检查用例全部 pass。
  // 本步骤只完成必做项，登记在册的 code_check / biz_check 仍无结论（not_run），
  // 因此这里必须仍是 not ready——先证「只完成必做项不足以放行」。
  assert(checklist.ready === false, '必做项完成但检查用例未执行时上线清单不应 ready', checklist.totals)
  assert(checklist.totals.checkBlocking > 0, '检查用例未执行应计入阻塞', checklist.totals)
  step(`上线检查：必做项完成但检查用例未跑 → ready=false（检查阻塞 ${checklist.totals.checkBlocking} 条）`)

  // ---------- 9. 交付门禁（需求就绪 + 测试验收 + 上线治理 + 代码推送的最终汇总） ----------
  const gate = await cli(['delivery', 'gate', String(req.id), '--scope', 'subtree'])
  assert(['ready', 'not_ready', 'unknown'].includes(gate.decision), '交付门禁应给出确定结论', gate)
  step(`交付门禁：decision=${gate.decision}，来源 ${gate.sources.map((s) => `${s.label}=${s.status}`).join(' / ')}`)

  // 关键断言：本轮是开发阶段集成，尚未派发测试（PM 明确测试阶段后续另行派发），
  // 因此交付门禁必须**正确地判定为不可交付**。需求就绪已通过；
  // 测试验收与上线治理（决策 42 后含检查用例）都因为「检查/回归用例尚无结论」而 fail——
  // 这正是「必做项 done ≠ 可交付」的门禁语义，证明门禁不是无脑绿灯。
  assert(gate.decision === 'not_ready', '未派发测试时交付门禁应为 not_ready（不得伪造成可交付）', gate.decision)
  const byLabel = Object.fromEntries(gate.sources.map((s) => [s.key, s.status]))
  assert(byLabel.readiness === 'pass', '需求就绪来源应为 pass', byLabel)
  assert(byLabel.acceptance === 'fail', '测试验收来源应为 fail（尚无测试证据）', byLabel)
  assert(byLabel.release === 'fail', '上线治理来源应为 fail（检查用例尚无结论）', byLabel)
  step('交付门禁：正确判定 not_ready——需求就绪 pass / 测试验收 fail（无证据）/ 上线治理 fail（检查用例未跑）')

  const gateMd = await cliRaw(['delivery', 'gate', String(req.id), '--scope', 'subtree', '--format', 'md'])
  assert(/^# 交付门禁/m.test(gateMd), '交付门禁应可导出 markdown', gateMd.slice(0, 200))
  step('交付门禁：可导出 markdown 交付记录')

  // ---------- 9b. 证明门禁能真正转绿：模拟「执行者回写测试证据」 ----------
  // 派单链路（ops.runTestCases）会为每条用例开一条 running 报告，执行者跑完后调用
  // `test report finish` 回写终态。完整派单会真正拉起 qodercli 进程，属于 PM 后续要单独
  // 派发的「测试阶段」，因此这里用同一套核心 API 开报告（等价于派单时的那一步），
  // 再用**公开 CLI 入口**回写结论，验证「有证据 → 门禁转绿」这条路径确实通。
  {
    const { createStore } = await import('../server/store.mjs')
    const { openDb } = await import('../server/db.mjs')
    const store = createStore(openDb())
    // 验收来源聚合子树内**全部启用用例**（regression / code_check / biz_check 都算证据），
    // 因此要把需求与子需求上的每条用例都跑出结论，门禁才会整体转绿。
    const targets = [...(await cli(['test', 'case', 'list', String(req.id)])), ...(await cli(['test', 'case', 'list', String(sub.id)]))]
    assert(targets.length >= 4, '应至少登记 4 条用例（需求 3 条 + 子需求 1 条）', targets.map((c) => c.name))

    for (const c of targets) {
      const opened = store.createTestReport(c.nodeId, { caseId: c.id, kind: c.kind, status: 'running', summary: `已派单执行：${c.name}` }, 'system')
      // 公开 CLI 入口回写终态（与执行者收尾同一条入口）
      await cli(['test', 'report', 'finish', String(opened.id), '--status', 'pass', '--summary', `${c.name} 通过`])
    }
    step(`测试证据：为 ${targets.length} 条启用用例（regression / code_check / biz_check）开报告并回写 pass`)

    // 证据变化会让此前的签收指纹失效（stale）——这是设计行为，正好顺带验证。
    // 签收是「对某一份具体证据」的背书，因此补完证据后需要重新签收。
    const staleStatus = await cli(['test', 'acceptance-status', String(req.id), '--scope', 'subtree'])
    assert(staleStatus.state !== 'accepted', '测试证据变化后原签收应失效（不再 accepted）', staleStatus.state)
    step(`验收签收：测试证据变化后原签收自动失效（state=${staleStatus.state}）`)
    await cli(['test', 'acceptance-sign', String(req.id), '--decision', 'accepted', '--scope', 'subtree', '--comment', '证据齐备后重新签收'])
    step('验收签收：对最新证据重新签收 accepted')

    const greenGate = await cli(['delivery', 'gate', String(req.id), '--scope', 'subtree'])
    assert(greenGate.decision === 'ready', '测试证据齐备后交付门禁应转为 ready', greenGate)
    step(`交付门禁：证据齐备后 decision=${greenGate.decision}（来源 ${greenGate.sources.map((s) => `${s.label}=${s.status}`).join(' / ')}）`)

    const greenMd = await cliRaw(['delivery', 'gate', String(req.id), '--scope', 'subtree', '--format', 'md'])
    assert(/- 交付结论：可交付/.test(greenMd), 'markdown 交付记录应显示可交付', greenMd.slice(0, 200))
    step('交付门禁：可导出「可交付」的 markdown 交付记录')
  }

  // ---------- 10. HTTP 入口一致性（三入口 1:1 抽查） ----------
  const { createStore } = await import('../server/store.mjs')
  const { openDb } = await import('../server/db.mjs')
  const store = createStore(openDb())
  const { server, base } = await httpServer(store)
  try {
    const httpReadiness = await (await fetch(`${base}/api/nodes/${req.id}/readiness?scope=subtree`)).json()
    assert(httpReadiness.ready === readiness.ready, 'HTTP readiness 应与 CLI 一致', httpReadiness)
    const httpMindmap = await (await fetch(`${base}/api/nodes/${req.id}/mindmap?scope=subtree`)).json()
    assert(httpMindmap.mermaid === mindmap.mermaid, 'HTTP mindmap 应与 CLI 的 mermaid 逐字节一致')
    const httpGate = await (await fetch(`${base}/api/nodes/${req.id}/delivery-gate?scope=subtree`)).json()
    // 与「证据齐备后」的 CLI 结论对比（此时门禁应为 ready）
    assert(httpGate.decision === 'ready', 'HTTP 交付门禁结论应与 CLI 一致（ready）', httpGate)
    step('三入口 1:1：HTTP 与 CLI 的 readiness / mindmap / delivery-gate 结论一致')
  } finally {
    await new Promise((res) => server.close(res))
  }

  console.log('\n# 全链路通过 ✅')
}

main().catch((e) => fail('未捕获异常', e && e.stack ? e.stack : String(e)))
