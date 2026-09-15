<template>
  <div class="structure-view">
    <div class="toolbar">
      <el-select v-model="rootId" placeholder="根节点（项目）" size="small" style="width:200px" @change="load">
        <el-option v-for="p in projects" :key="p.id" :label="p.name" :value="p.id" />
      </el-select>
      <el-select v-model="scope" size="small" style="width:110px" @change="load">
        <el-option label="含子树" value="subtree" />
        <el-option label="仅本节点" value="self" />
      </el-select>
      <el-select v-model="type" placeholder="类型" clearable size="small" style="width:110px" @change="load">
        <el-option v-for="t in TYPE_OPTIONS" :key="t" :label="structureTypeLabel(t)" :value="t" />
      </el-select>
      <el-select v-model="status" placeholder="状态" clearable size="small" style="width:110px" @change="load">
        <el-option v-for="(label, key) in statusLabels" :key="key" :label="label" :value="key" />
      </el-select>
      <el-select v-model="ready" placeholder="就绪" clearable size="small" style="width:110px" @change="load">
        <el-option label="就绪" value="true" />
        <el-option label="未就绪" value="false" />
      </el-select>
      <el-select v-model="hasGap" placeholder="文档缺口" clearable size="small" style="width:120px" @change="load">
        <el-option label="有缺口" value="true" />
        <el-option label="无缺口" value="false" />
      </el-select>
      <el-select v-model="caseStatus" placeholder="用例状态" clearable size="small" style="width:120px" @change="load">
        <el-option v-for="s in CASE_STATUS_OPTIONS" :key="s" :label="structureCaseStatusLabel(s)" :value="s" />
      </el-select>
      <el-input v-model="q" placeholder="搜索名称 / 路径" clearable size="small" style="width:200px" @keyup.enter="load" />
      <el-button size="small" @click="load">刷新</el-button>
    </div>

    <div class="summary">
      <el-statistic v-for="kpi in kpis" :key="kpi.key" :title="kpi.title" :value="kpi.value" />
      <el-button v-if="filterActive" size="small" text type="primary" @click="resetFilters">清除筛选</el-button>
    </div>

    <el-alert
      v-if="filterActive"
      type="info"
      :closable="false"
      :title="`已筛选：显示 ${graph.totals?.nodes ?? 0} / ${graph.totals?.total ?? 0} 个节点`"
      style="margin-bottom:8px"
    />
    <el-empty v-if="!nodes.length" description="当前范围 / 筛选下没有节点" />
    <el-table v-else :data="nodes" v-loading="loading" row-key="id" border stripe size="small" height="100%">
      <el-table-column label="名称" min-width="240">
        <template #default="{ row }">
          <span :style="{ paddingLeft: `${row.depth * 16}px` }">{{ row.name }}</span>
        </template>
      </el-table-column>
      <el-table-column label="路径" prop="path" min-width="200" show-overflow-tooltip />
      <el-table-column label="类型" width="90">
        <template #default="{ row }">
          <el-tag size="small" effect="plain">{{ structureTypeLabel(row.type) }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="status" label="状态" width="90" />
      <el-table-column label="文档" width="160">
        <template #default="{ row }">
          <el-tag size="small" :type="row.hasGap ? 'warning' : 'success'" effect="plain">{{ structureDocText(row) }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="用例" width="130">
        <template #default="{ row }">
          <el-tag v-if="row.caseCount" size="small" :type="structureCaseStatusType(row.caseStatus)">{{ structureCaseText(row) }}</el-tag>
          <span v-else>—</span>
        </template>
      </el-table-column>
      <el-table-column label="就绪" width="90">
        <template #default="{ row }">
          <el-tag size="small" :type="structureReadyTagType(row.ready)">{{ structureReadyLabel(row.ready) }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="80" fixed="right">
        <template #default="{ row }">
          <el-button link type="primary" size="small" @click="openNode(row)">跳转</el-button>
        </template>
      </el-table-column>
    </el-table>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import api from '../api.js'
import {
  STRUCTURE_TYPES,
  STRUCTURE_CASE_STATUSES,
  buildStructureKpi,
  structureCaseStatusLabel,
  structureCaseStatusType,
  structureCaseText,
  structureDocText,
  structureFilterActive,
  structureReadyLabel,
  structureReadyTagType,
  structureTypeLabel
} from '../structure.js'

const emit = defineEmits(['select'])

const TYPE_OPTIONS = STRUCTURE_TYPES
const CASE_STATUS_OPTIONS = STRUCTURE_CASE_STATUSES
const statusLabels = { todo: '待开始', doing: '进行中', testing: '提测中', done: '已完成', cancelled: '已取消' }

const loading = ref(false)
const projects = ref([])
const rootId = ref(null)
const scope = ref('subtree')
const type = ref('')
const status = ref('')
const ready = ref('')
const hasGap = ref('')
const caseStatus = ref('')
const q = ref('')
const graph = ref({ totals: {}, nodes: [] })

const nodes = computed(() => graph.value.nodes || [])
const kpis = computed(() => buildStructureKpi(graph.value.totals))
const filterActive = computed(() =>
  structureFilterActive({ type: type.value, status: status.value, ready: ready.value, hasGap: hasGap.value, caseStatus: caseStatus.value, q: q.value })
)

async function loadProjects() {
  const tree = await api.tree()
  projects.value = (tree.nodes || []).filter((n) => n.type === 'project')
  if (!rootId.value && projects.value.length) rootId.value = projects.value[0].id
}

async function load() {
  if (!rootId.value) return
  loading.value = true
  try {
    graph.value = await api.structureGraph(rootId.value, {
      scope: scope.value,
      type: type.value || undefined,
      status: status.value || undefined,
      ready: ready.value,
      hasGap: hasGap.value,
      caseStatus: caseStatus.value || undefined,
      q: q.value || undefined
    })
  } catch (e) {
    ElMessage.error(e.message)
  } finally {
    loading.value = false
  }
}

function resetFilters() {
  type.value = ''
  status.value = ''
  ready.value = ''
  hasGap.value = ''
  caseStatus.value = ''
  q.value = ''
  load()
}

function openNode(row) {
  emit('select', { id: row.id, name: row.name, type: row.type, path: row.path }, 'info')
}

onMounted(async () => {
  await loadProjects()
  await load()
})
</script>

<style scoped>
.structure-view { height:100%; display:flex; flex-direction:column; padding:0 0 12px; }
.toolbar { padding:8px 12px; display:flex; align-items:center; gap:8px; flex-wrap:wrap; background:#f5f7fa; border-bottom:1px solid #e4e7ed; }
.summary { display:flex; align-items:center; gap:18px; padding:10px 12px; border-bottom:1px solid #e4e7ed; background:#fff; }
.summary :deep(.el-statistic) { min-width:70px; }
</style>
