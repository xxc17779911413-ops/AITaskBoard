<template>
  <div class="workflow-map">
    <div class="workflow-toolbar">
      <el-radio-group v-model="scope" size="small" @change="load">
        <el-radio-button value="self">仅本节点</el-radio-button>
        <el-radio-button value="subtree">含子树</el-radio-button>
      </el-radio-group>
      <el-button size="small" @click="load">刷新</el-button>
      <div class="workflow-legend">
        <span><i class="dot pass" />通过</span>
        <span><i class="dot fail" />未通过</span>
        <span><i class="dot pending" />待处理</span>
        <span><i class="dot empty" />暂无</span>
      </div>
    </div>

    <div v-loading="loading" class="workflow-body">
      <el-empty v-if="!loading && !map.nodes.length" description="暂无可展示的研发主线" />
      <template v-else>
        <div class="workflow-canvas-wrap">
          <svg
            class="workflow-canvas"
            :viewBox="`0 0 ${layout.width} ${layout.height}`"
            :style="{ minWidth: `${layout.width}px`, height: `${layout.height}px` }"
            role="img"
            aria-label="研发主线思维导图"
          >
            <defs>
              <marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
                <path d="M 0 0 L 10 5 L 0 10 z" fill="#c0c4cc" />
              </marker>
            </defs>
            <g class="edges">
              <path v-for="(edge, i) in layout.edges" :key="i" :d="edge.path" marker-end="url(#arrow)" />
            </g>
            <g
              v-for="node in layout.nodes"
              :key="node.id"
              class="map-node"
              :class="[`is-${node.status}`, { selected: selectedId === node.id }]"
              :transform="`translate(${node.x},${node.y})`"
              @click="selectNode(node)"
            >
              <rect :width="node.width" :height="node.height" rx="8" />
              <text class="node-type" x="12" y="18">{{ typeLabel(node) }}</text>
              <text class="node-title" x="12" y="40">
                <tspan v-for="(line, li) in node.titleLines" :key="li" :x="12" :dy="li === 0 ? 0 : 16">{{ line }}</tspan>
              </text>
              <text v-if="node.subtitleLines.length" class="node-subtitle" x="12" :y="node.height - 14">
                <tspan v-for="(line, li) in node.subtitleLines" :key="li" :x="12" :dy="li === 0 ? 0 : 14">{{ line }}</tspan>
              </text>
            </g>
          </svg>
        </div>

        <aside class="workflow-inspector">
          <template v-if="selected">
            <div class="inspector-head">
              <el-tag size="small" :type="statusTagType(selected.status)" effect="dark">{{ statusLabel(selected.status) }}</el-tag>
              <strong>{{ selected.label }}</strong>
            </div>
            <p class="inspector-type">{{ typeLabel(selected) }}</p>
            <p class="inspector-detail">{{ selected.detail }}</p>
            <el-button
              v-if="selected.type === 'unit'"
              type="primary"
              size="small"
              @click="$emit('open-node', selected.unitId)"
            >
              打开节点
            </el-button>
            <template v-if="selected.type === 'branch' && selected.meta && selected.meta.documents">
              <el-divider content-position="left">文档</el-divider>
              <div v-for="doc in selected.meta.documents" :key="doc.id" class="inspector-row">
                <span>{{ doc.name }}</span>
                <el-tag size="small" :type="doc.filled ? 'success' : 'info'" effect="plain">{{ doc.filled ? '已填写' : '空' }}</el-tag>
              </div>
            </template>
            <template v-if="selected.type === 'branch' && selected.meta && selected.meta.caseIds && selected.meta.caseIds.length">
              <el-divider content-position="left">关联用例</el-divider>
              <div class="inspector-row">
                <span>用例数量</span>
                <strong>{{ selected.meta.caseIds.length }}</strong>
              </div>
            </template>
            <template v-if="selected.type === 'branch' && selected.meta && selected.meta.latestReportId">
              <el-divider content-position="left">最近报告</el-divider>
              <div class="inspector-row">
                <span>报告 ID</span>
                <strong>{{ selected.meta.latestReportId }}</strong>
              </div>
            </template>

            <template v-if="isReleaseItemBranch && selected.meta.releaseItems && selected.meta.releaseItems.length">
              <el-divider content-position="left">上线项回写</el-divider>
              <div v-for="item in selected.meta.releaseItems" :key="item.id" class="release-write-row">
                <div class="release-write-title">
                  <span>{{ item.name }}</span>
                  <el-tag v-if="item.required" size="small" type="warning" effect="plain">必做</el-tag>
                </div>
                <el-select
                  v-model="item.status"
                  size="small"
                  style="width:100%"
                  :disabled="writing"
                  @change="saveReleaseStatus(item)"
                >
                  <el-option v-for="s in releaseStatuses" :key="s.value" :label="s.label" :value="s.value" />
                </el-select>
              </div>
            </template>

            <template v-if="isCheckBranch">
              <el-divider content-position="left">检查回写</el-divider>
              <div v-if="!selected.meta.checkCases || !selected.meta.checkCases.length" class="inspector-empty">暂无检查用例</div>
              <div v-for="item in selected.meta.checkCases || []" :key="item.id" class="check-write-row">
                <div class="release-write-title">
                  <span>{{ item.name }}</span>
                  <el-tag size="small" :type="checkStatusTag(item.latestStatus)" effect="plain">{{ checkStatusLabel(item.latestStatus) }}</el-tag>
                </div>
                <div class="check-actions">
                  <el-button size="small" :disabled="writing || !item.latestReportId" @click="finishCheck(item, 'pass')">通过</el-button>
                  <el-button size="small" :disabled="writing || !item.latestReportId" @click="finishCheck(item, 'fail')">不通过</el-button>
                  <el-button size="small" :disabled="writing || !item.latestReportId" @click="finishCheck(item, 'blocked')">阻塞</el-button>
                </div>
                <p v-if="!item.latestReportId" class="item-hint">先执行检查，产生报告后可回写结论</p>
              </div>
              <el-button
                type="primary"
                size="small"
                :loading="writing"
                :disabled="!(selected.meta.caseIds?.length || selected.meta.releaseItems?.length)"
                @click="dispatchCheck"
              >
                执行检查
              </el-button>
            </template>
          </template>
          <el-empty v-else description="点击图中的节点查看详情" />
        </aside>
      </template>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import api from '../api.js'

const props = defineProps({ nodeId: Number })
defineEmits(['open-node'])

const scope = ref('self')
const loading = ref(false)
const map = ref({ node: {}, scope: 'self', status: 'empty', totals: {}, stages: [], units: [], nodes: [], edges: [] })
const selectedId = ref(null)
const writing = ref(false)
const releaseStatuses = [
  { value: 'pending', label: '待处理' },
  { value: 'ready', label: '就绪' },
  { value: 'done', label: '完成' },
  { value: 'blocked', label: '阻塞' },
  { value: 'skipped', label: '跳过' }
]

const NODE_WIDTH = 208
const NODE_HEIGHT = 72
const ROOT_WIDTH = 176
const ROOT_HEIGHT = 72
const COLUMN_GAP = 248
const ROW_GAP = 92
const X0 = 32
const STAGE_X = 248
const STAGE_Y = 24
const BRANCH_Y = 124

function splitText(text, max = 9) {
  const s = String(text || '')
  if (!s) return ['']
  const lines = []
  for (let i = 0; i < s.length; i += max) lines.push(s.slice(i, i + max))
  return lines.slice(0, 2)
}

function nodeSize(node) {
  return node.type === 'root' ? { width: ROOT_WIDTH, height: ROOT_HEIGHT } : { width: NODE_WIDTH, height: NODE_HEIGHT }
}

const layout = computed(() => {
  const stages = map.value.stages || []
  const branchNodes = (map.value.nodes || []).filter((n) => n.type === 'branch')
  const units = (map.value.units || []).map((u) => {
    const found = (map.value.nodes || []).find((n) => n.id === u.nodeId)
    return found || { ...u, id: u.nodeId, type: 'unit', label: u.name, status: 'pass', detail: u.path, meta: {} }
  })
  const stageNodes = (map.value.nodes || []).filter((n) => n.type === 'stage')
  const rootNode = (map.value.nodes || []).find((n) => n.type === 'root') || {
    id: 'root',
    type: 'root',
    label: map.value.node.name,
    status: map.value.status,
    detail: '',
    meta: {}
  }

  const positioned = []
  const positionedById = new Map()
  const put = (node, x, y) => {
    const { width, height } = nodeSize(node)
    const item = {
      ...node,
      x,
      y,
      width,
      height,
      titleLines: splitText(node.label, node.type === 'branch' ? 9 : 8),
      subtitleLines: node.type === 'branch' ? splitText(node.detail, 11) : []
    }
    positioned.push(item)
    positionedById.set(item.id, item)
    return item
  }

  put(rootNode, X0, STAGE_Y + 16)
  units.forEach((unit, i) => put(unit, X0, STAGE_Y + 132 + i * ROW_GAP))

  stageNodes.forEach((stage, i) => {
    const x = STAGE_X + i * COLUMN_GAP
    put(stage, x, STAGE_Y)
    const items = branchNodes.filter((n) => n.stage === stage.stage)
    items.forEach((item, j) => put(item, x, BRANCH_Y + j * ROW_GAP))
  })

  const maxStageItems = stages.reduce((max, stage) => {
    const count = branchNodes.filter((n) => n.stage === stage.key).length
    return Math.max(max, count)
  }, 0)
  const maxUnits = units.length
  const height = Math.max(420, BRANCH_Y + Math.max(maxStageItems, 1) * ROW_GAP + 60, STAGE_Y + 132 + maxUnits * ROW_GAP + 60)
  const width = STAGE_X + Math.max(stages.length, 1) * COLUMN_GAP + 40

  const pathBetween = (from, to) => {
    const x1 = from.x + from.width
    const y1 = from.y + from.height / 2
    const x2 = to.x
    const y2 = to.y + to.height / 2
    if (from.x === to.x) {
      const cx = from.x + from.width / 2
      return `M ${cx} ${from.y + from.height} L ${cx} ${to.y}`
    }
    const dx = Math.max(36, (x2 - x1) / 2)
    return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`
  }

  const edges = []
  for (const edge of map.value.edges || []) {
    const from = positionedById.get(edge.from)
    const to = positionedById.get(edge.to)
    if (!from || !to) continue
    edges.push({ ...edge, path: pathBetween(from, to) })
  }

  return { width, height, nodes: positioned, edges }
})

const selected = computed(() => layout.value.nodes.find((n) => n.id === selectedId.value) || null)
const isReleaseItemBranch = computed(
  () => selected.value?.type === 'branch' && ['release_config', 'release_sql', 'release_check'].includes(selected.value.stage)
)
const isCheckBranch = computed(
  () => selected.value?.type === 'branch' && ['release_check', 'code_check', 'biz_check'].includes(selected.value.stage)
)
const statusLabel = (s) => ({ pass: '通过', fail: '未通过', pending: '待处理', empty: '暂无' }[s] || s)
const statusTagType = (s) => ({ pass: 'success', fail: 'danger', pending: 'warning', empty: 'info' }[s] || 'info')
const checkStatusLabel = (s) => ({ pass: '通过', fail: '未通过', blocked: '阻塞', running: '执行中', not_run: '未执行' }[s] || s)
const checkStatusTag = (s) => ({ pass: 'success', fail: 'danger', blocked: 'warning', running: 'warning', not_run: 'info' }[s] || 'info')
const typeLabel = (node) =>
  ({
    root: '范围',
    stage: '阶段',
    unit: node.meta?.nodeType === 'subreq' ? '子需求' : '需求',
    branch: '分支'
  }[node.type] || node.type)

async function load() {
  loading.value = true
  try {
    map.value = await api.workflowMap(props.nodeId, scope.value)
    const preferred = selectedId.value && map.value.nodes.find((n) => n.id === selectedId.value)
    selectedId.value = preferred ? selectedId.value : map.value.nodes[0]?.id || null
  } finally {
    loading.value = false
  }
}

function selectNode(node) {
  selectedId.value = node.id
}

async function afterWrite(message) {
  ElMessage.success(message)
  await load()
}

async function saveReleaseStatus(item) {
  writing.value = true
  try {
    await api.releaseItemUpdate(item.id, { status: item.status })
    await afterWrite('上线项状态已回写')
  } catch (e) {
    ElMessage.error(e.message || String(e))
  } finally {
    writing.value = false
  }
}

async function finishCheck(item, status) {
  if (!item.latestReportId) return
  writing.value = true
  try {
    await api.testReportFinish(item.latestReportId, { status, overwrite: true })
    await afterWrite('检查结论已回写')
  } catch (e) {
    ElMessage.error(e.message || String(e))
  } finally {
    writing.value = false
  }
}

async function dispatchCheck() {
  const caseIds = selected.value?.meta?.caseIds || []
  const releaseItemIds = selected.value?.meta?.releaseItems?.map((item) => item.id) || []
  const unitNodeId = selected.value?.unitId
  if (!caseIds.length && !releaseItemIds.length) return
  writing.value = true
  try {
    const out = await api.releaseCheck(unitNodeId || props.nodeId, { scope: 'self', caseIds, dryRun: true })
    ElMessage.info(`将执行 ${out.cases.length} 条检查，已生成提示词`)
    try {
      await ElMessageBox.confirm('确认派单执行这组上线检查？', '执行检查', { type: 'warning' })
    } catch {
      return
    }
    try {
      await api.releaseCheck(unitNodeId || props.nodeId, { scope: 'self', caseIds })
      await afterWrite('检查已派单')
    } catch (e) {
      ElMessage.error(e.message || String(e))
    }
  } finally {
    writing.value = false
  }
}

watch(() => props.nodeId, load)
onMounted(load)
</script>

<style scoped>
.workflow-map {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}
.workflow-toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  padding-bottom: 10px;
  border-bottom: 1px solid #e4e7ed;
}
.workflow-legend {
  display: flex;
  gap: 10px;
  margin-left: auto;
  color: #606266;
  font-size: 12px;
}
.workflow-legend span {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  display: inline-block;
}
.dot.pass { background: #67c23a; }
.dot.fail { background: #f56c6c; }
.dot.pending { background: #e6a23c; }
.dot.empty { background: #a8abb2; }
.workflow-body {
  flex: 1;
  min-height: 0;
  display: flex;
  gap: 12px;
  padding-top: 10px;
}
.workflow-canvas-wrap {
  flex: 1;
  min-width: 0;
  overflow: auto;
  border: 1px solid #ebeef5;
  border-radius: 8px;
  background: #fafafa;
}
.workflow-canvas {
  display: block;
}
.edges path {
  fill: none;
  stroke: #c0c4cc;
  stroke-width: 1.4;
  opacity: 0.72;
}
.map-node {
  cursor: pointer;
}
.map-node rect {
  fill: #fff;
  stroke: #dcdfe6;
  stroke-width: 1.4;
  filter: drop-shadow(0 1px 2px rgb(0 0 0 / 6%));
}
.map-node:hover rect,
.map-node.selected rect {
  stroke: #409eff;
  stroke-width: 2;
}
.map-node.is-pass rect { fill: #f0f9eb; stroke: #b3e19d; }
.map-node.is-fail rect { fill: #fef0f0; stroke: #f3b5b5; }
.map-node.is-pending rect { fill: #fdf6ec; stroke: #f3d19e; }
.map-node.is-empty rect { fill: #f4f4f5; stroke: #dcdfe6; }
.map-node.is-root rect,
.map-node.is-stage rect,
.map-node.is-unit rect {
  fill: #fff;
  stroke: #c6d9f1;
}
.node-type {
  fill: #909399;
  font-size: 10px;
}
.node-title {
  fill: #303133;
  font-size: 13px;
  font-weight: 600;
}
.node-subtitle {
  fill: #909399;
  font-size: 11px;
}
.workflow-inspector {
  width: 280px;
  flex-shrink: 0;
  overflow: auto;
  border: 1px solid #ebeef5;
  border-radius: 8px;
  padding: 12px;
  background: #fff;
}
.inspector-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}
.inspector-head strong {
  overflow-wrap: anywhere;
}
.inspector-type {
  margin: 0 0 6px;
  color: #909399;
  font-size: 12px;
}
.inspector-detail {
  margin: 0 0 12px;
  color: #606266;
  line-height: 1.5;
  font-size: 12px;
  overflow-wrap: anywhere;
}
.inspector-row {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  padding: 5px 0;
  font-size: 12px;
}
.release-write-row,
.check-write-row {
  padding: 8px 0;
  border-bottom: 1px solid #f2f3f5;
}
.release-write-title {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
  font-size: 12px;
}
.check-actions {
  display: flex;
  gap: 4px;
}
.inspector-empty,
.item-hint {
  color: #909399;
  font-size: 12px;
}
@media (max-width: 900px) {
  .workflow-body {
    flex-direction: column;
  }
  .workflow-inspector {
    width: auto;
    max-height: 220px;
  }
}
</style>
