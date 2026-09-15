/* app/app.js — обвязка Unity WebGL-страницы.
   Отвечает за: собственный экран загрузки (полностью закрывает заставку
   Unity), прогресс с повтором при ошибке, процедурный анимированный фон,
   альбомную ориентацию в Telegram с учётом вырезов и полноэкранный
   режим на десктопе. Вне Telegram всё деградирует до обычного WebGL-хоста. */

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

  // Объект в сцене Unity, которому отправляется профиль Telegram после
  // старта (GameObject с методом OnTelegramUser(string json)).
  // null — не отправляется. См. README.
  const TELEGRAM_BRIDGE_OBJECT = null;

  // ==== DOM ====
  const $ = (id) => document.getElementById(id);
  const canvas = $("unity-canvas");
  const loading = $("loading");
  const bgCanvas = $("bg-fx");
  const fill = $("progress-fill");
  const track = $("progress-track");
  const percentEl = $("progress-percent");
  const stageEl = $("progress-size");
  const hintEl = $("loading-hint");
  const retryBtn = $("retry-button");
  const fullscreenBtn = $("fullscreen-button");
  const warning = $("unity-warning");
  const rotateHint = $("rotate-hint");

  $("loading-version").textContent = "v" + BUILD.productVersion;

  // ==== Окружение ====
  const tg = window.Telegram && window.Telegram.WebApp;
  const isTelegram = !!(tg && tg.platform && tg.platform !== "unknown");
  const isMobile = isTelegram ||
    /iPhone|iPad|iPod|Android|Mobile/i.test(navigator.userAgent);
  const reducedMotion = window.matchMedia &&
    matchMedia("(prefers-reduced-motion: reduce)").matches;

  if (isMobile) document.body.classList.add("is-mobile");

  // ==== Telegram WebApp ====
  if (isTelegram) {
    try {
      tg.ready();
      tg.expand();
      // Свайп вниз закрывает Mini App — в игре это почти всегда случайный
      // выход, поэтому отключаем.
      if (typeof tg.disableVerticalSwipes === "function") {
        tg.disableVerticalSwipes();
      }
      if (typeof tg.setHeaderColor === "function") {
        tg.setHeaderColor("#0d1218");
        tg.setBackgroundColor("#0d1218");
      }
      // Принудительная альбомная ориентация (Web App SDK 7.7+).
      if (tg.screenOrientation &&
          tg.screenOrientation.isLocked !== true &&
          typeof tg.screenOrientation.lock === "function") {
        tg.screenOrientation.lock("landscape");
      }
    } catch (e) {
      // Старые клиенты Telegram: ориентация/шапка недоступны — живём без них.
      console.warn("Telegram WebApp init:", e);
    }
  }

  // Вне Telegram браузер разрешает lock() только в полноэкранном режиме;
  // пробуем при первом касании (мобильные браузеры) и молча проваливаемся.
  if (isMobile && !isTelegram && screen.orientation && screen.orientation.lock) {
    const tryLock = () => {
      try {
        const r = screen.orientation.lock("landscape");
        if (r && r.catch) r.catch(() => {});
      } catch (e) { /* unsupported */ }
    };
    window.addEventListener("touchend", tryLock, { once: true });
  }

  // Подсказка «поверните телефон», если всё же остались в портрете.
  const mqPortrait = window.matchMedia("(orientation: portrait)");
  function updateRotateHint() {
    rotateHint.classList.toggle("visible", isMobile && mqPortrait.matches);
  }
  if (mqPortrait.addEventListener) {
    mqPortrait.addEventListener("change", updateRotateHint);
  } else if (mqPortrait.addListener) {
    mqPortrait.addListener(updateRotateHint);
  }
  updateRotateHint();

  // ==== Процедурный анимированный фон ====
  // Северное сияние из дрейфующих радиальных градиентов + медленный
  // звёздный параллакс. Никаких ассетов — всё генерируется на canvas.
  const background = (() => {
    const ctx = bgCanvas.getContext("2d");
    let raf = 0;
    let running = false;
    let w = 0, h = 0, dpr = 1;

    const BLOBS = [
      { hue: 208, sat: 60, rad: 0.62, ax: 0.36, ay: 0.22, sx: 0.00013, sy: 0.00009, ph: 0.4 },
      { hue: 168, sat: 55, rad: 0.50, ax: 0.30, ay: 0.28, sx: 0.00010, sy: 0.00014, ph: 1.9 },
      { hue: 258, sat: 48, rad: 0.55, ax: 0.40, ay: 0.20, sx: 0.00007, sy: 0.00011, ph: 3.6 },
      { hue: 205, sat: 50, rad: 0.40, ax: 0.45, ay: 0.30, sx: 0.00016, sy: 0.00007, ph: 5.2 },
    ];
    const STARS = Array.from({ length: 90 }, () => ({
      x: Math.random(), y: Math.random(),
      z: 0.25 + Math.random() * 0.75,        // глубина: размер/скорость/яркость
      tw: Math.random() * Math.PI * 2,       // фаза мерцания
    }));

    function resize() {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = bgCanvas.clientWidth || window.innerWidth;
      h = bgCanvas.clientHeight || window.innerHeight;
      bgCanvas.width = Math.max(1, Math.round(w * dpr));
      bgCanvas.height = Math.max(1, Math.round(h * dpr));
    }

    function draw(t) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const base = ctx.createLinearGradient(0, 0, 0, h);
      base.addColorStop(0, "#0a0f15");
      base.addColorStop(1, "#101a26");
      ctx.fillStyle = base;
      ctx.fillRect(0, 0, w, h);

      ctx.globalCompositeOperation = "lighter";
      const max = Math.max(w, h);
      for (const b of BLOBS) {
        const x = w * (0.5 + b.ax * Math.sin(t * b.sx + b.ph));
        const y = h * (0.5 + b.ay * Math.cos(t * b.sy + b.ph * 1.3));
        const r = max * b.rad;
        const g = ctx.createRadialGradient(x, y, 0, x, y, r);
        g.addColorStop(0, `hsla(${b.hue}, ${b.sat}%, 45%, 0.16)`);
        g.addColorStop(1, `hsla(${b.hue}, ${b.sat}%, 45%, 0)`);
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, w, h);
      }

      for (const s of STARS) {
        const drift = (t * 0.000010 * s.z) % 1;
        const x = ((s.x + drift) % 1) * w;
        const y = s.y * h;
        const a = 0.20 + 0.40 * s.z * (0.5 + 0.5 * Math.sin(t * 0.001 + s.tw));
        ctx.globalAlpha = a;
        ctx.fillStyle = "#cfe4ff";
        const size = s.z * 1.8;
        ctx.fillRect(x, y, size, size);
      }

      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
    }

    function frame(t) {
      if (!running) return;
      draw(t);
      raf = requestAnimationFrame(frame);
    }

    window.addEventListener("resize", resize);
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        cancelAnimationFrame(raf);
      } else if (running && !reducedMotion) {
        raf = requestAnimationFrame(frame);
      }
    });

    resize();
    if (reducedMotion) {
      draw(0); // один статичный кадр вместо анимации
    } else {
      running = true;
      raf = requestAnimationFrame(frame);
    }

    return {
      pause() { running = false; cancelAnimationFrame(raf); },
      resume() {
        if (reducedMotion || running) return;
        running = true;
        raf = requestAnimationFrame(frame);
      },
    };
  })();

  // ==== Прогресс загрузки ====
  function setProgress(p) {
    const percent = Math.round(Math.min(1, Math.max(0, p)) * 100);
    fill.style.width = percent + "%";
    track.setAttribute("aria-valuenow", String(percent));
    percentEl.textContent = percent + "%";
    // До ~90% качаются файлы сборки, дальше — инициализация движка.
    stageEl.textContent = percent < 90 ? "загрузка данных" : "запуск движка";
  }

  function showError(message) {
    background.resume();
    loading.hidden = false;
    loading.classList.remove("fade-out");
    hintEl.textContent = "Не удалось загрузить игру" +
      (message ? ": " + message : "") +
      ". Проверьте подключение к сети.";
    retryBtn.hidden = false;
  }

  retryBtn.addEventListener("click", () => window.location.reload());

  // ==== Баннеры предупреждений Unity (showBanner) ====
  function showBanner(msg, type) {
    const div = document.createElement("div");
    div.textContent = msg; // textContent: msg может содержать разметку движка
    div.className = type === "error" ? "banner banner-error" : "banner banner-warning";
    warning.appendChild(div);
    warning.style.display = "block";
    if (type !== "error") setTimeout(() => div.remove(), 5000);
  }

  // ==== Загрузка Unity ====
  // Экранный overlay (#loading) непрозрачен и лежит над canvas:
  // 1) стандартный лоадер шаблона Unity не используется вовсе — свой экран;
  // 2) после готовности инстанса overlay держится ещё SPLASH_COVER_MS —
  //    в это время движок рисует собственный splash прямо в canvas.
  //    Полностью отключить движковый splash можно и в Unity: Player
  //    Settings → WebGL → Show Unity Splash Screen (требует лицензию Plus);
  //    с этим таймаутом он скрыт и без пересборки.
  let unityInstance = null;
  let isFullscreen = false;
  const SPLASH_COVER_MS = 2500;

  const config = {
    dataUrl: BUILD.dataUrl,
    frameworkUrl: BUILD.frameworkUrl,
    codeUrl: BUILD.codeUrl,
    streamingAssetsUrl: BUILD.streamingAssetsUrl,
    companyName: BUILD.companyName,
    productName: BUILD.productName,
    productVersion: BUILD.productVersion,
    showBanner: showBanner,
    // Ограничиваем внутреннее разрешение рендера: на retina/4K
    // движку не нужно рисовать в полном DPR — это основной расход батареи.
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
          hintEl.textContent = "Готово! Запускаем…";
          // Держим overlay поверх движкового splash, затем плавно убираем.
          setTimeout(() => {
            loading.classList.add("fade-out");
            background.pause();
            setTimeout(() => { loading.hidden = true; }, 450);
          }, SPLASH_COVER_MS);
          sendTelegramUser();
        })
        .catch((err) => {
          console.error("Unity load failed:", err);
          showError(typeof err === "string" ? err : (err && err.message));
        });
    };
    script.onerror = () => showError("не найден " + BUILD.loaderUrl);
    document.body.appendChild(script);
  }

  function sendTelegramUser() {
    if (!isTelegram || !TELEGRAM_BRIDGE_OBJECT || !tg.initDataUnsafe) return;
    try {
      unityInstance.SendMessage(
        TELEGRAM_BRIDGE_OBJECT,
        "OnTelegramUser",
        JSON.stringify(tg.initDataUnsafe.user || {})
      );
    } catch (e) {
      console.warn("SendMessage to Unity failed:", e);
    }
  }

  // ==== Полноэкранный режим ====
  // toggle: повторное нажатие (или Esc/системный жест) выходит из фуллскрина;
  // состояние синхронизируется через fullscreenchange.
  function toggleFullscreen() {
    if (!unityInstance) return;
    unityInstance.SetFullscreen(isFullscreen ? 0 : 1);
    // При входе в фуллскрин в мобильном браузере появляется право
    // залочить ориентацию — пользуемся им.
    if (!isFullscreen && !isTelegram && screen.orientation && screen.orientation.lock) {
      try {
        const r = screen.orientation.lock("landscape");
        if (r && r.catch) r.catch(() => {});
      } catch (e) { /* unsupported */ }
    }
  }

  fullscreenBtn.addEventListener("click", toggleFullscreen);
  document.addEventListener("fullscreenchange", () => {
    isFullscreen = !!document.fullscreenElement;
    fullscreenBtn.setAttribute(
      "aria-label",
      isFullscreen ? "Выйти из полноэкранного режима" : "Полноэкранный режим"
    );
  });

  // ==== Мост для кода внутри Unity ====
  // Вызывается из C# через Application.ExternalCall / ExternalEval.
  window.GameBridge = {
    isTelegram: () => isTelegram,
    telegramUser: () =>
      (isTelegram && tg.initDataUnsafe && tg.initDataUnsafe.user) || null,
    haptic: (style) => {
      try {
        if (isTelegram && tg.HapticFeedback) {
          tg.HapticFeedback.impactOccurred(style || "light");
        }
      } catch (e) { /* noop */ }
    },
    closeApp: () => { try { if (isTelegram) tg.close(); } catch (e) { /* noop */ } },
    showError: (msg) => showError(msg),
  };

  start();
})();
