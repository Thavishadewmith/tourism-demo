const mongoose = require("mongoose");

async function connectDatabase() {
  const mongoUri = process.env.MONGO_URI || "mongodb://127.0.0.1:27017/tourpilot";

  mongoose.set("strictQuery", true);
  await mongoose.connect(mongoUri);

  return mongoose.connection;
}

module.exports = { connectDatabase };
