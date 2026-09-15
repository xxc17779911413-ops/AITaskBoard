<template>
  <div class="release-pane">
    <div class="release-head">
      <el-tag size="large" effect="dark" :type="releaseReadyTagType(checklist.ready)">{{ releaseReadyText(checklist.ready) }}</el-tag>
      <el-select v-model="scope" size="small" style="width:120px" @change="loadAll">
        <el-option label="仅本节点" value="self" />
        <el-option label="含子树" value="subtree" />
      </el-select>
      <div class="release-kpis">
        <el-statistic v-for="kpi in kpis" :key="kpi.key" :title="kpi.title" :value="kpi.value" />
      </div>
      <el-button size="small" @click="loadAll">刷新</el-button>
    </div>

    <el-alert
      v-if="checklist.ready === null"
      type="info"
      :closable="false"
      title="当前范围既没有必做上线项、也没有 code/biz/release_check 检查用例，无法判定上线就绪"
      style="margin-bottom:8px"
    />

    <div class="release-toolbar">
      <el-button type="primary" size="small" @click="openItemDialog()">+ 新增上线项</el-button>
      <el-button size="small" @click="openCheckDialog">执行上线检查</el-button>
      <el-select v-model="kindFilter" size="small" clearable placeholder="类型" style="width:130px" @change="loadItems">
        <el-option v-for="k in ITEM_KINDS" :key="k" :label="releaseItemKindLabel(k)" :value="k" />
      </el-select>
    </div>

    <el-table :data="items" v-loading="loading" row-key="id" border stripe size="small">
      <el-table-column label="上线项" min-width="200">
        <template #default="{ row }">
          <div class="item-name">{{ row.name }}</div>
          <div class="item-content">{{ row.content }}</div>
        </template>
      </el-table-column>
      <el-table-column label="类型" width="100">
        <template #default="{ row }">
          <el-tag size="small" effect="plain">{{ releaseItemKindLabel(row.kind) }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="状态" width="100">
        <template #default="{ row }">
          <el-select v-model="row.status" size="small" @change="changeStatus(row)">
            <el-option v-for="s in ITEM_STATUSES" :key="s" :label="releaseItemStatusLabel(s)" :value="s" />
          </el-select>
        </template>
      </el-table-column>
      <el-table-column label="必做" width="70">
        <template #default="{ row }">
          <el-tag size="small" :type="row.required ? 'warning' : 'info'">{{ row.required ? '必做' : '可选' }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="回滚" width="70">
        <template #default="{ row }">{{ row.rollback ? '有' : '—' }}</template>
      </el-table-column>
      <el-table-column label="操作" width="120" fixed="right">
        <template #default="{ row }">
          <el-button link type="primary" size="small" @click="openItemDialog(row)">编辑</el-button>
          <el-button link type="danger" size="small" @click="removeItem(row)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>

    <template v-if="(checklist.checkCases || []).length">
      <el-divider content-position="left">上线检查用例</el-divider>
      <el-table :data="checklist.checkCases" size="small" border stripe>
        <el-table-column prop="name" label="检查用例" min-width="180" />
        <el-table-column label="类型" width="110">
          <template #default="{ row }">{{ releaseCaseKindLabel(row.kind) }}</template>
        </el-table-column>
        <el-table-column label="最近结果" width="110">
          <template #default="{ row }">
            <el-tag size="small" :type="reportStatusType(row.latestStatus)">{{ reportStatusLabel(row.latestStatus) }}</el-tag>
          </template>
        </el-table-column>
      </el-table>
    </template>

    <template v-if="blockerCount">
      <el-divider content-position="left">阻塞项（{{ blockerCount }}）</el-divider>
      <el-table :data="blockerRows" size="small" border stripe>
        <el-table-column label="来源" width="100">
          <template #default="{ row }">
            <el-tag size="small" :type="row.source === 'case' ? 'info' : 'warning'" effect="plain">{{ row.sourceLabel }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="name" label="阻塞项" min-width="180" />
        <el-table-column prop="detail" label="说明" min-width="180" />
      </el-table>
    </template>

    <!-- 上线项编辑 -->
    <el-dialog v-model="itemDialog" :title="itemForm.id ? '编辑上线项' : '新增上线项'" width="560px">
      <el-form label-width="70px" size="small">
        <el-form-item label="名称">
          <el-input v-model="itemForm.name" placeholder="如：开灰度开关 / 执行建索引 SQL" />
        </el-form-item>
        <el-form-item label="类型">
          <el-select v-model="itemForm.kind" style="width:100%">
            <el-option v-for="k in ITEM_KINDS" :key="k" :label="releaseItemKindLabel(k)" :value="k" />
          </el-select>
        </el-form-item>
        <el-form-item label="内容">
          <el-input v-model="itemForm.content" type="textarea" :rows="4" placeholder="配置项 / SQL / 检查步骤" />
        </el-form-item>
        <el-form-item label="回滚">
          <el-input v-model="itemForm.rollback" type="textarea" :rows="2" placeholder="回滚方式（可选）" />
        </el-form-item>
        <el-form-item label="状态">
          <el-select v-model="itemForm.status" style="width:100%">
            <el-option v-for="s in ITEM_STATUSES" :key="s" :label="releaseItemStatusLabel(s)" :value="s" />
          </el-select>
        </el-form-item>
        <el-form-item label="必做">
          <el-switch v-model="itemForm.required" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="itemDialog = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="submitItem">保存</el-button>
      </template>
    </el-dialog>

    <!-- 派单检查 -->
    <el-dialog v-model="checkDialog" title="执行上线检查" width="560px">
      <el-alert
        type="info"
        :closable="false"
        title="把上线清单与 code/biz/release_check 检查用例拼成提示词派单给 agent；dryRun 只预演不派单。"
      />
      <pre v-if="checkPreview" class="check-preview">{{ checkPreview }}</pre>
      <template #footer>
        <el-button @click="checkDialog = false">取消</el-button>
        <el-button :loading="previewing" @click="dryRunCheck">预演</el-button>
        <el-button type="primary" :loading="dispatching" @click="dispatchCheck">派单检查</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import api from '../api.js'
import { reportStatusLabel, reportStatusType } from '../regression.js'
import {
  RELEASE_ITEM_KINDS,
  RELEASE_ITEM_STATUSES,
  buildReleaseKpi,
  releaseBlockerCount,
  releaseItemKindLabel,
  releaseItemStatusLabel,
  releaseCaseKindLabel,
  releaseReadyText,
  releaseReadyTagType
} from '../release.js'

const props = defineProps({ nodeId: { type: [Number, String], required: true } })

const ITEM_KINDS = RELEASE_ITEM_KINDS
const ITEM_STATUSES = RELEASE_ITEM_STATUSES

const loading = ref(false)
const saving = ref(false)
const previewing = ref(false)
const dispatching = ref(false)

const items = ref([])
const checklist = ref({ totals: {}, blockers: [], caseBlockers: [], checkCases: [], ready: null })
const scope = ref('self')
const kindFilter = ref('')

const itemDialog = ref(false)
const itemForm = reactive({ id: null, name: '', kind: 'config', content: '', rollback: '', status: 'pending', required: true })

const checkDialog = ref(false)
const checkPreview = ref('')

const kpis = computed(() => buildReleaseKpi(checklist.value.totals))
const blockerCount = computed(() => releaseBlockerCount(checklist.value))
const blockerRows = computed(() => [
  ...(checklist.value.blockers || []).map((b) => ({
    source: 'item',
    sourceLabel: releaseItemKindLabel(b.kind),
    name: b.name,
    detail: `上线项状态：${releaseItemStatusLabel(b.status)}`
  })),
  ...(checklist.value.caseBlockers || []).map((c) => ({
    source: 'case',
    sourceLabel: releaseCaseKindLabel(c.kind),
    name: c.name,
    detail: `检查用例最近结果：${reportStatusLabel(c.latestStatus)}`
  }))
])

async function loadItems() {
  loading.value = true
  try {
    items.value = await api.releaseItemList(props.nodeId, { kind: kindFilter.value || undefined })
  } finally {
    loading.value = false
  }
}

async function loadChecklist() {
  checklist.value = await api.releaseChecklist(props.nodeId, { scope: scope.value })
}

async function loadAll() {
  await Promise.all([loadItems(), loadChecklist()])
}

function openItemDialog(row = null) {
  itemForm.id = row?.id ?? null
  itemForm.name = row?.name ?? ''
  itemForm.kind = row?.kind ?? 'config'
  itemForm.content = row?.content ?? ''
  itemForm.rollback = row?.rollback ?? ''
  itemForm.status = row?.status ?? 'pending'
  itemForm.required = row?.required ?? true
  itemDialog.value = true
}

async function submitItem() {
  if (!itemForm.name.trim()) {
    ElMessage.warning('名称必填')
    return
  }
  saving.value = true
  try {
    const payload = {
      name: itemForm.name.trim(),
      kind: itemForm.kind,
      content: itemForm.content || '',
      rollback: itemForm.rollback || null,
      status: itemForm.status,
      required: itemForm.required
    }
    if (itemForm.id) await api.releaseItemUpdate(itemForm.id, payload)
    else await api.releaseItemUpsert(props.nodeId, payload)
    itemDialog.value = false
    await loadAll()
    ElMessage.success('已保存')
  } catch (e) {
    ElMessage.error(e.message)
  } finally {
    saving.value = false
  }
}

async function changeStatus(row) {
  try {
    await api.releaseItemUpdate(row.id, { status: row.status })
    await loadChecklist()
  } catch (e) {
    ElMessage.error(e.message)
    await loadItems()
  }
}

async function removeItem(row) {
  try {
    await ElMessageBox.confirm(`删除上线项「${row.name}」？`, '确认删除', { type: 'warning' })
  } catch {
    return
  }
  await api.releaseItemRemove(row.id)
  await loadAll()
}

function openCheckDialog() {
  checkPreview.value = ''
  checkDialog.value = true
}

async function dryRunCheck() {
  previewing.value = true
  try {
    const out = await api.releaseCheck(props.nodeId, { scope: scope.value, dryRun: true })
    checkPreview.value = out.prompt || ''
  } catch (e) {
    ElMessage.error(e.message)
  } finally {
    previewing.value = false
  }
}

async function dispatchCheck() {
  dispatching.value = true
  try {
    await api.releaseCheck(props.nodeId, { scope: scope.value })
    checkDialog.value = false
    await loadAll()
    ElMessage.success('已派单，检查报告已开为执行中')
  } catch (e) {
    ElMessage.error(e.message)
  } finally {
    dispatching.value = false
  }
}

watch(() => props.nodeId, loadAll, { immediate: true })
</script>

<style scoped>
.release-pane { height:100%; overflow-y:auto; padding-right:4px; }
.release-head { display:flex; align-items:center; gap:12px; flex-wrap:wrap; margin-bottom:10px; }
.release-kpis { display:flex; gap:14px; flex-wrap:wrap; flex:1; }
.release-kpis :deep(.el-statistic) { min-width:64px; }
.release-toolbar { display:flex; align-items:center; gap:8px; margin-bottom:8px; flex-wrap:wrap; }
.item-name { font-size:13px; color:#303133; }
.item-content { font-size:12px; color:#909399; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.check-preview { background:#f5f7fa; border:1px solid #e4e7ed; border-radius:4px; padding:8px; max-height:240px; overflow:auto; font-size:12px; white-space:pre-wrap; }
</style>
