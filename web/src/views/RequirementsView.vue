<template>
  <div class="requirements-view">
    <div class="toolbar">
      <el-select v-model="projectId" placeholder="项目" clearable size="small" style="width:200px" @change="load">
        <el-option v-for="p in projects" :key="p.id" :label="p.name" :value="p.id" />
      </el-select>
      <el-select v-model="status" placeholder="状态" clearable size="small" style="width:120px" @change="load">
        <el-option v-for="(label, key) in statusLabels" :key="key" :label="label" :value="key" />
      </el-select>
      <el-button size="small" @click="load">刷新</el-button>
      <el-button type="primary" size="small" :disabled="!projects.length" @click="openCreate">+ 新建需求</el-button>
    </div>

    <div class="summary">
      <el-statistic title="需求总数" :value="summary.total || 0" />
      <el-statistic title="进行中" :value="summary.byStatus?.doing || 0" />
      <el-statistic title="提测中" :value="summary.byStatus?.testing || 0" />
      <el-statistic title="已完成" :value="summary.byStatus?.done || 0" />
      <el-statistic title="缺需求内容" :value="summary.missingRequirementDoc || 0" />
      <el-statistic title="缺概要设计" :value="summary.missingDesignDoc || 0" />
      <el-statistic title="历史未知状态" :value="summary.unknownStatusCount || 0" />
    </div>

    <el-table :data="items" v-loading="loading" row-key="id" border stripe size="small" class="req-table">
      <el-table-column prop="name" label="需求" min-width="220">
        <template #default="{ row }">
          <div class="req-name">{{ row.name }}</div>
          <div class="req-path">{{ row.path }}</div>
        </template>
      </el-table-column>
      <el-table-column label="项目" width="140" prop="projectName" />
      <el-table-column label="状态" width="110">
        <template #default="{ row }">
          <el-tag :type="statusType(row.status)" size="small">{{ statusLabels[row.status] || row.status }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="文档关联" min-width="190">
        <template #default="{ row }">
          <el-tag
            v-for="d in row.docState"
            :key="d.name"
            size="small"
            :type="d.filled ? 'success' : d.linked ? 'warning' : 'danger'"
            class="doc-tag"
            @click="openDocs(row)"
          >
            {{ d.name }} {{ d.filled ? '已填写' : d.linked ? '空白' : '未关联' }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="就绪" width="90">
        <template #default="{ row }">
          <el-tag size="small" :type="row.readiness?.ready ? 'success' : 'info'">
            {{ row.readiness?.ready ? '就绪' : '未就绪' }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="状态流转" width="210">
        <template #default="{ row }">
          <el-button
            v-for="next in row.canTransitionTo"
            :key="next"
            link
            size="small"
            :type="next === 'cancelled' ? 'danger' : 'primary'"
            @click="move(row, next)"
          >
            {{ transitionLabel(next) }}
          </el-button>
          <span v-if="!row.canTransitionTo?.length" class="terminal">已结束</span>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="90" fixed="right">
        <template #default="{ row }">
          <el-button link type="primary" size="small" @click="openDocs(row)">文档</el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-dialog v-model="createDialog" title="新建需求" width="440px">
      <el-form label-width="70px" size="small">
        <el-form-item label="项目">
          <el-select v-model="form.projectId" style="width:100%">
            <el-option v-for="p in projects" :key="p.id" :label="p.name" :value="p.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="名称">
          <el-input v-model="form.name" placeholder="需求名称" @keyup.enter="submitCreate" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="createDialog = false">取消</el-button>
        <el-button type="primary" :loading="creating" @click="submitCreate">确认</el-button>
      </template>
    </el-dialog>

    <el-drawer v-model="docDrawer" :title="docNode?.path || docNode?.name" size="760px" destroy-on-close>
      <DocPane v-if="docNode" :node-id="docNode.id" />
    </el-drawer>
  </div>
</template>

<script setup>
import { onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import api from '../api.js'
import DocPane from '../components/DocPane.vue'

const loading = ref(false)
const creating = ref(false)
const projects = ref([])
const items = ref([])
const summary = ref({})
const projectId = ref(null)
const status = ref('')
const createDialog = ref(false)
const form = reactive({ projectId: null, name: '' })
const docDrawer = ref(false)
const docNode = ref(null)

const statusLabels = { todo: '待开始', doing: '进行中', testing: '提测中', done: '已完成', cancelled: '已取消' }
const statusType = (s) => ({ todo: 'info', doing: 'warning', testing: 'primary', done: 'success', cancelled: 'danger' }[s] || 'info')
const transitionLabel = (s) => ({ todo: '恢复待开始', doing: '开始', testing: '提测', done: '完成', cancelled: '取消' }[s] || s)
async function loadProjects() {
  const tree = await api.tree()
  projects.value = (tree.nodes || []).filter((n) => n.type === 'project')
  if (!projectId.value && projects.value.length) projectId.value = projects.value[0].id
}

async function load() {
  loading.value = true
  try {
    const out = await api.requirements({ projectId: projectId.value || undefined, status: status.value || undefined })
    items.value = out.items || []
    summary.value = out.summary || {}
  } finally {
    loading.value = false
  }
}

function openCreate() {
  form.projectId = projectId.value || projects.value[0]?.id || null
  form.name = ''
  createDialog.value = true
}

async function submitCreate() {
  if (!form.projectId || !form.name.trim()) return
  creating.value = true
  try {
    await api.requirementCreate({ projectId: form.projectId, name: form.name.trim() })
    createDialog.value = false
    await load()
    ElMessage.success('需求已创建，已关联两份核心文档')
  } catch (e) {
    ElMessage.error(e.message)
  } finally {
    creating.value = false
  }
}

async function move(row, next) {
  if (next === 'cancelled') {
    try {
      await ElMessageBox.confirm(`取消需求「${row.name}」？`, '确认取消', { type: 'warning' })
    } catch {
      return
    }
  }
  try {
    await api.requirementTransition(row.id, next)
    await load()
  } catch (e) {
    ElMessage.error(e.message)
  }
}

function openDocs(row) {
  docNode.value = row
  docDrawer.value = true
}

onMounted(async () => {
  await loadProjects()
  await load()
})
</script>

<style scoped>
.requirements-view { height:100%; display:flex; flex-direction:column; padding:0 0 12px; }
.toolbar { padding:8px 12px; display:flex; align-items:center; gap:8px; background:#f5f7fa; border-bottom:1px solid #e4e7ed; }
.summary { display:grid; grid-template-columns:repeat(7, minmax(100px, 1fr)); gap:12px; padding:12px; border-bottom:1px solid #e4e7ed; background:#fff; }
.req-table { flex:1; }
.req-name { font-weight:500; color:#303133; }
.req-path { margin-top:2px; font-size:12px; color:#909399; }
.doc-tag { cursor:pointer; margin:0 6px 4px 0; }
.terminal { color:#909399; font-size:12px; }
@media (max-width: 900px) { .summary { grid-template-columns:repeat(3, 1fr); } }
</style>
