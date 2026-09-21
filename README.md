# 山径气象窗口放行服务

在徒步俱乐部值班场景下，把**路线分段限制、成员耐受能力、逐时预报及其修订版本**汇成
带完整依据的放行结论。核心保证：

- **可重复计算**：结论由纯函数 `evaluateTrip` 产生（不读系统时间、无 I/O），每次结论保存
  全部规范化输入快照与 `inputFingerprint`（SHA-256），可随时重放核对。
- **修订触发重算**：更正预报到达后，尚未出发的行程自动用当前预报全集重算；旧结论版本
  原样保留并标记被哪个版本取代（`supersededBy`）。
- **出发后只升级、不改写**：队伍签到后，新预报只能追加风险升级（只升不降）和领队通知，
  原自动结论与人工裁决永不被静默修改。
- **矛盾、缺测、跨午夜都有明确结果**：见下文判定语义。
- **审计可追溯**：所有写操作进入只追加的 SHA-256 哈希链日志（`data/audit.log`），
  任何删改都会在 `GET /audit/verify` 断链；重启后从磁盘完整恢复。
- **重复投递幂等**：相同预报事件重复投递不产生新版本；写接口支持 `Idempotency-Key` 头。
- **未知扩展字段保留**：预报信封沿用 `parseForecastRevision` 的 `attributes` 约定，
  路线、路段、成员、预报上的未知字段全部原样保留并随版本快照留存。

## 判定语义

每个路段按计划窗口展开为整点小时槽（支持跨午夜；区间为 `[validFrom, validTo)`），
逐因子（阵风 `windGustKph`、能见度 `visibilityM`、降水 `precipitationMm`）汇总各来源
**生效修订版本**（同一来源取覆盖该槽的最高 `revision`，平局依次取最大 `issuedAt`、`eventId`）：

| 情形 | 结果 |
| --- | --- |
| 各来源观测均在限制内 | `GO`（来源差值超阈值时附 `SOURCE_CONFLICT` 提示，但不改变结论） |
| 连最安全来源都超限（所有来源一致确认） | `HOLD`，`CONSISTENT_BREACH` |
| 保守包络（最坏值）超限，但存在更安全读数（来源互相矛盾） | `MANUAL_REVIEW`，`MIXED_BREACH` |
| 受约束因子在任一计划小时槽缺测（含无来源覆盖、值为 null、逐时缺槽） | `MANUAL_REVIEW`，`DATA_GAP` |
| 没有任何路段限制或成员耐受约束该因子 | 缺测/矛盾均不影响放行 |

适用阈值取路段限制与全部成员个人耐受中**最保守**者（阵风/降水取最小 max，能见度取最大 min）。
严重度按最坏值/阈值之比给 `ELEVATED / HIGH / CRITICAL`。

出发后升级等级：一致超限按幅度定级；矛盾最坏包络超限为 `HIGH`；仅缺测为 `ELEVATED`；
只升不降。人工复核：`PENDING` 时生效状态为 `MANUAL_REVIEW`，值班员裁决 `GO/HOLD` 后
生效状态采用裁决值，自动结论仍原样保留。

## 运行

需要 Node.js >= 20，零第三方依赖。

```bash
npm test          # 20 个测试：纯函数、服务联动、HTTP 端到端、审计篡改
npm run seed      # 写入 fixtures 中的山脊路线、2 名成员、两条相互矛盾的预报
npm start         # 默认 http://localhost:3000；DATA_DIR=data，可用环境变量覆盖
PORT=3120 DATA_DIR=/var/lib/trail npm start
```

## API

所有时间使用带时区偏移的 ISO 8601。写接口可带 `Idempotency-Key`：同键同体重放首次响应，
同键异体返回 409。

| 方法与路径 | 说明 |
| --- | --- |
| `POST /routes` | 登记/更新路线（分段 `plannedStart/plannedEnd/limits`，未知字段保留） |
| `GET /routes`、`GET /routes/:routeId` | 查询路线 |
| `POST /members` | 登记成员及个人耐受 `{tolerance:{windGustKph:{max},visibilityM:{min}}}` |
| `GET /members`、`GET /members/:memberId` | 查询成员 |
| `POST /forecasts` | 投递预报修订信封（同 `parseForecastRevision` 契约；`values` 支持数字、`null` 缺测或逐时对象）。入库后自动联动重算/升级 |
| `POST /trips` | 创建行程 `{tripId?,routeId,memberIds}`，立即返回首版结论 |
| `GET /trips`、`GET /trips/:tripId` | 行程列表 / 当前结论版本 |
| `GET /trips/:tripId/versions` | 该行程的完整版本链（旧结论、取代关系） |
| `GET /versions/:versionId` | 取任意历史版本（含出发后升级与通知） |
| `GET /versions/:versionId/verify` | 用版本快照重放纯函数，核对结果与输入指纹 |
| `POST /trips/:tripId/recompute` | 手动重算（已出发返回 409 `ALREADY_DEPARTED`） |
| `POST /trips/:tripId/check-in` | 领队签到出发 `{by,at?}`；记录出发时结论 |
| `POST /trips/:tripId/reviews` | 申请人工复核 `{by,reason}` |
| `POST /trips/:tripId/reviews/resolve` | 值班员裁决 `{by,decision:"GO"|"HOLD",note?}` |
| `GET /audit` | 哈希链审计条目（含每版采用的预报事件与触发路段） |
| `GET /audit/verify` | 校验审计链完整性 |

结论对象的关键字段：

- `automatedStatus`：纯函数自动结论（`GO/MANUAL_REVIEW/HOLD`）；`effectiveStatus`：叠加人工复核后的生效状态。
- `triggeredSegmentIds`：触发限制的路段；`restrictions[]`：每条限制的因子、阈值来源、
  越界小时槽、各来源读数与采用的事件版本。
- `forecastBasis.usedEventIds` / `.bySlot`：本次结论每个计划小时槽、每个来源实际采用了
  哪个预报事件的哪个 revision；`consideredEvents`：全部在库候选事件。
- `escalations[]` / `notifications[]`：出发后的风险升级与领队通知（追加，不回改）。
- `inputFingerprint`：规范化输入的 SHA-256；策略常量版本见 `automatedStatus` 同层 `policyVersion`。

## 典型时序（对应 fixtures）

1. `npm run seed` 后创建 `ridge-west-17` 行程：早晨 r1（安全）与山脊站 r2（锋面提前）矛盾 → `MANUAL_REVIEW`。
2. 值班员裁决 GO、领队签到出发。
3. 投递 `fixtures/forecast-revision.json`（regional r3，阵风 72、能见度 180）：r3 取代同源 r1，
   两来源一致确认高海拔刃脊超限 → 追加 `CRITICAL` 升级与领队通知，seq=1 的原结论保持不变。
4. 重启服务后结论、升级、审计链完全一致；重复投递 r3 返回 `duplicate:true`，不产生任何新记录。

## 目录

- `src/forecast-contract.js`：既有预报信封契约（保持不变）。
- `src/domain/`：时间/规范化、校验、预报入库、策略常量与纯函数评估引擎。
- `src/service/decision-service.js`：版本链、自动重算、出发后升级、人工复核、幂等编排。
- `src/store/`：原子写 JSON 持久化与哈希链审计日志。
- `src/http/`、`src/server.js`：零依赖 HTTP API。
- `fixtures/`：山脊路线、成员、预报样例；`scripts/seed.mjs` 播种脚本。
