const express = require("express");
const cors = require("cors");
const morgan = require("morgan");
require("dotenv").config();
const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { connectDatabase } = require("./db/connect");
const Account = require("./models/Account");

const app = express();
const PORT = process.env.PORT || 4000;
const STORE_PATH = path.join(__dirname, "data", "store.json");

// Runtime auth stores (OTP + sessions).
const otpSessions = new Map();
const pendingRegistrations = new Map();
const authSessions = new Map();

app.use(cors());
app.use(express.json());
app.use(morgan("dev"));

function createId(prefix) {
  return `${prefix}_${crypto.randomUUID().slice(0, 8)}`;
}

async function readStore() {
  const raw = await fs.readFile(STORE_PATH, "utf8");
  return JSON.parse(raw);
}

async function writeStore(data) {
  await fs.writeFile(STORE_PATH, JSON.stringify(data, null, 2));
}

function normalizeType(type) {
  return String(type || "").trim().toLowerCase();
}

function normalizePhone(phone) {
  return String(phone || "").replace(/\D/g, "");
}

function dashboardForAccountType(accountType) {
  if (accountType === "driver") {
    return "driverdashboard.html";
  }

  if (accountType === "agent") {
    return "agentdashboard.html";
  }

  return "tourism-landing (1).html";
}

async function getAccountByPhone(phone) {
  return Account.findOne({ phone }).lean();
}

async function accountExists(phone) {
  return Boolean(await getAccountByPhone(phone));
}

async function seedAccountsIfEmpty() {
  const existingCount = await Account.countDocuments();
  if (existingCount > 0) {
    return;
  }

  const store = await readStore();
  const accounts = Array.isArray(store.accounts) ? store.accounts : [];
  if (accounts.length === 0) {
    return;
  }

  await Account.insertMany(
    accounts.map((account) => ({
      name: account.name,
      phone: account.phone,
      accountType: account.accountType
    }))
  );
}

function assertRequired(fields, payload) {
  const missing = fields.filter((f) => !String(payload[f] ?? "").trim());
  if (missing.length) {
    const err = new Error(`Missing required fields: ${missing.join(", ")}`);
    err.status = 400;
    throw err;
  }
}

function authMiddleware(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";

  if (!token || !authSessions.has(token)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  req.session = authSessions.get(token);
  next();
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "tourism-backend" });
});

app.post("/api/auth/register-request", async (req, res) => {
  try {
    const name = String(req.body.name || "").trim();
    const phone = normalizePhone(req.body.phone);
    const accountType = normalizeType(req.body.accountType);

    assertRequired(["name", "phone", "accountType"], { name, phone, accountType });

    if (!/^[0-9]{10}$/.test(phone)) {
      return res.status(400).json({ error: "Phone must be 10 digits" });
    }

    if (await accountExists(phone) || pendingRegistrations.has(phone)) {
      return res.status(409).json({ error: "An account already exists for this phone number" });
    }

    const otp = String(Math.floor(100000 + Math.random() * 900000));
    const otpToken = createId("reg");

    pendingRegistrations.set(phone, {
      name,
      phone,
      accountType,
      otp,
      otpToken,
      expiresAt: Date.now() + 5 * 60 * 1000
    });

    res.json({
      otpToken,
      otp,
      accountType,
      message: "Registration OTP generated (demo mode)"
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || "Internal Server Error" });
  }
});

app.post("/api/auth/verify-registration", async (req, res) => {
  try {
    const phone = normalizePhone(req.body.phone);
    const otp = String(req.body.otp || "").trim();
    const otpToken = String(req.body.otpToken || "").trim();

    const pending = pendingRegistrations.get(phone);
    if (!pending || pending.otpToken !== otpToken) {
      return res.status(400).json({ error: "Invalid registration request" });
    }

    if (Date.now() > pending.expiresAt) {
      pendingRegistrations.delete(phone);
      return res.status(400).json({ error: "OTP expired" });
    }

    if (pending.otp !== otp) {
      return res.status(400).json({ error: "Invalid OTP" });
    }

    if (await accountExists(phone)) {
      pendingRegistrations.delete(phone);
      return res.status(409).json({ error: "An account already exists for this phone number" });
    }

    const account = await Account.create({
      name: pending.name,
      phone,
      accountType: pending.accountType
    });

    pendingRegistrations.delete(phone);

    const token = createId("sess");
    authSessions.set(token, { phone, accountType: account.accountType, createdAt: Date.now() });

    res.json({
      token,
      account: account.toObject(),
      redirectTo: dashboardForAccountType(account.accountType),
      message: "Account created successfully"
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || "Internal Server Error" });
  }
});

app.post("/api/auth/send-otp", async (req, res) => {
  try {
    const phone = normalizePhone(req.body.phone);
    if (!/^\d{10}$/.test(phone)) {
      return res.status(400).json({ error: "Phone must be 10 digits" });
    }

    const account = await getAccountByPhone(phone);
    if (!account) {
      return res.status(404).json({ error: "No account found for this phone number" });
    }

    const otp = String(Math.floor(100000 + Math.random() * 900000));
    const otpToken = createId("otp");
    otpSessions.set(otpToken, { phone, otp, expiresAt: Date.now() + 5 * 60 * 1000 });

    // Demo mode: include OTP in response for local frontend testing.
    res.json({
      otpToken,
      otp,
      accountType: account.accountType,
      redirectTo: dashboardForAccountType(account.accountType),
      message: "OTP generated (demo mode)"
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || "Internal Server Error" });
  }
});

app.post("/api/auth/verify-otp", async (req, res) => {
  try {
    const phone = normalizePhone(req.body.phone);
    const otp = String(req.body.otp || "").trim();
    const otpToken = String(req.body.otpToken || "").trim();

    const record = otpSessions.get(otpToken);
    if (!record) {
      return res.status(400).json({ error: "Invalid otpToken" });
    }

    if (Date.now() > record.expiresAt) {
      otpSessions.delete(otpToken);
      return res.status(400).json({ error: "OTP expired" });
    }

    if (record.phone !== phone || record.otp !== otp) {
      return res.status(400).json({ error: "Invalid phone or OTP" });
    }

    const account = await getAccountByPhone(phone);
    if (!account) {
      otpSessions.delete(otpToken);
      return res.status(404).json({ error: "No account found for this phone number" });
    }

    otpSessions.delete(otpToken);
    const token = createId("sess");
    authSessions.set(token, { phone, accountType: account.accountType, createdAt: Date.now() });

    res.json({
      token,
      account,
      redirectTo: dashboardForAccountType(account.accountType),
      message: "Login successful"
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || "Internal Server Error" });
  }
});

app.get("/api/auth/me", authMiddleware, async (req, res, next) => {
  try {
    const account = await getAccountByPhone(req.session.phone);

    if (!account) {
      return res.status(404).json({ error: "Account not found" });
    }

    res.json({ account, redirectTo: dashboardForAccountType(account.accountType) });
  } catch (err) {
    next(err);
  }
});

app.get("/api/entities", authMiddleware, async (req, res, next) => {
  try {
    const store = await readStore();
    const type = normalizeType(req.query.type || "all");
    const entities = type === "all" ? store.entities : store.entities.filter((e) => normalizeType(e.type) === type);
    res.json(entities);
  } catch (err) {
    next(err);
  }
});

app.post("/api/entities", authMiddleware, async (req, res, next) => {
  try {
    assertRequired(["name", "type", "city", "rooms", "price", "contact"], req.body);
    const store = await readStore();

    const entity = {
      id: createId("ent"),
      name: String(req.body.name).trim(),
      type: normalizeType(req.body.type),
      city: String(req.body.city).trim(),
      rooms: String(req.body.rooms).trim(),
      price: String(req.body.price).trim(),
      contact: String(req.body.contact).trim(),
      notes: String(req.body.notes || "").trim(),
      createdAt: new Date().toISOString()
    };

    store.entities.push(entity);
    await writeStore(store);
    res.status(201).json(entity);
  } catch (err) {
    next(err);
  }
});

app.get("/api/drivers", authMiddleware, async (req, res, next) => {
  try {
    const store = await readStore();
    const status = String(req.query.status || "all");
    const drivers = status === "all" ? store.drivers : store.drivers.filter((d) => d.status === status);
    res.json(drivers);
  } catch (err) {
    next(err);
  }
});

app.post("/api/drivers", authMiddleware, async (req, res, next) => {
  try {
    assertRequired(["name", "license", "phone", "vehicle", "status"], req.body);
    const store = await readStore();

    const driver = {
      id: createId("drv"),
      name: String(req.body.name).trim(),
      license: String(req.body.license).trim(),
      phone: String(req.body.phone).trim(),
      vehicle: String(req.body.vehicle).trim(),
      status: String(req.body.status).trim(),
      createdAt: new Date().toISOString()
    };

    store.drivers.push(driver);
    await writeStore(store);
    res.status(201).json(driver);
  } catch (err) {
    next(err);
  }
});

app.patch("/api/drivers/:id/status", authMiddleware, async (req, res, next) => {
  try {
    assertRequired(["status"], req.body);
    const store = await readStore();
    const driver = store.drivers.find((d) => d.id === req.params.id);

    if (!driver) {
      return res.status(404).json({ error: "Driver not found" });
    }

    driver.status = String(req.body.status).trim();
    await writeStore(store);
    res.json(driver);
  } catch (err) {
    next(err);
  }
});

app.get("/api/tours", authMiddleware, async (req, res, next) => {
  try {
    const store = await readStore();
    res.json(store.tours);
  } catch (err) {
    next(err);
  }
});

app.post("/api/tours", authMiddleware, async (req, res, next) => {
  try {
    assertRequired(["title"], req.body);
    const days = Array.isArray(req.body.days) ? req.body.days : [];

    if (!days.length || days.some((day) => !Array.isArray(day.entries) || !day.entries.length)) {
      return res.status(400).json({ error: "Each day must contain at least one entry" });
    }

    const store = await readStore();
    const tour = {
      id: createId("tour"),
      title: String(req.body.title).trim(),
      status: String(req.body.status || "Ready"),
      time: `Ready-Made ${days.length} Days`,
      days,
      createdAt: new Date().toISOString()
    };

    store.tours.push(tour);
    await writeStore(store);
    res.status(201).json(tour);
  } catch (err) {
    next(err);
  }
});

app.get("/api/groups", authMiddleware, async (req, res, next) => {
  try {
    const store = await readStore();
    res.json(store.groups);
  } catch (err) {
    next(err);
  }
});

app.get("/api/groups/:id", authMiddleware, async (req, res, next) => {
  try {
    const store = await readStore();
    const group = store.groups.find((g) => g.id === req.params.id);
    if (!group) {
      return res.status(404).json({ error: "Group not found" });
    }
    res.json(group);
  } catch (err) {
    next(err);
  }
});

app.post("/api/groups", authMiddleware, async (req, res, next) => {
  try {
    assertRequired(["title"], req.body);
    const entityIds = Array.isArray(req.body.entityIds) ? req.body.entityIds : [];
    if (!entityIds.length) {
      return res.status(400).json({ error: "entityIds must contain at least one ID" });
    }

    const store = await readStore();
    const items = store.entities.filter((e) => entityIds.includes(e.id));

    const group = {
      id: createId("grp"),
      title: String(req.body.title).trim(),
      items,
      createdAt: new Date().toISOString()
    };

    store.groups.push(group);
    await writeStore(store);
    res.status(201).json(group);
  } catch (err) {
    next(err);
  }
});

app.use((err, _req, res, _next) => {
  const status = err.status || 500;
  res.status(status).json({
    error: err.message || "Internal Server Error"
  });
});

async function startServer() {
  await connectDatabase();
  await seedAccountsIfEmpty();
  app.listen(PORT, () => {
    console.log(`Backend running at http://localhost:${PORT}`);
  });
}

startServer().catch((error) => {
  console.error("Failed to start backend:", error);
  process.exit(1);
});
