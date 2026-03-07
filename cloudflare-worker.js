const FORUM_CHAT_ID = Number('-1003885716640'); // ID вашей закрытой группы с темами

// Ключи в KV: user_<userId> -> threadId, thread_<threadId> -> userId

export default {
  async fetch(request, env, ctx) {
    if (request.method !== 'POST') {
      return new Response('OK');
    }

    const token = env.BOT_TOKEN;
    const webAppUrl = env.WEB_APP_URL;
    const store = env.CLIENT_THREADS; // KV namespace, нужно привязать в Cloudflare

    if (!token) {
      return new Response('BOT_TOKEN is not set', { status: 500 });
    }

    const update = await request.json();
    const apiUrl = `https://api.telegram.org/bot${token}`;

    // Сообщения из приватного чата с клиентом
    if (update.message && update.message.chat && update.message.chat.type === 'private') {
      const chatId = update.message.chat.id;

      // Обработка /start
      if (update.message.text === '/start') {
        await sendStartMessage(apiUrl, chatId, webAppUrl);
      }

      // Убедиться, что для этого клиента есть тема в группе
      const threadId = await ensureClientThread(apiUrl, store, update.message.from, chatId);

      // Сообщение из WebApp (web_app_data)
      if (update.message.web_app_data) {
        await handleWebAppData(apiUrl, store, update.message, threadId);
        return new Response('OK');
      }

      // Обычный текст клиента → в его тему (только если тема есть)
      if (update.message.text && threadId) {
        const from = update.message.from;
        const prefix = `👤 ${from.first_name || ''}${from.last_name ? ' ' + from.last_name : ''} (id ${from.id})\n\n`;

        await sendMessage(apiUrl, FORUM_CHAT_ID, prefix + update.message.text, {
          message_thread_id: threadId,
        });
      }

      return new Response('OK');
    }

    // Сообщения из менеджерской группы (форум)
    if (update.message && update.message.chat && update.message.chat.id === FORUM_CHAT_ID) {
      const msg = update.message;
      const threadId = msg.message_thread_id;

      if (!threadId) {
        return new Response('OK');
      }

      const userId = await store?.get(`thread_${threadId}`);
      if (!userId) {
        return new Response('OK');
      }

      // Не пересылаем сообщения самого бота, только менеджеров
      if (msg.from && msg.from.is_bot) {
        return new Response('OK');
      }

      if (msg.text) {
        await sendMessage(apiUrl, Number(userId), msg.text);
      }

      return new Response('OK');
    }

    return new Response('OK');
  },
};

async function sendStartMessage(apiUrl, chatId, webAppUrl) {
  const text =
    'Привет! Я бот для записи и общения с мастером.\n\n' +
    'Нажми кнопку ниже, чтобы открыть приложение для записи на маникюр.';

  // Inline-кнопка сразу под сообщением (не внизу экрана)
  const replyMarkup =
    webAppUrl && webAppUrl.startsWith('https://')
      ? {
          inline_keyboard: [
            [
              {
                text: '💅 Записаться',
                web_app: { url: webAppUrl },
              },
            ],
          ],
        }
      : undefined;

  await sendMessage(apiUrl, chatId, text, { reply_markup: replyMarkup });
}

async function ensureClientThread(apiUrl, store, from, chatId) {
  if (!store) return undefined;

  const key = `user_${from.id}`;
  const existing = await store.get(key);
  if (existing) {
    return Number(existing);
  }

  // Создаём новую тему в форуме
  const name = `${from.first_name || 'Клиент'}${from.last_name ? ' ' + from.last_name : ''} | ID: ${from.id}`;

  const resp = await fetch(`${apiUrl}/createForumTopic`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: FORUM_CHAT_ID,
      name,
    }),
  });

  const data = await resp.json();
  if (!data.ok) {
    await sendMessage(
      apiUrl,
      chatId,
      'Не удалось создать тему в группе.\n\n' +
        'Проверьте: в группе включены «Темы» (Topics) и бот добавлен как администратор с правом «Управление темами».'
    );
    return undefined;
  }

  const threadId = data.result.message_thread_id;
  await store.put(`user_${from.id}`, String(threadId));
  await store.put(`thread_${threadId}`, String(from.id));

  return threadId;
}

async function handleWebAppData(apiUrl, store, message, threadId) {
  const chatId = message.chat.id;
  const rawData = message.web_app_data.data;

  try {
    const data = JSON.parse(rawData);

    if (data.type === 'manicure_booking') {
      const summary =
        '✅ Новая запись!\n\n' +
        `👤 Имя: ${data.name || '—'}\n` +
        `📞 Телефон: ${data.phone || '—'}\n` +
        `✨ Услуга: ${data.service || '—'}\n` +
        `📅 Дата: ${data.date || '—'}\n` +
        `⏰ Время: ${data.time || '—'}\n` +
        (data.comment ? `💬 Коммент: ${data.comment}` : '');

      // Клиенту — подтверждение с деталями записи
      const confirmText =
        '✅ Заявка отправлена мастеру.\n\n' +
        '📋 Вы записались:\n' +
        `✨ Услуга: ${data.service || '—'}\n` +
        `📅 Дата: ${data.date || '—'}\n` +
        `⏰ Время: ${data.time || '—'}\n` +
        (data.comment ? `💬 Пожелание: ${data.comment}\n\n` : '\n') +
        'Мастер свяжется с вами для подтверждения.';
      await sendMessage(apiUrl, chatId, confirmText);

      // В группу: сначала в тему (если есть), иначе в General (thread 1); если не вышло — без темы (группа без Topics)
      let res = await sendMessage(apiUrl, FORUM_CHAT_ID, summary, {
        message_thread_id: threadId || 1,
      });
      let resData = await res.json();
      if (!resData.ok) {
        res = await sendMessage(apiUrl, FORUM_CHAT_ID, summary);
        resData = await res.json();
      }
    }
  } catch (e) {
    await sendMessage(apiUrl, chatId, 'Ошибка при чтении данных из приложения.');
  }
}

async function sendMessage(apiUrl, chatId, text, extra = {}) {
  const body = {
    chat_id: chatId,
    text,
    ...extra,
  };

  return fetch(`${apiUrl}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

