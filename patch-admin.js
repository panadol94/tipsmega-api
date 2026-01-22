const fs = require("fs");

const file = "server.js";
let c = fs.readFileSync(file, "utf8");

// 1) Pastikan ada ADMIN_GROUP_ID constant (guna TG_GROUP_ADMIN_REPORT kalau ada)
if (!c.includes("const ADMIN_GROUP_ID")) {
  c = c.replace(
    /const GROUP_ADMIN_REPORT\s*=\s*process\.env\.TG_GROUP_ADMIN_REPORT.*\n/,
    (m) => m + 'const ADMIN_GROUP_ID = process.env.ADMIN_GROUP_ID || GROUP_ADMIN_REPORT;\n'
  );
}

// 2) Replace function isAdmin
const re = /async function isAdmin\s*\([\s\S]*?\n}\n/;
const replacement =
`async function isAdmin(tgUserId) {
  // (A) Manual admin list in Firestore (admins/{tgUserId})
  try {
    const snap = await db.collection("admins").doc(String(tgUserId)).get();
    if (snap.exists) return true;
  } catch (e) {}

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
`;

if (!re.test(c)) {
  console.log("❌ Tak jumpa function isAdmin() dalam server.js. Cari manual 'async function isAdmin' dulu.");
  process.exit(1);
}
c = c.replace(re, replacement + "\n");

fs.writeFileSync(file, c, "utf8");
console.log("✅ OK: isAdmin() updated (group admins allowed).");
