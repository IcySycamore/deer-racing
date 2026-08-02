/* =========================================================
   game-formulas.js — 公式库（所有可复算的逻辑公式）
   Node 端：require("./public/js/game-formulas.js") 得到 GameFormulas
   浏览器端：<script src="/js/game-formulas.js"> 得到 window.GameFormulas
   这里只有"公式"（纯函数），数值一律读 game-values.js（GameValues）。
   ========================================================= */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.GameFormulas = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // 浏览器端的全局对象（供取值用，替代外部 IIFE 的 root）
  const R =
    typeof self !== "undefined"
      ? self
      : typeof global !== "undefined"
        ? global
        : this;

  // 数值配置（两端同源）
  const V =
    typeof module === "object" && module.exports
      ? require("./game-values.js")
      : R.GameValues || {};

  // ============ 赛道坐标 ============
  // 内部坐标(0~len) → 前端坐标(0~100)
  function trackScale(v, len) {
    const L = len || V.FLAT_TRACK.default || 100;
    return (v * 100) / L;
  }
  // 前端坐标(0~100) → 内部坐标
  function trackUnscale(p, len) {
    const L = len || V.FLAT_TRACK.default || 100;
    return (p * L) / 100;
  }

  // ============ 赛道配置解析 ============
  // 从房间 raceConfig 计算"内部赛道总长"
  function effectiveTrackLen(cfg) {
    if (!cfg) return V.FLAT_TRACK.default;
    if (cfg.type === "lap") {
      const laps = clamp(
        cfg.laps || V.LAP.defaultLaps,
        V.LAP.minLaps,
        V.LAP.maxLaps,
      );
      return laps * V.LAP.lapLen;
    }
    if (cfg.type === "hill") {
      return clamp(
        cfg.summit || V.HILL.defaultSummit,
        V.HILL.minSummit,
        V.HILL.maxSummit,
      );
    }
    return clamp(
      cfg.trackLen || V.FLAT_TRACK.default,
      V.FLAT_TRACK.min,
      V.FLAT_TRACK.max,
    );
  }

  // 规范化房间 raceConfig（补默认值 + 校验范围）
  function normalizeRaceConfig(raw) {
    raw = raw || {};
    const type = V.RACE_TYPES.includes(raw.type) ? raw.type : "sprint";
    const lanes = clamp(
      Number(raw.lanes) || V.LANE.default,
      V.LANE.min,
      V.LANE.max,
    );
    // 鹿数 ≤ 赛道数-1（满足 鹿数<赛道数）；且≥DEER.min
    const maxDeer = Math.max(V.DEER.min, lanes - 1);
    const deerCount = clamp(
      Number(raw.deerCount) || Math.min(V.DEER.default, maxDeer),
      V.DEER.min,
      maxDeer,
    );
    return {
      type,
      lanes,
      deerCount,
      trackLen: clamp(
        Number(raw.trackLen) || V.FLAT_TRACK.default,
        V.FLAT_TRACK.min,
        V.FLAT_TRACK.max,
      ),
      laps: clamp(
        Number(raw.laps) || V.LAP.defaultLaps,
        V.LAP.minLaps,
        V.LAP.maxLaps,
      ),
      angle: clamp(
        Number(raw.angle) || V.HILL.defaultAngle,
        V.HILL.minAngle,
        V.HILL.maxAngle,
      ),
      summit: clamp(
        Number(raw.summit) || V.HILL.defaultSummit,
        V.HILL.minSummit,
        V.HILL.maxSummit,
      ),
    };
  }

  function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  }

  // ============ 经济公式 ============
  // 训练费用：BASE × GROWTH^n，取整到 5 的倍数
  function trainCost(count) {
    const v = V.TRAIN_BASE * Math.pow(V.TRAIN_GROWTH, count || 0);
    return Math.round(v / 5) * 5;
  }
  // 训练收益：随次数递增
  function trainGain(trained) {
    return V.TRAIN_GAIN_BASE + Math.floor((trained || 0) / V.TRAIN_GAIN_STEP);
  }
  // 卖出折价：基础价×60% + 养成度加成 + 每冠
  function sellPrice(deer) {
    if (!deer) return 0;
    const price = deer.price || deer.quality * 200;
    const caps = deer.caps || { speed: 100, stamina: 100, agility: 100 };
    const avg = (deer.speed + deer.stamina + deer.agility) / 3;
    const avgCap = (caps.speed + caps.stamina + caps.agility) / 3;
    const fill = avgCap > 0 ? clamp(avg / avgCap, 0, 1) : V.SELL_BASE;
    const champ = deer.champWins || 0;
    return Math.max(
      50,
      Math.floor(
        price * V.SELL_BASE +
          price * V.SELL_FILL * fill +
          champ * V.CHAMP_BONUS,
      ),
    );
  }
  // 商店手动刷新费用：分级封顶
  function shopRefreshCost(count) {
    return Math.min(
      V.SHOP_REFRESH_CAP,
      V.SHOP_REFRESH_BASE * Math.pow(2, count || 0),
    );
  }

  // ============ 属性 / 品质 ============
  // 从品质 roll 一头鹿的属性（区间 + 潜力上限浮动）
  function rollCapsAndAttrs(quality) {
    const r = V.QUALITY_RANGES[quality] || V.QUALITY_RANGES[1];
    const capVar = V.CAP_VAR_BASE + quality * V.CAP_VAR_PER_Q;
    const mkCap = () => Math.min(99, Math.round(r[1] + Math.random() * capVar));
    const caps = { speed: mkCap(), stamina: mkCap(), agility: mkCap() };
    const mk = (cap) => Math.floor(Math.random() * (cap - r[0] + 1)) + r[0];
    return {
      caps,
      speed: mk(caps.speed),
      stamina: mk(caps.stamina),
      agility: mk(caps.agility),
    };
  }
  // 品质分布 roll（商店 / AI 用）
  function rollQuality() {
    const dist = V.SHOP_QUALITY;
    const r = Math.random();
    let acc = 0;
    for (let i = 0; i < dist.length; i++) {
      acc += dist[i];
      if (r < acc) return i + 1;
    }
    return dist.length;
  }
  // 属性转星级（1-10）
  function attrStars(v) {
    return clamp(Math.round(v / 10), 1, 10);
  }

  // ============ 特技 ============
  function rollTrick(quality) {
    const chance = V.TRICK_CHANCES[quality] || 0;
    if (Math.random() >= chance) return null;
    const keys = Object.keys(V.TRICKS);
    return keys[Math.floor(Math.random() * keys.length)];
  }
  function trickInfo(key) {
    return key ? V.TRICKS[key] || null : null;
  }

  // ============ 投注 ============
  function comboOdds(type, oddsArr) {
    const t = V.BET_TYPES[type];
    if (!t || !oddsArr || oddsArr.length !== t.need) return 0;
    let sum = 0;
    for (const o of oddsArr) sum += parseFloat(o);
    return (sum / oddsArr.length) * t.mult;
  }
  // 动态赔率：随投注池波动
  function recalcOdds(rs) {
    if (!rs || !rs.racers || !rs.baseOdds) return;
    const pool = rs.betPool || {};
    const total = Object.values(pool).reduce((s, v) => s + v, 0);
    rs.odds = rs.racers.map((r, i) => {
      const base = parseFloat(rs.baseOdds[i]);
      const share = total > 0 ? (pool[r.deer.id] || 0) / total : 0;
      const o = base * (1 - share * 0.5 + (1 - share) * 0.12);
      return Math.max(1.1, Math.min(10, o)).toFixed(1);
    });
  }
  // 静态赔率（开赛时）：基于属性 + 类型权重
  function staticOdds(racers, type) {
    const w = V.TYPE_WEIGHTS[type] || V.TYPE_WEIGHTS.sprint;
    return racers.map((r) => {
      const d = r.deer;
      const score =
        d.speed * w.speed + d.stamina * w.stamina + d.agility * w.agility;
      return Math.max(1.5, Math.min(8.0, (60 / (score + 10)) * 3)).toFixed(1);
    });
  }

  // ============ 配种 ============
  // 小鹿品质 = 父母均值 + 按权重取 -1/0/+1（clamp 1~5）
  function breedQuality(qA, qB) {
    const avg = Math.round((qA + qB) / 2);
    const w = V.BREED_Q_WEIGHT;
    const idx = Math.floor(Math.random() * w.length);
    return clamp(avg + w[idx], 1, 5);
  }
  // 属性遗传：父母均值 × (0.85~1.15)，受上限约束
  function inheritAttr(x, y, cap, lo) {
    return Math.min(
      cap,
      Math.max(
        lo,
        Math.round(
          ((x + y) / 2) *
            (V.BREED_INHERIT_MIN + Math.random() * V.BREED_INHERIT_RANGE),
        ),
      ),
    );
  }

  // ============ 比赛引擎辅助 ============
  // 基础速度：类型主属性权重 + 起跑敏捷加成
  function baseSpeed(type, d, step) {
    const w = V.TYPE_WEIGHTS[type] || V.TYPE_WEIGHTS.sprint;
    const speed = d.speed / 100;
    const stamina = d.stamina / 100;
    const agility = d.agility / 100;
    let base = speed * w.speed + agility * w.agility + stamina * w.stamina;
    base += Math.random() * 0.1;
    // 起跑反应：前 START_STEPS 步敏捷加成（线性消退）
    base +=
      Math.max(0, 1 - step / V.START_STEPS) * agility * V.START_AGILITY_BONUS;
    return { base, agility };
  }

  // ============ 赛道物件生成（需求7：判定点 + 判定距离格式）============
  // 规则：
  //  - 每个物件有"判定点"pos（鹿到此判定）和"渲染位置"renderPos = pos + RENDER_OFFSET
  //  - 姿态动画（洞/障碍=跳跃姿态，草=非跳跃姿态）判定点之间至少要隔 JUDGE_GAP
  //  - 一旦生成跳跃姿态（洞/障碍），其后姿态判定点必须再额外隔 JUMP_EXTRA_GAP 个判定距离
  //  - 非姿态动画（道具）可随意生成，不受姿态间距约束（但仍隔开避免重叠）
  function generateTrackObjects(cfg) {
    const len = effectiveTrackLen(cfg);
    const lanes = cfg.lanes;
    const spec = V.RACE_OBJECTS[cfg.type] || V.RACE_OBJECTS.sprint;
    const objs = [];
    const RO = V.RENDER_OFFSET;
    const END = len - RO * 3;
    // 姿态物件权重表（洞/障碍/草）
    const poseTypes = ["hole", "obstacle", "grass"];
    const poseW = [spec.hole, spec.obstacle, spec.grass];
    // 姿态判定点间距：JUDGE_GAP × 类型稀疏系数
    const baseGap = V.JUDGE_GAP * (spec.gapMul || 1);
    // 记录最近姿态判定点 与 最近跳跃姿态判定点
    let lastPose = -Infinity; // 最近姿态动画判定点
    let lastJump = -Infinity; // 最近跳跃姿态判定点

    let pos = len * 0.06;
    while (pos < END) {
      // 递增位置（在姿态之间制造距离）
      const step = baseGap * (0.5 + Math.random() * 0.8);
      pos += step;
      if (pos >= END) break;

      // 决定生成哪种姿态（洞/障碍=跳跃姿态，草=非跳跃姿态）
      // 若距离上次跳跃姿态不足 (JUMP_EXTRA_GAP+1) 个判定距离，则跳过跳跃类，只放草或道具
      let roll = Math.random();
      let type = pickWeighted(poseTypes, poseW);
      const isJump = type === "hole" || type === "obstacle";
      const jumpSafe = pos - lastJump >= (V.JUMP_EXTRA_GAP + 1) * baseGap;

      // 姿态间距校验：与最近姿态判定点至少隔 baseGap
      if (pos - lastPose < baseGap) {
        // 太近：退化为不生成姿态（或放道具），避免姿态动画挤在一起
        maybePlacePowerup(objs, pos, lanes, len);
        continue;
      }
      // 跳跃姿态额外约束：不满足则降级为草（非跳跃）或道具
      if (isJump && !jumpSafe) {
        if (Math.random() < 0.5) {
          type = "grass";
        } else {
          maybePlacePowerup(objs, pos, lanes, len);
          continue;
        }
      }

      // 放置姿态物件到随机车道（障碍赛可多车道）
      const isJumpFinal = type === "hole" || type === "obstacle";
      if (cfg.type === "obstacle") {
        for (let lane = 0; lane < lanes; lane++) {
          objs.push({
            pos: Math.round(pos),
            type,
            lane,
            renderPos: Math.round(pos) + RO,
          });
        }
      } else {
        const lane = Math.floor(Math.random() * lanes);
        objs.push({
          pos: Math.round(pos),
          type,
          lane,
          renderPos: Math.round(pos) + RO,
        });
      }
      lastPose = pos;
      if (isJumpFinal) lastJump = pos;
    }

    // 道具点（非姿态，可随意生成）：固定数量，随机分布
    for (let k = 0; k < V.POWERUP_COUNT; k++) {
      const p = len * 0.2 + Math.floor(Math.random() * (len * 0.6));
      objs.push({
        pos: Math.round(p),
        type: "powerup",
        lane: Math.floor(Math.random() * lanes),
        renderPos: Math.round(p) + RO,
      });
    }
    return objs;
  }

  function maybePlacePowerup(objs, pos, lanes, len) {
    const p = pos + (Math.random() - 0.5) * V.JUDGE_GAP;
    if (p < len * 0.1 || p > len * 0.9) return;
    objs.push({
      pos: Math.round(p),
      type: "powerup",
      lane: Math.floor(Math.random() * lanes),
      renderPos: Math.round(p) + V.RENDER_OFFSET,
    });
  }

  function pickWeighted(items, weights) {
    const total = weights.reduce((s, v) => s + v, 0);
    let r = Math.random() * total;
    for (let i = 0; i < items.length; i++) {
      r -= weights[i];
      if (r <= 0) return items[i];
    }
    return items[items.length - 1];
  }

  return {
    trackScale,
    trackUnscale,
    effectiveTrackLen,
    normalizeRaceConfig,
    clamp,
    trainCost,
    trainGain,
    sellPrice,
    shopRefreshCost,
    rollCapsAndAttrs,
    rollQuality,
    attrStars,
    rollTrick,
    trickInfo,
    comboOdds,
    recalcOdds,
    staticOdds,
    breedQuality,
    inheritAttr,
    baseSpeed,
    generateTrackObjects,
  };
});
