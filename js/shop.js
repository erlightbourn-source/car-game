/*
 * shop.js — Coin economy, persistence, and the Garage UI.
 *
 * Owns the player's save (coins, owned cars, equipped car, upgrade levels)
 * and renders the Garage screen. Kept separate from gameplay so the engine
 * stays pure and the persistence layer is easy to swap for UserDefaults on
 * iOS. Fires onChange() whenever the save mutates so the host can refresh
 * the car skin and on-screen labels.
 */
const Shop = (() => {
  const KEY = "zippy_save_v1";
  const DEFAULTS = { best: 0, coins: 0, owned: ["red"], car: "red", magnet: 0, shield: 0 };
  let data = { ...DEFAULTS };
  let mem = null;           // in-memory fallback if localStorage is unavailable
  let onChange = () => {};

  function load() {
    try {
      const raw = window.localStorage.getItem(KEY);
      data = raw ? { ...DEFAULTS, ...JSON.parse(raw) } : { ...DEFAULTS };
    } catch (e) {
      data = mem ? { ...mem } : { ...DEFAULTS };
    }
    if (!Array.isArray(data.owned) || data.owned.indexOf("red") < 0) data.owned = ["red"];
    return data;
  }
  function persist() {
    mem = { ...data };
    try { window.localStorage.setItem(KEY, JSON.stringify(data)); } catch (e) {}
  }

  function carById(id) { return CARS.find((c) => c.id === id) || CARS[0]; }
  function equippedColors() {
    const c = carById(data.car);
    return { body: c.body, roof: c.roof, bumper: c.bumper };
  }

  // ---- UI -----------------------------------------------------------------
  function renderGarage() {
    document.getElementById("shop-coins").textContent = data.coins;

    // Car colour swatches
    const row = document.getElementById("car-row");
    row.innerHTML = "";
    for (const car of CARS) {
      const owned = data.owned.indexOf(car.id) >= 0;
      const equipped = data.car === car.id;
      const el = document.createElement("button");
      el.className = "swatch" + (equipped ? " equipped" : "");
      el.style.background = car.body;
      el.innerHTML =
        `<span class="swatch-name">${car.name}</span>` +
        `<span class="swatch-tag">${equipped ? "Driving" : owned ? "Equip" : "🪙 " + car.price}</span>`;
      if (!owned && data.coins < car.price) el.classList.add("locked");
      el.addEventListener("click", () => {
        if (data.car === car.id) return;
        if (owned) {
          data.car = car.id;
        } else if (data.coins >= car.price) {
          data.coins -= car.price;
          data.owned.push(car.id);
          data.car = car.id;
          Sfx.coin();
        } else {
          return; // not enough coins
        }
        persist(); onChange(); renderGarage();
      });
      row.appendChild(el);
    }

    renderUpgrade("upg-magnet", "🧲 Coin Magnet", "magnet", CONFIG.MAGNET_PRICES,
      "Pulls in coins from nearby lanes");
    renderUpgrade("upg-shield", "🛡️ Shield", "shield", CONFIG.SHIELD_PRICES,
      "Absorbs a crash so you keep driving");
  }

  function renderUpgrade(elId, label, key, prices, desc) {
    const maxLevel = prices.length - 1;
    const level = data[key] | 0;
    const next = level + 1;
    const el = document.getElementById(elId);
    let dots = "";
    for (let i = 1; i <= maxLevel; i++) dots += `<span class="dot ${i <= level ? "on" : ""}"></span>`;

    let btn;
    if (level >= maxLevel) {
      btn = `<span class="upg-max">MAX</span>`;
    } else {
      const price = prices[next];
      const afford = data.coins >= price;
      btn = `<button class="upg-buy${afford ? "" : " locked"}">🪙 ${price}</button>`;
    }
    el.innerHTML =
      `<div class="upg-info"><div class="upg-name">${label}</div>` +
      `<div class="upg-desc">${desc}</div><div class="dots">${dots}</div></div>` +
      `<div class="upg-action">${btn}</div>`;

    const buy = el.querySelector(".upg-buy");
    if (buy) buy.addEventListener("click", () => {
      const price = prices[next];
      if (level >= maxLevel || data.coins < price) return;
      data.coins -= price;
      data[key] = next;
      Sfx.coin();
      persist(); onChange(); renderGarage();
    });
  }

  return {
    init(opts) { onChange = (opts && opts.onChange) || (() => {}); load(); },
    get coins() { return data.coins; },
    get best() { return data.best; },
    get upgrades() { return { magnet: data.magnet | 0, shield: data.shield | 0 }; },
    equippedColors,
    addCoins(n) { data.coins += n; persist(); onChange(); },
    setBest(v) { if (v > data.best) { data.best = v; persist(); onChange(); } },
    renderGarage,
  };
})();
