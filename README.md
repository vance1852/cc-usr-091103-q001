# 山径气象窗口放行系统

把**路线分段、成员耐受能力、逐时预报及其修订版本**汇成带依据的放行结论。
值班员可随时查询每次结论采用了哪个预报版本、哪些路段触发限制；服务重启或预报重复投递后得到同一份可追溯结果。

## 领域规则（结论从哪里来）

- 气象要素按**海拔分级**设阈值（高海拔更严）：`windGustKph`（阵风）、`visibilityM`（能见度）、`precipitationMm`（窗口累计降水）。
- **成员耐受**只允许让阈值更严：阵风/降水取更低的个人上限，能见度取更高的个人下限；未声明者沿用策略。
- 结论等级：`GO` → `CONDITIONAL_GO`（附折返/通联等条件）→ `NO_GO`。
- **缺测从严**：行程暴露窗口内某路段某小时某要素无值，即 `NO_GO`，并记录具体 `路段/小时/要素`。
- **来源矛盾**：同一小时不同来源差值超过容差（见 `DEFAULT_POLICY.conflicts`），记录冲突并**采用更危险一侧**（风取高、能见度取低）。
- 每个来源只取其最高 `revision`；`cutoff`（计算时刻，等于当时最新预报的 `issuedAt`，显式入参）之后发布的预报不参与计算。
- 时间一律用**带时区偏移的 ISO 8601**，内部按 epoch 比较、按俱乐部时区（默认 +08:00）归整点桶，**跨午夜**行程天然连续。

## 更正预报到达后的两条通道（不可悄悄改写原决定）

| 队伍状态 | 更正预报到达时 |
|---|---|
| 未出发 `PLANNED` | **重算并产生新版本结论**（v1、v2…），旧版本永久留档，`supersedes` 串成版本链，并通知领队 |
| 已签到 `DEPARTED` | 原结论**冻结不可改写**；只允许追加**风险升级** `RiskEscalated`（只能升级不能降级）+ `LeaderNotified` 通知领队 |

- 签到（check-in）即冻结当时结论；`NO_GO` / `PENDING_REVIEW` 下禁止出发。
- **人工复核**：领队可申请复核。未出发 → 结论挂起为 `PENDING_REVIEW`（新版本，自动结论不删除），值班员裁定后产生 `MANUAL_OVERRIDE` 版本闭环；已出发 → 不改结论，只记录申请、通知与值班员处置指令。

## 可重复计算与审计

- 所有状态变更是**仅附加事件**（JSONL，`data/events.jsonl`，可用 `LOG_FILE` 覆盖）：重启重放即重建全部状态，领域结果不依赖系统时间。
- 每条结论带 `weather.contentHash`（策略+行程+采用的预报版本+逐小时判定的确定性哈希），决策 ID 也由内容决定——重放、重算、重复投递后 ID 与哈希一致。
- 预报投递支持 `Idempotency-Key`（默认 `forecast:<eventId>`）：同键同载荷只生效一次，同键不同载荷报 `409 DEDUPE_CONFLICT`。
- 崩溃恢复：级联未完成会在重启时按确定性规则补齐；"结论/升级落盘后、通知落盘前"崩溃会**补发**领队通知（标记 `recovered`），且不重复。
- `GET /trips/:id/audit` 返回按序号排列的完整事件流；未知扩展字段（如 `bulletinCode`、`terrainClass`、`transport`）原样保留在各实体的 `attributes` 中。

## 目录

- `src/forecast-contract.js`：预报信封契约（读取并校验，保留扩展属性）。
- `src/domain/`：纯函数，可重复计算
  - `time.js` 时区/小时桶；`policy.js` 海拔分级与成员耐受；`evaluate.js` 逐时段评估与证据；`decision.js` 结论映射；`hash.js` 确定性序列化。
- `src/store/event-store.js`：仅附加 JSONL 事件日志（重放、幂等、序号校验）。
- `src/service/clearance-service.js`：编排（重算级联、冻结/升级、人工复核、通知、恢复、审计查询）。
- `src/http/app.js`、`src/server.js`：零依赖 HTTP API 与启动入口。
- `fixtures/`：山脊路线样例与预报修订样例；`scripts/demo.mjs` 端到端演示；`test/` 27 项测试。

## 运行

```bash
npm test          # 全部测试（领域规则 / 编排 / 崩溃恢复 / HTTP）
npm run demo      # 端到端演示（重算、冻结升级、矛盾、幂等、人工复核）
npm start         # HTTP 服务，默认 :3000（PORT / LOG_FILE 可覆盖）
```

## API

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/routes` | 注册路线（分段+海拔，扩展字段保留） |
| POST | `/forecasts` | 接入预报/修订（支持 `Idempotency-Key`），自动触发重算级联 |
| POST | `/trips` | 排行程（成员+耐受+逐段进出时间），立即返回初始结论 |
| GET | `/trips` / `/trips/:id` | 列表 / 详情（当前结论、冻结结论、版本链、升级、复核、通知） |
| POST | `/trips/:id/check-in` | 签到出发，冻结当前结论 |
| POST | `/trips/:id/complete` | 行程结束 |
| POST | `/trips/:id/recalculate` | 手动重算（未出发；幂等） |
| POST | `/trips/:id/reviews` | 领队申请人工复核 `{by, reason}` |
| POST | `/trips/:id/reviews/resolve` | 值班员裁定 `{verdict, by, note}` |
| GET | `/trips/:id/audit` | 完整审计事件流 |
| GET | `/decisions/:decisionId` | 单条结论全文（逐路段/逐小时证据、预报版本、缺测、冲突） |

预报 `values` 支持逐时对象（`{"2026-10-04T07:00:00+08:00": 72}`）或整段窗口标量；累计量（降水）按暴露时长比例分摊，缺测小时直接省略即可，系统会按缺测识别。
