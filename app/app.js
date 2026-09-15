/* app/app.js — обвязка Unity WebGL-страницы.
   Экраны: стартовое меню → загрузка (кольцевой прогресс) → игра ⇄ пауза.
   Плюс: процедурный анимированный фон, синтезированные на WebAudio звуки
   (взмах крыльев, очко, смерть), альбомная ориентация в Telegram,
   полноэкранный режим на десктопе. Вне Telegram всё деградирует
   до обычного WebGL-хоста. */

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

  // Сколько держать экран загрузки поверх движкового splash Unity (мс).
  const SPLASH_COVER_MS = 2500;

  // ==== DOM ====
  const $ = (id) => document.getElementById(id);
  const canvas = $("unity-canvas");
  const bgCanvas = $("bg-fx");
  const startMenu = $("menu-start");
  const loading = $("loading");
  const pauseMenu = $("menu-pause");
  const playBtn = $("play-button");
  const pauseFab = $("pause-fab");
  const resumeBtn = $("resume-button");
  const restartBtn = $("restart-button");
  const fullscreenBtn = $("fullscreen-button");
  const retryBtn = $("retry-button");
  const warning = $("unity-warning");
  const rotateHint = $("rotate-hint");
  const fillEl = $("ring-fg");
  const percentEl = $("progress-percent");
  const stageEl = $("progress-size");
  const hintEl = $("loading-hint");

  // ==== Состояние страницы ====
  // start → loading → running ⇄ paused (splash — промежуточная фаза загрузки)
  let state = "start";
  function setState(next) {
    state = next;
    document.body.dataset.state = next;
  }

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
      // Аппаратная «назад» в Telegram: пауза, а на паузе — выход в чат.
      if (typeof tg.onEvent === "function") {
        tg.onEvent("backButtonClicked", () => {
          if (state === "running") pauseGame();
          else if (state === "paused") tg.close();
        });
      }
    } catch (e) {
      console.warn("Telegram WebApp init:", e);
    }
  }

  // Вне Telegram браузер разрешает lock() только в полноэкранном режиме;
  // пробуем при первом касании и молча проваливаемся.
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
    if (!ctx) return { pause() {}, resume() {} };
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
      w = window.innerWidth;
      h = window.innerHeight;
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

  // ==== Звуковой движок ====
  // Все звуки синтезируются на WebAudio — ассеты не нужны.
  // Запускается по первому пользовательскому действию (политика автоплея).
  const sfx = (() => {
    let ctx = null;
    let master = null;
    let noiseBuf = null;

    let muted;
    try { muted = localStorage.getItem("ttg2-muted") === "1"; }
    catch (e) { muted = false; }

    function persist() {
      try { localStorage.setItem("ttg2-muted", muted ? "1" : "0"); }
      catch (e) { /* приватный режим */ }
    }

    function ensure() {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return false;
      if (!ctx) {
        ctx = new AC();
        master = ctx.createGain();
        master.gain.value = muted ? 0 : 0.9;
        master.connect(ctx.destination);
        const len = ctx.sampleRate | 0; // 1 с «белого шума» для взмахов/краша
        noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
        const d = noiseBuf.getChannelData(0);
        for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      }
      if (ctx.state === "suspended") ctx.resume();
      return true;
    }

    // Взмах крыльев: шум через свипирующий полосовой фильтр + низкочастотное
    // «тело» удара воздуха.
    function flap() {
      if (!ensure()) return;
      const t = ctx.currentTime;

      const src = ctx.createBufferSource();
      src.buffer = noiseBuf;
      src.loop = true;
      const bp = ctx.createBiquadFilter();
      bp.type = "bandpass";
      bp.Q.value = 1.1;
      bp.frequency.setValueAtTime(350, t);
      bp.frequency.exponentialRampToValueAtTime(1500, t + 0.09);
      bp.frequency.exponentialRampToValueAtTime(500, t + 0.22);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.5, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.24);
      src.connect(bp); bp.connect(g); g.connect(master);
      src.start(t); src.stop(t + 0.26);

      const o = ctx.createOscillator();
      o.type = "sine";
      o.frequency.setValueAtTime(180, t);
      o.frequency.exponentialRampToValueAtTime(70, t + 0.12);
      const g2 = ctx.createGain();
      g2.gain.setValueAtTime(0.0001, t);
      g2.gain.exponentialRampToValueAtTime(0.32, t + 0.015);
      g2.gain.exponentialRampToValueAtTime(0.0001, t + 0.13);
      o.connect(g2); g2.connect(master);
      o.start(t); o.stop(t + 0.15);
    }

    // Удачное прохождение: быстрый восходящий двойной блип (A5 → D6).
    function score() {
      if (!ensure()) return;
      const t0 = ctx.currentTime;
      [880, 1174.7].forEach((f, i) => {
        const o = ctx.createOscillator();
        o.type = "triangle";
        o.frequency.value = f;
        const g = ctx.createGain();
        const t = t0 + i * 0.085;
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.4, t + 0.015);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
        o.connect(g); g.connect(master);
        o.start(t); o.stop(t + 0.18);
      });
    }

    // Смерть: пикирующий saw с закрывающимся фильтром + шумовой краш.
    function death() {
      if (!ensure()) return;
      const t = ctx.currentTime;

      const o = ctx.createOscillator();
      o.type = "sawtooth";
      o.frequency.setValueAtTime(300, t);
      o.frequency.exponentialRampToValueAtTime(38, t + 0.55);
      const lp = ctx.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.setValueAtTime(1200, t);
      lp.frequency.exponentialRampToValueAtTime(120, t + 0.55);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.45, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.6);
      o.connect(lp); lp.connect(g); g.connect(master);
      o.start(t); o.stop(t + 0.62);

      const src = ctx.createBufferSource();
      src.buffer = noiseBuf;
      src.playbackRate.value = 0.8;
      const ng = ctx.createGain();
      ng.gain.setValueAtTime(0.5, t);
      ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
      src.connect(ng); ng.connect(master);
      src.start(t); src.stop(t + 0.2);
    }

    // Клик по кнопкам меню.
    function ui(freq) {
      if (!ensure()) return;
      const t = ctx.currentTime;
      const f = freq || 520;
      const o = ctx.createOscillator();
      o.type = "sine";
      o.frequency.setValueAtTime(f, t);
      o.frequency.exponentialRampToValueAtTime(f * 1.5, t + 0.07);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.25, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
      o.connect(g); g.connect(master);
      o.start(t); o.stop(t + 0.13);
    }

    function setMuted(m) {
      muted = !!m;
      persist();
      if (master) master.gain.value = muted ? 0 : 0.9;
      document.querySelectorAll("#start-sound-toggle, #pause-sound-toggle")
        .forEach((btn) => {
          btn.setAttribute("aria-pressed", String(!muted));
          const label = btn.querySelector("span");
          if (label) {
            label.textContent = muted
              ? (btn.id === "start-sound-toggle" ? "Звук выключен" : "Звук")
              : (btn.id === "start-sound-toggle" ? "Звук включён" : "Звук");
          }
        });
    }

    return {
      flap, score, death, ui,
      unlock: ensure,
      isMuted: () => muted,
      setMuted,
    };
  })();

  // ==== Пауза игрового цикла ====
  // Публичного API паузы у этого билда Unity нет, поэтому подменяем
  // requestAnimationFrame: пока paused === true, отложенные колбэки копятся,
  // а не исполняются — движок и физика честно встают на последнем кадре.
  let loopPaused = false;
  const pendingFrames = new Map();
  const nativeRaf = window.requestAnimationFrame.bind(window);
  const nativeCaf = window.cancelAnimationFrame.bind(window);

  window.requestAnimationFrame = (cb) => {
    const id = nativeRaf((t) => {
      if (loopPaused) {
        pendingFrames.set(id, cb);
        return;
      }
      cb(t);
    });
    return id;
  };
  window.cancelAnimationFrame = (id) => {
    pendingFrames.delete(id);
    nativeCaf(id);
  };

  // Звук, который играет сама игра (если появится в сборке), тоже глушим
  // на паузе — иначе AudioContext продолжит фонить за замороженным кадром.
  function setGameAudioSuspended(suspend) {
    const acs = [];
    try {
      const m = unityInstance && unityInstance.Module;
      if (m && m.audioContext) acs.push(m.audioContext);
    } catch (e) { /* noop */ }
    try { if (window.unityAudioContext) acs.push(window.unityAudioContext); }
    catch (e) { /* noop */ }
    acs.forEach((ac) => {
      try { suspend ? ac.suspend() : ac.resume(); } catch (e) { /* noop */ }
    });
  }

  function pauseGame() {
    if (state !== "running") return;
    loopPaused = true;
    setGameAudioSuspended(true);
    pauseMenu.hidden = false;
    sfx.ui(420);
    setState("paused");
  }

  function resumeGame() {
    if (state !== "paused") return;
    sfx.ui(620);
    pauseMenu.hidden = true;
    loopPaused = false;
    const queued = Array.from(pendingFrames.values());
    pendingFrames.clear();
    queued.forEach((cb) => window.requestAnimationFrame(cb));
    setGameAudioSuspended(false);
    setState("running");
  }

  // ==== Прогресс загрузки: кольцевой счётчик ====
  const RING_C = 2 * Math.PI * 52;
  fillEl.style.strokeDasharray = String(RING_C);
  fillEl.style.strokeDashoffset = String(RING_C);

  function setProgress(p) {
    const percent = Math.round(Math.min(1, Math.max(0, p)) * 100);
    fillEl.style.strokeDashoffset = String(RING_C * (1 - percent / 100));
    percentEl.textContent = String(percent);
    // До ~90% качаются файлы сборки, дальше — инициализация движка.
    stageEl.textContent = percent < 90 ? "загрузка данных" : "запуск движка";
  }

  function showError(message) {
    setState("start");
    loading.hidden = false;
    loading.classList.remove("solid", "fade-out");
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
  // Скачивание 26 МБ стартует только по нажатию «Играть»: трафик тратится
  // целенаправленно, а overlay загрузки (сначала полупрозрачный — виден
  // анимированный фон, затем .solid — полностью укрывает движковый splash)
  // подменяет штатную заставку Unity.
  let unityInstance = null;
  let isFullscreen = false;
  let loadStarted = false;

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
    if (loadStarted) return;
    loadStarted = true;
    setState("loading");
    setProgress(0);
    const script = document.createElement("script");
    script.src = BUILD.loaderUrl;
    script.onload = () => {
      createUnityInstance(canvas, config, setProgress)
        .then((instance) => {
          unityInstance = instance;
          window.unityInstance = instance; // отладка из консоли
          // Движок сейчас рисует свой splash в canvas — закрываем его
          // непрозрачным слоем, потом плавно убираем.
          loading.classList.add("solid");
          hintEl.textContent = "Готово! Запускаем…";
          stageEl.textContent = "";
          setTimeout(() => {
            loading.classList.add("fade-out");
            background.pause();
            setTimeout(() => { loading.hidden = true; }, 450);
            setState("running");
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

  // ==== Обработчики меню ====
  playBtn.addEventListener("click", () => {
    sfx.unlock(); // аудиоконтекст создаётся по жесту пользователя
    sfx.ui(620);
    startMenu.hidden = true;
    loading.hidden = false;
    hintEl.textContent = "Загружаем игру…";
    start();
  });

  pauseFab.addEventListener("click", pauseGame);
  resumeBtn.addEventListener("click", resumeGame);
  restartBtn.addEventListener("click", () => {
    sfx.ui();
    window.location.reload();
  });

  document.querySelectorAll("#start-sound-toggle, #pause-sound-toggle")
    .forEach((btn) => btn.addEventListener("click", () => {
      sfx.setMuted(!sfx.isMuted());
      if (!sfx.isMuted()) sfx.ui(700); // короткий «пинг» при включении
    }));
  sfx.setMuted(sfx.isMuted()); // синхронизировать подписи с сохранённым

  // ==== Игровые вводные хуки ====
  // Игра — «тапни, чтобы взмахнуть»: каждый pointerdown по canvas и
  // пробел/стрелка на десктопе = взмах крыльев = соответствующий звук.
  function isFlapKey(code) {
    return code === "Space" || code === "ArrowUp" || code === "KeyW";
  }
  canvas.addEventListener("pointerdown", () => {
    if (state === "running") sfx.flap();
  }, { passive: true });

  window.addEventListener("keydown", (e) => {
    if (e.repeat) return;
    if (state === "running" && isFlapKey(e.code)) {
      sfx.flap();
    } else if (e.code === "Escape" || e.code === "KeyP") {
      if (state === "running") pauseGame();
      else if (state === "paused") resumeGame();
    }
  });

  // Сворачивание вкладки / уход из Telegram — автоматически на паузу.
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && state === "running") pauseGame();
  });

  // ==== Полноэкранный режим (десктоп) ====
  function toggleFullscreen() {
    if (!unityInstance) return;
    unityInstance.SetFullscreen(isFullscreen ? 0 : 1);
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
  // Вызывается из C#: Application.ExternalEval("window.GameBridge.score()")
  // или ExternalCall по именам onPlayerScore/onPlayerDeath/onPlayerFlap.
  window.GameBridge = {
    isTelegram: () => isTelegram,
    telegramUser: () =>
      (isTelegram && tg.initDataUnsafe && tg.initDataUnsafe.user) || null,
    flap: () => sfx.flap(),
    score: () => sfx.score(),
    death: () => sfx.death(),
    playSound: (name) => {
      const fn = { flap: sfx.flap, score: sfx.score, death: sfx.death, ui: sfx.ui }[name];
      if (fn) fn();
    },
    setMuted: (m) => sfx.setMuted(!!m),
    pause: pauseGame,
    resume: resumeGame,
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
  window.onPlayerFlap = window.GameBridge.flap;
  window.onPlayerScore = window.GameBridge.score;
  window.onPlayerDeath = window.GameBridge.death;

  // Стартуем со стартового меню: загрузка начнётся по нажатию «Играть».
  $("start-version").textContent = "v" + BUILD.productVersion;
  setState("start");
})();
