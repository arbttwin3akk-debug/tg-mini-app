const FORUM_CHAT_ID = '-1003885716640'; // ID закрытой группы (строка — надёжнее для API)

// Ключи в KV: user_<userId> -> threadId, thread_<threadId> -> userId

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    // HTTP-заявка из Web App (надёжная альтернатива sendData)
    if (request.method === 'POST' && url.pathname === '/booking') {
      return handleBookingPost(request, env);
    }

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
    const workerUrl = env.WORKER_PUBLIC_URL || '';
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
        await sendStartMessage(apiUrl, chatId, webAppUrl, workerUrl);
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
    if (update.message?.chat && String(update.message.chat.id) === FORUM_CHAT_ID) {
      const msg = update.message;
      const threadId = msg.message_thread_id;

      if (!threadId) {
        return new Response('OK');
      }

      // Не пересылаем сообщения самого бота, только менеджеров
      if (msg.from && msg.from.is_bot) {
        return new Response('OK');
      }

      // Сообщение в теме «Общее» с ссылками на каналы → рассылка всем клиентам записи
      const generalThreadId = Number(env.GENERAL_THREAD_ID || '1');
      const text = msg.text || msg.caption || '';
      const hasChannelLinks = /t\.me\/|telegram\.me\//i.test(text);
      if (threadId === generalThreadId && text && hasChannelLinks) {
        const userIds = await getAllRecordingClientIds(store);
        for (const uid of userIds) {
          try {
            await sendMessage(apiUrl, uid, text);
            await sleep(60);
          } catch (_) {}
        }
        return new Response('OK');
      }

      // Ответ менеджера в теме клиента → в ЛС этого клиента
      const userId = await store?.get(`thread_${threadId}`);
      if (!userId) {
        return new Response('OK');
      }

      if (msg.text || msg.caption) {
        await sendMessage(apiUrl, Number(userId), msg.text || msg.caption);
      }
    }

    return new Response('OK');
  } catch (e) {
    console.error('Worker error:', e);
    return new Response('OK');
  }
  },
};

async function sendStartMessage(apiUrl, chatId, webAppUrl, workerUrl) {
  const text =
    'Привет! Я бот для записи и общения с мастером.\n\n' +
    'Нажми кнопку ниже, чтобы открыть приложение для записи на маникюр.';

  let url = webAppUrl && String(webAppUrl).trim();
  if (url && url.startsWith('https://')) {
    const params = new URLSearchParams({ uid: String(chatId) });
    if (workerUrl) params.set('api', workerUrl.trim());
    url = url.replace(/\/?$/, '') + (url.includes('?') ? '&' : '?') + params.toString();
  }
  // Reply Keyboard нужен для sendData; uid+api — для HTTP fallback
  const body = {
    chat_id: chatId,
    text,
    ...(url && {
      reply_markup: {
        keyboard: [[{ text: '💅 Записаться', web_app: { url } }]],
        resize_keyboard: true,
      },
    }),
  };

  const res = await fetch(`${apiUrl}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!data.ok && body.reply_markup) {
    await fetch(`${apiUrl}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
  }
}

async function handleBookingPost(request, env) {
  const token = env.BOT_TOKEN;
  const store = env.CLIENT_THREADS;
  if (!token) {
    return jsonResponse({ ok: false, error: 'BOT_TOKEN not set' }, 500);
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ ok: false, error: 'Invalid JSON' }, 400);
  }

  const data = body.data || body;
  const uid = Number(body.uid ?? data.uid);
  if (!uid || (data.type || body.type) !== 'manicure_booking') {
    return jsonResponse({ ok: false, error: 'Invalid payload' }, 400);
  }

  const apiUrl = `https://api.telegram.org/bot${token}`;

  // Получить имя пользователя из API (у нас только uid)
  let userInfo = { id: uid, first_name: '', last_name: '', username: '' };
  try {
    const u = await fetch(`${apiUrl}/getChat?chat_id=${uid}`).then((r) => r.json());
    if (u.ok) {
      userInfo = { id: u.result.id, first_name: u.result.first_name || '', last_name: u.result.last_name || '', username: u.result.username || '' };
    }
  } catch (_) {}

  const threadId = await ensureClientThreadByUserId(apiUrl, store, userInfo, uid);

  const userName = [userInfo.first_name, userInfo.last_name].filter(Boolean).join(' ').trim() || '—';
  const userHandle = userInfo.username ? `@${userInfo.username}` : 'не указан';
  const submittedAt = new Date().toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'medium' });

  const summary =
    '✅ Новая запись!\n\n' +
    '📱 Контакт в Telegram:\n' +
    `   • ID: ${uid}\n` +
    `   • Username: ${userHandle}\n` +
    `   • Имя в ТГ: ${userName}\n` +
    `   • Время заявки: ${submittedAt}\n\n` +
    '📋 Детали записи:\n' +
    `   • Имя: ${data.name || '—'}\n` +
    `   • Телефон: ${data.phone || '—'}\n` +
    `   • Услуга: ${data.service || '—'}\n` +
    `   • Дата: ${data.date || '—'}\n` +
    `   • Время: ${data.time || '—'}\n` +
    (data.comment ? `   • Коммент: ${data.comment}` : '');

  let groupOk = false;
  for (const opts of [
    { message_thread_id: threadId || 1 },
    { message_thread_id: 1 },
    {},
  ]) {
    const res = await sendMessage(apiUrl, FORUM_CHAT_ID, summary, opts);
    const resData = await res.json();
    if (resData.ok) {
      groupOk = true;
      break;
    }
  }

  const confirmText =
    '✅ Заявка отправлена мастеру.\n\n' +
    '📋 Вы записались:\n' +
    `✨ Услуга: ${data.service || '—'}\n` +
    `📅 Дата: ${data.date || '—'}\n` +
    `⏰ Время: ${data.time || '—'}\n` +
    (data.comment ? `💬 Пожелание: ${data.comment}\n\n` : '\n') +
    'Мастер свяжется с вами для подтверждения.';
  await sendMessage(apiUrl, uid, confirmText);

  return jsonResponse({ ok: true, groupOk }, 200);
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

async function ensureClientThreadByUserId(apiUrl, store, from, chatId) {
  if (!store || !from) return undefined;
  const existing = await store.get(`user_${from.id}`);
  if (existing) return Number(existing);

  const name = `${from.first_name || 'Клиент'}${from.last_name ? ' ' + from.last_name : ''} | ID: ${from.id}`;
  const resp = await fetch(`${apiUrl}/createForumTopic`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: FORUM_CHAT_ID, name }),
  });
  const data = await resp.json();
  if (!data.ok) return undefined;
  const threadId = data.result.message_thread_id;
  await store.put(`user_${from.id}`, String(threadId));
  await store.put(`thread_${threadId}`, String(from.id));
  return threadId;
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
  const rawData = message.web_app_data?.data || '';
  const from = message.from || {};

  let data;
  try {
    data = JSON.parse(rawData);
  } catch (e) {
    await sendMessage(apiUrl, chatId, 'Ошибка при чтении данных.');
    return;
  }

  if (data.type !== 'manicure_booking') {
    return;
  }

  const userName = [from.first_name, from.last_name].filter(Boolean).join(' ').trim() || '—';
  const userHandle = from.username ? `@${from.username}` : 'не указан';
  const submittedAt = message.date
    ? new Date(message.date * 1000).toLocaleString('ru-RU', {
        dateStyle: 'short',
        timeStyle: 'medium',
      })
    : '—';

  const summary =
    '✅ Новая запись!\n\n' +
    '📱 Контакт в Telegram:\n' +
    `   • ID: ${from.id ?? '—'}\n` +
    `   • Username: ${userHandle}\n` +
    `   • Имя в ТГ: ${userName}\n` +
    `   • Время заявки: ${submittedAt}\n\n` +
    '📋 Детали записи:\n' +
    `   • Имя: ${data.name || '—'}\n` +
    `   • Телефон: ${data.phone || '—'}\n` +
    `   • Услуга: ${data.service || '—'}\n` +
    `   • Дата: ${data.date || '—'}\n` +
    `   • Время: ${data.time || '—'}\n` +
    (data.comment ? `   • Коммент: ${data.comment}` : '');

  // 1. СНАЧАЛА в группу (с fallback: с темой → без темы)
  let groupOk = false;
  for (const opts of [
    { message_thread_id: threadId || 1 },
    { message_thread_id: 1 },
    {},
  ]) {
    const res = await sendMessage(apiUrl, FORUM_CHAT_ID, summary, opts);
    const resData = await res.json();
    if (resData.ok) {
      groupOk = true;
      break;
    }
  }

  // 2. Клиенту подтверждение
  const confirmText =
    '✅ Заявка отправлена мастеру.\n\n' +
    '📋 Вы записались:\n' +
    `✨ Услуга: ${data.service || '—'}\n` +
    `📅 Дата: ${data.date || '—'}\n` +
    `⏰ Время: ${data.time || '—'}\n` +
    (data.comment ? `💬 Пожелание: ${data.comment}\n\n` : '\n') +
    'Мастер свяжется с вами для подтверждения.';
  await sendMessage(apiUrl, chatId, confirmText);

  if (!groupOk) {
    await sendMessage(
      apiUrl,
      chatId,
      '⚠️ Заявка принята, но не удалось отправить в группу. Проверьте, что бот добавлен в группу с правами на отправку сообщений.'
    );
  }
}

async function getAllRecordingClientIds(store) {
  if (!store) return [];
  const ids = new Set();
  let cursor;
  do {
    const list = await store.list({ prefix: 'user_', limit: 1000, cursor });
    for (const k of list.keys) {
      const m = k.name.match(/^user_(\d+)$/);
      if (m) ids.add(Number(m[1]));
    }
    cursor = list.list_complete ? undefined : list.cursor;
  } while (cursor);
  return [...ids];
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
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

