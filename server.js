const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const fs = require("fs");

// 游戏平衡配置唯一事实源（与前端 public/js/game-config.js 同一份文件）
const GameConfig = require(
  path.join(__dirname, "public", "js", "game-config.js"),
);
// 数据目录：托管平台设 DATA_DIR 指向持久化卷；本地默认项目根目录
const DATA_DIR = process.env.DATA_DIR || __dirname;
if (process.env.DATA_DIR && !fs.existsSync(DATA_DIR)) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch (e) {
    console.error("创建数据目录失败:", e.message);
  }
}
// 账号深层模块：校验/迁移/持久化/双向同步全部收口（唯一真相同步点）
const createAccountStore = require(
  path.join(__dirname, "server", "accounts.js"),
);
const Account = createAccountStore({
  filePath: path.join(DATA_DIR, "accounts.json"),
  createStarterDeer: () => randomDeer(2), // 注册时送一只二星鹿
}); // 服务器重启：内存出租市场清空，清除账号里残留的"挂出中"标记（鹿恢复为鹿舍可用）
Account.clearAllListed();
// 纯比赛引擎：位置步进 + 物件判定 + 名次判定（无 io/定时器，可单测）
const { createRace, stepRace } = require(
  path.join(__dirname, "server", "race-engine.js"),
);

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));

// 游戏全局状态
// rooms: { roomId: { host, hostName, name, players: { socketId: player }, raceState, shop, bettingPhase } }
// player: { id, name, gold, deers, bets, ready, selectedDeerId }
// deer: { id, name, quality, stars, desc, speed, stamina, agility, trained, owner }
// ⚠️ 属性数值 (speed/stamina/agility) 只在服务器内部使用，绝不发给客户端！

const rooms = {};

// 房间人数上限：与跑道数一致（满员后不能加入）
const MAX_PLAYERS = GameConfig.LANES;

// 全局出租市场（跨房间）：玩家挂出鹿出租给 AI 或其他玩家，每场结算租金
// market item: { id, deer(完整对象含真实属性), ownerId, ownerName, ownerAccount,
//                rentPrice, listedAt, rentedBy(租用玩家id), rentedByName }
// 鹿实体在"挂出者鹿舍 → 市场 → 租用者鹿舍"之间流转；AI 租用不移动实体，只结算租金
const rentalMarket = [];

// 创建房间玩家对象（hasStarter=true 时送一只随机二星鹿）
function buildPlayer(socketId, name, gold, hasStarter) {
  const player = {
    id: socketId,
    name,
    gold,
    deers: hasStarter ? [randomDeer(2)] : [],
    bets: [],
    ready: false,
    selectedDeerId: null,
    wins: 0,
  };
  if (hasStarter) player.deers[0].owner = socketId;
  return player;
}
// 尝试用账号登录并绑定到房间玩家；成功返回 r.ok=true
// 账号玩家的昵称以账号持久化昵称为准（服务器权威，忽略前端传的）
function tryBindAccount(socket, player, username, password) {
  if (!username) return { ok: false };
  const r =
    username && password ? Account.login(username, password) : { ok: false };
  if (r.ok) {
    socket.data.account = username;
    Account.bindToPlayer(player, username);
    socket.emit("accountInfo", {
      ok: true,
      account: r.account,
      isAdmin: isAdmin(socket),
    });
  } else {
    socket.emit("accountInfo", { ok: false, msg: r.msg });
  }
  return r;
}

// 确保 socket 已登录账号：已登录则直接通过；否则用用户名/密码登录。
// 匿名（未登录）返回 false，用于"匿名禁止建/加入房间、发布通告"等限制。
function ensureAccount(socket, username, password) {
  if (socket.data.account) return true; // 已登录
  if (username && password) {
    const r = Account.login(username, password);
    if (r.ok) {
      socket.data.account = username;
      return true;
    }
  }
  return false;
}

// 公共鹿信息：只暴露名字/称号/描述/固定价格，隐藏真实属性与星级
// inspected: 已查验过的星级（速/耐/巧），查验后持久显示，训练后同步更新
function publicDeer(d) {
  const antler = d.antler || { growUntil: 0 };
  return {
    id: d.id,
    name: d.name,
    title: d.title || "",
    fullName: deerFullName(d),
    quality: d.quality,
    desc: d.desc,
    trained: d.trained || 0,
    owner: d.owner,
    price: d.price, // 创建时随机生成的固定价格，不暴露范围
    inspected: d.inspected || null,
    rented: d.rented || null, // 租来的鹿：标记出租市场条目 id（比赛结束自动归还）
    // 生命周期（公开可见）：卖出价由服务器按属性公式计算
    sellPrice: sellPriceFor(d),
    races: d.races || 0,
    maxRaces: GameConfig.MAX_RACES,
    champWins: d.champWins || 0,
    retired: (d.races || 0) >= GameConfig.MAX_RACES,
    isFawn: !!d.isFawn, // 配种出生的小鹿：喂养 3 次后成年
    fed: d.fed || 0,
    antlerLeftMs: Math.max(0, antler.growUntil - Date.now()), // 鹿茸剩余成长毫秒（0 = 可收割）
    antlerGrowUntil: antler.growUntil || 0, // 绝对时间戳（客户端本地倒计时用）
    breedReady: !(d.breedCdUntil && d.breedCdUntil > Date.now()),
    // 特技：key + 展示信息（客户端只读，不暴露属性）
    trick: d.trick || null,
    trickName: GameConfig.trickInfo(d.trick)
      ? GameConfig.trickInfo(d.trick).name
      : null,
    trickIcon: GameConfig.trickInfo(d.trick)
      ? GameConfig.trickInfo(d.trick).icon
      : null,
  };
}

// 训练费用：按总训练次数递增（共享 GameConfig.trainCost；训练随机提升一项属性，不再分属性计费）
function trainCostFor(deer) {
  return GameConfig.trainCost(deer.trained || 0);
}

// 玩家自己的视图：包含自己的金币和鹿（属性仍隐藏）
function meView(player) {
  return {
    id: player.id,
    name: player.name,
    gold: player.gold,
    deers: player.deers.map(publicDeer),
    ready: !!player.ready,
    selectedDeerId: player.selectedDeerId || null,
    bets: player.bets || [],
    wins: player.wins || 0,
    account: player.account || null,
    // 本场比赛投注结算结果（前端 raceResult 展示"你赢了 X 金币"）
    lastBetResult: player.lastBetResult || null,
    lastBetGold: player.lastBetGold || 0,
  };
}

// 商店自动刷新间隔：3 分钟
const SHOP_REFRESH_MS = 3 * 60 * 1000;
// 手动刷新花费层次：自上次自动刷新起，连续手动刷新 50/100/200/400 封顶
function shopRefreshCostFor(room) {
  const n = room.manualRefreshCount || 0;
  return Math.min(400, 50 * Math.pow(2, n));
}

// 房间公开视图：不包含任何玩家私有数据，只有玩家名册与公开鹿信息
function roomView(room) {
  const roster = [];
  for (const p of Object.values(room.players)) {
    roster.push({
      id: p.id,
      name: p.name,
      isHost: p.id === room.host,
      ready: !!p.ready,
      deerCount: p.deers.length,
      wins: p.wins || 0,
      account: p.account || null,
    });
  }
  // 排行榜：按胜场数降序
  const leaderboard = [...roster].sort((a, b) => b.wins - a.wins);
  return {
    roomId: room.roomId,
    name: room.name || room.roomId,
    host: room.host,
    hostName: room.hostName,
    maxPlayers: room.maxPlayers || MAX_PLAYERS,
    isPublic: room.isPublic !== false,
    raceType: room.raceType || "sprint",
    betCountdown: room.betCountdown || GameConfig.BET_COUNTDOWN,
    players: roster,
    leaderboard,
    chatHistory: room.chatHistory || [],
    shop: room.shop.map(publicDeer),
    shopRefreshIn: Math.max(
      0,
      Math.ceil((room.shopRefreshesAt - Date.now()) / 1000),
    ),
    shopRefreshCost: shopRefreshCostFor(room),
    raceState: room.raceState ? publicRaceState(room.raceState) : null,
  };
}

// 比赛公开状态：不暴露真实属性，只暴露参赛鹿的公开信息、赔率、投注池与赛道物件计划
function publicRaceState(rs) {
  // 赛道物件内部坐标是 0~TRACK_LEN，广播给前端统一归一化回 0~100
  const sc = GameConfig.trackScale;
  return {
    type: rs.type,
    status: rs.status,
    odds: rs.odds,
    betPool: rs.betPool || {}, // 每只鹿的实时累计投注金额（动态赔率依据）
    finishOrder: rs.finishOrder,
    trackObjects: (rs.trackObjects || []).map((o) => ({
      ...o,
      pos: GameConfig.trackScale(o.pos),
      renderPos: GameConfig.trackScale(o.renderPos),
    })),
    racers: rs.racers.map((r) => ({
      deer: publicDeer(r.deer),
      ownerId: r.ownerId,
    })),
  };
}

// 给房间内每个玩家推送各自的视图（房主收到的是房主视角）
function broadcastViews(room) {
  const view = roomView(room);
  for (const id of Object.keys(room.players)) {
    const p = room.players[id];
    io.to(id).emit("roomUpdate", {
      ...view,
      me: meView(p),
      isHost: id === room.host,
    });
  }
}

// 聊天：保存历史并广播
function pushChat(room, who, msg) {
  if (!room) return;
  room.chatHistory = room.chatHistory || [];
  room.chatHistory.push({ who, msg, t: Date.now() });
  if (room.chatHistory.length > 50) room.chatHistory.shift();
  io.to(room.roomId).emit("chat", { who, msg });
}

// 全服聊天（全局公告频道）：只用于高品质鹿挂出租市场 + 服主发布通告
// 普通出租 / 租用 / 收回等操作不产生任何聊天消息（避免刷屏）
const globalChat = [];
function pushGlobalChat(msg) {
  globalChat.push({ msg, t: Date.now() });
  if (globalChat.length > 50) globalChat.shift();
  io.emit("globalChat", { msg });
}

// ===== 服主（服务器管理员）=====
// 通过环境变量 ADMIN_USERS 指定（逗号分隔的用户名），空则无人可发布通告。
// 服主是账号身份（登录后 socket.data.account 为用户名字符串），与房主无关。
const ADMIN_USERS = (process.env.ADMIN_USERS || "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);
function isAdmin(socket) {
  return (
    !!socket.data.account &&
    ADMIN_USERS.includes(String(socket.data.account).toLowerCase())
  );
}

// ===== 公告文件加载（可选）：启动时从 announcements.txt 读取，每行一条公告 =====
const ANNOUNCE_FILE = path.join(__dirname, "announcements.txt");
function loadAnnouncements() {
  try {
    const txt = fs.readFileSync(ANNOUNCE_FILE, "utf8");
    const lines = txt
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    for (const line of lines) pushGlobalChat(`通告：${line}`);
    if (lines.length) console.log(`已加载 ${lines.length} 条公告`);
  } catch (e) {
    // 文件不存在则忽略（无公告）
  }
}
loadAnnouncements();

// 高品质鹿判定：品质 4（风驰电掣）/ 5（神鹿天降）视为"属性很好"
function isGreatDeer(deer) {
  return deer && deer.quality >= 4;
}

// 房间状态变更后的单一广播路径：broadcastViews + 可选聊天副作用收口在这里。
// 「改了状态就广播」是模块不变量——新增 handler 只需调用 syncRoom(room[, chatMsg])，
// 不会漏广播也不会漏聊天。
function syncRoom(room, chatMsg) {
  if (!room) return;
  broadcastViews(room);
  if (chatMsg) pushChat(room, null, chatMsg);
}

// 大厅房间列表：公开房间（isPublic=true）出现在大厅列表，可被搜索/直接加入；
// 私密房间（isPublic=false）不出现在列表，只能凭房间号加入。
function roomListPublic() {
  const list = [];
  for (const r of Object.values(rooms)) {
    if (r.isPublic === false) continue; // 私密房不进列表
    const p = Object.values(r.players);
    list.push({
      roomId: r.roomId,
      name: r.name || r.roomId,
      hostName: r.hostName,
      raceType: r.raceType || "sprint",
      playerCount: p.length,
      maxPlayers: r.maxPlayers || MAX_PLAYERS,
      status:
        r.raceState && r.raceState.status === "racing" ? "racing" : "waiting",
    });
  }
  // 优先显示有人的房间，再按创建顺序
  list.sort((a, b) => b.playerCount - a.playerCount);
  return list;
}

// 广播房间列表给所有在线玩家（大厅用）
function broadcastRoomList() {
  io.emit("roomList", { rooms: roomListPublic() });
}

// 鹿名池与品质描述
const NAMES = [
  "闪电",
  "疾风",
  "飞影",
  "流星",
  "追月",
  "踏雪",
  "赤焰",
  "青霜",
  "紫电",
  "金蹄",
  "银角",
  "旋风",
  "奔雷",
  "幻影",
  "烈风",
  "霜刃",
  "惊鸿",
  "破晓",
];
const QUALITY_DESC = {
  1: { desc: "步履蹒跚" },
  2: { desc: "初露锋芒" },
  3: { desc: "迅捷如风" },
  4: { desc: "风驰电掣" },
  5: { desc: "神鹿天降" },
};
// 优雅后缀：按品质给鹿冠以称号，替代直白的星级展示
const ELEGANT_TITLES = {
  1: ["·闲庭", "·信步", "·踏青"],
  2: ["·追云", "·疾风", "·掠影"],
  3: ["·凌云", "·追月", "·惊鸿"],
  4: ["·逐日", "·贯虹", "·破空"],
  5: ["·破苍穹", "·冠绝群伦", "·九天之上"],
};

// 鹿的全名：名字 + 称号后缀（优雅区分品质，不再用星号明示）
function deerFullName(d) {
  return d.name + (d.title || "");
}

function randomDeer(quality) {
  const ranges = {
    1: [18, 35],
    2: [28, 50],
    3: [42, 65],
    4: [58, 80],
    5: [72, 95],
  };
  const r = ranges[quality];
  const titles = ELEGANT_TITLES[quality];
  // 每个鹿的属性上限不同（潜力随机）：品质越高，上限浮动越大
  // 上限 = 品质基准上限 + 随机浮动（6~14），决定了这头鹿能练到多高
  const capVar = 4 + quality * 2;
  const mkCap = () => Math.min(99, Math.round(r[1] + Math.random() * capVar));
  const caps = { speed: mkCap(), stamina: mkCap(), agility: mkCap() };
  const mk = (cap) => Math.floor(Math.random() * (cap - r[0] + 1)) + r[0];
  return {
    id: Date.now().toString(36) + Math.random().toString(36).substr(2, 4),
    name: NAMES[Math.floor(Math.random() * NAMES.length)],
    title: titles[Math.floor(Math.random() * titles.length)],
    quality,
    // 价格在创建时从品质范围内随机取定，客户端只见固定价格
    price: quality * 200 + Math.floor(Math.random() * 100),
    speed: mk(caps.speed),
    stamina: mk(caps.stamina),
    agility: mk(caps.agility),
    caps, // 属性上限（每头鹿不同）：训练/老去都受此约束
    desc: QUALITY_DESC[quality].desc,
    owner: null,
    // 生命周期与养成
    races: 0, // 参赛场次（达到 MAX_RACES 后退役）
    champWins: 0, // 夺冠次数（卖出时额外加价）
    antler: { growUntil: 0 }, // 鹿茸：0/已过 = 可收割，否则成长中
    breedCdUntil: 0, // 配种冷却
    // 特技：按品质小概率获得一个（品质越高越稀有 0.01%~2%）
    trick: GameConfig.rollTrick(quality),
  };
}

// 卖出折价公式：基础价 × 60% + 养成度加成（当前属性均值/上限均值，最高价格×25%） + 每冠 +120
// 属性养成度越高、夺冠越多，卖出价越高（比旧固定 50% 折价更保值）
function sellPriceFor(deer) {
  if (!deer) return 0;
  const price = deer.price || deer.quality * 200;
  const caps = deer.caps || { speed: 100, stamina: 100, agility: 100 };
  const avg = (deer.speed + deer.stamina + deer.agility) / 3;
  const avgCap = (caps.speed + caps.stamina + caps.agility) / 3;
  const fill = avgCap > 0 ? Math.max(0, Math.min(1, avg / avgCap)) : 0.6;
  const champ = deer.champWins || 0;
  return Math.max(
    50,
    Math.floor(price * 0.6 + price * 0.25 * fill + champ * 120),
  );
}

function generateShop() {
  const shop = [];
  for (let i = 0; i < 4; i++) {
    const roll = Math.random();
    let q =
      roll < 0.35 ? 1 : roll < 0.6 ? 2 : roll < 0.8 ? 3 : roll < 0.93 ? 4 : 5;
    shop.push(randomDeer(q));
  }
  return shop;
}

// 生成赛道物件计划：位置固定，所有鹿经过时各自判定
// 解决"障碍物不在那个位置却撞上"的问题
// 比赛类型影响赛道构成：障碍赛多坑/障碍，短距赛多为草地，耐力赛均衡
// 车道数与渲染位移来自共享 GameConfig（与前端一致）
const LANES = GameConfig.LANES;
const RENDER_OFFSET = GameConfig.RENDER_OFFSET;

// 生成赛道物件计划：位置固定，所有鹿经过时各自判定
// 解决"障碍物不在那个位置却撞上"的问题
// 比赛类型影响赛道构成：
//  - 障碍赛：物体在所有车道上都生成（洞/障碍/草混合）
//  - 短距/耐力：物体随机分散在部分车道（1~5 条）和不同距离上
function generateTrackObjects(type) {
  const objs = [];
  const isObstacle = type === "obstacle";
  const isSprint = type === "sprint";
  const T = GameConfig.TRACK_LEN; // 赛道总长（内部坐标）
  const END = T - 14; // 物件最晚位置（留出终点缓冲）
  let pos = T * 0.12;
  while (pos < END) {
    // 间隔：障碍赛密集，短距赛稀疏（按赛道长度比例缩放）
    const gap = isObstacle
      ? T * 0.05 + Math.random() * T * 0.06
      : isSprint
        ? T * 0.1 + Math.random() * T * 0.08
        : T * 0.07 + Math.random() * T * 0.09;
    pos += gap;
    if (pos >= END) break;
    let t;
    const roll = Math.random();
    if (isObstacle) {
      // 障碍赛：坑 40% / 障碍 35% / 草 25%
      t = roll < 0.4 ? "hole" : roll < 0.75 ? "obstacle" : "grass";
    } else if (isSprint) {
      // 短距赛：草 60% / 障碍 25% / 坑 15%
      t = roll < 0.15 ? "hole" : roll < 0.4 ? "obstacle" : "grass";
    } else {
      // 耐力赛：三种均等
      t = ["hole", "obstacle", "grass"][Math.floor(Math.random() * 3)];
    }
    if (isObstacle) {
      // 障碍赛：物体在所有车道上都生成
      for (let lane = 0; lane < LANES; lane++) {
        objs.push({
          pos: Math.round(pos), // 判定点位置（鹿到此判定）
          type: t,
          lane,
          renderPos: Math.round(pos) + RENDER_OFFSET, // 物件渲染位置 = 判定点 + 固定位移
        });
      }
    } else {
      // 短距/耐力：随机选 1~5 条车道分散生成
      const all = [0, 1, 2, 3, 4, 5];
      const lanes = [];
      const laneCount = 1 + Math.floor(Math.random() * 5);
      for (let k = 0; k < laneCount; k++) {
        const idx = Math.floor(Math.random() * all.length);
        lanes.push(all.splice(idx, 1)[0]);
      }
      for (const lane of lanes) {
        objs.push({
          pos: Math.round(pos), // 判定点位置（鹿到此判定）
          type: t,
          lane,
          renderPos: Math.round(pos) + RENDER_OFFSET, // 物件渲染位置 = 判定点 + 固定位移
        });
      }
    }
  }
  // 道具点：随机 3 个（位置 25%~80%，随机车道），鹿踩到获得随机道具（加速/攻击/护盾）
  for (let k = 0; k < 3; k++) {
    const p = T * 0.25 + Math.floor(Math.random() * (T * 0.55));
    objs.push({
      pos: Math.round(p),
      type: "powerup",
      lane: Math.floor(Math.random() * LANES),
      renderPos: Math.round(p) + RENDER_OFFSET,
    });
  }
  return objs;
}

// 属性转星级（1-10），供"查验"功能使用
function attrStars(v) {
  return Math.max(1, Math.min(10, Math.round(v / 10)));
}

// 属性转星级（1-10），供"查验"功能使用（共享 GameConfig.attrStars）
function attrStars(v) {
  return GameConfig.attrStars(v);
}

// 投注类型：来自共享 GameConfig（与前端 race.js 同源）
const BET_TYPES = GameConfig.BET_TYPES;

// 动态赔率：随实时投注量波动（热门鹿赔率走低、冷门鹿轻微升水）
// baseOdds 为比赛开始时的静态赔率；每次有人下注后按投注池重算
function recalcDynamicOdds(rs) {
  if (!rs || !rs.racers || !rs.baseOdds) return;
  const pool = rs.betPool || {};
  const total = Object.values(pool).reduce((s, v) => s + v, 0);
  rs.odds = rs.racers.map((r, i) => {
    const base = parseFloat(rs.baseOdds[i]);
    const share = total > 0 ? (pool[r.deer.id] || 0) / total : 0;
    // 被投注越多赔率越低（最多 -50%）；无人投注最多 +12% 升水
    const o = base * (1 - share * 0.5 + (1 - share) * 0.12);
    return Math.max(1.1, Math.min(10, o)).toFixed(1);
  });
}

// 结算单笔投注：返回赢得金币（0 = 未中）
// bet: { type, deerIds, amount, mult? }；finishDeerIds: 按名次排列的鹿 id
// mult 为下注时锁定的赔率倍率（动态赔率下投注后赔率变化不影响本注结算）
function settleBet(bet, finishDeerIds, odds, racers) {
  const idxOf = (id) => racers.findIndex((r) => r.deer.id === id);
  // 判定是否中奖（按玩法各自的命中条件，不分顺序）
  let hit = false;
  if (bet.type === "win") {
    hit = finishDeerIds[0] === bet.deerIds[0];
  } else if (bet.type === "place") {
    hit = finishDeerIds.slice(0, 3).includes(bet.deerIds[0]);
  } else if (bet.type === "quinella") {
    const top2 = finishDeerIds.slice(0, 2);
    hit = top2.includes(bet.deerIds[0]) && top2.includes(bet.deerIds[1]);
  } else if (bet.type === "trifecta") {
    const top3 = finishDeerIds.slice(0, 3);
    hit = bet.deerIds.every((id) => top3.includes(id));
  }
  if (!hit) return 0;
  // 中奖赔率倍率：优先用下注时锁定的倍率；无锁定（旧数据）则按当前赔率计算
  let mult = bet.mult;
  if (!mult || mult <= 0) {
    const oddsArr = bet.deerIds.map((id) => odds[idxOf(id)]);
    mult = GameConfig.comboOdds(bet.type, oddsArr);
  }
  if (mult <= 0) return 0;
  return Math.floor(bet.amount * mult);
}

// Socket.IO 连接处理
io.on("connection", (socket) => {
  console.log("玩家连接:", socket.id);
  let currentRoom = null;
  // 连接即推送一次出租市场快照（大厅面板初始化显示）+ 全服聊天历史 + 房间列表
  socket.emit("rentalMarketUpdate", { items: rentalMarketPublicItems() });
  socket.emit("globalChatHistory", [...globalChat]);
  socket.emit("roomList", { rooms: roomListPublic() });

  // 创建房间（需登录账号）
  socket.on(
    "createRoom",
    ({ playerName, roomName, username, password, maxPlayers, isPublic }) => {
      const roomId = Math.random().toString(36).substr(2, 6).toUpperCase();
      // 匿名账号不允许创建房间
      if (!ensureAccount(socket, username, password)) {
        socket.emit("error", "请先登录账号再创建房间");
        return;
      }
      // 房间人数：默认最大跑道数（6），范围 2~MAX_PLAYERS
      const maxP =
        Number(maxPlayers) >= 2 && Number(maxPlayers) <= MAX_PLAYERS
          ? Math.floor(Number(maxPlayers))
          : MAX_PLAYERS;
      rooms[roomId] = {
        roomId,
        name: roomName || `${playerName || "鹿主"}的房间`,
        host: socket.id,
        hostName: playerName || "鹿主",
        raceType: "sprint",
        maxPlayers: maxP,
        isPublic: isPublic !== false, // 默认公开，false = 仅可凭房间号加入
        players: {},
        raceState: null,
        shop: generateShop(),
        shopRefreshesAt: Date.now() + SHOP_REFRESH_MS,
        manualRefreshCount: 0,
        chatHistory: [],
        lastUpdate: Date.now(),
      };
      socket.join(roomId);
      currentRoom = roomId;
      const player = buildPlayer(socket.id, playerName || "鹿主", 1000, true);
      // 如果提供了账号信息则登录并应用
      if (username && tryBindAccount(socket, player, username, password).ok) {
        // 房主昵称以账号持久化昵称为准
        rooms[roomId].hostName = player.name;
      }
      rooms[roomId].players[socket.id] = player;
      broadcastViews(rooms[roomId]);
      pushChat(rooms[roomId], null, `${player.name} 创建了房间`);
      broadcastRoomList();
      console.log(`房间 ${roomId} 创建，房主: ${socket.id}`);
    },
  );

  // 加入房间（需登录账号）
  socket.on("joinRoom", ({ roomId, playerName, username, password }) => {
    roomId = String(roomId || "").toUpperCase();
    if (!rooms[roomId]) {
      socket.emit("error", "房间不存在");
      return;
    }
    // 匿名账号不允许加入房间
    if (!ensureAccount(socket, username, password)) {
      socket.emit("error", "请先登录账号再加入房间");
      return;
    }
    // 房间满员：拒绝加入（最多 room.maxPlayers 人，默认与跑道数一致）
    const maxP = rooms[roomId].maxPlayers || MAX_PLAYERS;
    if (Object.keys(rooms[roomId].players).length >= maxP) {
      socket.emit("error", `房间已满（最多 ${maxP} 人），无法加入`);
      return;
    }
    socket.join(roomId);
    currentRoom = roomId;
    const player = buildPlayer(socket.id, playerName || "鹿友", 800, false);
    // 如果提供了账号信息则登录并应用
    if (username) tryBindAccount(socket, player, username, password);
    rooms[roomId].players[socket.id] = player;
    broadcastViews(rooms[roomId]);
    pushChat(rooms[roomId], null, `${player.name} 加入了房间`);
    broadcastRoomList();
  });

  // 注册 / 登录：成功都绑定账号身份（改名/持久化依赖 socket.data.account）
  socket.on("register", ({ username, password }) => {
    const r = Account.register(username, password);
    if (r.ok) socket.data.account = r.account.username;
    socket.emit("accountInfo", { ...r, isAdmin: isAdmin(socket) });
  });
  socket.on("login", ({ username, password }) => {
    const r = Account.login(username, password);
    if (r.ok) socket.data.account = r.account.username;
    socket.emit("accountInfo", { ...r, isAdmin: isAdmin(socket) });
  });

  // 修改密码（需登录账号）：验证旧密码后设置新密码
  socket.on("changePassword", ({ oldPassword, newPassword }) => {
    if (!socket.data.account) {
      socket.emit("error", "请先登录账号");
      return;
    }
    const r = Account.changePassword(
      socket.data.account,
      oldPassword,
      newPassword,
    );
    socket.emit("changePasswordResult", r);
  });

  // 发送聊天消息
  socket.on("chat", ({ msg }) => {
    const room = rooms[currentRoom];
    if (!room) return;
    const player = room.players[socket.id];
    if (!player) return;
    msg = String(msg || "")
      .trim()
      .slice(0, 100);
    if (!msg) return;
    // 服主管理命令（以 / 开头，不进入房间聊天）
    if (msg[0] === "/") {
      if (isAdmin(socket)) {
        const cmd = msg.slice(1).trim();
        if (cmd.startsWith("公告") || cmd.startsWith("announce")) {
          const text = cmd.replace(/^(公告|announce)\s*/, "").trim();
          if (text) pushGlobalChat(`通告：${text}`);
        } else if (cmd === "reload" || cmd === "公告重载") {
          loadAnnouncements();
          pushGlobalChat("通告：公告已重载");
        }
      }
      return;
    }
    pushChat(room, player.name, msg);
  });

  // 全服通告：仅服主（服务器管理员）可发布；房主不可。
  socket.on("announce", ({ msg }) => {
    if (!isAdmin(socket)) return;
    msg = String(msg || "")
      .trim()
      .slice(0, 100);
    if (!msg) return;
    pushGlobalChat(`通告：${msg}`);
  });

  // 修改昵称（房主/玩家都可用）：账号玩家改名持久化到账号，大厅也可改
  socket.on("rename", ({ name }) => {
    name = String(name || "")
      .trim()
      .slice(0, 12);
    if (!name) return;
    // 账号玩家：直接更新账号昵称（持久化收口在 Account 模块）
    if (socket.data.account) {
      Account.rename(socket.data.account, name);
    }
    const room = rooms[currentRoom];
    if (!room) return;
    const player = room.players[socket.id];
    if (!player) return;
    player.name = name;
    if (room.host === socket.id) {
      room.hostName = player.name;
    }
    broadcastViews(room);
  });

  // 房主修改房间名
  socket.on("renameRoom", ({ name }) => {
    const room = rooms[currentRoom];
    if (!room || room.host !== socket.id) return;
    if (name) room.name = String(name).slice(0, 16);
    broadcastViews(room);
  });

  // 购买鹿
  socket.on("buyDeer", (payload) => {
    const { deerId } = payload || {};
    const room = rooms[currentRoom];
    if (!room || !deerId) return;
    const player = room.players[socket.id];
    if (!player) return;
    const deerIndex = room.shop.findIndex((d) => d.id === deerId);
    if (deerIndex === -1) return;
    const deer = room.shop[deerIndex];
    const price = deer.price; // 创建时已定的固定价格
    if (player.gold < price) {
      socket.emit("error", "金币不足");
      return;
    }
    player.gold -= price;
    deer.owner = socket.id;
    player.deers.push(deer);
    room.shop.splice(deerIndex, 1);
    if (room.shop.length < 3) room.shop = [...room.shop, ...generateShop()];
    Account.syncFromPlayer(player);
    broadcastViews(room);
  });

  // 刷新商店货架：分级花费（50/100/200/400 封顶）。
  // 手动刷新不重置自动刷新倒计时：倒计时走完自动换货并把花费恢复为 50 金
  socket.on("refreshShop", () => {
    const room = rooms[currentRoom];
    if (!room) return;
    const player = room.players[socket.id];
    if (!player) return;
    const cost = shopRefreshCostFor(room);
    if (player.gold < cost) {
      socket.emit("error", `金币不足，刷新商店需要 ${cost} 金币`);
      return;
    }
    player.gold -= cost;
    room.manualRefreshCount = (room.manualRefreshCount || 0) + 1;
    room.shop = generateShop();
    Account.syncFromPlayer(player);
    broadcastViews(room);
  });

  // 训练鹿：随机提升速度/耐力/敏捷中的一项；费用按总训练次数递增
  socket.on("trainDeer", ({ deerId }) => {
    const room = rooms[currentRoom];
    if (!room) return;
    const player = room.players[socket.id];
    if (!player) return;
    const deer = player.deers.find((d) => d.id === deerId);
    if (!deer) return;
    if (deer.rented) {
      socket.emit("error", "租来的鹿不可训练");
      return;
    }
    if ((deer.races || 0) >= GameConfig.MAX_RACES) {
      socket.emit("error", "这头鹿已老去退役，不能再训练，可卖出养老");
      return;
    }
    const cost = trainCostFor(deer);
    if (player.gold < cost) {
      socket.emit("error", `金币不足，训练需要 ${cost} 金币`);
      return;
    }
    player.gold -= cost;
    // 训练收益随次数递增（皇室战争式：投入越高提升越大）
    const gain = GameConfig.trainGain(deer.trained || 0);
    const attrs = ["speed", "stamina", "agility"];
    const attr = attrs[Math.floor(Math.random() * attrs.length)];
    // 训练受属性上限约束（每头鹿上限不同）：练满后不再增长
    const cap = (deer.caps && deer.caps[attr]) || 99;
    deer[attr] = Math.min(cap, deer[attr] + gain);
    deer.trained = (deer.trained || 0) + 1;
    // 训练后同步更新已查验的星级显示
    if (deer.inspected) {
      deer.inspected = {
        speed: attrStars(deer.speed),
        stamina: attrStars(deer.stamina),
        agility: attrStars(deer.agility),
      };
    }
    Account.syncFromPlayer(player);
    broadcastViews(room);
    // 告知训练结果（随机到了哪项属性、加了多少，前端 toast 反馈）
    socket.emit("deerInfo", {
      ok: true,
      trained: true,
      id: deer.id,
      name: deerFullName(deer),
      attr,
      gain,
      cost,
    });
  });

  // 给自己的鹿改名（只改名字，保留称号）
  socket.on("renameDeer", ({ deerId, name }) => {
    const room = rooms[currentRoom];
    if (!room) return;
    const player = room.players[socket.id];
    if (!player) return;
    const deer = player.deers.find((d) => d.id === deerId);
    if (!deer) return;
    if (deer.rented) {
      socket.emit("error", "租来的鹿不可改名");
      return;
    }
    name = String(name || "")
      .trim()
      .slice(0, 8);
    if (!name) return;
    deer.name = name;
    Account.syncFromPlayer(player);
    broadcastViews(room);
  });

  // 花金币查验鹿的属性（显示速度/耐力/敏捷星级，替代明示星级）
  // 只有买进鹿舍的鹿才能查验；商店里的鹿必须先购买（去掉商店查验机制）
  socket.on("inspectDeer", ({ deerId }) => {
    const room = rooms[currentRoom];
    if (!room) return;
    const player = room.players[socket.id];
    if (!player) return;
    // 只能查验自己鹿舍里的鹿
    const deer = player.deers.find((d) => d.id === deerId);
    if (!deer) {
      socket.emit("error", "只有买到鹿舍后才能查验");
      return;
    }
    if (deer.rented) {
      socket.emit("error", "租来的鹿不可查验");
      return;
    }
    const cost = GameConfig.INSPECT_COST; // 查验开销（共享配置）
    if (player.gold < cost) {
      socket.emit("error", "金币不足，无法查验");
      return;
    }
    player.gold -= cost;
    // 查验结果持久化到鹿上：客户端持续显示，训练后同步更新
    deer.inspected = {
      speed: attrStars(deer.speed),
      stamina: attrStars(deer.stamina),
      agility: attrStars(deer.agility),
    };
    Account.syncFromPlayer(player);
    socket.emit("deerInfo", {
      ok: true,
      id: deer.id,
      name: deerFullName(deer),
      attrs: { ...deer.inspected },
      cost,
    });
    broadcastViews(room); // 更新金币与星级持久显示
  });

  // 选择参赛鹿：最多一条（deerId 传空 = 取消选择）
  // 出战需交参赛费 ENTRY_FEE，赛前退赛/取消返还；开赛后锁定不退
  socket.on("selectDeer", ({ deerId }) => {
    const room = rooms[currentRoom];
    if (!room) return;
    const player = room.players[socket.id];
    if (!player) return;
    // 比赛进行中（投注/开跑）不可出战或退赛：参赛名单已锁定
    const racing = room.raceState && room.raceState.status !== "finished";
    // 取消选择：返还参赛费
    if (!deerId) {
      if (racing) {
        socket.emit("error", "比赛进行中，无法退赛");
        return;
      }
      if (player.selectedDeerId) {
        player.gold += GameConfig.ENTRY_FEE;
        player.selectedDeerId = null;
        player.ready = false;
        broadcastViews(room);
      }
      return;
    }
    if (racing) {
      socket.emit("error", "比赛进行中，无法出战");
      return;
    }
    const deer = player.deers.find((d) => d.id === deerId);
    if (!deer) return;
    if (deer.isFawn) {
      socket.emit("error", "小鹿还没长大，喂养 3 次成年后才能参赛");
      return;
    }
    if ((deer.races || 0) >= GameConfig.MAX_RACES) {
      socket.emit("error", "这头鹿已老去退役，不能再参赛，可卖出养老");
      return;
    }
    // 已选一只时点别的鹿：拒绝（最多一条，须先取消）
    if (player.selectedDeerId && player.selectedDeerId !== deerId) {
      socket.emit("error", "最多选择一条参赛鹿，请先取消当前选择");
      return;
    }
    // 点已选鹿 = 取消选择（返还参赛费）
    if (player.selectedDeerId === deerId) {
      player.gold += GameConfig.ENTRY_FEE;
      player.selectedDeerId = null;
      player.ready = false;
      broadcastViews(room);
      return;
    }
    // 参赛鹿总数上限：全房间已选鹿数达到跑道数后不能再选（只能观战）
    const selectedCount = Object.values(room.players).filter(
      (p) => p.selectedDeerId,
    ).length;
    if (selectedCount >= GameConfig.LANES) {
      socket.emit("error", "参赛鹿数量已满，本场只能观战");
      return;
    }
    // 扣参赛费
    if (player.gold < GameConfig.ENTRY_FEE) {
      socket.emit("error", `金币不足，参赛需要 ${GameConfig.ENTRY_FEE} 金币`);
      return;
    }
    player.gold -= GameConfig.ENTRY_FEE;
    player.selectedDeerId = deerId;
    player.ready = false; // 选择后需重新点"我准备好了"
    broadcastViews(room);
  });

  // 切换准备状态：不选鹿也可以准备（观战其他人的比赛，本场只看不赛）
  socket.on("readyRace", () => {
    const room = rooms[currentRoom];
    if (!room) return;
    const player = room.players[socket.id];
    if (!player) return;
    player.ready = !player.ready;
    broadcastViews(room);
  });

  // 房主选择比赛类型：非房主忽略，比赛进行中不可改
  socket.on("setRaceType", ({ type }) => {
    const room = rooms[currentRoom];
    if (!room || room.host !== socket.id) return;
    if (room.raceState) return;
    if (!GameConfig.RACE_TYPES.includes(type)) return;
    room.raceType = type;
    broadcastViews(room);
  });

  // 房主配置投注阶段倒计时：1~199 秒（比赛进行中不可改）
  socket.on("setBetCountdown", ({ seconds }) => {
    const room = rooms[currentRoom];
    if (!room || room.host !== socket.id) return;
    if (room.raceState) return;
    const s = Math.floor(Number(seconds));
    if (!(s >= 1 && s <= GameConfig.BET_COUNTDOWN_MAX)) {
      socket.emit(
        "error",
        `投注倒计时需在 1~${GameConfig.BET_COUNTDOWN_MAX} 秒之间`,
      );
      return;
    }
    room.betCountdown = s;
    broadcastViews(room);
  });

  // 房主开始比赛：所有玩家（含房主）都必须已准备并选鹿，参赛鹿 + AI 鹿补齐到 6 只
  socket.on("startRace", () => {
    const room = rooms[currentRoom];
    if (!room || room.host !== socket.id) return;
    if (room.raceState) return; // 已有比赛进行中
    // 全员就绪才能开赛：每个玩家都点击了准备（未选鹿的观战玩家也算就绪）
    const notReady = Object.values(room.players).filter((p) => !p.ready);
    if (notReady.length > 0) {
      socket.emit(
        "error",
        `还有 ${notReady.length} 名玩家未准备，全员准备后才能开始比赛`,
      );
      return;
    }
    // 构建参赛鹿列表
    const racers = [];
    for (const p of Object.values(room.players)) {
      if (!p.ready || !p.selectedDeerId) continue;
      const deer = p.deers.find((d) => d.id === p.selectedDeerId);
      if (deer) racers.push({ deer, ownerId: p.id });
    }
    // 至少 6 只参赛，不足用随机 AI 补齐（挂出出租市场的鹿不会被自动拉进比赛）
    // 需求：AI 鹿的品质尽量贴近参赛玩家鹿的平均品质（避免悬殊碾压/被碾压）
    // 依据玩家鹿平均品质，把 AI 品质限制在 ±1 的窄区间内
    let aiQ = 3; // 默认中等
    if (racers.length > 0) {
      let sum = 0;
      let n = 0;
      for (const r of racers) {
        if (!r.ownerId) continue; // 只统计玩家鹿
        sum += r.deer.quality;
        n++;
      }
      if (n > 0) {
        const avg = Math.round(sum / n);
        // AI 品质 = 玩家平均 ±1（clamp 到 1~5），波动小、差距缩小
        const offset = Math.floor(Math.random() * 3) - 1; // -1 ~ +1
        aiQ = Math.max(1, Math.min(5, avg + offset));
      }
    }
    const aiCount = Math.max(6 - racers.length, 0);
    for (let i = 0; i < aiCount; i++) {
      const aiDeer = randomDeer(aiQ);
      racers.push({ deer: aiDeer, ownerId: null });
    }
    // 计算隐藏赔率 (基于服务器真实属性 + 比赛类型权重，客户端不可见)
    // 权重与比赛引擎一致：主属性权重最大，但速度/耐力/敏捷三项都参与
    const odds = racers.map((r) => {
      const d = r.deer;
      const t = room.raceType || "sprint";
      const w =
        t === "sprint"
          ? { speed: 0.45, agility: 0.3, stamina: 0.15 }
          : t === "endurance"
            ? { speed: 0.2, stamina: 0.45, agility: 0.25 }
            : { speed: 0.25, stamina: 0.2, agility: 0.45 };
      const score =
        d.speed * w.speed + d.stamina * w.stamina + d.agility * w.agility;
      return Math.max(1.5, Math.min(8.0, (60 / (score + 10)) * 3)).toFixed(1);
    });
    room.raceState = {
      type: room.raceType || "sprint",
      racers,
      odds,
      baseOdds: [...odds], // 静态基准赔率（动态赔率以此为基础波动）
      status: "betting",
      bets: {},
      betPool: {}, // deerId -> 累计投注金额（实时投注量）
      finishOrder: null,
      trackObjects: generateTrackObjects(room.raceType || "sprint"),
    };
    // 重置所有人的投注记录与上场比赛结算结果（避免残留影响前端 toast 判定）
    for (const p of Object.values(room.players)) {
      p.bets = [];
      p.lastBetResult = null;
      p.lastBetGold = 0;
    }
    syncRoom(room, `比赛开始投注，${racers.length} 只鹿参赛`);
    // 广播给全服：大厅品牌栏可播放任意房间的进行中比赛（只含公开信息）
    io.emit("worldRaceStart", {
      roomId: room.roomId,
      roomName: room.name || room.roomId,
      trackObjects: room.raceState.trackObjects,
      racers: racers.map((r) => ({
        deer: publicDeer(r.deer),
        ownerId: r.ownerId,
      })),
    });
    // 投注倒计时（房主配置的秒数，默认 15s）
    let cd = room.betCountdown || GameConfig.BET_COUNTDOWN;
    room._cdTimer = setInterval(() => {
      if (!rooms[room.roomId] || room.raceState?.status !== "betting") {
        clearInterval(room._cdTimer);
        return;
      }
      cd--;
      if (cd <= 0) {
        clearInterval(room._cdTimer);
        startRaceSimulation(room, room.roomId);
      } else {
        io.to(room.roomId).emit("countdown", cd);
      }
    }, 1000);
  });

  // 下注：选择投注类型 + 对应数量鹿 + 金额，确认后追加（支持多次投注）
  socket.on("placeBet", ({ type, deerIds, amount }) => {
    const room = rooms[currentRoom];
    if (!room || room.raceState?.status !== "betting") return;
    const player = room.players[socket.id];
    if (!player) return;
    const betType = BET_TYPES[type];
    if (!betType) return;
    // 鹿数量必须与类型匹配，且不重复
    if (!Array.isArray(deerIds) || deerIds.length !== betType.need) return;
    if (new Set(deerIds).size !== betType.need) return;
    // 所有鹿必须在参赛名单
    for (const id of deerIds) {
      if (!room.raceState.racers.some((r) => r.deer.id === id)) return;
    }
    amount = Math.floor(amount);
    if (amount < GameConfig.MIN_BET) {
      socket.emit("error", `投注金额至少 ${GameConfig.MIN_BET} 金币`);
      return;
    }
    if (amount > player.gold) {
      socket.emit("error", "金币不足");
      return;
    }
    // 计算本注赔率倍率：按下注时点的赔率锁定（投注后赔率变化不影响本注结算）
    const idxOf = (id) =>
      room.raceState.racers.findIndex((r) => r.deer.id === id);
    const oddsArr = deerIds.map((id) =>
      parseFloat(room.raceState.odds[idxOf(id)]),
    );
    const mult = GameConfig.comboOdds(type, oddsArr);
    // 追加投注（不再覆盖之前的投注）
    player.gold -= amount;
    player.bets.push({ type, deerIds, amount, mult });
    // 更新投注池并重算动态赔率（实时投注量 → 实时赔率，随 roomUpdate 广播）
    room.raceState.betPool = room.raceState.betPool || {};
    for (const id of deerIds) {
      room.raceState.betPool[id] = (room.raceState.betPool[id] || 0) + amount;
    }
    recalcDynamicOdds(room.raceState);
    Account.syncFromPlayer(player);
    broadcastViews(room);
  });

  // 卖出自己的鹿：折价 50%（保底变现）。参赛中/已下注/出租中/租来的鹿不可卖
  socket.on("sellDeer", ({ deerId }) => {
    const room = rooms[currentRoom];
    if (!room) return;
    const player = room.players[socket.id];
    if (!player) return;
    const idx = player.deers.findIndex((d) => d.id === deerId);
    if (idx === -1) return;
    const deer = player.deers[idx];
    if (deer.rented) {
      socket.emit("error", "租来的鹿不可卖出");
      return;
    }
    if (
      room.raceState &&
      room.raceState.racers.some((r) => r.deer.id === deerId)
    ) {
      socket.emit("error", "比赛中的鹿不可卖出");
      return;
    }
    if ((player.bets || []).some((b) => (b.deerIds || []).includes(deerId))) {
      socket.emit("error", "已下注的鹿不可卖出");
      return;
    }
    // 折价公式：基础价×60% + 养成度加成（当前属性/上限）+ 每冠 +120（服务器权威计算）
    const refund = sellPriceFor(deer);
    player.gold += refund;
    player.deers.splice(idx, 1);
    if (player.selectedDeerId === deerId) {
      player.gold += GameConfig.ENTRY_FEE; // 已交的参赛费返还
      player.selectedDeerId = null;
      player.ready = false;
    }
    Account.syncFromPlayer(player);
    socket.emit("deerInfo", {
      ok: true,
      sold: true,
      refund,
      name: deerFullName(deer),
    });
    syncRoom(
      room,
      `💰 ${player.name} 卖出了 ${deerFullName(deer)}，获得 ${refund} 金币`,
    );
  });

  // 挂出鹿到出租市场（每场租金 = 品质 × 80，范围 80~400 金币）
  // 只有查验过的鹿才能挂出（市场里的鹿对买家显示查验结果）
  // 挂出后鹿离开鹿舍，AI 或其他玩家每租用一场，挂出者收一次租金（保底收入）
  socket.on("rentOutDeer", ({ deerId }) => {
    const room = rooms[currentRoom];
    if (!room) return;
    const player = room.players[socket.id];
    if (!player) return;
    const idx = player.deers.findIndex((d) => d.id === deerId);
    if (idx === -1) return;
    const deer = player.deers[idx];
    if (deer.rented) {
      socket.emit("error", "租来的鹿不可再出租");
      return;
    }
    if (deer.isFawn) {
      socket.emit("error", "小鹿还没长大，喂养 3 次成年后才能出租");
      return;
    }
    if ((deer.races || 0) >= GameConfig.MAX_RACES) {
      socket.emit("error", "这头鹿已老去退役，不能再出租，可卖出养老");
      return;
    }
    if (!deer.inspected) {
      socket.emit("error", "只有查验过的鹿才能挂上出租市场");
      return;
    }
    if (
      room.raceState &&
      room.raceState.racers.some((r) => r.deer.id === deerId)
    ) {
      socket.emit("error", "比赛中的鹿不可出租");
      return;
    }
    if ((player.bets || []).some((b) => (b.deerIds || []).includes(deerId))) {
      socket.emit("error", "已下注的鹿不可出租");
      return;
    }
    const rentPrice = Math.max(80, Math.min(400, deer.quality * 80));
    player.deers.splice(idx, 1);
    if (player.selectedDeerId === deerId) {
      player.gold += GameConfig.ENTRY_FEE; // 已交的参赛费返还
      player.selectedDeerId = null;
      player.ready = false;
    }
    // 账号玩家：标记账号鹿舍里的这只鹿为"挂出中"（进房间不重复加载，收回后恢复）
    if (socket.data.account) Account.listDeer(socket.data.account, deer.id);
    rentalMarket.push({
      id: Date.now().toString(36) + Math.random().toString(36).substr(2, 4),
      deer,
      ownerId: socket.id,
      ownerName: player.name,
      ownerAccount: socket.data.account || null,
      rentPrice,
      listedAt: Date.now(),
      rentedBy: null,
      rentedByName: null,
    });
    Account.syncFromPlayer(player);
    emitRentalMarket();
    socket.emit("deerInfo", {
      ok: true,
      listed: true,
      rentPrice,
      name: deerFullName(deer),
    });
    // 出租不再刷房间聊天；只有高品质鹿（风驰电掣/神鹿天降）在全服频道广播，吸引全服玩家来租
    if (isGreatDeer(deer)) {
      pushGlobalChat(
        `${player.name} 将「${deerFullName(deer)}」挂上出租市场（${rentPrice}金/场），全服可租`,
      );
    }
    broadcastViews(room);
  });

  // 收回挂出的鹿（被租用中不可收回）
  // 只在房间内操作：鹿回到鹿舍；登录玩家的鹿由账号持久化（挂出中标记）
  socket.on("unrentDeer", ({ marketId }) => {
    const room = rooms[currentRoom];
    if (!room) return;
    const player = room.players[socket.id];
    if (!player) return;
    const idx = rentalMarket.findIndex((m) => {
      if (m.id !== marketId) return false;
      if (m.ownerId === socket.id) return true;
      return !!(socket.data.account && m.ownerAccount === socket.data.account);
    });
    if (idx === -1) return;
    const m = rentalMarket[idx];
    if (m.rentedBy) {
      socket.emit("error", "该鹿正被租用，无法收回");
      return;
    }
    rentalMarket.splice(idx, 1);
    m.deer.owner = socket.id;
    // 账号玩家同时清除"挂出中"标记（鹿随账号持久化，收回后恢复可用）
    if (socket.data.account) Account.unlistDeer(socket.data.account, m.deer.id);
    player.deers.push(m.deer);
    Account.syncFromPlayer(player);
    emitRentalMarket();
    socket.emit("deerInfo", {
      ok: true,
      unrented: true,
      name: deerFullName(m.deer),
    });
    broadcastViews(room);
  });

  // 租用市场里的鹿作为自己的参赛鹿（一场；比赛结束自动归还）
  // 一次只能租一只；租金当场付给挂出者
  // 租用需要登录：市场是跨房间的全服共享池，只有账号玩家能租（游客只能观战）
  socket.on("rentDeer", ({ marketId }) => {
    if (!socket.data.account) {
      socket.emit("error", "租用鹿需要先登录账号");
      return;
    }
    const room = rooms[currentRoom];
    if (!room) return;
    const player = room.players[socket.id];
    if (!player) return;
    const idx = rentalMarket.findIndex((m) => m.id === marketId && !m.rentedBy);
    if (idx === -1) return;
    const m = rentalMarket[idx];
    if (player.gold < m.rentPrice) {
      socket.emit("error", `金币不足，租用需要 ${m.rentPrice} 金币`);
      return;
    }
    if (player.deers.some((d) => d.rented)) {
      socket.emit("error", "一次只能租用一只鹿");
      return;
    }
    player.gold -= m.rentPrice;
    const rentedDeer = { ...m.deer, rented: m.id };
    rentedDeer.owner = socket.id;
    player.deers.push(rentedDeer);
    m.rentedBy = socket.id;
    m.rentedByName = player.name;
    // 租金给挂出者（保底收入）
    if (!payGoldTo(m.ownerId, m.rentPrice) && m.ownerAccount) {
      Account.addGold(m.ownerAccount, m.rentPrice);
    }
    Account.syncFromPlayer(player);
    emitRentalMarket();
    socket.emit("deerInfo", {
      ok: true,
      rented: true,
      rentPrice: m.rentPrice,
      name: deerFullName(m.deer),
    });
    broadcastViews(room); // 租用不产生聊天消息（全服频道只广播高品质出租）
  });

  // 提前归还租来的鹿（比赛结束也会自动归还）
  socket.on("returnRentedDeer", ({ deerId }) => {
    const room = rooms[currentRoom];
    if (!room) return;
    const player = room.players[socket.id];
    if (!player) return;
    const deer = player.deers.find((d) => d.id === deerId && d.rented);
    if (!deer) return;
    returnRentedDeer(player);
    Account.syncFromPlayer(player);
    emitRentalMarket();
    socket.emit("deerInfo", {
      ok: true,
      returned: true,
      name: deerFullName(deer),
    });
    broadcastViews(room);
  });

  // 配种：两只自己的鹿（非租来/非小鹿/未退役）按公式生出小鹿
  // 小鹿属性 = 父母属性均值 × (0.85~1.15)；品质 = 父母品质均值 ±0/1；
  // 配种后父母冷却 3 分钟，花费固定金币
  socket.on("breedDeer", ({ deerAId, deerBId }) => {
    const room = rooms[currentRoom];
    if (!room) return;
    const player = room.players[socket.id];
    if (!player) return;
    if (!deerAId || !deerBId || deerAId === deerBId) return;
    const a = player.deers.find((d) => d.id === deerAId);
    const b = player.deers.find((d) => d.id === deerBId);
    if (!a || !b) return;
    if (a.rented || b.rented) {
      socket.emit("error", "租来的鹿不能配种");
      return;
    }
    if (a.isFawn || b.isFawn) {
      socket.emit("error", "小鹿还不能配种，先喂养长大");
      return;
    }
    if (
      (a.races || 0) >= GameConfig.MAX_RACES ||
      (b.races || 0) >= GameConfig.MAX_RACES
    ) {
      socket.emit("error", "老鹿已退役，不能再配种，可卖出养老");
      return;
    }
    const now = Date.now();
    if ((a.breedCdUntil || 0) > now || (b.breedCdUntil || 0) > now) {
      socket.emit(
        "error",
        `配种后需休息 ${Math.ceil(GameConfig.BREED_CD_MS / 60000)} 分钟才能再次配种`,
      );
      return;
    }
    if (player.gold < GameConfig.BREED_COST) {
      socket.emit("error", `金币不足，配种需要 ${GameConfig.BREED_COST} 金币`);
      return;
    }
    player.gold -= GameConfig.BREED_COST;
    a.breedCdUntil = now + GameConfig.BREED_CD_MS;
    b.breedCdUntil = now + GameConfig.BREED_CD_MS;
    // 小鹿品质与属性
    const ranges = {
      1: [18, 35],
      2: [28, 50],
      3: [42, 65],
      4: [58, 80],
      5: [72, 95],
    };
    const qAvg = Math.round((a.quality + b.quality) / 2);
    const roll = Math.random();
    const q = Math.max(
      1,
      Math.min(5, qAvg + (roll < 0.25 ? -1 : roll < 0.5 ? 0 : 1)),
    );
    const r = ranges[q];
    const capVar = 4 + q * 2;
    const mkCap = () => Math.min(99, Math.round(r[1] + Math.random() * capVar));
    const caps = { speed: mkCap(), stamina: mkCap(), agility: mkCap() };
    const inherit = (x, y, cap) =>
      Math.min(
        cap,
        Math.max(
          r[0],
          Math.round(((x + y) / 2) * (0.85 + Math.random() * 0.3)),
        ),
      );
    const child = {
      id: Date.now().toString(36) + Math.random().toString(36).substr(2, 4),
      name: NAMES[Math.floor(Math.random() * NAMES.length)],
      title: ELEGANT_TITLES[q][Math.floor(Math.random() * 3)],
      quality: q,
      price: q * 200 + Math.floor(Math.random() * 100),
      speed: inherit(a.speed, b.speed, caps.speed),
      stamina: inherit(a.stamina, b.stamina, caps.stamina),
      agility: inherit(a.agility, b.agility, caps.agility),
      caps,
      desc: QUALITY_DESC[q].desc,
      owner: socket.id,
      races: 0,
      champWins: 0,
      antler: { growUntil: 0 },
      breedCdUntil: 0,
      isFawn: true, // 小鹿：喂养 3 次后成年
      fed: 0,
      // 特技：配种小鹿也按品质 roll（继承父母特技的小几率提高，由品质决定）
      trick: GameConfig.rollTrick(q),
    };
    player.deers.push(child);
    Account.syncFromPlayer(player);
    syncRoom(
      room,
      `💞 ${player.name} 配种成功，新小鹿「${deerFullName(child)}」诞生！`,
    );
    socket.emit("deerInfo", {
      ok: true,
      bred: true,
      name: deerFullName(child),
      quality: q,
    });
  });

  // 喂养小鹿：花金币随机提升一项属性；喂满 FAWN_FEED_NEED 次成年
  socket.on("feedDeer", ({ deerId }) => {
    const room = rooms[currentRoom];
    if (!room) return;
    const player = room.players[socket.id];
    if (!player) return;
    const deer = player.deers.find((d) => d.id === deerId);
    if (!deer) return;
    if (deer.rented) {
      socket.emit("error", "租来的鹿不能喂养");
      return;
    }
    if (!deer.isFawn) {
      socket.emit("error", "只有小鹿可以喂养");
      return;
    }
    if (deer.fed >= GameConfig.FAWN_FEED_NEED) {
      socket.emit("error", "小鹿已经喂饱成年了");
      return;
    }
    if (player.gold < GameConfig.FEED_COST) {
      socket.emit("error", `金币不足，喂养需要 ${GameConfig.FEED_COST} 金币`);
      return;
    }
    player.gold -= GameConfig.FEED_COST;
    const gain = Math.floor(Math.random() * 3) + 1;
    const attrs = ["speed", "stamina", "agility"];
    const attr = attrs[Math.floor(Math.random() * attrs.length)];
    const cap = (deer.caps && deer.caps[attr]) || 99;
    deer[attr] = Math.min(cap, deer[attr] + gain);
    deer.fed = (deer.fed || 0) + 1;
    let grown = false;
    if (deer.fed >= GameConfig.FAWN_FEED_NEED) {
      deer.isFawn = false;
      grown = true;
    }
    Account.syncFromPlayer(player);
    broadcastViews(room);
    socket.emit("deerInfo", {
      ok: true,
      fed: true,
      attr,
      gain,
      grown,
      name: deerFullName(deer),
    });
  });

  // 收割鹿茸：鹿茸成熟后可收割换金币，收割后重新开始成长
  socket.on("harvestAntler", ({ deerId }) => {
    const room = rooms[currentRoom];
    if (!room) return;
    const player = room.players[socket.id];
    if (!player) return;
    const deer = player.deers.find((d) => d.id === deerId);
    if (!deer) return;
    if (deer.rented) {
      socket.emit("error", "租来的鹿不能收割鹿茸");
      return;
    }
    if ((deer.races || 0) >= GameConfig.MAX_RACES) {
      socket.emit("error", "这头鹿已老去退役，不能再收割鹿茸，可卖出养老");
      return;
    }
    const antler = deer.antler || (deer.antler = { growUntil: 0 });
    const now = Date.now();
    if (antler.growUntil > now) {
      const left = Math.ceil((antler.growUntil - now) / 1000);
      socket.emit("error", `鹿茸还在成长，约 ${left} 秒后可收割`);
      return;
    }
    const gold =
      deer.quality * GameConfig.ANTLER_BASE +
      Math.floor(Math.random() * GameConfig.ANTLER_RAND);
    player.gold += gold;
    antler.growUntil = now + GameConfig.ANTLER_GROW_MS;
    Account.syncFromPlayer(player);
    syncRoom(
      room,
      `🦌 ${player.name} 收割了 ${deerFullName(deer)} 的鹿茸，获得 ${gold} 金币`,
    );
    socket.emit("deerInfo", {
      ok: true,
      antler: true,
      gold,
      name: deerFullName(deer),
    });
  });

  // 主动退出房间（普通玩家或房主）：与断线同样的清理逻辑
  socket.on("leaveRoom", () => {
    removePlayerFromRoom(socket.id, currentRoom);
  });

  // 断开连接（关页面/断网）：清理逻辑与主动退出共用
  socket.on("disconnect", () => {
    console.log("玩家离开:", socket.id);
    removePlayerFromRoom(socket.id, currentRoom);
  });
});

// 出租市场条目公开视图（不含真实属性）
function rentalMarketPublicItems() {
  return rentalMarket.map((m) => ({
    id: m.id,
    deer: publicDeer(m.deer),
    ownerId: m.ownerId,
    ownerName: m.ownerName,
    ownerAccount: m.ownerAccount || null, // 登录玩家的账号名（前端用于识别"自己的鹿"，重连后 socket.id 会变）
    rentPrice: m.rentPrice,
    rentedBy: m.rentedBy || null,
  }));
}

// 广播出租市场快照（全服：大厅面板 + 房间内"我的出租"栏实时同步）
function emitRentalMarket() {
  io.emit("rentalMarketUpdate", { items: rentalMarketPublicItems() });
}

// 给玩家加金币（跨房间查找；返回是否找到在线玩家）
function payGoldTo(playerId, amount) {
  for (const r of Object.values(rooms)) {
    const p = r.players[playerId];
    if (p) {
      p.gold += amount;
      Account.syncFromPlayer(p);
      return true;
    }
  }
  return false;
}

// 归还玩家租用的鹿（比赛结束 / 退出房间 / 断线时调用）：从鹿舍移除回出租市场
function returnRentedDeer(player) {
  const rented = (player.deers || []).filter((d) => d.rented);
  if (!rented.length) return;
  for (const d of rented) {
    const m = rentalMarket.find((x) => x.id === d.rented);
    if (m) {
      m.rentedBy = null;
      m.rentedByName = null;
    }
    player.deers = player.deers.filter((x) => x.id !== d.id);
  }
}

// 从房间移除玩家：退投注、房主转交、空房删除、广播（主动退出与断线共用）
function removePlayerFromRoom(socketId, roomId) {
  if (!roomId || !rooms[roomId]) return;
  const room = rooms[roomId];
  const player = room.players[socketId];
  const leftName = player ? player.name : "玩家";
  if (player) {
    // 归还租用的鹿（回出租市场，市场同步在广播时由 emitRentalMarket 处理）
    const hadRented = player.deers.some((d) => d.rented);
    returnRentedDeer(player);
    // 移除该玩家的所有投注，退回金币
    if (player.bets.length > 0) {
      for (const b of player.bets) player.gold += b.amount;
      player.bets = [];
    }
    // 比赛未开始就退房：返还参赛费（开赛后锁定不退）
    if (player.selectedDeerId && !room.raceState) {
      player.gold += GameConfig.ENTRY_FEE;
      player.selectedDeerId = null;
      player.ready = false;
    }
    Account.syncFromPlayer(player);
    if (hadRented) emitRentalMarket();
  }
  delete room.players[socketId];
  // 房主离开：把房主转交给房间内最早的玩家
  if (room.host === socketId) {
    const remaining = Object.keys(room.players);
    if (remaining.length === 0) {
      // 空房销毁：停止所有定时器
      if (room._cdTimer) clearInterval(room._cdTimer);
      if (room._raceTimer) clearInterval(room._raceTimer);
      // 比赛未正常结束（还在投注/比赛途中）：通知全服直播移除这场"幽灵比赛"
      if (room.raceState && room.raceState.status !== "finished") {
        io.emit("raceCanceled", { roomId });
      }
      delete rooms[roomId];
      broadcastRoomList(); // 大厅房间列表同步移除
      return;
    }
    room.host = remaining[0];
    room.hostName = room.players[remaining[0]].name;
    syncRoom(room, `👑 ${leftName} 离开了房间，${room.hostName} 成为新房主`);
  } else {
    syncRoom(room, `🚪 ${leftName} 离开了房间`);
  }
  broadcastRoomList(); // 人数变化，同步大厅房间列表
}

// 商店自动刷新：到点整批换新并重置手动刷新花费；每秒向房间广播刷新倒计时与花费
setInterval(() => {
  const now = Date.now();
  for (const room of Object.values(rooms)) {
    if (now >= room.shopRefreshesAt) {
      room.shop = generateShop();
      room.shopRefreshesAt = now + SHOP_REFRESH_MS;
      room.manualRefreshCount = 0;
      broadcastViews(room);
    } else if (Object.keys(room.players).length > 0) {
      io.to(room.roomId).emit("shopTimer", {
        roomId: room.roomId,
        seconds: Math.max(0, Math.ceil((room.shopRefreshesAt - now) / 1000)),
        cost: shopRefreshCostFor(room),
      });
    }
  }
}, 1000);

function startRaceSimulation(room, roomId) {
  room.raceState.status = "racing";
  broadcastViews(room);

  const racers = room.raceState.racers;
  // 位置步进 + 物件判定 + 名次判定收进纯引擎 race-engine.js（无 io/定时器，可单测）
  const race = createRace(
    racers,
    room.raceState.type,
    room.raceState.trackObjects,
  );

  const interval = setInterval(() => {
    // 房间已销毁（如全员退出）：立即停止模拟，不再向全服广播位置
    if (!rooms[room.roomId]) {
      clearInterval(interval);
      return;
    }
    // 推进一步，拿到本步事件流并广播（时钟与广播是引擎的 adapter）
    // 位置在引擎内是 0~TRACK_LEN，广播给前端时统一归一化回 0~100
    const events = stepRace(race);
    for (const ev of events) {
      if (typeof ev.pos === "number") ev.pos = GameConfig.trackScale(ev.pos);
      io.emit("raceEvent", { roomId, ...ev });
    }
    io.emit("racePositions", {
      roomId,
      positions: race.positions.map((p) => GameConfig.trackScale(p)),
    });
    if (race.done) {
      clearInterval(interval);
      room.raceState.finishOrder = race.finishOrder;
      room.raceState.status = "finished";
      // 结算奖励
      const winnerIdx = race.finishOrder[0];
      const winnerOwner = racers[winnerIdx].ownerId;
      // 结算投注：按投注类型逐一判定，多注累加赔付
      const finishDeerIds = race.finishOrder.map((i) => racers[i].deer.id);
      for (const p of Object.values(room.players)) {
        if (!p.bets.length) continue;
        let totalWin = 0;
        for (const bet of p.bets) {
          totalWin += settleBet(
            bet,
            finishDeerIds,
            room.raceState.odds,
            racers,
          );
        }
        if (totalWin > 0) {
          p.gold += totalWin;
          p.lastBetResult = "win";
          p.lastBetGold = totalWin;
        } else {
          p.lastBetResult = "lose";
          p.lastBetGold = 0;
        }
        p.bets = [];
        Account.syncFromPlayer(p);
      }
      // 奖励参赛冠军主人 + 胜场 +1
      if (winnerOwner && room.players[winnerOwner]) {
        room.players[winnerOwner].gold += GameConfig.WINNER_REWARD;
        room.players[winnerOwner].wins =
          (room.players[winnerOwner].wins || 0) + 1;
        Account.syncFromPlayer(room.players[winnerOwner]);
      }
      // 鹿老去：玩家鹿每场参赛后 +1 场次，夺冠记录冠军次数；
      // 属性上限按 RACE_CAP_DECAY 衰减（大比例），当前属性按 RACE_ATTR_DECAY 衰减（小比例）；
      // 达到 MAX_RACES 后退役（不能再参赛/出租/配种，只能卖出）
      for (let ri = 0; ri < racers.length; ri++) {
        const r = racers[ri];
        if (!r.ownerId || !room.players[r.ownerId]) continue; // AI 鹿不老化
        const deer = r.deer;
        deer.races = (deer.races || 0) + 1;
        const rank = race.finishOrder.indexOf(ri);
        if (rank === 0) deer.champWins = (deer.champWins || 0) + 1;
        const caps = deer.caps;
        for (const attr of ["speed", "stamina", "agility"]) {
          if (caps && caps[attr]) {
            caps[attr] = Math.max(
              1,
              Math.round(caps[attr] * (1 - GameConfig.RACE_CAP_DECAY)),
            );
          }
          deer[attr] = Math.min(
            caps && caps[attr] ? caps[attr] : deer[attr],
            Math.max(
              1,
              Math.round(deer[attr] * (1 - GameConfig.RACE_ATTR_DECAY)),
            ),
          );
        }
        // 老去后同步更新已查验的星级显示
        if (deer.inspected) {
          deer.inspected = {
            speed: attrStars(deer.speed),
            stamina: attrStars(deer.stamina),
            agility: attrStars(deer.agility),
          };
        }
        Account.syncFromPlayer(room.players[r.ownerId]);
      }
      // 出租给 AI 的鹿结算租金：参赛即付 rentPrice，夺冠额外 + rentPrice×2
      // （挂出者的保底收入：鹿挂市场后每场比赛自动赚钱，防止金币归零）
      for (const r of racers) {
        if (!r.rental) continue;
        let income = r.rental.rentPrice;
        const rank = race.finishOrder.indexOf(racers.indexOf(r));
        if (rank === 0) income += r.rental.rentPrice * 2; // 夺冠奖金
        if (r.rental.ownerId && payGoldTo(r.rental.ownerId, income)) {
          // 在线玩家已入账
        } else if (r.rental.ownerAccount) {
          Account.addGold(r.rental.ownerAccount, income);
        }
      }
      // 归还玩家租用的鹿（回出租市场，供下一场继续被租）
      for (const p of Object.values(room.players)) {
        if (p.deers.some((d) => d.rented)) {
          returnRentedDeer(p);
          Account.syncFromPlayer(p);
        }
      }
      emitRentalMarket();
      // 本场已消费参赛费：结算后清空出战选择与准备状态，下一场需重新选鹿再出战
      for (const p of Object.values(room.players)) {
        p.selectedDeerId = null;
        p.ready = false;
      }
      // 按个人视角推送（每个人只看到自己的结果）
      syncRoom(room, `冠军：${deerFullName(racers[winnerIdx].deer)}`);
      io.emit("raceResult", {
        roomId,
        winner: deerFullName(racers[winnerIdx].deer),
        finishOrder: race.finishOrder.map((i) => ({
          name: deerFullName(racers[i].deer),
          owner: room.players[racers[i].ownerId]?.name || "AI",
        })),
      });
      // 重置比赛状态
      setTimeout(() => {
        room.raceState = null;
        broadcastViews(room);
      }, 8000);
    }
  }, 80);
  room._raceTimer = interval; // 存到房间，供空房销毁时停止模拟
}

const PORT = process.env.PORT || 50865;
// 绑定地址：本地默认 127.0.0.1（配 IIS 反代）；托管平台设 HOST=0.0.0.0 或由平台注入 PORT
const HOST = process.env.HOST || "127.0.0.1";
server.listen(PORT, HOST, () => {
  console.log(
    `荣耀赛鹿服务器运行在 http://${HOST}:${PORT} (${HOST === "0.0.0.0" ? "托管平台模式，对外可访问" : "本地模式，或 IIS 反向代理"})`,
  );
});
