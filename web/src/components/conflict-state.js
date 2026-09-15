/**
 * ConflictPane 的纯状态变换（无 Vue / DOM 依赖），便于回归测试多文件编辑流。
 *
 * 关键语义（N11 回归点）：
 * - `handled` 显式区分「未处理」与「已处理为空」；未处理回落 ours/theirs，已处理为空保留空串。
 * - 切换文件前必须 commitCurrent，把当前 editContent 收回到 map。
 * - 「保留内容」不得读取已被删除状态清空的编辑器；应恢复删除前的编辑或回落 ours/theirs。
 */

export function recordFromFile(file) {
  const ours = file?.ours
  const theirs = file?.theirs
  const fallback = ours == null ? (theirs == null ? '' : theirs) : ours
  return { path: file?.file || file?.path, handled: false, deleted: false, content: fallback, draft: fallback }
}

export function buildInitialMap(files = []) {
  const map = {}
  for (const f of files) {
    const path = f.file || f.path
    map[path] = recordFromFile(f)
  }
  return map
}

export function applySaved(map, savedFiles = []) {
  const next = { ...map }
  for (const f of savedFiles || []) {
    next[f.path] = {
      path: f.path,
      handled: true,
      deleted: !!f.deleted,
      content: f.content,
      draft: f.deleted ? null : f.content
    }
  }
  return next
}

/** 把当前编辑器内容收回到当前文件；删除态不回收内容草稿。 */
export function commitCurrent(map, file, editContent) {
  if (!file) return map
  const path = file.file || file.path
  const prev = map[path] || recordFromFile(file)
  if (prev.deleted) return { ...map, [path]: { ...prev } }
  return {
    ...map,
    [path]: { ...prev, handled: true, content: String(editContent ?? ''), draft: String(editContent ?? '') }
  }
}

export function switchFile(map, file, editContent) {
  const committed = commitCurrent(map, file, editContent)
  return { map: committed, path: null }
}

/** 文件切换：先回收旧文件编辑，再返回新文件的编辑器内容。 */
export function switchTo(map, fromFile, toFile, editContent) {
  const committed = commitCurrent(map, fromFile, editContent)
  const nextPath = toFile?.file || toFile?.path || ''
  const rec = committed[nextPath] || recordFromFile(toFile)
  return { map: committed, path: nextPath, content: rec.deleted ? '' : rec.draft ?? rec.content ?? '' }
}

export function setDeleted(map, file, deleted) {
  const path = file?.file || file?.path
  if (!path) return map
  const prev = map[path] || recordFromFile(file)
  if (deleted) {
    // 保留删除前的编辑草稿：用户点「保留内容」时才能恢复真实内容，而不是空串。
    return { ...map, [path]: { ...prev, handled: true, deleted: true } }
  }
  // 保留内容：优先恢复删除前的编辑草稿，其次回落真实 ours/theirs，绝不使用空串。
  const restored = prev.draft != null ? prev.draft : recordFromFile(file).content
  return { ...map, [path]: { ...prev, handled: true, deleted: false, content: restored, draft: restored } }
}

/** 组装 resolve payload：未处理项回落真实内容，已处理为空保留空串。 */
export function payloadFiles(files, map, currentPath, editContent) {
  const current = files.find((f) => (f.file || f.path) === currentPath)
  const currentRec = current ? map[current.file || current.path] : null
  // 当前文件处于删除态时，编辑器已被清空/禁用，不能再把空串回收覆盖删除草稿。
  const scratch = currentRec?.deleted ? map : commitCurrent(map, current, editContent)
  return files.map((f) => {
    const path = f.file || f.path
    const rec = scratch[path] || recordFromFile(f)
    if (rec.deleted) return { path, delete: true }
    return { path, content: rec.content == null ? recordFromFile(f).content : rec.content }
  })
}

export function statusOf(rec) {
  if (!rec || rec.handled !== true) return 'pending'
  return rec.deleted ? 'deleted' : 'handled'
}
