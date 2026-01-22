const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");
const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");
const { Storage } = require("@google-cloud/storage");
const fs = require("fs");
const path = require("path");
const os = require("os");

const app = express();
app.use(cors());
app.use(express.json());

// ===== ENV =====
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const GROUP_USER_JOIN = process.env.TG_GROUP_USER_JOIN;
const GROUP_ADMIN_REPORT = process.env.TG_GROUP_ADMIN_REPORT;
const GCS_BUCKET = process.env.GCS_BUCKET_NAME;

// ===== INIT FIREBASE =====
admin.initializeApp();
const db = admin.firestore();

// ===== INIT GCS =====
const storage = new Storage();
const bucket = storage.bucket(GCS_BUCKET);

// ===== INIT TELEGRAM BOT =====
const bot = new TelegramBot(BOT_TOKEN, { webHook: true });

// ===== TEMP MEMORY =====
const companyWizard = {};

// ===== UTIL =====
function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function isAdmin(id) {
  return db.collection("admins").doc(String(id)).get().then(s => s.exists);
}

async function ensureJoinedGroup(userId) {
  try {
    const member = await bot.getChatMember(GROUP_USER_JOIN, userId);
    return ["member", "administrator", "creator"].includes(member.status);
  } catch {
    return false;
  }
}

// ===== TELEGRAM WEBHOOK =====
app.post("/telegram/webhook", (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// ===== WELCOME MESSAGE IN GROUP =====
bot.on("new_chat_members", (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId,
`👋 Selamat datang ke TipsMega888!

Untuk dapat:
✅ OTP
⭐ Bonus 10 kredit
🔐 Akaun VERIFIED

Sila:
1️⃣ PM bot
2️⃣ Tekan /start
3️⃣ Share contact bila diminta`
  );
});

// ===== START =====
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  const joined = await ensureJoinedGroup(userId);
  if (!joined) {
    return bot.sendMessage(chatId,
      "❌ Sila join group dahulu:\nhttps://t.me/tipsmega888chat"
    );
  }

  bot.sendMessage(chatId, "Tekan butang bawah untuk kongsi contact:", {
    reply_markup: {
      keyboard: [[{ text: "📱 Share Contact", request_contact: true }]],
      resize_keyboard: true,
      one_time_keyboard: true
    }
  });
});

// ===== HANDLE CONTACT =====
bot.on("contact", async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const phone = msg.contact.phone_number;

  const otp = generateOTP();

  await db.collection("tg_users").doc(String(userId)).set({
    phone,
    verified: true,
    stars: admin.firestore.FieldValue.increment(10),
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });

  await bot.sendMessage(chatId,
    `✅ VERIFIED!\nOTP: *${otp}*\nBonus ⭐10 diberi.`,
    { parse_mode: "Markdown" }
  );

  await bot.sendMessage(GROUP_ADMIN_REPORT,
    `📩 OTP AUTO\nUser: ${userId}\nPhone: ${phone}\nOTP: ${otp}`
  );
});

// =======================
// COMPANY WIZARD
// =======================
bot.onText(/\/addcompany/, async (msg) => {
  const id = msg.from.id;
  if (!(await isAdmin(id))) return;

  companyWizard[id] = { step: 1, data: {} };
  bot.sendMessage(msg.chat.id, "📝 Step 1: Hantar nama company");
});

bot.on("message", async (msg) => {
  const id = msg.from.id;
  if (!companyWizard[id]) return;

  const w = companyWizard[id];
  const chatId = msg.chat.id;

  if (w.step === 1 && msg.text) {
    w.data.name = msg.text;
    w.step = 2;
    return bot.sendMessage(chatId, "🔗 Step 2: Hantar link atau SKIP");
  }

  if (w.step === 2 && msg.text) {
    w.data.link = msg.text === "SKIP" ? "" : msg.text;
    w.step = 3;
    return bot.sendMessage(chatId, "📝 Step 3: Hantar caption atau SKIP");
  }

  if (w.step === 3 && msg.text) {
    w.data.caption = msg.text === "SKIP" ? "" : msg.text;
    w.step = 4;
    return bot.sendMessage(chatId, "📷 Step 4: Hantar gambar / video");
  }

  if (w.step === 4 && (msg.photo || msg.video)) {
    let fileId, ext;

    if (msg.photo) {
      fileId = msg.photo[msg.photo.length - 1].file_id;
      ext = "jpg";
    } else {
      fileId = msg.video.file_id;
      ext = "mp4";
    }

    const file = await bot.getFile(fileId);
    const url = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;

    const temp = path.join(os.tmpdir(), `${Date.now()}.${ext}`);
    const res = await axios({ url, responseType: "stream" });
    const writer = fs.createWriteStream(temp);
    res.data.pipe(writer);
    await new Promise(r => writer.on("finish", r));

    const gcsPath = `companies/${w.data.name}/${Date.now()}.${ext}`;
    await bucket.upload(temp, { destination: gcsPath, public: true });
    fs.unlinkSync(temp);

    const storageUrl = `https://storage.googleapis.com/${GCS_BUCKET}/${gcsPath}`;

    await db.collection("companies").doc(w.data.name).set({
      name: w.data.name,
      link: w.data.link,
      caption: w.data.caption,
      status: "VERIFIED",
      storageUrl,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    delete companyWizard[id];
    return bot.sendMessage(chatId, `✅ ${w.data.name} LIVE di website`);
  }
});

// ===== API COMPANIES =====
app.get("/api/companies", async (req, res) => {
  const snap = await db.collection("companies").get();
  const data = [];
  snap.forEach(d => data.push(d.data()));
  res.json(data);
});

// ===== HEALTH =====
app.get("/health", (_, res) => res.send("ok"));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`API listening on ${PORT}`));
