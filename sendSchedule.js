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

dotenv.config();

const require = createRequire(import.meta.url);
const FormData = require('form-data'); 

// -------------------- КОНФІГУРАЦІЯ --------------------
const API_ID = parseInt(process.env.API_ID);
const API_HASH = process.env.API_HASH;
const BOT_TOKEN = process.env.BOT_TOKEN;
const TARGET_CHAT_ID = process.env.TARGET_CHAT_ID;
const DTEK_CHANNEL = process.env.DTEK_CHANNEL;

if (!API_ID || !API_HASH || !BOT_TOKEN || !TARGET_CHAT_ID || !DTEK_CHANNEL) {
   console.error('❌ ПОМИЛКА: Не всі змінні оточення налаштовані!');
   console.error('Перевірте файл .env');
   process.exit(1);
}

// Конфігураційні файли
const STATE_FILE = 'last_message_id.txt';
const SESSION_FILE = 'session_telethon_js.txt';

// -------------------- ІНІЦІАЛІЗАЦІЯ --------------------
let clientTG;
const bot = new Telegraf(BOT_TOKEN);
let sessionString = '';

// -------------------- ДОПОМІЖНІ ФУНКЦІЇ --------------------

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

// -------------------- АВТОРИЗАЦІЯ --------------------
async function authorize() {
   console.log('--- ПОТРІБНА АВТОРИЗАЦІЯ (TELEGRAM JS) ---');

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

// -------------------- ЛОГІКА МОНІТОРИНГУ --------------------

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
            
            console.log(`✅ Знайдено пост! ID: ${msg.id}`);
            console.log(`📝 Текст: ${msg.message.substring(0, 100)}...`);
            
            const photos = [];
            
            if (msg.media && msg.media.className === 'MessageMediaPhoto') {
               photos.push(msg.media.photo);
               console.log(`📷 Знайдено 1 фото`);
            }
            
            if (msg.groupedId) {
               console.log(`📸 Це альбом з групою ID: ${msg.groupedId}`);
               
               for (const otherMsg of result.messages) {
                  if (otherMsg.groupedId && otherMsg.groupedId.toString() === msg.groupedId.toString()) {
                     if (otherMsg.media && otherMsg.media.className === 'MessageMediaPhoto') {
                        photos.push(otherMsg.media.photo);
                     }
                  }
               }
               console.log(`📷 Знайдено ${photos.length} фото в альбомі`);
               
               if (photos.length > 2) {
                  console.log(`✂️ Обрізаю до 2 фото`);
                  photos.splice(2); 
               }
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
   try {
      const filenames = [];
      
      for (let i = 0; i < photos.length; i++) {
         console.log(`📥 Завантажую фото ${i + 1}/${photos.length}...`);
         
         const buffer = await clientTG.downloadMedia(photos[i], {
            workers: 1,
         });

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
            { 
               caption: caption,
               parse_mode: 'Markdown'
            }
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
      
      console.log(`✅ Надіслано ${filepaths.length} фото через Telegraf!`);
      
      filepaths.forEach(filepath => {
         if (fs.existsSync(filepath)) {
            fs.unlinkSync(filepath);
            console.log(`🗑️ Видалено тимчасовий файл: ${filepath}`);
         }
      });
      
   } catch (error) {
      console.error('❌ Помилка надсилання Telegraf:', error.message);
   }
}

// -------------------- ОСНОВНИЙ ПРОЦЕС --------------------
let lastProcessedMessageId = 0;

async function processDTEK() {
   const startTime = performance.now();
   console.log('\n--- Запуск моніторингу DTEK ---');
   console.log(`📅 Дата: ${new Date().toLocaleString('uk-UA')}`);

   if (fs.existsSync(STATE_FILE)) {
      lastProcessedMessageId = Number(fs.readFileSync(STATE_FILE, 'utf8'));
   }
   console.log(`▶ Останній оброблений ID: ${lastProcessedMessageId}`);

   try {
      let post = null;
      const now = new Date();
      const tomorrow = new Date(now);
      tomorrow.setDate(now.getDate() + 1);

      if (now.getHours() >= 20) {
         console.log(`\n--- Пріоритет: пошук графіка на ЗАВТРА (${tomorrow.toLocaleDateString('uk-UA')}) ---`);
         post = await findSchedule(tomorrow);
         
         if (post) {
            console.log('✅ Знайдено графік на завтра. Обробляю.');
         } else {
            console.log(`\n--- На завтра не знайдено. Перевіряю СЬОГОДНІ (${now.toLocaleDateString('uk-UA')}) ---`);
            post = await findSchedule(now);
         }
      } 
      else {
         console.log(`\n--- Пошук графіка на СЬОГОДНІ (${now.toLocaleDateString('uk-UA')}) ---`);
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

      console.log(`📥 Завантажую ${post.photos.length} фото (ID: ${post.messageId})...`);
      const files = await downloadPhotos(post.photos);

      console.log('📤 Відправляю в канал...');
      await sendToChannel(files, post.text, post.captionText); 

      fs.writeFileSync(STATE_FILE, String(post.messageId));
      lastProcessedMessageId = post.messageId;

      const endTime = performance.now();
      console.log(`✅ Готово! Час виконання: ${((endTime - startTime) / 1000).toFixed(2)}s`);
   } catch (error) {
      console.error('🛑 Критична помилка в процесі:', error.message);
   }
}

async function start() {
   try {
      if (fs.existsSync(SESSION_FILE)) {
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
         await authorize();
      } else {
         console.log('✅ Клієнт успішно авторизований через збережену сесію.');
      }
   } catch (e) {
      console.error(`❌ Запуск скасовано через помилку підключення/авторизації: ${e.message}`);
      return;
   }

   cron.schedule('*/30 20-23 * * *', () => {
      console.log('\n⏰ Регулярна вечірня перевірка (20:00-23:30)');
      processDTEK();
   });

   cron.schedule('*/30 0-7 * * *', () => {
      console.log('\n⏰ Регулярна нічна/ранкова перевірка (00:00-07:30)');
      processDTEK();
   });

   cron.schedule('20 7 * * *', () => {
      console.log('\n⏰ Обов\'язкова перевірка о 07:20');
      processDTEK();
   });

   console.log('✅ Бот запущено!');
   console.log('📅 Буде перевіряти графіки:');
   console.log('    - Кожні 30 хвилин з 20:00 до 07:30');
   console.log('    - Додатково о 07:20');
   
   processDTEK();
}

start();