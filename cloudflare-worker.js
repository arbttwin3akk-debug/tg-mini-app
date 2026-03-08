const FORUM_CHAT_ID = Number('-1003885716640'); // ID вашей закрытой группы с темами

// Ключи в KV: user_<userId> -> threadId, thread_<threadId> -> userId

export default {
  async fetch(request, env, ctx) {
    if (request.method !== 'POST') {
      return new Response('OK');
    }

    let update;
    try {
      update = await request.json();
    } catch (e) {
      return new Response('OK');
    }

    const token = env.BOT_TOKEN;
    const webAppUrl = env.WEB_APP_URL;
    const store = env.CLIENT_THREADS;

    if (!token) {
      console.error('BOT_TOKEN is not set');
      return new Response('OK');
    }

    const apiUrl = `https://api.telegram.org/bot${token}`;

    try {
      // Сообщения из приватного чата с клиентом
      if (update?.message?.chat?.type === 'private') {
      const chatId = update.message.chat.id;

      // Обработка /start — сразу приветствие и выход (без создания темы)
      const msgText = (update.message.text || '').trim();
      if (msgText.toLowerCase().startsWith('/start')) {
        await sendStartMessage(apiUrl, chatId, webAppUrl);
        return new Response('OK');
      }

      // Убедиться, что для этого клиента есть тема в группе
      const threadId = update.message.from
        ? await ensureClientThread(apiUrl, store, update.message.from, chatId)
        : undefined;

      // Сообщение из WebApp (web_app_data)
      if (update.message.web_app_data) {
        await handleWebAppData(apiUrl, store, update.message, threadId);
        return new Response('OK');
      }

      // Обычный текст клиента → в его тему (только если тема есть)
      if (update.message.text && threadId && update.message.from) {
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
    }

    return new Response('OK');
  } catch (e) {
    console.error('Worker error:', e);
    return new Response('OK');
  }
  },
};

async function sendStartMessage(apiUrl, chatId, webAppUrl) {
  const text =
    'Привет! Я бот для записи и общения с мастером.\n\n' +
    'Нажми кнопку ниже, чтобы открыть приложение для записи на маникюр.';

  const url = webAppUrl && String(webAppUrl).trim();
  const withButton = url && url.startsWith('https://');

  const body = {
    chat_id: chatId,
    text,
    ...(withButton && {
      reply_markup: {
        inline_keyboard: [[{ text: '💅 Записаться', web_app: { url } }]],
      },
    }),
  };

  const res = await fetch(`${apiUrl}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!data.ok && withButton) {
    await fetch(`${apiUrl}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
  }
}

async function ensureClientThread(apiUrl, store, from, chatId) {
  if (!store || !from) return undefined;

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

