const express = require("express");
const router = express.Router();

const { isAuthenticated, isAdmin } = require("../middleware/auth");
const catchAsyncErrors = require("../middleware/catchAsyncErrors");
const ErrorHandler = require("../utils/ErrorHandler");

const Elastic = require("../models/Elastic");
const RawMaterial = require("../models/RawMaterial");
const Costing = require("../models/Costing");


router.post(
  "/create",
  // isAuthenticated,
  catchAsyncErrors(async (req, res, next) => {
    const elasticData = req.body;

    let materialCost = 0;
    const costDetails = [];

    // 🔹 Helper to calculate material cost
    const addMaterialCost = async (materialId, weight) => {
      const material = await RawMaterial.findById(materialId);
      if (!material) {
        throw new Error(`Raw material not found`);
      }

      const cost = (material.price * weight) / 1000;
      materialCost += cost;

      costDetails.push({
        type: "material",
        description: material.name,
        quantity: weight,
        rate: material.price,
        cost,
      });
    };

    // 🧶 Spandex covering
    await addMaterialCost(
      elasticData.spandexCovering.id,
      elasticData.spandexCovering.weight
    );

    // 🧶 Warp spandex (rubber)
    await addMaterialCost(
      elasticData.warpSpandex.id,
      elasticData.warpSpandex.weight
    );

    // 🧵 Weft yarn
    await addMaterialCost(
      elasticData.weftYarn.id,
      elasticData.weftYarn.weight
    );

    // 🧵 Warp yarns (MULTIPLE)
    for (const yarn of elasticData.warpYarn) {
      await addMaterialCost(yarn.id, yarn.weight);
    }

    // 🧵 CREATE ELASTIC
    const elastic = await Elastic.create({
      name: elasticData.name,
      weaveType: elasticData.weaveType,

      warpSpandex: elasticData.warpSpandex,
      warpYarn: elasticData.warpYarn,
      spandexCovering: elasticData.spandexCovering,
      weftYarn: elasticData.weftYarn,

      spandexEnds: elasticData.spandexEnds,
      yarnEnds: elasticData.yarnEnds,
      pick: Number(elasticData.pick),
      noOfHook: Number(elasticData.noOfHook),
      weight: Number(elasticData.weight),

      testingParameters: elasticData.testingParameters,
      image: elasticData.image,
    });

    // 💰 CREATE COSTING
    const costing = await Costing.create({
      date: new Date(),
      elastic: elastic._id,
      materialCost,
      details: costDetails,
      totalCost: materialCost,
      status: "Final",
    });

    elastic.costing = costing._id;
    await elastic.save();

    res.status(201).json({
      success: true,
      data: elastic,
    });
  })
);


router.get(
  "/all",
  catchAsyncErrors(async (req, res) => {
    const elastics = await Elastic.find()
      .sort({ createdAt: -1 })
      .populate("costing");

    res.status(200).json({
      success: true,
      count: elastics.length,
      data: elastics,
    });
  })
);


router.get(
  "/:id",
  catchAsyncErrors(async (req, res, next) => {
    const elastic = await Elastic.findById(req.params.id)
      .populate("warpSpandex.id")
      .populate("spandexCovering.id")
      .populate("weftYarn.id")
      .populate("warpYarn.id")
      .populate("costing");

    if (!elastic) {
      return next(new ErrorHandler("Elastic not found", 404));
    }

    res.status(200).json({
      success: true,
      data: elastic,
    });
  })
);



module.exports = router;