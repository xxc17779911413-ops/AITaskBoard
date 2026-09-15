# 提交记录：结构探索

- feat(structure-exploration): 需求树 + 文档/用例/验收状态的只读图谱——`buildStructureGraph` 复用节点树与 `buildRequirementReadiness` 做状态叠加（文档缺口 / 用例最近结论最严重优先 / 需求就绪 / 门禁阻塞），支持 type/status/ready/hasGap/caseStatus/q 基础筛选（非法值 VALIDATION_FAILED，不静默降级）；筛选只影响展示、边两端保留；三入口 1:1（HTTP `/api/nodes/:id/structure-graph`、CLI `structure graph`、MCP `structure_graph`）+ renderStructureGraphMd + TOOLS 登记；Web 顶栏「结构探索」页（筛选 + KPI + 树形缩进 + 节点跳转，`web/src/structure.js` 纯展示口径）；纯读不 bump revision；补 store/入口/展示口径回归
- fix(structure-exploration): 收口 QA 的 `status` 筛选口径缺陷——`status` 是需求状态，匹配时限定 requirement / subreq（值域本就由 `assertRequirementStatus` 守住），避免 project / group / task 的 status 列同值混入；补正例回归（构造非需求节点同值 status 干扰，断言只命中需求两层）
