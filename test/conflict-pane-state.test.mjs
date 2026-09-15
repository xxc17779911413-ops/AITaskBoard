import test from 'node:test'
import assert from 'node:assert/strict'
import {
  applySaved,
  buildInitialMap,
  payloadFiles,
  setDeleted,
  statusOf,
  switchTo
} from '../web/src/components/conflict-state.js'

const files = [
  { file: 'p.txt', base: 'BASE p\n', ours: 'TARGET p\n', theirs: 'SOURCE p\n' },
  { file: 'q.txt', base: 'BASE q\n', ours: 'TARGET q\n', theirs: 'SOURCE q\n' }
]

test('N11 回归：编辑 A → 切 B → 写回，A 保留未保存编辑', () => {
  let map = buildInitialMap(files)
  let current = files[0]
  let edit = 'P EDITED\n'

  // 切到 B：必须先把 A 的编辑收回到 map
  const out = switchTo(map, current, files[1], edit)
  map = out.map
  current = files[1]
  edit = out.content

  const payload = payloadFiles(files, map, current.file, edit)
  assert.deepEqual(payload, [
    { path: 'p.txt', content: 'P EDITED\n' },
    { path: 'q.txt', content: 'TARGET q\n' }
  ])
})

test('N11 回归：编辑 → 采纳删除 → 保留内容 → 写回，恢复真实内容而非空串', () => {
  let map = buildInitialMap([files[0]])
  const file = files[0]
  map = { ...map, [file.file]: { ...map[file.file], handled: true, content: 'EDITED\n', draft: 'EDITED\n' } }

  map = setDeleted(map, file, true)
  assert.equal(statusOf(map[file.file]), 'deleted')
  map = setDeleted(map, file, false)
  assert.equal(statusOf(map[file.file]), 'handled')
  assert.equal(map[file.file].content, 'EDITED\n')

  // 组件在「保留内容」后会把恢复出的内容重新放进编辑器，因此这里传恢复值而非空串。
  const payload = payloadFiles([file], map, file.file, map[file.file].content)
  assert.deepEqual(payload, [{ path: 'p.txt', content: 'EDITED\n' }])
})

test('N11：未处理项与已处理为空明确区分', () => {
  const map = buildInitialMap([files[0], files[1]])
  const handledEmpty = applySaved(map, [{ path: 'p.txt', content: '', deleted: false }])
  assert.equal(statusOf(handledEmpty['p.txt']), 'handled')
  assert.equal(statusOf(handledEmpty['q.txt']), 'pending')

  const payload = payloadFiles(files, handledEmpty, 'q.txt', 'TARGET q\n')
  assert.deepEqual(payload, [
    { path: 'p.txt', content: '' },
    { path: 'q.txt', content: 'TARGET q\n' }
  ])
})
