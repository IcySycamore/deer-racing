/* =========================================================
   account.js — 账号模块（右上角登录/注册/资料）
   登录/注册弹窗、资料查看修改、退出登录
   ========================================================= */
(function () {
  "use strict";
  const G = window.Game;
  if (!G) return;
  if (!G.registers) G.registers = [];

  // 记录当前登录的账号凭据，创建/加入房间时带上
  G.accUser = "";
  G.accPass = "";
  G.account = null; // { username, gold, wins }
  // 当前认证模式: login / register
  G.authMode = "login";

  // ===== 模态框工具 =====
  window.openModal = (id) => {
    const m = document.getElementById(id);
    if (m) {
      m.style.display = "flex";
      const input = m.querySelector("input");
      if (input) setTimeout(() => input.focus(), 60);
    }
  };
  window.closeModal = (id) => {
    const m = document.getElementById(id);
    if (m) m.style.display = "none";
  };
  window.closeModalOnMask = (e, id) => {
    if (e.target === e.currentTarget) closeModal(id);
  };

  // ===== 认证弹窗 =====
  window.openAuth = (mode) => {
    setAuthMode(mode || "login");
    // 登录模式：保留浏览器密码保存器自动填充的用户名/密码（不清空）；
    // 注册模式：清空避免残留上次输入
    if (mode === "register") {
      const user = document.getElementById("accUser");
      const pass = document.getElementById("accPass");
      if (user) user.value = "";
      if (pass) pass.value = "";
    } else {
      // 登录模式：用凭证管理器拉取已保存的账号密码并预填，
      // 让密码管理器的自动填充真正生效（弹窗内不再手动输）
      G.autofillSavedCredentials();
      // 浏览器可能在离屏表单上异步自动填充，稍后镜像回弹窗
      setTimeout(syncFromOffscreenForm, 300);
    }
    openModal("modalAuth");
  };

  // 用 Credential Management API 拉取已保存密码并预填登录表单。
  // 浏览器只在 HTTPS / localhost 下允许；失败或用户拒绝时静默忽略。
  G.autofillSavedCredentials = function () {
    try {
      if (
        !window.PasswordCredential ||
        !navigator.credentials ||
        !navigator.credentials.get
      )
        return;
      navigator.credentials
        .get({ password: true })
        .then((cred) => {
          if (!cred || !cred.id) return;
          // 写入离屏表单（浏览器密码管理器识别的字段）
          const pmUser = document.getElementById("pmUsername");
          const pmPass = document.getElementById("pmPassword");
          if (pmUser) pmUser.value = cred.id;
          if (pmPass) pmPass.value = cred.password || "";
          // 离屏表单 → 弹窗输入框 镜像回填
          syncFromOffscreenForm();
        })
        .catch(() => {});
    } catch (e) {
      /* 浏览器不支持，忽略 */
    }
  };

  // 离屏表单 → 弹窗输入框 镜像（浏览器自动填充落到离屏表单后回填弹窗）
  function syncFromOffscreenForm() {
    const pmUser = document.getElementById("pmUsername");
    const pmPass = document.getElementById("pmPassword");
    const user = document.getElementById("accUser");
    const pass = document.getElementById("accPass");
    if (pmUser && pmUser.value && user && !user.value)
      user.value = pmUser.value;
    if (pmPass && pmPass.value && pass && !pass.value)
      pass.value = pmPass.value;
  }

  // 弹窗输入框 → 离屏表单 镜像（用户手动输入时同步给密码管理器字段，
  // 提交时浏览器能正确关联账号密码并提示保存）
  function syncToOffscreenForm() {
    const pmUser = document.getElementById("pmUsername");
    const pmPass = document.getElementById("pmPassword");
    const user = document.getElementById("accUser");
    const pass = document.getElementById("accPass");
    if (pmUser && user) pmUser.value = user.value;
    if (pmPass && pass) pmPass.value = pass.value;
  }

  // 绑定弹窗输入框实时同步到离屏表单
  function bindOffscreenSync() {
    const user = document.getElementById("accUser");
    const pass = document.getElementById("accPass");
    if (user) user.addEventListener("input", syncToOffscreenForm);
    if (pass) pass.addEventListener("input", syncToOffscreenForm);
  }
  bindOffscreenSync();

  window.setAuthMode = (mode) => {
    G.authMode = mode;
    const loginTab = document.getElementById("authTabLogin");
    const regTab = document.getElementById("authTabRegister");
    const submit = document.getElementById("authSubmit");
    const title = document.getElementById("authModalTitle");
    if (loginTab) loginTab.classList.toggle("active", mode === "login");
    if (regTab) regTab.classList.toggle("active", mode === "register");
    if (submit) submit.textContent = mode === "login" ? "登录" : "注册账号";
    if (title) title.textContent = mode === "login" ? "欢迎回来" : "注册新账号";
    // 密码保存器：登录用 current-password，注册用 new-password
    const pass = document.getElementById("accPass");
    if (pass) {
      pass.autocomplete =
        mode === "login" ? "current-password" : "new-password";
    }
    const form = document.getElementById("authForm");
    if (form) form.setAttribute("autocomplete", "on");
  };

  // ===== 登录 / 注册 =====
  window.doAuth = () => {
    if (G.authMode === "login") doLogin();
    else doRegister();
  };

  window.doLogin = () => {
    const username = document.getElementById("accUser").value.trim();
    const password = document.getElementById("accPass").value;
    if (!username || !password) return G.showToast("请输入用户名和密码");
    G.socket.emit("login", { username, password });
  };

  window.doRegister = () => {
    const username = document.getElementById("accUser").value.trim();
    const password = document.getElementById("accPass").value;
    if (!username || !password) return G.showToast("请输入用户名和密码");
    G.socket.emit("register", { username, password });
  };

  // 登录/注册输入框回车提交（IME 安全）
  G.bindEnter(document.getElementById("accUser"), () => doAuth());
  G.bindEnter(document.getElementById("accPass"), () => doAuth());
  // 资料弹窗改昵称输入框回车保存
  G.bindEnter(document.getElementById("playerName"), () => saveName());

  // ===== 修改密码 =====
  window.changePassword = () => {
    const oldP = document.getElementById("oldPassInput").value || "";
    const newP = document.getElementById("newPassInput").value || "";
    if (!oldP) return G.showToast("请输入当前密码");
    if (newP.length < 4) return G.showToast("新密码至少4位");
    G.socket.emit("changePassword", { oldPassword: oldP, newPassword: newP });
  };

  // ===== 资料弹窗 =====
  window.openProfile = () => {
    const acc = G.account;
    document.getElementById("profileUser").textContent = acc
      ? acc.name || acc.username
      : "-";
    document.getElementById("profileGold").textContent = acc ? acc.gold : "0";
    document.getElementById("profileWins").textContent = acc ? acc.wins : "0";
    // 昵称输入框预填当前昵称
    const nameInput = document.getElementById("playerName");
    if (nameInput) nameInput.value = acc ? acc.name || acc.username : "";
    openModal("modalProfile");
  };

  // ===== 退出登录 =====
  window.doLogout = () => {
    G.account = null;
    G.isAdmin = false;
    G.accUser = "";
    G.accPass = "";
    renderAuthArea();
    closeModal("modalProfile");
    G.showToast("已退出登录");
  };

  // ===== 更新右上角入口 =====
  window.refreshAuthArea = renderAuthArea; // 供 lobby.js 等外部刷新右上角
  function renderAuthArea() {
    const loginBtn = document.getElementById("btnLogin");
    const regBtn = document.getElementById("btnRegister");
    const userBtn = document.getElementById("btnUser");
    const nameText = document.getElementById("userNameText");
    if (G.account) {
      if (loginBtn) loginBtn.style.display = "none";
      if (regBtn) regBtn.style.display = "none";
      if (userBtn) {
        userBtn.style.display = "inline-flex";
        if (nameText)
          nameText.textContent = G.account.name || G.account.username;
      }
    } else {
      if (loginBtn) loginBtn.style.display = "";
      if (regBtn) regBtn.style.display = "";
      if (userBtn) userBtn.style.display = "none";
    }
  }

  G.registers.push((socket) => {
    socket.on("accountInfo", (r) => {
      const typedUser = (document.getElementById("accUser").value || "").trim();
      const authOpen =
        document.getElementById("modalAuth").style.display === "flex";
      if (r.ok) {
        const wasRegister = G.authMode === "register" && authOpen;
        G.accUser = typedUser || G.accUser;
        G.accPass = document.getElementById("accPass").value || G.accPass;
        G.account = r.account;
        G.isAdmin = !!r.isAdmin; // 服主（服务器管理员）身份
        renderAuthArea();
        closeModal("modalAuth");
        // 登录成功：调用浏览器凭证管理器，弹出"保存密码"提示
        // （SPA 无页面跳转，浏览器不会自动触发，需显式 store）
        if (!wasRegister && G.accUser && G.accPass) {
          try {
            if (window.PasswordCredential) {
              const cred = new window.PasswordCredential({
                id: G.accUser,
                password: G.accPass,
                name: G.account.name || G.accUser,
              });
              navigator.credentials.store(cred).catch(() => {});
            }
          } catch (e) {
            /* 浏览器不支持或用户拒绝，静默忽略 */
          }
        }
        // 注册成功：直接进入登录状态并打开资料页（可立即改昵称）
        if (wasRegister) {
          G.showToast(
            `🎉 注册成功，欢迎 ${r.account.name || r.account.username}`,
            "ok",
          );
          openProfile();
        } else if (authOpen) {
          G.showToast(`✅ 账号 ${r.account.username} 登录成功`, "ok");
        }
      } else {
        G.accUser = "";
        G.accPass = "";
        // 用悬浮提示显示错误（与服务器断开连接同款样式）
        G.showToast("⚠️ " + (r.msg || "账号操作失败"), "err");
      }
    });

    // 房间视图更新时刷新右上角（金币等）；me.account 是账号用户名（字符串）
    socket.on("roomUpdate", (data) => {
      if (G.account && data.me && data.me.account) {
        G.account = {
          ...G.account,
          name: data.me.name || G.account.name,
          gold: data.me.gold,
          wins: data.me.wins || 0,
        };
        renderAuthArea();
      }
    });

    // 修改密码结果
    socket.on("changePasswordResult", (r) => {
      if (r.ok) {
        // 成功后更新缓存的密码（避免下次进入房间用旧密码登录失败）
        G.accPass = document.getElementById("newPassInput").value || G.accPass;
        document.getElementById("oldPassInput").value = "";
        document.getElementById("newPassInput").value = "";
        G.showToast("✅ " + (r.msg || "密码修改成功"), "ok");
      } else {
        G.showToast("⚠️ " + (r.msg || "修改失败"), "err");
      }
    });
  });
})();
