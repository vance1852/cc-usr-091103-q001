# 山径气象窗口协议

这里保存徒步路线逐时预报修订的接入约定。预报以来源和版本区分，适用区间使用带时区偏移的 ISO 8601 时间，路线段限制可由后续领域服务据此计算。

## 目录

- `fixtures/forecast-revision.json` 是一条山脊预报修订样例。
- `src/forecast-contract.js` 负责读取并校验预报信封。
- `test/forecast-contract.test.js` 检查样例与扩展属性保留行为。

运行 `npm test` 可核对当前协议。预报资料只表达输入事实，不在解析阶段读取系统时间或推导放行结论。
