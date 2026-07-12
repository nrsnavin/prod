"use strict";

jest.mock("../../models/JobOrder");
jest.mock("../../models/Warping");
jest.mock("../../models/Covering");

const JobOrder = require("../../models/JobOrder");
const Warping = require("../../models/Warping");
const Covering = require("../../models/Covering");
const { checkAndAdvanceToWeaving } = require("../../utils/jobStatusHelper");

describe("checkAndAdvanceToWeaving", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns advanced:false and jobStatus:unknown when job is not found", async () => {
    JobOrder.findById = jest.fn().mockReturnValue({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(null) }) });

    const result = await checkAndAdvanceToWeaving("nonexistent");
    expect(result).toEqual({ advanced: false, jobStatus: "unknown" });
  });

  it("returns advanced:false when job status is not preparatory", async () => {
    JobOrder.findById = jest.fn().mockReturnValue({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue({ _id: "job1", status: "weaving", warping: "w1", covering: "c1" }),
      }),
    });

    const result = await checkAndAdvanceToWeaving("job1");
    expect(result).toEqual({ advanced: false, jobStatus: "weaving" });
  });

  it("returns advanced:false when warping ref is missing", async () => {
    JobOrder.findById = jest.fn().mockReturnValue({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue({ _id: "job1", status: "preparatory", warping: null, covering: "c1" }),
      }),
    });

    const result = await checkAndAdvanceToWeaving("job1");
    expect(result).toEqual({ advanced: false, jobStatus: "preparatory" });
  });

  it("returns advanced:false when covering ref is missing", async () => {
    JobOrder.findById = jest.fn().mockReturnValue({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue({ _id: "job1", status: "preparatory", warping: "w1", covering: null }),
      }),
    });

    const result = await checkAndAdvanceToWeaving("job1");
    expect(result).toEqual({ advanced: false, jobStatus: "preparatory" });
  });

  it("returns advanced:false when warping is not completed", async () => {
    JobOrder.findById = jest.fn().mockReturnValue({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue({ _id: "job1", status: "preparatory", warping: "w1", covering: "c1" }),
      }),
    });

    Warping.findById = jest.fn().mockReturnValue({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue({ status: "pending" }) }) });
    Covering.findById = jest.fn().mockReturnValue({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue({ status: "completed" }) }) });

    const result = await checkAndAdvanceToWeaving("job1");
    expect(result).toEqual({ advanced: false, jobStatus: "preparatory" });
  });

  it("returns advanced:false when covering is not completed", async () => {
    JobOrder.findById = jest.fn().mockReturnValue({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue({ _id: "job1", status: "preparatory", warping: "w1", covering: "c1" }),
      }),
    });

    Warping.findById = jest.fn().mockReturnValue({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue({ status: "completed" }) }) });
    Covering.findById = jest.fn().mockReturnValue({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue({ status: "in-progress" }) }) });

    const result = await checkAndAdvanceToWeaving("job1");
    expect(result).toEqual({ advanced: false, jobStatus: "preparatory" });
  });

  it("advances job to weaving when both warping and covering are completed", async () => {
    JobOrder.findById = jest.fn().mockReturnValue({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue({ _id: "job1", status: "preparatory", warping: "w1", covering: "c1" }),
      }),
    });

    Warping.findById = jest.fn().mockReturnValue({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue({ status: "completed" }) }) });
    Covering.findById = jest.fn().mockReturnValue({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue({ status: "completed" }) }) });

    // The helper uses a GUARDED findOneAndUpdate (filter re-asserts
    // status: "preparatory") so a concurrent transition can't clobber a
    // status that already moved on — assert that contract.
    JobOrder.findOneAndUpdate = jest.fn().mockResolvedValue({ status: "weaving" });

    const result = await checkAndAdvanceToWeaving("job1");
    expect(result).toEqual({ advanced: true, jobStatus: "weaving" });
    expect(JobOrder.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: "job1", status: "preparatory" },
      { status: "weaving" },
      { new: true, select: "status" }
    );
  });

  it("no-ops and reports truth when a concurrent transition wins the race", async () => {
    // First read: preparatory. Re-read after losing the race: weaving.
    JobOrder.findById = jest.fn()
      .mockReturnValueOnce({
        select: jest.fn().mockReturnValue({
          lean: jest.fn().mockResolvedValue({ _id: "job1", status: "preparatory", warping: "w1", covering: "c1" }),
        }),
      })
      .mockReturnValueOnce({
        select: jest.fn().mockReturnValue({
          lean: jest.fn().mockResolvedValue({ _id: "job1", status: "weaving" }),
        }),
      });

    Warping.findById = jest.fn().mockReturnValue({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue({ status: "completed" }) }) });
    Covering.findById = jest.fn().mockReturnValue({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue({ status: "completed" }) }) });

    // Guarded update matches nothing — someone else already advanced it.
    JobOrder.findOneAndUpdate = jest.fn().mockResolvedValue(null);

    const result = await checkAndAdvanceToWeaving("job1");
    expect(result).toEqual({ advanced: false, jobStatus: "weaving" });
  });
});
