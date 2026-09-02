require('dotenv').config();
const noblox = require('noblox.js');
const http = require('http');

const GROUP_ID = parseInt(process.env.GROUP_ID, 10);
const BASE_RANK_ID = 1;
const TARGET_RANK_ID = 2;
const CHECK_INTERVAL_MS = 1500;
const RANK_COOLDOWN_MS = 15000;
const STATUS_INTERVAL_MS = 2 * 60 * 60 * 1000; // 2 hours
const MAX_RETRIES = 4;
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const processingSet = new Set();
const recentlyRanked = new Map();
let baseRoleSetId = null;
let isPolling = false;
let lastAuditLogId = null;

// Dummy server for Render
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Roblox Auto-Ranker + Logger is running');
}).listen(PORT, () => {
    console.log(`[SYSTEM] Dummy server running on port ${PORT}`);
});

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
                const delay = 1200 * attempt;
                console.warn(`[RETRY ${attempt}/${MAX_RETRIES}] ${label} → 500. Waiting ${delay}ms...`);
                await sleep(delay);
                continue;
            }
            throw err;
        }
    }
}

// ---------- Discord Helpers (Rate-limit safe) ----------
const discordQueue = [];
let isProcessingDiscord = false;

async function processDiscordQueue() {
    if (isProcessingDiscord || discordQueue.length === 0) return;
    isProcessingDiscord = true;

    while (discordQueue.length > 0) {
        const { content, embeds, resolve } = discordQueue.shift();

        try {
            const res = await fetch(DISCORD_WEBHOOK_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    content: content || undefined,
                    embeds: embeds?.length ? embeds : undefined,
                    username: 'Group Logger',
                }),
            });

            if (res.status === 429) {
                const retryAfter = Number(res.headers.get('Retry-After') || 5);
                console.warn(`[DISCORD] Rate limited. Waiting ${retryAfter}s...`);
                discordQueue.unshift({ content, embeds, resolve });
                await sleep(retryAfter * 1000);
                continue;
            }

            if (!res.ok) {
                const text = await res.text();
                throw new Error(`Discord ${res.status}: ${text}`);
            }

            resolve(true);
        } catch (err) {
            console.error('[DISCORD] Failed to send:', err.message || err);
            resolve(false);
        }

        await sleep(800);
    }

    isProcessingDiscord = false;
}

async function sendDiscord(content, embeds = []) {
    if (!DISCORD_WEBHOOK_URL) {
        console.warn('[DISCORD] No DISCORD_WEBHOOK_URL set');
        return;
    }

    return new Promise((resolve) => {
        discordQueue.push({ content, embeds, resolve });
        processDiscordQueue();
    });
}

function makeEmbed(title, description, color = 0x5865F2) {
    return {
        title,
        description,
        color,
        timestamp: new Date().toISOString(),
        footer: { text: 'Group Logger' },
    };
}

// ---------- Ranking Logic ----------
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
            recentlyRanked.set(userId, Date.now());
            await sendDiscord(null, [
                makeEmbed(
                    '🆕 New Member Ranked',
                    `**${username}** (\`${userId}\`)\nRanked to **${result.name}** (Rank ${TARGET_RANK_ID})`,
                    0x57F287
                ),
            ]);
        } else {
            recentlyRanked.set(userId, Date.now());
        }
    } catch (err) {
        const details = err?.errors || err?.response?.data || err?.message || err;
        console.error(`[FAILED] ${username} (${userId}):`, details);
    } finally {
        processingSet.delete(userId);
    }
}

// ---------- Audit Log (Polling) ----------
async function checkAuditLog() {
    try {
        // Correct parameter order: group, actionType, userId, sortOrder, limit
        const logs = await withRetry(
            () => noblox.getAuditLog(GROUP_ID, null, null, "Desc", 25),
            'getAuditLog'
        );

        if (!logs || !logs.data || logs.data.length === 0) return;

        const entries = logs.data.sort((a, b) => a.id - b.id);

        for (const entry of entries) {
            if (lastAuditLogId && entry.id <= lastAuditLogId) continue;
            lastAuditLogId = entry.id;

            const actionType = entry.actionType;
            const desc = entry.description || {};
            const targetName = desc.TargetName || desc.Target?.name || 'Unknown';
            const targetId = desc.TargetId || desc.Target?.id || '?';
            const actor = entry.actor?.user?.username || entry.actor?.username || 'Unknown';

            // Promotion / Demotion
            if (actionType === 'ChangeRank') {
                const oldRank = desc.OldRoleSetName || 'Unknown';
                const newRank = desc.NewRoleSetName || 'Unknown';
                const msg = `**${targetName}** (\`${targetId}\`)\nFrom **${oldRank}** → **${newRank}**\nBy: ${actor}`;
                console.log(`[RANK CHANGE] ${targetName}: ${oldRank} → ${newRank}`);
                await sendDiscord(null, [
                    makeEmbed('⬆️ Rank Changed (Promotion / Demotion)', msg, 0xFEE75C),
                ]);
            }

            // Leave / Exile / Kick / Removal
            if (actionType === 'RemoveMember') {
                const msg = `**${targetName}** (\`${targetId}\`)\nRemoved / Exiled by: **${actor}**`;
                console.log(`[LEAVE / EXILE] ${targetName} was removed by ${actor}`);
                await sendDiscord(null, [
                    makeEmbed('🚪 Member Left / Exiled / Removed', msg, 0xED4245),
                ]);
            }

            // New member
            if (actionType === 'AcceptJoinRequest') {
                const msg = `**${targetName}** (\`${targetId}\`)\nAccepted by: **${actor}**`;
                console.log(`[NEW MEMBER] ${targetName} joined the group`);
                await sendDiscord(null, [
                    makeEmbed('✅ New Member Joined', msg, 0x57F287),
                ]);
            }
        }
    } catch (err) {
        console.error('[AUDIT] Poll error:', err.message || err);
    }
}

async function startAuditLogger() {
    console.log('[SYSTEM] Audit log polling started (every 20s)');
    await checkAuditLog();
    setInterval(checkAuditLog, 20000);
}

// ---------- 2-Hour Status Update ----------
async function sendGroupStatus() {
    try {
        const group = await withRetry(() => noblox.getGroup(GROUP_ID), 'getGroup');
        const memberCount = group.memberCount || 'Unknown';
        const groupName = group.name || 'Group';
        const shout = group.shout?.body ? group.shout.body.slice(0, 200) : 'No shout';
        const description =
            `**Group:** ${groupName}\n` +
            `**Members:** ${memberCount.toLocaleString()}\n` +
            `**Current Shout:** ${shout}\n\n` +
            `Bot is online and ranking Rank ${BASE_RANK_ID} → Rank ${TARGET_RANK_ID}`;
        await sendDiscord(null, [
            makeEmbed('📊 Group Status Update', description, 0x5865F2),
        ]);
        console.log('[STATUS] 2-hour group update sent');
    } catch (err) {
        console.error('[STATUS] Failed to send update:', err.message || err);
    }
}

// ---------- Main ----------
async function startAutoRanker() {
    try {
        const currentUser = await noblox.setCookie(process.env.ROBLOX_COOKIE);
        const botUserId = Number(currentUser.UserID || currentUser.id);
        const botUsername = currentUser.UserName || currentUser.name;

        console.log('==================================================');
        console.log(`Bot Active: ${botUsername} (ID: ${botUserId})`);
        console.log(`Mode: Rank 1 → ${TARGET_RANK_ID} + Discord Logger`);
        console.log(`Poll interval: ${CHECK_INTERVAL_MS}ms | Cooldown: ${RANK_COOLDOWN_MS / 1000}s`);
        console.log('==================================================\n');

        await startAuditLogger();

        setTimeout(() => sendGroupStatus(), 30000);
        setInterval(sendGroupStatus, STATUS_INTERVAL_MS);

        console.log('[SYSTEM] Bot is running. Waiting for Rank 1 members...\n');

        setInterval(async () => {
            if (isPolling) return;
            isPolling = true;
            try {
                const rank1Members = await getRank1Members();
                if (!rank1Members) return;

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