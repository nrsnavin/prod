"use strict";

jest.mock("../../models/Employee");
jest.mock("../../models/ShiftDetail");

const request = require("supertest");
const app = require("../../app");
const Employee = require("../../models/Employee");

// ─── helpers ────────────────────────────────────────────────────────────────

const fakeEmployee = (overrides = {}) => ({
  _id: "emp1",
  name: "John Doe",
  phoneNumber: "9876543210",
  department: "weaving",
  role: "operator",
  aadhar: "123456789012",
  performance: 80,
  skill: 5,
  shifts: [],
  save: jest.fn().mockResolvedValue(true),
  ...overrides,
});

// ─── POST /create-employee ──────────────────────────────────────────────────

describe("POST /api/v2/employee/create-employee", () => {
  beforeEach(() => jest.clearAllMocks());

  it("returns 201 and the new employee on success", async () => {
    Employee.findOne = jest.fn().mockResolvedValue(null);
    Employee.create = jest.fn().mockResolvedValue(fakeEmployee());

    const res = await request(app)
      .post("/api/v2/employee/create-employee")
      .send({ name: "John Doe", department: "weaving", phoneNumber: "9876543210" });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.employee).toMatchObject({ name: "John Doe" });
  });

  it("returns 400 when name is missing", async () => {
    const res = await request(app)
      .post("/api/v2/employee/create-employee")
      .send({ department: "weaving" });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/name is required/i);
  });

  it("returns 400 when department is missing", async () => {
    const res = await request(app)
      .post("/api/v2/employee/create-employee")
      .send({ name: "John" });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/department is required/i);
  });

  it("returns 400 when phoneNumber is not 10 digits", async () => {
    const res = await request(app)
      .post("/api/v2/employee/create-employee")
      .send({ name: "John", department: "weaving", phoneNumber: "123" });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/10 digits/i);
  });

  it("returns 409 when phone number already exists", async () => {
    Employee.findOne = jest.fn().mockResolvedValue(fakeEmployee());

    const res = await request(app)
      .post("/api/v2/employee/create-employee")
      .send({ name: "John", department: "weaving", phoneNumber: "9876543210" });

    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/already exists/i);
  });
});

// ─── GET /get-employees ─────────────────────────────────────────────────────

describe("GET /api/v2/employee/get-employees", () => {
  beforeEach(() => jest.clearAllMocks());

  it("returns 200 and an array of employees", async () => {
    const chain = { select: jest.fn().mockReturnThis(), sort: jest.fn().mockResolvedValue([fakeEmployee()]) };
    Employee.find = jest.fn().mockReturnValue(chain);

    const res = await request(app).get("/api/v2/employee/get-employees");

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.employees)).toBe(true);
  });

  it("filters by department when query param is provided", async () => {
    const chain = { select: jest.fn().mockReturnThis(), sort: jest.fn().mockResolvedValue([]) };
    Employee.find = jest.fn().mockReturnValue(chain);

    await request(app).get("/api/v2/employee/get-employees?department=weaving");

    expect(Employee.find).toHaveBeenCalledWith({ department: "weaving" });
  });

  it("does not filter when department=all", async () => {
    const chain = { select: jest.fn().mockReturnThis(), sort: jest.fn().mockResolvedValue([]) };
    Employee.find = jest.fn().mockReturnValue(chain);

    await request(app).get("/api/v2/employee/get-employees?department=all");

    expect(Employee.find).toHaveBeenCalledWith({});
  });
});

// ─── GET /get-employee-detail ───────────────────────────────────────────────

describe("GET /api/v2/employee/get-employee-detail", () => {
  beforeEach(() => jest.clearAllMocks());

  it("returns 400 when id is missing", async () => {
    const res = await request(app).get("/api/v2/employee/get-employee-detail");
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/id is required/i);
  });

  it("returns 404 when employee is not found", async () => {
    const chain = { populate: jest.fn().mockReturnThis(), exec: jest.fn().mockResolvedValue(null) };
    Employee.findById = jest.fn().mockReturnValue(chain);

    const res = await request(app).get("/api/v2/employee/get-employee-detail?id=nonexistent");
    expect(res.status).toBe(404);
    expect(res.body.message).toMatch(/not found/i);
  });

  it("returns 200 with employee detail on success", async () => {
    const emp = fakeEmployee({
      shifts: [
        { _id: "s1", date: "2024-01-01", shift: "A", timer: "06:00", productionMeters: 300, createdAt: new Date() },
      ],
    });
    const chain = { populate: jest.fn().mockReturnThis(), exec: jest.fn().mockResolvedValue(emp) };
    Employee.findById = jest.fn().mockReturnValue(chain);

    const res = await request(app).get("/api/v2/employee/get-employee-detail?id=emp1");

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.employee.name).toBe("John Doe");
  });
});

// ─── PUT /update ────────────────────────────────────────────────────────────

describe("PUT /api/v2/employee/update", () => {
  beforeEach(() => jest.clearAllMocks());

  it("returns 400 when id is missing", async () => {
    const res = await request(app).put("/api/v2/employee/update").send({ name: "New Name" });
    expect(res.status).toBe(400);
  });

  it("returns 404 when employee not found", async () => {
    Employee.findById = jest.fn().mockResolvedValue(null);

    const res = await request(app).put("/api/v2/employee/update?id=bad").send({ name: "X" });
    expect(res.status).toBe(404);
  });

  it("updates allowed fields and returns 200", async () => {
    const emp = fakeEmployee();
    Employee.findById = jest.fn().mockResolvedValue(emp);

    const res = await request(app)
      .put("/api/v2/employee/update?id=emp1")
      .send({ name: "Jane Doe", role: "supervisor" });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(emp.save).toHaveBeenCalled();
  });
});

// ─── PATCH /performance ─────────────────────────────────────────────────────

describe("PATCH /api/v2/employee/performance", () => {
  beforeEach(() => jest.clearAllMocks());

  it("returns 400 when id is missing", async () => {
    const res = await request(app).patch("/api/v2/employee/performance").send({ performance: 80 });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/id is required/i);
  });

  it("returns 400 when performance is not provided", async () => {
    const res = await request(app).patch("/api/v2/employee/performance").send({ id: "emp1" });
    expect(res.status).toBe(400);
  });

  it("returns 400 when performance is out of range", async () => {
    const res = await request(app).patch("/api/v2/employee/performance").send({ id: "emp1", performance: 150 });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/0 and 100/i);
  });

  it("returns 404 when employee not found", async () => {
    Employee.findByIdAndUpdate = jest.fn().mockResolvedValue(null);

    const res = await request(app).patch("/api/v2/employee/performance").send({ id: "emp1", performance: 75 });
    expect(res.status).toBe(404);
  });

  it("updates performance and returns 200", async () => {
    const emp = { _id: "emp1", name: "John", performance: 75 };
    Employee.findByIdAndUpdate = jest.fn().mockResolvedValue(emp);

    const res = await request(app).patch("/api/v2/employee/performance").send({ id: "emp1", performance: 75 });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.employee.performance).toBe(75);
  });
});

// ─── GET /get-employee-weave ────────────────────────────────────────────────

describe("GET /api/v2/employee/get-employee-weave", () => {
  it("returns 200 and weaving department employees", async () => {
    const chain = { select: jest.fn().mockReturnThis(), sort: jest.fn().mockResolvedValue([fakeEmployee()]) };
    Employee.find = jest.fn().mockReturnValue(chain);

    const res = await request(app).get("/api/v2/employee/get-employee-weave");

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Employee.find).toHaveBeenCalledWith({ department: "weaving" });
  });
});
