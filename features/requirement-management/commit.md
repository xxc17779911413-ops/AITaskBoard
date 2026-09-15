# 提交记录：需求管理

- feat(requirement-management): 需求管理端到端垂直切片——新增专属列表/创建/状态流转能力（store + HTTP + CLI + MCP 1:1），创建需求时自动关联「需求内容 / 概要设计」两份文档，列表返回文档关联状态、就绪结论与 KPI；需求状态机在 store 强制，通用 node.update 不能绕过；新增 RequirementsView 页签与 DocPane 文档抽屉；补 store/HTTP/CLI/MCP 回归
- fix(requirement-management): 收口 QA 缺陷 1–5——需求状态白名单下沉到通用 create/update，枚举外状态与通用创建绕过统一拒绝；`type=requirement` 的 create/upsert/batch 全部生成两份核心文档槽位；status 筛选同时作用于列表与 KPI；MCP 非法 status 改为 VALIDATION_FAILED；非法/空 projectId 显式拒绝；补 QA 建议的四类回归
- fix(requirement-management): 收口 QA R1/R2——`status.allowed.requirement` 改为转移图子集，启动期拒绝图外状态与缺 `todo` 配置；有效状态集统一驱动校验、`canTransitionTo` 与 KPI，堵住自定义状态直达 `done`、收窄后不可执行按钮/丢列问题；补 store 与真实 CLI+config.json 回归
- fix(requirement-management): 收口 QA E2/E3/E1——启动期校验收窄 workflow，拒绝非终态无出边与 `done` 不可达配置；`summary.total` 改为实际行数，历史图外状态单列 `unknownStatusCount` 并在需求管理 KPI 显示；移动端 KPI 网格改为 7 列；补终态不可达、历史脏数据对账、HTTP startServer 与 MCP runMcp 启动路径回归
