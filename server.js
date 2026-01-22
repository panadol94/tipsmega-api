require("dotenv").config();

const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");
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

// Public info
const GROUP_LINK = "https://t.me/tipsmega888chat";
const BOT_USERNAME = "@TIPSMEGA888OTPBOT";
const OTP_TTL_MS = 3 * 60 * 1000; // 3 min

// ===== INIT FIREBASE =====
// ===== INIT FIREBASE =====
const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
if (serviceAccountJson) {
  try {
    const serviceAccount = JSON.parse(serviceAccountJson);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
    console.log("Firebase initialized with inline JSON.");
  } catch (e) {
    console.error("Failed to parse FIREBASE_SERVICE_ACCOUNT_JSON:", e);
    process.exit(1);
  }
} else {
  admin.initializeApp(); // Fallback to ADC or GOOGLE_APPLICATION_CREDENTIALS path
}

const db = admin.firestore();

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
  // Malaysia min (601xxxxxxx) is 10-11, world max is 15.
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
  // (A) Manual admin list in Firestore (admins/{tgUserId})
  try {
    const snap = await db.collection("admins").doc(String(tgUserId)).get();
    if (snap.exists) return true;
  } catch (e) { }

  // (B) Telegram group admin/creator (ADMIN_GROUP_ID / TG_GROUP_ADMIN_REPORT)
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

// find tg user by phone (saved when user share contact in bot)
async function findTelegramUserByPhone(phoneE164) {
  const qsnap = await db.collection("tg_users").where("phone", "==", phoneE164).limit(1).get();
  if (qsnap.empty) return null;
  const d = qsnap.docs[0].data() || {};
  // IMPORTANT: tgUserId should exist (we save doc id as tgUserId in your bot flow)
  const tgUserId = qsnap.docs[0].id;
  return { tgUserId, data: d };
}

// ===== SETTINGS =====
async function getApprovalMode() {
  const ref = db.collection("settings").doc("approval");
  const snap = await ref.get();
  if (!snap.exists) {
    await ref.set({
      mode: "AUTO",
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return "AUTO";
  }
  return snap.data()?.mode || "AUTO";
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

// ===== BOT: CONTACT SHARE -> OTP (existing) =====
bot.on("contact", async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  // normalize phone to +E164
  const phoneRaw = msg.contact?.phone_number || "";
  const phone = normalizePhone(phoneRaw.startsWith("+") ? phoneRaw : `+${phoneRaw.replace(/\D/g, "")}`) || phoneRaw;

  const joined = await ensureJoinedGroup(userId);
  if (!joined) {
    return bot.sendMessage(chatId, `❌ Anda belum join group. Sila join dahulu:\n${GROUP_LINK}`);
  }

  // 1. Save tg user mapping (CRITICAL for website request-otp)
  await db.collection("tg_users").doc(String(userId)).set(
    {
      phone,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  // 2. DO NOT generate OTP here. Just tell user to go to website.
  const msgText = `✅ Contact Saved!\n\nSila pergi ke website dan tekan butang *MINTA OTP* untuk dapatkan kod.\n\nWebsite: tipsmega888-prod.web.app`;

  return bot.sendMessage(chatId, msgText, { parse_mode: "Markdown" });
});

// ===== ADMIN: MODE SWITCH =====
bot.onText(/\/autoapprove/, async (msg) => {
  const userId = msg.from.id;
  if (!(await isAdmin(userId))) return;
  await db.collection("settings").doc("approval").set({
    mode: "AUTO",
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedBy: userId,
  });
  bot.sendMessage(msg.chat.id, "✅ Mode set ke AUTO APPROVE");
});

bot.onText(/\/manualapprove/, async (msg) => {
  const userId = msg.from.id;
  if (!(await isAdmin(userId))) return;
  await db.collection("settings").doc("approval").set({
    mode: "MANUAL",
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedBy: userId,
  });
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
      "? Anda bukan admin.\n\nSemak:\n1) Firestore: admins/{userId}\n2) ADMIN_GROUP_ID env betul\n\nUserId anda: " +
      userId
    );
  }

  companyWizard[userId] = { step: 1, data: {} };
  return bot.sendMessage(chatId, "?? Step 1: Hantar *nama company*", { parse_mode: "Markdown" });
});

bot.onText(/\/listcompany/, async (msg) => {
  const snap = await db.collection("companies").get();
  if (snap.empty) return bot.sendMessage(msg.chat.id, "Tiada company lagi.");
  let text = "📋 Company List:\n";
  snap.forEach((d) => {
    const c = d.data();
    text += `- ${c.name}\n`;
  });
  bot.sendMessage(msg.chat.id, text);
});

bot.onText(/\/delcompany (.+)/, async (msg, match) => {
  const userId = msg.from.id;
  if (!(await isAdmin(userId))) return;

  const rawName = (match[1] || "").trim();
  if (!rawName) return;

  // Use same logic as creation to find the Doc ID
  const safeName = rawName.replace(/[^\w\- ]+/g, "").trim();

  const ref = db.collection("companies").doc(safeName);
  const snap = await ref.get();

  if (!snap.exists) {
    return bot.sendMessage(msg.chat.id, `⚠️ Company tak jumpa.\nCari ID: \`${safeName}\`\nInput: ${rawName}\n\nGuna /listcompany untuk tengok nama sebenar.`);
  }

  await ref.delete();

  // Also try to delete from Object Storage? (Optional enhancement, maybe risky if manual file mgmt)
  // For now just delete DB record.

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
    const snap = await db.collection("users").where("username", "==", targetUsername).limit(1).get();
    if (snap.empty) {
      return bot.sendMessage(chatId, `❌ User *${targetUsername}* tak jumpa. Pastikan dia dah register di website.`);
    }

    const doc = snap.docs[0];
    const phone = doc.id;

    // Use atomic increment so it stacks with existing bonus
    // Pending = (bonusStars_total) - (totalClaimed)
    // So if admin adds 50, bonusStars increases by 50. Pending increases by 50.
    await db.collection("users").doc(phone).set({
      bonusStars: admin.firestore.FieldValue.increment(amount),
      // bonusGranted: false, // NO LONGER NEEDED with Ledger System, but keeping it doesn't hurt.
      // actually, let's remove bonusGranted toggling to rely purely on Ledger math.
      // But we need to ensure the user knows to claim.
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    bot.sendMessage(chatId, `✅ *${amount} Stars* added to user *${targetUsername}* (Ledger Updated).\nUser perlu login/refresh untuk detect & claim.`);
  } catch (e) {
    bot.sendMessage(chatId, `❌ Error: ${e.message}`);
  }
});

// =======================
// ADMIN: DEDUCT STARS (TOLAK KREDIT)
// =======================
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
    const snap = await db.collection("users").where("username", "==", targetUsername).limit(1).get();
    if (snap.empty) {
      return bot.sendMessage(chatId, `❌ User *${targetUsername}* tak jumpa.`);
    }

    const doc = snap.docs[0];
    const phone = doc.id;

    // Instead of setting fixed bonus, we can add a NEGATIVE bonusStars.
    // Logic: 
    // If we use `bonusStars: -10`, when user grants, it adds -10 to device stars.
    // If device stars < 10, it goes negative? Or we clamp at 0?
    // Let's rely on standard math. If stars go negative, scanning will just block (stars <= 0).

    // Use atomic increment (negative)
    await db.collection("users").doc(phone).set({
      bonusStars: admin.firestore.FieldValue.increment(-amount),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

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

      await db.collection("companies").doc(safeName).set({
        name: safeName,
        link: wizard.data.link || "",
        caption: wizard.data.caption || "",
        status: "ACTIVE",
        mediaType,
        storageUrl,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
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
// DEBUG: FIRESTORE CHECK
// =======================
app.get("/api/_debug/firestore", async (_req, res) => {
  try {
    const at = admin.firestore.Timestamp.now();
    res.json({ ok: true, data: { at } });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// =======================
// API: INIT DEVICE (free 1 star first time)
// =======================
app.post("/api/init", async (req, res) => {
  try {
    const { deviceId } = req.body || {};
    if (!deviceId) return res.status(400).json({ error: "missing deviceId" });

    const ref = db.collection("devices").doc(String(deviceId));
    // Use transaction to prevent race on daily reset
    let finalStars = 0;
    let isNew = false;

    await db.runTransaction(async (tx) => {
      const dDoc = await tx.get(ref);
      if (!dDoc.exists) {
        tx.set(ref, {
          deviceId,
          stars: 1,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        finalStars = 1;
        isNew = true;
        return;
      }

      const data = dDoc.data() || {};
      // Check Reset IN MEMORY
      const todayStr = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kuala_Lumpur" });
      const lastActive = data.lastActiveDate || "";
      let currentStars = data.stars ?? 0;
      let needsUpdate = false;

      if (lastActive !== todayStr) {
        if (currentStars < DAILY_LIMIT) {
          currentStars = DAILY_LIMIT;
          needsUpdate = true;
        }
        // Update lastActive regardless? No, only update if we actually 'touch' the user? 
        // Or always update date to track activity? 
        // Better to always update date so we don't check again today.
        if (!needsUpdate) needsUpdate = true; // Just to update date
      }

      if (needsUpdate) {
        tx.set(ref, {
          stars: currentStars,
          lastActiveDate: todayStr,
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
      }

      finalStars = currentStars;
      isNew = false;
    });

    return res.json({ deviceId, stars: finalStars, isNew });
  } catch (e) {
    return res.status(500).json({ error: "Init failed", detail: String(e?.message || e) });
  }
});

// =======================
// API: SCAN (deduct 1 star)
// =======================
app.post("/api/scan", async (req, res) => {
  try {
    const { deviceId, megaId } = req.body || {};
    if (!deviceId) return res.status(400).json({ error: "missing deviceId" });
    if (!megaId) return res.status(400).json({ error: "missing megaId" });

    // TRANSACTIONAL SCAN
    let overallRtp = 0;
    let newStars = 0;

    await db.runTransaction(async (tx) => {
      const ref = db.collection("devices").doc(String(deviceId));
      const doc = await tx.get(ref);
      if (!doc.exists) throw new Error("device not initialized");

      const data = doc.data() || {};

      // 1. Check Daily Reset Logic (InMemory)
      const todayStr = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kuala_Lumpur" });
      let currentStars = data.stars ?? 0;
      const lastActive = data.lastActiveDate || "";
      let dateChanged = false;

      if (lastActive !== todayStr) {
        if (currentStars < DAILY_LIMIT) {
          currentStars = DAILY_LIMIT; // Reset up
        }
        dateChanged = true;
      }

      // 2. Deduct Logic
      if (currentStars <= 0) {
        throw new Error("NO_STARS");
      }

      currentStars -= 1; // Deduct cost

      // 3. Commit Updates
      tx.set(ref, {
        stars: currentStars,
        lastActiveDate: todayStr, // Always update date to today
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });

      newStars = currentStars;
    });

    // Generate RTP (Outside Transaction to keep it fast, or inside? irrelevant)
    overallRtp = Math.floor(10 + Math.random() * 84); // 10..93

    // Log (Async, outside tx is fine)
    await db.collection("scan_logs").add({
      deviceId,
      megaId,
      overallRtp,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return res.json({ ok: true, overallRtp, stars: newStars });

  } catch (e) {
    if (e.message === "NO_STARS") {
      return res.status(402).json({ error: "no stars", stars: 0 });
    }
    return res.status(500).json({ error: "scan failed", detail: String(e?.message || e) });
  }
});

// =======================
// AUTH: REQUEST OTP (send to Telegram user)
// =======================
app.post("/api/auth/request-otp", async (req, res) => {
  try {
    const phone = normalizePhone(req.body?.phone);
    if (!phone) {
      return res.status(400).json({ error: "Invalid phone. Use format +60123456789" });
    }

    const tg = await findTelegramUserByPhone(phone);
    if (!tg) {
      return res.status(404).json({
        error: "Phone not found in Telegram verification.",
        hint: `1) Join group: ${GROUP_LINK}\n\n  // IMPORTANT: ignore commands (so /addcompany works)\n  if (msg.text && msg.text.startsWith("/")) return;\n2) PM bot ${BOT_USERNAME} dan share contact.`,
      });
    }

    const joined = await ensureJoinedGroup(Number(tg.tgUserId));
    if (!joined) {
      return res.status(403).json({
        error: "You must join Telegram group first.",
        link: GROUP_LINK,
      });
    }

    const otp = generateOTP();
    const otpDoc = db.collection("web_otps").doc(phone);
    await otpDoc.set({
      phone,
      tgUserId: String(tg.tgUserId),
      otpHash: hashOTP(otp),
      createdAtMs: nowMs(),
      expiresAtMs: nowMs() + OTP_TTL_MS,
      attempts: 0,
    });

    await bot.sendMessage(
      Number(tg.tgUserId),
      `🔐 *TipsMega888 OTP*\n\nOTP anda: *${otp}*\nValid: *3 minit*\n\nJika bukan anda, abaikan mesej ini.`,
      { parse_mode: "Markdown" }
    );

    return res.json({ ok: true, expiresInSec: 180 });
  } catch (e) {
    return res.status(500).json({ error: "request otp failed", detail: String(e?.message || e) });
  }
});

// helper: make random 6-char referral code
function makeReferralCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let res = "";
  for (let i = 0; i < 6; i++) {
    res += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return res;
}

// =======================
// AUTH: REGISTER (verify OTP + create user)
// =======================
app.post("/api/auth/register", async (req, res) => {
  try {
    const phone = normalizePhone(req.body?.phone);
    const username = String(req.body?.username || "").trim();
    const password = String(req.body?.password || "");
    const otp = String(req.body?.otp || "").trim();
    const refCode = String(req.body?.refCode || "").trim().toUpperCase(); // ✅ Capture ref code

    if (!phone) return res.status(400).json({ error: "Invalid phone. Use +E164" });
    if (!username || username.length < 3) return res.status(400).json({ error: "Username terlalu pendek" });
    if (!password || password.length < 6) return res.status(400).json({ error: "Password min 6 char" });
    if (!/^\d{6}$/.test(otp)) return res.status(400).json({ error: "OTP mesti 6 digit" });

    // Check if USERNAMe is taken
    const sameName = await db.collection("users").where("username", "==", username).limit(1).get();
    if (!sameName.empty) {
      return res.status(400).json({ error: `Username '${username}' taken. Pilih lain.` });
    }

    // must exist in tg_users + joined group
    const tg = await findTelegramUserByPhone(phone);
    if (!tg) {
      return res.status(404).json({
        error: "Phone not verified in Telegram yet.",
        hint: `Join group: ${GROUP_LINK}\nPM bot ${BOT_USERNAME} & share contact.`,
      });
    }
    const joined = await ensureJoinedGroup(Number(tg.tgUserId));
    if (!joined) return res.status(403).json({ error: "Join Telegram group first.", link: GROUP_LINK });

    const otpSnap = await db.collection("web_otps").doc(phone).get();
    if (!otpSnap.exists) return res.status(400).json({ error: "OTP not requested or expired." });

    const o = otpSnap.data() || {};
    if ((o.expiresAtMs || 0) < nowMs()) {
      await db.collection("web_otps").doc(phone).delete();
      return res.status(400).json({ error: "OTP expired. Request new OTP." });
    }

    const attemptCount = (o.attempts || 0) + 1;
    if (attemptCount >= 3) {
      await db.collection("web_otps").doc(phone).delete();
      return res.status(400).json({ error: "Too many attempts. OTP deleted. Request baru." });
    }

    const ok = o.otpHash === hashOTP(otp);
    if (!ok) {
      await db.collection("web_otps").doc(phone).set({ attempts: admin.firestore.FieldValue.increment(1) }, { merge: true });
      return res.status(400).json({ error: `OTP salah. Cubaan ${attemptCount}/3.` });
    }

    const userRef = db.collection("users").doc(phone);
    const userSnap = await userRef.get();
    if (userSnap.exists && userSnap.data()?.verified) {
      await db.collection("web_otps").doc(phone).delete();
      return res.status(409).json({ error: "Account already exists. Please login." });
    }

    const salt = makeSalt();
    const pass = passwordHash(password, salt);

    // ✅ Generate NEW referral code for this user
    let newMyRefCode = makeReferralCode();
    // ensure unique (simple check loops max 3 times)
    for (let k = 0; k < 3; k++) {
      const exist = await db.collection("users").where("referralCode", "==", newMyRefCode).limit(1).get();
      if (exist.empty) break;
      newMyRefCode = makeReferralCode();
    }

    await db.runTransaction(async (tx) => {
      // 1. Create User
      tx.set(
        userRef,
        {
          phone,
          username,
          passSalt: salt,
          passHash: pass,
          verified: true,
          referralCode: newMyRefCode,
          referredBy: null, // will update below if valid
          bonusStars: 30,
          bonusGranted: false,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

      // 2. Handle Referral Reward (if code provided)
      if (refCode && refCode.length === 6) {
        const refQuery = await tx.get(db.collection("users").where("referralCode", "==", refCode).limit(1));
        if (!refQuery.empty) {
          const referrerDoc = refQuery.docs[0];
          const referrerData = referrerDoc.data();
          const referrerPhone = referrerDoc.id;

          // Cannot refer self (impossible by phone key, but good sanity check)
          if (referrerPhone !== phone) {
            // A) Mark referredBy on new user
            tx.set(userRef, { referredBy: referrerPhone }, { merge: true });

            // B) Reward Referrer (DIRECTLY ADD STARS to their default device??)
            // Wait, stars are on DEVICEs, not USERS. 
            // Complexity: Users can have multiple devices. 
            // Solution: We will store "referralBalance" on USER doc. 
            // When user logs in/grants, we can sweep balance?
            // OR simpler: increment 'bonusStars' on referrer user doc so next time they login/grant, they get it?
            // Let's use `bonusStars` increment on referrer.
            // Current 'bonusStars' logic in login is static "30". Let's change it to be dynamic increment.

            // REVISED STRATEGY:
            // Just increment referrer's `referralCount` and `bonusStars`. 
            // But wait, `bonusStars` field is currently used for the "Welcome Bonus".
            // Let's add a new field `accumulatedReferralBonus`.

            // Actually, simplest requested path: "Upline dapat 1 star".
            // Implementation: Increment `bonusStars` on the referrer USER doc.
            // When referrer logs in >> grant-device, that total `bonusStars` will be added.
            // NOTE: This means they need to re-login or hit grant-device to claim. Acceptable for now.

            tx.set(
              db.collection("users").doc(referrerPhone),
              {
                bonusStars: admin.firestore.FieldValue.increment(1),
                referralCount: admin.firestore.FieldValue.increment(1)
              },
              { merge: true }
            );

            // Log referral event
            const refLogRef = db.collection("referrals").doc();
            tx.set(refLogRef, {
              referrer: referrerPhone,
              referee: phone,
              code: refCode,
              reward: 1,
              createdAt: admin.firestore.FieldValue.serverTimestamp()
            });
          }
        }
      }
    });

    await db.collection("web_otps").doc(phone).delete();

    return res.json({ ok: true, phone, username, referralCode: newMyRefCode });
  } catch (e) {
    return res.status(500).json({ error: "register failed", detail: String(e?.message || e) });
  }
});

// =======================
// AUTH: RESET PASSWORD (Forgot Password)
// =======================
app.post("/api/auth/reset-password", async (req, res) => {
  try {
    const phone = normalizePhone(req.body?.phone);
    const password = String(req.body?.newPassword || "");
    const otp = String(req.body?.otp || "").trim();

    if (!phone) return res.status(400).json({ error: "Invalid phone" });
    if (!password || password.length < 6) return res.status(400).json({ error: "Password min 6 char" });
    if (!/^\d{6}$/.test(otp)) return res.status(400).json({ error: "OTP mesti 6 digit" });

    // 1. Verify OTP
    const otpSnap = await db.collection("web_otps").doc(phone).get();
    if (!otpSnap.exists) return res.status(400).json({ error: "OTP expired/invalid. Request baru." });

    const o = otpSnap.data() || {};
    if ((o.expiresAtMs || 0) < nowMs()) {
      await db.collection("web_otps").doc(phone).delete();
      return res.status(400).json({ error: "OTP expired." });
    }

    const attemptCount = (o.attempts || 0) + 1;
    if (attemptCount >= 3) {
      await db.collection("web_otps").doc(phone).delete();
      return res.status(400).json({ error: "Too many attempts. OTP deleted. Request baru." });
    }

    if (o.otpHash !== hashOTP(otp)) {
      await db.collection("web_otps").doc(phone).set({ attempts: admin.firestore.FieldValue.increment(1) }, { merge: true });
      return res.status(400).json({ error: `OTP salah. Cubaan ${attemptCount}/3.` });
    }

    // 2. Check User Exists
    const userRef = db.collection("users").doc(phone);
    const userSnap = await userRef.get();
    if (!userSnap.exists) {
      return res.status(404).json({ error: "Nombor ini belum register akaun." });
    }

    // 3. Update Password
    const salt = makeSalt();
    const pass = passwordHash(password, salt);

    await userRef.set({
      passSalt: salt,
      passHash: pass,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    // 4. Delete OTP & Return Username
    await db.collection("web_otps").doc(phone).delete();
    const username = userSnap.data()?.username || "Commander";

    return res.json({ ok: true, username });

  } catch (e) {
    return res.status(500).json({ error: "Reset failed", detail: String(e?.message || e) });
  }
});

// =======================
// AUTH: LOGIN (phone + password)
// =======================
// =======================
// AUTH: LOGIN (username + password) - CHANGED from phone
// =======================
app.post("/api/auth/login", async (req, res) => {
  try {
    const username = String(req.body?.username || "").trim(); // changed from phone
    const password = String(req.body?.password || "");

    if (!username) return res.status(400).json({ error: "Missing username" });
    if (!password) return res.status(400).json({ error: "Missing password" });

    // Lookup by username
    const snap = await db.collection("users").where("username", "==", username).limit(1).get();

    if (snap.empty) return res.status(404).json({ error: "Username not found" });

    const userDoc = snap.docs[0];
    const u = userDoc.data() || {};
    const phone = userDoc.id; // phone is the doc key

    if (!u.verified) return res.status(403).json({ error: "Not verified yet" });

    const salt = String(u.passSalt || "");
    const stored = String(u.passHash || "");
    const computed = passwordHash(password, salt);

    if (!salt || !stored || computed !== stored) {
      return res.status(403).json({ error: "Wrong password" });
    }

    const token = signToken({ phone, ts: nowMs() });

    // ensure old users get a code if missing
    let myCode = u.referralCode;
    if (!myCode) {
      myCode = makeReferralCode();
      await db.collection("users").doc(phone).set({ referralCode: myCode }, { merge: true });
    }

    return res.json({
      ok: true,
      token,
      phone,
      username: u.username || "",
      referralCode: myCode,
      bonusStars: u.bonusStars ?? 30, // rewards
      bonusGranted: !!u.bonusGranted,
    });
  } catch (e) {
    return res.status(500).json({ error: "login failed", detail: String(e?.message || e) });
  }
});

// =======================
// AUTH: GRANT DEVICE (claim bonus stars once after login)
// =======================
// =======================
// AUTH: GRANT DEVICE (Ledger System - Claim Pending Stars)
// =======================
app.post("/api/auth/grant-device", async (req, res) => {
  try {
    const auth = String(req.headers.authorization || "");
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    const payload = verifyToken(token);
    const phone = normalizePhone(payload?.phone);

    if (!phone) return res.status(401).json({ error: "unauthorized" });

    const deviceId = String(req.body?.deviceId || "").trim();
    if (!deviceId) return res.status(400).json({ error: "missing deviceId" });

    const userRef = db.collection("users").doc(phone);
    const devRef = db.collection("devices").doc(deviceId);

    let out = { ok: true, stars: 0, granted: false, bonusStars: 0, msg: "" };

    await db.runTransaction(async (tx) => {
      const [us, ds] = await Promise.all([tx.get(userRef), tx.get(devRef)]);
      if (!us.exists) throw new Error("user not found");
      if (!ds.exists) throw new Error("device not initialized");

      const u = us.data() || {};

      // LOGIC BARU: Ledger System
      // Total Bonus yang sepatutnya user dapat (Welcome + Referral + Admin)
      const totalBonusValues = Number(u.bonusStars ?? 30);

      // Berapa yang user dah pernah claim sebelum ni
      const totalClaimedSoFar = Number(u.totalClaimedStars ?? 0);

      // Baki yang belum claim (Pending)
      const pending = totalBonusValues - totalClaimedSoFar;

      const currentDevStars = Number(ds.data()?.stars ?? 0);

      // Jika ada baki positive, kita bagi baki tu
      if (pending > 0) {
        const newDevStars = currentDevStars + pending;

        // 1. Update User (rekod yang kita dah bagi semua pending)
        tx.set(
          userRef,
          {
            totalClaimedStars: totalBonusValues, // Sync balik Claimed = Total
            bonusGranted: true, // Legacy flag (keep for compat)
            bonusDeviceId: deviceId, // Last ID claim
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );

        // 2. Update Device (tambah stars)
        tx.set(
          devRef,
          { stars: newDevStars, updatedAt: admin.firestore.FieldValue.serverTimestamp() },
          { merge: true }
        );

        out = {
          ok: true,
          stars: newDevStars,
          granted: true,
          bonusStars: pending, // show amount added
          msg: `Claimed ${pending} new stars!`
        };
      } else {
        // Nothing to claim
        tx.set(devRef, { updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
        out = {
          ok: true,
          stars: currentDevStars,
          granted: false,
          bonusStars: 0,
          msg: "No new stars to claim"
        };
      }
    });

    return res.json(out);
  } catch (e) {
    return res.status(500).json({ error: "grant-device failed", detail: String(e?.message || e) });
  }
});

// =======================
// AUTH: ME (Get current user)
// =======================
app.get("/api/auth/me", async (req, res) => {
  try {
    const auth = String(req.headers.authorization || "");
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    const payload = verifyToken(token);
    const phone = normalizePhone(payload?.phone);

    if (!phone) return res.status(401).json({ error: "unauthorized" });

    const doc = await db.collection("users").doc(phone).get();
    if (!doc.exists) return res.status(404).json({ error: "user not found" });

    const u = doc.data() || {};

    // Also get device Stars if we want total view?
    // For now, return User data + bonus logic stuff

    return res.json({
      ok: true,
      username: u.username || "Commander",
      phone: u.phone,
      referralCode: u.referralCode,
      referralCount: u.referralCount || 0,
      bonusStars: u.bonusStars || 0, // This is pending claimable bonus
      totalClaimedStars: u.totalClaimedStars || 0,
    });
  } catch (e) {
    return res.status(500).json({ error: "auth/me failed", detail: String(e?.message || e) });
  }
});

// =======================
// API: GET COMPANIES FOR WEBSITE
// =======================
app.get("/api/companies", async (req, res) => {
  try {
    const snap = await db.collection("companies").orderBy("createdAt", "desc").get();

    const list = [];
    snap.forEach((doc) => {
      list.push({ id: doc.id, ...doc.data() });
    });

    res.json({ ok: true, companies: list });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ===== START SERVER =====
const PORT = Number(process.env.PORT || 8080);
app.get("/health", (req, res) => res.status(200).send("ok"));
app.listen(PORT, "0.0.0.0", () => console.log("API running on port " + PORT));
