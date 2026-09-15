<template>
  <div class="documents-view">
    <div class="toolbar">
      <el-select v-model="projectId" placeholder="项目" clearable size="small" style="width:180px" @change="load">
        <el-option v-for="p in projects" :key="p.id" :label="p.name" :value="p.id" />
      </el-select>
      <el-input v-model="q" placeholder="搜索文档名 / 正文 / 需求" clearable size="small" style="width:240px" @keyup.enter="load" />
      <el-select v-model="docName" placeholder="文档类型" clearable size="small" style="width:140px" @change="load">
        <el-option v-for="name in expectedDocNames" :key="name" :label="name" :value="name" />
      </el-select>
      <el-select v-model="fill" placeholder="填充状态" clearable size="small" style="width:130px" @change="load">
        <el-option label="已填写" value="filled" />
        <el-option label="空白" value="empty" />
      </el-select>
      <el-button size="small" @click="load">刷新</el-button>
    </div>

    <div class="summary">
      <el-statistic v-for="kpi in kpis" :key="kpi.key" :title="kpi.title" :value="kpi.value" />
    </div>

    <div class="panes">
      <el-table :data="items" v-loading="loading" row-key="id" border stripe size="small" class="doc-table">
        <el-table-column label="文档" min-width="240">
          <template #default="{ row }">
            <div class="doc-name">{{ row.name }}</div>
            <div class="doc-path">{{ row.path }}</div>
          </template>
        </el-table-column>
        <el-table-column label="关联" width="95">
          <template #default="{ row }">
            <el-tag size="small" :type="row.isRequired ? 'warning' : 'info'">
              {{ row.isRequired ? '核心文档' : '自定义' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="填充" width="95">
          <template #default="{ row }">
            <el-tag size="small" :type="row.filled ? 'success' : 'danger'">{{ row.filled ? '已填写' : '空白' }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="contentPreview" label="正文预览" min-width="260" show-overflow-tooltip />
        <el-table-column label="操作" width="90" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" size="small" @click="openDoc(row)">查看 / 编辑</el-button>
          </template>
        </el-table-column>
      </el-table>

      <div class="gap-panel">
        <div class="gap-title">缺口对账</div>
        <el-empty v-if="!gaps.length" description="当前筛选无缺口" :image-size="72" />
        <div v-for="gap in gaps" :key="`${gap.nodeId}-${gap.docName}`" class="gap-item">
          <div class="gap-main">{{ gap.nodeName }} · {{ gap.docName }}</div>
          <div class="gap-sub">{{ gap.gapType === 'missing' ? '未关联' : '已关联但正文空白' }}</div>
          <el-button link type="primary" size="small" @click="openGap(gap)">处理</el-button>
        </div>
      </div>
    </div>

    <el-drawer v-model="docDrawer" :title="selectedNode?.path || selectedNode?.name" size="760px" destroy-on-close>
      <DocPane v-if="selectedNode" :node-id="selectedNode.id" />
    </el-drawer>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue'
import api from '../api.js'
import DocPane from '../components/DocPane.vue'
import { buildDocumentKpi } from '../documentKpi.js'

const loading = ref(false)
const projects = ref([])
const projectId = ref(null)
const q = ref('')
const docName = ref('')
const fill = ref('')
const expectedDocNames = ref([])
const summary = ref({})
const items = ref([])
const gaps = ref([])
const docDrawer = ref(false)
const selectedNode = ref(null)

// 一旦叠加结果集筛选，KPI 就与表格 / 缺口面板共用 filtered* 口径，避免两处数字对不上
const filtered = computed(() => Boolean(q.value || docName.value || fill.value))
const kpis = computed(() => buildDocumentKpi(summary.value, { filtered: filtered.value }))

async function loadProjects() {
  const tree = await api.tree()
  projects.value = (tree.nodes || []).filter((n) => n.type === 'project')
  if (!projectId.value && projects.value.length) projectId.value = projects.value[0].id
}

async function load() {
  loading.value = true
  try {
    const out = await api.documentOverview({
      projectId: projectId.value || undefined,
      q: q.value || undefined,
      docName: docName.value || undefined,
      fill: fill.value || undefined
    })
    expectedDocNames.value = out.expectedDocNames || []
    summary.value = out.summary || {}
    items.value = out.items || []
    gaps.value = out.gaps || []
  } finally {
    loading.value = false
  }
}

function openDoc(row) {
  selectedNode.value = { id: row.nodeId, name: row.nodeName, path: row.path }
  docDrawer.value = true
}

function openGap(gap) {
  selectedNode.value = { id: gap.nodeId, name: gap.nodeName, path: gap.path }
  docDrawer.value = true
}

onMounted(async () => {
  await loadProjects()
  await load()
})
</script>

<style scoped>
.documents-view { height:100%; display:flex; flex-direction:column; padding:0 0 12px; }
.toolbar { padding:8px 12px; display:flex; align-items:center; gap:8px; background:#f5f7fa; border-bottom:1px solid #e4e7ed; }
.summary { display:grid; grid-template-columns:repeat(7, minmax(100px, 1fr)); gap:12px; padding:12px; border-bottom:1px solid #e4e7ed; background:#fff; }
.panes { flex:1; display:grid; grid-template-columns:minmax(0, 1fr) 280px; min-height:0; }
.doc-table { min-height:0; }
.gap-panel { border-left:1px solid #e4e7ed; overflow-y:auto; min-height:0; }
.gap-title { padding:8px 12px; font-weight:600; border-bottom:1px solid #e4e7ed; }
.gap-item { padding:8px 12px; border-bottom:1px solid #f0f2f5; }
.gap-main { font-size:13px; color:#303133; }
.gap-sub { margin-top:2px; font-size:12px; color:#909399; }
.doc-name { font-weight:500; color:#303133; }
.doc-path { margin-top:2px; font-size:12px; color:#909399; }
@media (max-width: 1000px) { .panes { grid-template-columns:1fr; } .gap-panel { border-left:none; border-top:1px solid #e4e7ed; } }
@media (max-width: 900px) { .summary { grid-template-columns:repeat(3, 1fr); } }
</style>
