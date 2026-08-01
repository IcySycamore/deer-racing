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
    G.socket.emit("createRoom", {
      playerName: name,
      roomName,
      username: G.accUser || undefined,
      password: G.accPass || undefined,
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
})();
