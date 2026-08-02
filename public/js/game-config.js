/* =========================================================
   game-config.js — 配置门面（GameConfig）
   合并 game-values.js（数值）+ game-formulas.js（公式）为单一 GameConfig，
   保持旧接口（GameConfig.LANES / trackScale / trainCost / rollTrick ...）
   以最小侵入兼容历史代码。
   Node 端：require("./public/js/game-config.js")
   浏览器端：<script src="/js/game-config.js"> 得到 window.GameConfig
   ========================================================= */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.GameConfig = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // 浏览器端的全局对象（供取值用，替代外部 IIFE 的 root）
  const R =
    typeof self !== "undefined"
      ? self
      : typeof global !== "undefined"
        ? global
        : this;

  let V, F;
  if (typeof module === "object" && module.exports) {
    V = require("./game-values.js");
    F = require("./game-formulas.js");
  } else {
    V = R.GameValues || {};
    F = R.GameFormulas || {};
  }

  // 合并：数值直接平铺，公式函数挂到对象上
  const GameConfig = Object.assign({}, V);
  GameConfig.GameValues = V;
  GameConfig.GameFormulas = F;
  for (const k of Object.keys(F)) {
    if (typeof F[k] === "function") GameConfig[k] = F[k];
  }

  // ---- 兼容旧字段（历史代码直接引用这些成员）----
  GameConfig.LANES = V.LANE.default;
  GameConfig.RACE_TYPES = V.RACE_TYPES;
  GameConfig.RENDER_OFFSET = V.RENDER_OFFSET;
  GameConfig.JUDGE_X = V.JUDGE_X;
  GameConfig.TRACK_LEN = V.FLAT_TRACK.default;
  // 兼容旧 trackScale(v)：无长度参数时用默认赛道长（有长度则透传）
  GameConfig.trackScale = function (v, len) {
    return F.trackScale(v, len || V.FLAT_TRACK.default);
  };

  return GameConfig;
});
