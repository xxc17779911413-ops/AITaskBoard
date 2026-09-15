<template>
  <div class="audit-view">
    <div class="toolbar">
      <el-select v-model="action" placeholder="高风险操作" clearable size="small" style="width:170px" @change="load">
        <el-option v-for="a in AUDIT_ACTIONS" :key="a" :label="auditActionLabel(a)" :value="a" />
      </el-select>
      <el-select v-model="decision" placeholder="结论" clearable size="small" style="width:130px" @change="load">
        <el-option v-for="d in AUDIT_DECISIONS" :key="d" :label="auditDecisionLabel(d)" :value="d" />
      </el-select>
      <el-input v-model.number="nodeId" placeholder="节点 id" clearable size="small" style="width:140px" @keyup.enter="load" />
      <el-button size="small" @click="load">刷新</el-button>
    </div>

    <div class="summary">
      <el-statistic v-for="kpi in kpis" :key="kpi.key" :title="kpi.title" :value="kpi.value" />
    </div>

    <el-empty v-if="!logs.length" description="当前筛选下没有审计记录" />
    <el-table v-else :data="logs" v-loading="loading" row-key="id" border stripe size="small" height="100%">
      <el-table-column prop="id" label="#" width="70" />
      <el-table-column label="操作" width="140">
        <template #default="{ row }">
          <el-tag size="small" effect="plain">{{ auditActionLabel(row.action) }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="结论" width="100">
        <template #default="{ row }">
          <el-tag size="small" :type="auditDecisionType(row.decision)">{{ auditDecisionLabel(row.decision) }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="actor" label="操作者" width="90" />
      <el-table-column label="节点" width="90">
        <template #default="{ row }">
          <el-button v-if="row.nodeId" link type="primary" size="small" @click="openNode(row)">#{{ row.nodeId }}</el-button>
          <span v-else>—</span>
        </template>
      </el-table-column>
      <el-table-column prop="reason" label="原因" width="160" />
      <el-table-column label="详情" min-width="220">
        <template #default="{ row }">
          <span class="audit-detail">{{ formatDetail(row.detail) }}</span>
        </template>
      </el-table-column>
      <el-table-column prop="createdAt" label="时间" width="200" />
    </el-table>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import api from '../api.js'
import { AUDIT_ACTIONS, AUDIT_DECISIONS, auditActionLabel, auditDecisionLabel, auditDecisionType, buildAuditKpi } from '../audit.js'

const emit = defineEmits(['select'])

const loading = ref(false)
const logs = ref([])
const action = ref('')
const decision = ref('')
const nodeId = ref(null)

const kpis = computed(() => buildAuditKpi(logs.value))

function formatDetail(detail) {
  if (detail == null) return '—'
  return typeof detail === 'string' ? detail : JSON.stringify(detail)
}

async function load() {
  loading.value = true
  try {
    logs.value = await api.auditLogs({
      action: action.value || undefined,
      decision: decision.value || undefined,
      nodeId: nodeId.value || undefined
    })
  } catch (e) {
    ElMessage.error(e.message)
  } finally {
    loading.value = false
  }
}

async function openNode(row) {
  try {
    const node = await api.nodeGet(row.nodeId)
    emit('select', { id: node.id, name: node.name, type: node.type, path: node.path }, 'info')
  } catch (e) {
    ElMessage.error(e.message)
  }
}

onMounted(load)
</script>

<style scoped>
.audit-view { height:100%; display:flex; flex-direction:column; padding:0 0 12px; }
.toolbar { padding:8px 12px; display:flex; align-items:center; gap:8px; flex-wrap:wrap; background:#f5f7fa; border-bottom:1px solid #e4e7ed; }
.summary { display:flex; align-items:center; gap:18px; padding:10px 12px; border-bottom:1px solid #e4e7ed; background:#fff; }
.summary :deep(.el-statistic) { min-width:70px; }
.audit-detail { font-size:12px; color:#606266; }
</style>
