const express = require("express");
const router = express.Router();

const { isAuthenticated, isAdmin } = require("../middleware/auth");
const catchAsyncErrors = require("../middleware/catchAsyncErrors");
const ErrorHandler = require("../utils/ErrorHandler");

const Elastic = require("../models/Elastic");
const RawMaterial = require("../models/RawMaterial");
const Costing = require("../models/Costing");

const { calculateElasticCosting } = require("../utils/elasticCosting.js");


async function calculateElasticCost(elasticData) {
  let totalCost = 0;
  const breakdown = [];

  const addCost = async (materialId, weight, category) => {
    const material = await RawMaterial.findById(materialId);
    if (!material) throw new Error("Raw material not found");

    const cost = (material.price * weight) / 1000;
    totalCost += cost;

    breakdown.push({
      material: material.name,
      category,
      rate: material.price,
      weight,
      cost,
    });
  };

  // Warp Spandex
  await addCost(
    elasticData.warpSpandex.id,
    elasticData.warpSpandex.weight,
    "Spandex"
  );

  // Covering
  await addCost(
    elasticData.spandexCovering.id,
    elasticData.spandexCovering.weight,
    "Covering"
  );

  // Weft
  await addCost(
    elasticData.weftYarn.id,
    elasticData.weftYarn.weight,
    "Weft"
  );

  // Warp Yarns
  for (const w of elasticData.warpYarn) {
    await addCost(w.id, w.weight, "Warp Yarn");
  }

  return { totalCost, breakdown };
}



// router.post(
//   "/create-elastic",
//   // isAuthenticated,
//   catchAsyncErrors(async (req, res, next) => {
//     const elasticData = req.body;

//     let materialCost = 0;
//     const costDetails = [];

//     // 🔹 Helper to calculate material cost
//     const addMaterialCost = async (materialId, weight) => {
//       const material = await RawMaterial.findById(materialId);
//       if (!material) {
//         throw new Error(`Raw material not found`);
//       }

//       const cost = (material.price * weight) / 1000;
//       materialCost += cost;

//       costDetails.push({
//         type: "material",
//         description: material.name,
//         quantity: weight,
//         rate: material.price,
//         cost,
//       });
//     };

//     // 🧶 Spandex covering
//     await addMaterialCost(
//       elasticData.spandexCovering.id,
//       elasticData.spandexCovering.weight
//     );

//     // 🧶 Warp spandex (rubber)
//     await addMaterialCost(
//       elasticData.warpSpandex.id,
//       elasticData.warpSpandex.weight
//     );

//     // 🧵 Weft yarn
//     await addMaterialCost(
//       elasticData.weftYarn.id,
//       elasticData.weftYarn.weight
//     );

//     // 🧵 Warp yarns (MULTIPLE)
//     for (const yarn of elasticData.warpYarn) {
//       await addMaterialCost(yarn.id, yarn.weight);
//     }

//     // 🧵 CREATE ELASTIC
//     const elastic = await Elastic.create({
//       name: elasticData.name,
//       weaveType: elasticData.weaveType,

//       warpSpandex: elasticData.warpSpandex,
//       warpYarn: elasticData.warpYarn,
//       spandexCovering: elasticData.spandexCovering,
//       weftYarn: elasticData.weftYarn,

//       spandexEnds: elasticData.spandexEnds,
//       yarnEnds: elasticData.yarnEnds,
//       pick: Number(elasticData.pick),
//       noOfHook: Number(elasticData.noOfHook),
//       weight: Number(elasticData.weight),

//       testingParameters: elasticData.testingParameters,
//       image: elasticData.image,
//     });

//     // 💰 CREATE COSTING
//     const costing = await Costing.create({
//       date: new Date(),
//       elastic: elastic._id,
//       materialCost,
//       details: costDetails,
//       totalCost: materialCost,
//       status: "Final",
//     });

//     elastic.costing = costing._id;
//     await elastic.save();

//     res.status(201).json({
//       success: true,
//       data: elastic,
//     });
//   })
// );
router.post(
  "/create-elastic",
  catchAsyncErrors(async (req, res, next) => {
    try {
      const elasticData = req.body;

      console.log("Received elastic data:", elasticData);

      // 1️⃣ Create Elastic first
      const elastic = await Elastic.create(elasticData);

      // 2️⃣ Calculate costing
      const { materialCost, details } =
        await calculateElasticCosting(elasticData);

        console.log("Calculated material cost:", materialCost);
        console.log("Cost breakdown:", details);

      const conversionCost = elasticData.conversionCost ?? 1.25;
      const totalCost = materialCost + conversionCost;

      // 3️⃣ Save Costing
      const costing = await Costing.create({
        date: new Date(),
        elastic: elastic._id,
        conversionCost,
        materialCost,
        details,
        totalCost,
        status: "Draft",
      });
      console.log("Costing created:", costing);
      // 4️⃣ Attach costing to elastic
      elastic.costing = costing._id;
      await elastic.save();

      res.status(201).json({
        success: true,
        elastic,
        costing,
      });
    } catch (err) {
      console.error(err);
      return next(new ErrorHandler(err.message, 400));
    }
  })
);


// router.get(
//   "/all",
//   catchAsyncErrors(async (req, res) => {
//     const elastics = await Elastic.find()
//       .sort({ createdAt: -1 })
//       .populate("costing");

//     res.status(200).json({
//       success: true,
//       count: elastics.length,
//       data: elastics,
//     });
//   })
// );


router.get(
  "/get-elastics",
  catchAsyncErrors(async (req, res) => {
    const { search = "", page = 1, limit = 20 } = req.query;

    const filter = search
      ? { name: { $regex: search, $options: "i" } }
      : {};

    const elastics = await Elastic.find(filter)
      .skip((page - 1) * limit)
      .limit(Number(limit))
      .sort({ createdAt: -1 });

    const total = await Elastic.countDocuments(filter);

    res.json({
      success: true,
      elastics,
      total,
      page: Number(page),
    });
  })
);

router.get(
  "/get-elastic-detail",
  catchAsyncErrors(async (req, res, next) => {
    const elastic = await Elastic.findById(req.query.id)
      .populate("warpSpandex.id")
      .populate("spandexCovering.id")
      .populate("weftYarn.id")
      .populate("warpYarn.id")
      .populate("costing");

    if (!elastic)
      return next(new ErrorHandler("Elastic not found", 404));

    res.json({
      success: true,
      elastic,
    });
  })
);


router.put(
  "/update-elastic",
  catchAsyncErrors(async (req, res, next) => {
    const elastic = await Elastic.findById(req.body._id);
    if (!elastic)
      return next(new ErrorHandler("Elastic not found", 404));

    const { totalCost, breakdown } =
      await calculateElasticCost(req.body);

    Object.assign(elastic, req.body);
    await elastic.save();

    await Costing.findByIdAndUpdate(elastic.costing, {
      materialCost: totalCost,
      details: breakdown,
    });

    res.json({ success: true, elastic });
  })
);


router.post(
  "/recalculate-elastic-cost",
  catchAsyncErrors(async (req, res) => {
    const elastic = await Elastic.findById(req.body.elasticId);
    if (!elastic)
      return res.status(404).json({ success: false });

    const { totalCost, breakdown } =
      await calculateElasticCost(elastic);

    await Costing.findByIdAndUpdate(elastic.costing, {
      materialCost: totalCost,
      details: breakdown,
    });

    res.json({ success: true });
  })
);



// router.get(
//   "/:id",
//   catchAsyncErrors(async (req, res, next) => {
//     const elastic = await Elastic.findById(req.params.id)
//       .populate("warpSpandex.id")
//       .populate("spandexCovering.id")
//       .populate("weftYarn.id")
//       .populate("warpYarn.id")
//       .populate("costing");

//     if (!elastic) {
//       return next(new ErrorHandler("Elastic not found", 404));
//     }

//     res.status(200).json({
//       success: true,
//       data: elastic,
//     });
//   })
// );



module.exports = router;