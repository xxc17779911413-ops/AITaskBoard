/**
 * 文档管理顶部 KPI 展示口径。
 *
 * scope 级字段（requirementCount / requiredSlotCount / ...）只随项目 / 状态变化；
 * 一旦叠加 q / docName / fill 这类结果集筛选，文档数与缺口项必须与表格 / 缺口面板一致，
 * 因此优先消费后端已返回的 filteredDocumentCount / filteredGapCount。
 */
export function buildDocumentKpi(summary = {}, { filtered = false } = {}) {
  const num = (v) => {
    const n = Number(v)
    return Number.isFinite(n) ? n : 0
  }
  const pickFiltered = (filteredKey, scopeKey) => (filtered ? num(summary[filteredKey]) : num(summary[scopeKey]))
  return [
    { key: 'requirementCount', title: '需求数', value: num(summary.requirementCount) },
    {
      key: 'documentCount',
      title: filtered ? '筛选文档' : '文档数',
      value: pickFiltered('filteredDocumentCount', 'documentCount')
    },
    { key: 'requiredSlotCount', title: '核心槽位', value: num(summary.requiredSlotCount) },
    { key: 'filledRequiredSlotCount', title: '已填写核心', value: num(summary.filledRequiredSlotCount) },
    { key: 'emptyRequiredSlotCount', title: '空白核心', value: num(summary.emptyRequiredSlotCount) },
    { key: 'unlinkedRequiredSlotCount', title: '未关联核心', value: num(summary.unlinkedRequiredSlotCount) },
    {
      key: 'gapRequirementCount',
      title: filtered ? '筛选缺口' : '缺口需求',
      value: pickFiltered('filteredGapCount', 'gapRequirementCount')
    }
  ]
}
