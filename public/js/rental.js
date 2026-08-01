/* =========================================================
   rental.js — 出租市场模块（房间商店内的"出租市场"子视图）
   保底机制：挂出鹿出租给 AI 或玩家，每场比赛赚租金，防止金币归零
   - 只有查验过的鹿才能挂出（服务器校验）
   - 市场是全服共享池：自己的鹿置顶显示（可收回），别人的鹿可租用
   - 市场里的鹿都是查验过的，租用后可参赛，比赛结束自动归还
   ========================================================= */
(function () {
  "use strict";
  const G = window.Game;
  if (!G) return;
  if (!G.registers) G.registers = [];

  // 服务器广播市场快照（挂出/收回/租用/归还/租金入账都会触发）
  G.registers.push((socket) => {
    socket.on("rentalMarketUpdate", (data) => {
      G.rentalMarket = (data && data.items) || [];
      // 房间内：刷新商店出租视图 + 鹿舍（大厅不渲染市场，只有房间内可租用/收回）
      if (G.room) {
        if (typeof G.renderShop === "function") G.renderShop();
        if (typeof G.renderDeer === "function") G.renderDeer();
      }
    });
  });

  // 租用市场里的鹿（一场；比赛结束自动归还；一次只租一只）
  window.rentDeer = (marketId) => {
    if (!G.room) return G.showToast("租用需要先进入房间");
    if (G.me && G.me.deers.some((d) => d.rented))
      return G.showToast("一次只能租用一只鹿", "err");
    G.socket.emit("rentDeer", { marketId });
  };
})();
