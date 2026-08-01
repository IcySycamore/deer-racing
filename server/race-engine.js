/* =========================================================
   server/race-engine.js — 纯比赛引擎（无 io / 定时器依赖）
   createRace(racers, type, trackObjects) 构建比赛状态；
   stepRace(race) 推进一步，返回本步产生的事件数组（纯函数）。
   位置步进 + 物件判定 + 名次判定全部在这里，可独立单测；
   时钟（setInterval）与广播（io.emit）由调用方作为 adapter 提供。
   ========================================================= */
const path = require("path");
const GameConfig = require(
  path.join(__dirname, "..", "public", "js", "game-config.js"),
);

const TOTAL_STEPS = 300; // 安全上限（约24秒），正常会提前结束

// 创建比赛状态
function createRace(racers, type, trackObjects) {
  return {
    racers,
    type,
    trackObjects: trackObjects || [],
    positions: racers.map(() => 0),
    finished: new Array(racers.length).fill(false),
    finishOrder: [],
    // 每只鹿的事件状态（服务器权威，只广播动画，不暴露属性）
    // 状态机：normal(正常跑) -> 在判定点 pos 判定：
    //   - 判定为"会躲过"：jumping（立即跳起，跨过物件后恢复）
    //   - 判定为"会中招"：approach（以原速/1.5倍速冲向物件）-> inObject（触发动画）
    eventState: racers.map((r, i) => ({
      state: "normal", // normal | approach | jumping | inObject
      obj: null, // approach 阶段冲向的物件
      until: 0, // inObject 结束的 step
      jumpEnd: 0, // jumping 结束的位置
      mult: 1,
      nextObj: 0, // 下一个待判定的赛道物件索引
      lane: i, // 当前车道（换道事件会改变；物件按此车道过滤）
      // 道具状态
      boostUntil: 0, // 加速结束的 step
      shield: false, // 护盾：下一次物件判定必定躲过/不吃草，然后消耗
      attackUntil: 0, // 被攻击眩晕结束的 step
      attackMult: 1, // 被攻击期间的倍速
      laneChangeUntil: 0, // 换道动画结束的 step（期间不再触发换道/冲出）
      // 技能系统（内置 CD：触发后冷却若干步，期间不再触发）
      skillCd: 0, // 技能冷却计数（每步递减）
      sprintUntil: 0, // 爆发冲刺结束的 step
      focusNext: false, // 专注：下一个物件判定必定躲过（然后消耗）
      // 随机事件
      momentumUntil: 0, // 状态火热结束的 step
      pebbleUntil: 0, // 踩到石子结束的 step
    })),
    step: 0,
    done: false,
  };
}

// 推进一步；返回本步产生的事件数组 [{ type, deerIndex, pos }, ...]
function stepRace(race) {
  const events = [];
  const { racers, type, trackObjects } = race;
  // 物件渲染在 renderPos = 判定点 + RENDER_OFFSET（固定位移）：
  //   会中招的在物件位置（renderPos）掉/撞/吃草，
  //   会躲过的在判定点就跳起来，视觉上明显在物件前起跳。
  // 跳跃落点余量：起跳(pos) -> 落地(renderPos + JUDGE_X)，总跨度 < 物件最小间隔
  const JUDGE_X = GameConfig.JUDGE_X;
  race.step++;

  for (let i = 0; i < racers.length; i++) {
    if (race.finished[i]) continue;
    const d = racers[i].deer;
    const es = race.eventState[i];
    const speed = d.speed / 100;
    const stamina = d.stamina / 100;
    const agility = d.agility / 100;
    // ===== 三项属性深度参与（任何比赛类型都生效，不只是主属性）=====
    // 1) 基础速度：比赛类型主属性权重最大，但速度/耐力/敏捷都参与
    //    - 短距赛：速度为主，敏捷（起步/变道）次之，耐力兜底
    //    - 耐力赛：耐力为主，敏捷/速度次之
    //    - 障碍赛：敏捷为主，速度/耐力次之
    let base;
    if (type === "sprint") base = speed * 0.45 + agility * 0.3 + stamina * 0.15;
    else if (type === "endurance")
      base = stamina * 0.45 + agility * 0.25 + speed * 0.2;
    else base = agility * 0.45 + speed * 0.25 + stamina * 0.2;
    base += Math.random() * 0.1; // 保底随机
    // 2) 起跑反应：前 12 步敏捷加成（线性消退）—— 敏捷高的鹿起步快
    base += Math.max(0, 1 - race.step / 12) * agility * 0.18;
    // 3) 体力：疲劳随赛程累积，与耐力成反比 —— 耐力低的鹿后段明显掉速
    //    fatigue 每步增量 = 0.005 - stamina*0.0035（耐力 0→1 时 0.005→0.0015）
    es.fatigue = (es.fatigue || 0) + (0.005 - stamina * 0.0035);
    const staminaMul = 1 - Math.min(1, es.fatigue) * 0.45;
    // 4) 稳定性：随机波动幅度与敏捷成反比 —— 敏捷高的鹿发挥更稳定
    //    随机占比加大（0.12→0.2），防止低赔率鹿被稳定预测一直赢
    let speedFactor =
      (base + (Math.random() - 0.5) * 0.2 * (1.4 - agility)) * staminaMul;
    // 5) 随机技能触发（概率加大）
    if (Math.random() < 0.05) speedFactor += 0.14; // 加速
    // 6) 道具：加速效果（拾取后持续提速）
    if (race.step < es.boostUntil) speedFactor += 0.22;
    // 7) 被道具攻击：眩晕减速
    if (race.step < es.attackUntil) speedFactor *= es.attackMult;
    // 8) 技能效果（带内置 CD，见 normal 状态技能触发）
    if (race.step < es.sprintUntil) speedFactor += 0.25; // 爆发冲刺
    // 9) 随机事件效果
    if (race.step < es.momentumUntil) speedFactor += 0.3; // 状态火热
    if (race.step < es.pebbleUntil) speedFactor *= 0.7; // 踩到石子

    // ===== 物件驱动事件系统（判定点在物体前 JUDGE_X 处）=====
    const objs = trackObjects;

    if (es.state === "inObject") {
      // 动画结束，恢复跑步
      if (race.step >= es.until) {
        es.state = "normal";
        es.mult = 1;
      }
    } else if (es.state === "jumping") {
      // 跳跃跨过物体：到达 jumpEnd 恢复（钳制落点，消除步进超调，
      // 保证跳跃跨度严格 = jumpEnd - obj.pos < 物件最小间隔）
      if (race.positions[i] >= es.jumpEnd) {
        race.positions[i] = es.jumpEnd;
        es.state = "normal";
        es.mult = 1;
      }
    } else if (es.state === "approach") {
      // 已判定"会中招"：冲向物件，到达物件渲染位置（renderPos）触发动画
      const obj = es.obj;
      const rp = obj.renderPos || obj.pos;
      if (race.positions[i] >= rp) {
        // 回退到物件中心，避免超调（每步 1.2-1.8 单位）导致鹿视觉上冲过物件才触发
        race.positions[i] = rp;
        es.state = "inObject";
        es.obj = null;
        if (obj.type === "hole") {
          es.until = race.step + 14; // 掉进洞里约1.1秒
          es.mult = 0; // 掉进洞里完全停下，出来后才继续跑
          events.push({ type: "hole", deerIndex: i, pos: rp });
        } else if (obj.type === "obstacle") {
          es.until = race.step + 16;
          es.mult = 0.15;
          events.push({ type: "obstacle", deerIndex: i, pos: rp });
        } else if (obj.type === "grass") {
          es.until = race.step + 14;
          es.mult = 0; // 完全停下吃草
          events.push({ type: "graze", deerIndex: i, pos: rp });
        }
      }
    } else if (es.state === "normal") {
      // ===== 技能系统（内置 CD：每步递减，触发后冷却若干步）=====
      // 三种技能按属性概率竞争：冲刺（速度）/ 专注（敏捷）/ 回复（耐力）
      if (es.skillCd > 0) es.skillCd--;
      if (es.skillCd <= 0) {
        const pSprint = 0.02 + speed * 0.05;
        const pFocus = 0.015 + agility * 0.04;
        const pRecover = 0.012 + stamina * 0.03;
        const total = pSprint + pFocus + pRecover;
        if (Math.random() < total) {
          const roll = Math.random() * total;
          if (roll < pSprint) {
            es.sprintUntil = race.step + 12; // 爆发冲刺：12 步内提速
            es.skillCd = 50 + Math.floor(Math.random() * 40); // CD 50~90 步
            events.push({
              type: "skillSprint",
              deerIndex: i,
              pos: Math.round(race.positions[i]),
            });
          } else if (roll < pSprint + pFocus) {
            es.focusNext = true; // 专注：下一个物件判定必躲过
            es.skillCd = 70 + Math.floor(Math.random() * 40); // CD 70~110 步
            events.push({
              type: "skillFocus",
              deerIndex: i,
              pos: Math.round(race.positions[i]),
            });
          } else {
            es.fatigue = Math.max(0, (es.fatigue || 0) - 0.05); // 回复：消除部分疲劳
            es.skillCd = 60 + Math.floor(Math.random() * 30); // CD 60~90 步
            events.push({
              type: "skillRecover",
              deerIndex: i,
              pos: Math.round(race.positions[i]),
            });
          }
        }
      }
      // ===== 随机事件（无 CD，纯概率）=====
      if (Math.random() < 0.008) {
        // 状态火热：短时爆发
        es.momentumUntil = race.step + 8;
        events.push({
          type: "momentum",
          deerIndex: i,
          pos: Math.round(race.positions[i]),
        });
      } else if (Math.random() < 0.006) {
        // 踩到石子：短时失速
        es.pebbleUntil = race.step + 8;
        events.push({
          type: "pebble",
          deerIndex: i,
          pos: Math.round(race.positions[i]),
        });
      } else if (Math.random() < 0.015) {
        // 崴脚：小概率随机绊倒（无对应物件）
        es.state = "inObject";
        es.until = race.step + 12;
        es.mult = 0.55;
        events.push({
          type: "twist",
          deerIndex: i,
          pos: Math.round(race.positions[i]),
        });
      } else if (
        race.step > 8 &&
        race.step >= es.laneChangeUntil &&
        race.positions[i] < 90 &&
        Math.random() < 0.02
      ) {
        // 换道：随机变到相邻车道（物件按新车道过滤；可能撞到旁边鹿）
        const dir = Math.random() < 0.5 ? -1 : 1;
        const target = Math.max(
          0,
          Math.min(GameConfig.LANES - 1, es.lane + dir),
        );
        if (target !== es.lane) {
          es.lane = target;
          es.laneChangeUntil = race.step + 20;
          events.push({
            type: "laneChange",
            deerIndex: i,
            lane: target,
            pos: Math.round(race.positions[i]),
          });
          // 撞到同车道位置接近的鹿：双方互相减速
          for (let j = 0; j < racers.length; j++) {
            if (j === i || race.finished[j]) continue;
            const ej = race.eventState[j];
            if (
              ej.lane === target &&
              Math.abs(race.positions[j] - race.positions[i]) < 8
            ) {
              ej.state = "inObject";
              ej.until = race.step + 8;
              ej.mult = 0.5;
              es.state = "inObject";
              es.until = race.step + 8;
              es.mult = 0.5;
              events.push({
                type: "bump",
                deerIndex: j,
                pos: Math.round(race.positions[j]),
              });
              break;
            }
          }
        }
      } else if (
        race.positions[i] > 30 &&
        race.positions[i] < 90 &&
        race.step >= es.laneChangeUntil &&
        Math.random() < 0.012
      ) {
        // 冲出赛道（攻击观赛者）：鹿跑出赛道，损失大量时间
        es.state = "inObject";
        es.until = race.step + 22;
        es.mult = 0.12;
        events.push({
          type: "runoff",
          deerIndex: i,
          pos: Math.round(race.positions[i]),
        });
      } else {
        // 到达下一个物件的判定点（物件位置 pos 处判定一次）
        // 跳过不属于自己车道的物件（物体带 lane：只对自己当前车道的鹿生效）
        let obj = objs[es.nextObj];
        while (obj && obj.lane !== undefined && obj.lane !== es.lane) {
          es.nextObj++;
          obj = objs[es.nextObj];
        }
        if (obj && race.positions[i] >= obj.pos) {
          es.nextObj++; // 消费该物件，避免重复判定
          const rp = obj.renderPos || obj.pos;
          if (obj.type === "powerup") {
            // 拾取道具：随机获得 加速 / 攻击 / 护盾
            const roll = Math.random();
            if (roll < 0.34) {
              // 加速
              es.boostUntil = race.step + 45;
              events.push({
                type: "boost",
                deerIndex: i,
                pos: Math.round(race.positions[i]),
              });
            } else if (roll < 0.67) {
              // 攻击前方最近未完成的鹿
              let target = -1;
              let bestD = Infinity;
              for (let j = 0; j < racers.length; j++) {
                if (j === i || race.finished[j]) continue;
                const dist = race.positions[j] - race.positions[i];
                if (dist > 0 && dist < bestD) {
                  bestD = dist;
                  target = j;
                }
              }
              if (target >= 0) {
                race.eventState[target].attackUntil = race.step + 16;
                race.eventState[target].attackMult = 0.35;
                events.push({
                  type: "attack",
                  deerIndex: target,
                  pos: Math.round(race.positions[target]),
                });
                events.push({
                  type: "powerup",
                  deerIndex: i,
                  pos: Math.round(race.positions[i]),
                  kind: "attack",
                });
              } else {
                // 没有可攻击对象：转为加速
                es.boostUntil = race.step + 30;
                events.push({
                  type: "boost",
                  deerIndex: i,
                  pos: Math.round(race.positions[i]),
                });
              }
            } else {
              // 护盾：下一次物件判定必定躲过/不吃草
              es.shield = true;
              events.push({
                type: "shield",
                deerIndex: i,
                pos: Math.round(race.positions[i]),
              });
            }
          } else if (obj.type === "hole") {
            // 洞：护盾/专注必定跳过；否则按敏捷判定（随机占比加大，防低赔率稳赢）
            const hasShield = es.shield;
            if (hasShield) es.shield = false;
            const hasFocus = es.focusNext;
            if (hasFocus) es.focusNext = false;
            const jumpP =
              hasShield || hasFocus
                ? 1
                : 0.3 + (d.agility / 100) * 0.25 + Math.random() * 0.25;
            if (Math.random() < jumpP) {
              // 会躲过：在判定点跳起，跨过物件（物件在 renderPos）
              // 钳制起跳位置到判定点，跳跃跨度 = rp + JUDGE_X - obj.pos < 最小间隔
              race.positions[i] = obj.pos;
              es.state = "jumping";
              es.jumpEnd = rp + JUDGE_X;
              es.mult = 0.9;
              events.push({
                type: "jump",
                deerIndex: i,
                pos: obj.pos, // 动画显示在跳起点（判定点，物件前方）
              });
            } else {
              // 会掉进去：原速冲向物件，到物件处掉下
              es.state = "approach";
              es.obj = obj;
              es.mult = 1;
            }
          } else if (obj.type === "obstacle") {
            // 障碍：护盾/专注必定跳过；否则按敏捷判定
            const hasShield = es.shield;
            if (hasShield) es.shield = false;
            const hasFocus = es.focusNext;
            if (hasFocus) es.focusNext = false;
            const jumpP =
              hasShield || hasFocus
                ? 1
                : 0.35 + (d.agility / 100) * 0.3 + Math.random() * 0.25;
            if (Math.random() < jumpP) {
              race.positions[i] = obj.pos;
              es.state = "jumping";
              es.jumpEnd = rp + JUDGE_X;
              es.mult = 0.9;
              events.push({
                type: "jump",
                deerIndex: i,
                pos: obj.pos,
              });
            } else {
              es.state = "approach";
              es.obj = obj;
              es.mult = 1;
            }
          } else if (obj.type === "grass") {
            // 草：护盾/专注免疫吃草；否则体力越低越容易停下吃草
            const hasShield = es.shield;
            if (hasShield) es.shield = false;
            const hasFocus = es.focusNext;
            if (hasFocus) es.focusNext = false;
            const grazeP =
              hasShield || hasFocus
                ? 0
                : 0.3 + (1 - d.stamina / 100) * 0.2 + Math.random() * 0.2;
            if (Math.random() < grazeP) {
              // 会吃草：1.5倍速冲向草，到草处停下吃草
              es.state = "approach";
              es.obj = obj;
              es.mult = 1.5;
            }
            // 不吃草：继续前进（物件已消费）
          }
        }
      }
    }
    speedFactor *= es.mult;
    // 速度修复：放大步进，保证属性普通的鹿也能跑完全程
    race.positions[i] += Math.max(0, speedFactor * 2.0);
    if (race.positions[i] >= 100 && !race.finished[i]) {
      race.positions[i] = 100;
      race.finished[i] = true;
      race.finishOrder.push(i);
    }
  }

  race.done = race.finished.every((f) => f) || race.step >= TOTAL_STEPS;
  if (race.done) {
    // 确保所有人完成
    for (let i = 0; i < racers.length; i++) {
      if (!race.finished[i]) {
        race.finished[i] = true;
        race.finishOrder.push(i);
      }
    }
  }
  return events;
}

module.exports = { createRace, stepRace, TOTAL_STEPS };
