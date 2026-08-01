/* =========================================================
   deer-card.js — 通用鹿卡片容器 & 通用图鉴
   供鹿舍 / 商店 / 出租市场等不同视角复用，避免重复模板。

   卡片容器固定区块顺序：
    头像 → 名字 → 描述 → [查验信息] → [徽章] → [价值 + 文字按钮]

   视角（G.DEER_VIEW）：
     STABLE            鹿舍 · 选参赛鹿（显示训练次数）
     OWNER_UNINSPECTED 查验前出租者 · 自己的鹿未查验（未知 + 查验按钮）
     OWNER_INSPECTED   查验后出租者 · 自己的鹿已查验（星级 + 出租按钮）
     RENTER            借用者 · 市场里租别人的鹿（星级 + 租用按钮）
     SHOP              购买者 · 商店货架（售价 + 购买按钮）
   ========================================================= */
(function () {
  "use strict";
  const G = window.Game;
  if (!G) return;

  // 星级文本（上限 10 星）
  G.starText =
    G.starText ||
    function (n) {
      return "★".repeat(n) + "☆".repeat(10 - n);
    };

  // 已查验星级文本（兼容鹿对象 .inspected 或直接 inspected 对象）
  // 三个属性各占一行（独立 <div>，不再用 \n 拼接——HTML 会折叠为空格）
  G.inspectedText =
    G.inspectedText ||
    function (d) {
      const st = d && d.inspected ? d.inspected : d;
      if (!st) return "";
      return (
        `<div class="stat-row"><span class="stat-label">速</span><span class="stat-stars">${G.starText(st.speed)}</span></div>` +
        `<div class="stat-row"><span class="stat-label">耐</span><span class="stat-stars">${G.starText(st.stamina)}</span></div>` +
        `<div class="stat-row"><span class="stat-label">巧</span><span class="stat-stars">${G.starText(st.agility)}</span></div>`
      );
    };

  // 视角常量
  const VIEW = {
    STABLE: "stable",
    OWNER_UNINSPECTED: "owner-uninspected",
    OWNER_INSPECTED: "owner-inspected",
    RENTER: "renter",
    SHOP: "shop",
  };
  G.DEER_VIEW = VIEW;

  // 通用鹿卡片容器
  // d:   鹿对象（fullName / desc / inspected / trained ...）
  // opts:
  //   view    视角（默认 STABLE），决定查验区与价值区的默认形态
  //   desc    覆盖描述（如出租市场 "初露锋芒 · 唐老大的鹿"）
  //   value   价值文本（如 "489" 或 "160/场"）；view=STABLE 时忽略
  //   action  { label, click, disabled, title, cls } 文字按钮；label 空则不渲染
  //   badges  [{ text, cls }] 附加徽章（已下注 / 租来的 / 已参赛 ...）
  //   meta    副信息（覆盖 STABLE 默认的"训练 N 次"）
  //   onClick / onContextMenu / title / extraCls  卡片级交互
  function deerCard(d, opts = {}) {
    const {
      view = VIEW.STABLE,
      desc,
      value,
      action,
      badges = [],
      meta,
      onClick,
      onContextMenu,
      title = "",
      extraCls = "",
    } = opts;

    // —— 查验信息区：按视角显示 ——
    let inspectedHtml = "";
    if (view === VIEW.OWNER_UNINSPECTED) {
      inspectedHtml =
        '<div class="deer-uninspected">❓ 未查验 · 属性未知</div>';
    } else if (
      d &&
      d.inspected &&
      (view === VIEW.OWNER_INSPECTED ||
        view === VIEW.RENTER ||
        view === VIEW.STABLE)
    ) {
      inspectedHtml = `<div class="deer-inspected">${G.inspectedText(d)}</div>`;
    }

    // —— 价值 / 副信息区 + 文字按钮 ——
    let valueHtml = "";
    if (meta != null) {
      valueHtml = `<div class="deer-meta">${meta}</div>`;
    } else if (view === VIEW.STABLE) {
      valueHtml = `<div class="deer-meta">训练 ${d.trained || 0} 次</div>`;
    } else if (value != null) {
      const act = action || {};
      valueHtml = `
        <div class="deer-actions">
          <span class="deer-price">🪙 ${value}</span>
          ${
            act.label
              ? `<button class="btn btn-sm ${act.cls || "btn-gold"}"
                   ${act.click ? `onclick="${act.click}"` : ""}
                   ${act.disabled ? "disabled" : ""}
                   ${act.title ? `title="${act.title}"` : ""}>${act.label}</button>`
              : ""
          }
        </div>`;
    }

    // —— 徽章 ——
    const badgeHtml = badges
      .map((b) => `<div class="bet-badge ${b.cls || ""}">${b.text}</div>`)
      .join("");

    return `
      <div class="deer-card ${extraCls}"
           ${onClick ? `onclick="${onClick}"` : ""}
           ${onContextMenu ? `oncontextmenu="${onContextMenu}"` : ""}
           ${title ? `title="${title}"` : ""}>
        <div class="deer-avatar">🦌</div>
        <div class="deer-fullname">${G.escapeHtml(d.fullName)}</div>
        <div class="deer-desc">${G.escapeHtml(desc != null ? desc : d.desc)}</div>
        ${inspectedHtml}
        ${badgeHtml}
        ${valueHtml}
      </div>`;
  }
  G.deerCard = deerCard;

  // 通用图鉴网格：渲染一组鹿卡片
  // items: [{ d, opts }]（opts 可省略，默认 STABLE 视角）
  function deerGrid(container, items) {
    const el =
      typeof container === "string"
        ? document.getElementById(container)
        : container;
    if (!el) return;
    el.innerHTML = items
      .map((it) => deerCard(it.d || it, it.opts || {}))
      .join("");
  }
  G.deerGrid = deerGrid;
})();
