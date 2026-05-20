#!/usr/bin/env node
// scripts/backfill-order-reservations.js
// ─────────────────────────────────────────────────────────────
//  One-shot, idempotent backfill of Elastic reservations for
//  every order already in Approved or InProgress state at the
//  time PR E lands.
//
//  For each such order:
//    1. Sum already-dispatched quantity per elastic from
//       non-cancelled DCs linked to the order:
//         disp[el] = SUM(items.quantity where DC.order==order &&
//                        DC.status != "cancelled" && item.elastic==el)
//    2. For each elasticOrdered line:
//         remaining = max(0, ordered - disp)
//         if remaining > 0:
//           push {elastic, quantity: remaining} into order.reservations
//           $inc Elastic.reservedStock += remaining
//           emit RESERVATION_HOLD info-row + STOCK_RESERVED fp
//
//  Skip rule: orders whose reservations[] is already non-empty
//  are treated as already-backfilled (the route created them).
//
//  Run once per environment after the PR E deploy:
//    node scripts/backfill-order-reservations.js
// ─────────────────────────────────────────────────────────────
"use strict";

try { require("dotenv").config(); } catch (_) { /* dotenv optional */ }

const mongoose = require("mongoose");

const Order           = require("../models/Order");
const Elastic         = require("../models/Elastic");
const DeliveryChallan = require("../models/DeliveryChallan");
const { applyMovement } = require("../utils/elasticStock");
const { buildFingerprint, ACTION_CODES } = require("../utils/fingerprint");

async function main() {
  const uri = process.env.MONGO_URI || process.env.DB_URL || process.env.MONGO_URL;
  if (!uri) {
    console.error("MONGO_URI / DB_URL / MONGO_URL not set");
    process.exit(1);
  }

  await mongoose.connect(uri);
  console.log("Connected.");

  const orders = await Order.find({
    status: { $in: ["Approved", "InProgress"] },
  });
  console.log(`Scanning ${orders.length} Approved/InProgress orders.`);

  let backfilled    = 0;
  let alreadyDone   = 0;
  let zeroRemaining = 0;
  let totalReserved = 0;
  const errors      = [];

  for (const order of orders) {
    if ((order.reservations || []).length > 0) {
      alreadyDone++;
      continue;
    }
    if (!Array.isArray(order.elasticOrdered) || order.elasticOrdered.length === 0) {
      zeroRemaining++;
      continue;
    }

    // Compute already-dispatched quantity per elastic.
    const dcs = await DeliveryChallan.find({
      order:  order._id,
      type:   "elastic",
      status: { $ne: "cancelled" },
    }).select("items").lean();

    const dispatched = new Map();
    for (const dc of dcs) {
      for (const item of (dc.items || [])) {
        if (!item.elastic) continue;
        const key = item.elastic.toString();
        dispatched.set(
          key,
          (dispatched.get(key) || 0) + (Number(item.quantity) || 0)
        );
      }
    }

    const session = await mongoose.startSession();
    try {
      let reservedThisOrder = 0;
      await session.withTransaction(async () => {
        for (const line of order.elasticOrdered) {
          const ordered   = Number(line.quantity) || 0;
          const shipped   = dispatched.get(line.elastic.toString()) || 0;
          const remaining = Math.max(0, ordered - shipped);
          if (remaining <= 0) continue;

          const elasticDoc = await Elastic.findById(line.elastic).session(session);
          if (!elasticDoc) {
            console.warn(
              `  [order ${order.orderNo}] elastic ${line.elastic} missing, skipping`
            );
            continue;
          }
          elasticDoc.reservedStock = (Number(elasticDoc.reservedStock) || 0) + remaining;
          await elasticDoc.save({ session });

          order.reservations.push({
            elastic:  line.elastic,
            quantity: remaining,
          });

          await applyMovement(session, {
            elasticId: line.elastic,
            type:      "RESERVATION_HOLD",
            quantity:  +remaining,
            refType:   "Order",
            refId:     order._id,
            reason:    `Backfill: order ${order.orderNo} approved at ${order.approvedAt?.toISOString() || "unknown"}`,
          });

          const fp = buildFingerprint(ACTION_CODES.STOCK_RESERVED, {
            entityId: order._id,
            actor:    { id: "system", name: "Backfill", role: "system" },
            meta: {
              elasticId:   line.elastic.toString(),
              elasticName: elasticDoc.name,
              quantity:    remaining,
              ordered,
              shipped,
              backfilled:  true,
            },
          });
          order.fingerprints.push(fp);
          reservedThisOrder += remaining;
        }

        if (reservedThisOrder > 0) {
          await order.save({ session });
        }
      });

      if (reservedThisOrder > 0) {
        backfilled++;
        totalReserved += reservedThisOrder;
        console.log(
          `  [order ${order.orderNo}] reserved ${reservedThisOrder} unit(s) across ${order.reservations.length} elastic(s).`
        );
      } else {
        zeroRemaining++;
      }
    } catch (err) {
      errors.push({ orderNo: order.orderNo, message: err.message });
      console.error(`  [order ${order.orderNo}] FAILED:`, err.message);
    } finally {
      session.endSession();
    }
  }

  console.log(`\nBackfilled ${backfilled} orders (${totalReserved} total units reserved).`);
  console.log(`Already backfilled: ${alreadyDone}.`);
  console.log(`Zero remaining to reserve: ${zeroRemaining}.`);
  if (errors.length > 0) {
    console.log(`\n${errors.length} order(s) FAILED:`);
    for (const e of errors) console.log(`  order ${e.orderNo}: ${e.message}`);
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
