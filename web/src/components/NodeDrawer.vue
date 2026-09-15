<template>
  <el-drawer v-model="internalVisible" :title="node.path || node.name" :size="drawerWidth" @close="emit('close')" destroy-on-close>
    <template #header="{ close, titleId }">
      <div style="display:flex;align-items:center;gap:8px">
        <h4 :id="titleId" style="margin:0;flex:1;overflow:hidden;text-overflow:ellipsis">{{ node.path || node.name }}</h4>
        <el-tag size="small">{{ typeLabel(node.type) }}</el-tag>
        <el-button size="small" @click="toggleWidth">
          {{ drawerWidth === '760px' ? '加宽' : '默认' }}
        </el-button>
      </div>
    </template>

    <el-tabs v-model="tab">
      <el-tab-pane label="基本信息" name="info">
        <el-form label-width="80px" size="small">
          <el-form-item label="名称">
            <el-input v-model="editName" @blur="saveName" />
          </el-form-item>
          <el-form-item label="状态">
            <el-select v-model="editStatus" @change="saveStatus" style="width:100%">
              <el-option v-for="(l, k) in statusLabels" :key="k" :label="l" :value="k" />
            </el-select>
          </el-form-item>
          <el-form-item label="创建者">{{ node.createdBy }}</el-form-item>
          <el-form-item label="更新时间">{{ node.updatedAt }}</el-form-item>
        </el-form>

        <el-divider content-position="left">属性</el-divider>
        <el-form label-width="100px" size="small">
          <el-form-item v-for="a in attrDefs" :key="a.key" :label="a.label">
            <el-input v-if="a.dataType === 'text' || a.dataType === 'url'" v-model="attrValues[a.key]" @blur="saveAttrs" />
            <el-input v-if="a.dataType === 'textarea'" v-model="attrValues[a.key]" type="textarea" :rows="3" @blur="saveAttrs" />
            <el-input-number v-if="a.dataType === 'number'" v-model="attrValues[a.key]" :min="0" style="width:100%" @change="saveAttrs" />
            <el-date-picker v-if="a.dataType === 'date'" v-model="attrValues[a.key]" type="date" value-format="YYYY-MM-DD" style="width:100%" @change="saveAttrs" />
            <el-select v-if="a.dataType === 'select'" v-model="attrValues[a.key]" style="width:100%" @change="saveAttrs">
              <el-option v-for="o in (a.options || [])" :key="o.value" :label="o.label" :value="o.value" />
            </el-select>
          </el-form-item>
          <el-empty v-if="!attrDefs.length" description="该类型暂无属性定义" />
        </el-form>
      </el-tab-pane>

      <el-tab-pane label="文档" name="docs">
        <DocPane :node-id="node.id" />
      </el-tab-pane>

      <el-tab-pane v-if="node.type === 'requirement' || node.type === 'subreq' || node.type === 'project'" label="概要设计" name="design">
        <div class="design-head">
          <el-select v-model="designScope" size="small" style="width:120px" @change="loadDesignOutline">
            <el-option label="仅本节点" value="self" />
            <el-option label="含子树" value="subtree" />
          </el-select>
          <span class="design-count" v-if="designOutline.totals">可推导 {{ designOutline.totals.units }} 个需求 / {{ designOutline.totals.nodes }} 个节点</span>
          <el-button size="small" :disabled="!designMd" @click="copyDesignMd">复制骨架</el-button>
          <el-button size="small" type="primary" :disabled="!designMd" @click="applyDesign">写入概要设计</el-button>
        </div>
        <el-alert
          v-if="designOutline.totals && designOutline.totals.nodes === 0"
          type="info"
          :closable="false"
          title="当前范围没有可推导的节点结构（先补充子需求 / 任务组 / 子任务）"
          style="margin-bottom:10px"
        />
        <div ref="designHostRef" v-show="designMd" class="design-host" />
      </el-tab-pane>

      <el-tab-pane label="导图" name="mindmap">
        <MindmapPane :node-id="node.id" />
      </el-tab-pane>

      <el-tab-pane label="交付" name="delivery">
        <div class="delivery-head">
          <el-tag :type="deliveryTagType(gate.decision)" effect="dark" size="large">{{ deliveryDecisionLabel(gate.decision) }}</el-tag>
          <el-select v-model="deliveryScope" size="small" style="width:120px" @change="loadDeliveryGate">
            <el-option label="仅本节点" value="self" />
            <el-option label="含子树" value="subtree" />
          </el-select>
        </div>
        <el-divider content-position="left">验收签收</el-divider>
        <div class="delivery-head" style="margin-bottom:8px">
          <el-tag :type="acceptanceTagType(acceptance.state)" effect="plain">{{ acceptanceStateLabel(acceptance.state) }}</el-tag>
          <span v-if="acceptance.signoff" class="acceptance-meta">
            {{ acceptance.signoff.signedBy }} · {{ acceptance.signoff.signedAt }}
          </span>
        </div>
        <div v-if="acceptance.signoff && acceptance.signoff.comment" class="acceptance-comment">
          {{ acceptance.signoff.comment }}
        </div>
        <div v-if="acceptance.state === 'not_applicable'" class="acceptance-hint">当前范围没有可验收的测试用例。</div>
        <div v-else class="acceptance-actions">
          <el-input v-model="acceptanceComment" size="small" placeholder="验收意见（驳回时建议填写）" style="max-width:320px" />
          <el-button size="small" type="success" :loading="signingAcceptance" @click="signAcceptance('accepted')">通过验收</el-button>
          <el-button size="small" type="danger" plain :loading="signingAcceptance" @click="signAcceptance('rejected')">驳回</el-button>
        </div>
        <div class="acceptance-evidence">
          证据：{{ acceptance.report.totals.pass }} 通过 / {{ acceptance.report.totals.cases }} 用例 ·
          指纹 {{ shortFingerprint(acceptance.report.evidenceFingerprint) }}
        </div>
        <el-alert
          v-if="gate.decision === 'unknown'"
          type="info"
          :closable="false"
          title="当前范围还没有可判定的交付证据（需求 / 用例 / 必做上线项都为空）"
          style="margin-bottom:10px"
        />
        <el-table :data="gate.sources || []" size="small">
          <el-table-column prop="label" label="来源" width="90" />
          <el-table-column label="结论" width="90">
            <template #default="{ row }">
              <el-tag size="small" :type="deliveryTagType(row.status)" effect="plain">{{ deliveryStatusLabel(row.status) }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="detail" label="说明" min-width="220" />
        </el-table>
        <template v-if="(gate.blockers || []).length">
          <el-divider content-position="left">阻塞项</el-divider>
          <el-table :data="gate.blockers" size="small" max-height="320">
            <el-table-column prop="label" label="来源" width="90" />
            <el-table-column prop="name" label="阻塞项" min-width="180" />
            <el-table-column prop="detail" label="说明" min-width="200" />
          </el-table>
        </template>
      </el-tab-pane>

      <el-tab-pane label="子节点" name="children">
        <el-empty v-if="!children.length" description="无子节点" />
        <el-table v-else :data="children" size="small" @row-click="onChildClick">
          <el-table-column prop="name" label="名称" min-width="150" />
          <el-table-column prop="type" label="类型" width="80">
            <template #default="{ row }">{{ typeLabel(row.type) }}</template>
          </el-table-column>
          <el-table-column prop="status" label="状态" width="70" />
        </el-table>
      </el-tab-pane>

      <el-tab-pane v-if="node.type === 'group' || node.type === 'task' || node.type === 'defect'" label="提交" name="commits">
        <el-form :model="commitForm" size="small" label-width="50px">
          <el-form-item label="SHA">
            <el-input v-model="commitForm.sha" placeholder="7–40 位十六进制" />
          </el-form-item>
          <el-form-item label="仓库">
            <el-select v-model="commitForm.repo" clearable filterable style="width:100%">
              <el-option v-for="r in repos" :key="r.id" :label="r.name" :value="r.name" />
            </el-select>
          </el-form-item>
          <el-form-item label="说明">
            <el-input v-model="commitForm.note" />
          </el-form-item>
          <el-form-item>
            <el-button type="primary" @click="addCommit">登记</el-button>
          </el-form-item>
        </el-form>
        <div v-if="commits.length" style="display:flex;justify-content:flex-end;margin:4px 0">
          <el-button size="small" @click="openAllInIdea">在 IDEA 查看全部变更（{{ commits.length }}）</el-button>
        </div>
        <el-alert v-if="pendingMerge" type="warning" :closable="false" style="margin:4px 0;padding:6px 10px">
          <template #title>
            <span>有 {{ pendingMerge.conflictFiles?.length || 0 }} 个冲突待处理（{{ pendingMerge.repo }}）</span>
            <el-button link type="primary" size="small" style="margin-left:8px" @click="openConflicts(pendingMerge.id)">处理冲突</el-button>
          </template>
        </el-alert>
        <el-alert v-if="dupGroupCount" type="warning" :closable="false" style="margin:4px 0;padding:6px 10px">
          <template #title>
            <span>检测到 {{ dupGroupCount }} 组重复提交（worktree / 需求分支重复登记）</span>
            <el-button link type="primary" size="small" style="margin-left:8px" @click="dedupeAll">一键去重</el-button>
          </template>
        </el-alert>
        <div v-if="commits.length" class="merge-legend">
          合并状态：<span class="legend-ok">✓ 已合入</span> · <span class="legend-no">✗ 未合入</span> · <span class="legend-unknown">— 未配置追踪目标（在顶部「设置」中配置）</span>
        </div>
        <el-table v-if="commits.length" :data="commits" size="small" max-height="300">
          <el-table-column prop="sha" label="SHA" width="108">
            <template #default="{ row }">
              <span>{{ row.sha }}</span>
              <el-tooltip v-if="dupOf(row)" placement="top">
                <template #content>
                  <div v-for="r in dupOf(row)" :key="r.cid" style="line-height:1.8">
                    [{{ relLabel(r.relation) }}] {{ r.sha.slice(0, 9) }} @ {{ shortPath(r.nodePath) }}
                  </div>
                  <div style="color:#bbb;margin-top:4px">同 sha / 同内容 可用上方「一键去重」；merge 覆盖仅作关联展示</div>
                </template>
                <span style="color:#E6A23C;cursor:help;margin-left:3px">⇄</span>
              </el-tooltip>
            </template>
          </el-table-column>
          <el-table-column prop="repo" label="仓库" width="96" />
          <el-table-column prop="note" label="说明" min-width="100" />
          <el-table-column label="分支" width="122">
            <template #default="{ row }">
              <template v-if="branchOf(row) && branchOf(row).subBranches && branchOf(row).subBranches.length">
                <el-tooltip placement="top" :content="branchOf(row).subBranches.join('\n')">
                  <el-tag size="small" type="info" effect="plain">{{ shortBranch(branchOf(row).subBranches[0]) }}</el-tag>
                </el-tooltip>
                <el-tag v-if="branchOf(row).subBranches.length > 1" size="small" type="info" effect="plain" style="margin-left:2px">+{{ branchOf(row).subBranches.length - 1 }}</el-tag>
              </template>
              <span v-else style="color:#999">—</span>
            </template>
          </el-table-column>
          <el-table-column label="需求分支" width="84">
            <template #default="{ row }">
              <el-tooltip placement="top" :content="demandTitle(row)">
                <el-tag size="small" :type="demandTagType(row)" :effect="demandEffect(row)">{{ demandSymbol(row) }}</el-tag>
              </el-tooltip>
            </template>
          </el-table-column>
          <el-table-column label="合并" width="190">
            <template #header>
              <el-tooltip placement="top" content="✓ 已合入 / ✗ 未合入 / — 未配置或本地无该分支（先 git fetch）">
                <span style="cursor:help">合并</span>
              </el-tooltip>
            </template>
            <template #default="{ row }">
              <el-tag size="small" :type="tagType(trackOf(row).test)" :effect="tagEffect(trackOf(row).test)" :title="badgeTitle(trackOf(row).test, '测试')">{{ statusSymbol(trackOf(row).test) }}测试</el-tag>
              <el-tag size="small" class="tag-gap" :type="tagType(trackOf(row).pre)" :effect="tagEffect(trackOf(row).pre)" :title="badgeTitle(trackOf(row).pre, '预发')">{{ statusSymbol(trackOf(row).pre) }}预发</el-tag>
              <el-tag size="small" class="tag-gap" :type="tagType(trackOf(row).release)" :effect="tagEffect(trackOf(row).release)" :title="badgeTitle(trackOf(row).release, '上线')">{{ statusSymbol(trackOf(row).release) }}上线</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="64">
            <template #default="{ row }">
              <el-button link type="primary" size="small" @click="openDiff(row)">查看</el-button>
            </template>
          </el-table-column>
        </el-table>
      </el-tab-pane>
    </el-tabs>
  </el-drawer>

  <DiffPane v-model:visible="diffVisible" :commit="diffCommit" />
  <ConflictPane v-model:visible="conflictVisible" :merge-id="conflictMergeId" @resolved="loadPendingMerge" />
</template>

<script setup>
import { ref, watch, nextTick } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import api from '../api.js'
import DocPane from './DocPane.vue'
import DiffPane from './DiffPane.vue'
import ConflictPane from './ConflictPane.vue'
import Vditor from 'vditor'
import 'vditor/dist/index.css'

// 与 DocPane 同源的自托管资源路径（mermaid / KaTeX 不依赖外网 CDN）
const PREVIEW_OPTIONS = {
  cdn: '/vditor',
  lang: 'zh_CN',
  theme: { current: 'light' },
  hljs: { style: 'github', lineNumber: true },
  markdown: { toc: true, mark: true, mermaid: true, math: { engine: 'KaTeX' } }
}
import MindmapPane from './MindmapPane.vue'

const props = defineProps({ node: Object, visible: Boolean, initialTab: { type: String, default: 'info' } })
const emit = defineEmits(['close', 'updated'])

const internalVisible = ref(props.visible)
watch(() => props.visible, (v) => { internalVisible.value = v })

const tab = ref(props.initialTab)
const drawerWidth = ref('760px')

const editName = ref(props.node.name)
const editStatus = ref(props.node.status || 'todo')
const attrValues = ref({})
const attrDefs = ref([])
const children = ref([])
const commits = ref([])
const repos = ref([])
const deliveryScope = ref('self')
const gate = ref({ decision: 'unknown', sources: [], blockers: [] })
const acceptance = ref({ state: 'not_applicable', report: { totals: { cases: 0, pass: 0 }, evidenceFingerprint: '' }, signoff: null })
const acceptanceComment = ref('')
const signingAcceptance = ref(false)
const designScope = ref('self')
const designOutline = ref({ totals: null, units: [] })
const designMd = ref('')
const designHostRef = ref(null)
const DESIGN_NODE_TYPES = ['project', 'requirement', 'subreq']
const statusLabels = { todo: '待开始', doing: '进行中', testing: '提测中', done: '已完成', cancelled: '已取消' }
const typeLabel = (t) => ({ project: '项目', requirement: '需求', subreq: '子需求', group: '任务组', task: '子任务', defect: '缺陷' }[t] || t)
const deliveryDecisionLabel = (d) => ({ ready: '可交付', not_ready: '不可交付', unknown: '待判定' }[d] || d)
const deliveryStatusLabel = (s) => ({ pass: '通过', fail: '未通过', not_applicable: '不适用' }[s] || s)
const deliveryTagType = (s) => ({ ready: 'success', pass: 'success', not_ready: 'danger', fail: 'danger' }[s] || 'info')
const acceptanceStateLabel = (s) => ({
  not_applicable: '无验收对象',
  pending: '待签收',
  accepted: '已验收',
  rejected: '已驳回',
  stale: '签收已失效'
}[s] || s)
const acceptanceTagType = (s) => ({ accepted: 'success', rejected: 'danger', stale: 'warning', pending: 'info' }[s] || 'info')
const shortFingerprint = (v) => (v ? String(v).slice(0, 8) : '—')

const commitForm = ref({ sha: '', repo: '', note: '' })
const diffVisible = ref(false)
const diffCommit = ref(null)
const conflictVisible = ref(false)
const conflictMergeId = ref(null)
const pendingMerge = ref(null)

/** 网页 → IDEA：请求插件打开该节点全部提交的合并变更 */
async function openAllInIdea() {
  if (!commits.value.length) return
  try {
    await api.ideOpenDiff({ cids: commits.value.map((c) => c.id), title: `节点「${props.node.name}」全部变更` })
    ElMessage.success('已发送到 IDEA（若未弹出，请确认 IDEA 已打开且已加载 TaskBoard 插件）')
  } catch (e) {
    ElMessage.error('发送失败：' + (e.message || e))
  }
}
const trackMap = ref({})
const branchMap = ref({})
const dupMap = ref({})
const dupItems = ref([])
const dupGroupCount = ref(0)

function relLabel(rel) {
  return { 'same-sha': '同 sha 重复', 'patch-id': '同内容(不同sha)', 'merge-covers': 'merge 覆盖', 'covered-by': '被 merge 覆盖' }[rel] || rel
}

function shortPath(p) {
  return (p || '').split('/').slice(-2).join('/')
}

function branchOf(row) {
  return branchMap.value[row.id] || null
}

function shortBranch(b) {
  return b.length > 13 ? b.slice(0, 13) + '…' : b
}

function demandSymbol(row) {
  const b = branchOf(row)
  if (!b || !b.demandBranch) return '—'
  return b.demandContained ? '✓' : '✗'
}

function demandTagType(row) {
  const b = branchOf(row)
  if (!b || !b.demandBranch || b.demandContained === null) return 'info'
  return b.demandContained ? 'success' : 'warning'
}

function demandEffect(row) {
  const b = branchOf(row)
  return !b || !b.demandBranch || b.demandContained === null ? 'plain' : 'light'
}

function demandTitle(row) {
  const b = branchOf(row)
  if (!b || !b.demandBranch) return '需求分支：未配置（在需求节点属性「需求分支」中填写）'
  const st = b.demandContained === null ? '本地无该分支（先 git fetch）' : b.demandContained ? '已合入' : '未合入'
  return `需求分支（${b.demandBranch}）：${st}`
}

function dupOf(row) {
  return dupMap.value[row.id] || null
}

function openDiff(row) {
  diffCommit.value = row
  diffVisible.value = true
}

function openConflicts(id) {
  conflictMergeId.value = id
  conflictVisible.value = true
}

async function loadPendingMerge() {
  try {
    const out = await api.mergeRecords({ nodeId: props.node.id, state: 'precheck_conflict' })
    pendingMerge.value = out.items?.[0] || null
  } catch {
    pendingMerge.value = null
  }
}

function trackOf(row) {
  return trackMap.value[`${row.repo || ''}@${row.sha}`] || null
}

function badgeClass(t) {
  if (!t || t.contained === null) return 'badge-unknown'
  return t.contained ? 'badge-ok' : 'badge-no'
}

function badgeTitle(t, label) {
  if (!t) return `${label}：未检测`
  if (t.contained === null) {
    return `${label}：${t.reason === 'ref-not-found' ? '本地无该分支/Tag（先 git fetch）' : '未配置'}`
  }
  return `${label}（${t.branch}）：${t.contained ? '已合入' : '未合入'}`
}

function tagType(t) {
  if (!t || t.contained === null) return 'info'
  return t.contained ? 'success' : 'warning'
}

function tagEffect(t) {
  return !t || t.contained === null ? 'plain' : 'light'
}

/** 状态符号：✓ 已合入 / ✗ 未合入 / — 未配置或本地无该 ref */
function statusSymbol(t) {
  if (!t || t.contained === null) return '— '
  return t.contained ? '✓ ' : '✗ '
}

async function loadTracks() {
  try {
    const r = await api.nodeTracks(props.node.id, 'self', { branches: true })
    const m = {}
    const bm = {}
    for (const it of r.items) {
      m[`${it.commit.repo || ''}@${it.commit.sha}`] = it.track
      bm[it.commit.id] = {
        subBranches: it.commit.subBranches || [],
        demandBranch: it.commit.demandBranch || null,
        demandContained: it.commit.demandContained
      }
    }
    trackMap.value = m
    branchMap.value = bm
  } catch {
    trackMap.value = {}
    branchMap.value = {}
  }
}

async function loadDuplicates() {
  try {
    const r = await api.commitDuplicates(props.node.id, 'self')
    const m = {}
    for (const it of r.items || []) m[it.cid] = it.related
    dupMap.value = m
    dupItems.value = r.items || []
    dupGroupCount.value = r.groupCount || 0
  } catch {
    dupMap.value = {}
    dupItems.value = []
    dupGroupCount.value = 0
  }
}

/** 一键去重：同 sha / patch-id 组保留最早一条，删除其余；merge 覆盖关系保留 */
async function dedupeAll() {
  const plan = new Map() // keepCid -> Set(removeCid)
  for (const item of dupItems.value) {
    for (const r of item.related) {
      if (r.relation !== 'same-sha' && r.relation !== 'patch-id') continue
      const keep = Math.min(item.cid, r.cid)
      const remove = Math.max(item.cid, r.cid)
      if (!plan.has(keep)) plan.set(keep, new Set())
      plan.get(keep).add(remove)
    }
  }
  if (!plan.size) {
    ElMessage.info('没有可自动去重的条目（merge 覆盖关系仅作关联展示，不自动删除）')
    return
  }
  const total = [...plan.values()].reduce((n, s) => n + s.size, 0)
  try {
    await ElMessageBox.confirm(`将删除 ${total} 条重复登记（每组保留最早一条；merge 覆盖关系保留）`, '一键去重', {
      confirmButtonText: '去重', cancelButtonText: '取消', type: 'warning'
    })
  } catch {
    return
  }
  let ok = 0
  let fail = 0
  for (const [keep, removes] of plan) {
    try {
      await api.commitDedupe({ keepId: keep, removeIds: [...removes] })
      ok += removes.size
    } catch {
      fail += 1
    }
  }
  ElMessage.success(`已去重 ${ok} 条${fail ? `，${fail} 组失败` : ''}`)
  commits.value = await api.commitList(props.node.id)
  await Promise.all([loadTracks(), loadDuplicates()])
  emit('updated')
}

function toggleWidth() {
  drawerWidth.value = drawerWidth.value === '760px' ? '70vw' : '760px'
}

async function loadDetail() {
  // 切换节点时回到请求的 tab（点「文档」列直接落在文档区）
  tab.value = props.initialTab
  const detail = await api.nodeGet(props.node.id)
  editName.value = detail.name
  editStatus.value = detail.status || 'todo'
  attrValues.value = detail.attrs || {}
  children.value = detail.children || []
  commits.value = detail.commits || []
  const allDefs = await api.attrDefs()
  attrDefs.value = allDefs.filter((d) => d.enabled !== false && d.nodeType === detail.type)
  const repoList = await api.repos()
  repos.value = repoList
  deliveryScope.value = 'self'
  loadDeliveryGate()
  designScope.value = 'self'
  if (DESIGN_NODE_TYPES.includes(detail.type)) loadDesignOutline()
  loadTracks()
  loadDuplicates()
  loadPendingMerge()
}

async function loadDeliveryGate() {
  try {
    const [g, a] = await Promise.all([
      api.deliveryGate(props.node.id, deliveryScope.value),
      api.acceptanceStatus(props.node.id, deliveryScope.value)
    ])
    gate.value = g
    acceptance.value = a
    acceptanceComment.value = ''
  } catch {
    gate.value = { decision: 'unknown', sources: [], blockers: [] }
    acceptance.value = { state: 'not_applicable', report: { totals: { cases: 0, pass: 0 }, evidenceFingerprint: '' }, signoff: null }
  }
}

async function signAcceptance(decision) {
  signingAcceptance.value = true
  try {
    await api.acceptanceSign(props.node.id, {
      decision,
      scope: deliveryScope.value,
      comment: acceptanceComment.value || null
    })
    ElMessage.success(decision === 'accepted' ? '已完成验收签收' : '已驳回验收')
    await loadDeliveryGate()
    emit('updated')
  } catch (e) {
    ElMessage.error(e.message || String(e))
  } finally {
    signingAcceptance.value = false
  }
}

/** 概要设计大纲：拉 JSON（计数）与 markdown（渲染），两者同源、只读，不落库 */
async function loadDesignOutline() {
  try {
    designOutline.value = await api.designOutline(props.node.id, designScope.value)
  } catch {
    designOutline.value = { totals: null, units: [] }
    designMd.value = ''
    return
  }
  try {
    const r = await fetch(`/api/nodes/${props.node.id}/design-outline?scope=${designScope.value}&format=md`)
    designMd.value = await r.text()
  } catch {
    designMd.value = ''
  }
  await nextTick()
  const el = designHostRef.value
  if (el && designMd.value) {
    el.innerHTML = ''
    await Vditor.preview(el, designMd.value, PREVIEW_OPTIONS)
  }
}

async function copyDesignMd() {
  try {
    await navigator.clipboard.writeText(designMd.value)
    ElMessage.success('已复制概要设计骨架')
  } catch {
    ElMessage.error('复制失败（浏览器未授权剪贴板）')
  }
}

async function applyDesign() {
  try {
    await ElMessageBox.confirm(
      '把推导出的骨架写入各需求的「概要设计」文档？已有内容默认不覆盖。',
      '写入概要设计',
      { type: 'info' }
    )
  } catch {
    return
  }
  try {
    const out = await api.designOutlineApply(props.node.id, { scope: designScope.value })
    ElMessage.success(`已写入 ${out.written} 份，跳过 ${out.skipped} 份（已有内容）`)
    emit('updated')
  } catch (e) {
    ElMessage.error(e.message)
  }
}

async function saveName() {
  if (editName.value !== props.node.name) {
    await api.nodeUpdate(props.node.id, { name: editName.value })
    emit('updated')
  }
}

async function saveStatus() {
  await api.nodeUpdate(props.node.id, { status: editStatus.value })
  emit('updated')
}

async function saveAttrs() {
  await api.nodeUpdate(props.node.id, { attrs: attrValues.value })
  emit('updated')
}

async function addCommit() {
  if (!commitForm.value.sha) return
  await api.commitAdd(props.node.id, commitForm.value)
  commitForm.value = { sha: '', repo: '', note: '' }
  commits.value = await api.commitList(props.node.id)
  loadTracks()
  loadDuplicates()
}

function onChildClick(child) {
  emit('close')
  // 由父组件在下一个 tick 中打开该子节点
  // 简单方案：重新 emit select 但保持 drawer 关闭
}

// 切换节点时重新加载（组件实例会被复用，onMounted 不会再次触发）
watch(() => props.node?.id, loadDetail, { immediate: true })
</script>

<style scoped>
.merge-legend {
  margin: 6px 0 4px;
  font-size: 12px;
  color: #909399;
}
.legend-ok {
  color: #529b2e;
}
.legend-no {
  color: #c77a08;
}
.legend-unknown {
  color: #a8abb2;
}
.tag-gap {
  margin-left: 4px;
}
.delivery-head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 10px;
}
.acceptance-meta {
  color: #909399;
  font-size: 12px;
}
.acceptance-comment {
  margin: 0 0 8px;
  color: #606266;
  font-size: 12px;
  white-space: pre-wrap;
}
.acceptance-hint,
.acceptance-evidence {
  color: #909399;
  font-size: 12px;
}
.acceptance-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 8px;
}
.design-head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 10px;
}
.design-count {
  color: #909399;
  font-size: 12px;
  flex: 1;
}
.design-host {
  height: calc(100% - 46px);
  overflow: auto;
}
.design-host.vditor-reset {
  padding: 8px 16px;
}
/* 让 tab 内容撑满抽屉高度，使 DocPane 里的 Vditor 拿到确定高度（否则渲染高度塌陷） */
:deep(.el-drawer__body) {
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
:deep(.el-tabs) {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
:deep(.el-tabs__content) {
  flex: 1;
  min-height: 0;
}
:deep(.el-tab-pane) {
  height: 100%;
}
</style>
