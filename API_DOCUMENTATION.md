# Jarvis 3.0 — Backend API Documentation

**Base URL:** `http://localhost:<PORT>/api/v2`

**Stack:** Node.js · Express · MongoDB (Mongoose)

---

## Authentication

JWT-based authentication. On login, a token is returned in the response body. Protected routes expect the token in a cookie named `token`.

> **Note:** Most routes in the current codebase have authentication middleware (`isAuthenticated`) commented out. Only `/user/all-users` actively enforces authentication.

Token payload:
```json
{ "userid": "<id>", "username": "<name>", "role": "<role>" }
```
Token expiry: **24 hours**. Secret: hardcoded as `"anuTapes"` (move to env in production).

---

## Standard Response Format

**Success:**
```json
{ "success": true, "data": ... }
```

**Error:**
```json
{ "success": false, "message": "Human-readable error" }
```

---

## Table of Contents

1. [User](#1-user)
2. [Machine](#2-machine)
3. [Shift](#3-shift)
4. [Employee](#4-employee)
5. [Customer](#5-customer)
6. [Supplier & Purchase Orders](#6-supplier--purchase-orders)
7. [Raw Materials](#7-raw-materials)
8. [Elastic](#8-elastic)
9. [Order](#9-order)
10. [Job Order](#10-job-order)
11. [Warping](#11-warping)
12. [Covering](#12-covering)
13. [Packing](#13-packing)
14. [Production](#14-production)
15. [Wastage](#15-wastage)

---

## 1. User

**Base path:** `/api/v2/user`

### POST `/sign-up`
Create a new user account.

**Body:**
```json
{ "name": "string", "email": "string", "password": "string", "role": "string" }
```

**Response `200`:**
```json
{ "success": true, "user": { ...userObject } }
```

---

### POST `/login-user`
Authenticate a user and receive a JWT token.

**Body:**
```json
{ "email": "string", "password": "string" }
```

**Response `201`:**
```json
{
  "username": "string",
  "id": "<userId>",
  "role": "string",
  "token": "<jwt>"
}
```

**Errors:** `400` if email/password missing or user not found.

---

### GET `/getuser`
Get the currently authenticated user's profile.

**Response `200`:**
```json
{ "success": true, "user": { ...userObject } }
```

---

### GET `/all-users` 🔒
Get all admin users. Requires `isAuthenticated`.

**Response `200`:**
```json
{ "success": true, "users": [ ...adminUsers ] }
```

---

### GET `/logout`
Clear the auth cookie and log out.

**Response `201`:**
```json
{ "success": true, "message": "Log out successful!" }
```

---

## 2. Machine

**Base path:** `/api/v2/machine`

### POST `/create-machine`
Register a new machine.

**Body:**
| Field | Type | Required |
|---|---|---|
| `ID` | string | Yes |
| `manufacturer` | string | Yes |
| `NoOfHead` | number (≥1) | Yes |
| `NoOfHooks` | number (≥1) | Yes |
| `DateOfPurchase` | date | No |

**Response `201`:**
```json
{ "success": true, "machine": { ...machineObject } }
```

**Errors:** `409` if machine ID already exists.

---

### GET `/get-machines`
List all machines with optional status filter.

**Query params:**
| Param | Values |
|---|---|
| `status` | `free` \| `running` \| `maintenance` |

**Response `200`:**
```json
{ "success": true, "machines": [ ...machines ] }
```

---

### GET `/get-machine-detail`
Get full machine detail with last 10 shifts and efficiency stats.

**Query params:** `id=<machineId>`

**Response `200`:**
```json
{
  "success": true,
  "machine": {
    "id": "string",
    "status": "free|running|maintenance",
    "manufacturer": "string",
    "heads": 4,
    "hooks": 8,
    "dateOfPurchase": "date|null",
    "currentJobNo": "string|null",
    "elastics": [],
    "result": [
      {
        "id": "<shiftDetailId>",
        "date": "date",
        "shift": "DAY|NIGHT",
        "employee": "string",
        "runtimeMinutes": 480,
        "outputMeters": 120,
        "efficiency": 66.67
      }
    ]
  }
}
```

---

### GET `/free`
List all machines with status `free`.

**Response `200`:**
```json
{ "success": true, "count": 3, "machines": [ ...machines ] }
```

---

### GET `/running-machines`
List all machines currently `running`, with their assigned job order.

**Response `200`:**
```json
{
  "success": true,
  "data": [
    {
      "machineId": "<id>",
      "machineCode": "LOOM-01",
      "ID": "LOOM-01",
      "manufacturer": "string",
      "noOfHeads": 4,
      "jobOrderNo": "1001",
      "elastics": []
    }
  ]
}
```

---

### PUT `/updateOrder`
Update the elastic head assignments on a machine.

**Body:**
```json
{ "id": "<machineId or Machine.ID string>", "elastics": [ ...elasticHeadArray ] }
```

**Response `200`:**
```json
{ "success": true, "data": "<machineMongoId>" }
```

---

### PATCH `/status`
Update machine status to `free` or `maintenance`.

> To set status to `running`, use `POST /job/plan-weaving`.

**Body:**
```json
{ "id": "<machineId>", "status": "free|maintenance" }
```

**Response `200`:**
```json
{ "success": true, "machine": { "_id": "...", "ID": "...", "status": "..." } }
```

---

## 3. Shift

**Base path:** `/api/v2/shift`

### POST `/create-shift-plan`
Create a DAY or NIGHT shift plan for a date, assigning machines, operators, and job orders.

**Body:**
```json
{
  "date": "ISO date string",
  "shiftType": "DAY|NIGHT",
  "description": "optional string",
  "machines": [
    {
      "machine": "<machineId>",
      "operator": "<employeeId>",
      "jobOrderNo": 1001
    }
  ]
}
```

**Response `201`:**
```json
{
  "success": true,
  "message": "DAY shift plan created successfully",
  "data": { "_id": "...", "date": "...", "shift": "DAY", "machineCount": 3 }
}
```

**Errors:** `409` if a plan already exists for that date/shift combination.

---

### GET `/today`
Get DAY and NIGHT shift plans for today.

**Response `200`:**
```json
{
  "success": true,
  "data": {
    "dayShift":   { "id": "...", "shift": "DAY", "production": 240, "machinesRunning": 4, "operatorCount": 4, "plan": [ ... ] },
    "nightShift": { ...same shape or "status": "not_created" }
  }
}
```

---

### GET `/shiftPlanToday`
Get shift plans for a specific date.

**Query params:** `date=<ISO date>`

**Response `200`:**
```json
{ "success": true, "shifts": [ ...shiftPlans ] }
```

---

### GET `/shiftPlanById`
Get detailed shift plan by ID, including per-machine production summary.

**Query params:** `id=<shiftPlanId>`

**Response `200`:**
```json
{
  "success": true,
  "data": {
    "_id": "...",
    "date": "...",
    "shift": "DAY",
    "description": "...",
    "totalProduction": 480,
    "operatorCount": 4,
    "machines": [
      {
        "machineId": "...",
        "machineName": "LOOM-01",
        "jobOrderNo": "1001",
        "operatorName": "John",
        "production": 120,
        "timer": "06:00",
        "status": "closed"
      }
    ]
  }
}
```

---

### GET `/shiftPLan`
Get a shift plan with its full populated details.

**Query params:** `id=<shiftPlanId>`

**Response `200`:**
```json
{ "success": true, "shift": { ...populatedShiftPlan } }
```

---

### GET `/get-in-range`
Get total production per date for a date range.

**Query params:** `start=YYYY-MM-DD&less=YYYY-MM-DD`

**Response `200`:**
```json
{ "success": true, "array": [ { "date": "01-01-2025", "production": 480 } ] }
```

---

### POST `/enter-shift-production`
Record production output for a shift detail entry (closes the shift).

**Body:**
```json
{
  "id": "<shiftDetailId>",
  "production": 120,
  "timer": "06:00",
  "feedback": "optional string"
}
```

**Response `200`:**
```json
{ "success": true, "shift": { ...updatedShiftDetail } }
```

**Errors:** `400` if shift is already closed or machine has no running job.

---

### POST `/update`
Directly update shift production/timer/feedback (no elastic calculation).

**Body:**
```json
{ "shiftId": "<id>", "production": 120, "timer": "06:00", "feedback": "string" }
```

**Response `200`:**
```json
{ "success": true, "shift": { ...shift } }
```

---

### GET `/shiftDetail`
Get a single shift detail with all populated references.

**Query params:** `id=<shiftDetailId>`

**Response `200`:**
```json
{ "success": true, "shift": { ...populatedShiftDetail } }
```

---

### GET `/all-open-shifts`
Get all open (not yet submitted) shift details.

**Response `200`:**
```json
{ "success": true, "shifts": [ ...openShifts ] }
```

---

### GET `/open`
Get all open shifts, sorted by date descending, with machine and job references.

**Response `200`:**
```json
{ "success": true, "shifts": [ ...openShifts ] }
```

---

### GET `/employee-open-shifts`
Get all open shifts for a specific employee.

**Query params:** `id=<employeeId>`

**Response `200`:**
```json
{ "success": true, "shifts": [ ...shifts ] }
```

---

### GET `/employee-closed-shifts`
Get last 30 closed shifts for a specific employee.

**Query params:** `id=<employeeId>`

**Response `200`:**
```json
{ "success": true, "shifts": [ ...shifts ] }
```

---

### GET `/shiftPlanOnDate`
Get shift plans for a date in `DD-MM-YYYY` format.

**Query params:** `date=DD-MM-YYYY`

**Response `200`:**
```json
{ "success": true, "shift": [ ...plans ] }
```

---

### DELETE `/deletePlan`
Delete a shift plan and all its shift detail entries.

**Query params:** `id=<shiftPlanId>`

**Response `200`:**
```json
{ "success": true, "message": "Shift Plan deleted successfully" }
```

---

## 4. Employee

**Base path:** `/api/v2/employee`

### POST `/create-employee`
Register a new employee.

**Body:**
| Field | Type | Required |
|---|---|---|
| `name` | string | Yes |
| `department` | string | Yes |
| `phoneNumber` | string (10 digits) | No |
| `role` | string | No |
| `aadhar` | string | No |

**Response `201`:**
```json
{ "success": true, "employee": { ...employee } }
```

**Errors:** `409` if phone number already registered.

---

### GET `/get-employees`
List all employees with optional department filter.

**Query params:** `department=<dept>` (omit or `all` for no filter)

**Response `200`:**
```json
{ "success": true, "employees": [ ...employees ] }
```

---

### GET `/get-employee-detail`
Get employee detail with last 10 shifts and efficiency stats.

**Query params:** `id=<employeeId>`

**Response `200`:**
```json
{
  "success": true,
  "employee": {
    "id": "...",
    "name": "string",
    "phoneNumber": "string",
    "department": "string",
    "role": "string",
    "aadhar": "string",
    "performance": 80,
    "skill": 90,
    "totalShifts": 45,
    "result": [
      {
        "id": "...",
        "date": "...",
        "shift": "DAY",
        "machine": "LOOM-01",
        "runtimeMinutes": 480,
        "outputMeters": 120,
        "efficiency": 66.67
      }
    ]
  }
}
```

---

### GET `/get-employee-weave`
Get all employees in the `weaving` department (for shift plan dropdowns).

**Response `200`:**
```json
{ "success": true, "employees": [ ...weavingEmployees ] }
```

---

### PUT `/update`
Update employee fields.

**Query params:** `id=<employeeId>`

**Body:** any subset of `name`, `phoneNumber`, `role`, `department`, `aadhar`, `skill`

**Response `200`:**
```json
{ "success": true, "employee": { ...employee } }
```

---

### PATCH `/performance`
Update an employee's performance score (0–100).

**Body:**
```json
{ "id": "<employeeId>", "performance": 85 }
```

**Response `200`:**
```json
{ "success": true, "employee": { "_id": "...", "name": "...", "performance": 85 } }
```

---

## 5. Customer

**Base path:** `/api/v2/customer`

### POST `/create`
Create a new customer.

**Body:**
| Field | Required |
|---|---|
| `name` | Yes |
| all other fields | No |

**Response `201`:**
```json
{ "success": true, "data": { ...customer } }
```

---

### PUT `/update`
Update a customer record.

**Body:** Customer object including `_id`.

**Response `200`:**
```json
{ "success": true, "data": { ...customer } }
```

---

### DELETE `/delete-customer`
Soft-delete a customer (sets `status = "Inactive"`).

**Query params:** `id=<customerId>`

**Response `200`:**
```json
{ "success": true, "message": "Customer deactivated successfully" }
```

---

### GET `/all-customers`
List customers with pagination and search.

**Query params:**
| Param | Default | Description |
|---|---|---|
| `page` | `1` | Page number |
| `limit` | `20` | Items per page |
| `search` | — | Searches name, phone, GSTIN |

**Response `200`:**
```json
{
  "success": true,
  "customers": [ ...customers ],
  "total": 100,
  "page": 1,
  "pages": 5
}
```

---

### GET `/customerDetail`
Get a single customer.

**Query params:** `id=<customerId>`

**Response `200`:**
```json
{ "success": true, "customer": { ...customer } }
```

---

## 6. Supplier & Purchase Orders

**Base path:** `/api/v2/supplier`

### POST `/create-supplier`
Create a new supplier.

**Body:** Supplier fields (name, phoneNumber, gstin, email, address, contactPerson, etc.)

**Response `201`:**
```json
{ "success": true, "supplier": { ...supplier } }
```

---

### GET `/get-suppliers`
List suppliers with pagination and name search.

**Query params:** `page`, `limit`, `search`

**Response `200`:**
```json
{
  "success": true,
  "suppliers": [ ...suppliers ],
  "pagination": { "page": 1, "limit": 20, "total": 50, "totalPages": 3 }
}
```

---

### GET `/get-supplier-detail`
Get a single supplier.

**Query params:** `id=<supplierId>`

**Response `200`:**
```json
{ "success": true, "supplier": { ...supplier } }
```

---

### PUT `/edit-supplier`
Update a supplier record.

**Body:** Supplier object including `_id`.

**Response `200`:**
```json
{ "success": true, "supplier": { ...supplier } }
```

---

### DELETE `/delete-supplier`
Soft-delete a supplier (sets `isActive = false`).

**Query params:** `id=<supplierId>`

**Response `200`:**
```json
{ "success": true, "message": "Supplier deleted successfully" }
```

---

### POST `/create-po`
Create a new Purchase Order.

**Body:**
```json
{
  "supplier": "<supplierId>",
  "items": [
    { "rawMaterial": "<materialId>", "price": 100, "quantity": 50 }
  ]
}
```

**Response `201`:**
```json
{ "success": true, "po": { ...populatedPO } }
```

PO number is auto-incremented from the highest existing `poNo`.

---

### GET `/get-pos`
List purchase orders with filters and pagination.

**Query params:**
| Param | Description |
|---|---|
| `page` | Page number (default 1) |
| `limit` | Items per page (default 20) |
| `status` | `Open` \| `Partial` \| `Completed` |
| `supplierId` | Filter by supplier |
| `search` | Filter by PO number |

**Response `200`:**
```json
{
  "success": true,
  "pos": [ ...purchaseOrders ],
  "pagination": { "page": 1, "limit": 20, "total": 40, "totalPages": 2, "hasMore": false }
}
```

---

### GET `/get-po-detail`
Get PO detail with all inward history.

**Query params:** `id=<poId>`

**Response `200`:**
```json
{ "success": true, "po": { ...po }, "inwardHistory": [ ...inwardRecords ] }
```

---

### PUT `/edit-po`
Edit an Open or Partial PO (preserves received quantities).

**Body:** PO object including `_id`, `supplier`, `items`.

**Response `200`:**
```json
{ "success": true, "po": { ...updatedPO } }
```

**Errors:** `400` if PO is `Completed`.

---

### POST `/clone-po`
Duplicate a PO with a new PO number and all received quantities reset to 0.

**Body:**
```json
{ "id": "<sourcePOId>" }
```

**Response `201`:**
```json
{ "success": true, "po": { ...clonedPO } }
```

---

### POST `/inward-stock`
Record goods received against a PO. Automatically updates PO status.

**Body:**
```json
{
  "poId": "<poId>",
  "items": [
    {
      "rawMaterial": "<materialId>",
      "quantity": 20,
      "inwardDate": "ISO date",
      "remarks": "optional"
    }
  ]
}
```

PO status transitions: `Open` → `Partial` → `Completed` based on received quantities.

**Response `201`:**
```json
{
  "success": true,
  "message": "Stock inward recorded. PO status: Partial",
  "inwardRecords": [ ... ],
  "poStatus": "Partial"
}
```

---

### GET `/get-inward-history`
Get all inward records for a PO.

**Query params:** `poId=<poId>`

**Response `200`:**
```json
{ "success": true, "records": [ ...inwardRecords ] }
```

---

## 7. Raw Materials

**Base path:** `/api/v2/materials`

### POST `/create-raw-material`
Create a new raw material.

**Body:**
```json
{
  "name": "string",
  "category": "warp|weft|Rubber|covering",
  "supplier": "<supplierId>",
  "stock": 0,
  "minStock": 0,
  "price": 0
}
```

**Response `201`:**
```json
{ "success": true, "material": { ...material } }
```

---

### GET `/get-raw-materials`
List raw materials with optional filters.

**Query params:**
| Param | Description |
|---|---|
| `search` | Regex search on name |
| `category` | Filter by category |
| `lowStock=true` | Only items where stock ≤ minStock |

**Response `200`:**
```json
{ "success": true, "materials": [ ...materials ] }
```

---

### GET `/get-raw-material-detail`
Get a material with inward and outward history (last 50 each).

**Query params:** `id=<materialId>`

**Response `200`:**
```json
{
  "success": true,
  "material": {
    ...materialFields,
    "stockMovements": [ ...last30Movements ],
    "inwards": [ ...last50InwardRecords ],
    "outwards": [ ...last50OutwardRecords ]
  }
}
```

---

### DELETE `/delete-raw-material`
Hard-delete a raw material.

**Query params:** `id=<materialId>`

**Response `200`:**
```json
{ "success": true, "message": "Material deleted" }
```

---

### PUT `/edit-raw-material`
Update raw material fields.

**Body:** Material object including `_id`.

**Response `200`:**
```json
{ "success": true, "material": { ...material } }
```

---

### GET `/suppliers`
List suppliers (used for dropdowns). Supports name search.

**Query params:** `search=<name>`

**Response `200`:**
```json
{ "success": true, "suppliers": [ ...suppliers ] }
```

---

### POST `/raise-po`
Raise a Purchase Order directly from the materials screen.

**Body:**
```json
{
  "supplier": "<supplierId>",
  "items": [ { "rawMaterial": "<id>", "quantity": 50, "price": 100 } ]
}
```

**Response `201`:**
```json
{ "success": true, "po": { ...po } }
```

---

### POST `/material-inward`
Record stock inward and update PO received quantity.

**Body:**
```json
{
  "rawMaterialId": "<id>",
  "purchaseOrderId": "<id>",
  "quantity": 20,
  "remarks": "optional"
}
```

**Response `201`:**
```json
{ "success": true, "inward": { ...inwardRecord } }
```

---

### GET `/get-low-stock-materials`
Get all materials where `stock ≤ minStock`.

**Response `200`:**
```json
{ "success": true, "materials": [ ...lowStockMaterials ] }
```

---

### GET `/materialForNewElastic`
Get raw materials grouped by category for the elastic creation form.

**Response `200`:**
```json
{
  "warp": [ ...warpMaterials ],
  "weft": [ ...weftMaterials ],
  "rubber": [ ...rubberMaterials ],
  "covering": [ ...coveringMaterials ]
}
```

---

## 8. Elastic

**Base path:** `/api/v2/elastic`

### POST `/create-elastic`
Create an elastic definition with automatic costing calculation.

**Body:**
```json
{
  "name": "string",
  "weaveType": "string",
  "warpSpandex":    { "id": "<materialId>", "weight": 50 },
  "spandexCovering":{ "id": "<materialId>", "weight": 30 },
  "weftYarn":       { "id": "<materialId>", "weight": 40 },
  "warpYarn":       [ { "id": "<materialId>", "weight": 20 } ],
  "spandexEnds": 4,
  "yarnEnds": 8,
  "pick": 18,
  "noOfHook": 4,
  "weight": 25,
  "conversionCost": 1.25,
  "testingParameters": { ... },
  "image": "base64 or url"
}
```

**Response `201`:**
```json
{
  "success": true,
  "elastic": { ...elastic },
  "costing": { "totalCost": 12.50, "materialCost": 11.25, "conversionCost": 1.25, "details": [ ... ] }
}
```

---

### GET `/get-elastics`
Paginated list of elastics with optional name search.

**Query params:** `search`, `page` (default 1), `limit` (default 20)

**Response `200`:**
```json
{ "success": true, "elastics": [ ...elastics ], "total": 50, "page": 1 }
```

---

### GET `/get-elastic-detail`
Get full elastic detail with all raw material and costing references populated.

**Query params:** `id=<elasticId>`

**Response `200`:**
```json
{ "success": true, "elastic": { ...populatedElastic } }
```

---

### PUT `/update-elastic`
Update an elastic and recalculate its material costing.

**Body:** Full elastic object including `_id`.

**Response `200`:**
```json
{ "success": true, "elastic": { ...elastic } }
```

---

### POST `/recalculate-elastic-cost`
Recalculate the costing for an existing elastic using current material prices.

**Body:**
```json
{ "elasticId": "<id>" }
```

**Response `200`:**
```json
{ "success": true }
```

---

## 9. Order

**Base path:** `/api/v2/order`

### Order Status Flow
```
Open → Approved → InProgress → Completed
         ↓
      Cancelled
```

### GET `/list`
List orders by status.

**Query params:** `status=Open|Approved|InProgress|Completed|Cancelled` *(required)*

**Response `200`:**
```json
{ "success": true, "orders": [ ...orders ] }
```

---

### POST `/create-order`
Create a new customer order. Automatically calculates raw material requirements.

**Body:**
```json
{
  "date": "ISO date",
  "po": "PO reference string",
  "customer": "<customerId>",
  "supplyDate": "ISO date",
  "description": "optional",
  "elasticOrdered": [
    { "elastic": "<elasticId>", "quantity": 500 }
  ]
}
```

**Response `201`:**
```json
{ "success": true, "orderId": "<orderId>" }
```

---

### GET `/get-orderDetail`
Get full order detail with elastic progress tracking.

**Query params:** `id=<orderId>`

**Response `200`:**
```json
{
  "success": true,
  "data": {
    "_id": "...",
    "orderNo": 1001,
    "po": "string",
    "status": "Open",
    "date": "...",
    "supplyDate": "...",
    "customer": { "name": "...", "gstin": "..." },
    "elastics": [
      { "id": "...", "name": "...", "ordered": 500, "produced": 200, "packed": 100, "pending": 300 }
    ],
    "jobs": [ ... ],
    "rawMaterialRequired": [ ... ]
  }
}
```

---

### POST `/approve`
Approve an order and atomically deduct raw material stock.

**Body:**
```json
{ "orderId": "<id>" }
```

Performs stock validation before deducting. Uses a MongoDB session/transaction.

**Response `200`:**
```json
{ "success": true, "message": "Order approved and stock deducted" }
```

**Errors:** `400` if insufficient stock for any material.

---

### POST `/cancel`
Cancel an Open or Approved order.

**Body:**
```json
{ "orderId": "<id>" }
```

**Response `200`:**
```json
{ "success": true, "message": "Order cancelled", "orderId": "...", "status": "Cancelled" }
```

---

### POST `/start-production`
Advance an Approved order to InProgress status.

**Body:**
```json
{ "orderId": "<id>" }
```

**Response `200`:**
```json
{ "success": true, "message": "Order moved to InProgress", "status": "InProgress" }
```

---

### POST `/complete`
Mark an InProgress order as Completed.

**Body:**
```json
{ "orderId": "<id>" }
```

**Response `200`:**
```json
{ "success": true, "message": "Order completed", "status": "Completed" }
```

---

### GET `/get-open-orders`
List all Open orders.

**Response `200`:**
```json
{ "success": true, "openOrders": [ ...orders ] }
```

---

### GET `/get-pending-orders`
List all Approved (pending production) orders.

**Response `200`:**
```json
{ "success": true, "pending": [ ...orders ] }
```

---

## 10. Job Order

**Base path:** `/api/v2/job`

### Job Status Flow
```
preparatory → weaving → finishing → checking → packing → completed
                                                         ↓
                                                      cancelled (from any non-terminal state)
```

### POST `/create`
Create a job order from an Order. Automatically creates a Warping and Covering programme.

**Body:**
```json
{
  "orderId": "<id>",
  "date": "ISO date",
  "elastics": [
    { "elastic": "<elasticId>", "quantity": 200 }
  ]
}
```

Validates that requested quantities don't exceed `Order.pendingElastic`.

**Response `201`:**
```json
{
  "success": true,
  "data": {
    "job":      { "_id": "...", "jobOrderNo": 1001, "status": "preparatory" },
    "warping":  { "_id": "...", "status": "open" },
    "covering": { "_id": "...", "status": "open" }
  }
}
```

---

### GET `/jobs`
List job orders with pagination, status filter, and job number search.

**Query params:**
| Param | Default | Description |
|---|---|---|
| `status` | — | Filter by status (or `all`) |
| `search` | — | Exact jobOrderNo |
| `page` | `1` | Page number |
| `limit` | `10` | Max 50 |

**Response `200`:**
```json
{
  "success": true,
  "jobs": [ ...jobs ],
  "pagination": { "total": 50, "page": 1, "limit": 10, "pages": 5, "hasMore": true }
}
```

---

### GET `/detail`
Get full job detail with all populated sub-documents.

**Query params:** `id=<jobId>`

**Response `200`:**
```json
{ "success": true, "job": { ...fullyPopulatedJob } }
```

---

### POST `/plan-weaving`
Assign a free machine and set the head→elastic mapping. Advances job: `preparatory → weaving`.

**Body:**
```json
{
  "jobId": "<id>",
  "machineId": "<id>",
  "headElasticMap": {
    "0": "<elasticId>",
    "1": "<elasticId>",
    "2": "<elasticId>",
    "3": "<elasticId>"
  }
}
```

Keys are 0-based head indexes (stored as 1-based in DB).

**Response `200`:**
```json
{
  "success": true,
  "data": {
    "job":     { "_id": "...", "jobOrderNo": 1001, "status": "weaving" },
    "machine": { "_id": "...", "ID": "LOOM-01", "status": "running", "headPlan": [ ... ] }
  }
}
```

---

### POST `/update-status`
Advance job through the status pipeline.

**Body:**
```json
{ "jobId": "<id>", "nextStatus": "finishing|checking|packing|completed" }
```

**Side effects:**
- `weaving → finishing`: releases the machine back to `free`
- `packing → completed`: marks the parent Order as `Completed` if all sibling jobs are done/cancelled

**Response `200`:**
```json
{ "success": true, "data": { "_id": "...", "jobOrderNo": 1001, "status": "finishing" } }
```

---

### POST `/cancel`
Cancel a job at any non-terminal stage.

**Body:**
```json
{ "jobId": "<id>", "reason": "optional reason" }
```

**Side effects:**
- Releases assigned machine if in `weaving`
- Restores quantities to `Order.pendingElastic`
- Reverts Order status to `Approved` if no active jobs remain

**Response `200`:**
```json
{ "success": true, "data": { "_id": "...", "jobOrderNo": 1001, "status": "cancelled" } }
```

---

### POST `/create-wastage`
Record elastic wastage during weaving, finishing, or checking.

**Body:**
```json
{
  "jobId": "<id>",
  "elasticId": "<id>",
  "employeeId": "<id>",
  "quantity": 5.5,
  "penalty": 0,
  "reason": "string (required)"
}
```

**Response `201`:**
```json
{ "success": true, "wastage": { ...wastage } }
```

---

### GET `/summary`
Get production summary for a job (planned vs produced vs packed vs wasted).

**Query params:** `jobId=<id>`

**Response `200`:**
```json
{
  "success": true,
  "jobId": "...",
  "jobNo": 1001,
  "status": "weaving",
  "summary": [
    {
      "elasticId": "...",
      "elasticName": "string",
      "planned": 200,
      "produced": 80,
      "packed": 50,
      "wasted": 5,
      "remaining": 115,
      "packingPct": 25
    }
  ]
}
```

---

### GET `/job-operators`
Get unique operators who have worked on a job (from shift records).

**Query params:** `id=<jobId>`

**Response `200`:**
```json
{ "success": true, "operators": [ { "_id": "...", "name": "...", "department": "..." } ] }
```

---

### GET `/jobs-checking`
List all jobs currently in `checking` status.

**Response `200`:**
```json
{ "success": true, "jobs": [ ...checkingJobs ] }
```

---

### POST `/assign-machine`
Reassign a different machine to a job already in `weaving` status.

**Body:**
```json
{ "jobId": "<id>", "machineId": "<id>" }
```

**Response `200`:**
```json
{ "success": true, "data": { "job": { ... }, "machine": { ... } } }
```

---

## 11. Warping

**Base path:** `/api/v2/warping`

### Warping Status Flow
```
open → in_progress → completed
                  ↓
              cancelled
```

### POST `/create`
Create a warping record for a job (also created automatically by `POST /job/create`).

**Body:**
```json
{ "jobId": "<id>", "elasticOrdered": [ { "elastic": "<id>", "quantity": 200 } ] }
```

**Response `201`:**
```json
{ "success": true, "warping": { ...warping } }
```

---

### GET `/list`
List warpings with status filter, job number search, and pagination.

**Query params:** `status=open|in_progress|completed|all`, `search`, `page`, `limit`

**Response `200`:**
```json
{
  "success": true,
  "data": [ ...warpings ],
  "pagination": { "total": 20, "page": 1, "limit": 20, "hasMore": false }
}
```

---

### GET `/detail/:id`
Get full warping detail with elastic and warping plan sub-documents.

**Response `200`:**
```json
{ "success": true, "warping": { ...populatedWarping } }
```

---

### PUT `/start`
Start a warping (requires a warping plan to exist first).

**Query params:** `id=<warpingId>`

**Response `200`:**
```json
{ "success": true, "warping": { ...warping } }
```

---

### PUT `/complete`
Complete a warping. If both warping and covering are complete, automatically advances the job to `weaving`.

**Query params:** `id=<warpingId>`

**Response `200`:**
```json
{ "success": true, "warping": { ...warping } }
```

---

### PATCH `/cancel/:id`
Cancel a warping.

**Response `200`:**
```json
{ "success": true, "warping": { ...warping } }
```

---

### GET `/warpingPlan`
Get the warping plan associated with a warping record.

**Query params:** `id=<warpingId>`

**Response `200`:**
```json
{ "exists": true, "plan": { ...warpingPlan } }
```
or `{ "exists": false }` if no plan yet.

---

### POST `/warpingPlan/create`
Create a warping plan with beam and section details.

**Body:**
```json
{
  "warpingId": "<id>",
  "beams": [
    {
      "sections": [
        { "warpYarn": "<materialId>", "ends": 20, "length": 100 }
      ]
    }
  ],
  "remarks": "optional"
}
```

`noOfBeams` is derived from `beams.length`.

**Response `201`:**
```json
{ "success": true, "plan": { ...populatedPlan } }
```

---

### GET `/plan-context/:jobId`
Get all warp yarns used by the elastics in a job (for warping plan form).

**Response `200`:**
```json
{
  "success": true,
  "jobId": "...",
  "warpYarns": [ { "id": "string", "name": "string" } ]
}
```

---

## 12. Covering

**Base path:** `/api/v2/covering`

### Covering Status Flow
```
open → in_progress → completed
              ↓
          cancelled
```

### GET `/list`
List coverings with pagination.

**Query params:** `status=open|in_progress|completed|cancelled`, `search=<jobOrderNo>`, `page`, `limit`

**Response `200`:**
```json
{
  "success": true,
  "data": [ ...coverings ],
  "pagination": { "total": 10, "page": 1, "limit": 20, "hasMore": false }
}
```

---

### GET `/detail`
Get full covering detail with elastic and raw material references.

**Query params:** `id=<coveringId>`

**Response `200`:**
```json
{ "success": true, "covering": { ...populatedCovering } }
```

---

### POST `/start`
Start a covering (must be in `open` status).

**Body:** `{ "id": "<coveringId>" }`

**Response `200`:**
```json
{ "success": true, "covering": { ...covering } }
```

---

### POST `/complete`
Complete a covering (must be in `in_progress` status).

**Body:** `{ "id": "<coveringId>", "remarks": "optional" }`

**Response `200`:**
```json
{ "success": true, "covering": { ...covering } }
```

---

### POST `/cancel`
Cancel a covering (cannot cancel a completed covering).

**Body:** `{ "id": "<coveringId>", "remarks": "optional" }`

**Response `200`:**
```json
{ "success": true, "covering": { ...covering } }
```

---

## 13. Packing

**Base path:** `/api/v2/packing`

### GET `/jobs-packing`
List jobs currently in `packing` status (for the Add Packing dropdown).

**Response `200`:**
```json
{ "success": true, "jobs": [ ...packingJobs ] }
```

---

### GET `/grouped`
Get packing summary grouped by job (total boxes and meters per job).

**Response `200`:**
```json
{
  "success": true,
  "grouped": [
    {
      "job": { "jobOrderNo": 1001, "customer": { "name": "..." } },
      "totalBoxes": 10,
      "totalMeters": 500
    }
  ]
}
```

---

### GET `/by-job/:jobId`
Get all packing records for a specific job.

**Response `200`:**
```json
{ "success": true, "packings": [ ...packings ] }
```

---

### GET `/detail/:id`
Get a single packing record with full references.

**Response `200`:**
```json
{ "success": true, "packing": { ...populatedPacking } }
```

---

### POST `/create-packing`
Create a packing record for a job.

**Body:**
| Field | Type | Required |
|---|---|---|
| `job` | ObjectId | Yes |
| `elastic` | ObjectId | Yes |
| `meter` | number (>0) | Yes |
| `netWeight` | number | Yes |
| `tareWeight` | number | Yes |
| `grossWeight` | number | Yes |
| `checkedBy` | ObjectId (Employee) | Yes |
| `packedBy` | ObjectId (Employee) | Yes |
| `joints` | number | No |
| `stretch` | string | No |
| `size` | string | No |

**Response `201`:**
```json
{ "success": true, "packing": { ...packing } }
```

---

### GET `/employees-by-department/:dept`
Get employees by department (for checkedBy/packedBy dropdowns).

**Response `200`:**
```json
{ "success": true, "employees": [ { "_id": "...", "name": "..." } ] }
```

---

### GET `/all`
Get all packing records (admin/reporting).

**Query params:** `limit` (default 50), `skip` (default 0)

**Response `200`:**
```json
{ "success": true, "total": 200, "packings": [ ...packings ] }
```

---

### DELETE `/:id`
Delete a packing record. Reverses the quantity update on the job.

**Response `200`:**
```json
{ "success": true, "message": "Packing record deleted" }
```

---

## 14. Production

**Base path:** `/api/v2/production`

### GET `/date-range`
Get production summary for each calendar day in a date range, broken down by DAY/NIGHT shift.

**Query params:** `startDate=YYYY-MM-DD&endDate=YYYY-MM-DD` *(both required)*

**Response `200`:**
```json
{
  "success": true,
  "count": 7,
  "data": [
    {
      "date": "2026-01-01",
      "dateLabel": "01 Jan 2026",
      "dayOfWeek": "Mon",
      "hasData": true,
      "totalProduction": 480,
      "dayShift": {
        "exists": true,
        "shiftPlanId": "...",
        "machineCount": 4,
        "operatorCount": 4,
        "shiftDetailCount": 4,
        "production": 240,
        "description": "...",
        "statusSummary": "closed"
      },
      "nightShift": { ...same shape }
    }
  ]
}
```

`statusSummary` values: `none` | `open` | `running` | `closed`

---

### GET `/shift-detail/:shiftPlanId`
Get full detail for a single shift plan including per-machine breakdown.

**Response `200`:**
```json
{
  "success": true,
  "data": {
    "shiftPlanId": "...",
    "date": "2026-01-01",
    "dateLabel": "01 Jan 2026",
    "shift": "DAY",
    "description": "string",
    "totalProduction": 240,
    "summary": {
      "totalMachines": 4,
      "totalOperators": 4,
      "totalProduction": 240,
      "totalTimerSeconds": 86400,
      "timerLabel": "24h",
      "avgProductionPerMachine": 60,
      "statusCounts": { "open": 0, "running": 0, "closed": 4 }
    },
    "details": [
      {
        "shiftDetailId": "...",
        "date": "2026-01-01",
        "shift": "DAY",
        "status": "closed",
        "timer": "06:00:00",
        "timerSeconds": 21600,
        "timerLabel": "6h",
        "productionMeters": 60,
        "machine": { "id": "...", "machineID": "LOOM-01", "noOfHead": 4, "noOfHooks": 8, "status": "free" },
        "employee": { "id": "...", "name": "string", "department": "weaving" },
        "job": { "id": "...", "jobNo": 1001, "status": "weaving" },
        "elastics": [ { "head": 1, "elastic": { "id": "...", "name": "...", "pick": 18 } } ]
      }
    ]
  }
}
```

---

### GET `/summary-stats`
Get aggregated production statistics for a date range.

**Query params:** `startDate=YYYY-MM-DD&endDate=YYYY-MM-DD`

**Response `200`:**
```json
{
  "success": true,
  "data": {
    "dateRange": { "startDate": "2026-01-01", "endDate": "2026-01-07" },
    "shiftPlans": {
      "totalProduction": 3360,
      "total": 14,
      "dayCount": 7,
      "nightCount": 7,
      "avgProductionPerShift": 240
    },
    "productionRecords": {
      "totalProduction": 3360,
      "total": 56,
      "uniqueMachines": 4,
      "uniqueOperators": 6
    }
  }
}
```

---

## 15. Wastage

**Base path:** `/api/v2/wastage`

Wastage can only be recorded when a job is in `weaving`, `finishing`, or `checking` status.

### POST `/add-wastage`
Record a wastage event.

**Body:**
```json
{
  "job": "<jobId>",
  "elastic": "<elasticId>",
  "employee": "<employeeId>",
  "quantity": 5.5,
  "penalty": 0,
  "reason": "string (required)"
}
```

**Response `201`:**
```json
{ "success": true, "wastage": { ...populatedWastage } }
```

---

### GET `/jobs-for-wastage`
List jobs eligible for wastage entry (status: weaving, finishing, or checking).

**Response `200`:**
```json
{ "success": true, "jobs": [ ...eligibleJobs ] }
```

---

### GET `/jobs-wastage-list`
List all jobs that have wastage records, with totals rolled up.

**Query params:** `status=<jobStatus>`, `search=<jobOrderNo>`

**Response `200`:**
```json
{
  "success": true,
  "jobs": [
    {
      "_id": "...",
      "jobOrderNo": 1001,
      "status": "finishing",
      "customer": { ... },
      "wastageElastic": [ ... ],
      "totalWastage": 12.5,
      "wastageCount": 3,
      "lastAdded": "..."
    }
  ]
}
```

---

### GET `/get-by-job`
Get all wastage records for a specific job.

**Query params:** `jobId=<id>`

**Response `200`:**
```json
{ "success": true, "wastages": [ ...wastageRecords ] }
```

---

### GET `/get-detail`
Get a single wastage record with full references.

**Query params:** `id=<wastageId>`

**Response `200`:**
```json
{ "success": true, "wastage": { ...populatedWastage } }
```

---

### GET `/analytics`
Aggregated wastage analytics.

**Query params:** `days=30` (max 365, default 30)

**Response `200`:**
```json
{
  "success": true,
  "analytics": {
    "topEmployees": [ { "name": "...", "department": "...", "total": 45, "count": 9, "avgPenalty": 0 } ],
    "byElastic":   [ { "name": "...", "total": 20, "count": 4 } ],
    "byStatus":    [ { "_id": "weaving", "total": 30, "count": 6 } ],
    "trend":       [ { "date": "2026-01-01", "total": 5, "count": 2 } ],
    "totalWastage": 120,
    "totalPenalty": 0,
    "totalCount": 24,
    "days": 30
  }
}
```

---

### GET `/get-in-range`
Get daily wastage totals for a date range.

**Query params:** `start=YYYY-MM-DD&less=YYYY-MM-DD`

**Response `200`:**
```json
{ "success": true, "array": [ { "date": "01-01-2026", "quantity": 5.5 } ] }
```

---

### GET `/get-by-employee`
Get last 50 wastage records for an employee.

**Query params:** `id=<employeeId>`

**Response `200`:**
```json
{ "success": true, "wastage": [ ...wastageRecords ] }
```

---

## Error Codes Summary

| Code | Meaning |
|---|---|
| `400` | Bad request / validation error |
| `401` | Unauthorized (not logged in) |
| `404` | Resource not found |
| `409` | Conflict (duplicate record) |
| `500` | Internal server error |
