/* =========================================================
   lobby.js — 大厅模块
   创建房间 / 加入房间（模态框）/ 复制ID
   ========================================================= */
(function () {
  "use strict";
  const G = window.Game;
  if (!G) return;

  // ===== 复制我的ID =====
  window.copyMyId = () => {
    const id = document.getElementById("myPlayerId").textContent;
    if (!id || id === "-") return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(id).then(
        () => G.showToast("ID 已复制"),
        () => fallbackCopy(id),
      );
    } else {
      fallbackCopy(id);
    }
  };

  function fallbackCopy(text) {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand("copy");
      G.showToast("ID 已复制");
    } catch (e) {
      G.showToast("复制失败，请手动复制");
    }
    ta.remove();
  }

  // ===== 保存名字（资料弹窗内） =====
  window.saveName = () => {
    const name = document.getElementById("playerName").value.trim();
    if (!name) return G.showToast("请输入昵称");
    G.socket.emit("rename", { name });
    // 本地更新账号昵称并刷新右上角（大厅改名时无 roomUpdate 回调）
    if (G.account) G.account.name = name;
    G.showToast(`昵称已保存: ${name}`);
    if (window.refreshAuthArea) window.refreshAuthArea();
    closeModal("modalProfile");
  };

  // ===== 大厅两大栏按钮 =====
  window.openCreateRoom = () => {
    document.getElementById("newRoomName").value = "";
    document.getElementById("newRoomMaxPlayers").value = "6";
    document.getElementById("newRoomIsPublic").checked = true;
    openModal("modalCreate");
  };
  window.openJoinRoom = () => {
    document.getElementById("roomIdInput").value = "";
    openModal("modalJoin");
  };

  // ===== 创建房间 =====
  window.createRoom = () => {
    // 已登录：优先用账号昵称（输入框只作未登录时的游客昵称）
    const name =
      (G.account && G.account.name) ||
      document.getElementById("playerName").value.trim() ||
      "鹿主";
    const roomName = document.getElementById("newRoomName").value.trim();
    const maxPlayers = Number(
      document.getElementById("newRoomMaxPlayers").value,
    );
    const isPublic = document.getElementById("newRoomIsPublic").checked;
    G.socket.emit("createRoom", {
      playerName: name,
      roomName,
      username: G.accUser || undefined,
      password: G.accPass || undefined,
      maxPlayers,
      isPublic,
    });
    closeModal("modalCreate");
  };

  // ===== 加入房间 =====
  window.joinRoom = () => {
    const roomId = document.getElementById("roomIdInput").value.trim();
    if (!roomId) return G.showToast("请输入房间ID");
    // 已登录：优先用账号昵称
    const name =
      (G.account && G.account.name) ||
      document.getElementById("playerName").value.trim() ||
      "鹿友";
    G.socket.emit("joinRoom", {
      roomId,
      playerName: name,
      username: G.accUser || undefined,
      password: G.accPass || undefined,
    });
    closeModal("modalJoin");
  };

  // 创建/加入房间输入框回车提交（IME 安全）
  G.bindEnter(document.getElementById("newRoomName"), () => createRoom());
  G.bindEnter(document.getElementById("roomIdInput"), () => joinRoom());

  // ===== 公开房间列表（大厅） =====
  let roomListData = [];
  G.registers.push((socket) => {
    socket.on("roomList", (data) => {
      roomListData = (data && data.rooms) || [];
      renderRoomList();
    });
  });

  // 渲染房间列表，支持按房间名 / 房主 / 房间号 搜索过滤
  window.renderRoomList = () => {
    const body = document.getElementById("roomListBody");
    if (!body) return;
    const q = (document.getElementById("roomListSearch").value || "")
      .trim()
      .toLowerCase();
    const rooms = roomListData.filter(
      (r) =>
        !q ||
        (r.name || "").toLowerCase().includes(q) ||
        (r.hostName || "").toLowerCase().includes(q) ||
        (r.roomId || "").toLowerCase().includes(q),
    );
    if (!rooms.length) {
      body.innerHTML = `<div class="roomlist-empty">${
        q ? "没有匹配的房间" : "暂无公开房间，点击上方「创建房间」开始"
      }</div>`;
      return;
    }
    body.innerHTML = rooms
      .map((r) => {
        const racing = r.status === "racing";
        const full = r.playerCount >= r.maxPlayers;
        return `<div class="roomlist-item">
          <div class="roomlist-info">
            <span class="roomlist-name">${esc(r.name)}</span>
            <span class="roomlist-meta">
              ${esc(r.roomId)} · 房主 ${esc(r.hostName)} · ${
                r.playerCount
              }/${r.maxPlayers} 人 · ${raceTypeLabel(r.raceType)}
            </span>
          </div>
          <div class="roomlist-side">
            ${racing ? '<span class="roomlist-status racing">比赛中</span>' : ""}
            <button class="btn btn-sm" ${
              full ? "disabled" : ""
            } onclick="joinRoomById('${esc(r.roomId)}')">
              ${full ? "已满" : "加入"}
            </button>
          </div>
        </div>`;
      })
      .join("");
  };

  // 从房间列表一键加入
  window.joinRoomById = (roomId) => {
    const name =
      (G.account && G.account.name) ||
      document.getElementById("playerName").value.trim() ||
      "鹿友";
    G.socket.emit("joinRoom", {
      roomId,
      playerName: name,
      username: G.accUser || undefined,
      password: G.accPass || undefined,
    });
  };

  // 比赛类型中文标签
  const RACE_LABELS = {
    sprint: "短距赛",
    endurance: "耐力赛",
    obstacle: "障碍赛",
  };
  function raceTypeLabel(t) {
    return RACE_LABELS[t] || "短距赛";
  }
  // 简单转义防注入
  function esc(s) {
    return String(s == null ? "" : s).replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );
  }
})();
