<template>
  <el-dialog
    :model-value="visible"
    width="94%"
    top="4vh"
    append-to-body
    destroy-on-close
    class="conflict-dialog"
    @update:model-value="$emit('update:visible', $event)"
  >
    <template #header>
      <div class="conflict-header">
        <span class="conflict-title">冲突处理</span>
        <span v-if="merge" class="conflict-meta">
          {{ merge.repo }} · {{ merge.sourceBranch }} → {{ merge.targetBranch }} · #{{ merge.id }}
        </span>
        <el-tag v-if="merge" size="small" :type="stateTag(merge.state)" effect="plain">{{ stateLabel(merge.state) }}</el-tag>
      </div>
    </template>

    <div v-loading="loading" class="conflict-body">
      <el-alert v-if="error" :title="error" type="error" :closable="false" />
      <template v-else-if="merge">
        <div class="conflict-toolbar">
          <div class="conflict-files">
            <div
              v-for="f in files"
              :key="f.file"
              class="conflict-file"
              :class="{ active: f.file === currentPath }"
              @click="selectFile(f.file)"
            >
              <span class="file-name" :title="f.file">{{ f.file }}</span>
              <el-tag size="small" :type="tagTypeFor(f.file)" effect="plain">{{ labelFor(f.file) }}</el-tag>
            </div>
          </div>
          <div class="conflict-actions">
            <el-button size="small" @click="setDelete(false)" :disabled="!currentFile">保留内容</el-button>
            <el-button size="small" type="danger" plain @click="setDelete(true)" :disabled="!currentFile">采纳删除</el-button>
            <el-button size="small" type="primary" :loading="saving" @click="saveResolve">写回</el-button>
          </div>
        </div>

        <div v-if="!currentFile" class="conflict-empty">无冲突文件</div>
        <template v-else>
          <div class="conflict-columns">
            <div class="conflict-col">
              <div class="col-title">Base</div>
              <pre class="col-content">{{ currentFile.base ?? '' }}</pre>
            </div>
            <div class="conflict-col">
              <div class="col-title">当前（{{ merge.targetBranch }}）</div>
              <pre class="col-content">{{ currentFile.ours ?? '' }}</pre>
            </div>
            <div class="conflict-col">
              <div class="col-title">传入（{{ merge.sourceBranch }}）</div>
              <pre class="col-content">{{ currentFile.theirs ?? '' }}</pre>
            </div>
          </div>
          <div class="conflict-editor">
            <div class="col-title">处理结果</div>
            <el-input v-model="editContent" type="textarea" :rows="10" :disabled="isDeleted" />
          </div>
        </template>

        <div class="conflict-footer">
          <el-input v-model="mergeSha" size="small" placeholder="合并提交 sha（可选）" style="max-width:280px" />
          <el-button size="small" @click="doAbort">放弃本次合并</el-button>
          <el-button size="small" type="success" :loading="confirming" @click="doConfirm">确认合并完成</el-button>
        </div>
      </template>
    </div>
  </el-dialog>
</template>

<script setup>
import { ref, computed, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import api from '../api.js'
import { applySaved, buildInitialMap, payloadFiles as buildPayload, setDeleted as setFileDeleted, statusOf, switchTo } from './conflict-state.js'

const props = defineProps({ visible: Boolean, mergeId: [Number, String] })
const emit = defineEmits(['update:visible', 'resolved'])

const loading = ref(false)
const saving = ref(false)
const confirming = ref(false)
const error = ref('')
const merge = ref(null)
const files = ref([])
const currentPath = ref('')
const editContent = ref('')
const resolvedMap = ref({})
const mergeSha = ref('')

const currentFile = computed(() => files.value.find((f) => f.file === currentPath.value) || null)
const isDeleted = computed(() => resolvedMap.value[currentPath.value]?.deleted === true)

const stateLabel = (s) => ({ precheck_conflict: '待处理冲突', merged: '已合并', resolved: '已解决', aborted: '已放弃' }[s] || s)
const stateTag = (s) => ({ precheck_conflict: 'warning', merged: 'success', resolved: 'success', aborted: 'info' }[s] || 'info')

async function load() {
  if (!props.mergeId) return
  loading.value = true
  error.value = ''
  try {
    const out = await api.mergeConflicts(props.mergeId)
    merge.value = out.merge
    files.value = out.files || []
    currentPath.value = files.value[0]?.file || ''
    resolvedMap.value = applySaved(buildInitialMap(files.value), out.merge?.resolvedFiles || [])
    resetEditor()
  } catch (e) {
    error.value = e?.message || String(e)
  } finally {
    loading.value = false
  }
}

function labelFor(path) {
  const st = statusOf(resolvedMap.value[path])
  return { pending: '待处理', handled: '已处理', deleted: '删除' }[st]
}

function tagTypeFor(path) {
  const st = statusOf(resolvedMap.value[path])
  return st === 'deleted' ? 'danger' : st === 'handled' ? 'success' : 'info'
}

/** 按当前记录重置编辑器；未处理回落真实内容，已处理为空保留空串。 */
function resetEditor() {
  const rec = resolvedMap.value[currentPath.value]
  editContent.value = rec?.deleted ? '' : rec?.draft ?? rec?.content ?? currentFile.value?.ours ?? currentFile.value?.theirs ?? ''
}

function selectFile(path) {
  const target = files.value.find((f) => f.file === path) || null
  const out = switchTo(resolvedMap.value, currentFile.value, target, editContent.value)
  resolvedMap.value = out.map
  currentPath.value = out.path
  editContent.value = out.content
}

function setDelete(deleted) {
  if (!currentFile.value) return
  resolvedMap.value = setFileDeleted(resolvedMap.value, currentFile.value, deleted)
  resetEditor()
}

function payloadFiles() {
  return buildPayload(files.value, resolvedMap.value, currentPath.value, editContent.value)
}

async function saveResolve() {
  if (!currentFile.value) return
  saving.value = true
  try {
    const out = await api.mergeResolve(props.mergeId, payloadFiles(), false)
    resolvedMap.value = applySaved(resolvedMap.value, out.files || [])
    merge.value = { ...merge.value, resolvedFiles: out.files }
    ElMessage.success('冲突处理结果已写回')
    emit('resolved', out)
  } catch (e) {
    ElMessage.error(e?.message || String(e))
  } finally {
    saving.value = false
  }
}

async function doConfirm() {
  try {
    await ElMessageBox.confirm('确认本地已应用合并结果？状态将置为已解决。', '确认合并完成', { type: 'warning' })
  } catch {
    return
  }
  confirming.value = true
  try {
    await api.mergeConfirm(props.mergeId, mergeSha.value || null)
    ElMessage.success('合并已确认')
    emit('resolved')
    emit('update:visible', false)
  } catch (e) {
    ElMessage.error(e?.message || String(e))
  } finally {
    confirming.value = false
  }
}

async function doAbort() {
  try {
    await ElMessageBox.confirm('放弃本次合并尝试？不会修改分支。', '放弃合并', { type: 'warning' })
  } catch {
    return
  }
  try {
    await api.mergeAbort(props.mergeId)
    ElMessage.success('已放弃本次合并')
    emit('resolved')
    emit('update:visible', false)
  } catch (e) {
    ElMessage.error(e?.message || String(e))
  }
}

watch(
  () => props.visible,
  (v) => {
    if (v) load()
  },
  { immediate: true }
)
</script>

<style scoped>
.conflict-header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding-right: 32px;
}
.conflict-title {
  font-weight: 600;
}
.conflict-meta {
  color: #909399;
  font-size: 12px;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.conflict-toolbar {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  margin-bottom: 10px;
}
.conflict-files {
  width: 260px;
  max-height: 120px;
  overflow: auto;
  border: 1px solid #e4e7ed;
  border-radius: 4px;
}
.conflict-file {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  font-size: 12px;
  cursor: pointer;
  border-bottom: 1px solid #f2f3f5;
}
.conflict-file.active {
  background: #ecf5ff;
}
.file-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.conflict-actions {
  display: flex;
  gap: 6px;
}
.conflict-columns {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
}
.conflict-col {
  min-width: 0;
  border: 1px solid #e4e7ed;
  border-radius: 4px;
  overflow: hidden;
}
.col-title {
  font-size: 12px;
  color: #606266;
  padding: 4px 8px;
  background: #f5f7fa;
  border-bottom: 1px solid #e4e7ed;
}
.col-content {
  margin: 0;
  padding: 8px;
  max-height: 220px;
  overflow: auto;
  font-size: 12px;
  white-space: pre-wrap;
}
.conflict-editor {
  margin-top: 10px;
}
.conflict-footer {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  margin-top: 12px;
}
.conflict-empty {
  padding: 24px;
  text-align: center;
  color: #909399;
}
</style>
