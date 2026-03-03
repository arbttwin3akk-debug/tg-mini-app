const { Telegraf, Markup } = require('telegraf');
const dotenv = require('dotenv');

// Загружаем токен из файла "bot tg.env" в корне проекта
dotenv.config({ path: 'bot tg.env' });

const token = process.env.BOT_TOKEN;

if (!token) {
  console.error(
    'Не найден BOT_TOKEN в файле "bot tg.env".\n' +
      'Убедитесь, что в файле есть строка вида:\n' +
      'BOT_TOKEN=123456:ABC-DEF...'
  );
  process.exit(1);
}

const bot = new Telegraf(token);

const WEB_APP_URL = process.env.WEB_APP_URL;

bot.start((ctx) => {
  const baseText =
    'Привет! Я минимальный Telegram-бот на JavaScript.\n' +
    'Есть мини‑приложение (Web App).\n\n' +
    'Команды:\n' +
    '- /start — это сообщение\n' +
    '- /help — список команд\n' +
    '- /app — ссылка на mini‑app\n\n';

  if (WEB_APP_URL && WEB_APP_URL.startsWith('https://')) {
    return ctx.reply(
      baseText + 'Нажми кнопку ниже, чтобы открыть приложение.',
      Markup.keyboard([[Markup.button.webApp('Открыть приложение', WEB_APP_URL)]])
        .resize()
        .persistent()
    );
  }

  return ctx.reply(
    baseText +
      'Сейчас Web App не подключён по HTTPS.\n' +
      'Локально можно открыть его в браузере по адресу http://localhost:3000/.'
  );
});

bot.help((ctx) =>
  ctx.reply('Доступные команды:\n/start — начать работу с ботом\n/help — показать это сообщение')
);

bot.command('app', (ctx) => {
  if (WEB_APP_URL && WEB_APP_URL.startsWith('https://')) {
    return ctx.reply(`Ссылка на мини‑приложение: ${WEB_APP_URL}`);
  }
  return ctx.reply(
    'Локальный адрес мини‑приложения: http://localhost:3000/\n' +
      'Когда у тебя будет HTTPS‑ссылка, добавим её в переменную WEB_APP_URL, и кнопка заработает прямо в Telegram.'
  );
});

// Эхо только для текстовых сообщений
bot.on('text', (ctx) => {
  const text = ctx.message.text;
  ctx.reply(`Ты написал: ${text}`);
});

// Сообщения без текста
bot.on('message', (ctx) => {
  if (!ctx.message.text) {
    ctx.reply('Я пока понимаю только текстовые сообщения.');
  }
});

// Обработка данных, присланных из Web App (Telegram WebApp sendData)
bot.on('web_app_data', (ctx) => {
  try {
    const data = JSON.parse(ctx.webAppData.data || '{}');
    if (data.type === 'form_message' && data.text) {
      ctx.reply(`Из мини‑приложения пришло сообщение:\n"${data.text}"`);
    } else {
      ctx.reply('Получены данные из мини‑приложения, но я не смог их распознать.');
    }
  } catch (err) {
    console.error('Ошибка обработки web_app_data:', err);
    ctx.reply('Произошла ошибка при обработке данных из мини‑приложения.');
  }
});

async function launch() {
  try {
    await bot.launch();
    console.log('Бот запущен. Нажмите Ctrl+C для остановки.');
  } catch (err) {
    console.error('Ошибка при запуске бота:', err);
  }
}

// Корректная остановка бота
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

launch();

