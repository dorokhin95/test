# Test_tg2

Игра на **Unity WebGL**, опубликованная через **GitHub Pages** и адаптированная
для запуска внутри **Telegram WebApp** (Mini App). Название сборки — `Test_tg2`,
версия `1.0.2`.

## Структура

```
.
├── index.html              Точка входа (кастомная обвязка над Unity-шаблоном)
├── app/                    Обвязка страницы, отделена от Unity-шаблона
│   ├── app.css             Адаптивная вёрстка, экран загрузки, баннеры
│   └── app.js              Загрузка сборки, прогресс, Telegram-мост
├── Build/                  Выход Unity WebGL (не редактируется вручную)
│   ├── game.loader.js
│   ├── game.framework.js
│   ├── game.data
│   └── game.wasm
├── TemplateData/           Иконки и изображения Unity-шаблона
└── .github/workflows/
    └── deploy.yml          Деплой статики на GitHub Pages
```

## Как запустить локально

Unity WebGL не работает по протоколу `file://` — нужен любой локальный
HTTP-сервер из корня репозитория:

```bash
# Python 3
python -m http.server 8080
# затем открыть http://localhost:8080

# или Node
npx serve .
```

## Как обновить сборку

1. В Unity: **File → Build Settings → WebGL → Build** в отдельную папку.
2. Скопировать содержимое папки `Build/` из экспорта в `Build/` этого репо
   (имена файлов должны совпадать с константой `BUILD` в `app/app.js`).
3. При необходимости обновить `productVersion`, `productName`, `companyName`
   в начале `app/app.js` — они же показываются на экране загрузки.

## Настройка Telegram WebApp

Обвязка работает и в обычном браузере, и внутри Telegram:

- В `app/app.js` можно указать `TELEGRAM_BRIDGE_OBJECT` — имя GameObject в
  сцене Unity с методом `OnTelegramUser(string json)`, чтобы передать профиль
  пользователя после старта. По умолчанию `null` (не отправляется).
- В интерфейсе Telegram включается `expand()`, `disableVerticalSwipes()`,
  тёмная шапка/фон `#0f1419`.

Чтобы опубликовать как Mini App: в [@BotFather] укажите Web App URL на
`https://<username>.github.io/test/`.

## Деплой

Push в `main` запускает workflow `deploy.yml`, который публикует репозиторий
как статический сайт на GitHub Pages. В настройках репо должен быть выбран
**Settings → Pages → Source: GitHub Actions**.
