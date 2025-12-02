import { Telegraf } from 'telegraf';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { Api } from 'telegram/tl/index.js';
import cron from 'node-cron';
import fs, { createReadStream } from 'fs';
import { createRequire } from 'module';
import { performance } from 'perf_hooks';
import input from 'input';
import dotenv from 'dotenv';
import Redis from 'ioredis';
import express from 'express';

dotenv.config();

const require = createRequire(import.meta.url);

// -------------------- КОНФІГ --------------------
const API_ID = parseInt(process.env.API_ID);
const API_HASH = process.env.API_HASH;
const BOT_TOKEN = process.env.BOT_TOKEN;

// тут вкажи канал, куди пересилати повідомлення
const TARGET_CHANNEL = '@huyova_bila_tserkva';

const DTEK_CHANNEL = process.env.DTEK_CHANNEL;
const REDIS_URL = process.env.REDIS_URL; 
const PORT = process.env.PORT || 8080;

if (!API_ID || !API_HASH || !BOT_TOKEN || !TARGET_CHANNEL || !DTEK_CHANNEL) {
    console.error('❌ ПОМИЛКА: Не всі змінні оточення налаштовані!');
    process.exit(1);
}

const STATE_FILE = 'last_message_id.txt';
const SESSION_FILE = 'session_telethon_js.txt';
const REDIS_KEY = 'last_processed_message_id';

let clientTG;
const bot = new Telegraf(BOT_TOKEN);
let sessionString = '';

let redisClient = null;

if (REDIS_URL) {
    const redisOptions = {
        maxRetriesPerRequest: null,
        enableReadyCheck: false,
        reconnectOnError: () => true,
        lazyConnect: true,
    };
    if (REDIS_URL.includes('upstash.io')) redisOptions.tls = { rejectUnauthorized: false };
    redisClient = new Redis(REDIS_URL, redisOptions);
    redisClient.on('error', (err) => console.error('❌ Redis помилка:', err.message));
    redisClient.on('ready', () => console.log('✅ Redis готовий'));
} else {
    console.log('⚠️ REDIS_URL відсутній. Використовується локальне сховище (файл).');
}

function getScheduleTexts(date) {
    const months = [
        'січня', 'лютого', 'березня', 'квітня', 'травня', 'червня',
        'липня', 'серпня', 'вересня', 'жовтня', 'листопада', 'грудня'
    ];
    const day = date.getDate();
    const month = months[date.getMonth()];
    return {
        searchText: `⚡️ Київщина: графіки відключень на ${day} ${month}`,
        captionText: `⚡️ Графіки відключень на ${day} ${month} по Київщині`
    };
}

async function findSchedule(searchForDate) {
    const peer = await clientTG.getEntity(DTEK_CHANNEL);
    const { searchText, captionText } = getScheduleTexts(searchForDate);

    const result = await clientTG.invoke(new Api.messages.GetHistory({ peer, limit: 50 }));
    for (const msg of result.messages) {
        if (!msg.message) continue;
        const messageText = msg.message.toLowerCase();
        const searchLower = searchText.toLowerCase();
        if (messageText.includes(searchLower) ||
            (messageText.includes('київщина') && messageText.includes('графік'))) {

            const photos = [];
            if (msg.media?.className === 'MessageMediaPhoto') photos.push(msg.media.photo);

            if (msg.groupedId) {
                result.messages.forEach(otherMsg => {
                    if (otherMsg.groupedId?.toString() === msg.groupedId.toString() &&
                        otherMsg.media?.className === 'MessageMediaPhoto') {
                        photos.push(otherMsg.media.photo);
                    }
                });
                if (photos.length > 2) photos.splice(2);
            }

            if (photos.length > 0) {
                return { photos, messageId: msg.id, text: msg.message, captionText };
            }
        }
    }
    return null;
}

async function downloadPhotos(photos) {
    const filenames = [];
    for (let i = 0; i < photos.length; i++) {
        const buffer = await clientTG.downloadMedia(photos[i], { workers: 1 });
        const filename = `dtek_${i + 1}.jpg`;
        fs.writeFileSync(filename, buffer);
        filenames.push(filename);
    }
    return filenames;
}

async function sendToChannel(filepaths, captionText) {
    if (filepaths.length === 1) {
        await bot.telegram.sendPhoto(TARGET_CHANNEL, { source: createReadStream(filepaths[0]) }, { caption: captionText });
    } else {
        const mediaGroup = filepaths.map((filepath, index) => ({
            type: 'photo',
            media: { source: createReadStream(filepath) },
            caption: index === 0 ? captionText : undefined,
        }));
        await bot.telegram.sendMediaGroup(TARGET_CHANNEL, mediaGroup);
    }

    filepaths.forEach(fp => { if (fs.existsSync(fp)) fs.unlinkSync(fp); });
}

let lastProcessedMessageId = 0;

async function readLastIdFromStore() {
    if (redisClient) {
        const storedId = await redisClient.get(REDIS_KEY);
        return storedId ? Number(storedId) : 0;
    } else if (fs.existsSync(STATE_FILE)) {
        return Number(fs.readFileSync(STATE_FILE, 'utf8'));
    }
    return 0;
}

async function writeLastIdToStore(id) {
    if (redisClient) await redisClient.set(REDIS_KEY, String(id));
    else fs.writeFileSync(STATE_FILE, String(id));
}

async function processDTEK() {
    lastProcessedMessageId = await readLastIdFromStore();

    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setDate(now.getDate() + 1);

    let post = now.getHours() >= 20 ? await findSchedule(tomorrow) || await findSchedule(now) : await findSchedule(now);
    if (!post || post.messageId <= lastProcessedMessageId) return;

    const files = await downloadPhotos(post.photos);
    await sendToChannel(files, post.captionText);

    await writeLastIdToStore(post.messageId);
    lastProcessedMessageId = post.messageId;
    console.log(`✅ Повідомлення надіслано в канал ${TARGET_CHANNEL}`);
}

async function start() {
    sessionString = process.env.SESSION_STRING || (fs.existsSync(SESSION_FILE) ? fs.readFileSync(SESSION_FILE, 'utf8') : '');
    const session = new StringSession(sessionString);

    clientTG = new TelegramClient(session, API_ID, API_HASH, { connectionRetries: 5, useWSS: true });
    await clientTG.connect();
    if (!(await clientTG.isUserAuthorized())) console.error('❌ SESSION_STRING недійсний або потрібна авторизація.');
    else console.log('✅ Telegram авторизовано');

    cron.schedule('*/30 20-23 * * *', processDTEK);
    cron.schedule('*/30 0-7 * * *', processDTEK);
    cron.schedule('20 7 * * *', processDTEK);

    await processDTEK();
}

const app = express();
app.get('/', (_, res) => res.send('DTEK Monitor Bot is running.'));
app.listen(PORT, () => { console.log(`🌍 Server running on port ${PORT}`); start(); });
