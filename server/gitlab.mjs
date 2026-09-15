/**
 * GitLab API 客户端（v1 仅只读 MR 拉取）。
 *
 * 决策 #5 / #6：MR 按「GitLab 项目 + 源分支」自动拉取；token 只存在本机
 * ~/.taskboard/config.json（600），接口返回时打码。这里使用内置 fetch，
 * 10 秒超时，最多 3 页（300 条）。
 */
import { AppError, CODES } from './errors.mjs'

const MAX_PAGES = 3
const PER_PAGE = 100
const TIMEOUT_MS = 10_000

function baseUrl(cfg) {
  return String((cfg && cfg.gitlab && cfg.gitlab.base_url) || '').replace(/\/$/, '')
}
function token(cfg) {
  return String((cfg && cfg.gitlab && cfg.gitlab.token) || '')
}

async function fetchJson(url, tokenValue) {
  let res
  try {
    res = await fetch(url, {
      headers: { 'PRIVATE-TOKEN': tokenValue },
      signal: AbortSignal.timeout(TIMEOUT_MS)
    })
  } catch (e) {
    throw new AppError(CODES.GITLAB_UNAVAILABLE, `连不上 GitLab：${e.message}`)
  }
  if (res.status === 401) throw new AppError(CODES.GITLAB_AUTH_FAILED, 'token 无效或已过期')
  if (res.status === 404) throw new AppError(CODES.GITLAB_PROJECT_NOT_FOUND, 'GitLab 项目不存在或路径错误')
  if (!res.ok) throw new AppError(CODES.GITLAB_UNAVAILABLE, `GitLab 返回 ${res.status}`)
  try {
    return await res.json()
  } catch (e) {
    throw new AppError(CODES.GITLAB_UNAVAILABLE, `GitLab 响应不是合法 JSON：${e.message}`)
  }
}

/** 断言配置可用；未配置 → GITLAB_NOT_CONFIGURED（引导去设置页）。 */
export function assertGitlabConfigured(cfg) {
  const base = baseUrl(cfg)
  const tk = token(cfg)
  if (!base || !tk) {
    throw new AppError(CODES.GITLAB_NOT_CONFIGURED, '请先在设置里填写 GitLab 地址与 token', {
      base_url: base || null
    })
  }
  return { base, token: tk }
}

/**
 * 拉取某项目某源分支的 MR（打开 + 已合并 + 已关闭），最多 3 页。
 * 返回映射后的数组；任何失败抛稳定错误码，调用方须保持既有数据不变。
 */
export async function fetchMergeRequests(cfg, project, sourceBranch) {
  const { base, token: tk } = assertGitlabConfigured(cfg)
  const encoded = encodeURIComponent(project)
  const out = []
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const url =
      `${base}/api/v4/projects/${encoded}/merge_requests` +
      `?source_branch=${encodeURIComponent(sourceBranch)}&state=all&per_page=${PER_PAGE}&page=${page}`
    const rows = await fetchJson(url, tk)
    if (!Array.isArray(rows)) throw new AppError(CODES.GITLAB_UNAVAILABLE, 'GitLab MR 响应结构异常（预期数组）')
    for (const r of rows) {
      out.push({
        iid: Number(r.iid),
        title: r.title ?? null,
        state: r.state ?? null,
        sourceBranch: r.source_branch ?? sourceBranch,
        webUrl: r.web_url ?? null,
        updatedAt: r.updated_at ?? null
      })
    }
    if (rows.length < PER_PAGE) break
  }
  return out
}
