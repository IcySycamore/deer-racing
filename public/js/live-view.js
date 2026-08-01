/* =========================================================
   live-view.js — 直播视图工厂模块
   房间内赛道渲染与大厅全服直播共用同一套渲染 + 摄像头逻辑。
   两个 adapter（房间视图 + 全服直播）都只依赖这一个接口，
   hero.js 无需再依赖整个比赛模块。
   暴露：window.LiveView = { create(opts), spawnParticle(surface) }
   ========================================================= */
(function () {
  "use strict";
  const G = window.Game;
  if (!G) return;

  // ===== 平直赛道参数（摄像头模式）=====
  // 车道数与共享配置同源（服务器生成物件与前端渲染一致）
  const LANES = GameConfig.LANES;
  const LANE_TOP = 27; // 第一条跑道中线 y(%)（相对 surface）
  const LANE_GAP = 9; // 跑道间距(%)
  // surface 始终固定 300% 宽：全局视角 = scale(1/3) 收进视口；跟随视角 = translateX 平移取景
  const SURFACE_W = 300;
  const VIEW_RATIO = SURFACE_W / 100; // 视口占 surface 的比例（1/3）
  const SCALE_GLOBAL = 1 / VIEW_RATIO;

  function laneCenter(idx) {
    return LANE_TOP + idx * LANE_GAP;
  }

  // 把元素放到 surface 坐标的 (progress 0-100, lane) 位置
  function placeObject(el, progress, lane) {
    el.style.left = progress + "%";
    el.style.top = laneCenter(lane) + "%";
    el.style.transform = "translate(-50%, -50%)";
  }

  function placeLine(el, progress) {
    el.style.left = progress + "%";
    el.style.top = laneCenter(0) - LANE_GAP / 2 + "%";
    el.style.height = LANES * LANE_GAP + "%";
  }

  // 把鹿放到 surface 坐标的 (progress 0-100, lane) 位置，头朝右
  function placeDeer(el, progress, idx) {
    el.style.left = progress + "%";
    el.style.top = laneCenter(idx) + "%";
  }

  // 随机小粒子（灰尘/花瓣，渲染氛围）
  function spawnParticle(surface) {
    const p = document.createElement("div");
    p.className = "particle";
    p.style.left = Math.random() * 90 + "%";
    p.style.top = Math.random() * 90 + "%";
    p.style.setProperty("--tx", (Math.random() - 0.5) * 40 + "px");
    p.style.setProperty("--ty", (Math.random() - 0.5) * 40 + "px");
    surface.appendChild(p);
    setTimeout(() => p.remove(), 800);
  }

  // 通用直播视图工厂：房间内赛道与大厅全服直播共用同一套渲染 + 摄像头逻辑
  // opts: { surface, container, controls, autoRotate, rotateMs, globalFit, minimap, betDeerIds }
  //   betDeerIds: 我押注的鹿 id 数组（头顶显示 🔻 倒三角箭头；房间内传入，大厅直播不传）
  // 摄像头原理：surface 固定 300% 宽完整渲染，视口(overflow:hidden)通过 transform 取景
  //   全局视角 = 整条赛道(scale 1/3)；跟随视角 = 平移视口到目标鹿周围
  //   globalFit: true 时全局视角改为"自适应缩放"——囊括首尾鹿并向外扩展
  //   minimap: true 时在容器底部显示赛道导航小窗（点线缩略图）
  function makeLiveView(opts) {
    const surface = opts.surface;
    const container = opts.container;
    const controls = !!opts.controls;
    const autoRotate = !!opts.autoRotate;
    const rotateMs = opts.rotateMs || 4000;
    const globalFit = !!opts.globalFit;
    const minimap = !!opts.minimap;
    // 自适应全局视角向外扩展的区间（赛道单位 0-100）
    const FIT_PAD = 12;
    const MIN_FIT_W = 25;

    const view = {
      racers: [],
      trackObjects: [],
      mode: autoRotate ? "global" : "follow",
      followIdx: 0,
      rotateTimer: null,
      disposed: false,
      lastPositions: [],
      laneOf: [], // 每只鹿当前车道（换道事件更新）
      betSet: new Set((opts.betDeerIds || []).map(String)), // 我押注的鹿 id
      fitRange: { lo: 0, hi: 100 }, // 当前视野范围（赛道单位）
      minimapEl: null,
      minimapTrack: null,
    };

    // 更新押注鹿集合：投注后刷新头顶箭头（增删，不重建视图）
    view.setBets = function (ids) {
      view.betSet = new Set((ids || []).map(String));
      if (!surface) return;
      surface.querySelectorAll(".race-deer").forEach((el, idx) => {
        const r = view.racers[idx];
        if (!r) return;
        const marker = el.querySelector(".bet-marker");
        if (view.betSet.has(String(r.deer.id))) {
          if (!marker) {
            const m = document.createElement("div");
            m.className = "bet-marker";
            m.textContent = "🔻";
            el.appendChild(m);
          }
        } else if (marker) {
          marker.remove();
        }
      });
    };

    // ---------- 摄像头 ----------
    view.applyCamera = function () {
      if (view.disposed) return;
      surface.style.transformOrigin = "0 0";
      if (view.mode === "global") {
        if (globalFit && view.lastPositions.length) {
          let minX = Math.min(...view.lastPositions);
          let maxX = Math.max(...view.lastPositions);
          let lo = Math.max(0, minX - FIT_PAD);
          let hi = Math.min(100, maxX + FIT_PAD);
          // 保证最小视口范围（鹿挤在一起时也别缩得太小）
          if (hi - lo < MIN_FIT_W) {
            const mid = (lo + hi) / 2;
            lo = Math.max(0, mid - MIN_FIT_W / 2);
            hi = Math.min(100, mid + MIN_FIT_W / 2);
            if (hi - lo < MIN_FIT_W) {
              // 起点/终点极端情况：贴边对齐
              if (mid < 50) {
                lo = 0;
                hi = MIN_FIT_W;
              } else {
                lo = 100 - MIN_FIT_W;
                hi = 100;
              }
            }
          }
          const W = hi - lo;
          // 视口(100%容器)覆盖 W 个赛道单位：S = 33.333 / W
          const S = 33.333 / W;
          // 视口左缘对齐 lo：tx = -lo * S（translateX 相对 surface 自身宽 300%）
          view.fitRange = { lo, hi };
          surface.style.transform = `translateX(${-(lo * S).toFixed(4)}%) scale(${S.toFixed(5)})`;
        } else {
          view.fitRange = { lo: 0, hi: 100 };
          surface.style.transform = `scale(${SCALE_GLOBAL})`;
        }
        if (minimap) updateMinimapViewport();
        return;
      }
      const deer = surface.querySelector(".race-deer.deer-" + view.followIdx);
      if (!deer) return;
      let x = parseFloat(deer.style.left) || 0; // surface 坐标 0~100
      const viewW = 100 / VIEW_RATIO; // 33.33（% of surface）
      // translateX 以 surface 自身宽度为基准，clamp 防止视口越出赛道
      const minTx = -(100 - viewW); // 视口右缘不越过赛道右缘
      const maxTx = 0; // 视口左缘不越过赛道左缘
      let tx = -(x - viewW / 2);
      tx = Math.max(minTx, Math.min(maxTx, tx));
      surface.style.transform = `scale(1) translateX(${tx}%)`;
      if (minimap) {
        view.fitRange = {
          lo: Math.max(0, x - viewW / 2),
          hi: Math.min(100, x + viewW / 2),
        };
        updateMinimapViewport();
      }
    };

    // 切换视角：只改 transform 与按钮高亮，不重建（鹿不会跳动、赛道不会闪烁）
    view.setMode = function (mode) {
      view.mode = mode;
      syncHighlight();
      view.applyCamera();
    };

    function syncHighlight() {
      if (!controls) return;
      const g = document.getElementById("viewGlobalBtn");
      const f = document.getElementById("viewFollowBtn");
      if (g) g.classList.toggle("active", view.mode === "global");
      if (f) f.classList.toggle("active", view.mode === "follow");
    }

    // ---------- 自动轮换视角（大厅直播用，无控件）----------
    function startAutoRotate() {
      stopAutoRotate();
      view.rotateTimer = setInterval(() => {
        if (view.disposed) return;
        if (view.mode === "global") {
          // 全局 -> 随机跟随一只鹿
          const n = view.racers.length;
          view.followIdx = n > 1 ? Math.floor(Math.random() * n) : 0;
          view.setMode("follow");
        } else {
          // 跟随 -> 全局
          view.setMode("global");
        }
      }, rotateMs);
    }
    function stopAutoRotate() {
      if (view.rotateTimer) {
        clearInterval(view.rotateTimer);
        view.rotateTimer = null;
      }
    }

    // ---------- 渲染赛道 ----------
    view.setRace = function (rs) {
      view.racers = rs.racers;
      view.trackObjects = rs.trackObjects || [];
      view.laneOf = view.racers.map((_, i) => i);
      view.followIdx = 0;
      build();
      view.applyCamera();
      // 只有大厅直播才自动轮换视角；房间内视角由用户按钮控制
      if (autoRotate) startAutoRotate();
    };

    function build() {
      // 清空 surface 与容器上的旧工具条/导航小窗
      surface
        .querySelectorAll(
          ".race-deer,.particle,.track-ground,.track-road,.lane-line,.start-line,.finish-line,.track-object,.race-event-bubble",
        )
        .forEach((e) => e.remove());
      if (container) {
        container.querySelectorAll(".view-bar").forEach((e) => e.remove());
        container.querySelectorAll(".track-minimap").forEach((e) => e.remove());
      }
      view.minimapEl = null;
      view.minimapTrack = null;
      view.lastPositions = new Array(view.racers.length).fill(0);

      surface.style.width = SURFACE_W + "%";
      surface.style.height = "100%";

      // 草地背景（surface 全宽）
      const ground = document.createElement("div");
      ground.className = "track-ground";
      surface.appendChild(ground);

      // 泥土跑道带（surface 全宽，跑道区域高度）
      const road = document.createElement("div");
      road.className = "track-road";
      road.style.top = laneCenter(0) - LANE_GAP / 2 + "%";
      road.style.height = LANES * LANE_GAP + "%";
      surface.appendChild(road);

      // 跑道分隔线（6 条跑道的 7 条线）
      for (let i = 0; i <= LANES; i++) {
        const ln = document.createElement("div");
        ln.className = "lane-line";
        ln.style.top = laneCenter(0) - LANE_GAP / 2 + i * LANE_GAP + "%";
        surface.appendChild(ln);
      }

      // 起跑线 & 终点线（surface 坐标 x=0 和 x=100）
      const start = document.createElement("div");
      start.className = "start-line";
      placeLine(start, 0);
      surface.appendChild(start);
      const finish = document.createElement("div");
      finish.className = "finish-line";
      placeLine(finish, 100);
      surface.appendChild(finish);

      // 赛道物件：每个物体画在它所属的车道上（renderPos = 判定点 + 固定位移）
      view.trackObjects.forEach((obj) => {
        const o = document.createElement("div");
        o.className = "track-object obj-" + obj.type;
        o.dataset.pos = obj.pos;
        // 草是 emoji 表现，道具点是图标
        if (obj.type === "grass") o.textContent = "🌿";
        if (obj.type === "powerup") o.textContent = "🎁";
        placeObject(o, obj.renderPos ?? obj.pos, obj.lane || 0);
        surface.appendChild(o);
      });

      // 参赛鹿（每只一条跑道）
      view.racers.forEach((r, idx) => {
        const deerEl = document.createElement("div");
        deerEl.className = "race-deer deer-" + idx;
        const ownerTag =
          r.ownerId === G.myId ? '<span class="mine">(我)</span>' : "";
        const betMark = view.betSet.has(String(r.deer.id))
          ? '<div class="bet-marker">🔻</div>'
          : "";
        deerEl.innerHTML = `${betMark}<div class="deer-body">🦌</div><div class="name-tag">${G.escapeHtml(r.deer.fullName)} ${ownerTag}</div>`;
        surface.appendChild(deerEl);
        placeDeer(deerEl, 0, idx);
      });

      if (controls) buildViewBar();
      if (minimap) buildMinimap();
    }

    // 导航小窗：赛道缩略图（线）+ 鹿点 + 当前视野框
    function buildMinimap() {
      if (!container) return;
      const mm = document.createElement("div");
      mm.className = "track-minimap";
      const track = document.createElement("div");
      track.className = "mm-track";
      const start = document.createElement("div");
      start.className = "mm-line mm-start";
      const finish = document.createElement("div");
      finish.className = "mm-line mm-finish";
      const vp = document.createElement("div");
      vp.className = "mm-viewport";
      // 物件小标记：细竖线，按类型配色（renderPos = 判定点 + 固定位移）
      view.trackObjects.forEach((obj) => {
        const o = document.createElement("div");
        o.className = "mm-obj obj-" + obj.type;
        o.style.left = (obj.renderPos ?? obj.pos) + "%";
        track.appendChild(o);
      });
      track.append(start, finish, vp);
      mm.appendChild(track);
      container.appendChild(mm);
      view.minimapEl = mm;
      view.minimapTrack = track;
      // 初始视野框
      view.fitRange = { lo: 0, hi: 100 };
      updateMinimapViewport();
    }

    function updateMinimapViewport() {
      if (!view.minimapEl || !view.minimapTrack) return;
      const vp = view.minimapTrack.querySelector(".mm-viewport");
      if (vp) {
        vp.style.left = view.fitRange.lo + "%";
        vp.style.width = Math.max(2, view.fitRange.hi - view.fitRange.lo) + "%";
      }
    }

    function updateMinimapDeers() {
      if (!view.minimapTrack) return;
      // 固定配色（黑/红/绿/蓝/金/紫/青/粉），用圆点代表参赛鹿（物体才是线条）
      const MM_COLORS = [
        "#1a1a1a",
        "#e5484d",
        "#2ec98d",
        "#3b82f6",
        "#e8a33d",
        "#a855f7",
        "#14b8a6",
        "#f43f5e",
      ];
      view.lastPositions.forEach((pos, idx) => {
        let dot = view.minimapTrack.querySelector(".mm-deer.mm-" + idx);
        if (!dot) {
          dot = document.createElement("span");
          dot.className = "mm-deer mm-" + idx;
          dot.style.background = MM_COLORS[idx % MM_COLORS.length];
          view.minimapTrack.appendChild(dot);
        }
        dot.style.left = pos + "%";
      });
    }

    // 视角工具条（房间内显示，固定在容器上不随镜头移动）
    function buildViewBar() {
      if (!container) return;
      const bar = document.createElement("div");
      bar.className = "view-bar";
      bar.innerHTML = `
        <button class="view-btn global ${view.mode === "global" ? "active" : ""}" id="viewGlobalBtn">全局视角</button>
        <button class="view-btn follow ${view.mode === "follow" ? "active" : ""}" id="viewFollowBtn">跟随视角</button>
        <label class="view-follow-label">跟随:
          <select id="viewFollowSel">${view.racers
            .map(
              (r, i) =>
                `<option value="${i}" ${i === view.followIdx ? "selected" : ""}>${G.escapeHtml(r.deer.fullName)}</option>`,
            )
            .join("")}</select>
        </label>`;
      container.appendChild(bar);
      document
        .getElementById("viewGlobalBtn")
        .addEventListener("click", () => view.setMode("global"));
      document
        .getElementById("viewFollowBtn")
        .addEventListener("click", () => view.setMode("follow"));
      document
        .getElementById("viewFollowSel")
        .addEventListener("change", (e) => {
          view.followIdx = parseInt(e.target.value, 10);
          view.applyCamera();
        });
    }

    // ---------- 位置更新 ----------
    view.setPositions = function (positions) {
      view.lastPositions = positions.slice();
      positions.forEach((pos, idx) => {
        const el = surface.querySelector(".race-deer.deer-" + idx);
        if (el) placeDeer(el, pos, view.laneOf[idx] ?? idx);
      });
      view.applyCamera();
      if (minimap) updateMinimapDeers();
      if (Math.random() < 0.3) spawnParticle(surface);
    };

    // ---------- 随机事件动画 ----------
    view.playEvent = function (ev) {
      const el = surface.querySelector(".race-deer.deer-" + ev.deerIndex);
      if (!el) return;
      // 换道事件：更新车道并立即移动到新车道（动画由 CSS transition 完成）
      if (ev.type === "laneChange") {
        view.laneOf[ev.deerIndex] = ev.lane;
        placeDeer(el, ev.pos ?? view.lastPositions[ev.deerIndex] ?? 0, ev.lane);
      }
      // 事件文字气泡：放在物件位置（随镜头平移，位置与物件一致）
      const bubble = document.createElement("div");
      bubble.className =
        "race-event-bubble " +
        (ev.type === "graze" ||
        ev.type === "jump" ||
        ev.type === "boost" ||
        ev.type === "shield" ||
        ev.type === "powerup" ||
        ev.type === "skillSprint" ||
        ev.type === "skillFocus" ||
        ev.type === "skillRecover" ||
        ev.type === "momentum"
          ? "good"
          : "bad");
      const textMap = {
        hole: "掉进洞里",
        obstacle: "撞上障碍",
        jump: "跳了过去",
        twist: "崴脚了",
        graze: "停下吃草",
        powerup: ev.kind === "attack" ? "🎁 道具攻击！" : "🎁 拾取道具",
        boost: "💨 冲刺加速！",
        attack: "💥 被道具攻击！",
        shield: "🛡️ 护盾生效",
        laneChange: "↔️ 变道",
        runoff: "😱 冲出赛道！",
        bump: "💢 撞车！",
        skillSprint: "⚡ 爆发冲刺！",
        skillFocus: "🧘 全神贯注",
        skillRecover: "🍀 体力回复",
        momentum: "🔥 状态火热！",
        pebble: "🪨 踩到石子",
      };
      bubble.textContent = textMap[ev.type] || ev.type;
      surface.appendChild(bubble);
      const x = ev.pos ?? 0;
      bubble.style.left = x + "%";
      const bubbleLane =
        ev.type === "laneChange" ? (ev.lane ?? ev.deerIndex) : ev.deerIndex;
      bubble.style.top = laneCenter(bubbleLane) - 5 + "%";
      setTimeout(() => bubble.remove(), 2300);

      // 鹿的动画（动画加在外层 .race-deer 上，不影响 left/top 定位）
      const animMap = {
        hole: "deer-holed",
        obstacle: "deer-stumble",
        jump: "deer-jump",
        twist: "deer-twist",
        graze: "deer-graze",
        boost: "deer-boost",
        attack: "deer-stun",
        shield: "deer-shield",
        runoff: "deer-runoff",
        bump: "deer-bump",
        skillSprint: "deer-boost",
        momentum: "deer-boost",
        skillFocus: "deer-shield",
        pebble: "deer-stumble",
      };
      const cls = animMap[ev.type];
      if (cls) {
        el.classList.remove(
          "deer-holed",
          "deer-stumble",
          "deer-jump",
          "deer-twist",
          "deer-graze",
          "deer-boost",
          "deer-stun",
          "deer-shield",
          "deer-runoff",
          "deer-bump",
        );
        // 中招动画（掉洞/撞障碍/吃草/冲出赛道/踩石子）：先把鹿瞬间定位到事件点再播动画，
        // 否则 transition 滞后 + 步进超调会让鹿视觉上冲过物件（右侧）才触发
        if (
          ev.type === "hole" ||
          ev.type === "obstacle" ||
          ev.type === "graze" ||
          ev.type === "runoff" ||
          ev.type === "pebble"
        ) {
          const wasTransition = el.style.transition;
          el.style.transition = "none";
          placeDeer(el, ev.pos, view.laneOf[ev.deerIndex] ?? ev.deerIndex);
          void el.offsetWidth; // 强制重排，让定位立即生效
          el.style.transition = wasTransition;
        }
        void el.offsetWidth; // 强制重绘以重启动画
        el.classList.add(cls);
        setTimeout(() => el.classList.remove(cls), 2300);
      }
    };

    // ---------- 释放 ----------
    view.dispose = function () {
      view.disposed = true;
      stopAutoRotate();
      surface
        .querySelectorAll(
          ".race-deer,.particle,.track-ground,.track-road,.lane-line,.start-line,.finish-line,.track-object,.race-event-bubble",
        )
        .forEach((e) => e.remove());
      if (container) {
        container.querySelectorAll(".view-bar").forEach((e) => e.remove());
        container.querySelectorAll(".track-minimap").forEach((e) => e.remove());
      }
      view.minimapEl = null;
      view.minimapTrack = null;
    };

    return view;
  }

  // 对外接口：create（直播视图工厂）+ spawnParticle（冠军撒花等共用）
  window.LiveView = {
    create: makeLiveView,
    spawnParticle: spawnParticle,
  };
})();
