import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)
const SCRIPT = path.resolve(import.meta.dirname, '../scripts/e2e-mainline.mjs')

/**
 * 主链路端到端回归（需求 → 交付门禁）作为**守门测试**：
 * scripts/e2e-mainline.mjs 走 CLI / HTTP 公开入口跑完整链路，本用例在独立进程里执行它，
 * 断言退出码为 0（内部每一步都带断言），并抽查输出里关键里程碑出现，避免脚本被改坏后静默通过。
 *
 * 独立 HOME 隔离，绝不碰真实 ~/.taskboard。
 */
test('主链路端到端回归（需求 → 交付门禁）：脚本全链路通过', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-e2e-guard-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))

  const { stdout } = await execFileP('node', [SCRIPT], {
    env: { ...process.env, TASKBOARD_HOME: home },
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024
  })

  assert.match(stdout, /全链路通过/, '脚本应报告全链路通过')
  // 关键里程碑：需求管理 / 概要设计 / 思维导图 / 就绪门禁 / 上线治理 / 交付门禁两态 / 三入口一致
  for (const milestone of [
    '需求管理：requirement_create',
    '概要设计：写入「概要设计」文档',
    '思维导图：',
    '需求就绪门禁通过',
    '上线检查：必做项完成但检查用例未跑 → ready=false',
    '交付门禁：正确判定 not_ready',
    '交付门禁：证据齐备后 decision=ready',
    '三入口 1:1'
  ]) {
    assert.ok(stdout.includes(milestone), `输出应包含里程碑：${milestone}`)
  }
})
