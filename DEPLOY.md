# Как включить автодеплой бота в Cloudflare (один раз)

Чтобы я мог сам деплоить Worker командой `npm run deploy`, сделай один раз:

## 1. Установить зависимости

В папке проекта:

```bash
npm install
```

## 2. Войти в Cloudflare (Wrangler)

```bash
npx wrangler login
```

Откроется браузер — войди в свой аккаунт Cloudflare.

## 3. Указать ID KV в wrangler.toml

- Зайди в **Cloudflare** → **Workers & Pages** → **KV**.
- Открой своё пространство имён (то, что привязано к Worker как `CLIENT_THREADS`).
- Скопируй **Namespace ID** (например `a1b2c3d4e5f6...`).
- В проекте открой файл **`wrangler.toml`** и замени `PASTE_YOUR_KV_NAMESPACE_ID` на этот ID.

## 4. Задать секреты (токен и URL приложения)

Выполни по одному разу:

```bash
npx wrangler secret put BOT_TOKEN
```
Введи токен бота от BotFather и нажми Enter.

```bash
npx wrangler secret put WEB_APP_URL
```
Введи `https://tg-mini-app-6tj.pages.dev/` (или свой URL Pages) и нажми Enter.

## 5. Готово

После этого при любых правках в коде бота я могу выполнять:

```bash
npm run deploy
```

и Worker будет обновляться в Cloudflare без копирования кода вручную.
