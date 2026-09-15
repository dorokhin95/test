/* app/app.js — обвязка Unity WebGL-страницы.
   Отвечает за: загрузку сборки с индикацией прогресса, адаптивный
   размер canvas, обработку ошибок с повтором, полноэкранный режим
   и интеграцию с Telegram WebApp (безопасно работает и вне Telegram). */

(() => {
  "use strict";

  // ==== Конфигурация сборки ====
  // Единственное место, где нужно менять версию при обновлении билда.
  const BUILD = {
    loaderUrl: "Build/game.loader.js",
    dataUrl: "Build/game.data",
    frameworkUrl: "Build/game.framework.js",
    codeUrl: "Build/game.wasm",
    streamingAssetsUrl: "StreamingAssets",
    companyName: "DefaultCompany",
    productName: "Test_tg2",
    productVersion: "1.0.2",
  };

  // Соотношение сторон окна сборки на десктопе (960x600 из исходного шаблона).
  const DESKTOP_ASPECT = 960 / 600;

  // Объект в сцене, которому отправляются данные Telegram после старта.
  // Заполните имя, когда в сборке появится приёмник (см. README);
  // null — данные не отправляются.
  const TELEGRAM_BRIDGE_OBJECT = null;

  // ==== DOM ====
  const container = document.getElementById("unity-container");
  const canvas = document.getElementById("unity-canvas");
  const loading = document.getElementById("loading");
  const fill = document.getElementById("progress-fill");
  const track = document.getElementById("progress-track");
  const percentEl = document.getElementById("progress-percent");
  const stageEl = document.getElementById("progress-size");
  const hintEl = document.getElementById("loading-hint");
  const retryBtn = document.getElementById("retry-button");
  const fullscreenBtn = document.getElementById("fullscreen-button");
  const warning = document.getElementById("unity-warning");

  document.getElementById("loading-version").textContent =
    "v" + BUILD.productVersion;

  // ==== Окружение ====
  const tg = window.Telegram && window.Telegram.WebApp;
  const isTelegram = !!(tg && tg.platform && tg.platform !== "unknown");
  const isMobileUA = /iPhone|iPad|iPod|Android|Mobile/i.test(navigator.userAgent);
  const isMobile = isTelegram || isMobileUA;

  if (isTelegram) {
    try {
      tg.ready();
      tg.expand();
      // Предотвращает закрытие свайпом и растягивает WebApp на весь экран.
      if (typeof tg.disableVerticalSwipes === "function") {
        tg.disableVerticalSwipes();
      }
      if (typeof tg.setHeaderColor === "function") {
        tg.setHeaderColor("#0f1419");
        tg.setBackgroundColor("#0f1419");
      }
      tg.onEvent("viewportChanged", layoutCanvas);
    } catch (e) {
      // Старые версии WebApp — просто продолжаем без этих настроек.
      console.warn("Telegram WebApp init:", e);
    }
  }

  // ==== Адаптивный canvas ====
  // Мобильные/Telegram: canvas занимает весь вьюпорт (сборка сама
  // подстраивается под размер). Десктоп: вписываем окно 960x600
  // с сохранением пропорций.
  function layoutCanvas() {
    const vw = container.clientWidth;
    const vh = container.clientHeight;
    if (!vw || !vh) return;

    if (isMobile) {
      canvas.style.width = vw + "px";
      canvas.style.height = vh + "px";
      return;
    }

    let w = Math.min(vw * 0.98, vh * 0.92 * DESKTOP_ASPECT);
    let h = w / DESKTOP_ASPECT;
    canvas.style.width = Math.round(w) + "px";
    canvas.style.height = Math.round(h) + "px";
  }

  layoutCanvas();
  window.addEventListener("resize", layoutCanvas);
  window.addEventListener("orientationchange", layoutCanvas);

  // ==== Прогресс загрузки ====
  function setProgress(p) {
    const percent = Math.round(Math.min(1, Math.max(0, p)) * 100);
    fill.style.width = percent + "%";
    track.setAttribute("aria-valuenow", String(percent));
    percentEl.textContent = percent + "%";
    // До ~90% качаются файлы сборки, дальше — инициализация движка.
    stageEl.textContent = percent < 90 ? "загрузка данных" : "инициализация";
  }

  function showError(message) {
    hintEl.textContent = "Не удалось загрузить игру" +
      (message ? ": " + message : "") +
      ". Проверьте подключение к сети.";
    retryBtn.hidden = false;
    setProgress(0);
  }

  retryBtn.addEventListener("click", () => {
    // Простой и надёжный повтор: чистое состояние страницы и кэша запросов.
    window.location.reload();
  });

  // ==== Баннер предупреждений Unity (showBanner) ====
  function showBanner(msg, type) {
    const div = document.createElement("div");
    div.textContent = msg; // textContent: msg может содержать разметку от движка
    if (type === "error") {
      div.className = "banner banner-error";
      warning.appendChild(div); // ошибки не исчезают сами
    } else {
      div.className = "banner banner-warning";
      warning.appendChild(div);
      setTimeout(() => div.remove(), 5000);
    }
    warning.style.display = "block";
  }

  // ==== Загрузка Unity ====
  let unityInstance = null;
  let isFullscreen = false;

  const config = {
    dataUrl: BUILD.dataUrl,
    frameworkUrl: BUILD.frameworkUrl,
    codeUrl: BUILD.codeUrl,
    streamingAssetsUrl: BUILD.streamingAssetsUrl,
    companyName: BUILD.companyName,
    productName: BUILD.productName,
    productVersion: BUILD.productVersion,
    showBanner: showBanner,
    // Ограничиваем разрешение рендера, чтобы 4K-мониторы и retina
    // не убивали производительность.
    devicePixelRatio: Math.min(window.devicePixelRatio || 1, isMobile ? 1.5 : 2),
  };

  function start() {
    setProgress(0);
    const script = document.createElement("script");
    script.src = BUILD.loaderUrl;
    script.onload = () => {
      createUnityInstance(canvas, config, setProgress)
        .then((instance) => {
          unityInstance = instance;
          window.unityInstance = instance; // отладка из консоли
          loading.hidden = true;
          sendTelegramData();
        })
        .catch((err) => {
          console.error("Unity load failed:", err);
          showError(typeof err === "string" ? err : err.message);
        });
    };
    script.onerror = () =>
      showError("не найден " + BUILD.loaderUrl);
    document.body.appendChild(script);
  }

  // Передаёт профиль пользователя Telegram в сцену, если там есть приёмник:
  // GameObject с методом OnTelegramUser(string json).
  function sendTelegramData() {
    if (!isTelegram || !TELEGRAM_BRIDGE_OBJECT || !tg.initDataUnsafe) return;
    try {
      unityInstance.SendMessage(
        TELEGRAM_BRIDGE_OBJECT,
        "OnTelegramUser",
        JSON.stringify(tg.initDataUnsafe.user || {})
      );
    } catch (e) {
      console.warn("sendMessage to Unity failed:", e);
    }
  }

  // ==== Полноэкранный режим ====
  fullscreenBtn.addEventListener("click", () => {
    if (!unityInstance) return;
    isFullscreen = !isFullscreen;
    unityInstance.SetFullscreen(isFullscreen ? 1 : 0);
    fullscreenBtn.setAttribute(
      "aria-label",
      isFullscreen ? "Выйти из полноэкранного режима" : "Полноэкранный режим"
    );
  });

  start();
})();
