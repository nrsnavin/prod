// ══════════════════════════════════════════════════════════════════
//  WAIT FOR THE INDEXES BEFORE EACH TEST
//
//  Several rules are kept by a unique index, not by a lookup first: the
//  same supplier bill number twice, a replayed request id, a document
//  number taken twice. Mongoose builds a model's indexes in the
//  background when the model is first loaded, and on a fresh in-memory
//  database under a parallel run the first test could reach the second
//  insert before the index existed, so a duplicate went through and the
//  test failed on a 201 it never sees on its own.
//
//  Before each test, wait for every loaded model's first index build.
//  Model.init() hands back the same promise each time, so after the
//  first test this costs nothing. Only while connected: a unit test that
//  loads a model without a database must not wait for one that never
//  comes. A failed build is left for the test itself to meet.
// ══════════════════════════════════════════════════════════════════
const mongoose = require("mongoose");

beforeEach(async () => {
  if (!mongoose?.connection || mongoose.connection.readyState !== 1 || typeof mongoose.modelNames !== "function") return;
  await Promise.allSettled(mongoose.modelNames().map((name) => mongoose.model(name).init()));
});
