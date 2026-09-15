# MR 自动拉取功能提交记录

> 状态：**已实现**（计划 5）。

- docs(mr-sync): 建立功能文档 —— prd（需求 + 接口表 + 验收标准）、design（拉取 / upsert / token 安全 / 错误码细分）
- feat(mr-sync): MR 自动拉取闭环——新增 `server/gitlab.mjs`（fetch + PRIVATE-TOKEN + 10s 超时 + 最多 3 页、401/404/网络错误稳定码）；store 新增 `listMrs` / `upsertMrs`（按 node×project×iid upsert、未返回记录保留）；ops `listMergeRequests` / `refreshMergeRequests`；HTTP（`GET/POST /api/nodes/:id/mrs`）/ CLI（`mr list|refresh`）/ MCP（`mr_list` / `mr_refresh`）三入口 1:1；节点详情内嵌 `mrs`，NodeDrawer 增加 MR 页签
- test(mr-sync): 本地 GitLab stub 回归——分页 / upsert 幂等 / 未返回记录保留；未配置、401、404、缺属性稳定报错且既有 MR 数据不变；HTTP / CLI / MCP 三入口列表逐字段一致
