/* =========================================================
   hero.js — 大厅品牌栏全服直播
   任意房间的比赛开始后，品牌栏自动播放其中一场：
   - 右下角显示房间名，左上角显示"全服直播"
   - 右上角无视角控件，视角每 4 秒自动轮换（全局 ↔ 随机跟随一只鹿）
   - 没有比赛时显示原品牌内容
   ========================================================= */
(function () {
  "use strict";
  const G = window.Game;
  if (!G) return;
  if (!G.registers) G.registers = [];

  // 进行中比赛的池子：roomId -> worldRaceStart 数据
  const pool = {};
  const hero = {
    view: null, // LiveView.create 实例
    roomId: null,
    roomName: "",
  };

  function showBrand() {
    const brand = document.getElementById("heroBrand");
    const live = document.getElementById("heroLive");
    if (brand) brand.style.display = "";
    if (live) live.style.display = "none";
  }

  function showLive() {
    const brand = document.getElementById("heroBrand");
    const live = document.getElementById("heroLive");
    if (brand) brand.style.display = "none";
    if (live) live.style.display = "";
  }

  function clearView() {
    if (hero.view) {
      hero.view.dispose();
      hero.view = null;
    }
    hero.roomId = null;
    hero.roomName = "";
  }

  // 从池中随机挑一场播放
  function pickRandom() {
    const ids = Object.keys(pool);
    if (!ids.length) return null;
    return pool[ids[Math.floor(Math.random() * ids.length)]];
  }

  function activate(data) {
    clearView();
    hero.roomId = data.roomId;
    hero.roomName = data.roomName || data.roomId;
    const tag = document.getElementById("heroRoomTag");
    if (tag) tag.textContent = "🏁 " + hero.roomName;
    hero.view = LiveView.create({
      surface: document.getElementById("heroSurface"),
      container: document.getElementById("heroLiveContainer"),
      controls: false,
      autoRotate: true,
      rotateMs: 4000,
    });
    hero.view.setRace(data);
    showLive();
  }

  G.registers.push((socket) => {
    // 全服新比赛开始（投注阶段）
    socket.on("worldRaceStart", (data) => {
      if (!data || !data.roomId || !data.racers || !data.racers.length) return;
      pool[data.roomId] = data;
      // 当前没有在播任何比赛时，随机挑一场播放
      if (!hero.view) {
        const next = pickRandom();
        if (next) activate(next);
      }
    });

    socket.on("racePositions", (data) => {
      if (!hero.view || data.roomId !== hero.roomId) return;
      hero.view.setPositions(data.positions);
    });

    socket.on("raceEvent", (ev) => {
      if (!hero.view || ev.roomId !== hero.roomId) return;
      hero.view.playEvent(ev);
    });

    // 比赛结束：移除池子，若正在播这场则切到下一场或恢复品牌栏
    socket.on("raceResult", (result) => {
      delete pool[result.roomId];
      if (hero.roomId === result.roomId) {
        clearView();
        const next = pickRandom();
        if (next) activate(next);
        else showBrand();
      }
    });

    // 房间中途销毁（全员退出）：比赛未正常结束，移除这场直播
    socket.on("raceCanceled", (data) => {
      if (!data || !data.roomId) return;
      delete pool[data.roomId];
      if (hero.roomId === data.roomId) {
        clearView();
        const next = pickRandom();
        if (next) activate(next);
        else showBrand();
      }
    });
  });
})();
