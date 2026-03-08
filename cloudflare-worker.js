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
      // Нажатия на inline-кнопки (отмена/перенос заказа)
      if (update?.callback_query) {
        await handleCallbackQuery(apiUrl, store, update.callback_query);
        return new Response('OK');
      }

      // Сообщения из приватного чата с клиентом
      if (update?.message?.chat?.type === 'private') {
      const chatId = update.message.chat.id;

      // Обработка /start — сразу приветствие и выход (без создания темы)
      const msgText = (update.message.text || '').trim();
      if (msgText.toLowerCase().startsWith('/start')) {
        await sendStartMessage(apiUrl, chatId, webAppUrl, workerUrl);
        return new Response('OK');
      }
      if (/^\/(d|broadcast_stats)(\s|$)/i.test(msgText)) {
        const ids = await getAllRecordingClientIds(store);
        await sendMessage(apiUrl, chatId, `📊 Клиентов в базе рассылки: ${ids.length}`);
        return new Response('OK');
      }
      const broadcastMatch = msgText.match(/^\/(b|broadcast)\s+(.+)$/is);
      if (broadcastMatch && broadcastMatch[2]?.trim()) {
        const toSend = broadcastMatch[2].trim();
        if (toSend) {
          const userIds = await getAllRecordingClientIds(store);
          for (const uid of userIds) {
            const res = await sendMessage(apiUrl, uid, toSend);
            const data = await res.json().catch(() => ({}));
            if (!data.ok && data.error_code === 429) await sleep(1000);
            await sleep(120);
          }
          await sendMessage(apiUrl, chatId, `✅ Разослано ${userIds.length} клиентам.`);
        }
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

    // Посты из канала General (если задан GENERAL_CHANNEL_ID)
    const generalChannelId = env.GENERAL_CHANNEL_ID?.trim();
    if (generalChannelId && update?.channel_post?.chat && String(update.channel_post.chat.id) === generalChannelId) {
      const msg = update.channel_post;
      const text = (msg.text || msg.caption || '').trim();
      if (text) {
        const userIds = await getAllRecordingClientIds(store);
        for (const uid of userIds) {
          const res = await sendMessage(apiUrl, uid, text);
          const data = await res.json().catch(() => ({}));
          if (!data.ok && data.error_code === 429) await sleep(1000);
          await sleep(120);
        }
      }
      return new Response('OK');
    }

    // Сообщения из менеджерской группы (форум)
    if (update.message?.chat && String(update.message.chat.id) === FORUM_CHAT_ID) {
      const msg = update.message;
      const threadId = msg.message_thread_id ?? 0;

      if (msg.from && msg.from.is_bot) {
        return new Response('OK');
      }

      // General topic: message_thread_id часто 0, undefined или 1,2. Рассылка всем клиентам записи
      const generalIdsRaw = (env.GENERAL_THREAD_ID || '0,1,2').split(',').map((s) => s.trim());
      const generalIds = new Set([0, ...generalIdsRaw.map((s) => Number(s)).filter((n) => !isNaN(n))]);
      const isGeneralTopic = generalIds.has(Number(threadId));
      const text = (msg.text || msg.caption || '').trim();
      const hasChannelLinks = /t\.me\/|telegram\.me\/|https?:\/\//i.test(text);
      const broadcastAny = (env.BROADCAST_ANY_MESSAGE || 'true').toLowerCase() === 'true';

      if (isGeneralTopic && text && (hasChannelLinks || broadcastAny)) {
        const bcMatch = text.match(/^\/(b|broadcast)\s+(.+)$/is);
        const toSend = bcMatch && bcMatch[2]?.trim() ? bcMatch[2].trim() : text;
        if (!toSend) return new Response('OK');
        const userIds = await getAllRecordingClientIds(store);
        for (const uid of userIds) {
          const res = await sendMessage(apiUrl, uid, toSend);
          const data = await res.json().catch(() => ({}));
          if (!data.ok && data.error_code === 429) await sleep(1000);
          await sleep(120);
        }
        return new Response('OK');
      }

      // Ответ менеджера в теме клиента → в ЛС этого клиента (только если есть thread)
      if (threadId && threadId !== 0) {
        const userId = await store?.get(`thread_${threadId}`);
        if (userId && (msg.text || msg.caption)) {
          await sendMessage(apiUrl, Number(userId), msg.text || msg.caption);
        }
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

  let data, photos = [];
  const ct = (request.headers.get('content-type') || '').toLowerCase();
  if (ct.includes('multipart/form-data')) {
    const fd = await request.formData();
    const jsonStr = fd.get('json');
    if (!jsonStr) return jsonResponse({ ok: false, error: 'Missing json field' }, 400);
    try { data = JSON.parse(jsonStr); } catch (e) { return jsonResponse({ ok: false, error: 'Invalid JSON in json field' }, 400); }
    for (const [key, val] of fd.entries()) {
      if (key.startsWith('photo') && val instanceof File && val.size > 0) {
        photos.push(val);
      }
    }
  } else {
    let body;
    try { body = await request.json(); } catch (e) { return jsonResponse({ ok: false, error: 'Invalid JSON' }, 400); }
    data = body.data || body;
  }

  const uid = Number(data.uid);
  const bookingType = data.type;
  const validTypes = ['manicure_booking', 'haircut_booking'];
  if (!uid || !validTypes.includes(bookingType)) {
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
  const categoryLabel = bookingType === 'haircut_booking' ? 'Стрижка' : 'Маникюр';

  const summary =
    `✅ Новая запись (${categoryLabel})!\n\n` +
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
    (data.comment ? `   • Коммент: ${data.comment}` : '') +
    (photos.length > 0 ? `\n   • 📸 Фото: ${photos.length} шт.` : '');

  let groupOk = false;
  let usedThreadOpts = {};
  for (const opts of [
    { message_thread_id: threadId || 1 },
    { message_thread_id: 1 },
    {},
  ]) {
    const res = await sendMessage(apiUrl, FORUM_CHAT_ID, summary, opts);
    const resData = await res.json();
    if (resData.ok) {
      groupOk = true;
      usedThreadOpts = opts;
      break;
    }
  }

  if (photos.length > 0 && groupOk) {
    await sendPhotosToChat(apiUrl, FORUM_CHAT_ID, photos, usedThreadOpts);
  }

  const confirmText =
    '✅ Заявка отправлена мастеру.\n\n' +
    '📋 Вы записались:\n' +
    `✨ Услуга: ${data.service || '—'}\n` +
    `📅 Дата: ${data.date || '—'}\n` +
    `⏰ Время: ${data.time || '—'}\n` +
    (data.comment ? `💬 Пожелание: ${data.comment}\n\n` : '\n') +
    (photos.length > 0 ? `📸 Фото: ${photos.length} шт.\n\n` : '') +
    'Мастер свяжется с вами для подтверждения.';

  const ref = `b_${uid}_${Date.now().toString(36)}`;
  const bookingData = {
    uid,
    name: data.name || '—',
    phone: data.phone || '—',
    service: data.service || '—',
    date: data.date || '—',
    time: data.time || '—',
    comment: data.comment || '',
    threadId: threadId || null,
  };
  await store?.put(`booking_${ref}`, JSON.stringify(bookingData), { expirationTtl: 604800 });

  const replyMarkup = {
    inline_keyboard: [[
      { text: '❌ Отменить заказ', callback_data: `cancel_${ref}` },
      { text: '🔄 Перенести заказ', callback_data: `resched_${ref}` },
    ]],
  };
  const confirmRes = await sendMessage(apiUrl, uid, confirmText, { reply_markup: replyMarkup });
  const confirmJson = await confirmRes.json();
  if (confirmJson.ok) {
    bookingData.confirmMsgId = confirmJson.result.message_id;
    bookingData.confirmChatId = uid;
    await store?.put(`booking_${ref}`, JSON.stringify(bookingData), { expirationTtl: 604800 });
  }

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

  if (!['manicure_booking', 'haircut_booking'].includes(data.type)) {
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

  // 2. Клиенту подтверждение с кнопками Отменить/Перенести
  const confirmText =
    '✅ Заявка отправлена мастеру.\n\n' +
    '📋 Вы записались:\n' +
    `✨ Услуга: ${data.service || '—'}\n` +
    `📅 Дата: ${data.date || '—'}\n` +
    `⏰ Время: ${data.time || '—'}\n` +
    (data.comment ? `💬 Пожелание: ${data.comment}\n\n` : '\n') +
    'Мастер свяжется с вами для подтверждения.';

  const ref = `b_${chatId}_${Date.now().toString(36)}`;
  const bookingData = {
    uid: chatId,
    name: data.name || '—',
    phone: data.phone || '—',
    service: data.service || '—',
    date: data.date || '—',
    time: data.time || '—',
    comment: data.comment || '',
    threadId: threadId || null,
  };
  await store?.put(`booking_${ref}`, JSON.stringify(bookingData), { expirationTtl: 604800 });

  const replyMarkup = {
    inline_keyboard: [[
      { text: '❌ Отменить заказ', callback_data: `cancel_${ref}` },
      { text: '🔄 Перенести заказ', callback_data: `resched_${ref}` },
    ]],
  };
  const confirmRes = await sendMessage(apiUrl, chatId, confirmText, { reply_markup: replyMarkup });
  const confirmJson = await confirmRes.json();
  if (confirmJson.ok) {
    bookingData.confirmMsgId = confirmJson.result.message_id;
    bookingData.confirmChatId = chatId;
    await store?.put(`booking_${ref}`, JSON.stringify(bookingData), { expirationTtl: 604800 });
  }

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
    const list = await store.list({ prefix: 'user_', limit: 1000, ...(cursor && { cursor }) });
    const keys = list.keys || [];
    for (const k of keys) {
      const name = k.name ?? k.key ?? '';
      const m = String(name).match(/^user_(\d+)$/);
      if (m) ids.add(Number(m[1]));
    }
    cursor = list.list_complete ? undefined : (list.cursor || null);
  } while (cursor);
  return [...ids];
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function sendPhotosToChat(apiUrl, chatId, photos, extra = {}) {
  if (photos.length === 1) {
    const fd = new FormData();
    fd.append('chat_id', String(chatId));
    fd.append('photo', photos[0]);
    if (extra.message_thread_id) fd.append('message_thread_id', String(extra.message_thread_id));
    await fetch(`${apiUrl}/sendPhoto`, { method: 'POST', body: fd });
  } else {
    const media = [];
    const fd = new FormData();
    fd.append('chat_id', String(chatId));
    if (extra.message_thread_id) fd.append('message_thread_id', String(extra.message_thread_id));
    for (let i = 0; i < Math.min(photos.length, 10); i++) {
      const key = 'photo' + i;
      fd.append(key, photos[i]);
      media.push({ type: 'photo', media: 'attach://' + key });
    }
    fd.append('media', JSON.stringify(media));
    await fetch(`${apiUrl}/sendMediaGroup`, { method: 'POST', body: fd });
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

async function editMessage(apiUrl, chatId, messageId, text, replyMarkup = null) {
  const body = {
    chat_id: chatId,
    message_id: messageId,
    text,
    ...(replyMarkup !== undefined && { reply_markup: replyMarkup }),
  };
  return fetch(`${apiUrl}/editMessageText`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function answerCallbackQuery(apiUrl, callbackQueryId, text = null, showAlert = false) {
  const body = {
    callback_query_id: callbackQueryId,
    ...(text && { text }),
    ...(showAlert && { show_alert: true }),
  };
  return fetch(`${apiUrl}/answerCallbackQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function handleCallbackQuery(apiUrl, store, cq) {
  const id = cq.id;
  const data = cq.data || '';
  const chatId = cq.message?.chat?.id;
  const msgId = cq.message?.message_id;

  async function getBooking(ref) {
    for (let i = 0; i < 3; i++) {
      const raw = await store?.get(`booking_${ref}`);
      if (raw) return raw;
      await sleep(1500);
    }
    return null;
  }

  const fromId = cq.from?.id;

  if (data.startsWith('cancel_ok_')) {
    const ref = data.slice(10);
    let raw = await getBooking(ref);
    let b = raw ? JSON.parse(raw) : null;
    if (!b && fromId) {
      const userName = [cq.from?.first_name, cq.from?.last_name].filter(Boolean).join(' ').trim() || '—';
      const userHandle = cq.from?.username ? `@${cq.from.username}` : '';
      const threadId = fromId ? await store?.get(`user_${fromId}`) : null;
      const notify =
        `❌ Клиент отменил заказ\n\n` +
        `👤 ${userName} (id ${fromId}) ${userHandle}\n` +
        `⚠️ Детали из кэша недоступны. Свяжитесь с клиентом для уточнения.`;
      await sendMessage(apiUrl, FORUM_CHAT_ID, notify, threadId ? { message_thread_id: Number(threadId) } : {});
      await editMessage(apiUrl, chatId, msgId, '✓ Запись отменена', { inline_keyboard: [] });
      await answerCallbackQuery(apiUrl, id, 'Запись отменена');
      return;
    }
    if (!b) {
      await answerCallbackQuery(apiUrl, id, 'Запись не найдена или устарела.', true);
      return;
    }
    const notify =
      `❌ Клиент отменил заказ\n\n` +
      `👤 ${b.name} (id ${b.uid})\n` +
      `📞 ${b.phone}\n` +
      `Услуга: ${b.service}\n` +
      `Дата: ${b.date} • ${b.time}`;
    const opts = b.threadId ? { message_thread_id: b.threadId } : {};
    await sendMessage(apiUrl, FORUM_CHAT_ID, notify, opts);
    if (b.confirmMsgId && b.confirmChatId) {
      const origText = `✅ Заявка отправлена мастеру.\n\n📋 Вы записались:\n✨ Услуга: ${b.service}\n📅 Дата: ${b.date}\n⏰ Время: ${b.time}\n\n❌ Запись отменена по вашей просьбе.`;
      await editMessage(apiUrl, b.confirmChatId, b.confirmMsgId, origText, { inline_keyboard: [] });
    }
    await editMessage(apiUrl, chatId, msgId, '✓ Запись отменена', { inline_keyboard: [] });
    await answerCallbackQuery(apiUrl, id, 'Запись отменена');
    return;
  }

  if (data.startsWith('cancel_no') || data.startsWith('resched_no')) {
    await editMessage(apiUrl, chatId, msgId, cq.message.text || 'Действие отменено.', { inline_keyboard: [] });
    await answerCallbackQuery(apiUrl, id);
    return;
  }

  if (data.startsWith('resched_ok_')) {
    const ref = data.slice(10);
    let raw = await getBooking(ref);
    let b = raw ? JSON.parse(raw) : null;
    if (!b && fromId) {
      const userName = [cq.from?.first_name, cq.from?.last_name].filter(Boolean).join(' ').trim() || '—';
      const userHandle = cq.from?.username ? `@${cq.from.username}` : '';
      const threadId = fromId ? await store?.get(`user_${fromId}`) : null;
      const notify =
        `🔄 Клиент хочет перенести заказ\n\n` +
        `👤 ${userName} (id ${fromId}) ${userHandle}\n` +
        `⚠️ Детали из кэша недоступны. Свяжитесь для уточнения новой даты.`;
      await sendMessage(apiUrl, FORUM_CHAT_ID, notify, threadId ? { message_thread_id: Number(threadId) } : {});
      await editMessage(apiUrl, chatId, msgId, '✓ Запрос отправлен мастеру', { inline_keyboard: [] });
      await answerCallbackQuery(apiUrl, id, 'Запрос отправлен мастеру');
      return;
    }
    if (!b) {
      await answerCallbackQuery(apiUrl, id, 'Запись не найдена или устарела.', true);
      return;
    }
    const notify =
      `🔄 Клиент хочет перенести заказ\n\n` +
      `👤 ${b.name} (id ${b.uid})\n` +
      `📞 ${b.phone}\n` +
      `Услуга: ${b.service}\n` +
      `Было: ${b.date} • ${b.time}\n\n` +
      `Мастеру нужно связаться для уточнения новой даты.`;
    const opts = b.threadId ? { message_thread_id: b.threadId } : {};
    await sendMessage(apiUrl, FORUM_CHAT_ID, notify, opts);
    if (b.confirmMsgId && b.confirmChatId) {
      const origText = `✅ Заявка отправлена мастеру.\n\n📋 Вы записались:\n✨ Услуга: ${b.service}\n📅 Дата: ${b.date}\n⏰ Время: ${b.time}\n\n🔄 Запрос на перенос отправлен. Мастер свяжется для уточнения новой даты.`;
      await editMessage(apiUrl, b.confirmChatId, b.confirmMsgId, origText, { inline_keyboard: [] });
    }
    await editMessage(apiUrl, chatId, msgId, '✓ Запрос отправлен мастеру', { inline_keyboard: [] });
    await answerCallbackQuery(apiUrl, id, 'Запрос отправлен мастеру');
    return;
  }

  if (data.startsWith('cancel_')) {
    const ref = data.slice(7);
    const confirmText = 'Подтвердите отмену записи?';
    const kb = {
      inline_keyboard: [
        [{ text: 'Да, отменить', callback_data: `cancel_ok_${ref}` }],
        [{ text: 'Нет', callback_data: 'cancel_no' }],
      ],
    };
    await sendMessage(apiUrl, chatId, confirmText, { reply_markup: kb });
    await answerCallbackQuery(apiUrl, id);
    return;
  }

  if (data.startsWith('resched_')) {
    const ref = data.slice(8);
    const confirmText =
      'Подтвердите перенос записи?\n\nМастер свяжется с вами для уточнения новой даты и времени.';
    const kb = {
      inline_keyboard: [
        [{ text: 'Да, перенести', callback_data: `resched_ok_${ref}` }],
        [{ text: 'Нет', callback_data: 'resched_no' }],
      ],
    };
    await sendMessage(apiUrl, chatId, confirmText, { reply_markup: kb });
    await answerCallbackQuery(apiUrl, id);
    return;
  }

  await answerCallbackQuery(apiUrl, id);
}

