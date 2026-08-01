/* =========================================================
   room.js — 房间模块
   相当于小程序的 pages/room：
   房间信息 / 玩家列表 / 排行榜 / 聊天 / 改名 / 标签切换
   ========================================================= */
(function () {
  "use strict";
  const G = window.Game;
  if (!G) return;
  if (!G.registers) G.registers = [];

  // ===== 房间视图更新（每个玩家收到自己的视图）=====
  G.registers.push((socket) => {
    socket.on("roomUpdate", (data) => {
      G.room = data;
      G.me = data.me;
      G.myId = socket.id;

      // 切换到房间视图
      G.ui.viewLobby.style.display = "none";
      G.ui.viewRoom.style.display = "flex";
      G.ui.goldDisplay.style.display = "inline-block";
      G.updateGold(G.me.gold);

      // 房间信息
      document.getElementById("roomIdText").textContent = G.room.roomId;
      document.getElementById("roomNameInput").value = G.room.name || "";
      document.getElementById("renameRoomBtn").style.display = data.isHost
        ? "inline-block"
        : "none";
      // 比赛类型：只有房主可改（下拉框），说明文字在下拉框的悬浮提示中
      G.selectedRaceType = data.raceType || G.selectedRaceType || "sprint";
      const raceSetup = document.getElementById("raceSetup");
      if (raceSetup) raceSetup.style.display = data.isHost ? "" : "none";
      const typeSel = document.getElementById("raceTypeSelect");
      if (typeSel) {
        typeSel.title = G.TYPE_DESC[G.selectedRaceType] || "";
        typeSel.value = G.selectedRaceType;
      }

      renderPlayerList();
      renderLeaderboard();
      renderChatHistory();
      G.renderDeer();
      G.renderShop();
      G.renderRacePanel();
    });

    // ===== 聊天 =====
    socket.on("chat", (msg) => {
      // 只追加到聊天栏，不弹 toast
      appendChatMsg(msg.who, msg.msg);
    });

    // ===== 全服聊天（高品质出租等全服公告）=====
    socket.on("globalChatHistory", (list) => {
      const box = document.getElementById("globalChatMsgs");
      if (box) box.innerHTML = "";
      (list || []).forEach((c) => appendGlobalChatMsg(c.msg));
    });
    socket.on("globalChat", (data) => {
      appendGlobalChatMsg(data && data.msg);
    });
  });

  // ===== 玩家列表 =====
  function renderPlayerList() {
    const list = document.getElementById("playerList");
    document.getElementById("playerCount").textContent = G.room.players.length;
    list.innerHTML = G.room.players
      .map(
        (p) => `
        <div class="player-row">
            <span class="crown">${p.isHost ? "👑" : ""}</span>
            <span style="font-weight:600;">${p.name}</span>
            ${
              p.id === G.myId
                ? '<span style="font-size:0.7em;color:var(--blue);">(我)</span>'
                : ""
            }
            <span style="font-size:0.75em;color:var(--muted);">${p.deerCount}只鹿</span>
            <span class="status ${p.ready ? "ready" : "waiting"}">
                ${p.ready ? "已准备" : "准备中"}
            </span>
        </div>
    `,
      )
      .join("");
  }

  // ===== 排行榜 =====
  function renderLeaderboard() {
    const box = document.getElementById("leaderboard");
    const lb = G.room.leaderboard || [];
    if (!lb.length) {
      box.innerHTML = '<div class="hint">暂无数据</div>';
      return;
    }
    box.innerHTML = lb
      .map((p, i) => {
        const isMe = p.id === G.myId;
        return `
        <div class="lb-row">
            <span class="lb-rank ${i < 3 ? "r" + (i + 1) : ""}">
                ${i < 3 ? ["🥇", "🥈", "🥉"][i] : i + 1}
            </span>
            <span style="font-weight:700;">${p.name}${isMe ? ' <span style="color:var(--blue);font-size:0.75em;">(我)</span>' : ""}</span>
            <span class="lb-wins">${p.wins || 0} 胜</span>
        </div>`;
      })
      .join("");
  }

  // ===== 聊天 =====
  function renderChatHistory() {
    const box = document.getElementById("chatMsgs");
    box.innerHTML = "";
    (G.room.chatHistory || []).forEach((c) => appendChatMsg(c.who, c.msg));
  }

  function appendChatMsg(who, msg) {
    const box = document.getElementById("chatMsgs");
    const d = document.createElement("div");
    d.className = "chat-msg" + (who ? "" : " system");
    if (who) {
      d.innerHTML = `<span class="who">${G.escapeHtml(who)}</span>${G.escapeHtml(msg)}`;
    } else {
      d.textContent = msg;
    }
    box.appendChild(d);
    box.scrollTop = box.scrollHeight;
  }

  // 全服公告消息（系统样式：金色居中；目前只有高品质出租广播，不开放全服发言）
  function appendGlobalChatMsg(msg) {
    if (!msg) return;
    const box = document.getElementById("globalChatMsgs");
    if (!box) return;
    const d = document.createElement("div");
    d.className = "chat-msg system";
    d.textContent = msg;
    box.appendChild(d);
    box.scrollTop = box.scrollHeight;
  }

  // 聊天频道切换（房间 / 通告）
  window.switchChatTab = (tab) => {
    const isRoom = tab === "room";
    document
      .querySelectorAll("#chatSidebar .chat-tabs .view-toggle-btn")
      .forEach((b) => {
        b.classList.toggle("active", b.dataset.chat === tab);
      });
    const roomMsgs = document.getElementById("chatMsgs");
    const globalMsgs = document.getElementById("globalChatMsgs");
    if (roomMsgs) roomMsgs.style.display = isRoom ? "" : "none";
    if (globalMsgs) globalMsgs.style.display = isRoom ? "none" : "";
    // 通告频道：禁用普通玩家输入与发送，仅服主（管理员）可发布
    const input = document.getElementById("chatInput");
    const sendBtn = document.getElementById("chatSendBtn");
    const canAnnounce = !!G.isAdmin;
    if (input) {
      input.disabled = isRoom ? false : !canAnnounce;
      input.placeholder = isRoom
        ? "说点什么..."
        : canAnnounce
          ? "输入要广播的全服通告..."
          : "通告频道 · 仅服主可发布";
    }
    if (sendBtn) {
      sendBtn.disabled = isRoom ? false : !canAnnounce;
      sendBtn.textContent = isRoom ? "发送" : "发布通告";
      sendBtn.className = "btn btn-sm " + (isRoom ? "btn-blue" : "btn-gold");
    }
  };

  window.sendChat = () => {
    const input = document.getElementById("chatInput");
    const msg = input.value.trim();
    if (!msg) return;
    // 通告频道（房主）→ 全服通告；房间频道 → 房间聊天
    const activeTab = document.querySelector(
      "#chatSidebar .chat-tabs .view-toggle-btn.active",
    );
    if (activeTab && activeTab.dataset.chat === "global") {
      G.socket.emit("announce", { msg });
    } else {
      G.socket.emit("chat", { msg });
    }
    input.value = "";
  };

  // ===== 改房间名 / 复制ID =====
  window.renameRoom = () => {
    const name = document.getElementById("roomNameInput").value.trim();
    if (!name) return G.showToast("请输入房间名");
    G.socket.emit("renameRoom", { name });
  };

  // ===== 退出房间（普通玩家或房主）=====
  window.leaveRoom = () => {
    if (!G.room) return;
    G.socket.emit("leaveRoom");
    // 立即回到大厅（本地重置，等待服务器确认；即使服务器无响应也不卡在房间）
    leaveRoomLocal();
  };

  function leaveRoomLocal() {
    G.room = null;
    G.me = null;
    G.countdownVal = null;
    G.stableSel = null;
    G.betPicks = []; // 清空投注已选
    if (
      G.stableView !== "card" &&
      typeof window.switchStableView === "function"
    ) {
      window.switchStableView("card"); // 停掉鹿圈动画
    }
    // 释放房间直播视图
    if (G.roomLive) {
      G.roomLive.dispose();
      G.roomLive = null;
    }
    G.ui.viewLobby.style.display = "block";
    G.ui.viewRoom.style.display = "none";
    G.ui.goldDisplay.style.display = "none";
    // 隐藏比赛轨道与投注面板
    G.ui.trackContainer.style.display = "none";
    G.ui.betPanel.style.display = "none";
    G.ui.betTimer.style.display = "none";
    G.showToast("已退出房间", "ok");
  }

  function bindStatic() {
    // 聊天输入框回车发送（IME 安全）
    G.bindEnter(document.getElementById("chatInput"), () => sendChat());
    // 房间名输入框回车改名
    G.bindEnter(document.getElementById("roomNameInput"), () => renameRoom());
    document.getElementById("roomIdBox").addEventListener("click", () => {
      if (!G.room) return;
      navigator.clipboard
        .writeText(G.room.roomId)
        .then(() => G.showToast(`已复制房间ID: ${G.room.roomId}`))
        .catch(() => G.showToast(`房间ID: ${G.room.roomId}`));
    });

    // 标签切换
    document.querySelectorAll(".tab-btn").forEach((b) => {
      b.addEventListener("click", () => {
        document
          .querySelectorAll(".tab-btn")
          .forEach((bt) => bt.classList.remove("active"));
        b.classList.add("active");
        Object.values(G.ui.panels).forEach((p) => (p.style.display = "none"));
        G.ui.panels[b.dataset.tab].style.display = "block";
        // 切到鹿舍继续鹿圈动画，离开则停止
        if (G.onTabChanged) G.onTabChanged(b.dataset.tab);
      });
    });

    // 聊天侧栏折叠
    const chatSidebar = document.getElementById("chatSidebar");
    const chatToggle = document.getElementById("chatToggle");
    if (chatToggle && chatSidebar) {
      chatToggle.addEventListener("click", () => {
        const collapsed = chatSidebar.classList.toggle("collapsed");
        chatToggle.textContent = collapsed ? "展开" : "收起";
      });
    }

    // 玩家/排行榜侧栏折叠（与聊天侧栏同款交互）
    const playerSidebar = document.getElementById("playerSidebar");
    const playerToggle = document.getElementById("playerToggle");
    if (playerToggle && playerSidebar) {
      playerToggle.addEventListener("click", () => {
        const collapsed = playerSidebar.classList.toggle("collapsed");
        playerToggle.textContent = collapsed ? "展开" : "收起";
      });
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bindStatic);
  } else {
    bindStatic();
  }
})();
