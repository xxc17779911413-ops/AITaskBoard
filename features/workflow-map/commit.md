# 提交记录（workflow-map）

- feat(workflow-map): 研发主线思维导图——新增只读聚合 `buildWorkflowMap`，把节点树 / 需求与概要设计门禁 / 文档 / AI 可回归用例 / 测试报告 / 验收报告 / 上线配置与 SQL / 上线、代码、业务检查投影成 `root → stage → branch` 图；四态 `pass/fail/pending/empty`，空态不伪装成通过；`scope=subtree` 覆盖需求两层；三入口 1:1（HTTP `/api/nodes/:id/workflow-map`、CLI `workflow map`、MCP `workflow_map`）+ `renderWorkflowMapMd` + NodeDrawer「主线」页签 SVG 可视化；纯读、不落表、不动 revision
- feat(workflow-map): 上线治理交互与检查回写——图保持只读，给上线分支补充稳定引用（`releaseItems` / `checkCases` / `latestReportId`）；「主线」右侧面板显式回写上线项状态、dry-run 后派单检查、按报告回写 pass/fail/blocked；复用既有 `release_items` / `test_reports` 状态机与 revision 语义；补 UT 覆盖写引用、回写翻转与只影响目标项
- fix(workflow-map): D1–D4 收口——D1 空白预置文档不作为通过证据、`mindmap` 排除根聚合，裸项目整体非 pass；D2 REST/CLI/MCP 统一 `normalizeFormat`，非法 format 一律 `VALIDATION_FAILED`；D3 检查分支按逐用例最严重状态收敛，避免一条 pass 掩盖 not_run；D4 `release_check` 补上线项状态回写入口；四项均补可复现 UT
