import express from 'express'
import fs from 'node:fs'
import { AppError, CODES } from './errors.mjs'
import { buildSchema, renderTreeMd, upsertByPath, importOutline, applyBatch, getCommitDiff, getNodeDiffs, getCommitTrack, getNodeTracks, getCombinedDiff, getNodeDuplicates, approveAndMerge, getMergeStatus, previewMerges, mergeUpstream, runTestCases, renderAcceptanceMd, renderAcceptanceStatusMd, runReleaseChecks, renderReleaseChecklistMd, renderReadinessMd, renderMindmapMd, renderDeliveryGateMd, renderDesignOutlineMd, applyDesignOutline, renderTestReportMd, setupWorkspace, getWorkspacePrompt, cleanupWorkspace, renderSecretScanMd, renderDeliverySnapshotMd, renderReleaseSqlAuditMd, renderCodeAuditMd, getNodeCodeAudit, renderBusinessGateMd } from './ops.mjs'
import { startAgentRun, retryAndDispatch } from './agent.mjs'
import { resolveRepoDir, pickBranchForCommit } from './git.mjs'
import { loadConfig, saveConfig, maskToken, UPLOAD_DIR } from './config.mjs'
import { saveUpload } from './uploads.mjs'

const STATUS_BY_CODE = {
  [CODES.VALIDATION_FAILED]: 400,
  [CODES.PARENT_TYPE_INVALID]: 400,
  [CODES.LEAF_NODE]: 400,
  [CODES.CYCLE_DETECTED]: 400,
  [CODES.CONFIRM_REQUIRED]: 400,
  [CODES.REPO_NOT_REGISTERED]: 400,
  [CODES.REPO_PATH_MISSING]: 400,
  [CODES.BRANCH_NOT_FOUND]: 400,
  [CODES.BRANCH_EXISTS_DIFFERENT_BASE]: 400,
  [CODES.WORKTREE_PATH_EXISTS]: 409,
  [CODES.NOT_FOUND]: 404,
  [CODES.PATH_NOT_FOUND]: 404,
  [CODES.PATH_AMBIGUOUS]: 409,
  [CODES.DOC_NAME_EXISTS]: 409,
  [CODES.TEST_CASE_NAME_EXISTS]: 409,
  [CODES.RELEASE_ITEM_NAME_EXISTS]: 409,
  [CODES.REPORT_STATUS_IMMUTABLE]: 409,
  [CODES.UPLOAD_INVALID_TYPE]: 400,
  [CODES.UPLOAD_TOO_LARGE]: 400,
  [CODES.PAYLOAD_TOO_LARGE]: 413,
  [CODES.GITLAB_NOT_CONFIGURED]: 400,
  [CODES.GITLAB_AUTH_FAILED]: 502,
  [CODES.GITLAB_PROJECT_NOT_FOUND]: 502,
  [CODES.GITLAB_UNAVAILABLE]: 502,
  [CODES.GIT_UNAVAILABLE]: 500,
  [CODES.GIT_FAILED]: 500
}

/** 统一的错误体：{ error: { code, message, details } } */
function errorBody(err) {
  const code = err.code || 'INTERNAL_ERROR'
  return { error: { code, message: err.message, ...(err.details !== undefined ? { details: err.details } : {}) } }
}

/**
 * body-parser / express 抛出的框架错误没有稳定业务码（`err.code` 缺失或为框架私有值），
 * 直接透传会让客户端错误落到 500。这里按 `err.type` / `err.status` 归一到业务码。
 * 返回 null 表示不是框架错误，交给通用分支处理。
 */
function mapFrameworkError(err) {
  if (!err) return null
  const type = err.type
  if (type === 'entity.too.large') {
    return {
      status: 413,
      code: CODES.PAYLOAD_TOO_LARGE,
      message: '请求体超过上限（express.json 限额 20 MB；图片单张上限 10 MB）',
      details: { limit: '20mb', maxUploadBytes: 10 * 1024 * 1024 }
    }
  }
  if (type === 'entity.parse.failed') {
    return {
      status: 400,
      code: CODES.VALIDATION_FAILED,
      message: '请求体不是合法 JSON'
    }
  }
  if (type === 'charset.unsupported' || type === 'entity.verify.failed') {
    return { status: type === 'charset.unsupported' ? 415 : 403, code: CODES.VALIDATION_FAILED, message: err.message }
  }
  // send/sendFile 等静态层错误：保持 HTTP 状态码，但换成稳定业务 code。
  // 注意 send 的错误带的是**文件系统 errno**（如 `code: 'ENOENT'`），不是业务码——
  // 只判 `!err.code` 会漏掉它，进而落到通用分支按未知 code 报成 500。
  // 业务错误（AppError）没有 `err.status`，因此这里用 status 作为「框架/HTTP 层」的判据。
  if (typeof err.status === 'number' && err.status < 500 && !isBusinessCode(err.code)) {
    return {
      status: err.status,
      code: err.status === 404 ? CODES.NOT_FOUND : CODES.VALIDATION_FAILED,
      message: err.message || `HTTP ${err.status}`
    }
  }
  return null
}

/** 是否是本仓库定义的稳定业务码（由 AppError 产生） */
function isBusinessCode(code) {
  return typeof code === 'string' && Object.prototype.hasOwnProperty.call(CODES, code)
}

export function createApp({ store }) {
  const app = express()
  app.use(express.json({ limit: '20mb' }))

  const wrap = (fn) => (req, res, next) => {
    try {
      const out = fn(req, res)
      if (out && typeof out.then === 'function') out.catch(next)
    } catch (e) {
      next(e)
    }
  }
  const refOf = (req) => req.params.id
  const actorOf = (req) => (req.get('x-taskboard-actor') || req.body?.actor || req.query.actor || 'user')

  // ---------- 发现与读取 ----------

  app.get('/api/health', wrap((req, res) => res.json({ ok: true, revision: store.getRevision() })))

  // 图片上传：Vditor 粘贴 / 选择图片 → base64 JSON → 返回可被 Markdown 引用的 URL。
  // 静态访问由 index.mjs 的 express.static(UPLOAD_DIR) 提供（/uploads/:name）。
  app.post(
    '/api/uploads',
    wrap((req, res) => {
      const out = saveUpload({ name: req.body?.name, data: req.body?.data })
      res.status(201).json(out)
    })
  )

  app.get(
    '/api/schema',
    wrap((req, res) => res.json(buildSchema(store, loadConfig())))
  )

  app.get('/api/revision', wrap((req, res) => res.json({ revision: store.getRevision() })))

  app.get(
    '/api/tree',
    wrap((req, res) => {
      const tree = store.listTree()
      if (req.query.format === 'md') {
        res.type('text/markdown').send(renderTreeMd(store, tree))
        return
      }
      res.json({ revision: store.getRevision(), nodes: tree })
    })
  )

  app.get(
    '/api/nodes/:id',
    wrap((req, res) => {
      const node = store.resolveRef(refOf(req))
      res.json({
        ...node,
        attrs: store.getAttrs(node.id),
        documents: store.listDocuments(node.id),
        commits: store.listCommits(node.id),
        children: store.listChildren(node.id)
      })
    })
  )

  // ---------- 节点写入 ----------

  app.post(
    '/api/nodes',
    wrap((req, res) => {
      const { parentId = null, parentPath = null, type, name, status, attrs } = req.body || {}
      const pid = parentPath ? store.resolveRef(parentPath).id : parentId
      res.status(201).json(store.createNode({ parentId: pid, type, name, status, attrs, actor: actorOf(req) }))
    })
  )

  app.patch(
    '/api/nodes/:id',
    wrap((req, res) => {
      const node = store.resolveRef(refOf(req))
      const { name, status, parentId, parentPath, attrs, confirm } = req.body || {}
      const moving = parentId !== undefined || parentPath !== undefined
      if (moving && confirm !== true) {
        throw new AppError(CODES.CONFIRM_REQUIRED, `移动节点需要 confirm: true`, { ref: refOf(req) })
      }
      const patch = { name, status, attrs }
      if (moving) {
        patch.parentId = parentPath ? (parentPath === null ? null : store.resolveRef(parentPath).id) : parentId
      }
      res.json(store.updateNode(node.id, patch, actorOf(req)))
    })
  )

  app.delete(
    '/api/nodes/:id',
    wrap((req, res) => {
      const node = store.resolveRef(refOf(req))
      if (req.query.confirm !== 'true' && req.body?.confirm !== true) {
        throw new AppError(CODES.CONFIRM_REQUIRED, `删除节点 ${node.path} 需要 confirm`, { ref: refOf(req) })
      }
      res.json(store.deleteNode(node.id))
    })
  )

  app.post(
    '/api/nodes/reorder',
    wrap((req, res) => {
      const { parentId = null, parentPath = null, orderedIds } = req.body || {}
      const pid = parentPath ? store.resolveRef(parentPath).id : parentId
      res.json(store.reorderSiblings(pid, orderedIds || []))
    })
  )

  // ---------- 需求管理（需求条目 / 状态流转 / 文档关联） ----------

  app.get(
    '/api/requirements',
    wrap((req, res) => {
      let projectId = null
      if (req.query.projectId !== undefined) {
        const rawProjectId = String(req.query.projectId).trim()
        if (!/^\d+$/.test(rawProjectId)) {
          throw new AppError(CODES.VALIDATION_FAILED, `projectId 必须是正整数，收到 ${req.query.projectId}`, {
            projectId: req.query.projectId
          })
        }
        projectId = Number(rawProjectId)
      }
      const status = req.query.status || null
      res.json({
        revision: store.getRevision(),
        summary: store.requirementSummary({ projectId, status }),
        items: store.listRequirements({ projectId, status })
      })
    })
  )

  app.post(
    '/api/requirements',
    wrap((req, res) => {
      const { projectId, projectPath = null, name, attrs } = req.body || {}
      const pid = projectPath ? store.resolveRef(projectPath).id : projectId
      res.status(201).json(store.createRequirement({ projectId: pid, name, attrs, actor: actorOf(req) }))
    })
  )

  app.post(
    '/api/requirements/:id/transition',
    wrap((req, res) => {
      const node = store.resolveRef(refOf(req))
      res.json(store.transitionRequirement(node.id, { status: (req.body || {}).status, actor: actorOf(req) }))
    })
  )

  app.get(
    '/api/documents/overview',
    wrap((req, res) => {
      let projectId = null
      if (req.query.projectId !== undefined) {
        const rawProjectId = String(req.query.projectId).trim()
        if (!/^\d+$/.test(rawProjectId)) {
          throw new AppError(CODES.VALIDATION_FAILED, `projectId 必须是正整数，收到 ${req.query.projectId}`, {
            projectId: req.query.projectId
          })
        }
        projectId = Number(rawProjectId)
      }
      res.json(
        store.documentOverview({
          projectId,
          status: req.query.status || null,
          q: req.query.q || null,
          docName: req.query.docName || null,
          fill: req.query.fill || null
        })
      )
    })
  )

  app.post(
    '/api/nodes/upsert',
    wrap((req, res) => {
      const { path, type, attrs, dryRun } = req.body || {}
      const out = upsertByPath(store, path, { type, attrs, by: actorOf(req), dryRun: !!dryRun })
      res.json(out)
    })
  )

  app.post(
    '/api/batch',
    wrap((req, res) => {
      const { ops, dryRun } = req.body || {}
      res.json(applyBatch(store, ops || [], { dryRun: !!dryRun, by: actorOf(req) }))
    })
  )

  app.post(
    '/api/import',
    wrap((req, res) => {
      const { content, parentPath = null, dryRun } = req.body || {}
      if (typeof content !== 'string') throw new AppError(CODES.VALIDATION_FAILED, 'content 必填（markdown 大纲文本）')
      res.json(importOutline(store, content, { parentPath, dryRun: !!dryRun, by: actorOf(req) }))
    })
  )

  // ---------- 属性定义与值 ----------

  app.get(
    '/api/attr-defs',
    wrap((req, res) =>
      res.json(
        store.listAttrDefs(req.query.nodeType || undefined, { includeDisabled: req.query.includeDisabled === 'true' })
      )
    )
  )
  app.post(
    '/api/attr-defs',
    wrap((req, res) => {
      const b = req.body || {}
      res.status(201).json(
        store.addAttrDef({
          nodeType: b.nodeType,
          key: b.key,
          label: b.label,
          dataType: b.dataType,
          options: b.options,
          required: b.required,
          defaultValue: b.defaultValue,
          sort: b.sort
        })
      )
    })
  )
  app.patch(
    '/api/attr-defs/:id',
    wrap((req, res) => res.json(store.updateAttrDef(Number(req.params.id), req.body || {})))
  )
  app.delete(
    '/api/attr-defs/:id',
    wrap((req, res) => res.json(store.deleteAttrDef(Number(req.params.id))))
  )

  // ---------- 文档 ----------

  app.get(
    '/api/nodes/:id/documents',
    wrap((req, res) => res.json(store.listDocuments(store.resolveRef(refOf(req)).id)))
  )
  app.post(
    '/api/nodes/:id/documents',
    wrap((req, res) => {
      const node = store.resolveRef(refOf(req))
      const { name, content } = req.body || {}
      res.status(201).json(store.createDocument(node.id, name, content ?? '', actorOf(req)))
    })
  )
  app.post(
    '/api/nodes/:id/documents/upsert',
    wrap((req, res) => {
      const node = store.resolveRef(refOf(req))
      const { name, content } = req.body || {}
      res.json(store.upsertDocument(node.id, name, content ?? null, actorOf(req)))
    })
  )
  app.post(
    '/api/nodes/:id/documents/reorder',
    wrap((req, res) => {
      const node = store.resolveRef(refOf(req))
      res.json(store.reorderDocuments(node.id, req.body?.orderedIds || []))
    })
  )
  app.patch(
    '/api/documents/:docId',
    wrap((req, res) => res.json(store.updateDocument(Number(req.params.docId), req.body || {}, actorOf(req))))
  )
  app.get(
    '/api/documents/:docId/versions',
    wrap((req, res) => res.json(store.listDocumentVersions(Number(req.params.docId))))
  )
  app.post(
    '/api/documents/:docId/versions/:versionId/restore',
    wrap((req, res) =>
      res.json(store.restoreDocumentVersion(Number(req.params.docId), Number(req.params.versionId), actorOf(req)))
    )
  )
  app.delete(
    '/api/documents/:docId',
    wrap((req, res) => res.json(store.deleteDocument(Number(req.params.docId))))
  )

  // ---------- 提交登记 ----------

  app.get(
    '/api/nodes/:id/commits',
    wrap((req, res) => {
      const node = store.resolveRef(refOf(req))
      res.json(store.listCommits(node.id, { subtree: req.query.subtree === 'true' }))
    })
  )
  app.post(
    '/api/nodes/:id/commits',
    wrap(async (req, res) => {
      const node = store.resolveRef(refOf(req))
      const { repo, sha, note, branch } = req.body || {}
      // 登记分支：未提供时自动从本机 git 推断（best-effort，失败不影响登记）
      let br = branch || null
      if (!br && repo && sha) {
        try {
          const repoRow = store.listRepos().find((r) => r.name === repo)
          if (repoRow && repoRow.localPath) {
            br = await pickBranchForCommit(resolveRepoDir(repoRow), sha)
          }
        } catch (ignore) {
          // 推断失败不阻断
        }
      }
      // 显式传了 branch 视为纠正（允许覆盖已有值）；自动推断只回填空值
      res.status(201).json(store.addCommit(node.id, { repo, sha, note, branch: br, overwriteBranch: !!branch }, actorOf(req)))
    })
  )
  app.delete(
    '/api/commits/:cid',
    wrap((req, res) => res.json(store.removeCommit(Number(req.params.cid))))
  )
  app.patch(
    '/api/commits/:cid',
    wrap((req, res) => {
      const b = req.body || {}
      res.json(store.updateCommitReview(Number(req.params.cid), { reviewStatus: b.reviewStatus, note: b.note }, actorOf(req)))
    })
  )
  app.post(
    '/api/commits/combined-diff',
    wrap(async (req, res) => res.json(await getCombinedDiff(store, (req.body || {}).cids)))
  )
  app.get(
    '/api/nodes/:id/duplicates',
    wrap(async (req, res) => res.json(await getNodeDuplicates(store, refOf(req), { scope: req.query.scope })))
  )
  app.post(
    '/api/commits/dedupe',
    wrap((req, res) => {
      const b = req.body || {}
      res.json(store.dedupeCommits({ keepId: b.keepId, removeIds: b.removeIds }, actorOf(req)))
    })
  )

  // ---------- commit diff 预览 ----------

  app.get(
    '/api/commits/:cid/diff',
    wrap(async (req, res) => res.json(await getCommitDiff(store, Number(req.params.cid))))
  )
  app.get(
    '/api/nodes/:id/diffs',
    wrap(async (req, res) => res.json(await getNodeDiffs(store, refOf(req), { scope: req.query.scope })))
  )

  // ---------- 分支合并状态（测试 / 预发 / 上线） ----------

  app.get(
    '/api/commits/:cid/track',
    wrap(async (req, res) => res.json(await getCommitTrack(store, Number(req.params.cid))))
  )
  app.get(
    '/api/nodes/:id/tracks',
    wrap(async (req, res) => res.json(await getNodeTracks(store, refOf(req), { scope: req.query.scope, branches: req.query.branches === 'true', light: req.query.light === 'true' })))
  )
  // ---------- 审批合并（同意 → 开发分支合入所属子需求的「需求分支」；主仓库执行） ----------
  app.post(
    '/api/nodes/:id/merge',
    wrap(async (req, res) => {
      const node = store.resolveRef(refOf(req))
      res.json(await approveAndMerge(store, node.id, { by: actorOf(req) }))
    })
  )

  app.get(
    '/api/nodes/:id/merge-status',
    wrap(async (req, res) => {
      const node = store.resolveRef(refOf(req))
      res.json(await getMergeStatus(store, node.id))
    })
  )

  app.post(
    '/api/nodes/:id/merge-preview',
    wrap(async (req, res) => {
      const node = store.resolveRef(refOf(req))
      res.json(await previewMerges(store, node.id))
    })
  )

  app.post(
    '/api/nodes/:id/merge-upstream',
    wrap(async (req, res) => {
      const node = store.resolveRef(refOf(req))
      const { targetBranch } = req.body || {}
      res.json(await mergeUpstream(store, node.id, { targetBranch: targetBranch || 'feature-merge' }))
    })
  )

  // ---------- comments（diff 行级评论） ----------
  app.post(
    '/api/nodes/:id/comments',
    wrap((req, res) => {
      const node = store.resolveRef(refOf(req))
      const b = req.body || {}
      res.status(201).json(store.createComment(node.id, {
        repo: b.repo,
        filePath: b.filePath,
        commitSha: b.commitSha,
        lineStart: b.lineStart,
        lineEnd: b.lineEnd,
        snippet: b.snippet,
        content: b.content
      }, actorOf(req)))
    })
  )
  app.get(
    '/api/nodes/:id/comments',
    wrap((req, res) => {
      const node = store.resolveRef(refOf(req))
      res.json(store.listComments(node.id, { filePath: req.query.filePath || null }))
    })
  )
  app.get(
    '/api/comments',
    wrap((req, res) => {
      res.json(store.listCommentsByFile(req.query.filePath || '', { commitSha: req.query.commitSha || null }))
    })
  )
  app.patch(
    '/api/comments/:cid',
    wrap((req, res) => {
      const b = req.body || {}
      res.json(store.updateComment(Number(req.params.cid), { status: b.status, content: b.content }))
    })
  )
  app.delete(
    '/api/comments/:cid',
    wrap((req, res) => {
      store.deleteComment(Number(req.params.cid))
      res.json({ ok: true })
    })
  )

  // ---------- 回归测试闭环（AI 可回归测试用例 + 测试/验收报告） ----------
  app.get(
    '/api/nodes/:id/test-cases',
    wrap((req, res) => {
      const node = store.resolveRef(refOf(req))
      res.json(
        store.listTestCases(node.id, {
          kind: req.query.kind || null,
          includeDisabled: req.query.includeDisabled === 'true'
        })
      )
    })
  )
  app.post(
    '/api/nodes/:id/test-cases',
    wrap((req, res) => {
      const node = store.resolveRef(refOf(req))
      const b = req.body || {}
      res.status(201).json(
        store.createTestCase(node.id, {
          name: b.name,
          kind: b.kind,
          prompt: b.prompt,
          expectation: b.expectation,
          enabled: b.enabled
        }, actorOf(req))
      )
    })
  )
  app.post(
    '/api/nodes/:id/test-cases/upsert',
    wrap((req, res) => {
      const node = store.resolveRef(refOf(req))
      const b = req.body || {}
      res.json(
        store.upsertTestCase(node.id, {
          name: b.name,
          kind: b.kind,
          prompt: b.prompt,
          expectation: b.expectation,
          enabled: b.enabled
        }, actorOf(req))
      )
    })
  )
  app.post(
    '/api/nodes/:id/test-cases/reorder',
    wrap((req, res) => {
      const node = store.resolveRef(refOf(req))
      res.json(store.reorderTestCases(node.id, (req.body || {}).orderedIds || []))
    })
  )
  app.patch(
    '/api/test-cases/:cid',
    wrap((req, res) => {
      const b = req.body || {}
      res.json(
        store.updateTestCase(Number(req.params.cid), {
          name: b.name,
          kind: b.kind,
          prompt: b.prompt,
          expectation: b.expectation,
          enabled: b.enabled
        }, actorOf(req))
      )
    })
  )
  app.delete(
    '/api/test-cases/:cid',
    wrap((req, res) => {
      store.deleteTestCase(Number(req.params.cid))
      res.json({ ok: true })
    })
  )
  app.post(
    '/api/nodes/:id/test-runs',
    wrap((req, res) => {
      const node = store.resolveRef(refOf(req))
      const b = req.body || {}
      res.status(201).json(
        runTestCases(store, node.id, {
          caseIds: b.caseIds,
          kind: b.kind,
          prompt: b.prompt,
          agent: b.agent,
          model: b.model,
          cwd: b.cwd,
          dryRun: !!b.dryRun,
          fanout: !!b.fanout,
          maxParallel: b.maxParallel != null ? b.maxParallel : null
        }, actorOf(req))
      )
    })
  )
  app.get(
    '/api/nodes/:id/test-reports',
    wrap((req, res) => {
      const node = store.resolveRef(refOf(req))
      res.json(
        store.listTestReports(node.id, {
          caseId: req.query.caseId ? Number(req.query.caseId) : null,
          kind: req.query.kind || null,
          limit: req.query.limit ? Number(req.query.limit) : 100
        })
      )
    })
  )
  app.get(
    '/api/test-reports/:rid',
    wrap((req, res) => {
      const report = store.getTestReport(Number(req.params.rid))
      if (store.normalizeFormat(req.query.format) === 'md') {
        res.type('text/markdown').send(renderTestReportMd(store, report))
        return
      }
      res.json(report)
    })
  )
  app.patch(
    '/api/test-reports/:rid',
    wrap((req, res) => {
      const b = req.body || {}
      res.json(
        store.finishTestReport(Number(req.params.rid), {
          status: b.status,
          summary: b.summary,
          detail: b.detail,
          runId: b.runId,
          overwrite: !!b.overwrite
        }, actorOf(req))
      )
    })
  )
  app.get(
    '/api/nodes/:id/acceptance-report',
    wrap((req, res) => {
      const node = store.resolveRef(refOf(req))
      // scope 原样透传，由 store.normalizeScope 统一做值域校验（非法值报错，不静默降级 self）
      const report = store.buildAcceptanceReport(node.id, { scope: req.query.scope })
      if (store.normalizeFormat(req.query.format) === 'md') {
        res.type('text/markdown').send(renderAcceptanceMd(report))
        return
      }
      res.json(report)
    })
  )
  app.get(
    '/api/nodes/:id/acceptance-status',
    wrap((req, res) => {
      const node = store.resolveRef(refOf(req))
      const status = store.buildAcceptanceStatus(node.id, { scope: req.query.scope })
      if (store.normalizeFormat(req.query.format) === 'md') {
        res.type('text/markdown').send(renderAcceptanceStatusMd(status))
        return
      }
      res.json(status)
    })
  )
  app.post(
    '/api/nodes/:id/acceptance-signoff',
    wrap((req, res) => {
      const node = store.resolveRef(refOf(req))
      const b = req.body || {}
      const signoff = store.upsertAcceptanceSignoff(
        node.id,
        { scope: b.scope, decision: b.decision, comment: b.comment ?? null },
        actorOf(req)
      )
      res.json(signoff)
    })
  )

  // ---------- 需求就绪门禁（需求管理闭环的前置判定） ----------
  app.get(
    '/api/nodes/:id/readiness',
    wrap((req, res) => {
      const node = store.resolveRef(refOf(req))
      const readiness = store.buildRequirementReadiness(node.id, {
        scope: req.query.scope
      })
      if (store.normalizeFormat(req.query.format) === 'md') {
        res.type('text/markdown').send(renderReadinessMd(readiness))
        return
      }
      res.json(readiness)
    })
  )

  // ---------- 思维导图（树 → mermaid mindmap 的只读投影） ----------
  app.get(
    '/api/nodes/:id/mindmap',
    wrap((req, res) => {
      const node = store.resolveRef(refOf(req))
      const mindmap = store.buildMindmap(node.id, {
        scope: req.query.scope,
        maxDepth: req.query.maxDepth
      })
      if (store.normalizeFormat(req.query.format) === 'md') {
        res.type('text/markdown').send(renderMindmapMd(mindmap))
        return
      }
      res.json(mindmap)
    })
  )

  // ---------- 文档敏感信息扫描（只读安全前置判定） ----------
  app.get(
    '/api/nodes/:id/secret-scan',
    wrap((req, res) => {
      const node = store.resolveRef(refOf(req))
      const scan = store.buildSecretScan(node.id, {
        scope: req.query.scope
      })
      if (store.normalizeFormat(req.query.format) === 'md') {
        res.type('text/markdown').send(renderSecretScanMd(scan))
        return
      }
      res.json(scan)
    })
  )

  // ---------- 代码检查（已登记提交新增行的只读静态审查） ----------
  app.get(
    '/api/nodes/:id/code-audit',
    wrap(async (req, res) => {
      const node = store.resolveRef(refOf(req))
      const audit = await getNodeCodeAudit(store, node.id, { scope: req.query.scope })
      if (store.normalizeFormat(req.query.format) === 'md') {
        res.type('text/markdown').send(renderCodeAuditMd(audit))
        return
      }
      res.json(audit)
    })
  )

  // ---------- 交付门禁（需求就绪 / 验收 / 上线三段的最终汇总） ----------
  app.get(
    '/api/nodes/:id/delivery-gate',
    wrap((req, res) => {
      const node = store.resolveRef(refOf(req))
      const gate = store.buildDeliveryGate(node.id, {
        scope: req.query.scope
      })
      if (store.normalizeFormat(req.query.format) === 'md') {
        res.type('text/markdown').send(renderDeliveryGateMd(gate))
        return
      }
      res.json(gate)
    })
  )
  app.post(
    '/api/nodes/:id/delivery-snapshots',
    wrap((req, res) => {
      const node = store.resolveRef(refOf(req))
      const b = req.body || {}
      res.status(201).json(
        store.captureDeliverySnapshot(
          node.id,
          { scope: b.scope, note: b.note },
          actorOf(req)
        )
      )
    })
  )
  app.get(
    '/api/nodes/:id/delivery-snapshots',
    wrap((req, res) => {
      const node = store.resolveRef(refOf(req))
      res.json(
        store.listDeliverySnapshots(node.id, {
          scope: req.query.scope ?? null,
          limit: req.query.limit
        })
      )
    })
  )
  app.get(
    '/api/delivery-snapshots/:sid',
    wrap((req, res) => {
      const snapshot = store.getDeliverySnapshot(Number(req.params.sid))
      if (store.normalizeFormat(req.query.format) === 'md') {
        res.type('text/markdown').send(renderDeliverySnapshotMd(snapshot))
        return
      }
      res.json(snapshot)
    })
  )

  // ---------- 概要设计大纲 / 思维导图（需求管理 → 概要设计 → 文档） ----------
  app.get(
    '/api/nodes/:id/design-outline',
    wrap((req, res) => {
      const node = store.resolveRef(refOf(req))
      const outline = store.buildDesignOutline(node.id, { scope: req.query.scope })
      if (store.normalizeFormat(req.query.format) === 'md') {
        res.type('text/markdown').send(renderDesignOutlineMd(outline))
        return
      }
      res.json(outline)
    })
  )

  app.post(
    '/api/nodes/:id/design-outline/apply',
    wrap((req, res) => {
      const body = req.body || {}
      const node = store.resolveRef(refOf(req))
      res.json(
        applyDesignOutline(store, node.id, {
          scope: body.scope,
          overwrite: !!body.overwrite,
          dryRun: !!body.dryRun,
          by: actorOf(req)
        })
      )
    })
  )

  // ---------- 上线治理（上线配置 / 上线 SQL / 上线检查清单） ----------
  app.get(
    '/api/nodes/:id/release-items',
    wrap((req, res) => {
      const node = store.resolveRef(refOf(req))
      res.json(
        store.listReleaseItems(node.id, {
          kind: req.query.kind || null,
          status: req.query.status || null,
          includeOptional: req.query.includeOptional !== 'false'
        })
      )
    })
  )
  app.post(
    '/api/nodes/:id/release-items',
    wrap((req, res) => {
      const node = store.resolveRef(refOf(req))
      const b = req.body || {}
      res.status(201).json(
        store.createReleaseItem(
          node.id,
          {
            name: b.name,
            kind: b.kind,
            content: b.content,
            rollback: b.rollback,
            status: b.status,
            required: b.required
          },
          actorOf(req)
        )
      )
    })
  )
  app.post(
    '/api/nodes/:id/release-items/upsert',
    wrap((req, res) => {
      const node = store.resolveRef(refOf(req))
      const b = req.body || {}
      res.json(
        store.upsertReleaseItem(
          node.id,
          {
            name: b.name,
            kind: b.kind,
            content: b.content,
            rollback: b.rollback,
            status: b.status,
            required: b.required
          },
          actorOf(req)
        )
      )
    })
  )
  app.post(
    '/api/nodes/:id/release-items/reorder',
    wrap((req, res) => {
      const node = store.resolveRef(refOf(req))
      res.json(store.reorderReleaseItems(node.id, (req.body || {}).orderedIds || []))
    })
  )
  app.patch(
    '/api/release-items/:rid',
    wrap((req, res) => {
      const b = req.body || {}
      res.json(
        store.updateReleaseItem(
          Number(req.params.rid),
          {
            name: b.name,
            kind: b.kind,
            content: b.content,
            rollback: b.rollback,
            status: b.status,
            required: b.required
          },
          actorOf(req)
        )
      )
    })
  )
  app.delete(
    '/api/release-items/:rid',
    wrap((req, res) => res.json(store.deleteReleaseItem(Number(req.params.rid))))
  )
  app.get(
    '/api/nodes/:id/release-checklist',
    wrap((req, res) => {
      const node = store.resolveRef(refOf(req))
      const checklist = store.buildReleaseChecklist(node.id, {
        scope: req.query.scope
      })
      if (store.normalizeFormat(req.query.format) === 'md') {
        res.type('text/markdown').send(renderReleaseChecklistMd(checklist))
        return
      }
      res.json(checklist)
    })
  )
  app.get(
    '/api/nodes/:id/release-sql-audit',
    wrap((req, res) => {
      const node = store.resolveRef(refOf(req))
      // scope / format 原样透传，由 store 单点校验（非法值报错，不静默降级 self / json）
      const audit = store.buildReleaseSqlAudit(node.id, { scope: req.query.scope })
      if (store.normalizeFormat(req.query.format) === 'md') {
        res.type('text/markdown').send(renderReleaseSqlAuditMd(audit))
        return
      }
      res.json(audit)
    })
  )


  // ---------- 业务检查门禁（业务可验收性的只读判定） ----------
  app.get(
    '/api/nodes/:id/business-gate',
    wrap((req, res) => {
      const node = store.resolveRef(refOf(req))
      const gate = store.buildBusinessGate(node.id, {
        scope: req.query.scope
      })
      if (store.normalizeFormat(req.query.format) === 'md') {
        res.type('text/markdown').send(renderBusinessGateMd(gate))
        return
      }
      res.json(gate)
    })
  )
  app.post(
    '/api/nodes/:id/release-checks',
    wrap((req, res) => {
      const node = store.resolveRef(refOf(req))
      const b = req.body || {}
      res.status(201).json(
        runReleaseChecks(
          store,
          node.id,
          {
            caseIds: b.caseIds,
            scope: b.scope,
            prompt: b.prompt,
            agent: b.agent,
            model: b.model,
            cwd: b.cwd,
            dryRun: !!b.dryRun
          },
          actorOf(req)
        )
      )
    })
  )

  // ---------- agent 运行时 / 会话 / 任务 ----------

  // 运行时
  app.get(
    '/api/runtimes',
    wrap((req, res) => res.json({ summary: store.agentRuntimeSummary(), items: store.listRuntimes({ status: req.query.status || null }) }))
  )
  app.post(
    '/api/runtimes',
    wrap((req, res) => res.status(201).json(store.upsertRuntime(req.body || {}, actorOf(req))))
  )
  app.get(
    '/api/runtimes/:id',
    wrap((req, res) => res.json(store.getRuntime(Number(req.params.id))))
  )
  app.post(
    '/api/runtimes/:id/heartbeat',
    wrap((req, res) => res.json(store.heartbeatRuntime(Number(req.params.id))))
  )
  app.patch(
    '/api/runtimes/:id',
    wrap((req, res) => {
      const b = req.body || {}
      if (b.status) return res.json(store.setRuntimeStatus(Number(req.params.id), b.status))
      return res.json(store.getRuntime(Number(req.params.id)))
    })
  )
  app.delete(
    '/api/runtimes/:id',
    wrap((req, res) => res.json(store.deleteRuntime(Number(req.params.id))))
  )

  // 任务（runs）：派单 / 列表 / 详情 / 消息流 / 取消 / 重试 / 回写
  app.post(
    '/api/nodes/:id/agent-runs',
    wrap((req, res) => {
      const node = store.resolveRef(refOf(req))
      const b = req.body || {}
      res.status(201).json(
        startAgentRun(
          store,
          node.id,
          {
            prompt: b.prompt,
            agent: b.agent,
            model: b.model,
            cwd: b.cwd,
            ideMode: !!b.ideMode,
            sessionId: b.sessionId,
            resume: !!b.resume,
            runtimeId: b.runtimeId,
            maxAttempts: b.maxAttempts
          },
          actorOf(req)
        )
      )
    })
  )
  app.get(
    '/api/nodes/:id/agent-runs',
    wrap((req, res) =>
      res.json(
        store.listAgentRuns(store.resolveRef(refOf(req)).id, {
          limit: Number(req.query.limit) || 20,
          sessionId: req.query.sessionId || null
        })
      )
    )
  )
  app.get(
    '/api/nodes/:id/agent-sessions',
    wrap((req, res) => res.json(store.listAgentSessions(store.resolveRef(refOf(req)).id, { status: req.query.status || null })))
  )
  app.post(
    '/api/nodes/:id/agent-sessions',
    wrap((req, res) => {
      const node = store.resolveRef(refOf(req))
      const b = req.body || {}
      res.status(201).json(store.createAgentSession(node.id, { agent: b.agent, workDir: b.workDir, title: b.title }, actorOf(req)))
    })
  )
  app.get(
    '/api/agent-sessions/:sid',
    wrap((req, res) => res.json(store.getAgentSession(Number(req.params.sid))))
  )
  app.patch(
    '/api/agent-sessions/:sid',
    wrap((req, res) => res.json(store.updateAgentSession(Number(req.params.sid), req.body || {})))
  )
  app.delete(
    '/api/agent-sessions/:sid',
    wrap((req, res) => res.json(store.archiveAgentSession(Number(req.params.sid))))
  )
  app.get(
    '/api/agent-runs/:rid',
    wrap((req, res) => res.json(store.getAgentRun(Number(req.params.rid))))
  )
  app.get(
    '/api/agent-runs/:rid/messages',
    wrap((req, res) => res.json(store.listAgentRunMessages(Number(req.params.rid), { sinceSeq: Number(req.query.sinceSeq) || 0 })))
  )
  app.post(
    '/api/agent-runs/:rid/messages',
    wrap((req, res) => res.status(201).json(store.appendAgentRunMessage(Number(req.params.rid), req.body || {})))
  )
  app.post(
    '/api/agent-runs/:rid/cancel',
    wrap((req, res) => res.json(store.cancelAgentRun(Number(req.params.rid), { reason: (req.body || {}).reason || 'manual' })))
  )
  app.post(
    '/api/agent-runs/:rid/retry',
    wrap((req, res) => res.status(201).json(retryAndDispatch(store, Number(req.params.rid), actorOf(req))))
  )
  app.patch(
    '/api/agent-runs/:rid',
    wrap((req, res) => {
      const b = req.body || {}
      if (b.status) {
        return res.json(
          store.finishAgentRun(Number(req.params.rid), {
            status: b.status,
            exitCode: b.exitCode ?? null,
            failureReason: b.failureReason ?? null,
            cliSessionId: b.cliSessionId ?? null,
            workDir: b.workDir ?? null
          })
        )
      }
      return res.json(store.getAgentRun(Number(req.params.rid)))
    })
  )

  // ---------- 网页 → IDEA 打开请求（IDE 桥；插件轮询领取） ----------

  app.post(
    '/api/ide/open-diff',
    wrap((req, res) => {
      res.status(201).json(store.createIdeRequest('open-diff', req.body || {}, actorOf(req)))
    })
  )
  app.get(
    '/api/ide/requests/next',
    wrap((req, res) => {
      const r = store.claimNextIdeRequest()
      if (!r) return res.status(204).end()
      res.json(r)
    })
  )
  app.post(
    '/api/ide/requests/:id/complete',
    wrap((req, res) => res.json(store.completeIdeRequest(Number(req.params.id), req.body || {})))
  )

  // ---------- 仓库登记 ----------

  // ---------- 工作区准备（分支 / worktree / 开发提示词） ----------
  app.get(
    '/api/nodes/:id/unit-repos',
    wrap((req, res) => {
      const node = store.resolveRef(refOf(req))
      res.json(store.listUnitRepos(node.id))
    })
  )
  app.post(
    '/api/nodes/:id/unit-repos',
    wrap((req, res) => {
      const node = store.resolveRef(refOf(req))
      const b = req.body || {}
      res.status(201).json(store.addUnitRepo(node.id, { repoId: b.repoId, branch: b.branch, worktreePath: b.worktreePath }, actorOf(req)))
    })
  )
  app.delete(
    '/api/unit-repos/:urid',
    wrap((req, res) => res.json(store.deleteUnitRepo(Number(req.params.urid))))
  )
  app.post(
    '/api/nodes/:id/setup',
    wrap(async (req, res) => {
      const node = store.resolveRef(refOf(req))
      const b = req.body || {}
      res.json(await setupWorkspace(store, node.id, {
        repoIds: b.repoIds,
        branch: b.branch,
        baseBranch: b.baseBranch,
        dryRun: !!b.dryRun,
        by: actorOf(req)
      }))
    })
  )
  app.get(
    '/api/nodes/:id/prompt',
    wrap((req, res) => {
      const node = store.resolveRef(refOf(req))
      res.json(getWorkspacePrompt(store, node.id))
    })
  )
  app.post(
    '/api/nodes/:id/cleanup',
    wrap(async (req, res) => {
      const node = store.resolveRef(refOf(req))
      const b = req.body || {}
      res.json(await cleanupWorkspace(store, node.id, {
        confirm: !!b.confirm,
        removeBranch: b.removeBranch !== false,
        by: actorOf(req)
      }))
    })
  )

  app.get('/api/repos', wrap((req, res) => res.json(store.listRepos())))
  app.post(
    '/api/repos',
    wrap((req, res) => {
      const b = req.body || {}
      res.status(201).json(store.addRepo({ name: b.name, localPath: b.localPath, gitlabProject: b.gitlabProject, note: b.note, tags: b.tags, testBranch: b.testBranch, preBranch: b.preBranch, releaseBranch: b.releaseBranch }))
    })
  )
  app.patch(
    '/api/repos/:rid',
    wrap((req, res) => res.json(store.updateRepo(Number(req.params.rid), req.body || {})))
  )
  app.delete(
    '/api/repos/:rid',
    wrap((req, res) => res.json(store.deleteRepo(Number(req.params.rid))))
  )

  // ---------- 标签级分支配置（仓库通过 tags 继承） ----------

  app.get('/api/branch-configs', wrap((req, res) => res.json(store.listBranchConfigs())))
  app.put(
    '/api/branch-configs/:tag',
    wrap((req, res) => {
      const b = req.body || {}
      res.json(store.upsertBranchConfig(req.params.tag, { testBranch: b.testBranch, preBranch: b.preBranch, releaseBranch: b.releaseBranch }))
    })
  )
  app.delete(
    '/api/branch-configs/:tag',
    wrap((req, res) => res.json(store.deleteBranchConfig(req.params.tag)))
  )

  // ---------- 本机配置 ----------

  app.get('/api/config', wrap((req, res) => res.json(maskToken(loadConfig()))))
  app.put(
    '/api/config',
    wrap((req, res) => res.json(maskToken(saveConfig(req.body || {}))))
  )
  app.post(
    '/api/config/gitlab/test',
    wrap(async (req, res) => {
      const cfg = loadConfig()
      const base = cfg.gitlab.base_url
      const token = cfg.gitlab.token
      if (!base || !token) throw new AppError(CODES.GITLAB_NOT_CONFIGURED, '请先在设置里填写 GitLab 地址与 token')
      let r
      try {
        r = await fetch(`${base.replace(/\/$/, '')}/api/v4/user`, { headers: { 'PRIVATE-TOKEN': token } })
      } catch (e) {
        throw new AppError(CODES.GITLAB_UNAVAILABLE, `连不上 GitLab：${e.message}`)
      }
      if (r.status === 401) throw new AppError(CODES.GITLAB_AUTH_FAILED, 'token 无效或已过期')
      if (!r.ok) throw new AppError(CODES.GITLAB_UNAVAILABLE, `GitLab 返回 ${r.status}`)
      const user = await r.json()
      res.json({ ok: true, user: { id: user.id, username: user.username, name: user.name } })
    })
  )

  // ---------- 错误处理 ----------
  // 文档图片静态访问（Markdown 预览直接引用 /uploads/<name>）。
  // 挂在 createApp 内，保证测试与真实服务（含 SPA 回退）行为一致。
  fs.mkdirSync(UPLOAD_DIR, { recursive: true })
  app.use('/uploads', express.static(UPLOAD_DIR))
  // 终结性 404：静态未命中时必须在这里结束，不能 next() 交给上层 SPA 回退——
  // 否则图片被删/改名后前端 <img> 会拿到 200 + index.html，静默裂图且无从感知。
  app.use('/uploads', (req, res) => {
    res.status(404).json({
      // 挂载点下的 req.path 是相对的，拼回 baseUrl 才能报出用户看到的完整地址
      error: { code: CODES.NOT_FOUND, message: `图片不存在：${req.baseUrl}${req.path}` }
    })
  })
  // 只对 /api/* 路由返回 404 JSON，非 API 路由放过（让上层静态托管或 SPA 回退处理）
  app.use((req, res, next) => {
    if (!req.path.startsWith('/api/')) return next()
    res.status(404).json({ error: { code: 'NOT_FOUND', message: `未知 API 路由 ${req.method} ${req.path}` } })
  })
  app.use((err, req, res, _next) => {
    // 框架层错误（body-parser / send 等）没有稳定 code，必须显式映射成业务码：
    // 否则「请求体过大」「JSON 格式错」这类纯客户端错误会被报成 500 服务端故障。
    const framework = mapFrameworkError(err)
    if (framework) {
      res.status(framework.status).json({
        error: { code: framework.code, message: framework.message, ...(framework.details ? { details: framework.details } : {}) }
      })
      return
    }
    const code = err.code || 'INTERNAL_ERROR'
    const status = STATUS_BY_CODE[code] || 500
    if (status >= 500) console.error('[task-board]', err)
    res.status(status).json(errorBody(err))
  })

  return app
}
