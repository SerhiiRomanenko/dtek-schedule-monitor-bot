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
const FormData = require('form-data');

// -------------------- КОНФІГ --------------------
const API_ID = parseInt(process.env.API_ID);
const API_HASH = process.env.API_HASH;
const BOT_TOKEN = process.env.BOT_TOKEN;
const TARGET_CHAT_ID = process.env.TARGET_CHAT_ID;
const DTEK_CHANNEL = process.env.DTEK_CHANNEL;
const REDIS_URL = process.env.REDIS_URL; 

const PORT = process.env.PORT || 8080;

if (!API_ID || !API_HASH || !BOT_TOKEN || !TARGET_CHAT_ID || !DTEK_CHANNEL) {
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

    if (REDIS_URL.includes('upstash.io')) {
        redisOptions.tls = { rejectUnauthorized: false };
    }

    redisClient = new Redis(REDIS_URL, redisOptions);

    redisClient.on('error', (err) => {
        console.error('❌ Redis помилка:', err.message);
    });

    redisClient.on('connect', () => console.log('🔌 Redis: socket connected (event).'));
    redisClient.on('ready', () => console.log('✅ Redis: client ready (event).'));
    redisClient.on('end', () => console.log('⚠️ Redis: connection closed (event).'));

    console.log('ℹ️ Redis ініціалізовано (lazyConnect=true). Не викликаю connect() вручну — Upstash-safe.');
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
        captionText: `⚡️ ! Графіки відключень на ${day} ${month} по Київщині`
    };
}

async function authorize() {
    console.log('--- ПОТРІБНА АВТОРИЗАЦІЯ (TELEGRAM JS) ---');

    try {
        await clientTG.start({
            phoneNumber: async () => await input.text('Телефон (+380...): '),
            password: async () => await input.text('Пароль 2FA: '),
            phoneCode: async () => await input.text('Код з Telegram: '),
            onError: (err) => console.error('Помилка авторизації:', err),
        });

        sessionString = clientTG.session.save();
        fs.writeFileSync(SESSION_FILE, sessionString);

        console.log(`🎉 Успішний вхід!`);
        return true;
    } catch (error) {
        console.error(`❌ Критична помилка авторизації: ${error.message}`);
        throw error;
    }
}

async function findSchedule(searchForDate) {
    try {
        const peer = await clientTG.getEntity(DTEK_CHANNEL);
        const { searchText, captionText } = getScheduleTexts(searchForDate);
        
        console.log(`🔍 Шукаю пост з текстом: "${searchText}"`);

        const result = await clientTG.invoke(
            new Api.messages.GetHistory({
                peer: peer,
                limit: 50,
            })
        );

        for (const msg of result.messages) {
            if (!msg.message) continue;

            const messageText = msg.message.toLowerCase();
            const searchLower = searchText.toLowerCase();

            if (messageText.includes(searchLower) ||
                (messageText.includes('київщина') && messageText.includes('графік'))) {

                const photos = [];

                if (msg.media?.className === 'MessageMediaPhoto') {
                    photos.push(msg.media.photo);
                }

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
                    console.log(`✅ Знайдено пост ID ${msg.id} з ${photos.length} фото`);
                    return {
                        photos,
                        messageId: msg.id,
                        text: msg.message,
                        captionText,
                    };
                }
            }
        }

        console.log(`❌ Пост на ${searchForDate.toLocaleDateString('uk-UA')} не знайдено`);
        return null;

    } catch (e) {
        console.error('🛑 Помилка пошуку:', e.message);
        throw e;
    }
}

async function downloadPhotos(photos) {
    try {
        const filenames = [];
        for (let i = 0; i < photos.length; i++) {
            console.log(`📥 Завантажую фото ${i + 1}/${photos.length}...`);
            const buffer = await clientTG.downloadMedia(photos[i], { workers: 1 });
            const filename = `dtek_${i + 1}.jpg`;
            fs.writeFileSync(filename, buffer);
            filenames.push(filename);
            console.log(`✅ Збережено: ${filename}`);
        }
        return filenames;
    } catch (e) {
        console.error('🛑 Помилка завантаження фото:', e.message);
        throw e;
    }
}

async function sendToChannel(filepaths, postText, captionText) {
    try {
        const caption = captionText;

        if (filepaths.length === 1) {
            await bot.telegram.sendPhoto(
                TARGET_CHAT_ID,
                { source: createReadStream(filepaths[0]) },
                { caption, parse_mode: 'Markdown' }
            );
        } else {
            const mediaGroup = filepaths.map((filepath, index) => ({
                type: 'photo',
                media: { source: createReadStream(filepath) },
                caption: index === 0 ? caption : undefined,
                parse_mode: index === 0 ? 'Markdown' : undefined,
            }));

            await bot.telegram.sendMediaGroup(TARGET_CHAT_ID, mediaGroup);
        }

        console.log(`✅ Надіслано ${filepaths.length} фото`);

        filepaths.forEach(filepath => {
            if (fs.existsSync(filepath)) {
                fs.unlinkSync(filepath);
                console.log(`🗑️ Видалено: ${filepath}`);
            }
        });

    } catch (error) {
        console.error('❌ Помилка надсилання Telegraf:', error.message);
        throw error;
    }
}

let lastProcessedMessageId = 0;

async function readLastIdFromStore() {
    if (redisClient) {
        try {
            const storedId = await redisClient.get(REDIS_KEY);
            return storedId ? Number(storedId) : 0;
        } catch (err) {
            console.error('❌ Помилка читання Redis:', err.message);
            return 0;
        }
    } else {
        if (fs.existsSync(STATE_FILE)) {
            return Number(fs.readFileSync(STATE_FILE, 'utf8'));
        }
        return 0;
    }
}

async function writeLastIdToStore(id) {
    try {
        if (redisClient) {
            await redisClient.set(REDIS_KEY, String(id));
        } else {
            fs.writeFileSync(STATE_FILE, String(id));
        }
    } catch (err) {
        console.error('❌ Помилка запису стану:', err.message);
    }
}

async function processDTEK() {
    const startTime = performance.now();
    console.log('\n--- Запуск моніторингу DTEK ---');
    console.log(`📅 ${new Date().toLocaleString('uk-UA')}`);

    lastProcessedMessageId = await readLastIdFromStore();
    console.log(`▶ Останній оброблений ID: ${lastProcessedMessageId}`);

    try {
        let post = null;
        const now = new Date();
        const tomorrow = new Date(now);
        tomorrow.setDate(now.getDate() + 1);

        if (now.getHours() >= 20) {
            post = await findSchedule(tomorrow) || await findSchedule(now);
        } else {
            post = await findSchedule(now);
        }

        if (!post) {
            console.log('⏳ Графік ще не опубліковано');
            return;
        }

        if (post.messageId <= lastProcessedMessageId) {
            console.log('➡️ Цей пост вже оброблено');
            return;
        }

        const files = await downloadPhotos(post.photos);
        await sendToChannel(files, post.text, post.captionText);

        await writeLastIdToStore(post.messageId);
        lastProcessedMessageId = post.messageId;

        const endTime = performance.now();
        console.log(`✅ Готово! ${((endTime - startTime) / 1000).toFixed(2)} s`);

    } catch (err) {
        console.error('🛑 Критична помилка:', err.message);
    }
}

async function start() {
    let sessionStringFromEnv = process.env.SESSION_STRING;

    try {
        if (sessionStringFromEnv) {
            sessionString = sessionStringFromEnv;
            console.log('✅ Використовується сесія із змінних оточення (Render).');
        } else if (fs.existsSync(SESSION_FILE)) {
            sessionString = fs.readFileSync(SESSION_FILE, 'utf8');
        }

        const session = new StringSession(sessionString);

        clientTG = new TelegramClient(session, API_ID, API_HASH, {
            connectionRetries: 5,
            useWSS: true,
            testServers: false,
        });

        console.log('🔄 Підключення до Telegram...');
        await clientTG.connect();

        if (!(await clientTG.isUserAuthorized())) {
            console.error('❌ SESSION_STRING недійсний або потрібна авторизація.');
        } else {
            console.log('✅ Telegram авторизовано');
        }

    } catch (e) {
        console.error(`❌ Помилка підключення Telegram: ${e.message}`);
    }

    cron.schedule('*/30 20-23 * * *', processDTEK);
    cron.schedule('*/30 0-7 * * *', processDTEK);
    cron.schedule('20 7 * * *', processDTEK);

    console.log('✅ Cron активовано.');

    processDTEK();
}

const app = express();

app.get('/', (_, res) => {
    res.status(200).send('DTEK Monitor Bot is running.');
});

const server = app.listen(PORT, async () => {
    console.log(`🌍 Web Service on port ${PORT}`);
    await start();
});

async function shutdown(signal) {
    console.log(`\n🛑 Shutdown signal received: ${signal}`);
    try {
        server.close();
        if (redisClient) {
            try {
                await redisClient.quit();
                console.log('✅ Redis: quit completed');
            } catch (e) {
                console.warn('⚠️ Redis quit failed, disconnecting:', e.message);
                try { redisClient.disconnect(); } catch {}
            }
        }
        if (clientTG) {
            try { await clientTG.disconnect(); } catch {}
        }
    } catch (e) {
        console.error('❌ Error during shutdown:', e.message);
    } finally {
        process.exit(0);
    }
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (err) => {
    console.error('uncaughtException:', err);
    shutdown('uncaughtException');
});
process.on('unhandledRejection', (reason) => {
    console.error('unhandledRejection:', reason);
});

