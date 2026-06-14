/*
 * main.js — Wires everything together: the game loop, input (swipe +
 * keyboard), UI screen state machine, audio, the coin economy (via Shop),
 * and the engine sound. The only file that touches the DOM, so the engine
 * and renderer stay portable.
 */
(function () {
  const canvas = document.getElementById("game");
  const engine = new GameEngine(CONFIG);

  // Build the 3D renderer. If WebGL is unavailable/blocked, show a friendly
  // message instead of a broken page or a raw error.
  let renderer;
  try {
    renderer = new Renderer(canvas, CONFIG);
  } catch (err) {
    console.error("Renderer init failed:", err);
    const wrap = document.getElementById("game-wrap");
    document.querySelectorAll(".screen").forEach((s) => s.classList.add("hidden"));
    const msg = document.createElement("div");
    msg.style.cssText =
      "position:absolute;inset:0;display:flex;flex-direction:column;gap:10px;align-items:center;" +
      "justify-content:center;padding:28px;text-align:center;z-index:50;background:#bfe3ff;color:#2c3e50;" +
      "font-family:'Trebuchet MS',system-ui,sans-serif;";
    msg.innerHTML =
      "<div style='font-size:52px'>🚗💨</div>" +
      "<div style='font-size:20px;font-weight:bold'>Couldn't start the 3D view</div>" +
      "<div style='font-size:14px;max-width:300px;opacity:.85'>This browser/device couldn't initialise WebGL. " +
      "Try a different browser, or turn off Low Power Mode and reload.</div>";
    wrap.appendChild(msg);
    return;
  }

  // DOM refs
  const $ = (id) => document.getElementById(id);
  const elStart = $("screen-start"), elShop = $("screen-shop");
  const elOver = $("screen-over"), elHud = $("hud");
  const elHudScore = $("hud-score"), elHudCoins = $("hud-coins-val"), elHudSpeed = $("hud-speed-val");

  // --- Persistence / economy ----------------------------------------------
  function refreshLabels() {
    $("start-best").textContent = Shop.best;
    $("start-coins").textContent = Shop.coins;
  }
  // Push every equipped customization (paint, body design, lights, world) to the
  // 3D scene. Order matters: set paint/light first so a design rebuild picks them up.
  function applyCustomization() {
    renderer.setLights(Shop.equippedLight());
    renderer.setCar(Shop.equippedColors());
    renderer.setDesign(Shop.equippedDesign());
    renderer.setBackground(Shop.equippedBackground());
  }
  function onShopChange() { refreshLabels(); applyCustomization(); }
  Shop.init({ onChange: onShopChange });
  engine.best = Shop.best;
  applyCustomization();

  // --- Screen state machine ------------------------------------------------
  let ui = "start";          // "start" | "shop" | "playing" | "over"
  let sawNewBest = false;
  let deadAt = 0;

  function hideAll() {
    elStart.classList.add("hidden"); elShop.classList.add("hidden");
    elOver.classList.add("hidden"); elHud.classList.add("hidden");
  }
  function showStart() { ui = "start"; hideAll(); refreshLabels(); elStart.classList.remove("hidden"); }
  function showShop()  { ui = "shop";  hideAll(); Shop.renderGarage(); elShop.classList.remove("hidden"); }
  function showPlaying() {
    ui = "playing"; hideAll(); elHud.classList.remove("hidden");
    elHudScore.textContent = "0"; elHudCoins.textContent = "0"; elHudSpeed.textContent = "0";
  }
  function showOver() {
    ui = "over"; hideAll();
    $("over-score").textContent = engine.score;
    $("over-best").textContent = engine.best;
    $("over-coins").textContent = engine.runCoins;
    $("new-best").classList.toggle("hidden", !sawNewBest);
    elOver.classList.remove("hidden");
  }

  // --- Actions -------------------------------------------------------------
  function beginGame() {
    sawNewBest = false;
    engine.upgrades = Shop.upgrades;       // apply purchased perks for this run
    engine.best = Shop.best;
    engine.reset();
    engine.start();
    applyCustomization();
    Sfx.unlock(); Sfx.engineStart();
    showPlaying();
  }

  function steer(dir) {
    if (ui === "shop") return;
    Sfx.unlock();
    if (engine.state === "ready") beginGame();
    else if (engine.state === "playing") engine.steer(dir);
    else if (engine.state === "dead" && performance.now() - deadAt > 350) beginGame();
  }
  function confirmAction() {
    if (ui === "shop") return;
    Sfx.unlock();
    if (engine.state === "ready") beginGame();
    else if (engine.state === "dead" && performance.now() - deadAt > 350) beginGame();
  }

  // --- Input: swipe + tap --------------------------------------------------
  const SWIPE_PX = 28;
  let downX = 0, downY = 0, tracking = false;
  canvas.addEventListener("pointerdown", (e) => {
    e.preventDefault(); downX = e.clientX; downY = e.clientY; tracking = true;
  });
  canvas.addEventListener("pointerup", (e) => {
    if (!tracking) return; tracking = false;
    const dx = e.clientX - downX, dy = e.clientY - downY;
    if (Math.abs(dx) > SWIPE_PX && Math.abs(dx) > Math.abs(dy)) {
      steer(dx < 0 ? -1 : 1);
    } else if (engine.state === "playing") {
      const rect = canvas.getBoundingClientRect();
      steer((e.clientX - rect.left) / rect.width < 0.5 ? -1 : 1);
    } else {
      confirmAction();
    }
  });
  canvas.addEventListener("pointercancel", () => { tracking = false; });

  elStart.addEventListener("pointerdown", (e) => { if (e.target === elStart) confirmAction(); });
  elOver.addEventListener("pointerdown", (e) => { if (e.target === elOver) confirmAction(); });

  $("play-btn").addEventListener("click", (e) => { e.stopPropagation(); beginGame(); });
  $("again-btn").addEventListener("click", (e) => { e.stopPropagation(); if (engine.state === "dead") beginGame(); });
  $("garage-btn").addEventListener("click", (e) => { e.stopPropagation(); Sfx.unlock(); showShop(); });
  $("over-garage-btn").addEventListener("click", (e) => { e.stopPropagation(); Sfx.unlock(); showShop(); });
  $("shop-back").addEventListener("click", (e) => { e.stopPropagation(); showStart(); });

  // --- Input: keyboard -----------------------------------------------------
  window.addEventListener("keydown", (e) => {
    switch (e.code) {
      case "ArrowLeft": case "KeyA":  e.preventDefault(); steer(-1); break;
      case "ArrowRight": case "KeyD": e.preventDefault(); steer(1); break;
      case "Space": case "Enter":     e.preventDefault(); confirmAction(); break;
      case "Escape":                  if (ui === "shop") showStart(); break;
      case "KeyM":                    toggleMute(); break;
    }
  });

  // --- Mute ----------------------------------------------------------------
  function toggleMute() {
    const muted = Sfx.toggleMute();
    $("mute-btn").textContent = muted ? "🔇" : "🔊";
    if (!muted && engine.state === "playing") Sfx.engineStart();
  }
  $("mute-btn").addEventListener("click", (e) => { e.stopPropagation(); toggleMute(); });

  // --- Resize --------------------------------------------------------------
  const onResize = () => renderer.resize();
  window.addEventListener("resize", onResize);
  window.addEventListener("orientationchange", onResize);

  // --- Helpers for particle positions in screen space ----------------------
  function playerScreen() {
    const pp = CONFIG.FOCAL / (CONFIG.FOCAL + CONFIG.PLAYER_Z);
    const x = CONFIG.WIDTH / 2 + engine.player.laneFrac * CONFIG.ROAD_HALF_NEAR * pp + renderer.camShift * (1 - pp);
    const y = CONFIG.HORIZON_Y + (CONFIG.HEIGHT - CONFIG.HORIZON_Y) * pp;
    return { x, y };
  }

  // --- React to engine events ---------------------------------------------
  function handleEvents(events) {
    for (const ev of events) {
      if (ev.type === "start") {
        Sfx.engineStart();
      } else if (ev.type === "steer") {
        Sfx.steer();
        const p = playerScreen();
        renderer.burst(p.x - ev.dir * 30, p.y, 7, "#d9d2c4", 90);
      } else if (ev.type === "score") {
        elHudScore.textContent = ev.value;
        if (ev.value % 5 === 0) Sfx.milestone(); else Sfx.pass();
      } else if (ev.type === "coin") {
        Shop.addCoins(CONFIG.COIN_VALUE);
        elHudCoins.textContent = engine.runCoins;
        Sfx.coin();
        const p = playerScreen();
        renderer.burst(p.x, p.y - 24, 8, "#ffe07a", 110);
      } else if (ev.type === "shieldhit") {
        Sfx.shield();
        const p = playerScreen();
        renderer.burst(p.x, p.y - 24, 22, "#86e1ff", 180);
      } else if (ev.type === "newbest") {
        sawNewBest = true;
        Shop.setBest(engine.best);
      } else if (ev.type === "crash") {
        Sfx.crash(); Sfx.engineStop();
        const p = playerScreen();
        renderer.burst(p.x, p.y - 30, 26, "#ff9d57", 220);
        deadAt = performance.now();
        // Guard against a restart slipping in before this fires.
        setTimeout(() => { if (engine.state === "dead" && ui === "playing") showOver(); }, 550);
      }
    }
  }

  // --- Game loop -----------------------------------------------------------
  let last = performance.now();
  function frame(now) {
    let dt = (now - last) / 1000; last = now;
    if (dt > 0.1) dt = 0.1;

    const events = engine.update(dt);
    handleEvents(events);
    renderer.render(engine, dt);

    if (engine.state === "playing") {
      const sp01 = (engine.speed - CONFIG.START_SPEED) / (CONFIG.MAX_SPEED - CONFIG.START_SPEED);
      Sfx.setEngine(Math.max(0, Math.min(1, sp01)));
      elHudSpeed.textContent = Math.round(engine.speed * CONFIG.KMH_PER_SPEED);
    }
    requestAnimationFrame(frame);
  }

  // --- Boot ----------------------------------------------------------------
  renderer.resize();
  showStart();
  requestAnimationFrame(frame);

  // Debug/inspection hook (handy for tuning and an automated test harness).
  window.ZippyGame = { engine, renderer, cfg: CONFIG, Shop, beginGame, steer, showShop, showStart };
})();
