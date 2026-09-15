<template>
  <div class="regression-pane">
    <div class="accept-head">
      <el-tag size="large" effect="dark" :type="acceptTagType">{{ acceptLabel }}</el-tag>
      <el-select v-model="scope" size="small" style="width:120px" @change="loadAcceptanceScope">
        <el-option label="仅本节点" value="self" />
        <el-option label="含子树" value="subtree" />
      </el-select>
      <div class="accept-kpis">
        <el-statistic v-for="kpi in kpis" :key="kpi.key" :title="kpi.title" :value="kpi.value" />
      </div>
      <el-button size="small" @click="reloadAll">刷新</el-button>
    </div>

    <el-alert
      v-if="kpisConserved === false"
      type="warning"
      :closable="false"
      title="分桶总数与用例数不一致，请检查报告状态"
      style="margin-bottom:8px"
    />

    <el-divider content-position="left">验收结论（测试 + 文档缺口）</el-divider>
    <div class="conclusion-block">
      <el-tag size="small" effect="dark" :type="conclusionTagType">{{ conclusionLabel }}</el-tag>
      <span class="conclusion-summary">{{ conclusionSummary }}</span>
    </div>
    <el-table
      v-if="(conclusion.items || []).length"
      :data="conclusion.items"
      size="small"
      border
      stripe
      style="margin-bottom:12px"
    >
      <el-table-column prop="name" label="需求" min-width="140" />
      <el-table-column label="版本" width="90">
        <template #default="{ row }">{{ row.version || '—' }}</template>
      </el-table-column>
      <el-table-column label="结论" width="100">
        <template #default="{ row }">
          <el-tag size="small" :type="conclusionItemTagType(row.decision)">{{ conclusionItemLabel(row.decision) }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="caseCount" label="用例" width="70" />
      <el-table-column label="文档缺口" min-width="200">
        <template #default="{ row }">
          <span v-if="!row.docBlockers?.length">—</span>
          <span v-else>{{ row.docBlockers.map((d) => d.label).join('、') }}</span>
        </template>
      </el-table-column>
    </el-table>

    <div class="case-toolbar">
      <el-button type="primary" size="small" @click="openCaseDialog()">+ 新建用例</el-button>
      <el-button size="small" :disabled="!selectedCases.length" @click="openRunDialog">运行选中（{{ selectedCases.length }}）</el-button>
      <el-button size="small" :disabled="!cases.length" @click="openRunDialog()">运行全部</el-button>
      <el-select v-model="kindFilter" size="small" clearable placeholder="类型" style="width:130px" @change="loadCases">
        <el-option v-for="k in CASE_KINDS" :key="k" :label="caseKindLabel(k)" :value="k" />
      </el-select>
      <el-checkbox v-model="includeDisabled" size="small" @change="loadCases">含停用</el-checkbox>
    </div>

    <el-table :data="cases" v-loading="loading" row-key="id" border stripe size="small" @selection-change="onSelectionChange">
      <el-table-column type="selection" width="42" />
      <el-table-column label="用例" min-width="180">
        <template #default="{ row }">
          <div class="case-name">{{ row.name }}</div>
          <div class="case-prompt">{{ row.prompt }}</div>
        </template>
      </el-table-column>
      <el-table-column label="类型" width="90">
        <template #default="{ row }">
          <el-tag size="small" effect="plain">{{ caseKindLabel(row.kind) }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="状态" width="90">
        <template #default="{ row }">
          <el-tag size="small" :type="row.enabled ? 'success' : 'info'">{{ row.enabled ? '启用' : '停用' }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="最近结果" width="100">
        <template #default="{ row }">
          <el-tag size="small" :type="reportStatusType(latestOf(row)?.latestStatus)">{{ reportStatusLabel(latestOf(row)?.latestStatus) }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="150" fixed="right">
        <template #default="{ row }">
          <el-button link type="primary" size="small" @click="openCaseDialog(row)">编辑</el-button>
          <el-button link type="primary" size="small" @click="filterReports(row)">报告</el-button>
          <el-button link type="danger" size="small" @click="removeCase(row)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-divider content-position="left">测试报告</el-divider>
    <div class="report-toolbar">
      <span v-if="reportFilterCase" class="report-filter">
        仅看用例「{{ reportFilterCase.name }}」
        <el-button link type="primary" size="small" @click="clearReportFilter">清除</el-button>
      </span>
    </div>
    <el-table :data="reports" v-loading="reportsLoading" row-key="id" border stripe size="small">
      <el-table-column prop="id" label="#" width="60" />
      <el-table-column label="用例" min-width="150">
        <template #default="{ row }">{{ caseName(row.caseId) }}</template>
      </el-table-column>
      <el-table-column label="状态" width="100">
        <template #default="{ row }">
          <el-tag size="small" :type="reportStatusType(row.status)">{{ reportStatusLabel(row.status) }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="summary" label="结论" min-width="200" show-overflow-tooltip />
      <el-table-column label="执行任务" width="90">
        <template #default="{ row }">{{ row.runId ?? '—' }}</template>
      </el-table-column>
      <el-table-column label="操作" width="120" fixed="right">
        <template #default="{ row }">
          <el-button link type="primary" size="small" @click="openReport(row)">详情</el-button>
          <el-button v-if="row.status === 'running'" link type="primary" size="small" @click="openFinish(row)">回写</el-button>
        </template>
      </el-table-column>
    </el-table>

    <!-- 用例编辑 -->
    <el-dialog v-model="caseDialog" :title="caseForm.id ? '编辑用例' : '新建用例'" width="560px">
      <el-form label-width="70px" size="small">
        <el-form-item label="名称">
          <el-input v-model="caseForm.name" placeholder="如：登录回归" />
        </el-form-item>
        <el-form-item label="类型">
          <el-select v-model="caseForm.kind" style="width:100%">
            <el-option v-for="k in CASE_KINDS" :key="k" :label="caseKindLabel(k)" :value="k" />
          </el-select>
        </el-form-item>
        <el-form-item label="提示词">
          <el-input v-model="caseForm.prompt" type="textarea" :rows="4" placeholder="给 AI 的执行指令（回归内容）" />
        </el-form-item>
        <el-form-item label="期望结果">
          <el-input v-model="caseForm.expectation" type="textarea" :rows="2" />
        </el-form-item>
        <el-form-item label="启用">
          <el-switch v-model="caseForm.enabled" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="caseDialog = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="submitCase">保存</el-button>
      </template>
    </el-dialog>

    <!-- 运行（dryRun 预览 → 派单） -->
    <el-dialog v-model="runDialog" title="运行回归测试" width="640px">
      <el-form label-width="90px" size="small">
        <el-form-item label="执行范围">
          <span>{{ runCaseIds.length ? `选中 ${runCaseIds.length} 条用例` : `全部启用用例（${cases.length} 条）` }}</span>
        </el-form-item>
        <el-form-item label="额外要求">
          <el-input v-model="runExtra" type="textarea" :rows="2" placeholder="可选：补充执行要求" />
        </el-form-item>
      </el-form>
      <el-alert
        type="info"
        :closable="false"
        title="先「预演」查看将执行的用例与提示词；确认后再派单。派单会为每条用例开一条执行中报告，并由 agent 执行后回写结论。"
      />
      <pre v-if="runPreview" class="run-preview">{{ runPreview }}</pre>
      <template #footer>
        <el-button @click="runDialog = false">取消</el-button>
        <el-button :loading="previewing" @click="dryRun">预演</el-button>
        <el-button type="primary" :loading="dispatching" @click="dispatchRun">派单执行</el-button>
      </template>
    </el-dialog>

    <!-- 报告详情 -->
    <el-dialog v-model="reportDialog" :title="`测试报告 #${reportDetail?.id ?? ''}`" width="560px">
      <el-descriptions v-if="reportDetail" :column="1" border size="small">
        <el-descriptions-item label="用例">{{ caseName(reportDetail.caseId) }}</el-descriptions-item>
        <el-descriptions-item label="状态">
          <el-tag size="small" :type="reportStatusType(reportDetail.status)">{{ reportStatusLabel(reportDetail.status) }}</el-tag>
        </el-descriptions-item>
        <el-descriptions-item label="结论">{{ reportDetail.summary || '—' }}</el-descriptions-item>
        <el-descriptions-item label="细节">
          <div class="detail-text">{{ reportDetail.detail || '—' }}</div>
        </el-descriptions-item>
        <el-descriptions-item label="执行任务">{{ reportDetail.runId ?? '—' }}</el-descriptions-item>
        <el-descriptions-item label="自动收尾">{{ reportDetail.autoFinalized ? '是' : '否' }}</el-descriptions-item>
        <el-descriptions-item label="开始">{{ reportDetail.startedAt }}</el-descriptions-item>
        <el-descriptions-item label="完成">{{ reportDetail.finishedAt || '—' }}</el-descriptions-item>
      </el-descriptions>
    </el-dialog>

    <!-- 回写报告终态 -->
    <el-dialog v-model="finishDialog" title="回写测试结论" width="440px">
      <el-form label-width="70px" size="small">
        <el-form-item label="结论">
          <el-select v-model="finishForm.status" style="width:100%">
            <el-option v-for="s in terminalStatuses" :key="s" :label="reportStatusLabel(s)" :value="s" />
          </el-select>
        </el-form-item>
        <el-form-item label="摘要">
          <el-input v-model="finishForm.summary" />
        </el-form-item>
        <el-form-item label="细节">
          <el-input v-model="finishForm.detail" type="textarea" :rows="3" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="finishDialog = false">取消</el-button>
        <el-button type="primary" :loading="finishing" @click="submitFinish">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import api from '../api.js'
import {
  TEST_CASE_KINDS,
  REPORT_STATUSES,
  buildAcceptanceKpi,
  acceptanceBucketsConserved,
  caseKindLabel,
  reportStatusLabel,
  reportStatusType
} from '../regression.js'

const props = defineProps({ nodeId: { type: [Number, String], required: true } })

const CASE_KINDS = TEST_CASE_KINDS
const terminalStatuses = REPORT_STATUSES.filter((s) => s !== 'running')

const loading = ref(false)
const reportsLoading = ref(false)
const saving = ref(false)
const previewing = ref(false)
const dispatching = ref(false)
const finishing = ref(false)

const cases = ref([])
const reports = ref([])
const acceptance = ref({ totals: {}, items: [] })
const conclusion = ref({ decision: 'unknown', totals: {}, items: [] })
const selectedCases = ref([])
const kindFilter = ref('')
const includeDisabled = ref(false)
const scope = ref('self')
const reportFilterCase = ref(null)

const caseDialog = ref(false)
const caseForm = reactive({ id: null, name: '', kind: 'regression', prompt: '', expectation: '', enabled: true })

const runDialog = ref(false)
const runCaseIds = ref([])
const runExtra = ref('')
const runPreview = ref('')

const reportDialog = ref(false)
const reportDetail = ref(null)

const finishDialog = ref(false)
const finishForm = reactive({ id: null, status: 'pass', summary: '', detail: '' })

const kpis = computed(() => buildAcceptanceKpi(acceptance.value.totals))
const kpisConserved = computed(() => acceptanceBucketsConserved(acceptance.value.totals))
const acceptLabel = computed(() => {
  const t = acceptance.value.totals || {}
  if (!t.cases) return '暂无用例'
  if (t.settled === 0) return '等待执行'
  return t.fail || t.blocked || t.error ? '未通过' : '通过'
})
const acceptTagType = computed(() => {
  const t = acceptance.value.totals || {}
  if (!t.cases || t.settled === 0) return 'info'
  return t.fail || t.blocked || t.error ? 'danger' : 'success'
})

const CONCLUSION_LABELS = { accepted: '验收通过', rejected: '验收未通过', unknown: '待判定' }
const CONCLUSION_ITEM_LABELS = { pass: '通过', fail: '未通过', not_applicable: '不适用' }
const conclusionLabel = computed(() => CONCLUSION_LABELS[conclusion.value.decision] || conclusion.value.decision)
const conclusionTagType = computed(
  () => ({ accepted: 'success', rejected: 'danger' })[conclusion.value.decision] || 'info'
)
const conclusionSummary = computed(() => {
  const t = conclusion.value.totals || {}
  if (!t.units) return '当前范围没有可判定的需求'
  return `需求 ${t.units} · 通过 ${t.pass} · 未通过 ${t.fail} · 阻塞项 ${t.blockers}`
})
const conclusionItemLabel = (d) => CONCLUSION_ITEM_LABELS[d] || d
const conclusionItemTagType = (d) => ({ pass: 'success', fail: 'danger' }[d] || 'info')

const latestOf = (row) => (acceptance.value.items || []).find((i) => i.caseId === row.id)
const caseName = (caseId) => cases.value.find((c) => c.id === caseId)?.name || (caseId ? `#${caseId}` : '（已删除用例）')

function onSelectionChange(rows) {
  selectedCases.value = rows
}

async function loadCases() {
  loading.value = true
  try {
    cases.value = await api.testCaseList(props.nodeId, {
      kind: kindFilter.value || undefined,
      includeDisabled: includeDisabled.value
    })
  } finally {
    loading.value = false
  }
}

async function loadReports() {
  reportsLoading.value = true
  try {
    reports.value = await api.testReportList(props.nodeId, reportFilterCase.value ? { caseId: reportFilterCase.value.id } : {})
  } finally {
    reportsLoading.value = false
  }
}

async function loadAcceptance() {
  acceptance.value = await api.acceptanceReport(props.nodeId, { scope: scope.value })
}

async function loadConclusion() {
  conclusion.value = await api.acceptanceConclusion(props.nodeId, { scope: scope.value })
}

async function loadAcceptanceScope() {
  await Promise.all([loadAcceptance(), loadConclusion()])
}

async function reloadAll() {
  await Promise.all([loadCases(), loadReports(), loadAcceptance(), loadConclusion()])
}

function openCaseDialog(row = null) {
  caseForm.id = row?.id ?? null
  caseForm.name = row?.name ?? ''
  caseForm.kind = row?.kind ?? 'regression'
  caseForm.prompt = row?.prompt ?? ''
  caseForm.expectation = row?.expectation ?? ''
  caseForm.enabled = row?.enabled ?? true
  caseDialog.value = true
}

async function submitCase() {
  if (!caseForm.name.trim() || !caseForm.prompt.trim()) {
    ElMessage.warning('名称与提示词必填')
    return
  }
  saving.value = true
  try {
    const payload = {
      name: caseForm.name.trim(),
      kind: caseForm.kind,
      prompt: caseForm.prompt.trim(),
      expectation: caseForm.expectation || null,
      enabled: caseForm.enabled
    }
    if (caseForm.id) await api.testCaseUpdate(caseForm.id, payload)
    else await api.testCaseUpsert(props.nodeId, payload)
    caseDialog.value = false
    await reloadAll()
    ElMessage.success('已保存')
  } catch (e) {
    ElMessage.error(e.message)
  } finally {
    saving.value = false
  }
}

async function removeCase(row) {
  try {
    await ElMessageBox.confirm(`删除用例「${row.name}」？历史报告会保留。`, '确认删除', { type: 'warning' })
  } catch {
    return
  }
  await api.testCaseRemove(row.id)
  await reloadAll()
}

function filterReports(row) {
  reportFilterCase.value = row
  loadReports()
}

function clearReportFilter() {
  reportFilterCase.value = null
  loadReports()
}

function openRunDialog() {
  runCaseIds.value = selectedCases.value.map((c) => c.id)
  runExtra.value = ''
  runPreview.value = ''
  runDialog.value = true
}

async function dryRun() {
  previewing.value = true
  try {
    const out = await api.testRun(props.nodeId, {
      caseIds: runCaseIds.value.length ? runCaseIds.value : undefined,
      prompt: runExtra.value || undefined,
      dryRun: true
    })
    runPreview.value = out.prompt || ''
  } catch (e) {
    ElMessage.error(e.message)
  } finally {
    previewing.value = false
  }
}

async function dispatchRun() {
  dispatching.value = true
  try {
    await api.testRun(props.nodeId, {
      caseIds: runCaseIds.value.length ? runCaseIds.value : undefined,
      prompt: runExtra.value || undefined
    })
    runDialog.value = false
    selectedCases.value = []
    await reloadAll()
    ElMessage.success('已派单，报告已开为执行中')
  } catch (e) {
    ElMessage.error(e.message)
  } finally {
    dispatching.value = false
  }
}

function openReport(row) {
  reportDetail.value = row
  reportDialog.value = true
}

function openFinish(row) {
  finishForm.id = row.id
  finishForm.status = 'pass'
  finishForm.summary = row.summary || ''
  finishForm.detail = row.detail || ''
  finishDialog.value = true
}

async function submitFinish() {
  finishing.value = true
  try {
    await api.testReportFinish(finishForm.id, {
      status: finishForm.status,
      summary: finishForm.summary || undefined,
      detail: finishForm.detail || undefined
    })
    finishDialog.value = false
    await reloadAll()
    ElMessage.success('已回写')
  } catch (e) {
    ElMessage.error(e.message)
  } finally {
    finishing.value = false
  }
}

watch(() => props.nodeId, reloadAll, { immediate: true })
</script>

<style scoped>
.regression-pane { height:100%; overflow-y:auto; padding-right:4px; }
.accept-head { display:flex; align-items:center; gap:12px; flex-wrap:wrap; margin-bottom:10px; }
.accept-kpis { display:flex; gap:14px; flex-wrap:wrap; flex:1; }
.accept-kpis :deep(.el-statistic) { min-width:64px; }
.case-toolbar { display:flex; align-items:center; gap:8px; margin-bottom:8px; flex-wrap:wrap; }
.conclusion-block { display:flex; align-items:center; gap:10px; margin-bottom:8px; }
.conclusion-summary { font-size:12px; color:#606266; }
.case-name { font-size:13px; color:#303133; }
.case-prompt { font-size:12px; color:#909399; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.report-toolbar { margin-bottom:6px; }
.report-filter { font-size:12px; color:#606266; }
.run-preview { background:#f5f7fa; border:1px solid #e4e7ed; border-radius:4px; padding:8px; max-height:240px; overflow:auto; font-size:12px; white-space:pre-wrap; }
.detail-text { white-space:pre-wrap; }
</style>
