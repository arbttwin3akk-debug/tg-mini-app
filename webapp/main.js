const tg = window.Telegram?.WebApp;

const userInfoEl = document.getElementById('user-info');
const messageInput = document.getElementById('message-input');
const sendButton = document.getElementById('send-button');
const statusEl = document.getElementById('status');

if (tg) {
  tg.expand();

  const user = tg.initDataUnsafe?.user;
  if (user) {
    const name = [user.first_name, user.last_name].filter(Boolean).join(' ');
    userInfoEl.textContent = `Вы: ${name} (@${user.username || 'без username'})`;
  } else {
    userInfoEl.textContent = 'Не удалось получить информацию о пользователе.';
  }
} else {
  userInfoEl.textContent =
    'Это веб‑страница открыта не из Telegram. Откройте её как Web App, чтобы видеть данные пользователя.';
}

sendButton.addEventListener('click', () => {
  const text = messageInput.value.trim();
  if (!text) {
    statusEl.textContent = 'Введите сообщение, чтобы отправить его боту.';
    return;
  }

  if (!tg) {
    statusEl.textContent =
      'Telegram WebApp API недоступен (страница открыта не из Telegram). Сообщение не будет отправлено.';
    return;
  }

  tg.sendData(
    JSON.stringify({
      type: 'form_message',
      text,
      sentAt: new Date().toISOString(),
    })
  );

  statusEl.textContent = 'Сообщение отправлено в бота. Можете закрыть мини‑приложение.';
});

