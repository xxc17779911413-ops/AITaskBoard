# 提交记录：代码检查

- feat(code-audit): 代码检查——已登记提交新增行的只读静态审查（冲突标记 / 私钥 / 硬编码凭据 / eval / 聚焦测试 / 调试遗留），只扫 diff 新增行不误算历史遗留；两级严重度（danger 阻塞 ready；warn 仅提示）；`ready=null` 覆盖「无提交 / 无新增行 / 有提交读不到 / 扫描截断」四种空态；凭据证据先脱敏再截断，任何输出不回显原值；单条提交读取失败不拖垮整体；三入口 1:1（HTTP /api/nodes/:id/code-audit、CLI code audit、MCP code_audit）+ renderCodeAuditMd + NodeDrawer「代码检查」页签；纯读不落表不动 revision；补 36 条 UT（规则边界 / 行号口径 / 脱敏先于截断 / 三态优先级 / 真实 CLI 与 MCP 协议 / markdown 转义）
- fix(code-audit): 收口 QA D1——同一行多个凭据赋值时第二个明文从 snippet 泄漏到 JSON / markdown / MCP / Web；`mask()` 改为扫出该行全部非占位凭据值后掩码每个值的所有出现位置（原实现只取第一条匹配且 `line.replace(value,…)` 按文本命中第一个相同文本，会掩错位置并漏掉后面的凭据）；按值长度降序单次正则交替避免前缀碰撞；补 6 条 D1 回归 UT（同值双凭据 / 不同值双凭据 / 同值多次出现 / 前缀碰撞 / 占位值不误掩 / 四条输出通道均无明文），6 条在旧实现上全部失败
