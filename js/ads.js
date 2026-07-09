/*
 * ads.js — Rewarded-ad manager for Lane Rush (hybrid-casual monetization).
 *
 * ONE opt-in reward: "double your coins" on the game-over screen. The player
 * CHOOSES to watch; nothing is forced and gameplay is never gated behind an ad.
 * Rewarded video is the least-intrusive, highest-eCPM hybrid-casual pattern.
 *
 * ── PROVIDER SEAM: going live with a real ad network ─────────────────────────
 * A provider implements two methods:
 *     isReady()                -> boolean   (an ad is loaded and ready to show)
 *     show(onReward, onClose)  -> void      (play it; call onReward ONLY when the
 *                                            user watched to completion, else
 *                                            call onClose on skip/forfeit/error)
 * Register it in PROVIDERS, set CONFIG.ADS_PROVIDER to its key, then:
 *   1. add the network's <script> to index.html,
 *   2. add the network's domain to the CSP (<meta> in index.html + _headers),
 *   3. ⚠ Lane Rush is played by young children — any real network MUST run in
 *      child-directed / non-personalized mode (COPPA + Google Play Families):
 *      no behavioral targeting, set tagForChildDirectedTreatment, use a certified
 *      Families ad SDK, and get legal sign-off. Do NOT ship a real network here
 *      without that. The simulated provider below is a DEV placeholder, not a
 *      certified ad — do not present it to live child users as a real ad.
 *
 * The built-in "simulated" provider is CSP-safe (pure in-page DOM, no external
 * request, zero data collection), so the whole reward flow ships and is testable
 * today with no third-party exposure. It is the safe default.
 */
(function () {
  "use strict";

  var cfg = { enabled: false, provider: "simulated", duration: 4 };
  var showing = false;   // manager-level: is a rewarded ad currently on screen?

  // ── Simulated rewarded provider: an in-page overlay, no network ────────────
  var Simulated = {
    _busy: false,
    isReady: function () { return !this._busy; },
    show: function (onReward, onClose) {
      if (this._busy) { if (onClose) onClose(); return; }
      this._busy = true;
      var self = this;
      var secs = Math.max(1, cfg.duration | 0);
      var done = false;

      var ov = document.createElement("div");
      ov.className = "ad-overlay";
      ov.setAttribute("role", "dialog");
      ov.setAttribute("aria-modal", "true");
      ov.setAttribute("aria-label", "Rewarded ad — watch to double your coins");
      ov.innerHTML =
        '<div class="ad-card">' +
          '<span class="ad-flag">Ad · demo</span>' +
          '<button class="ad-close" aria-label="Close ad, no reward">✕</button>' +
          '<div class="ad-art">🎬</div>' +
          '<div class="ad-title">Rewarded Ad (demo)</div>' +
          '<div class="ad-sub">Watch to double your coins</div>' +
          '<div class="ad-bar"><div class="ad-bar-fill"></div></div>' +
          '<div class="ad-count">Reward in <span class="ad-secs">' + secs + '</span>s</div>' +
        '</div>';
      // Keep taps inside the overlay from bubbling to the game-over screen
      // (which would otherwise start a new run). Keyboard is gated separately
      // by the game (Ads.isShowing) plus the Escape handler below.
      ov.addEventListener("pointerdown", function (e) { e.stopPropagation(); });
      ov.addEventListener("click", function (e) { e.stopPropagation(); });
      document.body.appendChild(ov);

      var fill = ov.querySelector(".ad-bar-fill");
      var secsEl = ov.querySelector(".ad-secs");
      var closeBtn = ov.querySelector(".ad-close");

      // Escape forfeits (no reward). Capture-phase so it wins regardless of the
      // game's own key handlers, which are gated off while an ad is showing.
      function onKey(e) { if (e.key === "Escape" || e.code === "Escape") { e.stopPropagation(); e.preventDefault(); forfeit(); } }
      document.addEventListener("keydown", onKey, true);

      function cleanup() {
        clearInterval(timer);
        document.removeEventListener("keydown", onKey, true);
        if (ov.parentNode) ov.parentNode.removeChild(ov);
        self._busy = false;
      }
      function finishReward() { if (done) return; done = true; cleanup(); if (onReward) onReward(); }
      function forfeit() { if (done) return; done = true; cleanup(); if (onClose) onClose(); }
      closeBtn.addEventListener("click", forfeit);
      // Move focus into the modal so keyboard users land on the dismiss control.
      try { closeBtn.focus(); } catch (e) {}

      // Animate the progress bar to full over the whole duration.
      requestAnimationFrame(function () {
        fill.style.transition = "width " + secs + "s linear";
        fill.style.width = "100%";
      });
      var left = secs;
      var timer = setInterval(function () {
        left -= 1;
        if (secsEl) secsEl.textContent = Math.max(0, left);
        if (left <= 0) finishReward();
      }, 1000);
    }
  };

  var PROVIDERS = { simulated: Simulated };

  window.Ads = {
    init: function (options) {
      options = options || {};
      cfg.enabled = !!options.enabled;
      cfg.provider = options.provider || "simulated";
      if (options.duration) cfg.duration = options.duration | 0;
      if (!PROVIDERS[cfg.provider]) cfg.provider = "simulated";   // fail safe
    },
    isRewardedReady: function () {
      var p = PROVIDERS[cfg.provider];
      return cfg.enabled && !!p && p.isReady();
    },
    // True while a rewarded ad is on screen — the game gates its input on this so
    // a keypress/tap can't start a run behind the overlay.
    isShowing: function () { return showing; },
    // onReward fires ONLY on full completion; onClose on skip / forfeit / when no
    // ad is available. Callers must credit the reward from onReward only.
    showRewarded: function (onReward, onClose) {
      var p = PROVIDERS[cfg.provider];
      if (!cfg.enabled || !p || !p.isReady()) { if (onClose) onClose(); return; }
      showing = true;
      p.show(
        function () { showing = false; if (onReward) onReward(); },
        function () { showing = false; if (onClose) onClose(); }
      );
    }
  };
})();
