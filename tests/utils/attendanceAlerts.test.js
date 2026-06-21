'use strict';

jest.mock("../../utils/notify.js", () => ({
  notify: jest.fn().mockResolvedValue({ ok: true }),
}));

const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

let mongo, Attendance, alerts, notifyMock;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  Attendance = require("../../models/Attendence.js");
  alerts     = require("../../utils/attendanceAlerts.js");
  notifyMock = require("../../utils/notify.js").notify;
}, 60_000);

afterAll(async () => {
  if (mongo) { await mongoose.disconnect(); await mongo.stop(); }
});
afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) {
    await c.deleteMany({});
  }
  notifyMock.mockClear();
});

function dayOffset(d, days) {
  const x = new Date(d);
  x.setDate(x.getDate() + days);
  return x;
}

async function seedDay(date, shift, presentCount, absentCount) {
  const docs = [];
  for (let i = 0; i < presentCount; i++) {
    docs.push({ employee: new mongoose.Types.ObjectId(), date, shift, status: "present", shiftHours: 12, hoursWorked: 12 });
  }
  for (let i = 0; i < absentCount; i++) {
    docs.push({ employee: new mongoose.Types.ObjectId(), date, shift, status: "absent", shiftHours: 12, hoursWorked: 0 });
  }
  if (docs.length) await Attendance.insertMany(docs);
}

describe("maybeFireAttendanceCrashed", () => {
  test("fires when today is well below the 30d baseline", async () => {
    const today = new Date("2026-06-20T05:00:00Z");
    today.setHours(0,0,0,0);
    // 10 days of 20-present, 0-absent
    for (let i = 1; i <= 10; i++) {
      await seedDay(dayOffset(today, -i), "DAY", 20, 0);
    }
    // Today: only 5 present (25% of baseline)
    await seedDay(today, "DAY", 5, 15);

    await alerts.maybeFireAttendanceCrashed({ date: today, shift: "DAY" });
    expect(notifyMock).toHaveBeenCalledWith(
      "attendanceCrashedToday",
      expect.objectContaining({ shift: "DAY", present: 5 }),
    );
  });

  test("stays silent on a normal day", async () => {
    const today = new Date("2026-06-20T05:00:00Z");
    today.setHours(0,0,0,0);
    for (let i = 1; i <= 10; i++) {
      await seedDay(dayOffset(today, -i), "DAY", 20, 0);
    }
    await seedDay(today, "DAY", 19, 1);
    await alerts.maybeFireAttendanceCrashed({ date: today, shift: "DAY" });
    expect(notifyMock).not.toHaveBeenCalled();
  });

  test("skips tiny teams (baseline below floor)", async () => {
    const today = new Date("2026-06-20T05:00:00Z");
    today.setHours(0,0,0,0);
    for (let i = 1; i <= 5; i++) {
      await seedDay(dayOffset(today, -i), "DAY", 2, 0);
    }
    await seedDay(today, "DAY", 0, 2);
    await alerts.maybeFireAttendanceCrashed({ date: today, shift: "DAY" });
    expect(notifyMock).not.toHaveBeenCalled();
  });

  test("stays silent when there is no baseline yet (new plant)", async () => {
    const today = new Date("2026-06-20T05:00:00Z");
    today.setHours(0,0,0,0);
    await seedDay(today, "DAY", 2, 18);
    await alerts.maybeFireAttendanceCrashed({ date: today, shift: "DAY" });
    expect(notifyMock).not.toHaveBeenCalled();
  });
});

describe("_effective() weights", () => {
  test("present + late count as 1, half_day as 0.5, absent/on_leave as 0", () => {
    const rows = [
      { status: "present"  }, { status: "present" },
      { status: "late"     },
      { status: "half_day" },
      { status: "absent"   }, { status: "on_leave" },
    ];
    expect(alerts._effective(rows)).toBe(3.5);
  });
});
