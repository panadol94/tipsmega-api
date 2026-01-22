require("dotenv").config();
const admin = require("firebase-admin");
const mongoose = require("mongoose");
const fs = require("fs");
const path = require("path");

// =========================================================
// 1. SETUP & CONNECTIONS
// =========================================================

const MONGO_URL = process.env.MONGO_URL || "mongodb://root:example@localhost:27017";
let FB_JSON = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;

// Fallback to local file if Env not set
if (!FB_JSON) {
    const keyPath = path.join(__dirname, "boda8-6879-a951a5589e06.json");
    if (fs.existsSync(keyPath)) {
        console.log("⚠️ Env var missing, loading key from file:", keyPath);
        FB_JSON = fs.readFileSync(keyPath, "utf8");
    }
}

if (!FB_JSON) {
    console.error("❌ Error: Missing FIREBASE_SERVICE_ACCOUNT_JSON in .env and no local key file found.");
    process.exit(1);
}

// Init Firebase
try {
    const serviceAccount = JSON.parse(FB_JSON);
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
    });
    console.log("✅ Firebase Admin initialized");
} catch (e) {
    console.error("❌ Firebase init failed:", e.message);
    process.exit(1);
}

const db = admin.firestore();

// =========================================================
// 2. MONGOOSE SCHEMAS (Must match server.js)
// =========================================================

const UserSchema = new mongoose.Schema({
    phone: { type: String, required: true, unique: true },
    username: { type: String, required: true, unique: true },
    passSalt: String,
    passHash: String,
    verified: { type: Boolean, default: false },
    referralCode: { type: String, unique: true, sparse: true },
    referredBy: String,
    referralCount: { type: Number, default: 0 },
    bonusStars: { type: Number, default: 0 },
    totalClaimedStars: { type: Number, default: 0 },
    bonusGranted: { type: Boolean, default: false },
    bonusDeviceId: String,
}, { timestamps: true });
const User = mongoose.model("User", UserSchema);

const DeviceSchema = new mongoose.Schema({
    deviceId: { type: String, required: true, unique: true },
    stars: { type: Number, default: 0 },
    lastActiveDate: String,
}, { timestamps: true });
const Device = mongoose.model("Device", DeviceSchema);

const TgUserSchema = new mongoose.Schema({
    tgUserId: { type: String, required: true, unique: true },
    phone: { type: String, required: true, index: true },
}, { timestamps: true });
const TgUser = mongoose.model("TgUser", TgUserSchema);

const SettingSchema = new mongoose.Schema({
    key: { type: String, required: true, unique: true },
    mode: { type: String, default: "AUTO" },
    updatedBy: Number,
}, { timestamps: true });
const Setting = mongoose.model("Setting", SettingSchema);

const CompanySchema = new mongoose.Schema({
    name: { type: String, required: true, unique: true },
    link: String,
    caption: String,
    status: { type: String, default: "ACTIVE" },
    mediaType: String,
    storageUrl: String,
}, { timestamps: true });
const Company = mongoose.model("Company", CompanySchema);


// =========================================================
// 3. MIGRATION LOGIC
// =========================================================

async function migrateCollection(fsCollectionName, MongoModel, transformFn) {
    console.log(`\n⏳ Migrating '${fsCollectionName}'...`);
    const snapshot = await db.collection(fsCollectionName).get();

    if (snapshot.empty) {
        console.log(`   No documents in '${fsCollectionName}'.`);
        return;
    }

    let count = 0;
    let skipped = 0;
    let errors = 0;

    for (const doc of snapshot.docs) {
        const data = doc.data();
        try {
            // Transform logic (map Firestore fields to Mongo fields if needed)
            const mongoData = transformFn ? transformFn(doc.id, data) : data;

            // Upsert based on unique key
            let filter = {};
            if (MongoModel.modelName === 'User') filter = { phone: mongoData.phone };
            else if (MongoModel.modelName === 'Device') filter = { deviceId: mongoData.deviceId };
            else if (MongoModel.modelName === 'TgUser') filter = { tgUserId: mongoData.tgUserId };
            else if (MongoModel.modelName === 'Setting') filter = { key: mongoData.key };
            else if (MongoModel.modelName === 'Company') filter = { name: mongoData.name };

            // Ensure undefined values are not passed (Mongoose strictness varies)
            // sanitize
            Object.keys(mongoData).forEach(k => mongoData[k] === undefined && delete mongoData[k]);

            await MongoModel.findOneAndUpdate(filter, mongoData, { upsert: true, new: true });
            count++;
        } catch (e) {
            console.error(`   ❌ Failed doc ${doc.id}: ${e.message}`);
            errors++;
        }
    }
    console.log(`   ✅ Done '${fsCollectionName}': ${count} migrated, ${errors} errors.`);
}

// TRANSFORMERS
function transformUser(docId, data) {
    return {
        ...data,
        phone: data.phone || docId, // Firestore ID is usually the phone
        referralCount: Number(data.referralCount || 0),
        bonusStars: Number(data.bonusStars || 0),
        totalClaimedStars: Number(data.totalClaimedStars || 0),
        // Ensure critical fields are strings
        username: String(data.username || ""),
    };
}

function transformDevice(docId, data) {
    return {
        ...data,
        deviceId: data.deviceId || docId,
        stars: Number(data.stars || 0),
    };
}

function transformTgUser(docId, data) {
    return {
        ...data,
        tgUserId: String(data.tgUserId || docId),
        phone: String(data.phone || ""),
    };
}

function transformCompany(docId, data) {
    return {
        ...data,
        name: data.name || docId,
    };
}

async function start() {
    try {
        await mongoose.connect(MONGO_URL);
        console.log(`✅ Connected to MongoDB: ${MONGO_URL}`);

        // 1. Settings
        const apps = await db.collection('settings').doc('approval').get();
        if (apps.exists) {
            await Setting.findOneAndUpdate(
                { key: 'approval' },
                { key: 'approval', mode: apps.data().mode || 'AUTO' },
                { upsert: true }
            );
            console.log("✅ Migrated Approval Setting");
        }

        // 2. TgUsers
        await migrateCollection('tg_users', TgUser, transformTgUser);

        // 3. User Accounts
        await migrateCollection('users', User, transformUser);

        // 4. Devices
        await migrateCollection('devices', Device, transformDevice);

        // 5. Companies
        await migrateCollection('companies', Company, transformCompany);

        console.log("\n🎉 Migration Complete.");
        process.exit(0);
    } catch (err) {
        console.error("FATAL:", err);
        process.exit(1);
    }
}

start();
