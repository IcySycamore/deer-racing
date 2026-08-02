/* =========================================================
   game-values.js — 纯数值配置（所有数值的唯一事实源）
   Node 端：require("./public/js/game-values.js") 得到 GameValues
   浏览器端：<script src="/js/game-values.js"> 得到 window.GameValues
   这里只有"数值"，没有逻辑；公式一律放在 game-formulas.js。
   管理人员只需改这一份文件即可平衡所有数值（概率/权重/时长/上限/花费）。
   ========================================================= */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.GameValues = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  return {
    // =========================================================
    // 车道数 / 参与鹿数（需求4：0 < 最大参与鹿数 < 最大赛道数 < 10）
    // =========================================================
    // 赛道（车道）数量范围
    LANE: { min: 2, max: 9, default: 6 },
    // 单场参赛鹿数上限范围（房间内玩家鹿不足时用 AI 补齐到该数）
    // 上限 8，恒小于最大赛道数 9（满足 鹿数<赛道数<10）
    DEER: { min: 2, max: 8, default: 6 },

    // 物件渲染位移：物件渲染位置 = 判定点 + RENDER_OFFSET（渲染物体在前方）
    RENDER_OFFSET: 3,
    // 跳跃落点余量（起跳 pos -> 落地 renderPos + JUDGE_X）
    JUDGE_X: 1,
    // 判定距离：两个姿态动画（洞/障碍/吃草）判定点之间的最小间隔
    // 跳跃姿态（洞/障碍）生成后，其后的姿态动画判定点至少还要再隔一个该距离
    JUDGE_GAP: 12,

    // =========================================================
    // 赛道模式（需求2/5：平直 / 跑圈 / 山坡）
    // =========================================================
    // 平直赛道（短距/耐力/障碍共用）：长度范围 100~15000
    FLAT_TRACK: { min: 100, max: 15000, default: 125 },
    // 跑圈：单圈固定 400（按标准体育场），可设圈数
    LAP: { lapLen: 400, minLaps: 1, maxLaps: 20, defaultLaps: 3 },
    // 山坡（登顶夺旗）：角度(度) + 登顶距离
    HILL: {
      minAngle: 5,
      maxAngle: 45,
      defaultAngle: 15,
      minSummit: 100,
      maxSummit: 5000,
      defaultSummit: 800,
      // 速度惩罚系数：坡度越陡减速越多，factor = 1 - (angle/maxAngle)*SPEED_PENALTY
      speedPenalty: 0.25,
      // 山坡上疲劳累积加快：factor = 1 + (angle/maxAngle)*FATIGUE_AMP
      fatigueAmp: 0.4,
    },

    // =========================================================
    // 比赛类型与赛道构成（需求1：概率/权重全部下沉到这里）
    // =========================================================
    RACE_TYPES: ["sprint", "endurance", "obstacle", "hill", "lap"],
    // 每种比赛的物件权重（洞/障碍=跳跃姿态，草=非跳跃姿态，道具=非姿态）
    // weights 比例：生成姿态物件时按此权重挑选类型
    // 物件间隔系数（相对 JUDGE_GAP 的倍数）：障碍赛密集、短距/跑圈稀疏
    RACE_OBJECTS: {
      sprint: { hole: 0.15, obstacle: 0.25, grass: 0.6, gapMul: 1.3 },
      endurance: { hole: 0.2, obstacle: 0.3, grass: 0.5, gapMul: 1.0 },
      obstacle: { hole: 0.4, obstacle: 0.35, grass: 0.25, gapMul: 0.6 },
      hill: { hole: 0.15, obstacle: 0.2, grass: 0.65, gapMul: 1.2 },
      lap: { hole: 0.2, obstacle: 0.3, grass: 0.5, gapMul: 0.9 },
    },
    // 道具（非姿态，可随意生成，不受姿态间距约束）数量
    POWERUP_COUNT: 3,
    // 每次跳跃姿态（洞/障碍）生成后，其后姿态判定点必须额外隔开的判定距离数
    JUMP_EXTRA_GAP: 1, // 共 1+1 = 2 个判定距离

    // =========================================================
    // 比赛流程
    // =========================================================
    BET_TYPES: {
      win: { need: 1, mult: 1 },
      place: { need: 1, mult: 0.5 },
      quinella: { need: 2, mult: 0.8 },
      trifecta: { need: 3, mult: 0.7 },
    },
    MIN_BET: 10,
    BET_COUNTDOWN: 15,
    BET_COUNTDOWN_MAX: 199,
    ENTRY_FEE: 200,
    WINNER_REWARD: 1200,
    INSPECT_COST: 200,

    // =========================================================
    // 属性 / 品质（需求1：AI鹿生成分布/区间下沉到这里）
    // =========================================================
    // 品质 -> [属性下限, 属性上限]
    QUALITY_RANGES: {
      1: [18, 35],
      2: [28, 50],
      3: [42, 65],
      4: [58, 80],
      5: [72, 95],
    },
    // 商店/AI 品质出现概率（roll 分布）
    SHOP_QUALITY: [0.35, 0.25, 0.2, 0.13, 0.07], // 品质1~5
    // 鹿的属性上限浮动（每头鹿潜力不同）：基准浮动 + 品质系数
    CAP_VAR_BASE: 4,
    CAP_VAR_PER_Q: 2,
    // 品质 -> 称号池
    ELEGANT_TITLES: {
      1: ["·闲庭", "·信步", "·踏青"],
      2: ["·追云", "·疾风", "·掠影"],
      3: ["·凌云", "·追月", "·惊鸿"],
      4: ["·逐日", "·贯虹", "·破空"],
      5: ["·破苍穹", "·冠绝群伦", "·九天之上"],
    },
    // 品质 -> 描述
    QUALITY_DESC: {
      1: { desc: "步履蹒跚" },
      2: { desc: "初露锋芒" },
      3: { desc: "迅捷如风" },
      4: { desc: "风驰电掣" },
      5: { desc: "神鹿天降" },
    },

    // =========================================================
    // 经济公式参数（公式在 game-formulas.js，这里只有基值）
    // =========================================================
    // 卖出折价：基础价×SELL_BASE + 养成度×SELL_FILL + 每冠×CHAMP_BONUS
    SELL_BASE: 0.6,
    SELL_FILL: 0.25,
    CHAMP_BONUS: 120,
    // 训练费用曲线：BASE × GROWTH^n，取整到 5 的倍数
    TRAIN_BASE: 20,
    TRAIN_GROWTH: 1.35,
    // 训练收益：TRAIN_GAIN_BASE + floor(次数 / TRAIN_GAIN_STEP)
    TRAIN_GAIN_BASE: 3,
    TRAIN_GAIN_STEP: 5,
    // 商店手动刷新费用：BASE × 2^n，封顶
    SHOP_REFRESH_BASE: 50,
    SHOP_REFRESH_CAP: 400,
    SHOP_REFRESH_MS: 3 * 60 * 1000,

    // =========================================================
    // 鹿生命周期
    // =========================================================
    MAX_RACES: 25,
    RACE_CAP_DECAY: 0.015, // 属性上限每次 -1.5%
    RACE_ATTR_DECAY: 0.005, // 当前属性每次 -0.5%

    // =========================================================
    // 特技（品质 -> 概率，品质越高越稀有 0.01%~2%）
    // =========================================================
    TRICK_CHANCES: { 1: 0.0001, 2: 0.0005, 3: 0.002, 4: 0.008, 5: 0.02 },
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

    // =========================================================
    // 鹿茸
    // =========================================================
    ANTLER_GROW_MS: 30 * 60 * 1000,
    ANTLER_BASE: 80,
    ANTLER_RAND: 120,

    // =========================================================
    // 配种（需求1：配种权重/品质区间下沉到这里）
    // =========================================================
    BREED_COST: 300,
    BREED_CD_MS: 3 * 60 * 1000,
    // 小鹿品质 = 父母均值 ±1，各档概率：-1 / 0 / +1
    BREED_Q_WEIGHT: [-1, 0, 1],
    // 属性遗传浮动：父母均值 × (BREED_INHERIT_MIN ~ +BREED_INHERIT_RANGE)
    BREED_INHERIT_MIN: 0.85,
    BREED_INHERIT_RANGE: 0.3, // 0.85 ~ 1.15

    // =========================================================
    // 小鹿喂养
    // =========================================================
    FEED_COST: 50,
    FAWN_FEED_NEED: 3,

    // =========================================================
    // 比赛引擎（需求1：随机事件/技能概率全部下沉到这里）
    // =========================================================
    // 起跑反应：前 START_STEPS 步敏捷加成
    START_STEPS: 12,
    START_AGILITY_BONUS: 0.18,
    // 基础速度权重（主属性最大）：sprint / endurance / obstacle
    TYPE_WEIGHTS: {
      sprint: { speed: 0.45, agility: 0.3, stamina: 0.15 },
      endurance: { speed: 0.2, stamina: 0.45, agility: 0.25 },
      obstacle: { speed: 0.25, stamina: 0.2, agility: 0.45 },
    },
    // 随机波动
    RANDOM_SCOPE: 0.2,
    RANDOM_AGILITY_FACTOR: 1.4,
    // 随机小爆发概率 / 幅度
    RANDOM_BOOST_P: 0.05,
    RANDOM_BOOST_AMT: 0.14,
    // 道具效果（时长以"步"计，配合 itemDuration 特技 × ITEM_DUR_MUL）
    POWERUP: {
      boostP: 0.34,
      attackP: 0.67,
      boostDur: 60,
      attackDur: 22,
      shieldDur: 50,
      fallbackBoostDur: 40,
      boostAmt: 0.22,
      attackMult: 0.35,
    },
    ITEM_DUR_MUL: 1.5,
    // 技能（内置 CD）：概率随属性递增
    SKILL: {
      sprintPBase: 0.02,
      sprintPPerSpeed: 0.05,
      focusPBase: 0.015,
      focusPPerAgi: 0.04,
      recoverPBase: 0.012,
      recoverPPerStam: 0.03,
      sprintDur: 12,
      sprintAmt: 0.25,
      focusCd: [70, 40], // [base, rand]
      sprintCd: [50, 40],
      recoverCd: [60, 30],
    },
    // 随机事件（无 CD，纯概率）
    RANDOM_EVENT: {
      momentumP: 0.008,
      momentumDur: 8,
      momentumAmt: 0.3,
      pebbleP: 0.006,
      pebbleDur: 8,
      pebbleMult: 0.7,
      twistP: 0.015,
      twistDur: 12,
      twistMult: 0.55,
      laneChangeP: 0.02,
      laneChangeMinStep: 8,
      laneChangeCd: 20,
      laneChangeRange: 8, // 撞车判定距离
    },
    // 障碍判定概率（洞/障碍 跳跃、草 停下）：基础 + 敏捷加成 + 随机
    JUMP: {
      holeBase: 0.3,
      holePerAgi: 0.25,
      holeRand: 0.25,
      obsBase: 0.35,
      obsPerAgi: 0.3,
      obsRand: 0.25,
      grassBase: 0.3,
      grassPerStam: 0.2,
      grassRand: 0.2,
    },
    // 特技效果参数
    TRICK: {
      startBoostSteps: 25,
      startBoostAmt: 0.22,
      fatigueMul: 0.6,
      jumpBoost: 0.12,
      lateThreshold: 0.5,
      lateSprintAmt: 0.18,
    },
    // 疲劳：每步增量 = FATIGUE_INC_BASE - stamina×FATIGUE_STAM
    FATIGUE: { incBase: 0.005, perStam: 0.0035, speedMul: 0.45 },
    // 速度放大倍数（保证普通鹿也能跑完全程）
    SPEED_MULT: 2.0,
  };
});
