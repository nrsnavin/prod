const express = require("express");
const { isAuthenticated, isAdmin } = require("../middleware/auth");
const catchAsyncErrors = require("../middleware/catchAsyncErrors");
const router = express.Router();
const RawMaterial = require("../models/RawMaterial.js");
const ErrorHandler = require("../utils/ErrorHandler");





router.post(
  "/create-raw-material",
  // isAuthenticated,
  catchAsyncErrors(async (req, res, next) => {
    try {
      const {
        name,
        category,
        stock,
        minStock,
        supplier,
        price,
      } = req.body;

      if (!name || !category || !supplier) {
        return next(new ErrorHandler("Missing required fields", 400));
      }

      const material = await RawMaterial.create({
        name,
        category,
        stock: stock || 0,
        minStock: minStock || 0,
        supplier,
        price: price || 0,
      });



      console.log(material)
      res.status(201).json({
        success: true,
        material,
      });
    } catch (error) {
      console.log(error);
      return next(new ErrorHandler(error.message, 400));
    }
  })
);




router.post(
  "/material-Inward",

  catchAsyncErrors(async (req, res, next) => {
    try {
      const materialData = req.body;
      console.log(materialData);

      materialData.materials.forEach(async element => {
        const raw = await RawMaterial.findById(element.id);
        raw.stock += element.quantity;
        raw.materialsInward.push({
          date: materialData.date,
          po: materialData.po,
          reference: materialData.reference
        })

        await raw.save();
      });


      res.status(201).json({
        success: true,

      });
    } catch (error) {
      console.log(error);
      return next(new ErrorHandler(error, 400));
    }
  })
);


// router.get(
//   "/all-materials",
//   // isAuthenticated,
//   catchAsyncErrors(async (req, res, next) => {
//     try {
//       const materials = await RawMaterial.find().sort({
//         createdAt: -1,
//       });
//       res.status(201).json({
//         success: true,
//         materials,
//       });
//     } catch (error) {
//       return next(new ErrorHandler(error.message, 500));
//     }
//   })
// );


router.get(
  "/get-raw-materials",
  catchAsyncErrors(async (req, res, next) => {
    try {
      const { search, category } = req.query;

      console.log("Search:", search, "Category:", category);

      const filter = {};

      if (category) {
        filter.category = category;
      }

      if (search) {
        filter.name = { $regex: search, $options: "i" };
      }

      if (req.query.lowStock === "true") {
        filter.$expr = { $lte: ["$stock", "$minStock"] };
      }

      const materials = await RawMaterial.find(filter)
        .populate("supplier", "name")
        .sort({ createdAt: -1 });

      console.log(materials)

      res.status(200).json({
        success: true,
        materials,
      });
    } catch (error) {
      console.log(error);
      return next(new ErrorHandler(error.message, 500));
    }
  })
);



// router.get(


//   "/material",
//   // isAuthenticated,
//   catchAsyncErrors(async (req, res, next) => {
//     try {
//       const materialsByCategory = await RawMaterial.find({ category: req.query.category }).sort({
//         createdAt: -1,
//       });
//       res.status(201).json({
//         success: true,
//         materialsByCategory,
//       });
//     } catch (error) {
//       return next(new ErrorHandler(error.message, 500));
//     }
//   })
// );


router.get(
  "/get-raw-material-detail",
  catchAsyncErrors(async (req, res, next) => {
    try {
      const { id } = req.query;

    if (!id) {
      return next(new ErrorHandler("Material ID required", 400));
    }

    const material = await RawMaterial.findById(id)
      .populate("stockMovements.order", "orderNo")
      .lean();

    if (!material) {
      return next(new ErrorHandler("Raw material not found", 404));
    }

    // 🔥 LAST 30 MOVEMENTS (LATEST FIRST)
    material.stockMovements = material.stockMovements
      .sort((a, b) => new Date(b.date) - new Date(a.date))
      .slice(0, 30);

    res.status(200).json({
      success: true,
      material,
    });
    } catch (error) {
      return next(new ErrorHandler(error.message, 500));
    }
  })
);



router.put(
  "/edit-raw-material",
  // isAuthenticated,
  catchAsyncErrors(async (req, res, next) => {
    try {
      const material = await RawMaterial.findByIdAndUpdate(
        req.body._id,
        req.body,
        { new: true }
      );

      if (!material) {
        return next(new ErrorHandler("Raw material not found", 404));
      }

      res.status(200).json({
        success: true,
        material,
      });
    } catch (error) {
      return next(new ErrorHandler(error.message, 400));
    }
  })
);

router.get(
  "/materials",
  // isAuthenticated,
  catchAsyncErrors(async (req, res, next) => {
    try {
      const materials = await RawMaterial.find().sort({
        createdAt: -1,
      });
      res.status(201).json({
        success: true,
        materials,
      });
    } catch (error) {
      return next(new ErrorHandler(error.message, 500));
    }
  })
);


router.get(
  "/get-low-stock-materials",
  catchAsyncErrors(async (req, res, next) => {
    try {
      const materials = await RawMaterial.find({
        $expr: { $lte: ["$stock", "$minStock"] },
      }).sort({ stock: 1 });

      res.status(200).json({
        success: true,
        materials,
      });
    } catch (error) {
      return next(new ErrorHandler(error.message, 500));
    }
  })
);



router.get(
  "/get-rubbers",
  // isAuthenticated,
  catchAsyncErrors(async (req, res, next) => {
    try {
      const rubbers = await RawMaterial.find({ category: 'rubber' }).sort({
        createdAt: -1,
      });
      res.status(200).json({
        success: true,
        rubbers,
      });
    } catch (error) {
      return next(new ErrorHandler(error.message, 500));
    }
  })
);


router.get(
  "/get-warpYarns",
  // isAuthenticated,
  catchAsyncErrors(async (req, res, next) => {
    try {
      const yarns = await RawMaterial.find({ category: 'warp' }).sort({
        createdAt: -1,
      });
      res.status(200).json({
        success: true,
        yarns,
      });
    } catch (error) {
      return next(new ErrorHandler(error.message, 500));
    }
  })
);


router.get(
  "/materialForNewElastic",
  //isAuthenticated,
  catchAsyncErrors(async (req, res, next) => {
    try {
      const warp = await RawMaterial.find({ category: 'warp' }).sort({
        createdAt: -1,
      });
      const rubber = await RawMaterial.find({ category: 'rubber' }).sort({
        createdAt: -1,
      });

      const weft = await RawMaterial.find({ category: 'weft' }).sort({
        createdAt: -1,
      });


      const covering = await RawMaterial.find({ category: 'covering' }).sort({
        createdAt: -1,
      });

      res.status(200).json(
        //rubber
        { warp, weft, rubber, covering },
      );
    } catch (error) {
      return next(new ErrorHandler(error.message, 500));
    }
  })
);

router.get(
  "/get-wefts",
  // isAuthenticated,
  catchAsyncErrors(async (req, res, next) => {
    try {
      const wefts = await RawMaterial.find({ category: 'weft' }).sort({
        createdAt: -1,
      });
      res.status(200).json({
        success: true,
        wefts,
      });
    } catch (error) {
      return next(new ErrorHandler(error.message, 500));
    }
  })
);

router.get(
  "/get-coverings",
  // isAuthenticated,
  catchAsyncErrors(async (req, res, next) => {
    try {
      const coverings = await RawMaterial.find({ category: 'covering' }).sort({
        createdAt: -1,
      });
      res.status(200).json({
        success: true,
        coverings,
      });
    } catch (error) {
      return next(new ErrorHandler(error.message, 500));
    }
  })
);


module.exports = router;