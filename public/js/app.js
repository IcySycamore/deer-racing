/* =========================================================
   app.js — 全局状态 / Socket 连接 / 工具函数
   类似小程序 app.js：负责生命周期与公共能力
   ========================================================= */
(function () {
  "use strict";

  // 全局状态（相当于小程序的 globalData）
  window.Game = {
    socket: null,
    myId: null,
    room: null, // 公开视图
    me: null, // 个人视图
    selectedRaceType: "sprint",
    betType: "win", // 投注类型: win/place/quinella/trifecta
    betPicks: [], // 当前投注已选鹿 id
    countdownVal: null,
    rentalMarket: [], // 出租市场快照（服务器广播更新）
    // UI 元素缓存（相当于小程序里的页面实例）
    ui: {},
  };

  const G = window.Game;

  // ===== 工具函数 =====
  // showToast(msg, type)：type 可选 "ok"(绿) / "err"(红，默认)，都复用悬浮提示样式
  G.showToast = function (msg, type) {
    const t = document.createElement("div");
    t.className =
      "error-toast" + (type === "ok" ? " ok" : type === "err" ? " err" : "");
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 3000);
  };

  // IME 安全的回车绑定：输入法组词过程中按回车不会误触发
  G.bindEnter = function (el, fn) {
    if (!el || typeof fn !== "function") return;
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.isComposing && e.keyCode !== 229) {
        e.preventDefault();
        fn();
      }
    });
  };

  G.escapeHtml = function (s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  };

  G.updateGold = function (g) {
    G.ui.goldAmt.textContent = g;
  };

  // ===== 初始化 UI 缓存 =====
  G.initUI = function () {
    G.ui.goldAmt = document.getElementById("goldAmt");
    G.ui.goldDisplay = document.getElementById("goldDisplay");
    G.ui.viewLobby = document.getElementById("view-lobby");
    G.ui.viewRoom = document.getElementById("view-room");
    G.ui.panels = {
      deer: document.getElementById("panel-deer"),
      shop: document.getElementById("panel-shop"),
      race: document.getElementById("panel-race"),
    };
    G.ui.trackContainer = document.getElementById("trackContainer");
    G.ui.betPanel = document.getElementById("betPanel");
    G.ui.trackSurface = document.getElementById("trackSurface");
    G.ui.betTimer = document.getElementById("betTimer");
    G.ui.betTimerNum = document.getElementById("betTimerNum");
    // 初始倒计时与共享配置一致（服务器广播会实时覆盖）
    if (G.ui.betTimerNum && window.GameConfig) {
      G.ui.betTimerNum.textContent = GameConfig.BET_COUNTDOWN;
    }
  };

  // ===== 连接 =====
  G.connect = function () {
    const socket = io();
    G.socket = socket;

    socket.on("connect", () => {
      G.myId = socket.id;
      // 完整显示 ID（20位），点击可复制
      const el = document.getElementById("myPlayerId");
      el.textContent = socket.id;
      el.title = "点击复制我的ID";
    });

    socket.on("disconnect", () => {
      G.showToast("⚠️ 与服务器断开连接");
    });

    socket.on("error", (msg) => G.showToast(msg));

    // 各模块注册自己的事件监听
    if (G.registers) {
      G.registers.forEach((fn) => fn(socket));
    }
  };
})();
