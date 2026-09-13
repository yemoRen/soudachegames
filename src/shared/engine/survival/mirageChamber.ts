/*
 * mirageChamber.ts — 蜃景密室（末世行止·高风险的 boss 连战玩法）。
 *
 * 设计要点（用户需求）：
 *  - 消耗 30 行动点，让「当前出击者」跑一次危险等级 7 的扭曲时空。
 *  - 内部为危1 → 危7 的 boss 连战，共 7 个 boss，连战无休息（血量跨场继承）。
 *  - 无经验获取（不走 XP 体系）。
 *  - 每击败一个 boss 即有两件 boss 产出（按该 boss 危险度各掉落一件带阶级词缀的装备，专属爆率表）。
 *  - 全程产出战斗日志（逐关交战回合 / 胜负 / 剩余生命 / 掉落）。
 *
 * 复用 battle-v5 正式战斗链路（buildSurvivorUnit / buildEnemyUnit / resolveDuelToCompletion），
 * 数值体系与真实遇怪战斗一致；boss 危险度缩放沿用 content.ts 的 ENEMY_DANGER_SCALE（危N ≈ +10%×N）。
 * 成员最大血量锚定到其持久最大血量，保证战斗内 / 回写同口径。
 */

import type { Attributes } from '@shared/types/cultivator';
import { AttributeType, ModifierType } from '@shared/engine/battle-v5/core/types';
import { BattleRuntime } from '@shared/engine/battle-v5/runtime/BattleRuntime';
import { resolveDuelToCompletion } from '@shared/engine/battle-v5/round/BattleAutoResolver';
import type { EnemyArchetype } from '@shared/engine/extraction';

import type { SurvivalGameState } from './state';
import { buildArenaLoadout, trySpendActionPoints, ACTION_POINT_CAP } from './state';
import { buildSurvivorUnit, buildEnemyUnit } from './combatAdapter';
import { rollGearDrop } from './affixes';
import { applyNearDeath } from './recovery';
import type { GearItem } from './economy';
import type { RNG } from './rng';

/** 进入蜃景密室固定消耗的行动点 */
export const MIRAGE_AP_COST = 30;

/** 每击败一名 boss 必掉落的战利品件数（高风险高回报：两件） */
export const MIRAGE_DROPS_PER_BOSS = 2;

interface BossDef {
  id: string;
  name: string;
  attributes: Attributes;
  threatNote: string;
}

/** 七位 boss（危1→危7 难度递增，且叠加危险度缩放后整体单调递增） */
const MIRAGE_BOSSES: BossDef[] = [
  { id: 'mirage-landlord', name: '楼王·腐化房东', attributes: { vitality: 10, strength: 11, spirit: 3, endurance: 9, speed: 5, willpower: 5 }, threatNote: '盘踞公寓顶层的变异巨物，力量惊人' },
  { id: 'mirage-corpseKing', name: '尸潮之主', attributes: { vitality: 13, strength: 12, spirit: 5, endurance: 11, speed: 6, willpower: 6 }, threatNote: '整座医院的尸群都听它号令' },
  { id: 'mirage-scrapKing', name: '拾荒王·铁钩', attributes: { vitality: 14, strength: 14, spirit: 7, endurance: 13, speed: 9, willpower: 9 }, threatNote: '废墟帮开创者，钩爪夺命' },
  { id: 'mirage-hiveMother', name: '隧道巢母', attributes: { vitality: 17, strength: 15, spirit: 8, endurance: 15, speed: 7, willpower: 7 }, threatNote: '整条地铁线的变异源头，虫卵铺满洞壁' },
  { id: 'mirage-beast', name: '变异巨兽', attributes: { vitality: 20, strength: 18, spirit: 6, endurance: 16, speed: 7, willpower: 8 }, threatNote: '区域霸主级巨兽' },
  { id: 'mirage-overseer', name: '督战官·灰烬', attributes: { vitality: 15, strength: 15, spirit: 12, endurance: 14, speed: 11, willpower: 12 }, threatNote: '末日当天仍未停止执行军令的钢铁之影' },
  { id: 'mirage-warlord', name: '战争领主', attributes: { vitality: 22, strength: 22, spirit: 16, endurance: 18, speed: 12, willpower: 14 }, threatNote: '禁区统治者，词缀叠加后堪称死神' },
];

/** 危险度 → 敌人基础六维乘数（与 content.ts 的 ENEMY_DANGER_SCALE 同口径） */
const DANGER_SCALE: Record<number, number> = {
  1: 1.0,
  2: 1.10,
  3: 1.20,
  4: 1.30,
  5: 1.40,
  6: 1.50,
  7: 1.60,
};

/** 单关战斗记录（供 UI 展示 / 持久化精简） */
export interface MirageRoundLog {
  danger: number;
  bossName: string;
  turns: number;
  won: boolean;
  hpAfter: number;
  maxHp: number;
  drops?: { name: string; rarity: string; value: number }[];
}

/** 蜃景密室运行结果 */
export interface MirageResult {
  ok: boolean;
  reason?: string;
  survivorName?: string;
  rounds: MirageRoundLog[];
  /** 是否通关全 7 关 */
  cleared: boolean;
  totalDrops: GearItem[];
  finalHp: number;
  maxHp: number;
  /** 人类可读战斗日志（逐行） */
  log: string[];
}

function scaleAttrs(a: Attributes, s: number): Attributes {
  return {
    vitality: Math.max(1, Math.round(a.vitality * s)),
    strength: Math.max(1, Math.round(a.strength * s)),
    spirit: Math.max(1, Math.round(a.spirit * s)),
    endurance: Math.max(1, Math.round(a.endurance * s)),
    speed: Math.max(1, Math.round(a.speed * s)),
    willpower: Math.max(1, Math.round(a.willpower * s)),
  };
}

/**
 * 运行一次蜃景密室连战。
 * 返回新的 SurvivalGameState（已扣行动点、已写入战利品 / 成员状态 / 战斗日志）与 MirageResult（供 UI 即时展示）。
 * 若前置条件不满足（行动点不足 / 成员濒死 / 无效），state 原样返回、result.ok=false。
 */
export function runMirageChamber(
  state: SurvivalGameState,
  survivorId: string,
  rng: RNG,
  now: number = Date.now(),
): { state: SurvivalGameState; result: MirageResult } {
  const profile = state.survivors.find((s) => s.id === survivorId);
  const status0 = state.survivorStatus[survivorId];
  const fail = (reason: string, partial?: Partial<MirageResult>): { state: SurvivalGameState; result: MirageResult } => ({
    state,
    result: { ok: false, reason, rounds: [], cleared: false, totalDrops: [], finalHp: 0, maxHp: 0, log: [`⚠ ${reason}`], ...partial },
  });
  if (!profile || !status0) return fail('无效的出击者');
  const afterAp = trySpendActionPoints(state, MIRAGE_AP_COST, now);
  if (!afterAp) {
    return fail(`行动点不足，需 ${MIRAGE_AP_COST} 点（当前 ${state.actionPoints ?? ACTION_POINT_CAP}）`, {
      finalHp: status0.currentHp,
      maxHp: status0.maxHp,
    });
  }
  if (status0.dyingUntil && new Date(status0.dyingUntil).getTime() > now) {
    return {
      state: afterAp,
      result: {
        ok: false,
        reason: '该成员处于濒死状态，无法进入蜃景密室',
        rounds: [],
        cleared: false,
        totalDrops: [],
        finalHp: status0.currentHp,
        maxHp: status0.maxHp,
        log: ['⚠ 该成员处于濒死状态，无法进入蜃景密室'],
      },
    };
  }

  const load = buildArenaLoadout(afterAp, survivorId);
  if (!load) return fail('无法构建出击者战斗单位', { finalHp: status0.currentHp, maxHp: status0.maxHp });

  const runtime = new BattleRuntime();
  const survivorUnit = buildSurvivorUnit(load.profile, load.attributes, load.bonus, runtime, status0.currentHp);
  const memberMax = status0.maxHp ?? survivorUnit.getMaxHp();
  // 把单位最大血量锚定到成员持久最大血量，保证战斗内 / 回写同口径
  const naturalMax = survivorUnit.getMaxHp();
  if (naturalMax !== memberMax) {
    survivorUnit.attributes.addModifier({
      id: 'mirage-maxhp',
      attrType: AttributeType.MAX_HP,
      type: ModifierType.FIXED,
      value: memberMax - naturalMax,
      source: { sourceType: 'survivalBonus', carrierId: 'mirage' },
    });
    survivorUnit.updateDerivedStats();
    survivorUnit.initializeResources({ hp: status0.currentHp });
  }

  const log: string[] = [];
  const rounds: MirageRoundLog[] = [];
  const drops: GearItem[] = [];
  let curHp = status0.currentHp;
  let cleared = true;

  log.push(
    `【蜃景密室开启】${profile.name} 踏入危险等级 7 的扭曲时空——危1~危7 的 boss 连战，连战无休息、无经验，唯有战利品。`,
  );

  for (let d = 1; d <= 7; d++) {
    const bossDef = MIRAGE_BOSSES[d - 1];
    const scale = DANGER_SCALE[d] ?? 1;
    const enemy: EnemyArchetype = {
      ...bossDef,
      attributes: scaleAttrs(bossDef.attributes, scale),
      boss: true,
      threatNote: bossDef.threatNote,
    };
    const enemyUnit = buildEnemyUnit(runtime, enemy);
    const duel = resolveDuelToCompletion({
      battleId: `mirage-${survivorId}-${d}-${now}`,
      player: survivorUnit,
      opponent: enemyUnit,
      runtime,
    });
    const playerId = survivorUnit.id;
    const survivorWon = duel.winner === playerId;
    const myHp = survivorWon ? duel.winnerSnapshot.hp.current : duel.loserSnapshot.hp.current;
    const hpNum = Math.max(0, Math.round(myHp));
    if (survivorWon) {
      log.push(`第 ${d} 关 · 危${d}｜【${bossDef.name}】交战 ${duel.turns} 回合 —— ⭕ 击破！剩余生命 ${hpNum}/${memberMax}`);
      const roundDrops: { name: string; rarity: string; value: number }[] = [];
      for (let k = 0; k < MIRAGE_DROPS_PER_BOSS; k++) {
        // 蜃景密室专属爆率表（MIRAGE_GEAR_QUALITY_WEIGHTS）；luckBias=0 让表值即为实际分布
        const drop = rollGearDrop(rng, d, 0, 0, false, true);
        drops.push(drop.gear);
        roundDrops.push({ name: drop.name, rarity: drop.rarityName, value: drop.value });
        log.push(`　🎁 掉落：【${drop.name}】（${drop.rarityName}，估值 ${drop.value}）`);
      }
      rounds.push({
        danger: d,
        bossName: bossDef.name,
        turns: duel.turns,
        won: true,
        hpAfter: hpNum,
        maxHp: memberMax,
        drops: roundDrops,
      });
      curHp = Math.max(1, hpNum);
      survivorUnit.initializeResources({ hp: curHp });
    } else {
      cleared = false;
      log.push(`第 ${d} 关 · 危${d}｜【${bossDef.name}】交战 ${duel.turns} 回合 —— ❌ ${profile.name} 倒下了！`);
      rounds.push({ danger: d, bossName: bossDef.name, turns: duel.turns, won: false, hpAfter: hpNum, maxHp: memberMax });
      break;
    }
  }

  // ===== 回写成员状态 =====
  let nextStatus = status0;
  if (!cleared) {
    nextStatus = applyNearDeath(status0, now);
  } else {
    const finalHp = Math.min(memberMax, Math.max(0, Math.round(curHp)));
    nextStatus = {
      ...status0,
      currentHp: finalHp,
      sortieReady: finalHp >= memberMax * 0.95 && status0.injuries.length === 0,
    };
    log.push(`🏆 全 7 关连战通关！${profile.name} 携战利品全身而退，剩余生命 ${finalHp}/${memberMax}。`);
  }

  const newState: SurvivalGameState = {
    ...afterAp,
    gear: [...afterAp.gear, ...drops],
    survivorStatus: { ...afterAp.survivorStatus, [survivorId]: nextStatus },
    mirage: { log, cleared, at: now },
    log: [
      `【蜃景密室】${profile.name} ${cleared ? '通关全 7 关' : `止步第 ${rounds.length} 关`}，获得 ${drops.length} 件装备。`,
      ...afterAp.log,
    ].slice(0, 50),
  };

  const result: MirageResult = {
    ok: true,
    survivorName: profile.name,
    rounds,
    cleared,
    totalDrops: drops,
    finalHp: nextStatus.currentHp,
    maxHp: memberMax,
    log,
  };
  return { state: newState, result };
}
