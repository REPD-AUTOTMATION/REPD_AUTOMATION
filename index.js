require('dotenv').config();
const noblox = require('noblox.js');

const GROUP_ID = parseInt(process.env.GROUP_ID, 10);
const BASE_RANK_ID = 1;          // Member
const TARGET_RANK_ID = 2;        // Police Recruit
const CHECK_INTERVAL_MS = 1500;
const RANK_COOLDOWN_MS = 15000;  // 45 seconds cooldown after ranking
const MAX_RETRIES = 4;

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const processingSet = new Set();
const recentlyRanked = new Map(); // userId → timestamp
let baseRoleSetId = null;
let isPolling = false;

function getUserId(player) {
    if (!player) return null;
    const id = player.userId || player.id;
    return id ? Number(id) : null;
}

async function withRetry(fn, label = 'API call') {
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            return await fn();
        } catch (err) {
            const msg = err?.message || String(err);
            const is500 = err?.httpStatusCode === 500 ||
                          msg.includes('InternalServerError') ||
                          msg.includes('Internal Server Error');

            if (is500 && attempt < MAX_RETRIES) {
                const delay = 1500 * attempt;
                console.warn(`[RETRY ${attempt}/${MAX_RETRIES}] ${label} → 500. Waiting ${delay}ms...`);
                await sleep(delay);
                continue;
            }
            throw err;
        }
    }
}

async function getRank1Members() {
    try {
        if (!baseRoleSetId) {
            const roles = await withRetry(() => noblox.getRoles(GROUP_ID), 'getRoles');
            const baseRole = roles.find(r => r.rank === BASE_RANK_ID);
            if (!baseRole) throw new Error(`Role for Rank ${BASE_RANK_ID} not found.`);
            baseRoleSetId = baseRole.id;
            console.log(`[SYSTEM] Cached roleset ID for Rank ${BASE_RANK_ID}: ${baseRoleSetId}`);
        }

        const members = await withRetry(
            () => noblox.getPlayers(GROUP_ID, baseRoleSetId),
            'getPlayers'
        );
        return Array.isArray(members) ? members : [];
    } catch (err) {
        console.warn(`[WARN] getRank1Members failed: ${err.message || err}`);
        return null;
    }
}

async function rankMember(userId, username) {
    if (processingSet.has(userId)) return;

    // Skip if we ranked this user recently
    const lastRanked = recentlyRanked.get(userId);
    if (lastRanked && Date.now() - lastRanked < RANK_COOLDOWN_MS) {
        return;
    }

    processingSet.add(userId);

    try {
        const currentRank = await withRetry(
            () => noblox.getRankInGroup(GROUP_ID, userId),
            `getRankInGroup ${userId}`
        );

        if (currentRank === BASE_RANK_ID) {
            console.log(`\n[NEW MEMBER] ${username} (${userId}) is Rank 1`);
            console.log(`[RANKING] ${username} → Rank ${TARGET_RANK_ID}...`);

            const result = await withRetry(
                () => noblox.setRank(GROUP_ID, userId, TARGET_RANK_ID),
                `setRank ${userId}`
            );

            console.log(`[SUCCESS] Ranked ${username} (${userId}) → ${result.name}`);
            recentlyRanked.set(userId, Date.now()); // start cooldown
        } else {
            // Not Rank 1 – put a short cooldown so we don't keep checking them every 3s
            recentlyRanked.set(userId, Date.now());
        }
    } catch (err) {
        console.error(`[FAILED] ${username} (${userId}): ${err.message || err}`);
        // No cooldown on failure → will retry
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
        console.log(`Mode: Rank 1 → ${TARGET_RANK_ID} (supports rejoin)`);
        console.log(`Poll interval: ${CHECK_INTERVAL_MS}ms | Cooldown: ${RANK_COOLDOWN_MS / 1000}s`);
        console.log('==================================================\n');

        console.log('[SYSTEM] Bot is running. Waiting for Rank 1 members...\n');

        setInterval(async () => {
            if (isPolling) return;
            isPolling = true;

            try {
                const rank1Members = await getRank1Members();
                if (!rank1Members) return;

                // Clean old cooldown entries (memory hygiene)
                const now = Date.now();
                for (const [id, ts] of recentlyRanked) {
                    if (now - ts > RANK_COOLDOWN_MS * 3) {
                        recentlyRanked.delete(id);
                    }
                }

                for (const player of rank1Members) {
                    const uid = getUserId(player);
                    if (!uid || uid === botUserId) continue;

                    if (!processingSet.has(uid)) {
                        rankMember(uid, player.username || `User ${uid}`);
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
        process.exit(1);
    }
}

process.on('unhandledRejection', (reason) => {
    console.error('[UNHANDLED REJECTION]', reason?.message || reason);
});
process.on('uncaughtException', (err) => {
    console.error('[UNCAUGHT EXCEPTION]', err?.message || err);
});

startAutoRanker();