import { execFile } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { openDb } from './db.mjs'
import { createStore } from './store.mjs'
import { createApp } from './http.mjs'
import { ensureLocalRuntime } from './agent.mjs'
import { loadConfig, DB_PATH } from './config.mjs'
import { mountSpa } from './static.mjs'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const DIST = path.join(ROOT, '..', 'web', 'dist')

function listen(app, port) {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, '127.0.0.1')
    server.once('listening', () => resolve(server))
    server.once('error', reject)
  })
}

/** 启动本地服务：默认端口取 config.port（3210），被占用则依次 +1，最多试 10 个 */
export async function startServer({ port, open = true, host = '127.0.0.1' } = {}) {
  const cfg = loadConfig()
  const db = openDb()
  const store = createStore(db, {
    docPresets: cfg.docPresets,
    readiness: cfg.readiness,
    status: cfg.status,
    releaseSqlAudit: cfg.releaseSqlAudit
  })
  store.failStaleAgentRuns()
  // 本机服务自身就是一个 daemon：启动时把本机默认 CLI 运行时注册为在线
  try {
    ensureLocalRuntime(store, 'qodercli', 'system')
  } catch {
    /* 运行时注册失败不阻断服务启动 */
  }
  const app = createApp({ store })
  // 前端构建产物静态托管 + SPA 回退（抽到 static.mjs 以便在生产形态布局下做 UT）
  mountSpa(app, { dist: DIST })

  const basePort = Number(port || cfg.port)
  let server = null
  let usedPort = null
  let lastErr = null
  for (let p = basePort; p <= basePort + 10; p += 1) {
    try {
      server = await listen(app, p)
      usedPort = p
      break
    } catch (e) {
      lastErr = e
      if (e.code !== 'EADDRINUSE') throw e
    }
  }
  if (!server) throw new Error(`端口 ${basePort}~${basePort + 10} 都被占用：${lastErr?.message}`)

  const url = `http://${host === '0.0.0.0' ? 'localhost' : host}:${usedPort}`
  console.log(`task-board 已启动：${url}`)
  console.log(`数据文件：${DB_PATH}`)
  if (open) execFile('open', [url], () => {})
  return { url, port: usedPort, server, store, db, app }
}

const isDirect = process.argv[1] && process.argv[1].endsWith('server/index.mjs')
if (isDirect) {
  startServer({ open: process.env.TASKBOARD_NO_OPEN !== '1' }).catch((e) => {
    console.error(`${e.code || 'ERROR'}: ${e.message}`)
    process.exit(1)
  })
}
