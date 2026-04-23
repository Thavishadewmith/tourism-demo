require("dotenv").config();
const fs = require("fs/promises");
const path = require("path");
const { connectDatabase } = require("../db/connect");
const Account = require("../models/Account");

async function readSeedAccounts() {
  const storePath = path.join(__dirname, "..", "data", "store.json");
  const raw = await fs.readFile(storePath, "utf8");
  const store = JSON.parse(raw);
  return Array.isArray(store.accounts) ? store.accounts : [];
}

async function main() {
  await connectDatabase();
  const accounts = await readSeedAccounts();

  for (const account of accounts) {
    await Account.updateOne(
      { phone: account.phone },
      {
        $set: {
          name: account.name,
          phone: account.phone,
          accountType: account.accountType
        }
      },
      { upsert: true }
    );
  }

  console.log(`Seeded ${accounts.length} account(s) into MongoDB.`);
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
