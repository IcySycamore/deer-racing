/* =========================================================
   server/accounts.js — 账号深层模块（唯一持久化点）
   接口：register / login / rename / bindToPlayer / syncFromPlayer / publicAccount
   实现：哈希校验、迁移、双向同步全部藏在模块内部；
   持久化通过 storage adapter（生产 fs 写盘，测试可换内存）。
   玩家对象 ↔ 账号对象的双向拷贝只在这里发生（单一真相同步点）。
   ========================================================= */
const fs = require("fs");
const crypto = require("crypto");

function createAccountStore(options = {}) {
  const filePath = options.filePath || null;
  // storage adapter：load() 返回账号对象，save(accounts) 持久化
  const storage = options.storage || {
    load() {
      if (!filePath || !fs.existsSync(filePath)) return {};
      try {
        return JSON.parse(fs.readFileSync(filePath, "utf8"));
      } catch (e) {
        return {};
      }
    },
    save(accounts) {
      if (!filePath) return;
      try {
        fs.writeFileSync(filePath, JSON.stringify(accounts, null, 2));
      } catch (e) {
        console.error("保存账号失败:", e.message);
      }
    },
  };
  // 注册时创建初始鹿（由调用方注入，解耦随机鹿生成）
  const createStarterDeer = options.createStarterDeer || (() => null);

  let accounts = storage.load();
  // 迁移：清理旧数据中的 emoji 星号字段（stars 已废弃），并补上昵称 name
  let dirty = false;
  for (const u of Object.keys(accounts)) {
    const acc = accounts[u];
    if (acc && !acc.name) {
      acc.name = u;
      dirty = true;
    }
    if (acc && Array.isArray(acc.deers)) {
      for (const d of acc.deers) {
        if (d && d.stars !== undefined) {
          delete d.stars;
          dirty = true;
        }
      }
    }
  }
  if (dirty) storage.save(accounts);

  function hashPassword(pw, salt) {
    return crypto
      .createHash("sha256")
      .update(salt + pw)
      .digest("hex");
  }

  function saveAccounts() {
    storage.save(accounts);
  }

  // 账号公开视图（不含密码）
  function publicAccount(username) {
    const acc = accounts[username];
    if (!acc) return null;
    return {
      username: acc.username,
      name: acc.name || acc.username,
      gold: acc.gold,
      wins: acc.wins,
      deerCount: acc.deers.length,
    };
  }

  // 注册：返回 {ok, msg, account?}
  function register(username, password) {
    username = String(username || "")
      .trim()
      .slice(0, 12);
    if (username.length < 2) return { ok: false, msg: "用户名至少2个字符" };
    if (String(password || "").length < 4)
      return { ok: false, msg: "密码至少4位" };
    if (accounts[username]) return { ok: false, msg: "用户名已存在" };
    const salt = crypto.randomBytes(8).toString("hex");
    const deers = [createStarterDeer()];
    accounts[username] = {
      username,
      name: username, // 昵称，默认与用户名相同，可改
      salt,
      passwordHash: hashPassword(password, salt),
      gold: 1000,
      deers,
      wins: 0,
      createdAt: Date.now(),
    };
    if (deers[0]) deers[0].owner = null;
    saveAccounts();
    return { ok: true, msg: "注册成功", account: publicAccount(username) };
  }

  // 登录：返回 {ok, msg, account?}
  function login(username, password) {
    username = String(username || "")
      .trim()
      .slice(0, 12);
    const acc = accounts[username];
    if (!acc) return { ok: false, msg: "账号不存在" };
    if (acc.passwordHash !== hashPassword(password, acc.salt))
      return { ok: false, msg: "密码错误" };
    return { ok: true, msg: "登录成功", account: publicAccount(username) };
  }

  // 修改昵称（持久化）；返回是否发生变更
  function rename(username, newName) {
    const acc = accounts[username];
    if (!acc || acc.name === newName) return false;
    acc.name = newName;
    saveAccounts();
    return true;
  }

  // 修改密码：验证旧密码，设置新密码；返回 {ok, msg}
  function changePassword(username, oldPassword, newPassword) {
    const acc = accounts[username];
    if (!acc) return { ok: false, msg: "账号不存在" };
    if (acc.passwordHash !== hashPassword(oldPassword, acc.salt))
      return { ok: false, msg: "旧密码错误" };
    if (String(newPassword || "").length < 4)
      return { ok: false, msg: "新密码至少4位" };
    acc.salt = crypto.randomBytes(8).toString("hex");
    acc.passwordHash = hashPassword(newPassword, acc.salt);
    saveAccounts();
    return { ok: true, msg: "密码修改成功" };
  }

  // 把账号数据应用到房间玩家（进入房间/绑定身份时）
  // 挂出中的鹿（listed）不进入鹿舍——它已经在出租市场里
  function bindToPlayer(player, username) {
    const acc = accounts[username];
    if (!acc) return;
    player.account = username;
    player.name = acc.name || username;
    player.gold = acc.gold;
    player.deers = acc.deers.filter((d) => !d.listed).map((d) => ({ ...d }));
    player.wins = acc.wins || 0;
  }

  // 给账号加金币（出租收入等离线/跨房间入账）；返回是否成功
  function addGold(username, amount) {
    const acc = accounts[username];
    if (!acc) return false;
    acc.gold = (acc.gold || 0) + amount;
    saveAccounts();
    return true;
  }

  // 标记账号鹿舍里的一只鹿为"挂出中"（鹿已在出租市场，不随房间加载）
  function listDeer(username, deerId) {
    const acc = accounts[username];
    if (!acc) return false;
    const d = (acc.deers || []).find((x) => x.id === deerId);
    if (!d) return false;
    d.listed = true;
    saveAccounts();
    return true;
  }

  // 清除"挂出中"标记（大厅/房间内收回鹿时）
  function unlistDeer(username, deerId) {
    const acc = accounts[username];
    if (!acc) return false;
    const d = (acc.deers || []).find((x) => x.id === deerId);
    if (!d) return false;
    delete d.listed;
    saveAccounts();
    return true;
  }

  // 清除所有账号的"挂出中"标记（服务器重启时调用：内存市场清空，
  // 若鹿还标记挂出中会永远无法使用，需恢复为鹿舍可用）
  function clearAllListed() {
    let dirty = false;
    for (const u of Object.keys(accounts)) {
      const acc = accounts[u];
      if (!acc || !Array.isArray(acc.deers)) continue;
      for (const d of acc.deers) {
        if (d && d.listed) {
          delete d.listed;
          dirty = true;
        }
      }
    }
    if (dirty) saveAccounts();
  }

  // 保存玩家数据回账号（下注/训练/改名等任何金币或鹿变更后）
  // 挂出中的鹿（listed）保留在账号鹿舍，避免被覆盖丢失
  function syncFromPlayer(player) {
    if (!player.account || !accounts[player.account]) return;
    const acc = accounts[player.account];
    acc.name = player.name;
    acc.gold = player.gold;
    const listed = (acc.deers || []).filter((d) => d.listed);
    acc.deers = [...player.deers, ...listed];
    acc.wins = player.wins || 0;
    saveAccounts();
  }

  return {
    register,
    login,
    rename,
    changePassword,
    bindToPlayer,
    syncFromPlayer,
    publicAccount,
    addGold,
    listDeer,
    unlistDeer,
    clearAllListed,
  };
}

module.exports = createAccountStore;
