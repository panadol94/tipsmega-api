/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * Comprehensive Database Seeder
 * Seeds Games, Companies, and Sample Users
 * Run: node seed-all.js
 */
require("dotenv").config();
const mongoose = require("mongoose");

const MONGO_URL = process.env.MONGO_URL || "mongodb://root:example@localhost:27017";

// ========== SCHEMAS ==========

const GameSchema = new mongoose.Schema({
    name: { type: String, required: true },
    icon: { type: String, default: "🎰" },
    category: { type: String, default: "slots" },
    rtpMin: { type: Number, default: 85 },
    rtpMax: { type: Number, default: 98 },
    isHot: { type: Boolean, default: false },
    isNew: { type: Boolean, default: true },
    enabled: { type: Boolean, default: true },
    order: { type: Number, default: 0 }
}, { timestamps: true });

const CompanySchema = new mongoose.Schema({
    name: { type: String, required: true, unique: true },
    website: { type: String },
    contact: { type: String },
    mediaUrls: [String]
}, { timestamps: true });

const UserSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    telegramId: { type: String },
    stars: { type: Number, default: 0 },
    isBanned: { type: Boolean, default: false },
    lastActive: Date
}, { timestamps: true });

const Game = mongoose.model("Game", GameSchema);
const Company = mongoose.model("Company", CompanySchema);
const User = mongoose.model("User", UserSchema);

// ========== SAMPLE DATA ==========

const SAMPLE_GAMES = [
    { name: "Great Blue", icon: "🐋", category: "slots", rtpMin: 92, rtpMax: 96, isHot: true, order: 1 },
    { name: "Highway Kings", icon: "🚛", category: "slots", rtpMin: 90, rtpMax: 95, isHot: true, order: 2 },
    { name: "Safari Heat", icon: "🦁", category: "slots", rtpMin: 91, rtpMax: 97, isHot: false, order: 3 },
    { name: "Dolphin Reef", icon: "🐬", category: "slots", rtpMin: 89, rtpMax: 96, isHot: true, order: 4 },
    { name: "Panther Moon", icon: "🐆", category: "slots", rtpMin: 88, rtpMax: 95, isHot: false, order: 5 },
    { name: "Bonus Bears", icon: "🐻", category: "slots", rtpMin: 90, rtpMax: 98, isHot: true, order: 6 },
    { name: "Wukong", icon: "🐒", category: "slots", rtpMin: 91, rtpMax: 97, isNew: true, order: 7 },
    { name: "Captain Treasure", icon: "🏴‍☠️", category: "slots", rtpMin: 87, rtpMax: 94, isHot: false, order: 8 },
    { name: "Golden Tour", icon: "⛳", category: "slots", rtpMin: 89, rtpMax: 95, isHot: false, order: 9 },
    { name: "Irish Luck", icon: "☘️", category: "slots", rtpMin: 90, rtpMax: 96, isHot: false, order: 10 },
    { name: "Jin Qian Wa", icon: "🧧", category: "slots", rtpMin: 92, rtpMax: 98, isHot: true, isNew: true, order: 11 },
    { name: "Koi Gate", icon: "🐟", category: "slots", rtpMin: 88, rtpMax: 95, isHot: false, order: 12 },
    { name: "Lucky Koi", icon: "🎏", category: "slots", rtpMin: 89, rtpMax: 96, isHot: false, order: 13 },
    { name: "Mayan Gold", icon: "🏛️", category: "slots", rtpMin: 90, rtpMax: 97, isHot: false, order: 14 },
    { name: "Money Tree", icon: "🌳", category: "slots", rtpMin: 91, rtpMax: 98, isHot: true, order: 15 },
    { name: "Ocean Paradise", icon: "🌊", category: "slots", rtpMin: 88, rtpMax: 95, isHot: false, order: 16 },
    { name: "Queen Of Egypt", icon: "👸", category: "slots", rtpMin: 89, rtpMax: 96, isHot: false, order: 17 },
    { name: "Three Kingdom", icon: "⚔️", category: "slots", rtpMin: 90, rtpMax: 97, isHot: true, order: 18 },
    { name: "Thunder God", icon: "⚡", category: "slots", rtpMin: 91, rtpMax: 98, isNew: true, order: 19 },
    { name: "Wild Giant Panda", icon: "🐼", category: "slots", rtpMin: 92, rtpMax: 97, isHot: true, order: 20 },
];

const SAMPLE_COMPANIES = [
    { name: "Mega888", website: "https://mega888.com", contact: "@mega888official" },
    { name: "Pussy888", website: "https://pussy888.com", contact: "@pussy888support" },
    { name: "918Kiss", website: "https://918kiss.com", contact: "@918kiss" },
    { name: "XE88", website: "https://xe88.com", contact: "@xe88official" },
    { name: "Joker123", website: "https://joker123.net", contact: "@joker123" },
];

const SAMPLE_USERS = [
    { username: "TestUser1", telegramId: "1001", stars: 5, lastActive: new Date() },
    { username: "TestUser2", telegramId: "1002", stars: 10, lastActive: new Date() },
    { username: "TestUser3", telegramId: "1003", stars: 3, lastActive: new Date() },
];

// ========== SEED FUNCTION ==========

async function seed() {
    try {
        console.log("🔌 Connecting to MongoDB...");
        await mongoose.connect(MONGO_URL);
        console.log("✅ Connected to MongoDB");

        // Games
        const gamesCount = await Game.countDocuments();
        if (gamesCount === 0) {
            console.log("🌱 Seeding games...");
            await Game.insertMany(SAMPLE_GAMES);
            console.log(`✅ Seeded ${SAMPLE_GAMES.length} games`);
        } else {
            console.log(`⏭️  Skipping games (${gamesCount} already exist)`);
        }

        // Companies
        const companiesCount = await Company.countDocuments();
        if (companiesCount === 0) {
            console.log("🌱 Seeding companies...");
            await Company.insertMany(SAMPLE_COMPANIES);
            console.log(`✅ Seeded ${SAMPLE_COMPANIES.length} companies`);
        } else {
            console.log(`⏭️  Skipping companies (${companiesCount} already exist)`);
        }

        // Users
        const usersCount = await User.countDocuments();
        if (usersCount === 0) {
            console.log("🌱 Seeding users...");
            await User.insertMany(SAMPLE_USERS);
            console.log(`✅ Seeded ${SAMPLE_USERS.length} users`);
        } else {
            console.log(`⏭️  Skipping users (${usersCount} already exist)`);
        }

        // Final counts
        console.log("\n📊 Final Counts:");
        console.log(`   Games: ${await Game.countDocuments()}`);
        console.log(`   Companies: ${await Company.countDocuments()}`);
        console.log(`   Users: ${await User.countDocuments()}`);

    } catch (err) {
        console.error("❌ Error:", err);
        process.exit(1);
    } finally {
        await mongoose.disconnect();
        console.log("\n🔌 Disconnected from MongoDB");
    }
}

seed();
