/* =========================================================
   server/race-engine.js — 纯比赛引擎（无 io / 定时器依赖）
   createRace(racers, config, trackObjects) 构建比赛状态；
   stepRace(race) 推进一步，返回本步产生的事件数组（纯函数）。

   【需求1】所有概率/权重/数值一律读 game-values.js（V），公式读
   game-formulas.js（F）。管理人员只需改数值文件即可平衡。
   【需求2/4/5】支持平直(短距/耐力/障碍)、跑圈(lap)、山坡(hill)三种
   赛道；车道数 lanes 与参赛鹿数 deerCount 由房间 config 决定，
   非硬编码。圈数/长度/角度/登顶距离全部来自 config。
   【需求6】已移除"冲出赛道(runoff)"事件。
   【需求7】物件采用"判定点 pos + 渲染位置 renderPos"格式；姿态动画
   （洞/障碍/吃草）判定点间距由 generateTrackObjects 保证；鹿在判定
   点直接判定并当场播放动画（不再 approach 冲向物件正上方）。
   比赛事件全部在服务器内判定后整体向客户端转播，避免时序问题。

   时钟（setInterval）与广播（io.emit）由调用方作为 adapter 提供。
   ========================================================= */
const path = require("path");
const V = require(path.join(__dirname, "..", "public", "js", "game-values.js"));
const F = require(
  path.join(__dirname, "..", "public", "js", "game-formulas.js"),
);

const TOTAL_STEPS = 3000; // 安全上限，正常会提前结束

// 创建比赛状态
// config: { type, lanes, deerCount, trackLen, laps, angle, summit }（未规范化也可，内部 normalize）
function createRace(racers, config, trackObjects) {
  const cfg = F.normalizeRaceConfig(config);
  const len = F.effectiveTrackLen(cfg);
  const lanes = cfg.lanes;

  return {
    racers,
    config: cfg,
    type: cfg.type,
    len, // 内部赛道总长（跑圈=圈数×400；山坡=登顶距离；平直=trackLen）
    lanes,
    trackObjects: trackObjects || [],
    positions: racers.map(() => 0),
    finished: new Array(racers.length).fill(false),
    finishOrder: [],
    // 每只鹿的事件状态（服务器权威，只广播动画，不暴露属性）
    // 状态机：normal(正常跑) -> 在判定点 pos 判定：
    //   - 判定为"会躲过"：jumping（立即跳起，跨过物件后恢复）
    //   - 判定为"会中招"：inObject（直接在判定点播放动画）
    eventState: racers.map((r, i) => {
      const es = {
        state: "normal", // normal | jumping | inObject
        until: 0, // inObject 结束的 step
        jumpEnd: 0, // jumping 结束的位置
        mult: 1,
        nextObj: 0, // 下一个待判定的赛道物件索引
        lane: i % lanes, // 初始车道：轮流分配（i % 车道数），非硬编码
        // 道具状态
        boostUntil: 0, // 加速结束的 step
        shieldUntil: 0,
        shield: false, // 护盾：下一次物件判定必定躲过/不吃草，然后消耗
        attackUntil: 0, // 被攻击眩晕结束的 step
        attackMult: 1, // 被攻击期间的倍速
        laneChangeUntil: 0, // 换道动画结束的 step（期间不再触发换道）
        // 技能系统（内置 CD：触发后冷却若干步，期间不再触发）
        skillCd: 0, // 技能冷却计数（每步递减）
        sprintUntil: 0, // 爆发冲刺结束的 step
        focusNext: false, // 专注：下一个物件判定必定躲过（然后消耗）
        // 随机事件
        momentumUntil: 0, // 状态火热结束的 step
        pebbleUntil: 0, // 踩到石子结束的 step
        // 疲劳
        fatigue: 0,
      };
      // 特技映射（读公式库 trickInfo）
      const info = F.trickInfo(r.deer && r.deer.trick);
      es.trick = r.deer && r.deer.trick ? r.deer.trick : null;
      es.trickEffect = info ? info.effect : null;
      es.hasStartBoost =
        es.trickEffect === "startBoost" ||
        es.trickEffect === "sprint" ||
        es.trickEffect === "item";
      return es;
    }),
    step: 0,
    done: false,
  };
}

// 推进一步；返回本步产生的事件数组 [{ type, deerIndex, pos }, ...]
function stepRace(race) {
  const events = [];
  const { racers } = race;
  const cfg = race.config;
  const len = race.len;
  const lanes = race.lanes;
  const trackObjects = race.trackObjects;
  const JUDGE_X = V.JUDGE_X;
  const RENDER_OFFSET = V.RENDER_OFFSET;
  race.step++;

  // 山坡坡度系数（仅 hill 生效）：ratio = angle / maxAngle
  const hillRatio = cfg.type === "hill" ? cfg.angle / V.HILL.maxAngle : 0;
  const hillSpeedMul = 1 - hillRatio * V.HILL.speedPenalty;
  const hillFatigueMul = 1 + hillRatio * V.HILL.fatigueAmp;

  for (let i = 0; i < racers.length; i++) {
    if (race.finished[i]) continue;
    const d = racers[i].deer;
    const es = race.eventState[i];
    const stamina = d.stamina / 100;
    const agility = d.agility / 100;

    // ===== 基础速度：类型主属性权重（F.baseSpeed，含起跑敏捷加成）=====
    const bs = F.baseSpeed(cfg.type, d, race.step);
    let base = bs.base;

    // 特技·疾风起跑：前 N 步额外爆发加速
    if (
      es.trickEffect === "startBoost" &&
      race.step <= V.TRICK.startBoostSteps
    ) {
      base +=
        V.TRICK.startBoostAmt * (1 - race.step / (V.TRICK.startBoostSteps * 2));
    }

    // ===== 体力：疲劳随赛程累积，与耐力成反比；山坡上疲劳累积更快 =====
    const fatigueInc =
      (V.FATIGUE.incBase - stamina * V.FATIGUE.perStam) *
      hillFatigueMul *
      (es.trickEffect === "fatigueReduce" ? V.TRICK.fatigueMul : 1);
    es.fatigue = (es.fatigue || 0) + fatigueInc;
    const staminaMul = 1 - Math.min(1, es.fatigue) * V.FATIGUE.speedMul;

    // ===== 稳定性：随机波动幅度与敏捷成反比（敏捷高发挥更稳定）=====
    let speedFactor =
      (base +
        (Math.random() - 0.5) *
          V.RANDOM_SCOPE *
          (V.RANDOM_AGILITY_FACTOR - agility)) *
      staminaMul;

    // 随机小爆发（概率/幅度读数值）
    if (Math.random() < V.RANDOM_BOOST_P) speedFactor += V.RANDOM_BOOST_AMT;
    // 道具：加速效果（拾取后持续提速）
    if (race.step < es.boostUntil) speedFactor += V.POWERUP.boostAmt;
    // 被道具攻击：眩晕减速
    if (race.step < es.attackUntil) speedFactor *= es.attackMult;
    // 技能效果（带内置 CD，见 normal 状态技能触发）
    if (race.step < es.sprintUntil) speedFactor += V.SKILL.sprintAmt;
    // 特技·爆发冲刺：过半程后再加速
    if (
      es.trickEffect === "lateSprint" &&
      race.positions[i] > len * V.TRICK.lateThreshold
    ) {
      speedFactor += V.TRICK.lateSprintAmt;
    }
    // 随机事件效果
    if (race.step < es.momentumUntil) speedFactor += V.RANDOM_EVENT.momentumAmt;
    if (race.step < es.pebbleUntil) speedFactor *= V.RANDOM_EVENT.pebbleMult;

    // ===== 物件驱动事件系统（判定点在物体前 JUDGE_X 处；渲染位置在 renderPos）=====
    const objs = trackObjects;

    if (es.state === "inObject") {
      // 动画结束，恢复跑步
      if (race.step >= es.until) {
        es.state = "normal";
        es.mult = 1;
      }
    } else if (es.state === "jumping") {
      // 跳跃跨过物体：到达 jumpEnd 恢复（钳制落点）
      if (race.positions[i] >= es.jumpEnd) {
        race.positions[i] = es.jumpEnd;
        es.state = "normal";
        es.mult = 1;
      }
    } else if (es.state === "normal") {
      // ===== 技能系统（内置 CD）=====
      if (es.skillCd > 0) es.skillCd--;
      if (es.skillCd <= 0) {
        const S = V.SKILL;
        const pSprint = S.sprintPBase + agility * S.sprintPPerSpeed;
        const pFocus = S.focusPBase + agility * S.focusPPerAgi;
        const pRecover = S.recoverPBase + stamina * S.recoverPPerStam;
        const total = pSprint + pFocus + pRecover;
        if (Math.random() < total) {
          const roll = Math.random() * total;
          if (roll < pSprint) {
            es.sprintUntil = race.step + S.sprintDur;
            es.skillCd =
              S.sprintCd[0] + Math.floor(Math.random() * S.sprintCd[1]);
            events.push({
              type: "skillSprint",
              deerIndex: i,
              pos: Math.round(race.positions[i]),
            });
          } else if (roll < pSprint + pFocus) {
            es.focusNext = true;
            es.skillCd =
              S.focusCd[0] + Math.floor(Math.random() * S.focusCd[1]);
            events.push({
              type: "skillFocus",
              deerIndex: i,
              pos: Math.round(race.positions[i]),
            });
          } else {
            es.fatigue = Math.max(0, (es.fatigue || 0) - 0.05);
            es.skillCd =
              S.recoverCd[0] + Math.floor(Math.random() * S.recoverCd[1]);
            events.push({
              type: "skillRecover",
              deerIndex: i,
              pos: Math.round(race.positions[i]),
            });
          }
        }
      }
      // ===== 随机事件（无 CD，纯概率，读 V.RANDOM_EVENT）=====
      const RE = V.RANDOM_EVENT;
      if (Math.random() < RE.momentumP) {
        es.momentumUntil = race.step + RE.momentumDur;
        events.push({
          type: "momentum",
          deerIndex: i,
          pos: Math.round(race.positions[i]),
        });
      } else if (Math.random() < RE.pebbleP) {
        es.pebbleUntil = race.step + RE.pebbleDur;
        events.push({
          type: "pebble",
          deerIndex: i,
          pos: Math.round(race.positions[i]),
        });
      } else if (Math.random() < RE.twistP) {
        // 崴脚：小概率随机绊倒（无对应物件）
        es.state = "inObject";
        es.until = race.step + RE.twistDur;
        es.mult = RE.twistMult;
        events.push({
          type: "twist",
          deerIndex: i,
          pos: Math.round(race.positions[i]),
        });
      } else if (
        race.step > RE.laneChangeMinStep &&
        race.step >= es.laneChangeUntil &&
        race.positions[i] < len * 0.9 &&
        Math.random() < RE.laneChangeP
      ) {
        // 换道：随机变到相邻车道（物件按新车道过滤；可能撞到旁边鹿）
        const dir = Math.random() < 0.5 ? -1 : 1;
        const target = Math.max(0, Math.min(lanes - 1, es.lane + dir));
        if (target !== es.lane) {
          es.lane = target;
          es.laneChangeUntil = race.step + RE.laneChangeCd;
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
              Math.abs(race.positions[j] - race.positions[i]) <
                RE.laneChangeRange
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
          if (obj.type === "powerup") {
            // 拾取道具：随机获得 加速 / 攻击 / 护盾
            const P = V.POWERUP;
            const durMul =
              es.trickEffect === "itemDuration" ? V.ITEM_DUR_MUL : 1;
            const roll = Math.random();
            if (roll < P.boostP) {
              es.boostUntil = race.step + Math.round(P.boostDur * durMul);
              events.push({
                type: "boost",
                deerIndex: i,
                pos: Math.round(race.positions[i]),
              });
            } else if (roll < P.attackP) {
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
                race.eventState[target].attackUntil =
                  race.step + Math.round(P.attackDur * durMul);
                race.eventState[target].attackMult = P.attackMult;
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
                es.boostUntil =
                  race.step + Math.round(P.fallbackBoostDur * durMul);
                events.push({
                  type: "boost",
                  deerIndex: i,
                  pos: Math.round(race.positions[i]),
                });
              }
            } else {
              es.shield = true;
              es.shieldUntil = race.step + Math.round(P.shieldDur * durMul);
              events.push({
                type: "shield",
                deerIndex: i,
                pos: Math.round(race.positions[i]),
              });
            }
          } else if (obj.type === "hole") {
            // 洞：护盾/专注必定跳过；否则按敏捷判定
            const jumpBoost =
              es.trickEffect === "obstacle" ? V.TRICK.jumpBoost : 0;
            if (es.shield && race.step >= es.shieldUntil) es.shield = false;
            const hasShield = es.shield;
            if (hasShield) es.shield = false;
            const hasFocus = es.focusNext;
            if (hasFocus) es.focusNext = false;
            const J = V.JUMP;
            const jumpP =
              hasShield || hasFocus
                ? 1
                : J.holeBase +
                  (d.agility / 100) * J.holePerAgi +
                  jumpBoost +
                  Math.random() * J.holeRand;
            if (Math.random() < jumpP) {
              // 会躲过：在判定点跳起，跨过物件
              race.positions[i] = obj.pos;
              es.state = "jumping";
              es.jumpEnd = (obj.renderPos || obj.pos) + JUDGE_X;
              es.mult = 0.9;
              events.push({
                type: "jump",
                deerIndex: i,
                pos: obj.pos,
              });
            } else {
              // 会掉进去：直接在判定点掉下（不再 approach 冲向正上方）
              es.state = "inObject";
              es.until = race.step + 14;
              es.mult = 0;
              events.push({
                type: "hole",
                deerIndex: i,
                pos: obj.pos,
              });
            }
          } else if (obj.type === "obstacle") {
            const jumpBoost =
              es.trickEffect === "obstacle" ? V.TRICK.jumpBoost : 0;
            if (es.shield && race.step >= es.shieldUntil) es.shield = false;
            const hasShield = es.shield;
            if (hasShield) es.shield = false;
            const hasFocus = es.focusNext;
            if (hasFocus) es.focusNext = false;
            const J = V.JUMP;
            const jumpP =
              hasShield || hasFocus
                ? 1
                : J.obsBase +
                  (d.agility / 100) * J.obsPerAgi +
                  jumpBoost +
                  Math.random() * J.obsRand;
            if (Math.random() < jumpP) {
              race.positions[i] = obj.pos;
              es.state = "jumping";
              es.jumpEnd = (obj.renderPos || obj.pos) + JUDGE_X;
              es.mult = 0.9;
              events.push({
                type: "jump",
                deerIndex: i,
                pos: obj.pos,
              });
            } else {
              es.state = "inObject";
              es.until = race.step + 16;
              es.mult = 0.15;
              events.push({
                type: "obstacle",
                deerIndex: i,
                pos: obj.pos,
              });
            }
          } else if (obj.type === "grass") {
            // 草：护盾/专注免疫吃草；否则体力越低越容易停下吃草
            if (es.shield && race.step >= es.shieldUntil) es.shield = false;
            const hasShield = es.shield;
            if (hasShield) es.shield = false;
            const hasFocus = es.focusNext;
            if (hasFocus) es.focusNext = false;
            const J = V.JUMP;
            const grazeP =
              hasShield || hasFocus
                ? 0
                : J.grassBase +
                  (1 - d.stamina / 100) * J.grassPerStam +
                  Math.random() * J.grassRand;
            if (Math.random() < grazeP) {
              // 会吃草：直接在判定点停下吃草
              es.state = "inObject";
              es.until = race.step + 14;
              es.mult = 0;
              events.push({
                type: "graze",
                deerIndex: i,
                pos: obj.pos,
              });
            }
            // 不吃草：继续前进（物件已消费）
          }
        }
      }
    }
    speedFactor *= es.mult;

    // 速度修复：放大步进，保证属性普通的鹿也能跑完全程
    // 步进随赛道长度放大：len 越长步进越大（保证有限步数内跑完全程）
    const stepScale = V.SPEED_MULT * Math.pow(len / V.FLAT_TRACK.default, 0.35);
    race.positions[i] += Math.max(0, speedFactor * stepScale);
    if (race.positions[i] >= len && !race.finished[i]) {
      race.positions[i] = len;
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
