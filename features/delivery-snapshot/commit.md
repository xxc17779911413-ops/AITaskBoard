# 提交记录：交付证据快照

- feat(delivery-snapshot): 交付证据快照——显式冻结当前 delivery_gate 的完整依据与 SHA-256 指纹，后续读取实时核对并返回 current / drifted，历史结论不可变；新增 delivery_snapshots 表与 v6 迁移、store 三类能力、HTTP / CLI / MCP 三入口 1:1、renderDeliverySnapshotMd 与 NodeDrawer「交付」页冻结入口；补齐 store actor 白名单中的 mcp / system，修复 MCP 操作者被降级为 user 的审计缺口；新增 9 条回归覆盖不可变性、漂移、scope、revision、级联和三入口
- fix(delivery-snapshot): 收口独立测试 D1/D2——Markdown 导出的节点标题与备注统一按单行 / 单元格规则转义反斜杠、竖线、换行，用户文本不能注入章节或伪造证据表格；指纹改为证据投影，递归剔除 name / path / label 等展示字段，明确“漂移只认证据集合”，节点改名不再误报 drifted；补 D1 注入回归与三入口 md 一致性、D2 改名不漂移回归
- fix(delivery-snapshot): 收口独立复验 D1/D2 残余——`cell()` 按 CommonMark 行结束符口径统一 `\r\n|\r|\n`，单独 CR 不再能注入代码围栏 / 引用 / HTML 块并吞掉冻结依据表；证据指纹同时剔除 `createdAt/updatedAt/createdBy/updatedBy` 审计元数据，使上线项仅改名、no-op 重存保持 `current`，而 status/content 等证据变化仍 `drifted`；补真实 Markdown 渲染断言和三入口上线项漂移矩阵回归
