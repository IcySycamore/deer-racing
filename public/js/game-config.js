/* =========================================================
   game-config.js — 游戏平衡配置（两端唯一事实源）
   Node 端：require("./public/js/game-config.js") 得到 GameConfig
   浏览器端：<script src="/js/game-config.js"> 得到 window.GameConfig
   规则只在这里定义一份：投注玩法/赔率公式/赛道车道/费用/倒计时
   ========================================================= */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.GameConfig = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const GameConfig = {
    // 赛道车道数（服务器生成物件与前端渲染必须一致）
    LANES: 6,
    // 比赛类型（房主可选的三种）
    RACE_TYPES: ["sprint", "endurance", "obstacle"],
    // 赛道物件渲染位移：物件渲染位置 = 判定点 + RENDER_OFFSET
    RENDER_OFFSET: 3,
    // 跳跃落点余量（起跳 pos -> 落地 renderPos + JUDGE_X，跨度必须 < 物件最小间隔）
    JUDGE_X: 1,
    // 赛道总长度（内部逻辑单位，0 ~ TRACK_LEN）。加大后比赛更久、物件分布更开。
    // 广播给前端时统一归一化到 0-100（live-view 渲染假设 0-100，无需改动）。
    TRACK_LEN: 125,
    // 将内部赛道坐标(0~TRACK_LEN)归一化为前端坐标(0~100)的系数
    trackScale: function (v) {
      return (v * 100) / this.TRACK_LEN;
    },

    // 投注玩法：类型 -> 选几只鹿 + 中奖赔率倍率
    // 结算规则统一为：组合赔率均值 × mult（win/place 是单鹿，均值即该鹿赔率）
    BET_TYPES: {
      win: { need: 1, mult: 1 },
      place: { need: 1, mult: 0.5 },
      quinella: { need: 2, mult: 0.8 },
      trifecta: { need: 3, mult: 0.7 },
    },
    // 投注最低金额
    MIN_BET: 10,
    // 投注倒计时（秒，房主可在准备页配置 1~199 秒）
    BET_COUNTDOWN: 15,
    BET_COUNTDOWN_MAX: 199,
    // 参赛费：出战（选鹿参赛）扣费，赛前退赛返还
    ENTRY_FEE: 200,
    // 冠军奖励
    WINNER_REWARD: 1200,
    // 查验鹿属性花费
    INSPECT_COST: 200,

    // ===== 鹿老去 / 生命周期 =====
    // 参赛场次达到上限后退役：不能再参赛/出租/配种，只能卖出
    MAX_RACES: 25,
    // 每场比赛后的衰减比例：上限衰减大、当前属性衰减小
    RACE_CAP_DECAY: 0.015, // 属性上限每次 -1.5%
    RACE_ATTR_DECAY: 0.005, // 当前属性每次 -0.5%

    // ===== 特技机制 =====
    // 商店/配种出生的鹿按品质获得一个特技的概率（品质越高越稀有，0.01%~2%）
    // 品质 1 → 0.01% · 2 → 0.05% · 3 → 0.2% · 4 → 0.8% · 5 → 2%
    TRICK_CHANCES: {
      1: 0.0001,
      2: 0.0005,
      3: 0.002,
      4: 0.008,
      5: 0.02,
    },
    // 特技池：每头鹿最多一个特技，比赛引擎中按特技生效
    // effect 是给比赛引擎读的 key，前端只展示 name/desc/icon
    TRICKS: {
      swift: {
        name: "疾风起跑",
        icon: "🌪️",
        desc: "起跑阶段爆发加速，开局领先",
        effect: "startBoost",
      },
      endurance: {
        name: "耐力冠军",
        icon: "🛡️",
        desc: "体力消耗大幅降低，后程不掉速",
        effect: "fatigueReduce",
      },
      obstacle: {
        name: "障碍大师",
        icon: "🚀",
        desc: "跳跃判定概率提升，更易跨过障碍",
        effect: "jumpBoost",
      },
      sprint: {
        name: "爆发冲刺",
        icon: "⚡",
        desc: "赛程后半段再次加速冲刺",
        effect: "lateSprint",
      },
      item: {
        name: "道具亲和",
        icon: "🍀",
        desc: "拾取道具效果持续时间延长",
        effect: "itemDuration",
      },
    },
    // 按品质 roll 是否获得特技
    rollTrick: function (quality) {
      const chance = this.TRICK_CHANCES[quality] || 0;
      if (Math.random() >= chance) return null;
      const keys = Object.keys(this.TRICKS);
      return keys[Math.floor(Math.random() * keys.length)];
    },
    // 特技查询（key -> {name,icon,desc,effect}），不存在返回 null
    trickInfo: function (key) {
      return key ? this.TRICKS[key] || null : null;
    },

    // ===== 鹿茸 =====
    // 收割后需成长 ANTLER_GROW_MS 才能再次收割；价值 = 品质×ANTLER_BASE + 随机(0~ANTLER_RAND)
    // 30 分钟成长周期，避免高频收割破坏经济平衡
    ANTLER_GROW_MS: 30 * 60 * 1000,
    ANTLER_BASE: 80,
    ANTLER_RAND: 120,

    // ===== 配种 =====
    // 花费 + 父母配种冷却（毫秒）
    BREED_COST: 300,
    BREED_CD_MS: 3 * 60 * 1000,

    // ===== 小鹿喂养 =====
    // 花费 + 喂养 N 次成年（成年后才能参赛/出租/配种）
    FEED_COST: 50,
    FAWN_FEED_NEED: 3,

    // 训练费用：皇室战争式普通卡升级曲线——前期便宜、逐步递增
    // cost(n) = 20 × 1.35^n，取整到 5 的倍数
    // n=0:20 · n=2:35 · n=5:90 · n=8:220 · n=10:400（配合 1200 夺冠奖，前期性价比高）
    TRAIN_BASE: 20,
    TRAIN_GROWTH: 1.35,
    trainCost: function (count) {
      const v = this.TRAIN_BASE * Math.pow(this.TRAIN_GROWTH, count || 0);
      return Math.round(v / 5) * 5;
    },
    // 训练收益：随训练次数递增（3~6 点），投入越高单次提升越大
    trainGain: function (trained) {
      return 3 + Math.floor((trained || 0) / 5);
    },

    // 属性转星级（1-10）
    attrStars: function (v) {
      return Math.max(1, Math.min(10, Math.round(v / 10)));
    },

    // 中奖赔率倍率：oddsArr 是该组合各鹿的赔率（按投注顺序）
    // 返回 0 表示类型/鹿数不合法；调用方负责"是否中奖"的判定
    comboOdds: function (type, oddsArr) {
      const t = this.BET_TYPES[type];
      if (!t || !oddsArr || oddsArr.length !== t.need) return 0;
      let sum = 0;
      for (const o of oddsArr) sum += parseFloat(o);
      return (sum / oddsArr.length) * t.mult;
    },
  };

  return GameConfig;
});
