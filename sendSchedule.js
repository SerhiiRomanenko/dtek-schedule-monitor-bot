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
import express from 'express'; // <--- НОВИЙ ІМПОРТ: EXPRESS

// Завантаження змінних з .env файлу
dotenv.config();

const require = createRequire(import.meta.url);
const FormData = require('form-data'); 

// -------------------- КОНФІГУРАЦІЯ --------------------
const API_ID = parseInt(process.env.API_ID);
const API_HASH = process.env.API_HASH;
const BOT_TOKEN = process.env.BOT_TOKEN;
const TARGET_CHAT_ID = process.env.TARGET_CHAT_ID;
const DTEK_CHANNEL = process.env.DTEK_CHANNEL;
const REDIS_URL = process.env.REDIS_URL;

// --- КОНФІГУРАЦІЯ WEB SERVICE ---
// Render вимагає порт. Якщо не вказано, використовуємо 8080.
const PORT = process.env.PORT || 8080; 
// ----------------------------------

if (!API_ID || !API_HASH || !BOT_TOKEN || !TARGET_CHAT_ID || !DTEK_CHANNEL) {
   console.error('❌ ПОМИЛКА: Не всі змінні оточення налаштовані!');
   process.exit(1);
}

const STATE_FILE = 'last_message_id.txt';
const SESSION_FILE = 'session_telethon_js.txt';
const REDIS_KEY = 'last_processed_message_id'; 

// -------------------- ІНІЦІАЛІЗАЦІЯ --------------------
let clientTG;
const bot = new Telegraf(BOT_TOKEN);
let sessionString = '';

let redisClient = null;
if (REDIS_URL) {
    redisClient = new Redis(REDIS_URL);
    redisClient.on('error', (err) => console.error('❌ Помилка Redis:', err.message));
    console.log('✅ Redis ініціалізовано та підключено.');
} else {
    console.log('⚠️ Змінна REDIS_URL відсутня. Використовується локальне сховище (нестійке на Render).');
}

// -------------------- ДОПОМІЖНІ ФУНКЦІЇ (без змін) --------------------

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
// ... (Логіка авторизації залишена для повноти, але не використовується на Render)
   try {
      await clientTG.start({
         phoneNumber: async () => await input.text('Введіть ваш номер телефону (+380...): '),
         password: async () => await input.text('Введіть пароль (для 2FA, якщо є): '),
         phoneCode: async () => await input.text('Введіть код, який прийшов вам у Telegram: '),
         onError: (err) => console.error('Помилка авторизації:', err),
      });
      sessionString = clientTG.session.save();
      fs.writeFileSync(SESSION_FILE, sessionString);
      console.log(`🎉 Успішний вхід! Сесію збережено у файлі '${SESSION_FILE}'.`);
      return true;
   } catch (error) {
      console.error(`❌ Критична помилка авторизації: ${error.message}`);
      throw error;
   }
}

// ... (Функції findSchedule, downloadPhotos, sendToChannel без змін)

async function findSchedule(searchForDate) {
   try {
      const peer = await clientTG.getEntity(DTEK_CHANNEL);
      const { searchText, captionText } = getScheduleTexts(searchForDate);
      
      console.log(`🔍 Шукаю пост з текстом, що містить: "${searchText}"`);

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
            
            // ... (скорочена логіка пошуку та збору фото)
            
            const photos = []; // Логіка збору фото
             if (msg.media && msg.media.className === 'MessageMediaPhoto') { photos.push(msg.media.photo); }
             if (msg.groupedId) {
                // ... (Логіка альбому)
                result.messages.forEach(otherMsg => {
                    if (otherMsg.groupedId?.toString() === msg.groupedId.toString() && otherMsg.media?.className === 'MessageMediaPhoto') {
                        photos.push(otherMsg.media.photo);
                    }
                });
                if (photos.length > 2) { photos.splice(2); }
             }
            
            if (photos.length > 0) {
               return {
                  photos: photos,
                  messageId: msg.id,
                  text: msg.message,
                  captionText: captionText,
               };
            }
         }
      }

      console.log(`❌ Пост з графіком на ${searchForDate.toLocaleDateString('uk-UA')} не знайдено`);
      return null;

   } catch (e) {
      console.error('🛑 Помилка пошуку повідомлення:', e.message);
      throw e;
   }
}

async function downloadPhotos(photos) {
    // ... (Логіка завантаження фото)
    const filenames = [];
    for (let i = 0; i < photos.length; i++) {
        const buffer = await clientTG.downloadMedia(photos[i], { workers: 1 });
        const filename = `dtek_${i + 1}.jpg`;
        fs.writeFileSync(filename, buffer);
        filenames.push(filename);
    }
    return filenames;
}

async function sendToChannel(filepaths, postText, captionText) {
    // ... (Логіка відправлення повідомлення)
    const caption = captionText; 
    
    if (filepaths.length === 1) {
        await bot.telegram.sendPhoto(TARGET_CHAT_ID, { source: createReadStream(filepaths[0]) }, { caption: caption, parse_mode: 'Markdown' });
    } else {
        const mediaGroup = filepaths.map((filepath, index) => ({
            type: 'photo',
            media: { source: createReadStream(filepath) },
            caption: index === 0 ? caption : undefined,
            parse_mode: index === 0 ? 'Markdown' : undefined,
        }));
        await bot.telegram.sendMediaGroup(TARGET_CHAT_ID, mediaGroup);
    }
    
    filepaths.forEach(filepath => {
        if (fs.existsSync(filepath)) {
            fs.unlinkSync(filepath);
        }
    });
}


// -------------------- ОСНОВНИЙ ПРОЦЕС --------------------
let lastProcessedMessageId = 0;

async function processDTEK() {
   const startTime = performance.now();
   console.log('\n--- Запуск моніторингу DTEK ---');
   console.log(`📅 Дата: ${new Date().toLocaleString('uk-UA')}`);

    // --- ЧИТАННЯ СТАНУ З REDIS АБО ЛОКАЛЬНОГО ФАЙЛУ ---
    if (redisClient) {
        try {
            const storedId = await redisClient.get(REDIS_KEY);
            lastProcessedMessageId = storedId ? Number(storedId) : 0;
            console.log(`▶ Останній оброблений ID (Redis): ${lastProcessedMessageId}`);
        } catch (error) {
            console.error('❌ Помилка читання з Redis, використовується ID: 0', error);
            lastProcessedMessageId = 0;
        }
    } else {
        if (fs.existsSync(STATE_FILE)) {
          lastProcessedMessageId = Number(fs.readFileSync(STATE_FILE, 'utf8'));
       }
        console.log(`▶ Останній оброблений ID (FILE/0): ${lastProcessedMessageId}`);
    }

   try {
      let post = null;
      const now = new Date();
      const tomorrow = new Date(now);
      tomorrow.setDate(now.getDate() + 1);

      // Логіка пошуку (на завтра / сьогодні)
      if (now.getHours() >= 20) {
         post = await findSchedule(tomorrow) || await findSchedule(now);
      } else {
         post = await findSchedule(now);
      }

      if (!post) {
         console.log('⏳ Графік на сьогодні/завтра ще не опубліковано. Спробую пізніше.');
         return;
      }

      if (post.messageId <= lastProcessedMessageId) {
         console.log('➡️ Цей графік вже був відправлений. Пропускаю.');
         return;
      }

      // Завантаження та відправлення
      const files = await downloadPhotos(post.photos);
      await sendToChannel(files, post.text, post.captionText); 

    // --- АВТОМАТИЧНЕ ЗБЕРЕЖЕННЯ СТАНУ У REDIS ---
    if (redisClient) {
        await redisClient.set(REDIS_KEY, String(post.messageId));
        console.log(`💾 ID ${post.messageId} успішно збережено у Redis.`);
    }
    
    lastProcessedMessageId = post.messageId;

      const endTime = performance.now();
      console.log(`✅ Готово! Час виконання: ${((endTime - startTime) / 1000).toFixed(2)}s`);
   } catch (error) {
      console.error('🛑 Критична помилка в процесі:', error.message);
   }
}

// -------------------- ЗАПУСК --------------------
async function start() {
    // 1. Ініціалізація Telegram
    let sessionStringFromEnv = process.env.SESSION_STRING;

   try {
      // ... (Логіка підключення Telegram)
       const session = new StringSession(sessionStringFromEnv || fs.readFileSync(SESSION_FILE, 'utf8'));
      clientTG = new TelegramClient(session, API_ID, API_HASH, {
         connectionRetries: 5, useWSS: true, testServers: false,
      });
      await clientTG.connect();

      if (!(await clientTG.isUserAuthorized())) {
         console.error('❌ Клієнт Telegram не авторизований. Перевірте SESSION_STRING.');
      } else {
         console.log('✅ Клієнт успішно авторизований через збережену сесію.');
      }
   } catch (e) {
      console.error(`❌ Запуск скасовано через помилку підключення/авторизації: ${e.message}`);
      // Не виходимо, оскільки нам потрібно запустити Express-сервер
   }

   // 2. Налаштування Cron-розкладу
   cron.schedule('*/30 20-23 * * *', () => {
      processDTEK();
   });
   cron.schedule('*/30 0-7 * * *', () => {
      processDTEK();
   });
   cron.schedule('20 7 * * *', () => {
      processDTEK();
   });

   console.log('✅ Cron-планувальник налаштовано.');
   processDTEK(); // Запуск при старті
}

// -------------------- ЗАПУСК WEB SERVICE --------------------

// Ініціалізація Express
const app = express();

app.get('/', (req, res) => {
   res.status(200).send('DTEK Monitor Bot is running and cron is active.');
});

// Запуск HTTP-сервера
app.listen(PORT, async () => {
   console.log(`🌍 Web Service запущено на порті ${PORT}.`);
   await start(); // Запуск логіки бота
});
