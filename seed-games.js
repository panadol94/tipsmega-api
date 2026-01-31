/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * Seed Games Collection
 * Run: node seed-games.js
 */
require("dotenv").config();
const mongoose = require("mongoose");

const MONGO_URL = process.env.MONGO_URL || "mongodb://root:example@localhost:27017";

// Games Schema (same as server.js)
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
const Game = mongoose.model("Game", GameSchema);

// Sample games data
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

async function seed() {
    try {
        console.log("🔌 Connecting to MongoDB...");
        await mongoose.connect(MONGO_URL);
        console.log("✅ Connected to MongoDB");

        // Check existing games
        const existingCount = await Game.countDocuments();
        console.log(`📊 Existing games: ${existingCount}`);

        if (existingCount > 0) {
            console.log("⚠️ Games already exist. Skipping seed.");
            console.log("   To re-seed, run: db.games.deleteMany({}) in MongoDB first");
        } else {
            console.log("🌱 Seeding games...");
            await Game.insertMany(SAMPLE_GAMES);
            console.log(`✅ Seeded ${SAMPLE_GAMES.length} games successfully!`);
        }

        // Final count
        const finalCount = await Game.countDocuments();
        console.log(`📊 Total games now: ${finalCount}`);

    } catch (err) {
        console.error("❌ Error:", err);
    } finally {
        await mongoose.disconnect();
        console.log("🔌 Disconnected from MongoDB");
    }
}

seed();
