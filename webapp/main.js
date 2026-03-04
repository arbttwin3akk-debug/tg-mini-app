const tg = window.Telegram?.WebApp;

const userInfoEl = document.getElementById('user-info');
const nameInput = document.getElementById('name');
const phoneInput = document.getElementById('phone');
const serviceSelect = document.getElementById('service');
const dateInput = document.getElementById('date');
const timeInput = document.getElementById('time');
const commentInput = document.getElementById('comment');
const submitButton = document.getElementById('submit');
const statusEl = document.getElementById('status');

if (tg) {
  tg.expand();

  const user = tg.initDataUnsafe?.user;
  if (user) {
    const name = [user.first_name, user.last_name].filter(Boolean).join(' ');
    userInfoEl.textContent = `Вы: ${name} (@${user.username || 'без username'})`;
    if (!nameInput.value) {
      nameInput.value = name;
    }
  } else {
    userInfoEl.textContent = 'Не удалось получить информацию о пользователе.';
  }
} else {
  userInfoEl.textContent =
    'Эта страница открыта не из Telegram. Откройте её как Web App, чтобы заявка ушла боту.';
}

submitButton.addEventListener('click', () => {
  const name = nameInput.value.trim();
  const phone = phoneInput.value.trim();
  const service = serviceSelect.value;
  const date = dateInput.value;
  const time = timeInput.value;
  const comment = commentInput.value.trim();

  if (!name || !phone || !date || !time) {
    statusEl.textContent = 'Заполните минимум имя, телефон, дату и время.';
    return;
  }

  if (!tg) {
    statusEl.textContent =
      'Telegram WebApp API недоступен (страница открыта не из Telegram). Заявка не будет отправлена.';
    return;
  }

  const payload = {
    type: 'manicure_booking',
    name,
    phone,
    service,
    date,
    time,
    comment,
  };

  tg.sendData(JSON.stringify(payload));
  statusEl.textContent = 'Заявка отправлена боту. Можете закрыть приложение.';
});
