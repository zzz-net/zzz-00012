# 门店应急调拨 JSON API

本地运行的门店应急调拨管理系统，使用 **SQLite**（`data/allocation.db`）持久化保存用户、门店、商品、库存、调拨单和追加式操作历史。支持"提交-复核-审批-出库"全链路流程，同时包含库存盘点和差异调账模块，服务重启后所有数据不丢失。

## 快速启动

```bash
npm install
npm start
```

服务默认运行在 `http://localhost:3000`。首次启动会自动初始化样例数据到 SQLite。

手动重置数据（会覆盖现有数据）：

```bash
npm run init
```

健康检查：

```powershell
curl.exe -s http://localhost:3000/api/health
```

> Windows PowerShell 使用说明：
> - 必须使用 `curl.exe`（不是 PowerShell 的 `curl` 别名，它是 Invoke-WebRequest）
> - POST 请求使用 `--%` 停止 PowerShell 解析，JSON 双引号内用 `\\"` 转义
> - 所有示例均为**单行**，可直接复制粘贴到 PowerShell 执行

## 数据存储

所有业务数据保存在 `data/allocation.db`（SQLite 数据库），包含以下表：

| 表 | 说明 |
|----|------|
| users | 用户（id, name, role, store） |
| stores | 门店（id, name） |
| products | 商品（id, name） |
| inventory | 库存（store, product, qty） |
| allocations | 调拨单（含内嵌 history JSON） |
| history | 调拨追加式操作历史（每条状态变更单独一行） |
| stocktake_batches | 盘点批次（id, store, status, created/confirmed/withdrawn 信息） |
| stocktake_items | 盘点明细（batchId, product, actualQty） |
| stocktake_adjustments | 差异调账记录（含账面、锁定、实盘、差异、新账面） |
| stocktake_history | 盘点追加式审计日志（created/item_add/item_update/confirmed/withdrawn） |

## 预置样例数据

### 角色 & 用户

| 用户ID | 姓名 | 角色 | 所属门店 |
|--------|------|------|----------|
| u_store_a | 门店A店员张三 | store_user | store_a |
| u_store_b | 门店B店员李四 | store_user | store_b |
| u_warehouse | 库管王五 | warehouse | - |
| u_manager | 区域经理赵六 | manager | - |

查看所有用户：

```powershell
curl.exe -s http://localhost:3000/api/users
```

### 门店

| 门店ID | 名称 |
|--------|------|
| store_a | 门店A（望京店） |
| store_b | 门店B（国贸店） |
| store_c | 门店C（三里屯店） |

### 商品

| 商品ID | 名称 |
|--------|------|
| p_umbrella | 应急雨伞 |
| p_water | 瓶装矿泉水 |
| p_mask | 防护口罩 |
| p_firstaid | 急救包 |

### 初始库存

查看库存（含总库存 qty、已锁定 lockedQty、可用 availableQty）：

```powershell
curl.exe -s http://localhost:3000/api/inventory
```

## 调拨业务流程状态机

```
pending（待复核）
  ├── reviewed（已复核） ──┐
  │           └── approved（已审批/已锁定） ── shipped（已出库）
  ├── rejected（已驳回）
  └── withdrawn（已撤回）
```

## 调拨完整链路 Demo：提交 → 复核 → 审批 → 出库

下面以 **门店B（国贸店）紧急向门店A（望京店）调拨 15 把雨伞** 为例演示完整流程。每条命令均为单行，可直接复制到 PowerShell 执行。

### 1. 门店B店员提交调拨申请

```powershell
curl.exe --% -s -X POST http://localhost:3000/api/allocations -H "Content-Type: application/json" -d "{\"sourceStore\":\"store_a\",\"targetStore\":\"store_b\",\"product\":\"p_umbrella\",\"qty\":15,\"reason\":\"突降暴雨，门店B雨伞售罄，顾客大量需求\",\"operator\":\"u_store_b\"}"
```

返回 `201 Created`，状态为 `pending`。记下返回的 `id`（例如 `alloc_002`），后续步骤需要使用。

以下命令使用 `alloc_002`，请替换为实际返回的 ID。

### 2. 库管复核库存

```powershell
curl.exe --% -s -X POST http://localhost:3000/api/allocations/alloc_002/review -H "Content-Type: application/json" -d "{\"operator\":\"u_warehouse\"}"
```

状态变为 `reviewed`。

### 3. 区域经理审批（通过后锁定库存）

```powershell
curl.exe --% -s -X POST http://localhost:3000/api/allocations/alloc_002/approve -H "Content-Type: application/json" -d "{\"operator\":\"u_manager\"}"
```

状态变为 `approved`，此时门店A的雨伞库存中 15 把被锁定。可通过 `/api/inventory` 查看 `lockedQty` 和 `availableQty` 变化（总库存不变）。

### 4. 出库确认（真正扣减库存）

```powershell
curl.exe --% -s -X POST http://localhost:3000/api/allocations/alloc_002/ship -H "Content-Type: application/json" -d "{\"operator\":\"u_warehouse\"}"
```

状态变为 `shipped`，门店A库存 -15，门店B库存 +15，锁定释放。

### 5. 审计查询

查询所有已出库的调拨单：

```powershell
curl.exe -s "http://localhost:3000/api/audit?status=shipped"
```

按门店和商品组合查询：

```powershell
curl.exe -s "http://localhost:3000/api/audit?sourceStore=store_a&product=p_umbrella"
```

## 调拨错误场景验证

所有错误都会返回清晰的错误码和消息，且 **不修改任何数据**（SQLite 事务回滚或根本不写入）。

### ❌ 申请人自审（复核自己的申请）

```powershell
curl.exe --% -s -X POST http://localhost:3000/api/allocations/alloc_002/review -H "Content-Type: application/json" -d "{\"operator\":\"u_store_b\"}"
```

预期返回：`400 {"error":"SELF_REVIEW","message":"申请人不能复核自己的申请"}`

验证：再查询该调拨单，状态仍为原值，库存和历史记录均不变。

```powershell
curl.exe -s http://localhost:3000/api/allocations/alloc_002
```

### ❌ 未复核直接审批

新建一个申请（跳过复核步骤）：

```powershell
curl.exe --% -s -X POST http://localhost:3000/api/allocations -H "Content-Type: application/json" -d "{\"sourceStore\":\"store_c\",\"targetStore\":\"store_b\",\"product\":\"p_water\",\"qty\":10,\"reason\":\"测试未复核审批\",\"operator\":\"u_store_b\"}"
```

假设返回 ID 为 `alloc_003`，直接审批：

```powershell
curl.exe --% -s -X POST http://localhost:3000/api/allocations/alloc_003/approve -H "Content-Type: application/json" -d "{\"operator\":\"u_manager\"}"
```

预期返回：`400 {"error":"NOT_REVIEWED","message":"未复核的申请不能直接审批，必须先由库管复核"}`

验证：调拨单状态仍为 `pending`，无历史记录追加。

```powershell
curl.exe -s http://localhost:3000/api/allocations/alloc_003
```

### ❌ 库存被其他已批申请占用

先创建一个申请并审批，占满门店A的雨伞可用库存：

```powershell
curl.exe --% -s -X POST http://localhost:3000/api/allocations -H "Content-Type: application/json" -d "{\"sourceStore\":\"store_a\",\"targetStore\":\"store_b\",\"product\":\"p_umbrella\",\"qty\":15,\"reason\":\"占满可用库存\",\"operator\":\"u_store_b\"}"
```

假设 ID 为 `alloc_004`，复核并审批：

```powershell
curl.exe --% -s -X POST http://localhost:3000/api/allocations/alloc_004/review -H "Content-Type: application/json" -d "{\"operator\":\"u_warehouse\"}"
```

```powershell
curl.exe --% -s -X POST http://localhost:3000/api/allocations/alloc_004/approve -H "Content-Type: application/json" -d "{\"operator\":\"u_manager\"}"
```

此时门店A雨伞可用库存接近 0。再新建一个超过可用量的申请：

```powershell
curl.exe --% -s -X POST http://localhost:3000/api/allocations -H "Content-Type: application/json" -d "{\"sourceStore\":\"store_a\",\"targetStore\":\"store_b\",\"product\":\"p_umbrella\",\"qty\":20,\"reason\":\"测试库存被占用\",\"operator\":\"u_store_b\"}"
```

假设 ID 为 `alloc_005`，复核时会失败：

```powershell
curl.exe --% -s -X POST http://localhost:3000/api/allocations/alloc_005/review -H "Content-Type: application/json" -d "{\"operator\":\"u_warehouse\"}"
```

预期返回：`400 {"error":"INSUFFICIENT_AVAILABLE","message":"来源门店可用库存不足，当前可用 X，需要 20"}`

验证：调拨单仍为 `pending`，总库存和可用量均不变。

```powershell
curl.exe -s http://localhost:3000/api/inventory
```

### ❌ 已撤回的调拨单不能出库

先创建一个新申请，审批后撤回，再尝试出库：

```powershell
curl.exe --% -s -X POST http://localhost:3000/api/allocations -H "Content-Type: application/json" -d "{\"sourceStore\":\"store_c\",\"targetStore\":\"store_b\",\"product\":\"p_mask\",\"qty\":10,\"reason\":\"测试撤回后出库\",\"operator\":\"u_store_b\"}"
```

假设 ID 为 `alloc_006`，依次执行：

```powershell
curl.exe --% -s -X POST http://localhost:3000/api/allocations/alloc_006/review -H "Content-Type: application/json" -d "{\"operator\":\"u_warehouse\"}"
```

```powershell
curl.exe --% -s -X POST http://localhost:3000/api/allocations/alloc_006/approve -H "Content-Type: application/json" -d "{\"operator\":\"u_manager\"}"
```

```powershell
curl.exe --% -s -X POST http://localhost:3000/api/allocations/alloc_006/withdraw -H "Content-Type: application/json" -d "{\"operator\":\"u_store_b\",\"remark\":\"不需要了\"}"
```

```powershell
curl.exe --% -s -X POST http://localhost:3000/api/allocations/alloc_006/ship -H "Content-Type: application/json" -d "{\"operator\":\"u_warehouse\"}"
```

最后一步预期返回：`400 {"error":"WITHDRAWN_CANNOT_SHIP","message":"已撤回的调拨单不能出库"}`

验证：门店C的口罩库存未扣减，门店B也未增加，调拨单状态保持 `withdrawn`。

```powershell
curl.exe -s http://localhost:3000/api/inventory
curl.exe -s http://localhost:3000/api/allocations/alloc_006
```

## 库存盘点 & 差异调账模块

库管可以按门店发起盘点批次，录入商品实盘数量，系统自动计算账面数量、已锁定数量、可调数量和差异。区域经理确认后才能生成调账记录，实际库存只按差异修正。

### 角色权限

| 角色 | 查看盘点 | 创建批次 | 录入明细 | 确认调账 | 撤销批次 |
|------|----------|----------|----------|----------|----------|
| store_user | 仅自己门店 | 否 | 否 | 否 | 否 |
| warehouse | 全部门店 | 是 | 是 | 否 | 是（仅未确认） |
| manager | 全部门店 | 否 | 否 | 是 | 否 |

### 盘点状态机

```
pending（待确认）
  ├── confirmed（已确认/已调账）
  └── withdrawn（已撤销）
```

### 完整链路 Demo：创建批次 → 录入明细 → 经理确认调账

下面以 **门店C（三里屯店）月末盘点** 为例演示完整流程。

#### 1. 库管创建盘点批次

```powershell
curl.exe --% -s -X POST http://localhost:3000/api/stocktake -H "Content-Type: application/json" -d "{\"store\":\"store_c\",\"remark\":\"门店C月末盘点\",\"operator\":\"u_warehouse\"}"
```

返回 `201 Created`，状态为 `pending`。记下返回的 `id`（例如 `stocktake_002`），后续步骤需要使用。

#### 2. 库管录入商品实盘数量（可重复调用，同一商品会覆盖）

录入雨伞，实盘 25（账面 30，差异 -5）：

```powershell
curl.exe --% -s -X POST http://localhost:3000/api/stocktake/stocktake_002/items -H "Content-Type: application/json" -d "{\"product\":\"p_umbrella\",\"actualQty\":25,\"operator\":\"u_warehouse\"}"
```

录入矿泉水，实盘 160（账面 150，差异 +10）：

```powershell
curl.exe --% -s -X POST http://localhost:3000/api/stocktake/stocktake_002/items -H "Content-Type: application/json" -d "{\"product\":\"p_water\",\"actualQty\":160,\"operator\":\"u_warehouse\"}"
```

每次录入返回实时计算的字段：`bookQty`（账面）、`lockedQty`（已锁定）、`availableAfter`（调账后可用）、`diffQty`（差异 = 实盘 - 账面）。

#### 3. 查看盘点批次详情

```powershell
curl.exe -s "http://localhost:3000/api/stocktake/stocktake_002?operator=u_warehouse"
```

返回包含所有明细、差异汇总、操作历史。

#### 4. 区域经理确认（生成调账记录并修正库存）

```powershell
curl.exe --% -s -X POST http://localhost:3000/api/stocktake/stocktake_002/confirm -H "Content-Type: application/json" -d "{\"operator\":\"u_manager\"}"
```

状态变为 `confirmed`，库存按差异修正（雨伞 30→25，矿泉水 150→160），每条商品生成一条调账记录。

#### 5. 查询调账记录

```powershell
curl.exe -s "http://localhost:3000/api/stocktake-adjustments?batchId=stocktake_002"
```

#### 6. 查询盘点审计日志

```powershell
curl.exe -s "http://localhost:3000/api/stocktake-history?operator=u_warehouse"
```

### 门店用户权限测试（仅能看自己门店）

门店A店员查看盘点列表，只能看到 store_a 的：

```powershell
curl.exe -s "http://localhost:3000/api/stocktake?operator=u_store_a"
```

门店A店员尝试查看门店B的盘点详情（stocktake_001），被拒绝：

```powershell
curl.exe -s "http://localhost:3000/api/stocktake/stocktake_001?operator=u_store_a"
```

预期返回：`403 {"error":"STOCKTAKE_STORE_FORBIDDEN","message":"门店用户只能查看自己门店的盘点结果"}`

门店A店员尝试创建盘点批次，被拒绝：

```powershell
curl.exe --% -s -X POST http://localhost:3000/api/stocktake -H "Content-Type: application/json" -d "{\"store\":\"store_a\",\"operator\":\"u_store_a\"}"
```

预期返回：`403 {"error":"STOCKTAKE_ROLE_FORBIDDEN","message":"该用户角色无权限执行此盘点操作"}`

### 错误场景：调拨锁库冲突拦截

当门店存在**已审批未出库**的调拨单占用库存时，盘点确认会阻止会让可用库存变负的调账。

先在门店A创建并审批一个调拨单，锁定 25 把雨伞：

```powershell
curl.exe --% -s -X POST http://localhost:3000/api/allocations -H "Content-Type: application/json" -d "{\"sourceStore\":\"store_a\",\"targetStore\":\"store_b\",\"product\":\"p_umbrella\",\"qty\":25,\"reason\":\"测试盘点冲突\",\"operator\":\"u_store_b\"}"
```

假设返回 ID 为 `alloc_xxx`，执行复核和审批：

```powershell
curl.exe --% -s -X POST http://localhost:3000/api/allocations/alloc_xxx/review -H "Content-Type: application/json" -d "{\"operator\":\"u_warehouse\"}"
```

```powershell
curl.exe --% -s -X POST http://localhost:3000/api/allocations/alloc_xxx/approve -H "Content-Type: application/json" -d "{\"operator\":\"u_manager\"}"
```

此时门店A雨伞已锁定 25，账面 30，可用 5。

创建一个门店A的盘点批次，把雨伞实盘录为 20（调账后账面 20，锁定 25，可用为 -5）：

```powershell
curl.exe --% -s -X POST http://localhost:3000/api/stocktake -H "Content-Type: application/json" -d "{\"store\":\"store_a\",\"remark\":\"测试锁库冲突\",\"operator\":\"u_warehouse\"}"
```

假设批次 ID 为 `stocktake_yyy`：

```powershell
curl.exe --% -s -X POST http://localhost:3000/api/stocktake/stocktake_yyy/items -H "Content-Type: application/json" -d "{\"product\":\"p_umbrella\",\"actualQty\":20,\"operator\":\"u_warehouse\"}"
```

```powershell
curl.exe --% -s -X POST http://localhost:3000/api/stocktake/stocktake_yyy/confirm -H "Content-Type: application/json" -d "{\"operator\":\"u_manager\"}"
```

预期返回：`400 {"error":"STOCKTAKE_NEGATIVE_AVAILABLE", ...}`，包含 `conflicts` 数组，详细说明哪个商品调账后可用为负。此时库存未修改，批次状态仍为 `pending`。

### 错误场景：库管撤销未确认批次

先创建一个未确认的盘点批次：

```powershell
curl.exe --% -s -X POST http://localhost:3000/api/stocktake -H "Content-Type: application/json" -d "{\"store\":\"store_c\",\"remark\":\"测试撤销\",\"operator\":\"u_warehouse\"}"
```

假设 ID 为 `stocktake_zzz`，录入一项后撤销：

```powershell
curl.exe --% -s -X POST http://localhost:3000/api/stocktake/stocktake_zzz/items -H "Content-Type: application/json" -d "{\"product\":\"p_mask\",\"actualQty\":190,\"operator\":\"u_warehouse\"}"
```

```powershell
curl.exe --% -s -X POST http://localhost:3000/api/stocktake/stocktake_zzz/withdraw -H "Content-Type: application/json" -d "{\"operator\":\"u_warehouse\",\"remark\":\"录错了，重新盘点\"}"
```

状态变为 `withdrawn`，撤销和确认操作都会写入追加式审计日志（`stocktake_history`）。

### 盘点错误码说明

| 错误码 | 说明 |
|--------|------|
| STOCKTAKE_NOT_FOUND | 盘点批次不存在 |
| STOCKTAKE_ROLE_FORBIDDEN | 角色无权限执行此盘点操作 |
| STOCKTAKE_STORE_FORBIDDEN | 门店用户只能查看自己门店的盘点结果 |
| STOCKTAKE_NOT_PENDING | 批次不是 pending 状态，不能修改/确认/撤销 |
| STOCKTAKE_EMPTY | 批次没有录入任何明细，无法确认 |
| STOCKTAKE_NEGATIVE_AVAILABLE | 调账后会导致可用库存为负（与已审批未出库调拨冲突） |

## SQLite 持久化验证

完成上述操作后：

1. 停止服务（Ctrl+C）
2. 确认 `data/allocation.db` 文件存在且大小 > 0
3. 重新启动服务 `npm start`
4. 查询库存、调拨单和历史，数据应与停止前完全一致：

```powershell
curl.exe -s http://localhost:3000/api/inventory
curl.exe -s http://localhost:3000/api/allocations
curl.exe -s http://localhost:3000/api/history
curl.exe -s http://localhost:3000/api/stocktake
curl.exe -s http://localhost:3000/api/stocktake-adjustments
curl.exe -s http://localhost:3000/api/stocktake-history
```

可使用自动化脚本一键验证：

```powershell
node verify-flow.js
node verify-restart.js

node verify-stocktake.js
node verify-stocktake.js --check-restart
```

轻量回归：

```powershell
node check-readme.js
node smoke-test.js
```

## 审计查询接口

`GET /api/audit` 支持按来源门店、目标门店、商品、状态筛选，返回带名称的详细信息和完整状态历史。

按来源门店查询：

```powershell
curl.exe -s "http://localhost:3000/api/audit?sourceStore=store_a"
```

按状态筛选已出库：

```powershell
curl.exe -s "http://localhost:3000/api/audit?status=shipped"
```

按商品筛选：

```powershell
curl.exe -s "http://localhost:3000/api/audit?product=p_umbrella"
```

组合筛选：

```powershell
curl.exe -s "http://localhost:3000/api/audit?sourceStore=store_a&status=approved"
```

`GET /api/history` 支持按 operator、status 筛选，以及通过 sourceStore/targetStore/product 关联调拨单过滤：

```powershell
curl.exe -s "http://localhost:3000/api/history?operator=u_manager"
curl.exe -s "http://localhost:3000/api/history?status=approved"
curl.exe -s "http://localhost:3000/api/history?sourceStore=store_a&product=p_umbrella"
```

## API 列表

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /api/health | 健康检查 |
| GET | /api/users | 用户列表 |
| GET | /api/stores | 门店列表 |
| GET | /api/products | 商品列表 |
| GET | /api/inventory | 库存列表（含 total/locked/available） |
| GET | /api/allocations | 所有调拨单 |
| GET | /api/allocations/:id | 单个调拨单详情 |
| POST | /api/allocations | 提交调拨申请（门店用户） |
| POST | /api/allocations/:id/review | 库管复核 |
| POST | /api/allocations/:id/approve | 区域经理审批（锁定库存） |
| POST | /api/allocations/:id/ship | 出库确认（扣减库存） |
| POST | /api/allocations/:id/reject | 驳回申请 |
| POST | /api/allocations/:id/withdraw | 撤回申请 |
| GET | /api/history | 调拨操作历史（支持筛选） |
| GET | /api/audit | 调拨审计查询（支持筛选） |
| GET | /api/stocktake | 盘点批次列表（门店用户自动过滤自己门店） |
| GET | /api/stocktake/:id | 单个盘点批次详情（含明细、差异、调账记录） |
| POST | /api/stocktake | 库管创建盘点批次 |
| POST | /api/stocktake/:id/items | 库管录入/更新商品实盘数量 |
| POST | /api/stocktake/:id/confirm | 区域经理确认（生成调账，修正库存） |
| POST | /api/stocktake/:id/withdraw | 库管撤销未确认批次 |
| GET | /api/stocktake-adjustments | 差异调账记录（支持按门店/商品/batchId 筛选） |
| GET | /api/stocktake-history | 盘点审计日志（支持按 batchId/operator/action 筛选） |
