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
let rolesCache = null;

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

// ---------- Discord Helpers ----------
async function sendDiscord(content, embeds = []) {
    if (!DISCORD_WEBHOOK_URL) {
        console.warn('[DISCORD] No DISCORD_WEBHOOK_URL set');
        return;
    }

    try {
        await fetch(DISCORD_WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                content: content || undefined,
                embeds: embeds.length ? embeds : undefined,
                username: 'Group Logger',
            }),
        });
    } catch (err) {
        console.error('[DISCORD] Failed to send:', err.message || err);
    }
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
            rolesCache = roles;
            const 