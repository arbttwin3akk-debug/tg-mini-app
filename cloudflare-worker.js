export default {
  async fetch(request, env, ctx) {
    if (request.method !== 'POST') {
      return new Response('OK');
    }

    const token = env.BOT_TOKEN;
    const webAppUrl = env.WEB_APP_URL;

    if (!token) {
      return new Response('BOT_TOKEN is not set', { status: 500 });
    }

    const update = await request.json();
    const apiUrl = `https://api.telegram.org/bot${token}`;

    // /start
    if (update.message && update.message.text === '/start') {
      const chatId = update.message.chat.id;

      const text =
        'Привет! Я бот, который работает на Cloudflare Workers.\n' +
        'Нажми кнопку ниже, чтобы открыть приложение.';

      const replyMarkup =
        webAppUrl && webAppUrl.startsWith('https://')
          ? {
              keyboard: [
                [
                  {
                    text: 'Открыть приложение',
                    web_app: { url: webAppUrl },
                  },
                ],
              ],
              resize_keyboard: true,
              persistent: true,
            }
          : undefined;

      await fetch(`${apiUrl}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          reply_markup: replyMarkup,
        }),
      });

      return new Response('OK');
    }

    // Эхо
    if (update.message && update.message.text) {
      const chatId = update.message.chat.id;
      const text = update.message.text;

      await fetch(`${apiUrl}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: `Ты написал: ${text}`,
        }),
      });
    }

    // Данные из WebApp (sendData)
    if (update.message && update.message.web_app_data) {
      const chatId = update.message.chat.id;
      const data = update.message.web_app_data.data;

      await fetch(`${apiUrl}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: `Из WebApp пришли данные:\n${data}`,
        }),
      });
    }

    return new Response('OK');
  },
};

