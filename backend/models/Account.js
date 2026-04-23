const mongoose = require("mongoose");

const accountSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true
    },
    phone: {
      type: String,
      required: true,
      trim: true,
      unique: true,
      index: true
    },
    accountType: {
      type: String,
      required: true,
      trim: true,
      enum: ["agent", "driver", "traveler"]
    }
  },
  {
    timestamps: true,
    versionKey: false
  }
);

module.exports = mongoose.model("Account", accountSchema);
