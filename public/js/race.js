/* =========================================================
   race.js — 比赛模块
   相当于小程序的 pages/race：
   鹿舍 / 商店 / 训练 / 投注 / 倒计时 / 平直赛道 / 视角切换 / 随机事件动画
   ========================================================= */
(function () {
  "use strict";
  const G = window.Game;
  if (!G) return;
  if (!G.registers) G.registers = [];

  // 比赛类型说明
  G.TYPE_DESC = {
    sprint: "短距赛 · 比拼速度",
    endurance: "耐力赛 · 比拼耐力",
    obstacle: "障碍赛 · 比拼敏捷",
  };

  // 属性名映射
  const ATTR_TEXT = { speed: "速度", stamina: "耐力", agility: "敏捷" };
  // 训练费用（共享 GameConfig.trainCost，与服务器一致）：按总训练次数递增
  function trainCostOf(d) {
    return GameConfig.trainCost(d.trained || 0);
  }

  // ===== 鹿舍（图鉴式：左栏卡片选择，右栏详情操作）=====
  G.renderDeer = function () {
    if (!G.me) return;
    // 选中项失效时清空（鹿已卖出 / 退租 / 归还 / 挂出）
    if (G.stableSel && !(G.me.deers || []).some((x) => x.id === G.stableSel))
      G.stableSel = null;
    const grid = document.getElementById("deerGrid");
    grid.innerHTML =
      G.me.deers
        .map((d) => {
          const isSel = G.stableSel === d.id;
          const isRace = G.me.selectedDeerId === d.id;
          const isRented = !!d.rented;
          const hasBet = (G.me.bets || []).some((b) =>
            (b.deerIds || []).includes(d.id),
          );
          const badges = [];
          if (hasBet) badges.push({ text: "已下注" });
          if (isRented) badges.push({ text: "租来的" });
          if (isRace) badges.push({ text: "已参赛" });
          if (d.isFawn) badges.push({ text: "🐣小鹿" });
          if (d.retired) badges.push({ text: "👴退役" });
          if (!(d.antlerLeftMs > 0) && !d.isFawn && !d.retired)
            badges.push({ text: "🌿鹿茸" });
          return G.deerCard(d, {
            view: G.DEER_VIEW.STABLE,
            badges,
            meta: `训练 ${d.trained || 0} 次 · 参赛 ${d.races || 0}/${d.maxRaces || GameConfig.MAX_RACES} 场${d.champWins ? ` · 🏆${d.champWins}冠` : ""}`,
            extraCls: `${isSel ? "selected" : ""} ${
              G.me.ready && isRace ? "ready" : ""
            } ${d.retired ? "retired" : ""}`,
            onClick: `selectStableDeer('${d.id}')`,
            onContextMenu: `event.preventDefault();cancelSelectDeer('${d.id}')`,
            title: isRace
              ? "已出战 · 点击查看 · 右键取消出战"
              : "点击查看（左键只选中，出战需在详情点「出战」）",
          });
        })
        .join("") || '<div class="hint">你还没有鹿，去商店买一只吧！</div>';
    G.renderStableDetail();
    syncPaddockDeers();
  };

  // 左键选中鹿（只选中查看，不出战；出战需点详情面板的「出战」键）
  window.selectStableDeer = (deerId) => {
    // 鹿不存在（已卖出 / 退租 / 归还 / 停租）时忽略，避免选中已删除的鹿
    if (!G.me || !(G.me.deers || []).some((x) => x.id === deerId)) return;
    if (G.stableSel === deerId) {
      // 再点已选中的鹿 = 取消选中
      G.stableSel = null;
    } else {
      G.stableSel = deerId;
    }
    G.renderStableDetail();
  };

  // 出战 / 退赛：把选中鹿同步到比赛准备页（最多一条）
  // 视觉反馈已足够（"已参赛"徽章出现/消失、按钮在 出战/退赛 间切换），无需额外 toast
  window.toggleEnterRace = (deerId) => {
    if (!G.me || !(G.me.deers || []).some((x) => x.id === deerId)) return;
    // 已出战 → 退赛；未出战 → 出战
    const isRace = G.me.selectedDeerId === deerId;
    G.socket.emit("selectDeer", { deerId: isRace ? null : deerId });
  };

  // 右键取消出战（已出战才有效）
  window.cancelSelectDeer = (deerId) => {
    if (!G.me || G.me.selectedDeerId !== deerId) return;
    G.socket.emit("selectDeer", { deerId: null });
  };

  // 训练：随机提升速度/耐力/敏捷中的一项（费用按总训练次数递增）
  window.trainDeer = (deerId) => {
    G.socket.emit("trainDeer", { deerId });
  };

  // 花金币查验鹿的属性
  window.inspectDeer = (deerId) => {
    G.socket.emit("inspectDeer", { deerId });
  };

  // 改名
  window.renameDeer = (deerId) => {
    const input = document.getElementById("deerRenameInput");
    const name = input ? input.value.trim() : "";
    if (!name) return G.showToast("请输入新名字");
    G.socket.emit("renameDeer", { deerId, name });
  };

  // 右侧详情面板（植物大战僵尸图鉴风格）
  G.renderStableDetail = function () {
    const box = document.getElementById("deerDetail");
    if (!box) return;
    const deer = (G.me.deers || []).find((d) => d.id === G.stableSel);
    if (!deer) {
      box.innerHTML =
        '<div class="stable-detail-empty">🦌<br>点击左侧选择一只鹿<br><span>查看属性 · 改名 · 查验 · 训练</span></div>';
      return;
    }
    const isRace = G.me.selectedDeerId === deer.id;
    const isRented = !!deer.rented;
    // 图鉴视角：借用者（租来的） / 查验后出租者（已查验） / 查验前出租者（未查验）
    const view = isRented
      ? G.DEER_VIEW.RENTER
      : deer.inspected
        ? G.DEER_VIEW.OWNER_INSPECTED
        : G.DEER_VIEW.OWNER_UNINSPECTED;
    const bars = ["speed", "stamina", "agility"]
      .map((attr) => {
        const st = deer.inspected ? deer.inspected[attr] : null;
        const pct = st ? Math.round((st / 10) * 100) : 0;
        return `<div class="attr-row">
          <span class="attr-label">${ATTR_TEXT[attr]}</span>
          <div class="attr-bar"><div class="attr-fill ${st ? "" : "unknown"}" style="width:${pct}%"></div></div>
          <span class="attr-val ${st ? "" : "unknown"}">${st ? st + "/10" : "?"}</span>
        </div>`;
      })
      .join("");
    const rentPrice = Math.max(80, Math.min(400, (deer.quality || 1) * 80));
    // 卖出价由服务器按属性公式计算（publicDeer.sellPrice），兜底旧逻辑
    const sellPrice =
      deer.sellPrice != null
        ? deer.sellPrice
        : Math.floor((deer.price || deer.quality * 200) * 0.5);
    // —— 出战 / 退赛（左键只选中，出战同步到比赛准备页；最多一条）——
    // 参赛需付 ENTRY_FEE，赛前退赛返还；小鹿未成年 / 老鹿退役不能参赛
    let raceBtn;
    if (isRace) {
      raceBtn = `<button class="detail-act act-danger" title="赛前退赛返还参赛费" onclick="toggleEnterRace('${deer.id}')"><span class="act-ico">↩️</span><span class="act-lbl">退赛(返${GameConfig.ENTRY_FEE}金)</span></button>`;
    } else if (deer.retired) {
      raceBtn = `<button class="detail-act" disabled title="已参赛 ${deer.races} 场，退役后不能参赛/出租/配种，可卖出养老"><span class="act-ico">🏁</span><span class="act-lbl">已退役</span></button>`;
    } else if (deer.isFawn) {
      raceBtn = `<button class="detail-act" disabled title="小鹿喂养 ${GameConfig.FAWN_FEED_NEED} 次成年后才能参赛"><span class="act-ico">🏁</span><span class="act-lbl">小鹿未成年</span></button>`;
    } else {
      raceBtn = `<button class="detail-act act-race" title="参赛费 ${GameConfig.ENTRY_FEE} 金币，赛前退赛返还" onclick="toggleEnterRace('${deer.id}')"><span class="act-ico">🏁</span><span class="act-lbl">出战(${GameConfig.ENTRY_FEE}金)</span></button>`;
    }
    // —— 鹿茸 / 小鹿喂养（鹿圈与详情共用）——
    const antlerLeft = deer.antlerLeftMs || 0;
    const antlerBtn =
      antlerLeft > 0
        ? `<button class="detail-act" disabled title="鹿茸还在成长" data-antler="${deer.id}" data-grow-until="${deer.antlerGrowUntil || 0}"><span class="act-ico">⏳</span><span class="act-lbl">成长中 ${Math.ceil(antlerLeft / 1000)}s</span></button>`
        : `<button class="detail-act act-gold" title="收割鹿茸换金币（品质越高越值钱）" onclick="harvestAntler('${deer.id}')"><span class="act-ico">🌿</span><span class="act-lbl">收割鹿茸</span></button>`;
    const feedBtn = deer.isFawn
      ? `<button class="detail-act" title="喂养小鹿随机提升属性，${GameConfig.FAWN_FEED_NEED} 次成年" onclick="feedDeer('${deer.id}')"><span class="act-ico">🍼</span><span class="act-lbl">喂养(${GameConfig.FEED_COST}金)</span></button>`
      : "";
    // —— 按视角渲染操作按钮 ——
    let actions;
    if (view === G.DEER_VIEW.RENTER) {
      // 借用者：租来的鹿，不可训练/改名/查验/卖出/再出租，可主动退租或等比赛结束自动归还
      actions = `<div class="hint" style="grid-column:1/-1;color:var(--gold)">租来的鹿 · 不可训练/查验/卖出 · 可主动退租，比赛结束也会自动归还</div>
         <button class="detail-act act-danger" onclick="returnRentedDeer('${deer.id}')"><span class="act-ico">📤</span><span class="act-lbl">退租归还</span></button>`;
    } else if (view === G.DEER_VIEW.OWNER_INSPECTED) {
      // 查验后出租者：已查验，可训练 / 挂出租市场 / 卖出 / 收割鹿茸 / 喂养小鹿
      // 退役鹿只能卖出养老（不能训练/收割/出租）
      actions = deer.retired
        ? `<button class="detail-act act-danger" title="按属性折价卖出，得冠额外加价" onclick="sellDeer('${deer.id}')"><span class="act-ico">💰</span><span class="act-lbl">卖出(${sellPrice}金)</span></button>`
        : `<button class="detail-act act-train" title="随机提升速度/耐力/敏捷中的一项" onclick="trainDeer('${deer.id}')"><span class="act-ico">💪</span><span class="act-lbl">训练(${trainCostOf(deer)}金)</span></button>
         ${feedBtn}
         ${antlerBtn}
         <button class="detail-act act-rent" title="挂到商店出租市场，每场赚租金" onclick="rentOutDeer('${deer.id}')"><span class="act-ico">🏪</span><span class="act-lbl">出租(${rentPrice}金/场)</span></button>
         <button class="detail-act act-danger" title="按属性折价卖出，得冠额外加价" onclick="sellDeer('${deer.id}')"><span class="act-ico">💰</span><span class="act-lbl">卖出(${sellPrice}金)</span></button>`;
    } else {
      // 查验前出租者：未查验，先查验才能训练收益最大化 / 挂出租市场
      // 退役鹿只能卖出养老（不能训练/查验/出租）
      actions = deer.retired
        ? `<button class="detail-act act-danger" title="按属性折价卖出，得冠额外加价" onclick="sellDeer('${deer.id}')"><span class="act-ico">💰</span><span class="act-lbl">卖出(${sellPrice}金)</span></button>`
        : `<button class="detail-act act-train" title="随机提升速度/耐力/敏捷中的一项" onclick="trainDeer('${deer.id}')"><span class="act-ico">💪</span><span class="act-lbl">训练(${trainCostOf(deer)}金)</span></button>
         ${feedBtn}
         ${antlerBtn}
         <button class="detail-act act-inspect" onclick="inspectDeer('${deer.id}')"><span class="act-ico">🔍</span><span class="act-lbl">查验(${GameConfig.INSPECT_COST}金)</span></button>
         <button class="detail-act act-rent" disabled title="查验后才能挂到出租市场"><span class="act-ico">🏪</span><span class="act-lbl">出租需查验</span></button>
         <button class="detail-act act-danger" title="按属性折价卖出，得冠额外加价" onclick="sellDeer('${deer.id}')"><span class="act-ico">💰</span><span class="act-lbl">卖出(${sellPrice}金)</span></button>`;
    }
    const retiredTag = deer.retired
      ? '<span class="mine" style="color:var(--red)">(已退役)</span>'
      : "";
    const fawnTag = deer.isFawn
      ? `<span class="mine" style="color:var(--gold)">(小鹿 ${deer.fed || 0}/${GameConfig.FAWN_FEED_NEED})</span>`
      : "";
    box.innerHTML = `
        <div class="detail-head">
          <div class="detail-avatar">🦌</div>
          <div class="detail-name-wrap">
            <div class="detail-name">${G.escapeHtml(deer.fullName)} ${
              isRace ? '<span class="mine">(参赛鹿)</span>' : ""
            } ${isRented ? '<span class="mine">(租来的)</span>' : ""} ${retiredTag} ${fawnTag}</div>
            <div class="detail-rename">
              <input class="input-field" id="deerRenameInput" placeholder="新名字" maxlength="8" value="${G.escapeHtml(deer.name)}" ${isRented ? "disabled" : ""} />
              <button class="btn btn-sm" onclick="renameDeer('${deer.id}')" ${isRented ? "disabled" : ""}>改名</button>
            </div>
          </div>
        </div>
        <div class="detail-desc">${G.escapeHtml(deer.desc)}</div>
        ${
          deer.inspected
            ? `<div class="deer-inspected">${G.inspectedText(deer)}</div>`
            : ""
        }
        <div class="detail-bars">${bars}</div>
        <div class="detail-meta">训练 ${deer.trained || 0} 次 · 参赛 ${
          deer.races || 0
        }/${deer.maxRaces || GameConfig.MAX_RACES} 场${
          deer.champWins ? ` · 🏆 ${deer.champWins} 冠` : ""
        }</div>
        <div class="detail-actions">
          ${raceBtn}
          ${actions}
        </div>`;
  };

  // 出租市场卡片列表：自己的鹿排最前（可收回），之后是别人的鹿（可租用）
  // 房间商店的出租市场子视图与大厅的全服出租市场共用同一渲染
  // "自己的鹿"判定：socket.id 或登录账号名（刷新/重连后 socket.id 会变）
  function isMyRental(m) {
    return (
      m.ownerId === G.myId ||
      !!(G.account && m.ownerAccount === G.account.username)
    );
  }
  function rentalCardsHtml() {
    const items = G.rentalMarket || [];
    const mine = items.filter(isMyRental);
    const others = items.filter((m) => !isMyRental(m));
    const card = (m) => {
      const rented = !!m.rentedBy;
      const isMine = mine.includes(m);
      return G.deerCard(m.deer, {
        view: G.DEER_VIEW.RENTER,
        desc: `${m.deer.desc} · ${m.ownerName}的鹿`,
        value: `${m.rentPrice}/场${rented ? " · 已被租用" : ""}`,
        action: isMine
          ? rented
            ? {
                label: "已租出",
                disabled: true,
                title: "被租用中，需等归还后才能收回",
              }
            : { label: "收回", click: `unrentDeer('${m.id}')` }
          : rented
            ? { label: "已租出", disabled: true }
            : { label: "租用", click: `rentDeer('${m.id}')` },
        extraCls: `rental-item ${rented ? "rented" : ""}`,
      });
    };
    return [...mine, ...others].map(card).join("");
  }

  // 提前归还租来的鹿（比赛结束也会自动归还）
  window.returnRentedDeer = (deerId) => {
    // 本地先行取消选中：退租后该鹿会立即从鹿舍移除，
    // 若 stableSel 仍指向它，服务器响应前的空窗期再渲染会访问已删鹿
    if (G.stableSel === deerId) {
      G.stableSel = null;
      G.renderStableDetail();
    }
    G.socket.emit("returnRentedDeer", { deerId });
  };

  // 卖出鹿（折价 50%）：本地先行取消选中，避免指向已删鹿
  window.sellDeer = (deerId) => {
    if (G.stableSel === deerId) {
      G.stableSel = null;
      G.renderStableDetail();
    }
    G.socket.emit("sellDeer", { deerId });
  };

  // 挂出到出租市场：鹿会从鹿舍移除，同样先行取消选中
  window.rentOutDeer = (deerId) => {
    if (G.stableSel === deerId) {
      G.stableSel = null;
      G.renderStableDetail();
    }
    G.socket.emit("rentOutDeer", { deerId });
  };

  // 收回挂出的鹿（房间内操作）
  window.unrentDeer = (marketId) => G.socket.emit("unrentDeer", { marketId });

  // 收割鹿茸：成熟后换金币，之后重新成长
  window.harvestAntler = (deerId) => G.socket.emit("harvestAntler", { deerId });
  // 喂养小鹿：随机提升一项属性，喂满成年
  window.feedDeer = (deerId) => G.socket.emit("feedDeer", { deerId });
  // 配种：两只自己的鹿（a = 抓住的鹿，b = 点击的另一只）
  window.breedDeer = (deerAId, deerBId) =>
    G.socket.emit("breedDeer", { deerAId, deerBId });

  // ===== 鹿圈（鹿随机走动，鼠标靠近会小步躲开；点击=抓住，功能表在底部；碰另一只鹿=配种）=====
  const PADDOCK = {
    deer: [], // {id, x, y, vx, vy, state, t, el}
    timer: 0,
    on: false,
    mouse: null,
    caughtId: null, // 抓住的鹿 id（功能表作用于它）
    breedMode: false, // 配种选择模式：再点另一只鹿 = 配种
    barEl: null, // 底部功能表元素
  };

  window.switchStableView = function (mode) {
    G.stableView = mode || "card";
    // 只切换鹿舍面板内的视图按钮（商店面板共用同类样式，避免互相干扰）
    document.querySelectorAll("#panel-deer .view-toggle-btn").forEach((b) => {
      b.classList.toggle("active", b.dataset.view === G.stableView);
    });
    const grid = document.getElementById("deerGrid");
    const wrap = document.getElementById("paddockWrap");
    if (grid) grid.style.display = G.stableView === "card" ? "" : "none";
    if (wrap) wrap.style.display = G.stableView === "paddock" ? "" : "none";
    if (G.stableView === "paddock") startPaddock();
    else stopPaddock();
  };

  G.onTabChanged = function (tab) {
    if (tab !== "deer") stopPaddock();
    else if (G.stableView === "paddock") startPaddock();
  };

  function startPaddock() {
    syncPaddockDeers();
    if (!PADDOCK.on) {
      PADDOCK.on = true;
      PADDOCK.timer = setInterval(paddockTick, 16);
    }
  }

  function stopPaddock() {
    PADDOCK.on = false;
    if (PADDOCK.timer) {
      clearInterval(PADDOCK.timer);
      PADDOCK.timer = 0;
    }
  }

  // 点击鹿：配种模式 → 与抓住的鹿配种；已抓住 → 取消；未抓住 → 抓住
  function onPaddockDeerClick(id) {
    const all = G.me.deers || [];
    const deer = all.find((x) => x.id === id);
    if (!deer) return;
    if (PADDOCK.breedMode) {
      const a = PADDOCK.caughtId;
      PADDOCK.breedMode = false;
      if (a && a !== id) {
        const aDeer = all.find((x) => x.id === a);
        if (aDeer) {
          if (aDeer.isFawn || deer.isFawn)
            return G.showToast("小鹿还不能配种", "err");
          if (aDeer.retired || deer.retired)
            return G.showToast("老鹿已退役，不能配种", "err");
          if (
            !window.confirm(
              `用「${aDeer.fullName}」和「${deer.fullName}」配种？\n花费 ${GameConfig.BREED_COST} 金，父母冷却 3 分钟`,
            )
          ) {
            renderPaddockBar();
            return;
          }
          G.socket.emit("breedDeer", { deerAId: a, deerBId: id });
        }
      }
      renderPaddockBar();
      return;
    }
    if (PADDOCK.caughtId !== id) {
      PADDOCK.caughtId = id; // 抓住
      selectStableDeer(id); // 同步右侧详情
      // 抓住的鹿立即吸附到鼠标小手
      const pd = PADDOCK.deer.find((x) => x.id === id);
      if (pd && PADDOCK.mouse) {
        pd.x = PADDOCK.mouse.x;
        pd.y = PADDOCK.mouse.y;
      }
    }
    // 点击已抓住的鹿不取消：只能通过点空地或鼠标离开控件松手
    renderPaddockBar();
  }

  // 功能表："配种"进入配种模式（再点另一只鹿完成配种）
  window.startBreedMode = () => {
    const d = (G.me.deers || []).find((x) => x.id === PADDOCK.caughtId);
    if (!d) return;
    if (d.isFawn) return G.showToast("小鹿还不能配种", "err");
    if (d.retired) return G.showToast("老鹿已退役，不能配种", "err");
    if (!d.breedReady)
      return G.showToast("这头鹿刚配过种，需休息 3 分钟", "err");
    PADDOCK.breedMode = true;
    renderPaddockBar();
    G.showToast("点另一只鹿完成配种（再点当前鹿取消）");
  };

  // 底部功能表：抓住的鹿的操作按钮（收割鹿茸 / 喂养小鹿 / 配种 / 查看详情）
  function renderPaddockBar() {
    const pad = document.getElementById("deerPaddock");
    if (!pad) return;
    const barBox = document.getElementById("paddockBar");
    if (barBox) barBox.innerHTML = "";
    // 同步抓住高亮（未抓住的鹿移除高亮）
    PADDOCK.deer.forEach((pd) => {
      if (pd.el) pd.el.classList.toggle("caught", PADDOCK.caughtId === pd.id);
    });
    if (!PADDOCK.caughtId) return;
    const d = (G.me.deers || []).find((x) => x.id === PADDOCK.caughtId);
    if (!d) {
      PADDOCK.caughtId = null;
      return;
    }
    const bar = document.getElementById("paddockBar");
    if (!bar) return;
    bar.innerHTML = "";
    const antlerLeft = d.antlerLeftMs || 0;
    // 退役鹿只能卖出养老（鹿圈里不提供收割鹿茸/喂养/配种按钮）
    const antlerBtn = d.retired
      ? ""
      : antlerLeft > 0
        ? `<button class="btn btn-sm" disabled data-antler="${d.id}" data-grow-until="${d.antlerGrowUntil || 0}">鹿茸成长中 ${Math.ceil(antlerLeft / 1000)}s</button>`
        : `<button class="btn btn-sm btn-gold" onclick="harvestAntler('${d.id}')">收割鹿茸</button>`;
    const feedBtn = d.isFawn
      ? `<button class="btn btn-sm" onclick="feedDeer('${d.id}')">喂养(${GameConfig.FEED_COST}金)</button>`
      : "";
    const breedBtn =
      !d.isFawn && !d.retired
        ? `<button class="btn btn-sm ${PADDOCK.breedMode ? "btn-gold" : ""}" onclick="startBreedMode()">${PADDOCK.breedMode ? "点另一只鹿配种..." : "配种"}</button>`
        : "";
    const flags = [
      d.isFawn ? "🐣小鹿" : "",
      d.retired ? "👴退役" : "",
      !d.breedReady ? "💤配种冷却" : "",
      !d.retired && antlerLeft > 0 ? "" : "",
      !d.retired && antlerLeft <= 0 ? "🌿鹿茸可收割" : "",
    ]
      .filter(Boolean)
      .join(" · ");
    bar.innerHTML = `
      <div class="paddock-bar-head">🦌 ${G.escapeHtml(d.fullName)} ${flags ? `<span class="pd-flags">${flags}</span>` : ""}</div>
      <div class="paddock-bar-actions">
        ${antlerBtn}
        ${feedBtn}
        ${breedBtn}
        <button class="btn btn-sm" onclick="selectStableDeer('${d.id}')">查看详情</button>
        <button class="btn btn-sm btn-ghost" onclick="clearCaught()">取消抓住</button>
      </div>`;
    PADDOCK.barEl = bar;
  }

  // 取消抓住（再点已抓住的鹿也会取消）
  window.clearCaught = () => {
    PADDOCK.caughtId = null;
    PADDOCK.breedMode = false;
    renderPaddockBar();
  };

  // 同步鹿圈里的鹿（增删 + 状态刷新：小鹿/退役/鹿茸/抓住标记）
  function syncPaddockDeers() {
    const pad = document.getElementById("deerPaddock");
    if (!pad || !G.me) return;
    const w = pad.clientWidth || 600;
    const h = pad.clientHeight || 240;
    // 移除不再拥有的
    PADDOCK.deer = PADDOCK.deer.filter((d) => {
      const keep = (G.me.deers || []).some((x) => x.id === d.id);
      if (!keep && d.el) d.el.remove();
      return keep;
    });
    // 新增 + 刷新状态
    for (const d of G.me.deers) {
      let pd = PADDOCK.deer.find((x) => x.id === d.id);
      if (!pd) {
        const el = document.createElement("div");
        el.className = "paddock-deer";
        el.addEventListener("click", () => onPaddockDeerClick(d.id));
        pad.appendChild(el);
        pd = {
          id: d.id,
          x: 40 + Math.random() * (w - 80),
          y: 40 + Math.random() * (h - 80),
          vx: 0,
          vy: 0,
          state: "stop",
          t: 300 + Math.random() * 1000,
          el,
        };
        PADDOCK.deer.push(pd);
      }
      // 状态徽章：小鹿🐣 / 退役👴 / 鹿茸成熟🌿
      const antlerOk = !(d.antlerLeftMs > 0);
      pd.el.innerHTML = `
        <span class="pd-emoji">${d.isFawn ? "🦌" : "🦌"}${antlerOk && !d.isFawn ? '<span class="pd-antler">🌿</span>' : ""}</span>
        <span class="pd-name">${G.escapeHtml(d.name)}${d.isFawn ? "🐣" : ""}${d.retired ? "👴" : ""}</span>`;
      pd.el.classList.toggle("caught", PADDOCK.caughtId === d.id);
    }
    renderPaddockBar();
    // 绑定鼠标交互（一次性）
    if (!pad._pdBound) {
      pad._pdBound = true;
      pad.addEventListener("mousemove", (e) => {
        const r = pad.getBoundingClientRect();
        PADDOCK.mouse = { x: e.clientX - r.left, y: e.clientY - r.top };
      });
      pad.addEventListener("mouseleave", () => {
        PADDOCK.mouse = null;
        // 抓住的鹿一直跟着鼠标小手，鼠标离开控件即松手
        if (PADDOCK.caughtId) clearCaught();
      });
      // 点击空白处取消抓住
      pad.addEventListener("click", (e) => {
        if (e.target === pad && PADDOCK.caughtId) {
          clearCaught();
        }
      });
    }
  }

  function paddockTick() {
    if (!PADDOCK.on) return;
    const pad = document.getElementById("deerPaddock");
    if (!pad) {
      PADDOCK.on = false;
      return;
    }
    const w = pad.clientWidth;
    const h = pad.clientHeight;
    for (const d of PADDOCK.deer) {
      // 抓住的鹿：一直贴在鼠标小手上（离开控件时已松手）
      if (d.id === PADDOCK.caughtId) {
        if (PADDOCK.mouse) {
          d.x = PADDOCK.mouse.x;
          d.y = PADDOCK.mouse.y;
        }
        if (d.el) {
          d.el.style.left = d.x + "px";
          d.el.style.top = d.y + "px";
          d.el.style.transform = "translate(-50%, -50%)";
        }
        continue;
      }
      d.t -= 16;
      // 状态切换：行走 ↔ 停下
      if (d.state === "flee") {
        if (d.t <= 0) {
          d.state = "walk";
          d.t = 700 + Math.random() * 1500;
          const ang = Math.random() * Math.PI * 2;
          const sp = 0.12 + Math.random() * 0.18; // 散步速度（慢）
          d.vx = Math.cos(ang) * sp;
          d.vy = Math.sin(ang) * sp;
        }
      } else if (d.t <= 0) {
        if (d.state === "walk") {
          d.state = "stop";
          d.t = 400 + Math.random() * 1500;
          d.vx = 0;
          d.vy = 0;
        } else {
          d.state = "walk";
          d.t = 800 + Math.random() * 1800;
          const ang = Math.random() * Math.PI * 2;
          const sp = 0.12 + Math.random() * 0.18; // 散步速度（慢）
          d.vx = Math.cos(ang) * sp;
          d.vy = Math.sin(ang) * sp;
        }
      }
      // 鼠标靠近 → 小步躲开（巨幅降低逃跑速度：0.6 → 0.15，很容易抓住）
      if (PADDOCK.mouse && d.state !== "flee") {
        const dx = d.x - PADDOCK.mouse.x;
        const dy = d.y - PADDOCK.mouse.y;
        const dist = Math.hypot(dx, dy);
        if (dist < 70) {
          d.state = "flee";
          d.t = 700;
          const sp = 0.15; // 逃跑速度大幅降低（原 0.6）
          d.vx = (dx / (dist || 1)) * sp;
          d.vy = (dy / (dist || 1)) * sp;
        }
      }
      if (d.state === "walk" || d.state === "flee") {
        const k = d.state === "flee" ? 1 : 0.55;
        d.x += d.vx * 16 * k;
        d.y += d.vy * 16 * k;
      }
      // 边界反弹
      const m = 20;
      if (d.x < m) {
        d.x = m;
        d.vx = Math.abs(d.vx);
      } else if (d.x > w - m) {
        d.x = w - m;
        d.vx = -Math.abs(d.vx);
      }
      if (d.y < m) {
        d.y = m;
        d.vy = Math.abs(d.vy);
      } else if (d.y > h - m) {
        d.y = h - m;
        d.vy = -Math.abs(d.vy);
      }
      if (d.el) {
        d.el.style.left = d.x + "px";
        d.el.style.top = d.y + "px";
        // 朝移动方向看（🦌 默认朝左，scaleX(-1) 朝右）
        d.el.style.transform = `translate(-50%, -50%) scaleX(${d.vx >= 0 ? -1 : 1})`;
        d.el.classList.toggle("moving", d.state !== "stop");
      }
    }
  }

  // ===== 商店 =====
  // 子视图：buy = 购买（货架），rent = 出租市场（看别人的鹿并租用）
  G.shopView = G.shopView || "buy";
  window.switchShopView = (view) => {
    G.shopView = view;
    // 与鹿舍共用 stable-view-toggle 样式，只切换商店面板内的按钮
    document.querySelectorAll("#panel-shop .view-toggle-btn").forEach((b) => {
      b.classList.toggle("active", b.dataset.view === view);
    });
    const shopGrid = document.getElementById("shopGrid");
    const rentalGrid = document.getElementById("rentalGrid");
    if (shopGrid) shopGrid.style.display = view === "buy" ? "" : "none";
    if (rentalGrid) rentalGrid.style.display = view === "rent" ? "" : "none";
    renderShopGrid();
    renderRentalGrid();
  };

  G.renderShop = function () {
    if (!G.room) return;
    // 初始化子视图高亮（与鹿舍共用样式类）
    document.querySelectorAll("#panel-shop .view-toggle-btn").forEach((b) => {
      b.classList.toggle("active", b.dataset.view === G.shopView);
    });
    renderShopGrid();
    renderRentalGrid();
  };

  // 购买视图：商店货架（购买者视角 · 售价 + 购买按钮）
  function renderShopGrid() {
    const grid = document.getElementById("shopGrid");
    if (!grid) return;
    grid.innerHTML =
      G.room.shop
        .map((d) =>
          G.deerCard(d, {
            view: G.DEER_VIEW.SHOP,
            value: d.price ?? d.quality * 200,
            action: {
              label: "购买",
              click: `event.stopPropagation();buyDeer('${d.id}')`,
            },
            onClick: `buyDeer('${d.id}')`,
            title: "点击购买",
          }),
        )
        .join("") || '<div class="hint">货架空空，稍后自动刷新</div>';
    // 自动刷新倒计时与手动刷新花费
    const timerEl = document.getElementById("shopTimer");
    if (timerEl)
      timerEl.textContent = G.room.shopRefreshIn
        ? `自动刷新 ${G.room.shopRefreshIn}s`
        : "";
    const btn = document.getElementById("refreshShopBtn");
    if (btn)
      btn.textContent = G.room.shopRefreshCost
        ? `刷新货架 (${G.room.shopRefreshCost}金)`
        : "刷新货架";
  }

  // 出租市场视图：自己的鹿置顶（收回按钮），其后是别人的鹿（租用按钮）
  function renderRentalGrid() {
    const grid = document.getElementById("rentalGrid");
    if (!grid) return;
    const items = G.rentalMarket || [];
    if (!items.length) {
      grid.innerHTML =
        '<div class="hint">市场空空 —— 把你的鹿查验后挂上来，每场比赛自动赚租金！</div>';
      return;
    }
    grid.innerHTML = rentalCardsHtml();
  }

  window.buyDeer = (deerId) => G.socket.emit("buyDeer", { deerId });

  // 刷新商店货架
  window.refreshShop = () => G.socket.emit("refreshShop");

  // ===== 比赛准备面板 =====
  G.renderRacePanel = function () {
    if (!G.room || !G.me) return;
    const isHost = G.room.host === G.myId;
    const inRace = !!G.room.raceState;

    // 比赛设置区（仅房主 + 无比赛时显示表单；非房主隐藏）
    const raceSetup = document.getElementById("raceSetup");
    if (raceSetup)
      raceSetup.style.display = isHost && !inRace ? "flex" : "none";
    const cdInput = document.getElementById("betCountdownInput");
    if (cdInput && G.room.betCountdown != null && !inRace) {
      cdInput.value = G.room.betCountdown;
    }
    // 同步比赛类型下拉框（以服务器为准）
    const typeSel = document.getElementById("raceTypeSelect");
    if (typeSel && G.room.raceType) typeSel.value = G.room.raceType;

    const readyBtn = document.getElementById("readyBtn");
    const startBtn = document.getElementById("startRaceBtn");
    const hint = document.getElementById("readyHint");

    if (inRace) {
      readyBtn.style.display = "none";
      startBtn.style.display = "none";
      hint.textContent =
        G.room.raceState.status === "betting"
          ? "投注阶段：选择参赛鹿下注"
          : G.room.raceState.status === "racing"
            ? "比赛进行中"
            : "比赛结束";
    } else {
      const hasDeer = !!G.me.selectedDeerId;
      const selName = hasDeer
        ? (() => {
            const d = (G.me.deers || []).find(
              (x) => x.id === G.me.selectedDeerId,
            );
            return d ? d.name : "";
          })()
        : "";
      readyBtn.style.display = "inline-block";
      readyBtn.textContent = G.me.ready ? "取消准备" : "我准备好了";
      readyBtn.disabled = false;
      // 全员就绪才能开赛（含房主自己）
      const allPlayers = G.room.players || [];
      const allReady =
        allPlayers.length > 0 && allPlayers.every((p) => p.ready);
      startBtn.style.display = isHost ? "inline-block" : "none";
      startBtn.disabled = !(isHost && allReady);
      const notReadyCount = allPlayers.filter((p) => !p.ready).length;
      // 提示行（按钮下方）：显示所选鹿名或未选鹿 + 当前状态
      const deerInfo = hasDeer ? `🦌 已选鹿：${selName}` : "未选鹿";
      let status;
      if (G.me.ready) {
        if (!hasDeer) status = "已准备（观战）";
        else if (notReadyCount > 0)
          status = `已准备 · 等待 ${notReadyCount} 名玩家`;
        else if (isHost) status = "全员已准备，可开始比赛";
        else status = "等待房主开始比赛";
      } else {
        status = hasDeer
          ? "点击「我准备好了」开始准备"
          : "可直接准备观战，或选一只鹿参赛";
      }
      hint.textContent = `${deerInfo} · ${status}`;
    }

    // 我押注的鹿 id（头顶 🔻 箭头）
    function betDeerIdsFromMe() {
      return ((G.me && G.me.bets) || []).flatMap((b) => b.deerIds || []);
    }

    // 投注面板状态：常显，只是启用/禁用（禁用时显示原因）
    function setBetEnabled(enabled, hint) {
      G.ui.betPanel.style.display = "block";
      G.ui.betPanel.classList.toggle("bet-disabled", !enabled);
      document
        .querySelectorAll("#betPanel .bet-type-btn")
        .forEach((b) => (b.disabled = !enabled));
      const amt = document.getElementById("betAmount");
      if (amt) amt.disabled = !enabled;
      const btn = document.getElementById("betSubmitBtn");
      if (btn) btn.disabled = !enabled;
      const hintEl = document.getElementById("betTypeHint");
      if (hintEl) hintEl.textContent = enabled ? "" : hint || "";
      const opts = document.getElementById("betOptions");
      if (opts && !enabled) {
        opts.innerHTML = `<div class="bet-disabled-hint">${hint || "暂不可投注"}</div>`;
      }
    }

    // 比赛显示（比赛容器与投注面板常显，只是是否禁用；比赛后清空投注状态）
    const rs = G.room.raceState;
    const trackEl = G.ui.trackContainer;
    // 占位提示（未开赛/已结束的等待状态）
    let ph = document.getElementById("trackPlaceholder");
    if (!ph) {
      ph = document.createElement("div");
      ph.id = "trackPlaceholder";
      ph.className = "track-placeholder";
      if (trackEl) trackEl.appendChild(ph);
    }
    if (rs) {
      trackEl.style.display = "block";
      if (ph) ph.style.display = "none";
      document.getElementById("resultBox").style.display = "none";
      if (rs.status === "betting") {
        setBetEnabled(true);
        renderBetOptions(rs);
        // 新一场比赛创建直播视图；同一场比赛的多次投注刷新只复用，不重建（避免鹿跳动/视角闪烁）
        if (!G.roomLive) {
          G.roomLive = G.makeLiveView({
            surface: G.ui.trackSurface,
            container: trackEl,
            controls: true,
            globalFit: true, // 全局视角自适应囊括所有鹿
            minimap: true, // 底部导航小窗
            betDeerIds: betDeerIdsFromMe(), // 押注的鹿头顶 🔻
          });
          G.roomLive.setRace(rs);
        } else {
          G.roomLive.setBets(betDeerIdsFromMe());
        }
        document.getElementById("raceStatus").textContent = "投注阶段";
        document.getElementById("raceStatus").className =
          "race-status-text betting";
        // 倒计时显示（如果服务器已在倒数）
        if (G.countdownVal !== null) {
          G.ui.betTimer.style.display = "inline-flex";
          G.ui.betTimerNum.textContent = G.countdownVal;
        }
      } else if (rs.status === "racing") {
        setBetEnabled(false, "比赛进行中，无法投注");
        G.ui.betTimer.style.display = "none";
        document.getElementById("raceStatus").textContent = "比赛进行中";
        document.getElementById("raceStatus").className =
          "race-status-text racing";
        // 比赛中加入房间：也要能看到正在进行的比赛（投注阶段加入的视图可复用）
        if (!G.roomLive) {
          G.roomLive = G.makeLiveView({
            surface: G.ui.trackSurface,
            container: trackEl,
            controls: true,
            globalFit: true,
            minimap: true,
            betDeerIds: betDeerIdsFromMe(),
          });
          G.roomLive.setRace(rs);
        } else {
          G.roomLive.setBets(betDeerIdsFromMe());
        }
      } else if (rs.status === "finished") {
        setBetEnabled(false, "比赛已结束，等待下一场");
        G.ui.betTimer.style.display = "none";
        // 比赛后清空押注容器中的状态（已选、类型、我的投注列表由服务器清空广播）
        G.betPicks = [];
        G.betType = "win";
        renderMyBetInfo(); // 刷新"我的投注"（服务器已清空 bets，显示"尚未下注"）
        document.getElementById("raceStatus").textContent = "比赛结束";
        document.getElementById("raceStatus").className =
          "race-status-text finished";
      }
    } else {
      // 未开赛/比赛已彻底结束：容器常显占位，投注面板禁用
      trackEl.style.display = "block";
      if (ph) {
        ph.style.display = "flex";
        ph.textContent = "等待比赛开始";
      }
      setBetEnabled(false, "尚未开赛，开赛后即可下注");
      G.ui.betTimer.style.display = "none";
      G.countdownVal = null;
      G.betPicks = [];
      G.betType = "win";
      document.getElementById("raceStatus").textContent = "";
      // 比赛彻底结束，释放直播视图
      if (G.roomLive) {
        G.roomLive.dispose();
        G.roomLive = null;
      }
    }
  };

  window.toggleReady = () => {
    G.socket.emit("readyRace");
  };

  // 房主切换比赛类型（下拉框；说明文字在 select 的 title 悬浮提示中）
  window.setRaceTypeSelect = (type) => {
    if (!G.room || G.room.host !== G.myId) return;
    if (!GameConfig.RACE_TYPES.includes(type)) return;
    G.selectedRaceType = type;
    G.socket.emit("setRaceType", { type });
  };

  // 房主设置投注阶段倒计时（1~199 秒）
  window.setBetCountdown = () => {
    const input = document.getElementById("betCountdownInput");
    if (!input) return;
    const s = parseInt(input.value, 10);
    if (!(s >= 1 && s <= GameConfig.BET_COUNTDOWN_MAX)) {
      return G.showToast(
        `投注倒计时需在 1~${GameConfig.BET_COUNTDOWN_MAX} 秒之间`,
        "err",
      );
    }
    G.socket.emit("setBetCountdown", { seconds: s });
  };

  window.requestStartRace = () => {
    if (!G.room || G.room.host !== G.myId) return;
    if (!G.me.ready) return G.showToast("请先点击「我准备好了」");
    const allPlayers = G.room.players || [];
    const notReady = allPlayers.filter((p) => !p.ready);
    if (notReady.length > 0) {
      return G.showToast(`还有 ${notReady.length} 名玩家未准备`, "err");
    }
    G.socket.emit("startRace");
  };

  // ===== 投注 =====
  // 展示文案（数值部分 need/mult 来自共享 GameConfig，与服务器结算同源）
  const BET_LABELS = {
    win: "独赢",
    place: "位置",
    quinella: "连赢",
    trifecta: "三重彩",
  };
  const BET_DESCS = {
    win: "押冠军",
    place: "押前三名",
    quinella: "前两名",
    trifecta: "前三名",
  };
  const BET_TYPES = Object.fromEntries(
    Object.entries(GameConfig.BET_TYPES).map(([k, v]) => [
      k,
      { ...v, label: BET_LABELS[k], desc: BET_DESCS[k] },
    ]),
  );
  // 当前投注状态（G.betType / G.betPicks 由 app.js 初始化）

  // 切换投注类型：清空已选，重新渲染
  window.setBetType = (type) => {
    if (!BET_TYPES[type]) return;
    G.betType = type;
    G.betPicks = [];
    renderBetOptions(G.room && G.room.raceState);
  };

  // 点击鹿卡片：选中/取消（按类型数量限制）
  window.toggleBetPick = (deerId) => {
    const t = BET_TYPES[G.betType];
    const i = G.betPicks.indexOf(deerId);
    if (i >= 0) {
      G.betPicks.splice(i, 1);
    } else if (G.betPicks.length < t.need) {
      G.betPicks.push(deerId);
    } else {
      return G.showToast(`该投注类型最多选 ${t.need} 匹鹿`, "err");
    }
    renderBetOptions(G.room && G.room.raceState);
  };

  // 确认投注：必须选够鹿 + 金额 >= 最低投注
  window.placeBet = () => {
    const t = BET_TYPES[G.betType];
    if (G.betPicks.length !== t.need)
      return G.showToast(`请选择 ${t.need} 匹鹿`, "err");
    const amount = currentBetAmount();
    if (amount < GameConfig.MIN_BET)
      return G.showToast(`投注金额至少 ${GameConfig.MIN_BET} 金币`, "err");
    if (amount > (G.me ? G.me.gold : 0)) return G.showToast("金币不足", "err");
    G.socket.emit("placeBet", {
      type: G.betType,
      deerIds: [...G.betPicks],
      amount,
    });
    G.betPicks = []; // 投注成功后清空已选，方便继续下注
  };

  function currentBetAmount() {
    return parseInt(document.getElementById("betAmount").value) || 0;
  }

  // 单鹿卡片赔率：动态赔率随实时投注量波动（服务器每次下注后重算并广播）
  // need=1 的玩法（win/place）显示结算倍率；need>1 的玩法显示该鹿单鹿赔率
  function betOddsText(rs, idx) {
    const base = parseFloat(rs.odds[idx]);
    const t = BET_TYPES[G.betType];
    if (t.need === 1) return GameConfig.comboOdds(G.betType, [base]).toFixed(1);
    return base.toFixed(1);
  }

  function renderBetOptions(rs) {
    if (!rs) return;
    // 已选的鹿不在本场参赛名单时自动清空（新一场比赛开始时重置）
    const racerIds = rs.racers.map((r) => r.deer.id);
    G.betPicks = G.betPicks.filter((id) => racerIds.includes(id));
    const opts = document.getElementById("betOptions");
    // 类型按钮高亮
    document.querySelectorAll("#betTypes .bet-type-btn").forEach((b) => {
      b.classList.toggle("active", b.dataset.type === G.betType);
    });
    const t = BET_TYPES[G.betType];
    // 组合倍率实时显示：选够鹿时给出当前组合倍率（赔率变化即刷新）
    let hintText = `${t.label} · ${t.desc}（选 ${t.need} 匹鹿）`;
    if (G.betPicks.length === t.need) {
      const oddsArr = G.betPicks.map((id) => {
        const i = rs.racers.findIndex((r) => r.deer.id === id);
        return parseFloat(rs.odds[i]);
      });
      hintText += ` · 组合倍率 ${GameConfig.comboOdds(G.betType, oddsArr).toFixed(1)}x（实时）`;
    } else if (G.betPicks.length > 0) {
      hintText += ` · 已选 ${G.betPicks.length}/${t.need}`;
    }
    // 动态赔率说明：显示当前投注总额
    const totalPool = Object.values(rs.betPool || {}).reduce(
      (s, v) => s + v,
      0,
    );
    if (totalPool > 0) {
      hintText += ` · 本场投注 ${totalPool}金`;
    }
    document.getElementById("betTypeHint").textContent = hintText;
    opts.innerHTML = rs.racers
      .map((r, idx) => {
        const isMine = r.ownerId === G.myId;
        const picked = G.betPicks.includes(r.deer.id);
        const pool = (rs.betPool && rs.betPool[r.deer.id]) || 0;
        return `
        <div class="deer-card bet-opt ${picked ? "selected" : ""}" onclick="toggleBetPick('${r.deer.id}')">
            <div class="bet-deer">🦌 ${r.deer.fullName} ${isMine ? '<span class="mine">(我的鹿)</span>' : ""}</div>
            <div class="bet-odds">赔率 ${betOddsText(rs, idx)}x${pool ? `<span class="bet-pool"> · 已投 ${pool}金</span>` : ""}</div>
            ${picked ? '<div class="bet-badge">已选</div>' : ""}
        </div>
    `;
      })
      .join("");
    updateBetSubmit();
    renderMyBetInfo();
  }

  // 投注按钮可用性：选够鹿 + 金额 >= 最低投注且不超过金币
  function updateBetSubmit() {
    const btn = document.getElementById("betSubmitBtn");
    if (!btn) return;
    const t = BET_TYPES[G.betType];
    const amount = currentBetAmount();
    const gold = G.me ? G.me.gold : 0;
    btn.disabled = !(
      G.betPicks.length === t.need &&
      amount >= GameConfig.MIN_BET &&
      amount <= gold
    );
  }

  // 金额输入变化时刷新按钮状态
  const betAmountInput = document.getElementById("betAmount");
  if (betAmountInput) {
    betAmountInput.addEventListener("input", updateBetSubmit);
  }

  function findDeerName(deerId) {
    const r = G.room?.raceState?.racers.find((x) => x.deer.id === deerId);
    return r ? r.deer.fullName : "?";
  }

  // 我的投注列表：显示所有已下投注（可多次投注）
  function renderMyBetInfo() {
    const el = document.getElementById("myBetInfo");
    const myBets = (G.me && G.me.bets) || [];
    if (!myBets.length) {
      el.textContent =
        "尚未下注：选择类型和鹿，输入金额后确认投注（可多次投注）";
      return;
    }
    el.innerHTML =
      "我的投注：" +
      myBets
        .map((b) => {
          const t = BET_TYPES[b.type] || { label: b.type, need: 1 };
          const names = (b.deerIds || [])
            .map((id) => findDeerName(id))
            .join("、");
          return `<div class="my-bet">· ${t.label} ${b.amount}金 → ${names}</div>`;
        })
        .join("");
  }

  // ===== 平直赛道渲染 =====
  // 直播视图工厂（makeLiveView + 赛道渲染辅助 + spawnParticle）
  // 已抽到独立模块 public/js/live-view.js（window.LiveView）。
  // 房间赛道（G.renderRacePanel）与大厅全服直播（hero.js）共用同一工厂，
  // 这里只保留别名引用。
  G.makeLiveView = LiveView.create;

  // 鹿茸成长倒计时：把服务器下发的绝对时间戳换算成剩余秒数实时更新按钮。
  // 服务器只在下发快照时给 antlerLeftMs，客户端需要本地计时才能逐秒递减；
  // 到 0 时自动重渲染，按钮从"鹿茸成长中"变成可点击的"收割鹿茸"。
  function updateAntlerCountdowns() {
    if (!G.me || !G.me.deers) return;
    const now = Date.now();
    for (const d of G.me.deers) {
      if (d.antlerLeftMs <= 0) continue; // 已可收割，无需处理
      const until = d.antlerGrowUntil || 0;
      const left = until > 0 ? Math.max(0, until - now) : 0;
      const leftSec = Math.ceil(left / 1000);
      document.querySelectorAll(`[data-antler="${d.id}"]`).forEach((el) => {
        // 只更新标签文字，保留图标 span（.act-lbl）
        const lbl = el.querySelector(".act-lbl");
        if (lbl) lbl.textContent = `成长中 ${leftSec}s`;
        else el.textContent = `鹿茸成长中 ${leftSec}s`;
      });
      // 到期：让按钮恢复成可收割（重渲染当前视图即可）
      if (left <= 0) {
        if (G.stableSel === d.id) G.renderStableDetail();
        if (PADDOCK.caughtId === d.id) renderPaddockBar();
        syncPaddockDeers();
      }
    }
  }

  // ===== 事件监听注册 =====
  G.registers.push((socket) => {
    // 鹿茸成长倒计时：本地每秒更新所有 [data-antler] 按钮（可收割时自动变收割按钮）
    setInterval(updateAntlerCountdowns, 1000);

    // 投注倒计时
    socket.on("countdown", (n) => {
      G.countdownVal = n;
      G.ui.betTimer.style.display = "inline-flex";
      G.ui.betTimerNum.textContent = n;
    });

    // 比赛位置（全服广播，只处理自己房间的比赛）
    socket.on("racePositions", (data) => {
      if (!G.room?.raceState || data.roomId !== G.room.roomId) return;
      if (G.roomLive) G.roomLive.setPositions(data.positions);
    });

    // 随机事件动画（全服广播，只处理自己房间的比赛）
    socket.on("raceEvent", (ev) => {
      if (!G.room?.raceState || ev.roomId !== G.room.roomId) return;
      if (G.roomLive) G.roomLive.playEvent(ev);
    });

    // 商店自动刷新倒计时 + 手动刷新花费（每秒更新）
    socket.on("shopTimer", (data) => {
      if (G.room && data.roomId !== G.room.roomId) return;
      const timerEl = document.getElementById("shopTimer");
      if (timerEl)
        timerEl.textContent =
          data.seconds > 0 ? `自动刷新 ${data.seconds}s` : "";
      const btn = document.getElementById("refreshShopBtn");
      if (btn && data.cost != null)
        btn.textContent = `🔄 刷新货架 (${data.cost}金)`;
    });

    // 鹿操作反馈（查验 / 卖出 / 挂出 / 收回 / 租用 / 归还 / 训练）
    socket.on("deerInfo", (r) => {
      if (!r.ok) return;
      // 训练结果：随机提升了一项属性（必须告知玩家练到了哪项）
      if (r.trained) {
        G.showToast(
          `✨ 训练成功：${ATTR_TEXT[r.attr] || r.attr} +${r.gain}`,
          "ok",
        );
        return;
      }
      if (r.sold) {
        G.showToast(`💰 已卖出 ${r.name}，获得 ${r.refund} 金币`, "ok");
        return;
      }
      if (r.listed) {
        G.showToast(
          `📢 已挂出 ${r.name} 到出租市场（${r.rentPrice}金/场）`,
          "ok",
        );
        return;
      }
      if (r.unrented) {
        G.showToast(`↩️ 已收回 ${r.name}`, "ok");
        return;
      }
      if (r.rented) {
        G.showToast(
          `🤝 已租用 ${r.name}（${r.rentPrice}金/场，赛后自动归还）`,
          "ok",
        );
        return;
      }
      if (r.returned) {
        G.showToast(`↩️ 已归还 ${r.name}`, "ok");
        return;
      }
      if (r.bred) {
        G.showToast(
          `💞 配种成功！新小鹿「${r.name}」诞生（品质 ${r.quality}）`,
          "ok",
        );
        return;
      }
      if (r.fed) {
        G.showToast(
          r.grown
            ? `🍼 小鹿 ${r.name} 长大了！${ATTR_TEXT[r.attr]} +${r.gain}`
            : `🍼 喂养 ${r.name}：${ATTR_TEXT[r.attr]} +${r.gain}`,
          "ok",
        );
        return;
      }
      if (r.antler) {
        G.showToast(`🌿 收割鹿茸成功，获得 ${r.gold} 金币！`, "ok");
        return;
      }
      G.showToast(
        `查验完成：${r.name} 速度 ${r.attrs.speed}星 / 耐力 ${r.attrs.stamina}星 / 敏捷 ${r.attrs.agility}星`,
        "ok",
      );
    });

    // 比赛结果
    socket.on("raceResult", (result) => {
      if (result.roomId && G.room && result.roomId !== G.room.roomId) return;
      G.countdownVal = null;
      G.ui.betTimer.style.display = "none";
      // 显示完整结果框
      const box = document.getElementById("resultBox");
      box.style.display = "block";
      const medals = ["🥇", "🥈", "🥉"];
      const rows = result.finishOrder
        .map(
          (f, i) => `
          <div class="result-row ${i === 0 ? "champ" : ""}">
            <span class="result-rank">${medals[i] || i + 1}</span>
            <span class="result-name">${G.escapeHtml(f.name)}</span>
            <span class="result-owner">${G.escapeHtml(f.owner)}</span>
          </div>`,
        )
        .join("");
      box.innerHTML = `
        <div class="result-champ">🏆 ${G.escapeHtml(result.winner)}</div>
        <div class="result-sub">夺得冠军</div>
        <div class="result-list">${rows}</div>`;
      // 个人投注结算
      if (G.me?.lastBetResult === "win") {
        G.showToast(`🎉 你赢了 ${G.me.lastBetGold} 金币！`);
      } else if (G.me?.lastBetResult === "lose") {
        G.showToast(`可惜没中，再接再厉！`);
      }
      // 冠军撒花
      for (let i = 0; i < 12; i++) {
        setTimeout(() => LiveView.spawnParticle(G.ui.trackSurface), i * 60);
      }
    });
  });
})();
