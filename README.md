# 门店应急调拨 JSON API

本地运行的门店应急调拨管理系统，使用 **SQLite**（`data/allocation.db`）持久化保存用户、门店、商品、库存、调拨单和追加式操作历史。支持"提交-复核-审批-出库"全链路流程，服务重启后所有数据不丢失。

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
| history | 追加式操作历史（每条状态变更单独一行） |

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

## 业务流程状态机

```
pending（待复核）
  ├── reviewed（已复核） ──┐
  │           └── approved（已审批/已锁定） ── shipped（已出库）
  ├── rejected（已驳回）
  └── withdrawn（已撤回）
```

## 完整链路 Demo：提交 → 复核 → 审批 → 出库

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

## 错误场景验证

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
```

可使用自动化脚本一键验证：

```powershell
node verify-flow.js      # 跑通完整链路并保存快照
# 重启服务后
node verify-restart.js   # 对比重启前后数据一致性
```

轻量回归：

```powershell
node check-readme.js     # 检查 README 非空、无 ^ 续行符、--% 转义正确
node smoke-test.js       # 跑主流程 + 申请人自审错误场景
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
| GET | /api/history | 操作历史（支持筛选） |
| GET | /api/audit | 审计查询（支持筛选） |
