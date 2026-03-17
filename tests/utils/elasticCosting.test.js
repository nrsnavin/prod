"use strict";

jest.mock("../../models/RawMaterial");

const RawMaterial = require("../../models/RawMaterial");
const { calculateElasticCosting } = require("../../utils/elasticCosting");

const makeMaterial = (id, price) => ({
  _id: id,
  price,
});

describe("calculateElasticCosting", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("calculates material cost correctly for a simple elastic", async () => {
    RawMaterial.findById = jest.fn().mockImplementation((id) => {
      const map = {
        mat1: makeMaterial("mat1", 200),
        mat2: makeMaterial("mat2", 100),
        mat3: makeMaterial("mat3", 150),
      };
      return Promise.resolve(map[id] || null);
    });

    const elasticData = {
      warpSpandex: { id: "mat1", weight: 500 },
      spandexCovering: { id: "mat2", weight: 300 },
      weftYarn: { id: "mat3", weight: 400 },
      warpYarn: [],
    };

    const result = await calculateElasticCosting(elasticData);

    // cost = (price * quantity) / 1000
    // mat1: (200 * 500) / 1000 = 100
    // mat2: (100 * 300) / 1000 = 30
    // mat3: (150 * 400) / 1000 = 60
    // total = 190
    expect(result.materialCost).toBeCloseTo(190);
    expect(result.details).toHaveLength(3);
  });

  it("includes multiple warp yarns in the cost", async () => {
    RawMaterial.findById = jest.fn().mockImplementation((id) => {
      const map = {
        mat1: makeMaterial("mat1", 200),
        mat2: makeMaterial("mat2", 100),
        mat3: makeMaterial("mat3", 150),
        wy1: makeMaterial("wy1", 80),
        wy2: makeMaterial("wy2", 60),
      };
      return Promise.resolve(map[id] || null);
    });

    const elasticData = {
      warpSpandex: { id: "mat1", weight: 100 },
      spandexCovering: { id: "mat2", weight: 100 },
      weftYarn: { id: "mat3", weight: 100 },
      warpYarn: [
        { id: "wy1", weight: 250 },
        { id: "wy2", weight: 500 },
      ],
    };

    const result = await calculateElasticCosting(elasticData);

    // mat1: 20, mat2: 10, mat3: 15, wy1: 20, wy2: 30
    expect(result.materialCost).toBeCloseTo(95);
    expect(result.details).toHaveLength(5);
  });

  it("skips materials with zero or missing quantity", async () => {
    RawMaterial.findById = jest.fn().mockResolvedValue(makeMaterial("mat1", 200));

    const elasticData = {
      warpSpandex: { id: "mat1", weight: 0 },
      spandexCovering: { id: null, weight: 300 },
      weftYarn: { id: "mat1", weight: 500 },
      warpYarn: [],
    };

    const result = await calculateElasticCosting(elasticData);
    // Only weftYarn contributes: (200 * 500) / 1000 = 100
    expect(result.materialCost).toBeCloseTo(100);
    expect(result.details).toHaveLength(1);
  });

  it("throws when a raw material is not found in DB", async () => {
    RawMaterial.findById = jest.fn().mockResolvedValue(null);

    const elasticData = {
      warpSpandex: { id: "missing", weight: 100 },
      spandexCovering: { id: "mat2", weight: 100 },
      weftYarn: { id: "mat3", weight: 100 },
      warpYarn: [],
    };

    await expect(calculateElasticCosting(elasticData)).rejects.toThrow(
      "Raw material not found"
    );
  });

  it("returns zero cost and empty details when all quantities are zero", async () => {
    const elasticData = {
      warpSpandex: { id: "mat1", weight: 0 },
      spandexCovering: { id: "mat2", weight: 0 },
      weftYarn: { id: "mat3", weight: 0 },
      warpYarn: [],
    };

    const result = await calculateElasticCosting(elasticData);
    expect(result.materialCost).toBe(0);
    expect(result.details).toHaveLength(0);
  });

  it("detail entries contain correct fields", async () => {
    RawMaterial.findById = jest.fn().mockResolvedValue(makeMaterial("mat1", 400));

    const elasticData = {
      warpSpandex: { id: "mat1", weight: 250 },
      spandexCovering: { id: "mat1", weight: 0 },
      weftYarn: { id: "mat1", weight: 0 },
      warpYarn: [],
    };

    const result = await calculateElasticCosting(elasticData);
    const detail = result.details[0];

    expect(detail.type).toBe("material");
    expect(detail.description).toBe("Warp Spandex");
    expect(detail.quantity).toBe(250);
    expect(detail.rate).toBe(400);
    expect(detail.cost).toBeCloseTo(100); // (400 * 250) / 1000
  });
});
