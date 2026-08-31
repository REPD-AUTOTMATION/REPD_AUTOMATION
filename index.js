require('dotenv').config();
const noblox = require('noblox.js');

const GROUP_ID = parseInt(process.env.GROUP_ID, 10);
const BASE_RANK_ID = 1;   // Member
const TARGET_RANK_ID = 2; // Police Recruit

const CHECK_INTERVAL_MS = 2500; // 2.5 seconds poll rate

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const processedSet = new Set();
const processingSet = new Set();
let baseRoleSetId = null;
let isPolling = false;

function getUserId(player) {
    if (!player) return null;
    const id = player.userId || player.id;
    return id ? Number(id) : null;
}

// Fetch ONLY Rank 1 members from Roblox (Bypasses 99% of your group)
async function getRank1Members() {
    try {
        if (!baseRoleSetId) {
            const roles = await noblox.getRoles(GROUP_ID);
            const baseRole = roles.find(r => r.rank === BASE_RANK_ID);
            if (!baseRole) throw new Error(`Role for Rank ${BASE_RANK_ID} not found.`);
            baseRoleSetId = baseRole.id;
        }

        const members = await noblox.getPlayers(GROUP_ID, baseRoleSetId);
        return Array.isArray(members) ? members : [];
    } catch (err) {
        console.warn(`[WARN] Roblox API glitch: ${err.message || err}`);
        return null;
    }
}

async function rankMember(userId, username) {
    if (processingSet.has(userId) || processedSet.has(userId)) return;
    processingSet.add(userId);

    try {
        console.log(`\n[NEW UNRANKED MEMBER] ${username} (${userId})`);
        
        const currentRank = await noblox.getRankInGroup(GROUP_ID, userId);
        
        if (currentRank === BASE_RANK_ID) {
            console.log(`[RANKING] ${username} (${userId}) → Rank ${TARGET_RANK_ID}...`);
            const result = await noblox.setRank(GROUP_ID, userId, TARGET_RANK_ID);
            console.log(`[SUCCESS] Ranked ${username} (${userId}) → ${result.name}`);
        } else {
            console.log(`[SKIP] ${username} (${userId}) is already Rank ${currentRank}`);
        }

        processedSet.add(userId);
    } catch (err) {
        console.error(`[FAILED] ${username} (${userId}): ${err.message || err}`);
    } finally {
        processingSet.delete(userId);
    }
}

async function startAutoRanker() {
    try {
        const currentUser = await noblox.setCookie(process.env.ROBLOX_COOKIE);
        const botUserId = Number(currentUser.UserID || currentUser.id);
        const botUsername = currentUser.UserName || currentUser.name;

        console.log('==================================================');
        console.log(`Bot Active: ${botUsername} (ID: ${botUserId})`);
        console.log(`Mode: High-Scale Rank-1 Targeted Auto-Ranker`);
        console.log(`Auto-ranking Rank ${BASE_RANK_ID} → Rank ${TARGET_RANK_ID}`);
        console.log('==================================================\n');

        console.log('[SYSTEM] Fetching active Rank 1 queue...');
        const initialMembers = await getRank1Members();

        if (initialMembers) {
            console.log(`[SYSTEM] Found ${initialMembers.length} unranked user(s) on startup. Processing...`);
            for (const player of initialMembers) {
                const uid = getUserId(player);
                if (uid && uid !== botUserId) {
                    await rankMember(uid, player.username || `User ${uid}`);
                }
            }
        }
        console.log('\n[SYSTEM] Startup complete. Listening for new joins every 2.5s...\n');

        // Fast Polling Loop
        setInterval(async () => {
            if (isPolling) return;
            isPolling = true;

            try {
                const rank1Members = await getRank1Members();
                if (!rank1Members) return;

                const currentRank1Ids = new Set();

                for (const player of rank1Members) {
                    const uid = getUserId(player);
                    if (!uid || uid === botUserId) continue;

                    currentRank1Ids.add(uid);

                    // If a user in Rank 1 hasn't been processed yet, rank them instantly
                    if (!processedSet.has(uid)) {
                        rankMember(uid, player.username || `User ${uid}`);
                    }
                }

                // Clean memory if someone left Rank 1 without being processed by the bot
                for (const id of processedSet) {
                    if (!currentRank1Ids.has(id)) {
                        processedSet.delete(id);
                    }
                }

            } catch (err) {
                console.warn(`[WARN] Loop error: ${err.message || err}`);
            } finally {
                isPolling = false;
            }
        }, CHECK_INTERVAL_MS);

    } catch (error) {
        console.error('[INITIALIZATION ERROR]', error?.message || error);
    }
}

startAutoRanker();