require("dotenv").config();

const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");
const { Storage } = require("@google-cloud/storage");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

const app = express();
app.use(cors());
app.use(express.json());

// ===== ENV =====
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const GROUP_USER_JOIN = process.env.TG_GROUP_USER_JOIN; // -100...
const GROUP_ADMIN_REPORT = process.env.TG_GROUP_ADMIN_REPORT; // -100...
const ADMIN_GROUP_ID = process.env.ADMIN_GROUP_ID || GROUP_ADMIN_REPORT;
const GCS_BUCKET = process.env.GCS_BUCKET_NAME;
const ADMIN_SECRET = process.env.ADMIN_SECRET || "";
const AUTH_SECRET = process.env.AUTH_SECRET || process.env.ADMIN_SECRET || "CHANGE_ME_AUTH_SECRET";
const MONGO_URL = process.env.MONGO_URL || "mongodb://root:example@localhost:27017";

const DAILY_LIMIT = 5;

// Public info
const GROUP_LINK = "https://t.me/tipsmega888chat";
const BOT_USERNAME = "@TIPSMEGA888OTPBOT";
const OTP_TTL_MS = 3 * 60 * 1000; // 3 min

// ===== CONNECT MONGODB =====
mongoose.connect(MONGO_URL)
  .then(() => console.log("✅ Connected to MongoDB"))
  .catch(err => {
    console.error("❌ MongoDB connection error:", err);
    process.exit(1);
  });

// ===== SCHEMAS =====

// 1. Settings (Approval Mode)
const SettingSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true }, // 'approval'
  mode: { type: String, default: "AUTO" }, // 'AUTO' | 'MANUAL'
  updatedBy: Number,
}, { timestamps: true });
const Setting = mongoose.model("Setting", SettingSchema);

// 2. Telegram User Mapping
const TgUserSchema = new mongoose.Schema({
  tgUserId: { type: String, required: true, unique: true }, // Use string for safety
  phone: { type: String, required: true, index: true }, // +E164
}, { timestamps: true });
const TgUser = mongoose.model("TgUser", TgUserSchema);

// 3. User (Website Account)
const UserSchema = new mongoose.Schema({
  phone: { type: String, required: true, unique: true }, // _id
  username: { type: String, required: true, unique: true },
  passSalt: String,
  passHash: String,
  verified: { type: Boolean, default: false },
  referralCode: { type: String, unique: true, sparse: true },
  referredBy: String, // phone of referrer
  referralCount: { type: Number, default: 0 },
  bonusStars: { type: Number, default: 0 }, // Pending/Accumulated bonus to be granted to device
  totalClaimedStars: { type: Number, default: 0 },
  bonusGranted: { type: Boolean, default: false }, // Legacy flag
  bonusDeviceId: String,
}, { timestamps: true });
const User = mongoose.model("User", UserSchema);

// 4. Device (Credits & Usage)
const DeviceSchema = new mongoose.Schema({
  deviceId: { type: String, required: true, unique: true },
  stars: { type: Number, default: 0 },
  lastActiveDate: String, // '2025-01-23'
}, { timestamps: true });
const Device = mongoose.model("Device", DeviceSchema);

// 5. Web OTP (Temporary)
const WebOtpSchema = new mongoose.Schema({
  phone: { type: String, required: true, unique: true },
  tgUserId: String,
  otpHash: String,
  expiresAt: Date,
  attempts: { type: Number, default: 0 }
}, { timestamps: true });
// TTL Index for auto-deletion
WebOtpSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
const WebOtp = mongoose.model("WebOtp", WebOtpSchema);

// 6. Companies
const CompanySchema = new mongoose.Schema({
  name: { type: String, required: true, unique: true }, // ID-like
  link: String,
  caption: String,
  status: { type: String, default: "ACTIVE" },
  mediaType: String, // photo/video
  storageUrl: String,
}, { timestamps: true });
const Company = mongoose.model("Company", CompanySchema);

// 7. Logs (Scan & Referral)
const ScanLogSchema = new mongoose.Schema({
  deviceId: String,
  megaId: String,
  overallRtp: Number,
}, { timestamps: true });
const ScanLog = mongoose.model("ScanLog", ScanLogSchema);

const ReferralLogSchema = new mongoose.Schema({
  referrer: String,
  referee: String,
  code: String,
  reward: Number,
}, { timestamps: true });
const ReferralLog = mongoose.model("ReferralLog", ReferralLogSchema);


// ===== INIT GCS =====
const storage = new Storage();
const bucket = storage.bucket(GCS_BUCKET);

// ===== INIT TELEGRAM BOT (WEBHOOK MODE) =====
const bot = new TelegramBot(BOT_TOKEN, { webHook: true });

// ===== WIZARD STATE =====
const companyWizard = {}; // { tgUserId: { step, data } }

// ===== HELPERS =====
function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function nowMs() {
  return Date.now();
}

function normalizePhone(input) {
  const raw = String(input || "").trim();
  let digits = raw.replace(/\D/g, ""); // Keep only digits

  if (!digits) return null;

  // 1. If starts with 0 (e.g. 012...) => 6012...
  if (digits.startsWith("0")) {
    digits = "60" + digits.substring(1);
  }

  // 2. Validate length (E.164 loose)
  if (digits.length < 8 || digits.length > 15) return null;

  return "+" + digits;
}

function hashOTP(otp) {
  return crypto.createHmac("sha256", AUTH_SECRET).update(String(otp)).digest("hex");
}

function passwordHash(password, salt) {
  return crypto.scryptSync(String(password), salt, 32).toString("hex");
}

function makeSalt() {
  return crypto.randomBytes(16).toString("hex");
}

function signToken(payloadObj) {
  const payload = Buffer.from(JSON.stringify(payloadObj), "utf8").toString("base64url");
  const sig = crypto.createHmac("sha256", AUTH_SECRET).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

function verifyToken(token) {
  try {
    const parts = String(token || "").split(".");
    if (parts.length !== 2) return null;
    const [payload, sig] = parts;
    const expected = crypto.createHmac("sha256", AUTH_SECRET).update(payload).digest("base64url");
    if (sig !== expected) return null;
    const obj = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return obj || null;
  } catch {
    return null;
  }
}

async function isAdmin(tgUserId) {
  // (B) Telegram group admin/creator
  try {
    const gid = ADMIN_GROUP_ID;
    if (!gid) return false;
    const member = await bot.getChatMember(gid, tgUserId);
    return ["administrator", "creator"].includes(member.status);
  } catch (e) {
    return false;
  }
}

async function ensureJoinedGroup(userId) {
  try {
    const member = await bot.getChatMember(GROUP_USER_JOIN, userId);
    return ["member", "administrator", "creator"].includes(member.status);
  } catch {
    return false;
  }
}

// find tg user by phone
async function findTelegramUserByPhone(phoneE164) {
  const doc = await TgUser.findOne({ phone: phoneE164 });
  if (!doc) return null;
  return { tgUserId: doc.tgUserId, data: doc };
}

// ===== SETTINGS =====
async function getApprovalMode() {
  let s = await Setting.findOne({ key: "approval" });
  if (!s) {
    s = await Setting.create({ key: "approval", mode: "AUTO" });
  }
  return s.mode || "AUTO";
}

// ===== TELEGRAM WEBHOOK ENDPOINT =====
app.post("/telegram/webhook", (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// ===== GROUP WELCOME MESSAGE =====
bot.on("new_chat_members", (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(
    chatId,
    `👋 Selamat datang ke TipsMega888!
Untuk dapat:
✅ OTP
⭐ Bonus kredit scan
🔐 Akaun VERIFIED
Sila:
1️⃣ PM bot ${BOT_USERNAME}
2️⃣ Tekan /start
3️⃣ Share contact bila diminta`
  );
});

// ===== BOT: START =====
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  const joined = await ensureJoinedGroup(userId);
  if (!joined) {
    return bot.sendMessage(chatId, `❌ Sila join group dahulu:\n${GROUP_LINK}`);
  }

  bot.sendMessage(chatId, "Sila tekan butang di bawah untuk kongsi contact:", {
    reply_markup: {
      keyboard: [[{ text: "📱 Share Contact", request_contact: true }]],
      resize_keyboard: true,
      one_time_keyboard: true,
    },
  });
});

// ===== BOT: CONTACT SHARE -> OTP (save mapping) =====
bot.on("contact", async (msg) => {
  const chatId = msg.chat.id;
  const userId = String(msg.from.id);

  // normalize phone to +E164
  const phoneRaw = msg.contact?.phone_number || "";
  const phone = normalizePhone(phoneRaw.startsWith("+") ? phoneRaw : `+${phoneRaw.replace(/\D/g, "")}`) || phoneRaw;

  const joined = await ensureJoinedGroup(userId);
  if (!joined) {
    return bot.sendMessage(chatId, `❌ Anda belum join group. Sila join dahulu:\n${GROUP_LINK}`);
  }

  // 1. Save tg user mapping (Upsert)
  await TgUser.findOneAndUpdate(
    { tgUserId: userId },
    { phone: phone },
    { upsert: true, new: true }
  );

  // 2. Reply
  const msgText = `✅ Contact Saved!\n\nSila pergi ke website dan tekan butang *MINTA OTP* untuk dapatkan kod.\n\nWebsite: tipsmega888.com`;

  return bot.sendMessage(chatId, msgText, { parse_mode: "Markdown" });
});

// ===== ADMIN: MODE SWITCH =====
bot.onText(/\/autoapprove/, async (msg) => {
  const userId = msg.from.id;
  if (!(await isAdmin(userId))) return;

  await Setting.findOneAndUpdate(
    { key: "approval" },
    { mode: "AUTO", updatedBy: userId },
    { upsert: true }
  );
  bot.sendMessage(msg.chat.id, "✅ Mode set ke AUTO APPROVE");
});

bot.onText(/\/manualapprove/, async (msg) => {
  const userId = msg.from.id;
  if (!(await isAdmin(userId))) return;

  await Setting.findOneAndUpdate(
    { key: "approval" },
    { mode: "MANUAL", updatedBy: userId },
    { upsert: true }
  );
  bot.sendMessage(msg.chat.id, "⏳ Mode set ke MANUAL APPROVE");
});

bot.onText(/\/mode/, async (msg) => {
  const mode = await getApprovalMode();
  bot.sendMessage(msg.chat.id, `Current approval mode: ${mode}`);
});

// =======================
// COMPANY WIZARD (ADMIN)
// =======================
bot.onText(/\/addcompany/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  const ok = await isAdmin(userId);
  if (!ok) {
    return bot.sendMessage(
      chatId,
      "⛔ Anda bukan admin."
    );
  }

  companyWizard[userId] = { step: 1, data: {} };
  return bot.sendMessage(chatId, "🏢 Step 1: Hantar *nama company*", { parse_mode: "Markdown" });
});

bot.onText(/\/listcompany/, async (msg) => {
  const list = await Company.find();
  if (list.length === 0) return bot.sendMessage(msg.chat.id, "Tiada company lagi.");
  let text = "📋 Company List:\n";
  list.forEach((c) => {
    text += `- ${c.name}\n`;
  });
  bot.sendMessage(msg.chat.id, text);
});

bot.onText(/\/delcompany (.+)/, async (msg, match) => {
  const userId = msg.from.id;
  if (!(await isAdmin(userId))) return;

  const rawName = (match[1] || "").trim();
  if (!rawName) return;

  const safeName = rawName.replace(/[^\w\- ]+/g, "").trim();

  const c = await Company.findOne({ name: safeName });
  if (!c) {
    return bot.sendMessage(msg.chat.id, `⚠️ Company tak jumpa: ${safeName}`);
  }

  await Company.deleteOne({ _id: c._id });

  bot.sendMessage(msg.chat.id, `❌ Company *${safeName}* telah dipadam.`, { parse_mode: "Markdown" });
});

// =======================
// ADMIN: GIVE STARS (CREDIT)
// =======================
bot.onText(/\/give (.+) (.+)/, async (msg, match) => {
  const userId = msg.from.id;
  const chatId = msg.chat.id;
  if (!(await isAdmin(userId))) return;

  const targetUsername = (match[1] || "").trim();
  const amount = parseInt(match[2] || "0");

  if (!targetUsername || isNaN(amount) || amount <= 0) {
    return bot.sendMessage(chatId, "⚠️ Format: `/give <username> <amount>`\nContoh: `/give ali 50`");
  }

  try {
    const user = await User.findOne({ username: targetUsername });
    if (!user) {
      return bot.sendMessage(chatId, `❌ User *${targetUsername}* tak jumpa.`);
    }

    user.bonusStars += amount;
    await user.save();

    bot.sendMessage(chatId, `✅ *${amount} Stars* added to user *${targetUsername}* (Ledger Updated).\nUser perlu login/refresh untuk detect & claim.`);
  } catch (e) {
    bot.sendMessage(chatId, `❌ Error: ${e.message}`);
  }
});

bot.onText(/\/deduct (.+) (.+)/, async (msg, match) => {
  const userId = msg.from.id;
  const chatId = msg.chat.id;
  if (!(await isAdmin(userId))) return;

  const targetUsername = (match[1] || "").trim();
  const amount = parseInt(match[2] || "0");

  if (!targetUsername || isNaN(amount) || amount <= 0) {
    return bot.sendMessage(chatId, "⚠️ Format: `/deduct <username> <amount>`\nContoh: `/deduct ali 10`");
  }

  try {
    const user = await User.findOne({ username: targetUsername });
    if (!user) {
      return bot.sendMessage(chatId, `❌ User *${targetUsername}* tak jumpa.`);
    }

    user.bonusStars -= amount;
    await user.save();

    bot.sendMessage(chatId, `✅ *${amount} Stars* deducted from user *${targetUsername}* (Ledger Updated).`);
  } catch (e) {
    bot.sendMessage(chatId, `❌ Error: ${e.message}`);
  }
});

// Wizard steps handler
bot.on("message", async (msg) => {
  const userId = msg.from?.id;
  const chatId = msg.chat?.id;
  if (!userId || !chatId) return;
  if (!companyWizard[userId]) return;
  if (!(await isAdmin(userId))) return;

  const wizard = companyWizard[userId];

  if (wizard.step === 1 && msg.text) {
    wizard.data.name = msg.text.trim();
    wizard.step = 2;
    return bot.sendMessage(chatId, "🔗 Step 2: Hantar *link* (atau taip `SKIP`)", { parse_mode: "Markdown" });
  }

  if (wizard.step === 2 && msg.text) {
    wizard.data.link = msg.text.trim().toUpperCase() === "SKIP" ? "" : msg.text.trim();
    wizard.step = 3;
    return bot.sendMessage(chatId, "📝 Step 3: Hantar *caption* (atau taip `SKIP`)", { parse_mode: "Markdown" });
  }

  if (wizard.step === 3 && msg.text) {
    wizard.data.caption = msg.text.trim().toUpperCase() === "SKIP" ? "" : msg.text.trim();
    wizard.step = 4;
    return bot.sendMessage(chatId, "📷 Step 4: Hantar *gambar atau video* untuk company ini");
  }

  if (wizard.step === 4 && (msg.photo || msg.video)) {
    try {
      let fileId, mediaType, ext;
      if (msg.photo) {
        fileId = msg.photo[msg.photo.length - 1].file_id;
        mediaType = "photo";
        ext = "jpg";
      } else {
        fileId = msg.video.file_id;
        mediaType = "video";
        ext = "mp4";
      }

      const file = await bot.getFile(fileId);
      const url = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;
      const tempPath = path.join(os.tmpdir(), `${Date.now()}.${ext}`);

      const writer = fs.createWriteStream(tempPath);
      const response = await axios({ url, method: "GET", responseType: "stream" });
      response.data.pipe(writer);

      await new Promise((resolve, reject) => {
        writer.on("finish", resolve);
        writer.on("error", reject);
      });

      const safeName = String(wizard.data.name || "company").replace(/[^\w\- ]+/g, "").trim() || "company";
      const gcsPath = `companies/${safeName}/${Date.now()}.${ext}`;

      await bucket.upload(tempPath, {
        destination: gcsPath,
        public: true,
        metadata: { cacheControl: "public, max-age=31536000" },
      });

      const storageUrl = `https://storage.googleapis.com/${GCS_BUCKET}/${gcsPath}`;

      await Company.create({
        name: safeName,
        link: wizard.data.link || "",
        caption: wizard.data.caption || "",
        status: "ACTIVE",
        mediaType,
        storageUrl,
      });

      delete companyWizard[userId];
      return bot.sendMessage(chatId, `✅ Company *${safeName}* telah LIVE di website!`, { parse_mode: "Markdown" });
    } catch (e) {
      delete companyWizard[userId];
      return bot.sendMessage(chatId, "❌ Upload gagal. Cuba /addcompany semula.");
    } finally {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    }
  }
});

// =======================
// DEBUG: DB CHECK
// =======================
app.get("/api/_debug/db", async (_req, res) => {
  try {
    const at = new Date();
    res.json({ ok: true, data: { at, mongo: mongoose.connection.readyState } });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// =======================
// API: INIT DEVICE (free 1 star first time)
// =======================
app.post("/api/init", async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const { deviceId } = req.body || {};
    if (!deviceId) throw new Error("missing deviceId");

    let device = await Device.findOne({ deviceId }).session(session);
    let finalStars = 0;
    let isNew = false;
    let needsUpdate = false;

    if (!device) {
      device = new Device({ deviceId, stars: 1, lastActiveDate: "" }); // new device starts with 1
      finalStars = 1;
      isNew = true;
      needsUpdate = true;
    } else {
      // Logic Reset
      const todayStr = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kuala_Lumpur" });
      const lastActive = device.lastActiveDate || "";
      let currentStars = device.stars;

      if (lastActive !== todayStr) {
        if (currentStars < DAILY_LIMIT) {
          currentStars = DAILY_LIMIT;
          needsUpdate = true;
        } else {
          // still update date
          needsUpdate = true;
        }
      }

      device.stars = currentStars;
      device.lastActiveDate = todayStr;
      finalStars = currentStars;
    }

    if (needsUpdate || isNew) {
      await device.save({ session });
    }

    await session.commitTransaction();
    session.endSession();

    return res.json({ deviceId, stars: finalStars, isNew });
  } catch (e) {
    await session.abortTransaction();
    session.endSession();
    return res.status(500).json({ error: "Init failed", detail: String(e.message) });
  }
});

// =======================
// API: SCAN (deduct 1 star)
// =======================
app.post("/api/scan", async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const { deviceId, megaId } = req.body || {};
    if (!deviceId) throw new Error("missing deviceId");
    if (!megaId) throw new Error("missing megaId");

    const device = await Device.findOne({ deviceId }).session(session);
    if (!device) throw new Error("device not initialized");

    const todayStr = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kuala_Lumpur" });
    const lastActive = device.lastActiveDate || "";
    let currentStars = device.stars;

    // 1. Reset check logic (just in case they missed /init for the day)
    if (lastActive !== todayStr) {
      if (currentStars < DAILY_LIMIT) {
        currentStars = DAILY_LIMIT;
      }
      device.lastActiveDate = todayStr;
    }

    // 2. Deduct
    if (currentStars <= 0) {
      throw new Error("NO_STARS");
    }
    currentStars -= 1;
    device.stars = currentStars;

    await device.save({ session });

    // 3. Log (can be outside tx, but inside is safer for consistency)
    await ScanLog.create([{
      deviceId,
      megaId,
      overallRtp: Math.floor(10 + Math.random() * 84),
    }], { session });

    await session.commitTransaction();
    session.endSession();

    // Re-fetch log for RTP or just calc again
    const overallRtp = Math.floor(10 + Math.random() * 84);

    return res.json({ ok: true, overallRtp, stars: currentStars });

  } catch (e) {
    await session.abortTransaction();
    session.endSession();
    if (e.message === "NO_STARS") {
      return res.status(402).json({ error: "no stars", stars: 0 });
    }
    return res.status(500).json({ error: "scan failed", detail: String(e.message) });
  }
});

// =======================
// AUTH: REQUEST OTP
// =======================
app.post("/api/auth/request-otp", async (req, res) => {
  try {
    const phone = normalizePhone(req.body?.phone);
    if (!phone) return res.status(400).json({ error: "Invalid phone. Use format +60123456789" });

    // 1. Check mapping
    const tgDoc = await TgUser.findOne({ phone: phone });
    if (!tgDoc) {
      return res.status(404).json({
        error: "Phone not found in Telegram verification.",
        hint: `1) Join group: ${GROUP_LINK}\n2) PM bot ${BOT_USERNAME} dan share contact.`,
      });
    }

    // 2. Check group join
    const joined = await ensureJoinedGroup(tgDoc.tgUserId);
    if (!joined) {
      return res.status(403).json({
        error: "You must join Telegram group first.",
        link: GROUP_LINK,
      });
    }

    // 3. Generate OTP
    const otp = generateOTP();
    const expiresAt = new Date(Date.now() + OTP_TTL_MS);

    await WebOtp.findOneAndUpdate(
      { phone },
      {
        phone,
        tgUserId: tgDoc.tgUserId,
        otpHash: hashOTP(otp),
        expiresAt,
        attempts: 0
      },
      { upsert: true }
    );

    // 4. Send Message
    await bot.sendMessage(
      tgDoc.tgUserId,
      `🔐 *TipsMega888 OTP*\n\nOTP anda: *${otp}*\nValid: *3 minit*\n\nJika bukan anda, abaikan mesej ini.`,
      { parse_mode: "Markdown" }
    );

    return res.json({ ok: true, expiresInSec: 180 });
  } catch (e) {
    return res.status(500).json({ error: "request otp failed", detail: String(e.message) });
  }
});

// helper
function makeReferralCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let res = "";
  for (let i = 0; i < 6; i++) {
    res += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return res;
}

// =======================
// AUTH: REGISTER
// =======================
app.post("/api/auth/register", async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const phone = normalizePhone(req.body?.phone);
    const username = String(req.body?.username || "").trim();
    const password = String(req.body?.password || "");
    const otp = String(req.body?.otp || "").trim();
    const refCode = String(req.body?.refCode || "").trim().toUpperCase();

    if (!phone) throw new Error("Invalid phone");
    if (!username || username.length < 3) throw new Error("Username too short");

    // Check UserName duplicate
    const existingUser = await User.findOne({ username }).session(session);
    if (existingUser) throw new Error(`Username '${username}' taken.`);

    // Verify OTP
    const otpDoc = await WebOtp.findOne({ phone }).session(session);
    if (!otpDoc || otpDoc.expiresAt < new Date()) throw new Error("OTP expired/invalid");
    if (otpDoc.attempts >= 3) {
      await WebOtp.deleteOne({ phone }).session(session);
      throw new Error("Too many attempts");
    }
    if (otpDoc.otpHash !== hashOTP(otp)) {
      otpDoc.attempts += 1;
      await otpDoc.save({ session });
      throw new Error("OTP Salah");
    }

    // Check Account Duplicate
    const acc = await User.findOne({ phone }).session(session);
    if (acc && acc.verified) throw new Error("Account already exists");

    // Create
    const salt = makeSalt();
    const pass = passwordHash(password, salt);

    // Gen Ref Code
    let newMyRefCode = makeReferralCode();
    // (Skipping strict loop check for collision for simplicity, but in real world do check)

    // Referrer Logic
    let referredBy = null;
    if (refCode && refCode.length === 6) {
      const referrer = await User.findOne({ referralCode: refCode }).session(session);
      if (referrer && referrer.phone !== phone) {
        referredBy = referrer.phone;
        referrer.bonusStars += 1; // Reward
        referrer.referralCount += 1;
        await referrer.save({ session });

        await ReferralLog.create([{
          referrer: referrer.phone,
          referee: phone,
          code: refCode,
          reward: 1
        }], { session });
      }
    }

    // Save User
    if (acc) {
      // update existing partial (if any)
      acc.username = username;
      acc.passSalt = salt;
      acc.passHash = pass;
      acc.verified = true;
      acc.referralCode = newMyRefCode;
      acc.referredBy = referredBy;
      acc.bonusStars = 30; // Welcome bonus
      await acc.save({ session });
    } else {
      await User.create([{
        phone,
        username,
        passSalt: salt,
        passHash: pass,
        verified: true,
        referralCode: newMyRefCode,
        referredBy,
        bonusStars: 30,
      }], { session });
    }

    await WebOtp.deleteOne({ phone }).session(session);

    await session.commitTransaction();
    session.endSession();

    return res.json({ ok: true, phone, username, referralCode: newMyRefCode });

  } catch (e) {
    await session.abortTransaction();
    session.endSession();
    return res.status(500).json({ error: "register failed", detail: String(e.message) });
  }
});

// =======================
// AUTH: RESET PASSWORD
// =======================
app.post("/api/auth/reset-password", async (req, res) => {
  try {
    const phone = normalizePhone(req.body?.phone);
    const password = String(req.body?.newPassword || "");
    const otp = String(req.body?.otp || "").trim();

    if (!phone) return res.status(400).json({ error: "Invalid phone" });

    // Verify OTP logic (simplified)
    const otpDoc = await WebOtp.findOne({ phone });
    if (!otpDoc || otpDoc.expiresAt < new Date()) return res.status(400).json({ error: "OTP expired" });
    if (otpDoc.otpHash !== hashOTP(otp)) return res.status(400).json({ error: "OTP Salah" });

    const user = await User.findOne({ phone });
    if (!user) return res.status(404).json({ error: "User not found" });

    const salt = makeSalt();
    const pass = passwordHash(password, salt);

    user.passSalt = salt;
    user.passHash = pass;
    await user.save();

    await WebOtp.deleteOne({ phone });

    return res.json({ ok: true, username: user.username });
  } catch (e) {
    return res.status(500).json({ error: "reset failed", detail: String(e.message) });
  }
});

// =======================
// AUTH: LOGIN
// =======================
app.post("/api/auth/login", async (req, res) => {
  try {
    const username = String(req.body?.username || "").trim();
    const password = String(req.body?.password || "");

    const user = await User.findOne({ username });
    if (!user) return res.status(404).json({ error: "Username not found" });

    if (!user.verified) return res.status(403).json({ error: "Not verified" });

    const computed = passwordHash(password, user.passSalt);
    if (computed !== user.passHash) return res.status(403).json({ error: "Wrong password" });

    // ensure ref code exists
    if (!user.referralCode) {
      user.referralCode = makeReferralCode();
      await user.save();
    }

    const token = signToken({ phone: user.phone, ts: nowMs() });

    return res.json({
      ok: true,
      token,
      phone: user.phone,
      username: user.username,
      referralCode: user.referralCode,
      bonusStars: user.bonusStars,
      bonusGranted: user.bonusGranted
    });
  } catch (e) {
    return res.status(500).json({ error: "login failed", detail: String(e.message) });
  }
});

// =======================
// AUTH: GRANT DEVICE (Ledger)
// =======================
app.post("/api/auth/grant-device", async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const auth = String(req.headers.authorization || "");
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    const payload = verifyToken(token);
    const phone = normalizePhone(payload?.phone);
    const deviceId = String(req.body?.deviceId || "").trim();

    if (!phone || !deviceId) throw new Error("Auth/DeviceID missing");

    const user = await User.findOne({ phone }).session(session);
    if (!user) throw new Error("User not found");

    let device = await Device.findOne({ deviceId }).session(session);
    if (!device) throw new Error("Device not initialized");

    const totalBonus = user.bonusStars || 0;
    const totalClaimed = user.totalClaimedStars || 0;
    const pending = totalBonus - totalClaimed;

    let out = {};

    if (pending > 0) {
      device.stars += pending;
      user.totalClaimedStars = totalBonus;
      user.bonusGranted = true;
      user.bonusDeviceId = deviceId;

      out = { ok: true, stars: device.stars, granted: true, bonusStars: pending, msg: `Claimed ${pending} new stars!` };
    } else {
      out = { ok: true, stars: device.stars, granted: false, bonusStars: 0, msg: "No new stars" };
    }

    await user.save({ session });
    await device.save({ session });

    await session.commitTransaction();
    session.endSession();

    return res.json(out);

  } catch (e) {
    await session.abortTransaction();
    session.endSession();
    return res.status(500).json({ error: "grant failed", detail: String(e.message) });
  }
});

// =======================
// AUTH: ME
// =======================
app.get("/api/auth/me", async (req, res) => {
  try {
    const auth = String(req.headers.authorization || "");
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    const payload = verifyToken(token);
    const phone = normalizePhone(payload?.phone);

    const user = await User.findOne({ phone });
    if (!user) return res.status(404).json({ error: "User not found" });

    return res.json({
      ok: true,
      username: user.username,
      phone: user.phone,
      referralCode: user.referralCode,
      referralCount: user.referralCount,
      bonusStars: (user.bonusStars || 0) - (user.totalClaimedStars || 0), // Calc pending
      totalClaimedStars: user.totalClaimedStars,
    });
  } catch (e) {
    return res.status(500).json({ error: "auth/me failed" });
  }
});

// =======================
// API: GET COMPANIES
// =======================
app.get("/api/companies", async (req, res) => {
  try {
    const list = await Company.find().sort({ createdAt: -1 });
    // map to id
    const out = list.map(c => ({ id: c.name, ...c.toObject() })); // frontend uses name as ID often
    res.json({ ok: true, companies: out });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message) });
  }
});

const PORT = Number(process.env.PORT || 8080);
app.get("/health", (req, res) => res.status(200).send("ok"));
app.listen(PORT, "0.0.0.0", () => console.log("API running on port " + PORT));
