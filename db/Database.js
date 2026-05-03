const mongoose = require("mongoose");

// BUG FIX: The original code did:
//   db = await mongoose.connect(...).then(data => { console.log(...) })
// .then() returns undefined (the callback has no return value), so `db`
// was always undefined. Also there was no error handling, so a failed
// connection would surface only as mysterious downstream query errors.
const connectDatabase = async () => {
  try {
    const data = await mongoose.connect(process.env.MONGO_URL, {});
    console.log(`mongod connected with server: ${data.connection.host}`);
  } catch (err) {
    console.error(`MongoDB connection failed: ${err.message}`);
    process.exit(1);
  }
};

module.exports = { connectDatabase };
