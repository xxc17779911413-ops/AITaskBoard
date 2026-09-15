import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { openDb } from './db.mjs'
import { createStore } from './store.mjs'
import { loadConfig, saveConfig, maskToken } from './config.mjs'
import { buildSchema, renderTreeMd, upsertByPath, importOutline, applyBatch, getCommitDiff, getNodeDiffs, getCommitTrack, getNodeTracks, getCombinedDiff, getNodeDuplicates, runTestCases, renderAcceptanceMd, renderAcceptanceStatusMd, runReleaseChecks, renderReleaseChecklistMd, renderReadinessMd, renderMindmapMd, renderDeliveryGateMd, renderDesignOutlineMd, applyDesignOutline, renderTestReportMd } from './ops.mjs'
import { setupWorkspace, getWorkspacePrompt, cleanupWorkspace } from './ops.mjs'
import { startAgentRun, retryAndDispatch } from './agent.mjs'
import { resolveRepoDir, pickBranchForCommit } from './git.mjs'
import { saveUpload } from './uploads.mjs'

export function createMcpServer({ store }) {
  const cfg = loadConfig()

  const server = new McpServer({ name: 'task-board', version: '0.1.0' })

  /** 把业务校验错误转成 MCP isError 结果，保持与 HTTP / CLI 的 VALIDATION_FAILED 契约一致。 */
  const mcpValidate = (fn) => async (args) => {
    try {
      return await fn(args)
    } catch (e) {
      if (e && e.code) {
        return {
          isError: true,
          content: [{ type: 'text', text: `${e.code}: ${e.message}${e.details ? ` ${JSON.stringify(e.details)}` : ''}` }]
        }
      }
      throw e
    }
  }

  // ---------- 读取 ----------

  server.tool('tree', '打印整棵树', { format: z.enum(['md', 'json']).optional() }, async ({ format }) => {
    const tree = store.listTree()
    if (format === 'md') {
      return { content: [{ type: 'text', text: renderTreeMd(store, tree) }] }
    }
    return { content: [{ type: 'text', text: JSON.stringify({ revision: store.getRevision(), nodes: tree }, null, 2) }] }
  })

  server.tool('schema', '节点类型 / 状态值域 / 属性定义 / 工具清单', async () => {
    return { content: [{ type: 'text', text: JSON.stringify(buildSchema(store, loadConfig()), null, 2) }] }
  })

  server.tool('node_get', '获取节点详情', { ref: z.string().describe('id 或路径') }, async ({ ref }) => {
    const node = store.resolveRef(ref)
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            { ...node, attrs: store.getAttrs(node.id), documents: store.listDocuments(node.id), children: store.listChildren(node.id) },
            null,
            2
          )
        }
      ]
    }
  })

  server.tool(
    'node_upsert',
    '按路径 get-or-create（幂等）',
    {
      path: z.string().describe('节点路径，如 项目A/需求1'),
      type: z.string().optional(),
      attrs: z.record(z.string()).optional(),
      dryRun: z.boolean().optional()
    },
    async ({ path, type, attrs, dryRun }) => {
      const out = upsertByPath(store, path, { type, attrs, by: 'ai', dryRun: !!dryRun })
      return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] }
    }
  )

  server.tool(
    'node_update',
    '更新节点（移动需要 confirm: true）',
    {
      ref: z.string().describe('id 或路径'),
      name: z.string().optional(),
      status: z.string().optional(),
      parentPath: z.string().nullable().optional(),
      attrs: z.record(z.string()).optional(),
      confirm: z.boolean().optional()
    },
    async ({ ref, name, status, parentPath, attrs, confirm }) => {
      const node = store.resolveRef(ref)
      const patch = { name, status, attrs }
      if (parentPath !== undefined) {
        if (confirm !== true) return { content: [{ type: 'text', text: '移动节点需要 confirm: true' }], isError: true }
        patch.parentId = parentPath === null ? null : store.resolveRef(parentPath).id
      }
      return { content: [{ type: 'text', text: JSON.stringify(store.updateNode(node.id, patch, 'ai'), null, 2) }] }
    }
  )

  server.tool(
    'node_delete',
    '删除节点（需要 confirm: true）',
    { ref: z.string().describe('id 或路径'), confirm: z.boolean() },
    async ({ ref, confirm }) => {
      if (confirm !== true) return { content: [{ type: 'text', text: '删除节点需要 confirm: true' }], isError: true }
      const node = store.resolveRef(ref)
      return { content: [{ type: 'text', text: JSON.stringify(store.deleteNode(node.id), null, 2) }] }
    }
  )

  server.tool(
    'node_reorder',
    '同级排序',
    {
      parentId: z.number().optional(),
      parentPath: z.string().optional(),
      orderedIds: z.array(z.number())
    },
    async ({ parentId, parentPath, orderedIds }) => {
      const pid = parentPath ? store.resolveRef(parentPath).id : parentId
      return { content: [{ type: 'text', text: JSON.stringify(store.reorderSiblings(pid, orderedIds), null, 2) }] }
    }
  )

  // ---------- 需求管理（需求条目 / 状态流转 / 文档关联） ----------

  server.tool(
    'requirement_list',
    '需求条目列表：含项目、属性、文档关联状态、就绪结论与可流转状态',
    { project: z.string().optional(), status: z.string().optional() },
    mcpValidate(async ({ project, status }) => {
      const projectId = project ? store.resolveRef(project).id : null
      const data = {
        revision: store.getRevision(),
        summary: store.requirementSummary({ projectId, status: status || null }),
        items: store.listRequirements({ projectId, status: status || null })
      }
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
    })
  )

  server.tool(
    'requirement_create',
    '新建需求条目并关联「需求内容 / 概要设计」两份文档',
    { project: z.string(), name: z.string(), attrs: z.record(z.string()).optional() },
    mcpValidate(async ({ project, name, attrs }) => {
      const projectId = store.resolveRef(project).id
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(store.createRequirement({ projectId, name, attrs, actor: 'ai' }), null, 2)
          }
        ]
      }
    })
  )

  server.tool(
    'requirement_transition',
    '需求状态流转（todo→doing→testing→done；未完成前可 cancelled；cancelled→todo 可恢复）',
    { ref: z.string(), status: z.string() },
    mcpValidate(async ({ ref, status }) => {
      const node = store.resolveRef(ref)
      return { content: [{ type: 'text', text: JSON.stringify(store.transitionRequirement(node.id, { status, actor: 'ai' }), null, 2) }] }
    })
  )

  // ---------- 属性 ----------

  server.tool(
    'attr_defs',
    '属性定义列表',
    { nodeType: z.string().optional(), includeDisabled: z.boolean().optional() },
    async ({ nodeType, includeDisabled }) => {
      return {
        content: [{ type: 'text', text: JSON.stringify(store.listAttrDefs(nodeType, { includeDisabled: !!includeDisabled }), null, 2) }]
      }
    }
  )

  server.tool(
    'attr_add',
    '新增属性定义',
    {
      nodeType: z.string(),
      key: z.string(),
      label: z.string(),
      dataType: z.enum(['text', 'textarea', 'number', 'date', 'select', 'url']),
      options: z.string().optional(),
      required: z.boolean().optional(),
      sort: z.number().optional()
    },
    async ({ nodeType, key, label, dataType, options, required, sort }) => {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              store.addAttrDef({ nodeType, key, label, dataType, options: options ? JSON.parse(options) : null, required: !!required, sort }),
              null,
              2
            )
          }
        ]
      }
    }
  )

  server.tool(
    'attr_update',
    '更新属性定义',
    { id: z.number(), label: z.string().optional(), dataType: z.string().optional(), options: z.string().optional(), required: z.boolean().optional(), sort: z.number().optional(), enabled: z.boolean().optional() },
    async ({ id, ...patch }) => {
      if (patch.options) patch.options = JSON.parse(patch.options)
      return { content: [{ type: 'text', text: JSON.stringify(store.updateAttrDef(id, patch), null, 2) }] }
    }
  )

  server.tool('attr_remove', '删除属性定义', { id: z.number() }, async ({ id }) => {
    return { content: [{ type: 'text', text: JSON.stringify(store.deleteAttrDef(id), null, 2) }] }
  })

  server.tool(
    'attr_set',
    '设置节点属性值',
    { ref: z.string().describe('id 或路径'), attrs: z.record(z.string()) },
    async ({ ref, attrs }) => {
      const node = store.resolveRef(ref)
      return { content: [{ type: 'text', text: JSON.stringify(store.setAttrs(node.id, attrs, 'ai'), null, 2) }] }
    }
  )

  // ---------- 文档 ----------

  server.tool('doc_list', '列节点文档', { ref: z.string() }, async ({ ref }) => {
    const node = store.resolveRef(ref)
    return { content: [{ type: 'text', text: JSON.stringify(store.listDocuments(node.id), null, 2) }] }
  })

  server.tool(
    'doc_upsert',
    '按文档名 upsert（幂等）',
    { ref: z.string(), name: z.string(), content: z.string().optional() },
    async ({ ref, name, content }) => {
      const node = store.resolveRef(ref)
      return { content: [{ type: 'text', text: JSON.stringify(store.upsertDocument(node.id, name, content ?? null, 'ai'), null, 2) }] }
    }
  )

  server.tool(
    'doc_create',
    '新增文档',
    { ref: z.string(), name: z.string(), content: z.string().optional() },
    async ({ ref, name, content }) => {
      const node = store.resolveRef(ref)
      return { content: [{ type: 'text', text: JSON.stringify(store.createDocument(node.id, name, content ?? '', 'ai'), null, 2) }] }
    }
  )

  server.tool(
    'doc_update',
    '更新文档',
    { docId: z.number(), name: z.string().optional(), content: z.string().optional() },
    async ({ docId, name, content }) => {
      const patch = {}
      if (name !== undefined) patch.name = name
      if (content !== undefined) patch.content = content
      return { content: [{ type: 'text', text: JSON.stringify(store.updateDocument(docId, patch, 'ai'), null, 2) }] }
    }
  )

  server.tool(
    'doc_version_list',
    '列出文档的历史版本（新版本在前）',
    { docId: z.number() },
    mcpValidate(async ({ docId }) => {
      return { content: [{ type: 'text', text: JSON.stringify(store.listDocumentVersions(docId), null, 2) }] }
    })
  )

  server.tool(
    'doc_version_restore',
    '恢复文档到指定历史版本；恢复本身会追加一个新版本，不改写历史',
    { docId: z.number(), versionId: z.number() },
    mcpValidate(async ({ docId, versionId }) => {
      return { content: [{ type: 'text', text: JSON.stringify(store.restoreDocumentVersion(docId, versionId, 'ai'), null, 2) }] }
    })
  )

  server.tool('doc_remove', '删除文档', { docId: z.number() }, async ({ docId }) => {
    return { content: [{ type: 'text', text: JSON.stringify(store.deleteDocument(docId), null, 2) }] }
  })

  server.tool(
    'doc_reorder',
    '文档排序',
    { ref: z.string(), orderedIds: z.array(z.number()) },
    async ({ ref, orderedIds }) => {
      const node = store.resolveRef(ref)
      return { content: [{ type: 'text', text: JSON.stringify(store.reorderDocuments(node.id, orderedIds), null, 2) }] }
    }
  )

  // ---------- commit ----------

  server.tool(
    'commit_list',
    '列出节点的 commit 登记',
    { ref: z.string(), subtree: z.boolean().optional() },
    async ({ ref, subtree }) => {
      const node = store.resolveRef(ref)
      return { content: [{ type: 'text', text: JSON.stringify(store.listCommits(node.id, { subtree: !!subtree }), null, 2) }] }
    }
  )

  server.tool(
    'commit_diff',
    '单个 commit 的 diff 预览（文件列表 + 每文件 patch / old / new；仓库读本机 git）',
    { cid: z.number().describe('commit 登记 id（commit_list 返回的 id）') },
    async ({ cid }) => {
      const data = await getCommitDiff(store, cid)
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
    }
  )

  server.tool(
    'node_diffs',
    '节点（含子树）聚合 diff：按 (repo, sha) 去重、回填来源节点；单条失败带 error 字段',
    { ref: z.string(), scope: z.string().optional() },
    mcpValidate(async ({ ref, scope }) => {
      const data = await getNodeDiffs(store, ref, { scope })
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
    })
  )

  server.tool(
    'commit_track',
    '检测单个 commit 是否已合入测试/预发/上线分支（需仓库配置三分支）',
    { cid: z.number().describe('commit 登记 id（commit_list 返回的 id）') },
    async ({ cid }) => {
      const data = await getCommitTrack(store, cid)
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
    }
  )

  server.tool(
    'node_tracks',
    '节点（含子树）合并状态聚合：按 (repo, sha) 去重；contained=null 表示未配置或本地无该 ref；branches=true 附分支标注与需求分支合入状态',
    { ref: z.string(), scope: z.string().optional(), branches: z.boolean().optional() },
    mcpValidate(async ({ ref, scope, branches }) => {
      const data = await getNodeTracks(store, ref, { scope, branches: !!branches })
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
    })
  )

  server.tool(
    'commit_add',
    '登记 commit（branch 可选：不传时自动从本机 git 推断开发分支，优先匹配提交 message 中的需求编号；显式传入则视为纠正并覆盖已有值）',
    { ref: z.string(), sha: z.string(), repo: z.string().optional(), note: z.string().optional(), branch: z.string().optional() },
    async ({ ref, sha, repo, note, branch }) => {
      const node = store.resolveRef(ref)
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
      return { content: [{ type: 'text', text: JSON.stringify(store.addCommit(node.id, { repo, sha, note, branch: br, overwriteBranch: !!branch }, 'ai'), null, 2) }] }
    }
  )

  server.tool(
    'commit_duplicates',
    '重复提交检测：same-sha（同 sha 重复登记）/ patch-id（同内容不同 sha）/ merge 覆盖（worktree 提交被合入需求分支）',
    { ref: z.string(), scope: z.string().optional() },
    mcpValidate(async ({ ref, scope }) => {
      return { content: [{ type: 'text', text: JSON.stringify(await getNodeDuplicates(store, ref, { scope }), null, 2) }] }
    })
  )

  server.tool(
    'commit_dedupe',
    '一键去重：保留 keepId，删除重复登记的 removeIds（校验同 repo 且 sha/patch-id 相同）',
    { keepId: z.number(), removeIds: z.array(z.number()) },
    async ({ keepId, removeIds }) => {
      return { content: [{ type: 'text', text: JSON.stringify(store.dedupeCommits({ keepId, removeIds }, 'ai'), null, 2) }] }
    }
  )

  server.tool(
    'commit_combined_diff',
    '多个 commit 的合并变更（MR 式）：按仓库分组、文件并集，每个文件 old=最早 commit 父版本、new=最新 commit 版本',
    { cids: z.array(z.number()) },
    async ({ cids }) => {
      return { content: [{ type: 'text', text: JSON.stringify(await getCombinedDiff(store, cids), null, 2) }] }
    }
  )

  server.tool(
    'agent_run',
    '触发 agent 任务（默认 qodercli + DeepSeek-Flash；工作目录自动取节点关联仓库，可显式传 cwd）。' +
      'sessionId 指定会话（缺省自动挂该节点活动会话），resume=true 续跑会话里上一次 CLI 会话，runtimeId 指定运行时。异步执行，用 agent_runs_list 查结果',
    {
      ref: z.string(),
      prompt: z.string(),
      agent: z.string().optional(),
      model: z.string().optional(),
      cwd: z.string().optional(),
      sessionId: z.number().optional(),
      resume: z.boolean().optional(),
      runtimeId: z.number().optional(),
      maxAttempts: z.number().optional()
    },
    async ({ ref, prompt, agent, model, cwd, sessionId, resume, runtimeId, maxAttempts }) => {
      const node = store.resolveRef(ref)
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              startAgentRun(store, node.id, { prompt, agent, model, cwd, sessionId, resume, runtimeId, maxAttempts }, 'ai'),
              null,
              2
            )
          }
        ]
      }
    }
  )

  server.tool(
    'agent_runs_list',
    'agent 任务历史（含输出、状态、attempt/失败原因；可按 sessionId 过滤）',
    { ref: z.string(), limit: z.number().optional(), sessionId: z.number().optional() },
    async ({ ref, limit, sessionId }) => {
      const node = store.resolveRef(ref)
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(store.listAgentRuns(node.id, { limit: limit || 20, sessionId: sessionId || null }), null, 2)
          }
        ]
      }
    }
  )

  // ---------- 运行时 ----------

  server.tool('runtime_list', '运行时列表（本机 agent CLI 实例状态 + 总览统计）', { status: z.enum(['online', 'offline']).optional() }, async ({ status }) => {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ summary: store.agentRuntimeSummary(), items: store.listRuntimes({ status: status || null }) }, null, 2)
        }
      ]
    }
  })

  server.tool(
    'runtime_register',
    '注册/更新运行时（按 daemonId + provider 幂等 upsert；注册即视为 online 心跳）',
    {
      name: z.string().optional(),
      daemonId: z.string(),
      provider: z.string().optional(),
      runtimeMode: z.enum(['local', 'cloud']).optional(),
      status: z.enum(['online', 'offline']).optional(),
      deviceInfo: z.string().optional(),
      visibility: z.enum(['private', 'public']).optional()
    },
    async (args) => {
      return { content: [{ type: 'text', text: JSON.stringify(store.upsertRuntime(args, 'ai'), null, 2) }] }
    }
  )

  server.tool('runtime_heartbeat', '运行时心跳（刷新 last_seen_at + 置 online）', { id: z.number() }, async ({ id }) => {
    return { content: [{ type: 'text', text: JSON.stringify(store.heartbeatRuntime(id), null, 2) }] }
  })

  server.tool(
    'runtime_status',
    '手动改运行时状态（online/offline）',
    { id: z.number(), status: z.enum(['online', 'offline']) },
    async ({ id, status }) => {
      return { content: [{ type: 'text', text: JSON.stringify(store.setRuntimeStatus(id, status), null, 2) }] }
    }
  )

  server.tool('runtime_remove', '删除运行时（存在未完成任务时拒绝，历史任务解绑保留）', { id: z.number() }, async ({ id }) => {
    return { content: [{ type: 'text', text: JSON.stringify(store.deleteRuntime(id), null, 2) }] }
  })

  // ---------- 会话 ----------

  server.tool(
    'agent_session_list',
    '节点上的 agent 会话（可续跑的连续对话；含 runCount / cliSessionId）',
    { ref: z.string(), status: z.enum(['active', 'archived']).optional() },
    async ({ ref, status }) => {
      const node = store.resolveRef(ref)
      return { content: [{ type: 'text', text: JSON.stringify(store.listAgentSessions(node.id, { status: status || null }), null, 2) }] }
    }
  )

  server.tool(
    'agent_session_new',
    '新建 agent 会话（不复用旧会话）',
    { ref: z.string(), agent: z.string().optional(), workDir: z.string().optional(), title: z.string().optional() },
    async ({ ref, agent, workDir, title }) => {
      const node = store.resolveRef(ref)
      return { content: [{ type: 'text', text: JSON.stringify(store.createAgentSession(node.id, { agent, workDir, title }, 'ai'), null, 2) }] }
    }
  )

  server.tool('agent_session_archive', '归档 agent 会话', { id: z.number() }, async ({ id }) => {
    return { content: [{ type: 'text', text: JSON.stringify(store.archiveAgentSession(id), null, 2) }] }
  })

  // ---------- 任务消息流 / 取消 / 重试 ----------

  server.tool(
    'agent_run_messages',
    '读取任务消息流（事件流；sinceSeq 增量拉取）',
    { id: z.number(), sinceSeq: z.number().optional() },
    async ({ id, sinceSeq }) => {
      return { content: [{ type: 'text', text: JSON.stringify(store.listAgentRunMessages(id, { sinceSeq: sinceSeq || 0 }), null, 2) }] }
    }
  )

  server.tool('agent_run_cancel', '取消任务（未结束任务置 cancelled，并杀掉本地子进程）', { id: z.number(), reason: z.string().optional() }, async ({ id, reason }) => {
    return { content: [{ type: 'text', text: JSON.stringify(store.cancelAgentRun(id, { reason: reason || 'manual' }), null, 2) }] }
  })

  server.tool(
    'agent_run_retry',
    '重试任务（新建 attempt+1 的子任务并指向原任务；后台任务会立刻重新执行，前台任务只重建记录）',
    { id: z.number() },
    async ({ id }) => {
      return { content: [{ type: 'text', text: JSON.stringify(retryAndDispatch(store, id, 'ai'), null, 2) }] }
    }
  )

  server.tool(
    'commit_review',
    '更新 commit 审查结果（pending 待审 / approved 通过 / issue 有问题）；pending 时清空审者信息',
    { cid: z.number(), reviewStatus: z.enum(['pending', 'approved', 'issue']), reviewNote: z.string().optional() },
    async ({ cid, reviewStatus, reviewNote }) => {
      return { content: [{ type: 'text', text: JSON.stringify(store.updateCommitReview(cid, { reviewStatus, note: reviewNote }, 'ai'), null, 2) }] }
    }
  )

  server.tool('commit_remove', '删除 commit 登记', { commitId: z.number() }, async ({ commitId }) => {
    return { content: [{ type: 'text', text: JSON.stringify(store.removeCommit(commitId), null, 2) }] }
  })

  // ---------- 仓库 ----------

  server.tool('repo_list', '仓库列表', async () => {
    return { content: [{ type: 'text', text: JSON.stringify(store.listRepos(), null, 2) }] }
  })

  server.tool(
    'repo_add',
    '新增仓库（tags 为逗号分隔标签，如“前端”/“后端”，分支目标可从标签继承）',
    { name: z.string(), localPath: z.string().optional(), gitlabProject: z.string().optional(), note: z.string().optional(), tags: z.string().optional(), testBranch: z.string().optional(), preBranch: z.string().optional(), releaseBranch: z.string().optional() },
    async ({ name, localPath, gitlabProject, note, tags, testBranch, preBranch, releaseBranch }) => {
      return { content: [{ type: 'text', text: JSON.stringify(store.addRepo({ name, localPath, gitlabProject, note, tags, testBranch, preBranch, releaseBranch }), null, 2) }] }
    }
  )

  server.tool(
    'repo_update',
    '更新仓库（含 tags 与测试/预发/上线分支配置）',
    { id: z.number(), name: z.string().optional(), localPath: z.string().optional(), gitlabProject: z.string().optional(), note: z.string().optional(), tags: z.string().optional(), testBranch: z.string().optional(), preBranch: z.string().optional(), releaseBranch: z.string().optional() },
    async ({ id, ...patch }) => {
      return { content: [{ type: 'text', text: JSON.stringify(store.updateRepo(id, patch), null, 2) }] }
    }
  )

  server.tool('branch_config_list', '标签级追踪目标列表（测试/预发/上线）', async () => {
    return { content: [{ type: 'text', text: JSON.stringify(store.listBranchConfigs(), null, 2) }] }
  })

  server.tool(
    'branch_config_set',
    '设置标签的测试/预发/上线追踪目标（分支或 tag 名；仓库通过 tags 继承，仓库级非空时优先）',
    { tag: z.string(), testBranch: z.string().optional(), preBranch: z.string().optional(), releaseBranch: z.string().optional() },
    async ({ tag, testBranch, preBranch, releaseBranch }) => {
      return { content: [{ type: 'text', text: JSON.stringify(store.upsertBranchConfig(tag, { testBranch, preBranch, releaseBranch }), null, 2) }] }
    }
  )

  server.tool('branch_config_remove', '删除标签配置', { tag: z.string() }, async ({ tag }) => {
    return { content: [{ type: 'text', text: JSON.stringify(store.deleteBranchConfig(tag), null, 2) }] }
  })

  server.tool('repo_remove', '删除仓库', { id: z.number() }, async ({ id }) => {
    return { content: [{ type: 'text', text: JSON.stringify(store.deleteRepo(id), null, 2) }] }
  })

  // ---------- 工作区准备（分支 / worktree / 开发提示词） ----------

  server.tool(
    'unit_repo_list',
    '列出工作单元（group / task）登记的涉及仓库（branch / worktree_path）',
    { node: z.union([z.number(), z.string()]) },
    mcpValidate(async ({ node }) => {
      const n = store.resolveRef(String(node))
      return { content: [{ type: 'text', text: JSON.stringify(store.listUnitRepos(n.id), null, 2) }] }
    })
  )

  server.tool(
    'unit_repo_add',
    '登记工作单元涉及仓库（按 node × repo 幂等；已存在时只更新显式传入的字段）',
    {
      node: z.union([z.number(), z.string()]),
      repoId: z.union([z.number(), z.string()]),
      branch: z.string().optional(),
      worktreePath: z.string().optional()
    },
    mcpValidate(async ({ node, repoId, branch, worktreePath }) => {
      const n = store.resolveRef(String(node))
      const out = store.addUnitRepo(n.id, { repoId, branch, worktreePath }, 'ai')
      return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] }
    })
  )

  server.tool(
    'unit_repo_remove',
    '移除工作单元仓库关联',
    { id: z.union([z.number(), z.string()]) },
    mcpValidate(async ({ id }) => {
      return { content: [{ type: 'text', text: JSON.stringify(store.deleteUnitRepo(Number(id)), null, 2) }] }
    })
  )

  server.tool(
    'unit_setup',
    '创建工作区：按 branchTemplate 逐仓库建分支 + worktree（分支从子需求分支派生），回填并返回开发提示词。dryRun 只做规划、不碰 git 不落库',
    {
      node: z.union([z.number(), z.string()]),
      repoIds: z.array(z.union([z.number(), z.string()])).optional(),
      branch: z.string().optional(),
      baseBranch: z.string().optional(),
      dryRun: z.boolean().optional()
    },
    mcpValidate(async ({ node, repoIds, branch, baseBranch, dryRun }) => {
      const n = store.resolveRef(String(node))
      const out = await setupWorkspace(store, n.id, { repoIds, branch, baseBranch, dryRun: !!dryRun, by: 'ai' })
      return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] }
    })
  )

  server.tool(
    'unit_prompt',
    '生成 / 刷新开发提示词（纯读，不碰 git 不落库）：节点上下文 + 工作区路径 + 分支基线 + 文档清单 + 命令与约定',
    { node: z.union([z.number(), z.string()]) },
    mcpValidate(async ({ node }) => {
      const n = store.resolveRef(String(node))
      return { content: [{ type: 'text', text: JSON.stringify(getWorkspacePrompt(store, n.id), null, 2) }] }
    })
  )

  server.tool(
    'unit_cleanup',
    '清理工作区（移除 worktree / 删除已并入基线分支）；破坏性操作，必须 confirm: true',
    {
      node: z.union([z.number(), z.string()]),
      // `.catch(undefined)`：对外 schema 仍是 required boolean（AI 看到的契约不变），
      // 但「没传 confirm」不再被 SDK 拦成 -32602，而是下沉到 handler 由 mcpValidate
      // 归一成 isError + CONFIRM_REQUIRED——与 HTTP / CLI 的拒绝语义一致（同 D6 纪律）。
      confirm: z.boolean().catch(undefined),
      removeBranch: z.boolean().optional()
    },
    mcpValidate(async ({ node, confirm, removeBranch }) => {
      const n = store.resolveRef(String(node))
      const out = await cleanupWorkspace(store, n.id, { confirm: !!confirm, removeBranch: removeBranch !== false, by: 'ai' })
      return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] }
    })
  )

  // ---------- 导入 / 批量 ----------

  server.tool(
    'import_outline',
    '大纲导入（markdown 缩进格式）',
    { content: z.string(), parentPath: z.string().optional(), dryRun: z.boolean().optional() },
    async ({ content, parentPath, dryRun }) => {
      return { content: [{ type: 'text', text: JSON.stringify(importOutline(store, content, { parentPath, dryRun: !!dryRun, by: 'ai' }), null, 2) }] }
    }
  )

  server.tool(
    'batch',
    '批量操作',
    { ops: z.array(z.any()), dryRun: z.boolean().optional() },
    async ({ ops, dryRun }) => {
      return { content: [{ type: 'text', text: JSON.stringify(applyBatch(store, ops, { dryRun: !!dryRun, by: 'ai' }), null, 2) }] }
    }
  )

  // ---------- 配置 ----------

  server.tool('config_get', '读取配置（token 打码）', async () => {
    return { content: [{ type: 'text', text: JSON.stringify(maskToken(loadConfig()), null, 2) }] }
  })

  server.tool('agent_run_get', '读取 agent 运行记录（测试/派单；含输出，200KB 截断）', { id: z.number() }, async ({ id }) => {
    return { content: [{ type: 'text', text: JSON.stringify(store.getAgentRun(id), null, 2) }] }
  })

  server.tool(
    'comment_add',
    '添加 diff 行级评论（文件路径必填；行号/片段可选）',
    {
      node: z.union([z.number(), z.string()]),
      filePath: z.string(),
      content: z.string(),
      repo: z.string().optional(),
      commitSha: z.string().optional(),
      lineStart: z.number().optional(),
      lineEnd: z.number().optional(),
      snippet: z.string().optional()
    },
    async ({ node, filePath, content, repo, commitSha, lineStart, lineEnd, snippet }) => {
      const n = store.resolveRef(String(node))
      const c = store.createComment(n.id, { repo, filePath, commitSha, lineStart, lineEnd, snippet, content }, 'mcp')
      return { content: [{ type: 'text', text: JSON.stringify(c, null, 2) }] }
    }
  )

  server.tool(
    'comment_list',
    '列出评论（给 node 按节点查；或给 filePath 按文件全库查）',
    { node: z.union([z.number(), z.string()]).optional(), filePath: z.string().optional(), commitSha: z.string().optional() },
    async ({ node, filePath, commitSha }) => {
      const list = node != null
        ? store.listComments(store.resolveRef(String(node)).id, { filePath: filePath || null })
        : store.listCommentsByFile(filePath || '', { commitSha: commitSha || null })
      return { content: [{ type: 'text', text: JSON.stringify(list, null, 2) }] }
    }
  )

  server.tool(
    'comment_update',
    '更新评论（状态 open/resolved 或修改内容）',
    { id: z.number(), status: z.enum(['open', 'resolved']).optional(), content: z.string().optional() },
    async ({ id, status, content }) => {
      const c = store.updateComment(id, { status, content })
      return { content: [{ type: 'text', text: JSON.stringify(c, null, 2) }] }
    }
  )

  server.tool('comment_remove', '删除评论', { id: z.number() }, async ({ id }) => {
    store.deleteComment(id)
    return { content: [{ type: 'text', text: JSON.stringify({ ok: true, id }, null, 2) }] }
  })

  // ---------- 回归测试闭环（AI 可回归测试用例 + 测试/验收报告） ----------

  server.tool(
    'test_case_list',
    '列出节点的测试用例（AI 可回归测试）；kind 可筛 regression/acceptance/code_check/biz_check/release_check',
    { node: z.union([z.number(), z.string()]), kind: z.string().optional(), includeDisabled: z.boolean().optional() },
    async ({ node, kind, includeDisabled }) => {
      const n = store.resolveRef(String(node))
      const list = store.listTestCases(n.id, { kind: kind || null, includeDisabled: !!includeDisabled })
      return { content: [{ type: 'text', text: JSON.stringify(list, null, 2) }] }
    }
  )

  server.tool(
    'test_case_upsert',
    '按用例名 get-or-create 测试用例（幂等）：已存在则更新内容与期望，返回 created 标记',
    {
      node: z.union([z.number(), z.string()]),
      name: z.string(),
      prompt: z.string(),
      kind: z.enum(['regression', 'acceptance', 'code_check', 'biz_check', 'release_check']).optional(),
      expectation: z.string().optional(),
      enabled: z.boolean().optional()
    },
    async ({ node, name, prompt, kind, expectation, enabled }) => {
      const n = store.resolveRef(String(node))
      const c = store.upsertTestCase(n.id, { name, prompt, kind: kind || 'regression', expectation: expectation ?? null, enabled: enabled === undefined ? 1 : enabled }, 'mcp')
      return { content: [{ type: 'text', text: JSON.stringify(c, null, 2) }] }
    }
  )

  server.tool(
    'test_case_update',
    '更新测试用例（改名 / 改类型 / 改内容 / 改期望 / 启停）',
    {
      id: z.number(),
      name: z.string().optional(),
      kind: z.enum(['regression', 'acceptance', 'code_check', 'biz_check', 'release_check']).optional(),
      prompt: z.string().optional(),
      expectation: z.string().optional(),
      enabled: z.boolean().optional()
    },
    async ({ id, name, kind, prompt, expectation, enabled }) => {
      const c = store.updateTestCase(id, { name, kind, prompt, expectation, enabled }, 'mcp')
      return { content: [{ type: 'text', text: JSON.stringify(c, null, 2) }] }
    }
  )

  server.tool('test_case_remove', '删除测试用例（连带删除的仅是用例，历史报告保留但 case_id 置空）', { id: z.number() }, async ({ id }) => {
    store.deleteTestCase(id)
    return { content: [{ type: 'text', text: JSON.stringify({ ok: true, id }, null, 2) }] }
  })

  server.tool(
    'test_case_reorder',
    '按 id 顺序重排测试用例',
    { node: z.union([z.number(), z.string()]), orderedIds: z.array(z.number()) },
    async ({ node, orderedIds }) => {
      const n = store.resolveRef(String(node))
      const list = store.reorderTestCases(n.id, orderedIds)
      return { content: [{ type: 'text', text: JSON.stringify(list, null, 2) }] }
    }
  )

  server.tool(
    'test_run',
    '派单执行回归测试用例，并为每条用例开一条 running 报告。缺省 grouped：把选中用例拼成一段提示词派一个 agent 任务；fanout=true：每条用例派独立 agent 任务（并行），maxParallel 设并行护栏（缺省 4，上限 16）。dryRun 只返回将要执行的用例与提示词',
    {
      node: z.union([z.number(), z.string()]),
      caseIds: z.array(z.number()).optional(),
      kind: z.enum(['regression', 'acceptance', 'code_check', 'biz_check', 'release_check']).optional(),
      prompt: z.string().optional(),
      agent: z.string().optional(),
      model: z.string().optional(),
      cwd: z.string().optional(),
      dryRun: z.boolean().optional(),
      fanout: z.boolean().optional(),
      // 故意不在协议层用 z.number() 卡类型：否则 `true` / "4" / [1] 会被 SDK 拦成 -32602，
      // 与 HTTP / CLI 的 VALIDATION_FAILED 口径不一致（决策 31/35 的「业务错误不泄漏 SDK 错误」
      // 同样适用于值域/类型）。这里接原始值，交给 handler 内的 normalizeMaxParallel 统一严格拒绝。
      maxParallel: z.unknown().optional()
    },
    // 业务错误（如 fan-out 护栏超限 / maxParallel 值域）走 isError + 稳定错误码，
    // 不把异常直接抛回 SDK（与其它门禁 / 聚合工具同一口径）。
    mcpValidate(async ({ node, caseIds, kind, prompt, agent, model, cwd, dryRun, fanout, maxParallel }) => {
      const n = store.resolveRef(String(node))
      const out = runTestCases(
        store,
        n.id,
        {
          caseIds: caseIds || null,
          kind: kind || null,
          prompt: prompt || null,
          agent,
          model,
          cwd,
          dryRun: !!dryRun,
          fanout: !!fanout,
          maxParallel: maxParallel != null ? maxParallel : null
        },
        'mcp'
      )
      return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] }
    })
  )

  server.tool(
    'test_report_list',
    '列出节点的测试/验收报告（倒序，可按 caseId / kind 筛）',
    { node: z.union([z.number(), z.string()]), caseId: z.number().optional(), kind: z.string().optional(), limit: z.number().optional() },
    async ({ node, caseId, kind, limit }) => {
      const n = store.resolveRef(String(node))
      const list = store.listTestReports(n.id, { caseId: caseId ?? null, kind: kind || null, limit: limit || 100 })
      return { content: [{ type: 'text', text: JSON.stringify(list, null, 2) }] }
    }
  )

  server.tool(
    'test_report_get',
    '读取单条测试报告；format=md 返回可贴进 issue / MR 的 markdown',
    { id: z.number(), format: z.string().optional() },
    mcpValidate(async ({ id, format }) => {
      const report = store.getTestReport(id)
      const text =
        store.normalizeFormat(format) === 'md'
          ? renderTestReportMd(store, report)
          : JSON.stringify(report, null, 2)
      return { content: [{ type: 'text', text }] }
    })
  )

  server.tool(
    'test_report_finish',
    '回写测试报告终态（agent 执行完 / 前台执行者回写时调用）',
    {
      id: z.number(),
      status: z.enum(['running', 'pass', 'fail', 'blocked', 'error', 'cancelled']),
      summary: z.string().optional(),
      detail: z.string().optional(),
      runId: z.number().optional(),
      overwrite: z.boolean().optional().describe('终态互转 / 终态回退时显式覆盖（默认拒绝）')
    },
    async ({ id, status, summary, detail, runId, overwrite }) => {
      const r = store.finishTestReport(id, { status, summary, detail, runId, overwrite: !!overwrite }, 'mcp')
      return { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] }
    }
  )

  server.tool(
    'acceptance_report',
    '验收报告：聚合节点（含可选子树）的用例最近结果、通过率与未覆盖清单；format=md 返回可贴进 issue 的 markdown',
    { node: z.union([z.number(), z.string()]), scope: z.string().optional(), format: z.string().optional() },
    mcpValidate(async ({ node, scope, format }) => {
      const n = store.resolveRef(String(node))
      const report = store.buildAcceptanceReport(n.id, { scope })
      const text = store.normalizeFormat(format) === 'md' ? renderAcceptanceMd(report) : JSON.stringify(report, null, 2)
      return { content: [{ type: 'text', text }] }
    })
  )

  server.tool(
    'acceptance_status',
    '验收签收状态：同时返回测试证据、签收结论、签收人与证据是否已失效；format=md 返回可贴进 issue 的 markdown',
    { node: z.union([z.number(), z.string()]), scope: z.string().optional(), format: z.string().optional() },
    mcpValidate(async ({ node, scope, format }) => {
      const n = store.resolveRef(String(node))
      const status = store.buildAcceptanceStatus(n.id, { scope })
      const text = store.normalizeFormat(format) === 'md' ? renderAcceptanceStatusMd(status) : JSON.stringify(status, null, 2)
      return { content: [{ type: 'text', text }] }
    })
  )

  server.tool(
    'acceptance_sign',
    '签收 / 驳回验收：绑定当前测试证据指纹；后续用例或报告变化会让签收自动失效',
    {
      node: z.union([z.number(), z.string()]),
      decision: z.enum(['accepted', 'rejected']),
      scope: z.string().optional(),
      comment: z.string().optional()
    },
    mcpValidate(async ({ node, decision, scope, comment }) => {
      const n = store.resolveRef(String(node))
      const signoff = store.upsertAcceptanceSignoff(n.id, { decision, scope, comment: comment ?? null }, 'mcp')
      return { content: [{ type: 'text', text: JSON.stringify(signoff, null, 2) }] }
    })
  )

  server.tool(
    'requirement_readiness',
    '需求就绪门禁：判定节点（含可选子树）的需求内容 / 概要设计 / 可回归用例是否齐备，给出能否进入回归测试的结论；format=md 返回可贴进 issue 的 markdown',
    { node: z.union([z.number(), z.string()]), scope: z.string().optional(), format: z.string().optional() },
    mcpValidate(async ({ node, scope, format }) => {
      const n = store.resolveRef(String(node))
      const readiness = store.buildRequirementReadiness(n.id, { scope })
      const text = store.normalizeFormat(format) === 'md' ? renderReadinessMd(readiness) : JSON.stringify(readiness, null, 2)
      return { content: [{ type: 'text', text }] }
    })
  )

  server.tool(
    'mindmap',
    '思维导图：把节点（含可选子树）投影成 mermaid mindmap，供人俯瞰需求拆解；format=md 返回可贴进 issue / 设计文档的 markdown，json 返回 mermaid 文本 + 结构化 nodes/edges/totals',
    {
      node: z.union([z.number(), z.string()]),
      scope: z.string().optional(),
      maxDepth: z.union([z.number(), z.string()]).optional(),
      format: z.string().optional()
    },
    mcpValidate(async ({ node, scope, maxDepth, format }) => {
      const n = store.resolveRef(String(node))
      const mindmap = store.buildMindmap(n.id, { scope, maxDepth: maxDepth === undefined ? null : maxDepth })
      const text = store.normalizeFormat(format) === 'md' ? renderMindmapMd(mindmap) : JSON.stringify(mindmap, null, 2)
      return { content: [{ type: 'text', text }] }
    })
  )

  server.tool(
    'delivery_gate',
    '交付门禁：汇总需求就绪 / 测试验收 / 上线治理三段既有结论，给出唯一“能否交付”判定；format=md 返回可贴进 issue 的 markdown',
    { node: z.union([z.number(), z.string()]), scope: z.string().optional(), format: z.string().optional() },
    mcpValidate(async ({ node, scope, format }) => {
      const n = store.resolveRef(String(node))
      const gate = store.buildDeliveryGate(n.id, { scope })
      const text = store.normalizeFormat(format) === 'md' ? renderDeliveryGateMd(gate) : JSON.stringify(gate, null, 2)
      return { content: [{ type: 'text', text }] }
    })
  )

  // ---------- 概要设计大纲 / 思维导图（需求管理 → 概要设计 → 文档） ----------

  server.tool(
    'design_outline',
    '概要设计大纲：从需求树的子需求 / 任务组 / 子任务结构推导 markdown 骨架 + mermaid 思维导图；format=md 返回可直接写入「概要设计」文档的内容',
    { node: z.union([z.number(), z.string()]), scope: z.string().optional(), format: z.string().optional() },
    mcpValidate(async ({ node, scope, format }) => {
      const n = store.resolveRef(String(node))
      const outline = store.buildDesignOutline(n.id, { scope })
      const text =
        store.normalizeFormat(format) === 'md' ? renderDesignOutlineMd(outline) : JSON.stringify(outline, null, 2)
      return { content: [{ type: 'text', text }] }
    })
  )

  server.tool(
    'design_outline_apply',
    '把推导出的概要设计骨架写入各需求的「概要设计」文档（与需求就绪门禁同一份文档）；默认不覆盖已填写内容，overwrite=true 才覆盖',
    {
      node: z.union([z.number(), z.string()]),
      scope: z.string().optional(),
      overwrite: z.boolean().optional(),
      dryRun: z.boolean().optional().describe('只回报将写哪些、不落库不动 revision（预演）')
    },
    mcpValidate(async ({ node, scope, overwrite, dryRun }) => {
      const n = store.resolveRef(String(node))
      const out = applyDesignOutline(store, n.id, { scope, overwrite: !!overwrite, dryRun: !!dryRun, by: 'mcp' })
      return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] }
    })
  )

  // ---------- 上线治理（上线配置 / 上线 SQL / 上线检查清单） ----------

  server.tool(
    'release_item_list',
    '列出节点的上线项（上线配置 / 上线 SQL / 上线检查）；kind 可筛 config/sql/check，status 可筛 pending/ready/done/blocked/skipped',
    {
      node: z.union([z.number(), z.string()]),
      kind: z.enum(['config', 'sql', 'check']).optional(),
      status: z.enum(['pending', 'ready', 'done', 'blocked', 'skipped']).optional(),
      includeOptional: z.boolean().optional()
    },
    async ({ node, kind, status, includeOptional }) => {
      const n = store.resolveRef(String(node))
      const list = store.listReleaseItems(n.id, {
        kind: kind || null,
        status: status || null,
        includeOptional: includeOptional === undefined ? true : includeOptional
      })
      return { content: [{ type: 'text', text: JSON.stringify(list, null, 2) }] }
    }
  )

  server.tool(
    'release_item_upsert',
    '按名称 get-or-create 上线项（幂等）：已存在则更新内容/回滚/状态/必做，返回 created 标记',
    {
      node: z.union([z.number(), z.string()]),
      name: z.string(),
      kind: z.enum(['config', 'sql', 'check']).optional(),
      content: z.string().optional(),
      rollback: z.string().optional(),
      status: z.enum(['pending', 'ready', 'done', 'blocked', 'skipped']).optional(),
      required: z.boolean().optional()
    },
    async ({ node, name, kind, content, rollback, status, required }) => {
      const n = store.resolveRef(String(node))
      const item = store.upsertReleaseItem(
        n.id,
        {
          name,
          // 只传显式给出的字段：未传的交给 store 决定（新建取默认值、已存在保持原样）。
          // 与 CLI / HTTP 保持同一语义——入口补默认值会让既有的 rollback / status / required 静默回退。
          kind,
          content,
          rollback,
          status,
          required
        },
        'mcp'
      )
      return { content: [{ type: 'text', text: JSON.stringify(item, null, 2) }] }
    }
  )

  server.tool(
    'release_item_update',
    '更新上线项（改名 / 改类型 / 改内容 / 改回滚 / 改状态 / 改必做）',
    {
      id: z.number(),
      name: z.string().optional(),
      kind: z.enum(['config', 'sql', 'check']).optional(),
      content: z.string().optional(),
      rollback: z.string().optional(),
      status: z.enum(['pending', 'ready', 'done', 'blocked', 'skipped']).optional(),
      required: z.boolean().optional()
    },
    async ({ id, name, kind, content, rollback, status, required }) => {
      const item = store.updateReleaseItem(id, { name, kind, content, rollback, status, required }, 'mcp')
      return { content: [{ type: 'text', text: JSON.stringify(item, null, 2) }] }
    }
  )

  server.tool('release_item_remove', '删除上线项', { id: z.number() }, async ({ id }) => {
    const out = store.deleteReleaseItem(id)
    return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] }
  })

  server.tool(
    'release_item_reorder',
    '按 id 顺序重排上线项',
    { node: z.union([z.number(), z.string()]), orderedIds: z.array(z.number()) },
    async ({ node, orderedIds }) => {
      const n = store.resolveRef(String(node))
      const list = store.reorderReleaseItems(n.id, orderedIds)
      return { content: [{ type: 'text', text: JSON.stringify(list, null, 2) }] }
    }
  )

  server.tool(
    'release_checklist',
    '上线检查清单：聚合节点（含可选子树）的上线项完成度、就绪结论与阻塞项；format=md 返回可贴进上线单的 markdown',
    { node: z.union([z.number(), z.string()]), scope: z.string().optional(), format: z.string().optional() },
    mcpValidate(async ({ node, scope, format }) => {
      const n = store.resolveRef(String(node))
      const checklist = store.buildReleaseChecklist(n.id, { scope })
      const text = store.normalizeFormat(format) === 'md' ? renderReleaseChecklistMd(checklist) : JSON.stringify(checklist, null, 2)
      return { content: [{ type: 'text', text }] }
    })
  )

  server.tool(
    'release_check',
    '派单执行上线前置检查：把上线清单 + code_check/biz_check/release_check 用例拼成提示词交给 agent 运行时，并为每条用例开 running 报告。dryRun 只返回将要检查的内容',
    {
      node: z.union([z.number(), z.string()]),
      caseIds: z.array(z.number()).optional(),
      scope: z.string().optional(),
      prompt: z.string().optional(),
      agent: z.string().optional(),
      model: z.string().optional(),
      cwd: z.string().optional(),
      dryRun: z.boolean().optional()
    },
    mcpValidate(async ({ node, caseIds, scope, prompt, agent, model, cwd, dryRun }) => {
      const n = store.resolveRef(String(node))
      const out = runReleaseChecks(
        store,
        n.id,
        { caseIds: caseIds || null, scope, prompt: prompt || null, agent, model, cwd, dryRun: !!dryRun },
        'mcp'
      )
      return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] }
    })
  )

  server.tool(
    'agent_run_update',
    '回写 agent 任务结果（Qoder IDE 等前台执行者完成后调用：追加输出 + 置终态）。' +
      'cliSessionId/workDir 会沉淀到会话，供下次 --resume 续跑',
    {
      id: z.number(),
      status: z.enum(['success', 'failed', 'timeout', 'cancelled']),
      output: z.string().optional(),
      exitCode: z.number().optional(),
      failureReason: z.string().optional(),
      cliSessionId: z.string().optional(),
      workDir: z.string().optional()
    },
    async ({ id, status, output, exitCode, failureReason, cliSessionId, workDir }) => {
      if (output) {
        store.appendAgentRunOutput(id, output)
        store.appendAgentRunMessage(id, { type: 'text', content: output })
      }
      const run = store.finishAgentRun(id, {
        status,
        exitCode: exitCode ?? null,
        failureReason: failureReason ?? null,
        cliSessionId: cliSessionId ?? null,
        workDir: workDir ?? null
      })
      return { content: [{ type: 'text', text: JSON.stringify(run, null, 2) }] }
    }
  )

  server.tool(
    'config_set',
    '更新配置',
    { port: z.number().optional(), gitlabBase: z.string().optional(), gitlabToken: z.string().optional() },
    async ({ port, gitlabBase, gitlabToken }) => {
      const patch = {}
      if (port !== undefined) patch.port = port
      if (gitlabBase !== undefined || gitlabToken !== undefined) {
        patch.gitlab = {}
        if (gitlabBase !== undefined) patch.gitlab.base_url = gitlabBase
        if (gitlabToken !== undefined) patch.gitlab.token = gitlabToken
      }
      return { content: [{ type: 'text', text: JSON.stringify(maskToken(saveConfig(patch)), null, 2) }] }
    }
  )

  server.tool(
    'upload_image',
    '上传文档图片（png / jpg / jpeg / gif / webp，≤10 MB）；data 为 base64 或 data URL，返回可写进 Markdown 的 /uploads/<name> 地址',
    // `.catch(undefined)`：对外的 JSON schema 仍是 `type: string` + required（AI 看到的契约不变），
    // 但类型错误 / 缺字段不再被 SDK 拦成 `-32602`，而是下沉到 handler 由 mcpValidate 归一成
    // `isError + VALIDATION_FAILED`，与 HTTP / CLI 的错误契约一致（D6）。
    { name: z.string().catch(undefined), data: z.string().catch(undefined) },
    mcpValidate(async ({ name, data }) => {
      const out = saveUpload({ name, data })
      return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] }
    })
  )

  return server
}

export async function runMcp() {
  const cfg = loadConfig()
  const db = openDb()
  const store = createStore(db, { docPresets: cfg.docPresets, readiness: cfg.readiness, status: cfg.status })
  const server = createMcpServer({ store })
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

const isDirect = process.argv[1] && process.argv[1].endsWith('server/mcp.mjs')
if (isDirect) {
  runMcp().catch((e) => {
    console.error(`MCP: ${e.message}`)
    process.exit(1)
  })
}
