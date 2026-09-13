/**
 * Phase 1 — 搜打撤核心引擎（v1.0.1 出击玩法重做版）
 *
 * 核心循环：搜(搜刮) → 遭遇事件 → 决策(开战/绕行/投掷脱离/突围) → 打(自动回合战斗) → 撤(撤离结算)。
 *
 * v1.0.1 增量（对局搜索出击页设计）：
 *  - 对局倒计时：RUN_TIME_LIMIT_SEC 内完成搜打撤，时间耗尽未撤离 → 直接判定阵亡（timeout）。
 *  - 时间就是风险：每次行动消耗对局时间；越接近封锁，遭遇概率越高。
 *  - 多区域转移：每区最多搜 MAX_ZONE_SEARCHES 次，搜完必须转移。
 *  - 遭遇抉择：遭遇不再自动开战，强制玩家四选一（开战/潜行/投掷脱离/突围撤离）。
 *  - 弹药与护甲：交战消耗弹药；弹药不足被迫肉搏；护甲按承伤比例吸收损耗。
 *  - 安全箱：SECURE_BOX_SLOTS 格，阵亡也 100% 保留（搜打撤保底设计）。
 *  - 尸体搜刮：战斗胜利后可搜刮敌方尸体获取战利品。
 *  - 场景叙事：state.scene 承载当前场景文本（区别于底部滚动日志）。
 *
 * 引擎复用（不重写）：
 *  - 战斗：battle-v5 的 resolveDuelToCompletion（真实伤害/回合/胜负判定）
 *  - 状态：CultivatorCondition（hp/mp/毒性/创伤）作为「单次出击 survival 状态」
 */

import { Unit } from '@shared/engine/battle-v5/units/Unit';
import { AttributeType, ModifierType } from '@shared/engine/battle-v5/core/types';
import type { UnitId } from '@shared/engine/battle-v5/core/types';
import { BattleRuntime } from '@shared/engine/battle-v5/runtime/BattleRuntime';
import { resolveDuelToCompletion } from '@shared/engine/battle-v5/round/BattleAutoResolver';
import type { AutomaticDuelResolutionV1 } from '@shared/engine/battle-v5/round/BattleAutoResolver';
import type { CultivatorCondition } from '@shared/types/condition';
import { SYSTEM_LINES } from '@shared/theme/survival';
import {
  buildSurvivorUnit,
  buildEnemyUnit,
} from '@shared/engine/survival/combatAdapter';
import {
  rollEnemyAffixes,
  aggregateEnemyAffixes,
  rollGearDrop,
  mobGearDropChance,
} from '@shared/engine/survival/affixes';
import { RAID_PACK_CAPACITY } from '@shared/engine/survival/equipment';
import type { GearItem, GearSlot } from '@shared/engine/survival/economy';
import type { Injury } from '@shared/engine/survival/recovery';
import { applyInjuryToBase, injuryAttrPenalty, rollCombatInjuries } from '@shared/engine/survival/recovery';
import { INJURY_LABEL } from '@shared/engine/survival/recovery';
import type {
  AttrEffects,
  BattleReplayEntry,
  BattleRoundEntry,
  CombatBonus,
  DangerZone,
  EncounterAction,
  EnemyArchetype,
  ExtractOutcome,
  ExtractionRunState,
  ExtractionSummary,
  LootItem,
  PendingSearch,
  RunEquippedGear,
  SurvivorLoadout,
  ZoneGraph,
  ZoneNode,
} from './types';
import {
  ACTION_COST,
  EXTRACT_REVEAL_AT_SEC,
  EXTRACT_REVEAL_SEARCHES,
  FIGHT_AMMO_COST,
  MAP_BRANCH_COUNT,
  MAX_ZONE_SEARCHES,
  RUN_TIME_LIMIT_SEC,
  SECURE_BOX_SLOTS,
  threatEncounterChance,
  threatTierOf,
} from './types';
import type { Attributes } from '@shared/types/cultivator';
import { generateZoneGraph, ENEMY_DANGER_SCALE } from './content';

const ATTRIBUTE_MAP: Array<[keyof Attributes, AttributeType]> = [
  ['vitality', AttributeType.VITALITY],
  ['strength', AttributeType.STRENGTH],
  ['spirit', AttributeType.SPIRIT],
  ['endurance', AttributeType.ENDURANCE],
  ['speed', AttributeType.SPEED],
  ['willpower', AttributeType.WILLPOWER],
];

/** 构造一个可参战的 Unit（属性→战斗属性，自带普攻兜底） */
function buildUnit(
  runtime: BattleRuntime,
  id: string,
  name: string,
  attrs: Attributes,
  currentHp?: number,
): Unit {
  const baseAttrs = {} as Record<AttributeType, number>;
  for (const [key, attrType] of ATTRIBUTE_MAP) {
    baseAttrs[attrType] = attrs[key];
  }
  const unit = new Unit(id as UnitId, name, baseAttrs, { runtime });
  unit.updateDerivedStats();
  unit.initializeCurrentResourcesToMax();
  if (typeof currentHp === 'number') {
    unit.initializeResources({ hp: currentHp });
  }
  return unit;
}

/** 构造一份全新的 in-run 状态（复用 condition 结构） */
function freshCondition(maxHp: number, maxMp: number): CultivatorCondition {
  return {
    version: 1,
    resources: {
      hp: { current: maxHp, max: maxHp },
      mp: { current: maxMp, max: maxMp },
    },
    gauges: { pillToxicity: 0 },
    tracks: {
      tempering: {
        vitality: { level: 0, progress: 0 },
        spirit: { level: 0, progress: 0 },
        wisdom: { level: 0, progress: 0 },
        speed: { level: 0, progress: 0 },
        willpower: { level: 0, progress: 0 },
      },
      marrowWash: { version: 1, level: 0, progress: 0 },
    },
    counters: {
      longTermPillUsesByRealm: {},
      cultivationPillUsesByRealm: {},
      longevityPillUsesByRealm: {},
    },
    statuses: [],
    timestamps: {},
  };
}

// ===== v1.0.3：六维深化 + 伤势（debuff）实时生效 =====

/**
 * 六维深化派生值（引擎与 UI 共用一套口径）：
 *  - 力量 → 背包容量（白字每 1 点 = 1 格）、近战输出（进 battle-v5）
 *  - 敏捷 → 行动耗时系数、潜行成功率
 *  - 耐力 → 续航时限（每 1 点 = 1.5 分钟），超限开始判定疲惫
 *  - 体质 → 气血/回血（battle-v5 + recovery）、失血抗性
 *  - 意志 → 震伤（精神类伤势）抗性
 *  - 感知 → 预警敌人（降低遇敌率）、搜刮额外物资概率
 */
export function deriveAttrEffects(attrs: Attributes): AttrEffects {
  const strength = attrs.strength ?? 10;
  const speed = attrs.speed ?? 10;
  const endurance = attrs.endurance ?? 10;
  const vitality = attrs.vitality ?? 10;
  const spirit = attrs.spirit ?? 10;
  const willpower = attrs.willpower ?? 10;
  return {
    // 临时背包：基础力量（白字）每 1 点 = 1 格
    packCapacity: Math.max(1, Math.floor(strength)),
    // 敏捷 10 → 1.00；敏捷 20 → 0.80（搜索更快）；敏捷 6 → 1.08（更慢）
    timeScale: Math.max(0.72, Math.min(1.12, 1 - (speed - 10) * 0.02)),
    sneakBonus: (speed - 10) * 0.03,
    staminaMinutes: endurance * 1.5,
    // 感知 10 → 0；感知 20 → -0.20（遇敌率下降 20 个百分点）
    encounterAvoid: (spirit - 10) * 0.02,
    lootExtraChance: Math.min(0.6, spirit * 0.02),
    shockResist: Math.max(0.55, 1 - willpower * 0.015),
    bleedResist: Math.max(0.6, 1 - vitality * 0.01),
  };
}

/** 本局穿戴装备提供的六维加成 */
function runEquipAttrBonus(state: ExtractionRunState): Partial<Attributes> {
  const out: Partial<Attributes> = {};
  for (const e of state.equipped) {
    for (const k of Object.keys(e.gear.modifiers) as (keyof Attributes)[]) {
      out[k] = (out[k] ?? 0) + (e.gear.modifiers[k] ?? 0);
    }
  }
  return out;
}

/**
 * 本局「有效六维」= 基础六维 经伤势削减 + 当前穿戴装备 + 固定加成（避难所/势力）。
 * 换装 / 受伤 / 治疗都会立刻反映到下一次战斗与页面展示。
 */
export function runEffectiveAttributes(state: ExtractionRunState): Attributes {
  const profile = state.survivor.profile;
  const base: Attributes =
    state.baseAttributes ?? profile?.attributes ?? state.survivor.attributes;
  const injured = applyInjuryToBase(base, state.injuries ?? []);
  const out: Attributes = { ...injured };
  const equipBonus = runEquipAttrBonus(state);
  for (const k of Object.keys(equipBonus) as (keyof Attributes)[]) {
    out[k] += equipBonus[k] ?? 0;
  }
  const fixed = state.attrBonusFixed ?? {};
  for (const k of Object.keys(fixed) as (keyof Attributes)[]) {
    out[k] += fixed[k] ?? 0;
  }
  // v1.1.1⑥ 肾上腺素增益：副本时间 10 分钟内六维全属性 +5（计时窗口内持续生效，战斗与页面显示统一从此处取数）
  if ((state.buffUntilSec ?? 0) > (state.elapsedSec ?? 0)) {
    for (const k of ['vitality', 'strength', 'spirit', 'endurance', 'speed', 'willpower'] as (keyof Attributes)[]) {
      out[k] = (out[k] ?? 0) + 5;
    }
  }
  return out;
}

/** 本局有效战斗加成 = 基础加成（词条+避难所） + 当前穿戴装备的战斗词条 */
export function runCombatBonus(state: ExtractionRunState): CombatBonus {
  const baseBonus = state.bonusBase ?? state.survivor.bonus ?? {
    hpBonus: 0,
    critBonus: 0,
    lootLuck: 0,
    startHpRatio: 0,
  };
  let hpBonus = baseBonus.hpBonus ?? 0;
  let critBonus = baseBonus.critBonus ?? 0;
  let lootLuck = baseBonus.lootLuck ?? 0;
  let xpBonus = baseBonus.xpBonus ?? 0;
  let coinBonus = baseBonus.coinBonus ?? 0;
  for (const e of state.equipped) {
    const c = e.gear.combat;
    if (!c) continue;
    hpBonus += c.hpBonus ?? 0;
    critBonus += c.critBonus ?? 0;
    lootLuck += c.lootLuck ?? 0;
    xpBonus += c.xpBonus ?? 0;
    coinBonus += c.coinBonus ?? 0;
  }
  return { ...baseBonus, hpBonus, critBonus, lootLuck, xpBonus, coinBonus };
}

/** 给定穿戴列表的气血加成之和（用于副本最大血量锚点）。
 *  除战斗词条气血(hpBonus)外，还计入装备六维属性带来的气血：体质×20 + 耐力×3，
 *  使副本内换装有体质/耐力词条的装备时，最大血量随之正确变化（修复仅改气血词条才生效的问题）。 */
function equippedHpBonus(equipped: RunEquippedGear[]): number {
  let s = 0;
  for (const e of equipped) {
    const m = e.gear.modifiers ?? {};
    s += (m.vitality ?? 0) * 20 + (m.endurance ?? 0) * 3;
    s += e.gear.combat?.hpBonus ?? 0;
  }
  return s;
}

/**
 * 副本有效最大血量 = 出击起点 maxHp + 当前穿戴装备气血加成 + 出击途中档案增量（体质点 / 带气血词条）。
 * 这是副本内最大血量的唯一权威来源：换装、加点、选词条都只改它的构成项，不破坏当前血量语义。
 */
export function effectiveRunMaxHp(state: ExtractionRunState): number {
  return (state.startMaxHp ?? 0) + equippedHpBonus(state.equipped) + (state.profileMaxHpBonus ?? 0);
}

/**
 * 换装 / 加点 / 选词条后重算副本最大血量：仅改 max，current = min(max, 现有 current)。
 *  —— 满血时减 max 则 current 同减、加 max 则 current 不变；非满时 current 不超过 max（符合「不影响当前血量」）。
 */
export function recomputeRunMaxHp(state: ExtractionRunState): void {
  const newMax = effectiveRunMaxHp(state);
  const hp = state.condition.resources.hp;
  hp.max = newMax;
  hp.current = Math.min(newMax, hp.current ?? 0);
}

/** 本局战局背包容量 = 基础力量（白字）每 1 点 = 1 格（v1.0.5 起） */
export function runPackCapacity(state: ExtractionRunState): number {
  const base = state.baseAttributes?.strength ?? 10;
  return Math.max(1, Math.floor(base));
}

/** 伤势文本（UI 展示用）：给出该伤势削减了哪些基础六维、各减多少点 */
export function injuryAttrTextOf(state: ExtractionRunState, inj: Injury): string {
  const base: Attributes =
    state.baseAttributes ?? state.survivor.profile?.attributes ?? state.survivor.attributes;
  const after = applyInjuryToBase(base, [inj]);
  const def = injuryAttrPenalty([inj]);
  return (Object.keys(def) as (keyof Attributes)[])
    .map((k) => `${ATTR_LABEL_CN[k]} -${(base[k] ?? 0) - (after[k] ?? 0)}`)
    .join('、');
}

const ATTR_LABEL_CN: Record<keyof Attributes, string> = {
  vitality: '体质',
  strength: '力量',
  spirit: '感知',
  endurance: '耐力',
  speed: '敏捷',
  willpower: '意志',
};

function sumValue(items: LootItem[]): number {
  return items.reduce((acc, it) => acc + it.value * (it.qty ?? 1), 0);
}

/** 单件战利品在战局背包中占一格的判定：相同 id 的物品自动堆叠（不额外占格） */
function isSameStack(a: LootItem, b: LootItem): boolean {
  return a.id === b.id;
}

// ===== 对局时钟 =====

/** 对局内时钟文本 [mm:ss]（用于日志时间戳） */
export function fmtClock(totalSec: number): string {
  const s = Math.max(0, Math.round(totalSec));
  const mm = Math.floor(s / 60);
  const ss = s % 60;
  return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

/** 写入一条带对局时间戳的日志 */
function plog(state: ExtractionRunState, text: string): void {
  state.log.push(`[${fmtClock(state.elapsedSec)}] ${text}`);
}

/** 对局剩余时间（秒） */
export function timeLeft(state: ExtractionRunState): number {
  return Math.max(0, RUN_TIME_LIMIT_SEC - state.elapsedSec);
}

// ===== v1.0.5：分支图 / 威胁时钟 辅助 =====

/** 在分支图中按 id 取节点 */
function nodeById(state: ExtractionRunState, id: string): ZoneNode | undefined {
  return state.graph.nodes.find((n) => n.id === id);
}

/** 当前所在节点 */
export function currentZoneOf(state: ExtractionRunState): ZoneNode {
  return nodeById(state, state.currentZoneId) ?? state.graph.nodes[0];
}

/** 当前节点的相邻可移动节点 */
export function zoneNeighbors(state: ExtractionRunState): ZoneNode[] {
  const adj = state.graph.edges[state.currentZoneId] ?? [];
  return adj.map((id) => nodeById(state, id)).filter((n): n is ZoneNode => !!n);
}

/** 当前是否位于霸主所在最深层节点 */
export function isBossZone(state: ExtractionRunState): boolean {
  return state.currentZoneId === state.graph.bossZoneId;
}

/** 从当前节点出发，BFS 找到最近的撤离点（节点 id） */
export function nearestExtractZone(state: ExtractionRunState): string | null {
  if (state.graph.extractZones.length === 0) return null;
  const start = state.currentZoneId;
  const visited = new Set<string>([start]);
  const queue: string[] = [start];
  while (queue.length) {
    const cur = queue.shift()!;
    if (state.graph.extractZones.includes(cur)) return cur;
    for (const nb of state.graph.edges[cur] ?? []) {
      if (!visited.has(nb)) {
        visited.add(nb);
        queue.push(nb);
      }
    }
  }
  return null;
}

/**
 * v1.0.10：本区「深度」1..7 —— 只驱动**遇怪难度 / 遇怪概率**（威胁查表、敌人词缀、伏击率、经验）。
 * 与 `state.zone.dangerLevel`（= 本图难度 危1..危7，全图恒定，只驱动装备基础爆率）彻底解耦。
 */
function zoneDepth(state: ExtractionRunState): number {
  const d = currentZoneOf(state)?.depth ?? 1;
  return Math.max(1, Math.min(7, Math.round(d)));
}

// v1.1.7：副本药物产出概率 = 原概率 × 0.5（激素/血清/急救等）
const MEDICINE_DROP_FACTOR = 0.5;
const MEDICINE_LOOT_IDS = new Set(['meds', 'serum', 'medkit', 'stim', 'nutrient', 'nanogel', 'splint']);

// v1.1.7：深3~深7 区域，移动 / 搜刮 / 战斗均有 5% 概率感染
const INFECTION_CHANCE = 0.05;
function maybeContractInfection(state: ExtractionRunState, rng: () => number): void {
  if (zoneDepth(state) < 3) return;
  if (rng() >= INFECTION_CHANCE) return;
  if (state.injuries.includes('infection')) return;
  state.injuries = [...state.injuries, 'infection'];
  // v1.1.9：感染生效时附带 5% 最大生命值侵蚀，避免「只加 debuff 不掉血」
  const maxHp = state.condition.resources.hp.max ?? 1;
  const infectDmg = Math.max(1, Math.round(maxHp * 0.05));
  const before = state.condition.resources.hp.current;
  state.condition.resources.hp.current = Math.max(1, before - infectDmg);
  plog(
    state,
    `🤢 你在废墟的污浊环境里感染了！【感染】debuff 生效：体质/意志 -1/4，恢复速度 -50%，并承受 ${infectDmg} 点侵蚀伤害（${before} → ${state.condition.resources.hp.current}）。可用抗生素 / 血清 / 纳米凝胶清除。`,
  );
}

/** 把分支图节点转换为战斗/搜刮用的 DangerZone */
function nodeToZone(node: ZoneNode): DangerZone {
  return {
    id: node.id,
    name: node.name,
    dangerLevel: node.danger,
    flavor: node.flavor,
    lootTable: node.lootTable,
    enemies: node.enemies,
    extractTimeSec: 0,
  };
}

/** 从已用时间推导并写入当前威胁档 */
function updateThreat(state: ExtractionRunState): void {
  state.threatTier = threatTierOf(state.elapsedSec);
}

/** 撤离点显形判定：~5 分钟 或 搜满 3 区后显形 */
function maybeRevealExtract(state: ExtractionRunState): void {
  if (state.phase !== 'searching') return;
  if (state.extractRevealed) return;
  const distinct = Object.keys(state.zoneSearches).filter(
    (id) => (state.zoneSearches[id] ?? 0) > 0,
  ).length;
  if (state.elapsedSec >= EXTRACT_REVEAL_AT_SEC || distinct >= EXTRACT_REVEAL_SEARCHES) {
    state.extractRevealed = true;
    const names = state.graph.extractZones
      .map((id) => nodeById(state, id)?.name ?? id)
      .join('、');
    plog(state, `🚁 撤离信号已激活！本局撤离点：${names}。可前往撤离点瞬间撤离，或击破霸主后随时撤离。`);
  }
}

/**
 * 消耗对局时间。时间耗尽且尚未撤离 → phase='timeout'（等同阵亡结算）。
 * 只在 searching 阶段生效，避免覆盖 dead/extracted 等终态。
 */
function spendTime(state: ExtractionRunState, sec: number, rng: () => number = Math.random): void {
  if (state.phase !== 'searching') return;
  state.elapsedSec += sec;
  // v1.0.5：时间推进即刷新威胁档；并检查撤离点显形
  updateThreat(state);
  maybeRevealExtract(state);
  if (state.elapsedSec >= RUN_TIME_LIMIT_SEC) {
    state.elapsedSec = RUN_TIME_LIMIT_SEC;
    state.phase = 'timeout';
    state.encounter = undefined;
    state.scene =
      '⏰ 对局时间耗尽！\n封锁区外墙永久关闭，救援频道一片死寂……\n你没能赶上撤离窗口，未入库物资与本次行动全部作废（安全箱除外）。';
    plog(state, '⏰ 警告：对局时间耗尽，未能撤离，判定阵亡！');
    return;
  }
  // 时间推进后判定耐力透支（疲惫）
  checkFatigue(state, rng);
}

/** 行动耗时：受「敏捷」影响（敏捷越高，搜索/潜行/转移越快） */
function actionCost(state: ExtractionRunState, base: number): number {
  return Math.max(5, Math.round(base * deriveAttrEffects(runEffectiveAttributes(state)).timeScale));
}

/**
 * v1.0.3 耐力·续航：超过「耐力 × 1.5 分钟」的行动时限后，越拖越容易疲惫。
 * 疲惫 = 全六维 -1/4 的 debuff；可用营养剂消除。
 * 每次时间推进后判定一次，概率 = 5% × 超时分钟数（上限 60%）。
 */
function checkFatigue(state: ExtractionRunState, rng: () => number): void {
  if (state.phase !== 'searching') return;
  if ((state.injuries ?? []).includes('fatigue')) return;
  const capMin = deriveAttrEffects(runEffectiveAttributes(state)).staminaMinutes;
  const elapsedMin = state.elapsedSec / 60;
  if (elapsedMin <= capMin) return;
  const over = elapsedMin - capMin;
  if (rng() < Math.min(0.6, 0.05 * over)) {
    state.injuries = [...(state.injuries ?? []), 'fatigue'];
    plog(
      state,
      `😮‍💨 连续行动 ${Math.floor(elapsedMin)} 分钟（耐力续航上限 ${capMin} 分钟）——体力透支，陷入【疲惫】：全六维 -1/4。`,
    );
    state.scene = `😮‍💨 你的双腿开始打颤，呼吸带着铁锈味。\n连续行动已超过耐力续航上限（${capMin} 分钟），【疲惫】debuff 生效：全六维 -1/4。\n使用营养剂可以消除疲惫。`;
  }
}

/** 手动推进对局时间（供 UI 调用，例如等待 / 强行消耗时间） */
export function tickTime(state: ExtractionRunState, sec: number, rng: () => number = Math.random): void {
  spendTime(state, sec, rng);
}

/** 当前区域剩余搜索次数 */
export function zoneSearchLeft(state: ExtractionRunState): number {
  return Math.max(0, MAX_ZONE_SEARCHES - (state.zoneSearches[state.zone.id] ?? 0));
}

// ===== 战局背包 =====

/**
 * 把一件战利品放入战局背包：相同 id 的物品自动堆叠（qty+1），不额外占用格子。
 * 仅当背包「格子数」（不同 id 的堆叠数量）未满时才能放入。
 * 装备掉落 id 唯一，因此每件装备独立占一格。
 * 返回是否成功放入。
 */
export function addCarriedLoot(state: ExtractionRunState, item: LootItem): boolean {
  if (state.phase !== 'searching') return false;
  // 相同物品直接堆叠到已有格子：永远允许，且不占用新格子（容量只限制「不同物品种类数」）
  const existing = state.carriedLoot.find((l) => isSameStack(l, item));
  if (existing) {
    existing.qty = (existing.qty ?? 1) + 1;
    return true;
  }
  // v1.0.3：背包格数受「力量」影响（每 5 点 +1 格）
  if (state.carriedLoot.length >= runPackCapacity(state)) return false;
  state.carriedLoot.push({ ...item, qty: item.qty ?? 1 });
  return true;
}

/** 战局背包现有堆叠总数量（用于展示） */
export function carriedQty(state: ExtractionRunState): number {
  return state.carriedLoot.reduce((acc, it) => acc + (it.qty ?? 1), 0);
}

/** 丢弃一件战局背包物资（腾出负重） */
export function dropCarried(state: ExtractionRunState, index: number): void {
  if (state.phase !== 'searching') return;
  if (index < 0 || index >= state.carriedLoot.length) return;
  const [it] = state.carriedLoot.splice(index, 1);
  if (it) plog(state, `🗑 丢弃了【${it.name}】。`);
}

/** 把战局背包中的一件物资整格移入安全箱（阵亡也保留）。返回是否成功 */
export function moveToSecure(state: ExtractionRunState, index: number): boolean {
  if (state.phase !== 'searching') return false;
  const it = state.carriedLoot[index];
  if (!it) return false;
  const slot = state.secureBox.findIndex((s) => s === null);
  if (slot < 0) {
    plog(state, '🛡 安全箱已满，无法再放入。');
    return false;
  }
  state.carriedLoot.splice(index, 1);
  state.secureBox[slot] = it;
  plog(state, `🛡 【${it.name}】已放入安全箱（阵亡也保留）。`);
  return true;
}

/** 从安全箱取回一件到战局背包（需要背包有空格）。返回是否成功 */
export function takeFromSecure(state: ExtractionRunState, slot: number): boolean {
  if (state.phase !== 'searching') return false;
  const it = state.secureBox[slot];
  if (!it) return false;
  if (state.carriedLoot.length >= runPackCapacity(state)) {
    plog(state, '🎒 战局背包已满，无法从安全箱取回。');
    return false;
  }
  state.secureBox[slot] = null;
  state.carriedLoot.push(it);
  plog(state, `🎒 已从安全箱取回【${it.name}】。`);
  return true;
}

/** 安全箱物资转入已入库（撤离成功 / 阵亡保底结算时调用） */
export function bankSecureIntoBanked(state: ExtractionRunState): void {
  const kept = state.secureBox.filter((s): s is LootItem => s !== null);
  if (kept.length > 0) {
    state.bankedLoot.push(...kept);
    state.secureBox = state.secureBox.map(() => null);
  }
}

// ===== 开局 =====

/**
 * 派生大地图某个分支区域的有效区域（v1.0.2）：
 *  - 名称 = 大地图 · 分支名；
 *  - 有效危险度随分支深度提升（每 3 区 +1，封顶 9）——搜刮品质 / 敌人词缀 / 遭遇率同步水涨船高；
 *  - 最后一区（霸主区）敌人池替换为地图专属霸主。
 */
export function branchZone(map: DangerZone, idx: number): DangerZone {
  if (!map.branches || map.branches.length === 0) return map;
  const last = map.branches.length - 1;
  const br = map.branches[Math.max(0, Math.min(idx, last))];
  const isBossFloor = idx >= last;
  return {
    ...map,
    id: br.id,
    name: `${map.name}·${br.name}`,
    dangerLevel: Math.min(9, map.dangerLevel + Math.floor(idx / 3)),
    flavor: br.flavor,
    enemies: isBossFloor && map.bossEnemy ? [map.bossEnemy] : map.enemies,
  };
}

/** 当前是否处于霸主分支区（每图第 MAP_BRANCH_COUNT 区） */
export function isBossBranch(state: ExtractionRunState): boolean {
  const len = state.map.branches?.length ?? 0;
  return len > 0 && state.branchIndex >= len - 1;
}

/**
 * 进入危险区域，建立一次出击（状态机从 idle → searching）。
 * startArmor / startAmmo：由 caller 依据穿戴装备推算（护甲槽阶级→耐久，武器阶级→弹药）。
 * 入局即位于大地图第 1 分支区；用 advanceBranch 逐区深入。
 */
/** v1.0.3 建局可选参数（换装 / 固定加成 / 继承伤势） */
export interface CreateRunOptions {
  /** 出击前已穿戴的装备（fromRun=false），副本内可被临时换装覆盖 */
  equipped?: GearItem[];
  /** 不含「装备战斗词条」的基础战斗加成（词条 + 避难所） */
  bonusBase?: CombatBonus;
  /** 避难所 / 势力等不随换装变化的六维加成 */
  attrBonusFixed?: Partial<Attributes>;
  /** 出击时从基地带出的伤势（带伤出击） */
  injuries?: Injury[];
  /** 出击起始最大血量：持久 maxHp + 临时驻防加成（medbay 等）。不传则由战斗单位派生。 */
  startMaxHp?: number;
  /** 持久 maxHp（不含临时驻防加成），结算回写基地时以此为准。不传则回落到 startMaxHp。 */
  baseMaxHp?: number;
  /** v1.0.5：本局 RNG（用于生成分支图 / 撤离点 / 霸主位置）；不传则 Math.random */
  rng?: () => number;
  /** v1.0.5：序列化用的 RNG 种子（刷新后重建确定性 RNG）；不传则随机生成 */
  seed?: number;
}

export function createRun(
  survivor: SurvivorLoadout,
  zone: DangerZone,
  startHp?: number,
  startArmor?: { current: number; max: number },
  startAmmo?: number,
  opts: CreateRunOptions = {},
): ExtractionRunState {
  const runtime = new BattleRuntime();
  // v1.0.3：本局穿戴列表（可被副本内临时换装改写）
  const equipped: RunEquippedGear[] = (opts.equipped ?? []).map((g) => ({
    slot: g.slot,
    gear: g,
    fromRun: false,
  }));
  // 基础六维（不含装备/避难所加成）——debuff 削减的基数
  const baseAttributes: Attributes = { ...(survivor.profile?.attributes ?? survivor.attributes) };
  // 装备战斗词条单独结算（换装时重算），bonusBase 只保留词条/避难所部分
  let bonusBase: CombatBonus = opts.bonusBase ?? survivor.bonus ?? {
    hpBonus: 0,
    critBonus: 0,
    lootLuck: 0,
    startHpRatio: 0,
  };
  if (!opts.bonusBase && survivor.bonus) {
    let gHp = 0;
    let gCrit = 0;
    let gLoot = 0;
    let gXp = 0;
    let gCoin = 0;
    for (const e of equipped) {
      const c = e.gear.combat;
      if (!c) continue;
      gHp += c.hpBonus ?? 0;
      gCrit += c.critBonus ?? 0;
      gLoot += c.lootLuck ?? 0;
      gXp += c.xpBonus ?? 0;
      gCoin += c.coinBonus ?? 0;
    }
    bonusBase = {
      ...survivor.bonus,
      hpBonus: (survivor.bonus.hpBonus ?? 0) - gHp,
      critBonus: (survivor.bonus.critBonus ?? 0) - gCrit,
      lootLuck: (survivor.bonus.lootLuck ?? 0) - gLoot,
      xpBonus: (survivor.bonus.xpBonus ?? 0) - gXp,
      coinBonus: (survivor.bonus.coinBonus ?? 0) - gCoin,
    };
  }
  // 固定六维加成（避难所/势力等）：未显式传入时，由「总属性 - 基础属性 - 原装备加成」反推，
  // 保证旧调用方（不传 opts）的有效六维与出击前完全一致。
  const attrBonusFixed: Partial<Attributes> = opts.attrBonusFixed ?? (() => {
    const out: Partial<Attributes> = {};
    if (!survivor.profile) return out;
    for (const k of Object.keys(survivor.attributes) as (keyof Attributes)[]) {
      const delta = (survivor.attributes[k] ?? 0) - (baseAttributes[k] ?? 0);
      if (delta !== 0) out[k] = delta;
    }
    for (const e of equipped) {
      for (const k of Object.keys(e.gear.modifiers) as (keyof Attributes)[]) {
        out[k] = (out[k] ?? 0) - (e.gear.modifiers[k] ?? 0);
      }
    }
    return out;
  })();
  // 有完整档案+战斗加成时，走正式 battle-v5 战斗单元；否则退化为属性直转。
  let unit: Unit;
  if (survivor.profile && survivor.bonus) {
    unit = buildSurvivorUnit(survivor.profile, survivor.attributes, survivor.bonus, runtime);
  } else {
    unit = buildUnit(runtime, 'survivor', survivor.name, survivor.attributes);
  }
  const startMaxHp = opts.startMaxHp ?? unit.getMaxHp();
  const baseMaxHp = opts.baseMaxHp ?? startMaxHp;
  // 副本初始最大血量 = 起点 maxHp + 出击前已穿戴装备的气血加成（新需求②：装备气血计入副本上限）
  const runMaxHp = startMaxHp + equippedHpBonus(equipped);
  const condition = freshCondition(runMaxHp, unit.getMaxMp());
  if (typeof startHp === 'number') {
    condition.resources.hp.current = Math.max(0, Math.min(runMaxHp, Math.round(startHp)));
  }
  const armor = startArmor ?? { current: 0, max: 0 };
  const map = zone;
  // v1.0.5：本局分支图（固定 16 区池 + 随机连边 / 随机撤离点 / 霸主浮动），取消旧种子地图
  const genRng = opts.rng ?? Math.random;
  const graph = generateZoneGraph(zone, genRng);
  const startNode = graph.nodes.find((nd) => nd.id === graph.startId) ?? graph.nodes[0];
  const startZone = nodeToZone(startNode);
  return {
    survivor,
    zone: startZone,
    map,
    branchIndex: 0,
    // ===== v1.0.5：分支图 / 撤离点 / 威胁时钟 =====
    currentZoneId: graph.startId,
    graph,
    extractRevealed: false,
    threatTier: 0,
    bossDefeated: false,
    rngSeed: opts.seed ?? Math.floor(Math.random() * 2147483647),
    pendingSearch: null,
    bagFullPrompt: false,
    condition,
    carriedLoot: [],
    carriedCredits: 0,
    carriedCreditsBonus: 0,
    bankedLoot: [],
    phase: 'searching',
    searchCount: 0,
    log: [SYSTEM_LINES.missionReady, SYSTEM_LINES.enterZone, `进入【${startZone.name}】：${startZone.flavor}`],
    rescuedThisRun: false,
    elapsedSec: 0,
    ammo: Math.max(0, Math.round(startAmmo ?? 24)),
    armor,
    zoneSearches: {},
    secureBox: Array.from({ length: SECURE_BOX_SLOTS }, () => null),
    atExtract: false,
    battles: [],
    xpGained: 0,
    buffUntilSec: 0,
    // ===== v1.0.3 =====
    injuries: [...(opts.injuries ?? [])],
    equipped,
    attrBonusFixed,
    bonusBase,
    baseAttributes,
    startMaxHp,
    baseMaxHp,
    profileMaxHpBonus: 0,
    scene: [
      '【生存系统】任务简报：',
      `目标区域【${startZone.name}】—— ${startZone.flavor}`,
      `本图共 ${graph.nodes.length} 个区域，连成一张分支网络，越深入越危险，最深处盘踞着霸主。`,
      `对局时长 ${Math.round(RUN_TIME_LIMIT_SEC / 60)} 分钟，时间耗尽未撤离将判定阵亡。`,
      '每次搜索 / 深入都会消耗时间；越接近封锁，遭遇越频繁。',
      '安全箱内的物资即使阵亡也会保留，撤离成功才能带走背包物资。',
      ...(opts.injuries && opts.injuries.length > 0
        ? [`⚠ 带伤出击：${opts.injuries.map((i) => INJURY_LABEL[i]).join('、')}（六维已被临时削减）。`]
        : []),
    ].join('\n'),
  };
}

// ===== 战利品发放 =====

/** 战利品 id=ammo 时直接装填进弹匣（不占背包格） */
const AMMO_LOOT_GRANT = 10;
/** v1.0.3 弹药补给：搜索时额外翻出弹药箱的概率 / 数量区间（不占背包，直接进弹匣） */
const AMMO_CACHE_CHANCE = 0.15; // 搜刮翻出弹药箱的概率（v1.0.3：下调以减缓弹药获取）
const AMMO_CACHE_MIN = 3; // 个位数
const AMMO_CACHE_MAX = 15; // 十几个

/**
 * 把一张战利品表条目实际发放到对局（弹药→弹匣；装备→带阶级掉落；其余入背包）。
 * 返回给场景/日志使用的描述文本；背包满时返回 null。
 */
function grantLoot(state: ExtractionRunState, raw: LootItem, rng: () => number, luck = 0): string | null {
  const item: LootItem =
    raw.kind === 'gear' && !raw.gear
      ? rollGearDrop(rng, state.zone.dangerLevel, luck * 0.2)
      : raw;
  // v1.1.7：副本药物产出概率调整为原来的 50%（激素/血清/急救等）
  if (MEDICINE_LOOT_IDS.has(item.id) && rng() >= MEDICINE_DROP_FACTOR) {
    return null;
  }
  if (item.id === 'ammo') {
    state.ammo += AMMO_LOOT_GRANT;
    return `【弹药】×${AMMO_LOOT_GRANT}（已装填进弹匣，余 ${state.ammo} 发）`;
  }
  // v1.0.4：废土币只作为出击搜索的直接钱财，不进入战局背包（不占格、不算材料），单独累计，撤离后折算入基地货币
  if (item.kind === 'currency' || item.id === 'credits') {
    const base = (item.value ?? 1) * (item.qty ?? 1);
    // 金币获取加成（拾荒嗅觉 / 装备词条）直接体现在搜刮到的废土币数量上：
    // 无加成 = base 个；100% 加成 = 2×base 个。加成随当前穿戴实时计算（含副本内换装）。
    const bonus = runCombatBonus(state).coinBonus ?? 0;
    const total = Math.round(base * (1 + bonus));
    state.carriedCredits += total;
    state.carriedCreditsBonus += total - base;
    return `【废土币】×${total}（直接钱财，撤离后折算入基地货币）`;
  }
  const tierNote = item.rarityName ? `(${item.rarityName} · 估值 ${item.value})` : `(估值 ${item.value})`;
  if (!addCarriedLoot(state, item)) return null;
  return `【${item.name}】${tierNote}`;
}

// ===== 搜刮 =====

/** 搜刮阶段：随机获得物资；有概率触发遭遇事件（不再自动开战，强制抉择） */
export function search(state: ExtractionRunState, rng: () => number = Math.random, luck = 0): void {
  if (state.phase !== 'searching' || state.encounter || state.atExtract) return;
  const searched = state.zoneSearches[state.zone.id] ?? 0;
  if (searched >= MAX_ZONE_SEARCHES) {
    state.scene = `【${state.zone.name}】已经被你翻了个底朝天。\n此地已被搜刮干净，需要前往下一处区域。`;
    plog(state, `本区域已搜刮干净（${MAX_ZONE_SEARCHES}/${MAX_ZONE_SEARCHES}），请前往下一区域。`);
    return;
  }
  const timeCost = actionCost(state, ACTION_COST.search);

  // 先结算"应获得"的战利品（不立即写入背包，便于背包满时抉择）
  const eff = deriveAttrEffects(runEffectiveAttributes(state));
  const percepExtra = rng() < eff.lootExtraChance ? 1 : 0;
  const base = 1 + Math.floor(rng() * 2);
  const extra = Math.floor(luck) + (rng() < luck % 1 ? 1 : 0) + percepExtra;
  const gained: LootItem[] = [];
  let ammoGained = 0;
  let creditsGained = 0;
  const planGrant = (raw: LootItem) => {
    if (raw.id === 'ammo') {
      ammoGained += AMMO_LOOT_GRANT;
      return;
    }
    if (raw.kind === 'currency' || raw.id === 'credits') {
      const baseV = (raw.value ?? 1) * (raw.qty ?? 1);
      const bonus = runCombatBonus(state).coinBonus ?? 0;
      creditsGained += Math.round(baseV * (1 + bonus));
      return;
    }
    if (raw.kind === 'gear' && !raw.gear) {
      gained.push(rollGearDrop(rng, state.zone.dangerLevel, luck * 0.2));
      return;
    }
    gained.push(raw);
  };
  for (let i = 0; i < base + extra; i++) {
    planGrant(state.zone.lootTable[Math.floor(rng() * state.zone.lootTable.length)]);
  }
  // v1.0.3 弹药补给：搜索有概率翻出弹药箱，直接装填进弹匣，不占用战局背包
  if (rng() < AMMO_CACHE_CHANCE) {
    ammoGained += AMMO_CACHE_MIN + Math.floor(rng() * (AMMO_CACHE_MAX - AMMO_CACHE_MIN + 1));
  }
  // 装备掉落：危险度越高，越可能搜到带阶级词缀的装备（白-绿-蓝-紫-黄-橙-红）
  // v1.0.10：改为统一的小怪爆率（危1 20% → 危7 44%），并受搜刮运势加成
  const gearChance = mobGearDropChance(state.zone.dangerLevel, luck);
  if (rng() < gearChance) {
    gained.push(rollGearDrop(rng, state.zone.dangerLevel, luck * 0.2));
  }
  // 遭遇判定（威胁查表）
  const enemy = rollEncounter(state, rng);

  // v1.0.5：背包满且本轮有新物品 → 暂存，弹"放弃/取消"
  const cap = runPackCapacity(state);
  const existingIds = new Set(state.carriedLoot.map((l) => l.id));
  const hasNew = gained.some((g) => !existingIds.has(g.id));
  if (state.carriedLoot.length >= cap && hasNew) {
    state.pendingSearch = {
      gained,
      ammoGained,
      creditsGained,
      encounter: enemy ? { enemy, intro: encounterIntro(state, enemy, rng) } : null,
      timeCost,
      zoneSearchesAfter: { ...state.zoneSearches, [state.zone.id]: searched + 1 },
      searchCountAfter: state.searchCount + 1,
    };
    state.bagFullPrompt = true;
    state.scene = `🎒 背包已满！\n你翻出了物资，却装不下了。\n必须立刻决断：放弃本轮拾取（时间照耗），或取消（腾出空间后重试）。`;
    plog(state, `🎒 背包已满，弹出 放弃/取消 抉择。`);
    return;
  }
  applySearchOutcome(state, gained, ammoGained, creditsGained, enemy, timeCost);
  // v1.1.7：深4~深7 区域搜刮有 5% 概率感染
  maybeContractInfection(state, rng);
}

/** 把已结算的搜刮结果写入对局（时间 / 背包 / 遭遇） */
function applySearchOutcome(
  state: ExtractionRunState,
  gained: LootItem[],
  ammoGained: number,
  creditsGained: number,
  enemy: EnemyArchetype | null,
  timeCost: number,
): void {
  spendTime(state, timeCost);
  if (state.phase !== 'searching') return;
  const gainedText: string[] = [];
  for (const g of gained) {
    const text = grantLoot(state, g, Math.random, 0);
    if (text) gainedText.push(text);
  }
  if (ammoGained > 0) {
    state.ammo += ammoGained;
    gainedText.push(`【弹药补给】×${ammoGained}（已装填进弹匣，余 ${state.ammo} 发）`);
  }
  if (creditsGained > 0) {
    state.carriedCredits += creditsGained;
    gainedText.push(`【废土币】×${creditsGained}（直接钱财，撤离后折算入基地货币）`);
  }
  state.zoneSearches[state.zone.id] = (state.zoneSearches[state.zone.id] ?? 0) + 1;
  state.searchCount++;
  const left = zoneSearchLeft(state);
  for (const g of gainedText) plog(state, `搜索区域，获得：${g}`);

  if (enemy) {
    const intro = encounterIntro(state, enemy, Math.random);
    state.encounter = { enemy, intro };
    state.scene = intro;
    plog(state, `⚠ 听见脚步声，遭遇【${enemy.name}】！`);
    return;
  }

  const lootText = gainedText.length > 0 ? gainedText.join('\n') : '一无所获……只有风穿过破碎的窗棂。';
  state.scene = [
    `你压低身位，翻检【${state.zone.name}】的残骸。`,
    '【系统提示】：你开始搜索这片区域。',
    '──',
    `✅ 搜索成功：`,
    lootText,
    '',
    `本区剩余搜索机会：${left}/${MAX_ZONE_SEARCHES}${left === 0 ? '（搜完需转移下一区域）' : ''}`,
  ].join('\n');
}

/**
 * v1.0.5：背包满弹窗的"放弃/取消"抉择。
 *  - cancel：不消耗任何状态，等玩家清理背包后可再次点击搜索（重新结算本轮）。
 *  - abandon：时间照耗、搜索计数照记，但战利品丢弃（弹药/废土币照常获得）；若本轮触发遭遇则进入抉择。
 */
export function resolveBagFull(
  state: ExtractionRunState,
  mode: 'abandon' | 'cancel',
  rng: () => number = Math.random,
): void {
  if (!state.pendingSearch) return;
  const p = state.pendingSearch;
  if (mode === 'cancel') {
    state.pendingSearch = null;
    state.bagFullPrompt = false;
    state.scene = `你收紧背包带，决定先腾出空间。\n【取消】本轮收刮暂不进行，清理背包后可再次点击搜索。`;
    return;
  }
  // 放弃：消耗时间/计数，但丢弃战利品（弹药/废土币照常获得）
  state.pendingSearch = null;
  state.bagFullPrompt = false;
  spendTime(state, p.timeCost, rng);
  if (state.phase !== 'searching') return;
  state.zoneSearches = p.zoneSearchesAfter;
  state.searchCount = p.searchCountAfter;
  if (p.ammoGained > 0) {
    state.ammo += p.ammoGained;
    plog(state, `【弹药补给】×${p.ammoGained}（已装填，余 ${state.ammo} 发）`);
  }
  if (p.creditsGained > 0) {
    state.carriedCredits += p.creditsGained;
    plog(state, `【废土币】×${p.creditsGained}（直接钱财）`);
  }
  if (p.encounter) {
    state.encounter = p.encounter;
    state.scene = p.encounter.intro;
    plog(state, `⚠ 听见脚步声，遭遇【${p.encounter.enemy.name}】！`);
  } else {
    state.scene = `你翻出了物资，但背包已塞满——索性把这一轮战利品留在原地，继续前行。`;
  }
  plog(state, `🗑 背包已满，已放弃本轮拾取（时间已消耗）。`);
  updateThreat(state);
  maybeRevealExtract(state);
}

// ===== 遭遇 =====

const ENCOUNTER_DIRS = ['楼道转角', '坍塌的墙后', '浓雾深处', '翻覆的车辆旁', '地铁阴影里', '货架倒塌的缺口'];

function encounterIntro(state: ExtractionRunState, enemy: EnemyArchetype, rng: () => number): string {
  const dir = ENCOUNTER_DIRS[Math.floor(rng() * ENCOUNTER_DIRS.length)];
  const affixNote =
    enemy.affixes && enemy.affixes.length > 0
      ? `\n敌方词条：${enemy.affixes.map((a) => a.label).join('、')}`
      : '';
  const ammoNote =
    state.ammo >= FIGHT_AMMO_COST ? '' : `\n（⚠ 弹药不足 ${FIGHT_AMMO_COST} 发，开战将被迫近身肉搏）`;
  return [
    '⚠️ 遭遇事件！',
    `一名【${enemy.name}】从${dir}冲了出来——${enemy.threatNote ?? '来者不善'}。${affixNote}`,
    `你现在可以选择：${ammoNote}`,
    '🔹【主动开战】消耗弹药，开启回合战斗',
    '🔹【潜行绕行】消耗时间，有概率被发现；失败将被迫交战',
    '🔹【投掷物脱离】消耗烟雾弹/闪光弹，必定脱离纠缠',
    '🔹【突围撤离点】放弃搜刮，直奔撤离位置',
  ].join('\n');
}

/** 按区域危险度抽一个敌人原型并结算其词缀（不做概率门控）。pool 可指定候选敌人池（默认本区敌人池） */
export function pickEnemy(state: ExtractionRunState, rng: () => number, pool?: EnemyArchetype[]): EnemyArchetype {
  const list = pool && pool.length > 0 ? pool : state.zone.enemies;
  const base = list[Math.floor(rng() * list.length)];
  // v1.0.10：敌人词缀强度由「深度」驱动（越深越硬），与装备爆率（本图危N）解耦
  const affixes = rollEnemyAffixes(rng, zoneDepth(state));
  const { attributes, hpBonus, critBonus } = aggregateEnemyAffixes(affixes);
  const effectiveAttributes: Attributes = { ...base.attributes };
  for (const k of Object.keys(attributes) as (keyof Attributes)[]) {
    effectiveAttributes[k] = (effectiveAttributes[k] ?? 0) + (attributes[k] ?? 0);
  }
  return {
    ...base,
    attributes: effectiveAttributes,
    bonus: { hpBonus, critBonus },
    affixes,
  };
}

/**
 * 按区域危险度 + 对局时间压力随机判定是否遭遇敌人。
 * 时间越晚遭遇概率越高（惩罚「贪物资」的玩家）。
 */
export function rollEncounter(state: ExtractionRunState, rng: () => number = Math.random): EnemyArchetype | null {
  const tier = state.threatTier;
  const depth = currentZoneOf(state).depth;
  const bossZone = isBossZone(state);
  // v1.0.3 感知·预警：感知越高越不容易被敌人逮到（最多削减 20 个百分点）
  const avoid = bossZone ? 0 : Math.min(0.2, deriveAttrEffects(runEffectiveAttributes(state)).encounterAvoid);
  // 霸主区：仅「最后一次搜刮」触发霸主；前两次为普通 / 精英敌人或物资（v1.0.5 修复）
  if (bossZone) {
    const searches = state.zoneSearches[state.currentZoneId] ?? 0;
    if (!state.bossDefeated && searches >= MAX_ZONE_SEARCHES - 1) {
      const boss = state.zone.enemies.find((e) => e.boss) ?? state.zone.enemies[0];
      return boss ? pickEnemy(state, rng, [boss]) : null;
    }
    const nonBoss = state.zone.enemies.filter((e) => !e.boss);
    if (nonBoss.length === 0) return null;
    const chance = Math.max(0.05, threatEncounterChance(depth, tier) - avoid);
    if (rng() >= chance) return null;
    return pickEnemy(state, rng, nonBoss);
  }
  // 非霸主区：霸主不应出现在普通遭遇池中（部分主题会把 boss 也放入 enemies，需显式过滤）
  const availableEnemies = state.zone.enemies.filter((e) => !e.boss);
  // 收网期（tier3）：必遇
  if (tier === 3) return availableEnemies.length > 0 ? pickEnemy(state, rng, availableEnemies) : null;
  const chance = Math.max(0.05, threatEncounterChance(depth, tier) - avoid);
  if (rng() >= chance) return null;
  return availableEnemies.length > 0 ? pickEnemy(state, rng, availableEnemies) : null;
}

/**
 * 遭遇抉择：强制玩家四选一（搜打撤的灵魂）。
 *  - fight：进入回合战斗（弹药不足则肉搏）
 *  - sneak：消耗时间潜行；失败被迫交战
 *  - throw：消耗投掷物（UI 负责扣库存），必定脱离
 */
export function resolveEncounter(state: ExtractionRunState, action: EncounterAction, rng: () => number = Math.random): void {
  const enc = state.encounter;
  if (!enc || state.phase !== 'searching') return;
  switch (action) {
    case 'fight': {
      fight(state, enc.enemy, rng);
      break;
    }
    case 'sneak': {
      spendTime(state, actionCost(state, ACTION_COST.sneak), rng); // 潜行绕行：基础 3 分钟，受敏捷 timeScale 缩放（敏捷越高越快），制造紧迫感
      if (state.phase !== 'searching') return;
      // 精英/Boss 更难绕开；v1.0.3 敏捷加成潜行成功率
      const sneakBonus = deriveAttrEffects(runEffectiveAttributes(state)).sneakBonus;
      const successP = Math.max(0.1, Math.min(0.95, (enc.enemy.boss ? 0.15 : 0.30) + sneakBonus));
      if (rng() < successP) {
        state.encounter = undefined;
        state.scene = `你贴着断墙，压低呼吸从侧翼绕行……\n【${enc.enemy.name}】在废墟间逡巡片刻，最终没有发现你的踪迹。\n危险暂时解除，但时间已悄悄流逝。`;
        plog(state, `潜行成功，绕开了【${enc.enemy.name}】。`);
      } else {
        plog(state, `潜行失败！【${enc.enemy.name}】发现了你，被迫交战！`);
        state.scene = `你的脚步惊动了碎石——【${enc.enemy.name}】猛地转头锁定了你！\n退路已断，只能迎战！`;
        fight(state, enc.enemy, rng);
      }
      break;
    }
    case 'throw': {
      spendTime(state, actionCost(state, ACTION_COST.throwEscape), rng);
      if (state.phase !== 'searching') return;
      state.encounter = undefined;
      state.scene = '烟雾弹炸开，浓白的烟雾瞬间吞没了敌人的视野。\n你借着烟幕低姿疾走，甩开了纠缠。\n（投掷物已消耗）';
      plog(state, '💥 投掷物脱离成功，甩开了敌人。');
      break;
    }
  }
}

// ===== 救援 =====

/**
 * 救援事件：搜刮时按概率生成一个可招募集合成员。
 * npcGenerator 由 caller 注入（charge.ts.generateSurvivor），
 * 保持 extraction 引擎与生存系统的解耦。
 */
export function rollRescue(
  state: ExtractionRunState,
  rng: () => number,
  npcGenerator: () => import('@shared/engine/survival/chargen').SurvivorProfile,
): import('@shared/engine/survival/chargen').SurvivorProfile | null {
  if (state.rescuedThisRun) return null;
  if (state.phase !== 'searching') return null;
  // 低概率 + 危险度越高救援越容易（因为更危险的地方遇难者也越多）
  // v1.0.10：越深遇难者越多（深度驱动，非本图危险度）
  const chance = 0.1 + zoneDepth(state) * 0.04;
  if (rng() >= chance) return null;
  const npc = npcGenerator();
  state.rescuedThisRun = true;
  plog(state, `❗ 发现被困幸存者【${npc.name}】（${npc.tierName}）—— 决定带回基地。`);
  state.carriedNpc = npc;
  return npc;
}

// ===== 战斗 =====

/** 六维属性 → 战斗风格点评（|差|≥3 才点评，最多 4 条） */
const ATTR_NOTE_DEFS: Array<{
  key: keyof Attributes;
  label: string;
  high: string;
  low: string;
}> = [
  { key: 'speed', label: '敏捷', high: '你总能抢先出手、从容走位，先手权牢牢在握', low: '你常常后手挨打，先手权在敌人手里，建议利用走位弥补' },
  { key: 'strength', label: '力量', high: '你的火力压制占据上风，正面硬拼不吃亏', low: '正面火力对拼处于劣势，拉开距离周旋才是正解' },
  { key: 'endurance', label: '耐力', high: '你的续航更持久，消耗战对你有利', low: '长时间缠斗对你不利，速战速决为上' },
  { key: 'vitality', label: '体质', high: '你的血量底盘更厚，容错率更高', low: '你的血量底盘偏薄，交战前记得用药把状态拉满' },
  { key: 'spirit', label: '感知', high: '你的感知更敏锐，总能抓住要害打出暴击', low: '敌人的感知压制了你，暴击机会与判断会吃亏' },
  { key: 'willpower', label: '意志', high: '你的意志坚韧，更难被敌方节奏带偏', low: '敌人意志顽强，慎防陷入它擅长的持久消耗' },
];

/**
 * 从 battle-v5 决斗结果构建可展开的战斗回放：
 * 逐回合命中/暴击/闪避/护盾吸收文本 + 每回合双方生命 + 一段文字描写 + 六维属性点评。
 */
function buildBattleReplay(
  state: ExtractionRunState,
  enemy: EnemyArchetype,
  selfUnit: Unit,
  enemyUnit: Unit,
  duel: AutomaticDuelResolutionV1,
  won: boolean,
  logIndex: number,
  groupIndex?: number,
  groupTotal?: number,
): BattleReplayEntry {
  const selfId = selfUnit.id;
  const enemyId = enemyUnit.id;
  const selfName = state.survivor.name;

  // 初始生命（battle_init 帧；缺失时退化为当前状态）
  const initFrame = duel.stateTimeline.frames.find((f) => f.phase === 'battle_init');
  let hpSelf = initFrame?.units[selfId]?.hp.current ?? state.condition.resources.hp.current;
  let hpEnemy = initFrame?.units[enemyId]?.hp.current ?? 0;

  interface Agg {
    texts: string[];
    selfDmg: number;
    enemyDmg: number;
  }
  const byTurn = new Map<number, Agg>();
  const aggOf = (turn: number): Agg => {
    let a = byTurn.get(turn);
    if (!a) {
      a = { texts: [], selfDmg: 0, enemyDmg: 0 };
      byTurn.set(turn, a);
    }
    return a;
  };
  const hpByTurn = new Map<number, { self: number; enemy: number }>();

  let critSelf = 0;
  let dodgeSelf = 0;
  let biggestSelf = 0;
  let biggestEnemy = 0;
  let firstActor = '';

  for (const seq of duel.sequences) {
    const turn = seq.turn;
    if (turn >= 1 && seq.phase === 'action_pre' && seq.actor?.name && !firstActor) {
      firstActor = seq.actor.name;
    }
    if (turn < 1) continue;
    const agg = aggOf(turn);
    for (const fact of seq.facts) {
      if (fact.type === 'damage') {
        const src = fact.origin.kind === 'owned' ? fact.origin.owner.name : fact.origin.carrier.name;
        const critTag = fact.critical ? '（暴击！）' : '';
        const shieldTag = fact.shieldAbsorbed > 0 ? `，护盾吸收 ${fact.shieldAbsorbed}` : '';
        agg.texts.push(`${src} → ${fact.target.name}：-${fact.amount}${critTag}${shieldTag}`);
        if (fact.target.id === enemyId) {
          hpEnemy = fact.afterHp;
          agg.selfDmg += fact.amount;
          biggestSelf = Math.max(biggestSelf, fact.amount);
          if (fact.critical) critSelf++;
        } else {
          hpSelf = fact.afterHp;
          agg.enemyDmg += fact.amount;
          biggestEnemy = Math.max(biggestEnemy, fact.amount);
        }
      } else if (fact.type === 'defense' && fact.defense === 'dodge') {
        agg.texts.push(`${fact.target.name} 凭敏捷身法闪避了攻杀！`);
        if (fact.target.id === selfId) dodgeSelf++;
      } else if (fact.type === 'recovery' && fact.resource === 'hp') {
        agg.texts.push(`${fact.target.name} 恢复生命 ${fact.amount}`);
        if (fact.target.id === selfId) hpSelf = fact.after;
        else hpEnemy = fact.after;
      }
    }
    hpByTurn.set(turn, { self: hpSelf, enemy: hpEnemy });
  }

  // 逐回合生命快照（无动作的回合沿用上一回合值）
  const rounds: BattleRoundEntry[] = [];
  let lastSelf = hpSelf;
  let lastEnemy = hpEnemy;
  for (let t = 1; t <= duel.turns; t++) {
    const snap = hpByTurn.get(t);
    if (snap) {
      lastSelf = snap.self;
      lastEnemy = snap.enemy;
    }
    const agg = byTurn.get(t);
    rounds.push({
      round: t,
      text:
        agg && agg.texts.length > 0
          ? agg.texts.join('；')
          : '（双方试探周旋，未发生有效交互）',
      hpSelf: lastSelf,
      hpEnemy: lastEnemy,
    });
  }

  // 一段战斗文字描写
  const intro =
    firstActor === selfName
      ? `${selfName} 抢得先手，在【${enemy.name}】扑近之前先一步开火。`
      : `【${enemy.name}】抢先发难，${selfName} 就地翻滚脱离了第一波攻势。`;
  const mid =
    biggestSelf > 0
      ? `你打出的最重一击造成 ${biggestSelf} 点伤害${critSelf > 0 ? `，全场轰出 ${critSelf} 次暴击` : ''}。`
      : '你全程被火力压制，没能打出像样的还击。';
  const taken =
    biggestEnemy > 0
      ? `最险的一发让你失去 ${biggestEnemy} 点生命${dodgeSelf > 0 ? `——好在凭敏捷身法闪掉了 ${dodgeSelf} 次杀招` : ''}。`
      : '';
  const end = won
    ? `第 ${duel.turns} 回合，${enemy.name} 轰然倒地，废墟重归死寂。`
    : `第 ${duel.turns} 回合，你的枪声永远停在了这片废墟。`;
  let narrative = [intro, mid, taken, end].filter(Boolean).join(' ');
  if (groupIndex && groupTotal) {
    narrative = `〔敌群第 ${groupIndex}/${groupTotal} 只 · ${enemy.name}〕${narrative}`;
  }

  // 六维属性交互点评（v1.0.3：用「本局有效六维」对比，debuff 会真实反映在点评里）
  const notes: string[] = [];
  const effAttrs = runEffectiveAttributes(state);
  for (const def of ATTR_NOTE_DEFS) {
    const mine = effAttrs[def.key] ?? 0;
    const theirs = enemy.attributes[def.key] ?? 0;
    const diff = mine - theirs;
    if (Math.abs(diff) >= 3) {
      notes.push(`${def.label} ${mine} : ${theirs} —— ${diff > 0 ? def.high : def.low}`);
    }
    if (notes.length >= 4) break;
  }

  return {
    logIndex,
    enemyName: enemy.name,
    affixes: enemy.affixes?.map((a) => a.label).join('、') ?? '',
    turns: duel.turns,
    win: won,
    boss: !!enemy.boss,
    groupIndex,
    groupTotal,
    rounds,
    narrative,
    attrNotes: notes,
    dmgDealt: [...byTurn.values()].reduce((a, b) => a + b.selfDmg, 0),
    dmgTaken: [...byTurn.values()].reduce((a, b) => a + b.enemyDmg, 0),
  };
}

/**
 * 交战阶段：用真实 battle-v5 引擎决出胜负，并把结果写回 in-run 状态。
 * v1.0.1：交战消耗弹药（不足则肉搏先挨一刀）；护甲按承伤比例吸收损耗；
 * 胜利后留下可搜刮的敌方尸体。
 * v1.0.2：生成逐回合战斗回放（battles）+ 霸主击杀额外战利品。
 */
/** 危3+ 副本一次遭遇的敌群规模上限（1~GROUP_MAX 个小怪，boss 不参与群怪） */
const GROUP_MIN_DANGER = 3;
const GROUP_MAX = 3;

/** 把敌人六维基础属性整体乘以 mult（用于 boss 狂暴），派生属性由 buildEnemyUnit 重算 */
function scaleEnemyAttributes(base: Attributes, mult: number): Attributes {
  const out = { ...base };
  for (const k of ['vitality', 'strength', 'spirit', 'endurance', 'speed', 'willpower'] as (keyof Attributes)[]) {
    out[k] = Math.max(1, Math.round((base[k] ?? 0) * mult));
  }
  return out;
}

export function fight(
  state: ExtractionRunState,
  enemy: EnemyArchetype,
  rng: () => number = Math.random,
): void {
  if (state.phase !== 'searching') return;
  // 危3+ 副本非 boss 遭遇：随机 1~3 个小怪成队，逐个击破、HP 跨场继承（伤势死亡螺旋）
  const groupSize =
    !enemy.boss && state.zone.dangerLevel >= GROUP_MIN_DANGER
      ? 1 + Math.floor(rng() * GROUP_MAX)
      : 1;
  if (groupSize > 1) {
    plog(state, `⚔ 遭遇敌群（共 ${groupSize} 个）—— 为首的【${enemy.name}】率先扑来，其余在阴影里蠕动。`);
  }
  const groupHpStart = state.condition.resources.hp.current;
  const groupDirs = ['左侧', '右侧', '身后', '正面', '斜刺里', '废墟缝隙'];
  for (let i = 0; i < groupSize; i++) {
    const mob = i === 0 ? enemy : pickEnemy(state, rng);
    if (groupSize > 1 && (state.phase as string) === 'searching') {
      const dir = groupDirs[i % groupDirs.length];
      plog(state, `⚔ 敌群第 ${i + 1}/${groupSize} 只：【${mob.name}】从${dir}扑了上来！`);
    }
    fightOne(state, mob, rng, groupSize > 1 ? i + 1 : undefined, groupSize > 1 ? groupSize : undefined);
    if ((state.phase as string) === 'dead') break;
    if (i < groupSize - 1 && (state.phase as string) === 'searching') {
      plog(
        state,
        `⚔ 你刚击倒【${mob.name}】，残敌立刻补位——还有 ${groupSize - 1 - i} 个敌人围了上来！`,
      );
      spendTime(state, Math.floor(rng() * 15));
    }
  }
  if (groupSize > 1 && (state.phase as string) !== 'dead') {
    const lost = Math.max(0, groupHpStart - state.condition.resources.hp.current);
    const hpMaxNow = state.condition.resources.hp.max ?? Math.max(1, state.condition.resources.hp.current);
    const remainPct = hpMaxNow > 0
      ? Math.round((state.condition.resources.hp.current / hpMaxNow) * 100)
      : 0;
    plog(
      state,
      `⚔ 敌群清缴完毕：共 ${groupSize} 只全部放倒，此役累计损失 ${lost} 点生命（剩余 ${state.condition.resources.hp.current}/${hpMaxNow}，血量 ${remainPct}%）——废墟暂归死寂。`,
    );
  }
  // v1.1.7：深4~深7 区域战斗有 5% 概率感染
  if ((state.phase as string) !== 'dead') maybeContractInfection(state, rng);
}

/**
 * 单体战斗（一次遭遇中的一只敌人）。群组战斗会循环调用本函数，
 * 玩家血量在多次战斗间自然继承，配合战后伤势判定形成「死亡螺旋」。
 */
function fightOne(
  state: ExtractionRunState,
  enemy: EnemyArchetype,
  rng: () => number = Math.random,
  groupIndex?: number,
  groupTotal?: number,
): void {
  if (state.phase !== 'searching') return;
  state.encounter = undefined;
  state.phase = 'combat';

  const maxHp = state.condition.resources.hp.max ?? 0;
  // 弹药结算：足够 → 正常交战；不足 → 被迫肉搏，先被劈中一刀
  if (state.ammo >= FIGHT_AMMO_COST) {
    state.ammo -= FIGHT_AMMO_COST;
    plog(state, `🔫 交战消耗弹药 ${FIGHT_AMMO_COST} 发（余 ${state.ammo}）。`);
  } else {
    const meleePenalty = Math.max(1, Math.round(maxHp * 0.12));
    state.condition.resources.hp.current = Math.max(1, state.condition.resources.hp.current - meleePenalty);
    plog(state, `⚠ 弹药不足，被迫近身肉搏（先承受 ${meleePenalty} 点伤害）！`);
  }
  const hpBeforeFight = state.condition.resources.hp.current;

  const runtime = new BattleRuntime();
  // v1.0.3：战斗属性 = 本局有效六维（基础 − 伤势削减 + 当前穿戴装备 + 固定加成）
  let effAttrs = runEffectiveAttributes(state);
  // v1.1.1⑥ 肾上腺素增益：计时窗口内六维 +5 已并入 runEffectiveAttributes（上方 effAttrs 已含）；此处仅播报状态
  if ((state.buffUntilSec ?? 0) > state.elapsedSec) {
    plog(state, `🧪 增益补给【肾上腺素】生效中：六维全属性 +5（剩余 ${Math.max(0, Math.ceil((state.buffUntilSec - state.elapsedSec) / 60))} 分钟）。`);
  }
  // 本局实时战斗加成（换装后立即生效）
  const runBonus = runCombatBonus(state);
  if ((state.injuries ?? []).length > 0) {
    plog(
      state,
      `⚠ 带伤作战：${state.injuries.map((i) => INJURY_LABEL[i]).join('、')}（有效六维已被削减）。`,
    );
  }
  // 有完整档案时走正式 battle-v5 战斗单元（装备/词条生效）；否则属性直转。
  let survivorUnit: Unit;
  if (state.survivor.profile) {
    survivorUnit = buildSurvivorUnit(
      state.survivor.profile,
      effAttrs,
      runBonus,
      runtime,
      state.condition.resources.hp.current,
    );
  } else {
    survivorUnit = buildUnit(
      runtime,
      'survivor',
      state.survivor.name,
      effAttrs,
      state.condition.resources.hp.current,
    );
  }
  // v1.0.3 新需求：把战斗单位的最大血量锚定到「副本有效最大血量」（起点 + 装备气血 + 途中加点/词条增量），
  // 保证副本内换装带气血装备、以及出击途中分配体质点 / 选择带气血词条时，最大血量即时、一致地生效。
  const anchorMax = effectiveRunMaxHp(state);
  if (anchorMax > 0) {
    const naturalMax = survivorUnit.getMaxHp();
    if (naturalMax !== anchorMax) {
      survivorUnit.attributes.addModifier({
        id: 'sortie-start-maxhp',
        attrType: AttributeType.MAX_HP,
        type: ModifierType.FIXED,
        value: anchorMax - naturalMax,
        source: { sourceType: 'survivalBonus', carrierId: 'survival' },
      });
      survivorUnit.updateDerivedStats();
      survivorUnit.initializeResources({ hp: state.condition.resources.hp.current });
    }
  }
  // v1.0.11：按区域危险度放大敌人数值（恢复「越深越险」梯度）
  const dScale = ENEMY_DANGER_SCALE[state.zone.dangerLevel] ?? 1;
  const scaledEnemy: EnemyArchetype = dScale === 1
    ? enemy
    : {
        ...enemy,
        attributes: (Object.keys(enemy.attributes) as (keyof Attributes)[]).reduce(
          (acc, k) => {
            acc[k] = Math.max(1, Math.round((enemy.attributes[k] ?? 0) * dScale));
            return acc;
          },
          { ...enemy.attributes } as Attributes,
        ),
      };
  const affixNote = enemy.affixes && enemy.affixes.length
    ? `〔${enemy.affixes.map((a) => a.label).join('、')}〕`
    : '';
  const groupTag = groupIndex && groupTotal ? `〔敌群 ${groupIndex}/${groupTotal}〕` : '';

  let enemyUnit = buildEnemyUnit(runtime, scaledEnemy);
  // v1.0.2 伤害类投掷物自动使用：快捷·投掷槽装备了破片手雷时，45% 概率战斗先手引爆
  if (state.quickThrow === 'grenade' && rng() < 0.45) {
    const dmg = Math.max(10, Math.round(enemyUnit.getMaxHp() * 0.2));
    enemyUnit.takeDamage(dmg);
    plog(state, `💣 你抢先拉开破片手雷掷向【${enemy.name}】，轰然爆炸造成 ${dmg} 点伤害！`);
  }

  // ===== Boss 狂暴（两阶段实现）=====
  // 第一阶段：基础形态交战，玩家取胜 → 进入第二阶段狂暴形态（六维 ×1.5），玩家血量自然继承。
  // 若玩家在第一阶段阵亡，则 boss 从未跌破 50%，不触发狂暴。
  // 危1~危7 全部 boss 生效；狂暴在危险度缩放（ENEMY_DANGER_SCALE）之上再叠加。
  // v1.1.2 补全：第一阶段现在会单独输出交战日志与战斗回放，避免看起来像 boss 死后才狂暴。
  let duel: ReturnType<typeof resolveDuelToCompletion>;
  let enrageApplied = false;
  let replayEnemy: EnemyArchetype = enemy;
  let phase1Duel: ReturnType<typeof resolveDuelToCompletion> | undefined;
  let phase2Duel: ReturnType<typeof resolveDuelToCompletion> | undefined;
  const phase1EnemyUnit = enemyUnit;
  if (enemy.boss) {
    phase1Duel = resolveDuelToCompletion({
      battleId: 'extraction-duel-p1',
      player: survivorUnit,
      opponent: enemyUnit,
      runtime,
    });
    if (phase1Duel.winner === survivorUnit.id) {
      // 第一阶段交战日志 + 回放：把 boss 从满血压到 50% 以下的完整过程
      const phase1LogIndex = state.log.length;
      plog(
        state,
        `⚔ ${groupTag}第一阶段：与【${enemy.name}】${affixNote}交战，历时 ${phase1Duel.turns} 回合，将其血量压至 50% 以下`,
      );
      state.battles.push(
        buildBattleReplay(
          state,
          replayEnemy,
          survivorUnit,
          phase1EnemyUnit,
          phase1Duel,
          true,
          phase1LogIndex,
          groupIndex,
          groupTotal,
        ),
      );

      plog(state, `👹【${enemy.name}】血量跌破 50%，进入狂暴——六维骤升 ×1.5，第二阶段开战！`);

      const hpCarry = Math.max(1, phase1Duel.winnerSnapshot.hp.current);
      survivorUnit.initializeResources({ hp: hpCarry });
      const enragedEnemy: EnemyArchetype = {
        ...enemy,
        attributes: scaleEnemyAttributes(scaledEnemy.attributes, 1.5),
      };
      const enragedUnit = buildEnemyUnit(runtime, enragedEnemy);
      if (state.quickThrow === 'grenade' && rng() < 0.45) {
        const dmg = Math.max(10, Math.round(enragedUnit.getMaxHp() * 0.2));
        enragedUnit.takeDamage(dmg);
        plog(state, `💣 狂暴阶段的【${enemy.name}】也被破片手雷先手炸中，造成 ${dmg} 点伤害！`);
      }
      phase2Duel = resolveDuelToCompletion({
        battleId: 'extraction-duel-p2',
        player: survivorUnit,
        opponent: enragedUnit,
        runtime,
      });
      duel = phase2Duel;
      enrageApplied = true;
      enemyUnit = enragedUnit;
      replayEnemy = enragedEnemy;
    } else {
      duel = phase1Duel;
    }
  } else {
    duel = resolveDuelToCompletion({
      battleId: 'extraction-duel',
      player: survivorUnit,
      opponent: enemyUnit,
      runtime,
    });
  }
  const survivorWon = duel.winner === survivorUnit.id;
  const sSnap = survivorWon ? duel.winnerSnapshot : duel.loserSnapshot;
  const eSnap = survivorWon ? duel.loserSnapshot : duel.winnerSnapshot;

  // 输出第二阶段交战日志 / 非 boss 交战日志 / boss 第一阶段失败日志
  if (enrageApplied && phase2Duel) {
    const phase2LogIndex = state.log.length;
    plog(
      state,
      `⚔ ${groupTag}第二阶段：与狂暴【${enemy.name}】${affixNote}交战（${enemy.threatNote ?? ''}），历时 ${phase2Duel.turns} 回合`,
    );
    state.battles.push(
      buildBattleReplay(
        state,
        replayEnemy,
        survivorUnit,
        enemyUnit,
        phase2Duel,
        survivorWon,
        phase2LogIndex,
        groupIndex,
        groupTotal,
      ),
    );
  } else if (phase1Duel) {
    // boss 第一阶段失败：只输出第一阶段交战日志与回放
    const phase1LogIndex = state.log.length;
    plog(
      state,
      `⚔ ${groupTag}与【${enemy.name}】${affixNote}交战（${enemy.threatNote ?? ''}），历时 ${phase1Duel.turns} 回合`,
    );
    state.battles.push(
      buildBattleReplay(
        state,
        replayEnemy,
        survivorUnit,
        phase1EnemyUnit,
        phase1Duel,
        survivorWon,
        phase1LogIndex,
        groupIndex,
        groupTotal,
      ),
    );
  } else {
    const battleLogIndex = state.log.length;
    plog(
      state,
      `⚔ ${groupTag}与【${enemy.name}】${affixNote}交战（${enemy.threatNote ?? ''}），历时 ${duel.turns} 回合`,
    );
    state.battles.push(
      buildBattleReplay(
        state,
        replayEnemy,
        survivorUnit,
        enemyUnit,
        duel,
        survivorWon,
        battleLogIndex,
        groupIndex,
        groupTotal,
      ),
    );
  }

  const totalTurns = (phase1Duel?.turns ?? 0) + (phase2Duel?.turns ?? 0) || duel.turns;

  const hpAfterBattle = sSnap.hp.current;
  // 护甲承伤结算：本场生命损耗的一部分由护甲吸收（耐久同步损耗）
  const loss = Math.max(0, hpBeforeFight - hpAfterBattle);
  let absorbed = 0;
  if (state.armor.current > 0 && loss > 0) {
    absorbed = Math.min(state.armor.current, Math.ceil(loss * 0.35));
    state.armor.current -= absorbed;
  }

  state.condition.resources.hp.current = Math.min(sSnap.hp.max, hpAfterBattle + absorbed);
  state.condition.resources.hp.max = sSnap.hp.max;

  if (!sSnap.alive) {
    state.phase = 'dead';
    state.scene = `⚔【${enemy.name}】的最后一击击穿了你……\n你倒在了【${state.zone.name}】的废墟里。\n❌ 战斗失败：对局结束，本局背包物资全部丢失（安全箱保留）；身上穿戴装备有概率掉落。`;
    plog(state, SYSTEM_LINES.death);
    return;
  }

  state.phase = 'searching';
  // ===== v1.0.3 战后伤势判定：按战后剩余血量阶段概率挂上 debuff =====
  const hpNow = state.condition.resources.hp.current;
  const hpMaxNow = state.condition.resources.hp.max ?? Math.max(1, hpNow);
  const hpPctNow = hpMaxNow > 0 ? (hpNow / hpMaxNow) * 100 : 0;
  const newInjuries = rollCombatInjuries(rng, hpPctNow, runEffectiveAttributes(state));
  if (newInjuries.length > 0) {
    for (const inj of newInjuries) {
      if (!state.injuries.includes(inj)) {
        state.injuries = [...state.injuries, inj];
        plog(
          state,
          `🩹 战后负伤【${INJURY_LABEL[inj]}】（剩余血量 ${Math.round(hpPctNow)}%）——${injuryAttrTextOf(state, inj)}。`,
        );
      }
    }
    state.scene = `🩹 硝烟散去，你才感觉到疼。\n战后判定附加伤势：${newInjuries.map((i) => INJURY_LABEL[i]).join('、')}（基础六维已被临时削减，使用对应药物可消除）。`;
  }
  const armorNote =
    absorbed > 0
      ? `防弹甲承受了大部分冲击（护甲耐久 -${absorbed}，余 ${state.armor.current}/${state.armor.max}）`
      : state.armor.max <= 0
        ? '你没有护甲防护，硬扛了伤害'
        : '护甲已碎裂，这次全靠血肉硬扛';
  if (state.armor.current <= 0 && state.armor.max > 0) {
    plog(state, '🛡 护甲耐久耗尽，已失去防护！');
  }
  state.corpse = { enemyName: enemy.name, boss: !!enemy.boss };
  // 击杀经验：与敌人强度/区域危险度挂钩（撤离成功才结算入角色）
  const xpGain = Math.round(
    (12 + zoneDepth(state) * 8) * (enemy.boss ? 3 : 1) * (0.8 + rng() * 0.4),
  );
  state.xpGained += xpGain;
  plog(state, `📈 击败【${enemy.name}】获得经验 +${xpGain}（已实时结算入角色档案）。`);
  // 霸主击杀奖励：v1.0.9 补充——一次性发放完所有 boss 战利品（红阶「霸主战利品」+ 橙阶「霸主遗物」），不再保留 boss 尸体可搜刮，避免「放弃撤离→再搜一次 boss」额外刷装备
  if (enemy.boss) {
    state.bossDefeated = true;
    state.extractRevealed = true; // 击破霸主即开放撤离
    // v1.0.6：击败霸主后，若当前位于霸主区域，原地直接可撤离（按之前设定）。
    if (isBossZone(state)) state.atExtract = true;
    plog(state, `👑 区域霸主【${enemy.name}】已被击倒！本图最深处宣告清理——所有霸主战利品已自动入库，你可随时撤离。`);
    // 红阶「霸主战利品」：霸主必定爆装备，品质走 BOSS 表（危1~危7）
    const bonus = rollGearDrop(rng, state.zone.dangerLevel, 0.8, 0, true);
    if (addCarriedLoot(state, bonus)) {
      plog(state, `👑 霸主战利品：【${bonus.name}】（${bonus.rarityName}，估值 ${bonus.value}）。`);
    }
    // 橙阶「霸主遗物」（从 lootCorpse 提取到此处，一次性发放完，不再由搜刮尸体获得）
    const relic = rollGearDrop(rng, state.zone.dangerLevel, 0.6, 0, true);
    if (addCarriedLoot(state, relic)) {
      plog(state, `👑 霸主遗物：【${relic.name}】（${relic.rarityName}，估值 ${relic.value}）。`);
    }
    // v1.0.9 补充：boss 尸体不再可搜刮，避免「放弃撤离→再搜一次 boss」额外刷装备
    state.corpse = undefined;
  }
  const phaseLine = enrageApplied
    ? `第一阶段历时 ${phase1Duel?.turns ?? 0} 回合将 ${enemy.name} 压至半血；第二阶段狂暴形态历时 ${phase2Duel?.turns ?? 0} 回合。`
    : `你果断还击，枪声在废墟间回荡——历时 ${duel.turns} 回合。`;
  state.scene = [
    '⚔ 战斗爆发！',
    `${enemy.name} 扑击而来，${armorNote}。`,
    phaseLine,
    `✅ 战斗胜利：击倒【${enemy.name}】，你剩余生命 ${state.condition.resources.hp.current}/${state.condition.resources.hp.max}。`,
    '可以【搜刮敌方尸体】获取战利品。',
  ].join('\n');
  if (enrageApplied) {
    state.scene = `👹【${enemy.name}】曾狂暴（血量 <50% 时六维 ×1.5）！\n` + state.scene;
  }
  const totalTurnsNote = totalTurns > duel.turns ? `整场战斗历时 ${totalTurns} 回合` : `历时 ${duel.turns} 回合`;
  plog(
    state,
    `✔ 击退【${enemy.name}】（${totalTurnsNote}，敌方残余生命 ${eSnap.hp.current}），你剩余生命 ${state.condition.resources.hp.current}/${state.condition.resources.hp.max}`,
  );
  // 交战消耗对局时间（放在末尾：胜利后仍可能因时间耗尽而 timeout）
  spendTime(state, ACTION_COST.fight + Math.floor(rng() * 20));
}

// ===== v1.0.3：副本内临时换装 + 伤势治疗 =====

/** 把一件装备（GearItem）包成战局背包条目（换下来的旧装备回流用） */
function gearToLoot(gear: GearItem): LootItem {
  return {
    id: `loot-${gear.id}`,
    name: gear.name,
    kind: 'gear',
    value: gear.value,
    tier: gear.tier ?? 0,
    rarityName: gear.rarityName ?? gear.rarity,
    gear,
  };
}

/**
 * 在副本里穿戴临时背包中的装备。
 *  - 同槽位已有装备 → 换下的旧装备回到临时背包（若背包已满则拒绝换装）；
 *  - 穿戴后，六维 / 战斗加成立即生效，影响接下来的战斗与搜刮。
 * 返回是否成功。
 */
export function equipCarriedGear(state: ExtractionRunState, index: number): boolean {
  if (state.phase !== 'searching') return false;
  const it = state.carriedLoot[index];
  if (!it || !it.gear) return false;
  const gear = it.gear;
  const prev = state.equipped.find((e) => e.slot === gear.slot);
  const cap = runPackCapacity(state);
  // 换下的旧装备需要占一格：若背包已满（且换下后无处安放）则拒绝
  if (prev && state.carriedLoot.length - 1 >= cap) {
    plog(state, `🎒 战局背包已满，无法换下【${prev.gear.name}】。`);
    return false;
  }
  // 从临时背包移除（整格移除，装备不堆叠）
  state.carriedLoot.splice(index, 1);
  if (prev) {
    state.equipped = state.equipped.filter((e) => e.slot !== gear.slot);
    state.carriedLoot.push(gearToLoot(prev.gear));
    plog(state, `🎽 换装：卸下【${prev.gear.name}】，改穿【${gear.name}】（旧装备已回临时背包）。`);
  } else {
    plog(state, `🎽 换装：穿上了【${gear.name}】（${GEAR_SLOT_LABEL_CN[gear.slot] ?? gear.slot}槽）。`);
  }
  state.equipped = [...state.equipped, { slot: gear.slot, gear, fromRun: true }];
  // 新需求②：换装后按「副本有效最大血量」重算 max（仅改 max，current 用 min 夹取——满血减 max 则当前同减、加 max 则当前不变）
  recomputeRunMaxHp(state);
  return true;
}

/** 卸下本局某槽位装备，放回临时背包（背包满则失败） */
export function unequipRunGear(state: ExtractionRunState, slot: GearSlot): boolean {
  if (state.phase !== 'searching') return false;
  const cur = state.equipped.find((e) => e.slot === slot);
  if (!cur) return false;
  if (state.carriedLoot.length >= runPackCapacity(state)) {
    plog(state, '🎒 战局背包已满，无法卸下装备。');
    return false;
  }
  state.equipped = state.equipped.filter((e) => e.slot !== slot);
  state.carriedLoot.push(gearToLoot(cur.gear));
  plog(state, `🎽 卸下【${cur.gear.name}】，已放入战局背包。`);
  // 新需求②：卸下带气血装备后按「副本有效最大血量」重算 max（仅改 max，current 用 min 夹取）
  recomputeRunMaxHp(state);
  return true;
}

/** 取本局某槽位正在穿戴的装备 */
export function runGearOf(state: ExtractionRunState, slot: GearSlot): RunEquippedGear | undefined {
  return state.equipped.find((e) => e.slot === slot);
}

const GEAR_SLOT_LABEL_CN: Record<GearSlot, string> = {
  weapon: '主武器',
  offWeapon: '副武器',
  head: '头部',
  armor: '躯干护甲',
  legs: '腿部',
  accessory: '饰品',
};

/**
 * 使用恢复用品消除指定伤势（UI 依据药品的 treats 列表调用）。
 * 返回实际被消除的伤势；已不带该伤势则忽略。
 */
export function cureInjuries(state: ExtractionRunState, injuries: Injury[]): Injury[] {
  if (state.phase !== 'searching') return [];
  const cured: Injury[] = [];
  for (const inj of injuries) {
    if (state.injuries.includes(inj)) cured.push(inj);
  }
  if (cured.length === 0) return [];
  state.injuries = state.injuries.filter((i) => !cured.includes(i));
  plog(
    state,
    `💊 伤势已处理：${cured.map((i) => INJURY_LABEL[i]).join('、')} 消除，六维恢复（当前伤势 ${state.injuries.length} 项）。`,
  );
  return cured;
}

/**
 * 从战局背包消耗一件道具（qty-1 或整格移除）。
 * 供 UI 实现「副本内使用搜到的回复类道具」；返回被消耗的物品。
 */
export function consumeCarriedItem(state: ExtractionRunState, index: number): LootItem | null {
  if (state.phase !== 'searching') return null;
  const it = state.carriedLoot[index];
  if (!it) return null;
  const q = it.qty ?? 1;
  if (q <= 1) state.carriedLoot.splice(index, 1);
  else it.qty = q - 1;
  return it;
}

/** 搜刮敌方尸体：战斗胜利后的额外战利品机会（霸主尸体必掉高阶装备） */
export function lootCorpse(state: ExtractionRunState, rng: () => number = Math.random): void {
  if (!state.corpse || state.phase !== 'searching') return;
  spendTime(state, actionCost(state, ACTION_COST.corpseLoot), rng);
  if (state.phase !== 'searching') return;
  const enemyName = state.corpse.enemyName;
  const wasBoss = !!state.corpse.boss;
  const picks = 1 + Math.floor(rng() * 2);
  const gained: string[] = [];
  for (let i = 0; i < picks; i++) {
    const raw = state.zone.lootTable[Math.floor(rng() * state.zone.lootTable.length)];
    const text = grantLoot(state, raw, rng, 0.1);
    if (text) gained.push(text);
  }
  // v1.0.9 补充：boss 尸体的「霸主遗物」已在击败分支一次性发放，这里跳过 boss 额外掉落；普通敌尸仍走原随机奖励
  // wasBoss 块已移除（保留变量以避免破坏上方 enum/log 文本）
  if (!wasBoss) {
    // v1.0.10：小怪并非必定爆装备——按危险度 + 搜刮运势判定一次额外装备掉落
    const luck = runCombatBonus(state).lootLuck ?? 0;
    if (rng() < mobGearDropChance(state.zone.dangerLevel, luck)) {
      const bonus = rollGearDrop(rng, state.zone.dangerLevel, 0.1 + luck * 0.2);
      if (addCarriedLoot(state, bonus)) {
        gained.push(`【${bonus.name}】(${bonus.rarityName} · 估值 ${bonus.value})`);
      }
    }
  }
  state.corpse = undefined;
  const lootText = gained.length > 0 ? gained.join('\n') : '尸体上只有弹壳与血迹，一无所获。';
  state.scene = `你翻检【${enemyName}】的尸体……\n🩸 搜刮结果：\n${lootText}`;
  plog(state, `🩸 搜刮了【${enemyName}】的尸体。`);
}

// ===== 转移与撤离 =====

/** 前往下一区域：消耗时间、改变风险等级（zoneSearches 按区域独立累计，回来仍是搜干净的） */
export function moveToZone(state: ExtractionRunState, zone: DangerZone, rng: () => number = Math.random): void {
  if (state.phase !== 'searching' || state.encounter || state.atExtract) return;
  if (zone.id === state.zone.id) return;
  spendTime(state, actionCost(state, ACTION_COST.move), rng);
  if (state.phase !== 'searching') return;
  state.zone = zone;
  state.scene = [
    `你穿过废墟间的缝隙，转移到了【${zone.name}】。`,
    `${zone.flavor}`,
    `本区剩余搜索机会：${MAX_ZONE_SEARCHES}/${MAX_ZONE_SEARCHES}。`,
  ].join('\n');
  // 注：moveToZone 为旧版（非分支图）入口，不更新 currentZoneId，故此处不打印深度
  plog(state, `📍 转移至【${zone.name}】（危${zone.dangerLevel}）。`);
}

/**
 * v1.0.5：沿分支图移动到相邻节点（图移动模型的核心）。
 *  - 仅允许移动到当前节点的相邻区域；
 *  - 抵达撤离点（且已显形）→ 立即 atExtract（瞬间撤离，可确认/继续搜刮）；
 *  - 抵达霸主区且未击破 → 强制遭遇霸主；
 *  - 当前区未搜满就转移，有概率被残余敌人纠缠（伏击）。
 */
export function moveToNode(state: ExtractionRunState, targetId: string, rng: () => number = Math.random): void {
  if (state.phase !== 'searching' || state.encounter || state.atExtract) return;
  const adj = state.graph.edges[state.currentZoneId] ?? [];
  if (!adj.includes(targetId)) return;
  spendTime(state, actionCost(state, ACTION_COST.move), rng);
  if (state.phase !== 'searching') return;
  state.currentZoneId = targetId;
  state.zone = nodeToZone(currentZoneOf(state));
  // 霸主区不再于「进入」时强制遭遇；霸主改由本区最后一次搜刮触发（v1.0.5 修复）
  const reachedBossAfterDefeat =
    targetId === state.graph.bossZoneId && state.bossDefeated;
  if (
    (state.graph.extractZones.includes(targetId) && state.extractRevealed) ||
    reachedBossAfterDefeat
  ) {
    state.atExtract = true;
    plog(state, `🚁 你抵达撤离点【${state.zone.name}】，救援就在眼前。`);
  } else {
    state.atExtract = false;
  }
  // 转移伏击：当前区未搜满就转移，有概率被残余敌人纠缠
  const searched = state.zoneSearches[state.currentZoneId] ?? 0;
  const residualChance = searched < MAX_ZONE_SEARCHES ? 0.5 * (1 - searched / MAX_ZONE_SEARCHES) : 0;
  // v1.0.10：伏击率由「深度」驱动（越深越容易被残余敌人缠上）
  const depthAmbush = Math.min(0.65, 0.05 * zoneDepth(state) + 0.003 * (state.elapsedSec / 60));
  const ambushChance = Math.max(residualChance, depthAmbush);
  // v1.0.12：伏击池排除霸主——霸主唯一、仅于「霸主区第三次搜刮」登场，禁止转移途中刷 boss
  const ambushPool = state.zone.enemies.filter((e) => !e.boss);
  if (ambushPool.length > 0 && rng() < ambushChance) {
      const enemy = pickEnemy(state, rng, ambushPool);
      const intro = `⚠️ 转移遭袭！\n${searched >= MAX_ZONE_SEARCHES ? `你以为【${state.zone.name}】已被翻遍、再无威胁——可废墟深处仍有游荡的【${enemy.name}】循着动静扑了出来！（即便区域已搜刮干净，危险仍随等级与时间累积）` : `你收拾行装准备离开【${state.zone.name}】——但未探索彻底的区域里，残余的敌人循着你的动静追了上来！\n一名【${enemy.name}】堵住了去路。`}${enemy.affixes?.length ? `\n敌方词条：${enemy.affixes.map((a) => a.label).join('、')}` : ''}\n先解决纠缠，才能继续：\n🔹【主动开战】消耗弹药，开启回合战斗\n🔹【潜行绕行】消耗时间，有概率被发现；失败将被迫交战\n🔹【投掷物脱离】消耗烟雾弹/闪光弹，必定脱离纠缠\n🔹【突围撤离点】放弃深入，直奔撤离位置`;
      state.encounter = { enemy, intro };
      state.scene = intro;
      plog(state, `⚠ 转移途中被【${enemy.name}】纠缠（本区搜刮 ${searched}/${MAX_ZONE_SEARCHES} 次，深度 ${zoneDepth(state)}，对局 ${Math.floor(state.elapsedSec / 60)} 分）！`);
      updateThreat(state);
      maybeRevealExtract(state);
      return;
    }
  state.scene = `你穿过废墟间的缝隙，转移到了【${state.zone.name}】（本图危${state.zone.dangerLevel} · 本区深度 ${zoneDepth(state)}）。\n${state.zone.flavor}`;
  plog(state, `📍 转移至【${state.zone.name}】（危${state.zone.dangerLevel} · 深度 ${zoneDepth(state)}）。`);
  // v1.1.7：深4~深7 区域转移有 5% 概率感染
  maybeContractInfection(state, rng);
  updateThreat(state);
  maybeRevealExtract(state);
}

/**
 * 深入到本大地图的下一个分支区域（v1.0.2 主路线）：
 * 搜完 3 次 → 深入下一分支；第 MAP_BRANCH_COUNT 区为霸主领地。
 *
 * v1.0.2 转移伏击：分支未彻底探索（<MAX_ZONE_SEARCHES 次）就贸然深入，
 * 有概率被该区域残余的敌人纠缠 —— 且搜得越少概率越高（0 次约 55%，搜满 3 次必定安全）。
 */
export function advanceBranch(state: ExtractionRunState, rng: () => number = Math.random): void {
  if (state.phase !== 'searching' || state.encounter || state.atExtract) return;
  const len = state.map.branches?.length ?? 0;
  if (len === 0 || state.branchIndex >= len - 1) {
    state.scene = '你已站在本图最深处——霸主领地。这里没有更深的区域了。\n（击败霸主或就此撤离，自行决断。）';
    plog(state, '📍 已位于本图最深分支区。');
    return;
  }
  // 转移伏击判定：该分支搜刮次数越多，残余敌人越少，伏击概率越低
  const searched = state.zoneSearches[state.zone.id] ?? 0;
  const residualChance = searched < MAX_ZONE_SEARCHES ? 0.55 * (1 - searched / MAX_ZONE_SEARCHES) : 0;
  // v1.0.10：伏击率由「深度」驱动（越深越容易被残余敌人缠上）
  const depthAmbush = Math.min(0.65, 0.05 * zoneDepth(state) + 0.003 * (state.elapsedSec / 60));
  const ambushChance = Math.max(residualChance, depthAmbush);
  // v1.0.12：伏击池排除霸主——霸主唯一、仅于「霸主区第三次搜刮」登场，禁止转移途中刷 boss
  const ambushPool = state.zone.enemies.filter((e) => !e.boss);
  if (ambushPool.length > 0 && rng() < ambushChance) {
      const enemy = pickEnemy(state, rng, ambushPool);
      state.encounter = {
        enemy,
        intro: [
          '⚠️ 转移遭袭！',
          (searched >= MAX_ZONE_SEARCHES ? `你以为【${state.zone.name}】已被翻遍、再无威胁——可废墟深处仍有游荡的【${enemy.name}】循着动静扑了出来！（即便区域已搜刮干净，危险仍随等级与时间累积）` : `你收拾行装准备离开【${state.zone.name}】——但未探索彻底的区域里，残余的敌人循着你的动静追了上来！`),
          `一名【${enemy.name}】堵住了退路。${enemy.affixes?.length ? `\n敌方词条：${enemy.affixes.map((a) => a.label).join('、')}` : ''}`,
          '先解决纠缠，才能继续深入：',
          '🔹【主动开战】消耗弹药，开启回合战斗',
          '🔹【潜行绕行】消耗时间，有概率被发现；失败将被迫交战',
          '🔹【投掷物脱离】消耗烟雾弹/闪光弹，必定脱离纠缠',
          '🔹【突围撤离点】放弃深入，直奔撤离位置',
        ].join('\n'),
      };
      state.scene = state.encounter.intro;
      plog(state, `⚠ 转移途中被【${enemy.name}】纠缠（本分支搜刮 ${searched}/${MAX_ZONE_SEARCHES} 次，深度 ${zoneDepth(state)}，对局 ${Math.floor(state.elapsedSec / 60)} 分）！`);
      return;
    }
  spendTime(state, actionCost(state, ACTION_COST.move), rng);
  if (state.phase !== 'searching') return;
  state.branchIndex += 1;
  const nz = branchZone(state.map, state.branchIndex);
  state.zone = nz;
  const bossFloor = state.branchIndex >= len - 1;
  // v1.0.6：深入到霸主分支时，若霸主已被击败，原地可撤离
  state.atExtract = !!(nz.id === state.graph.bossZoneId && state.bossDefeated);
  state.scene = [
    `你翻过残垣、沿废弃通道一路深入，抵达【${nz.name}】。`,
    nz.flavor,
    `路线进度：第 ${state.branchIndex + 1}/${MAP_BRANCH_COUNT} 区（危${nz.dangerLevel}）。`,
    ...(bossFloor ? ['⚠ 这里是霸主领地——每一次搜索都可能把它引来！'] : []),
  ].join('\n');
  plog(state, `📍 深入至【${nz.name}】（危${nz.dangerLevel}${bossFloor ? '·霸主区' : ''}）。`);
  // v1.1.7：深4~深7 区域深入移动有 5% 概率感染
  maybeContractInfection(state, rng);
}

/** v1.0.5：突围奔赴最近撤离点（BFS 找最近撤离点，抄近路直奔，抵达即 atExtract） */
export function goToExtract(state: ExtractionRunState, rng: () => number = Math.random): void {
  if (state.phase !== 'searching' || state.encounter || state.atExtract) return;
  if (!state.extractRevealed) return; // v1.0.5：撤离点未显形前不可突围（防止非撤离点直接撤离）
  const target = nearestExtractZone(state);
  if (!target) {
    state.scene = '⚠ 暂无可抵达的撤离点（区域图异常）。';
    return;
  }
  spendTime(state, actionCost(state, ACTION_COST.travel), rng);
  if (state.phase !== 'searching') return;
  state.currentZoneId = target;
  state.zone = nodeToZone(currentZoneOf(state));
  state.atExtract = true;
  state.scene = '🚁 你不再恋战，抄近路冲向撤离信号区……\n救援直升机正在接近。\n【确认撤离】结束本局，背包物资全部入库。\n【继续搜刮】放弃本次机会——贪心者自负风险。';
  plog(state, '🚁 突围成功，已抵达撤离点。');
  // v1.1.7：深4~深7 区域突围移动有 5% 概率感染
  maybeContractInfection(state, rng);
  maybeRevealExtract(state);
}

/** 放弃本次撤离，返回地图继续搜刮 */
export function leaveExtract(state: ExtractionRunState, rng: () => number = Math.random): void {
  if (state.phase !== 'searching' || !state.atExtract) return;
  spendTime(state, actionCost(state, ACTION_COST.leaveExtract), rng);
  if (state.phase !== 'searching') return;
  state.atExtract = false;
  state.scene = `你咬了咬牙，退出了撤离信号区。\n时间不等人——剩余 ${fmtClock(timeLeft(state))}。`;
  plog(state, '放弃了本次撤离机会，返回继续搜刮。');
}

// ===== 撤离结算 =====

/** 撤离结算：成功→携带+安全箱物资入库 + 救援到的幸存者也带回基地；死亡/超时→仅安全箱保底 */
export function extract(state: ExtractionRunState): ExtractOutcome {
  if (state.phase === 'dead') return 'death';
  if (state.phase === 'timeout') return 'timeout';
  bankSecureIntoBanked(state);
  state.bankedLoot.push(...state.carriedLoot);
  const bankedValue = sumValue(state.bankedLoot);
  state.carriedLoot = [];
  if (state.carriedNpc) {
    state.bankedNpc = state.carriedNpc;
    state.carriedNpc = undefined;
  }
  state.phase = 'extracted';
  state.log.push(`${SYSTEM_LINES.extractSuccess} 入库 ${state.bankedLoot.length} 件，估值 ${bankedValue} 废土币`);
  return 'success';
}

function buildSummary(state: ExtractionRunState, outcome: ExtractOutcome): ExtractionSummary {
  return {
    survivorName: state.survivor.name,
    zoneName: state.zone.name,
    outcome,
    searches: state.searchCount,
    carriedValue: sumValue(state.carriedLoot),
    bankedValue: sumValue(state.bankedLoot),
    hpLeft: state.condition.resources.hp.current,
    hpMax: state.condition.resources.hp.max ?? 0,
  };
}

/** 确定性随机（mulberry32），让 Demo 可复现 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 一键演示：搜几次 → 遭遇则自动开战 → 搜尸 → 最终撤离。
 * 返回完整状态机 + 结算摘要，供上层（CLI / 前端 / 测试）消费。
 */
export function runAutoExtraction(opts: {
  survivor: SurvivorLoadout;
  zone: DangerZone;
  rng?: () => number;
  maxSearches?: number;
}): { state: ExtractionRunState; summary: ExtractionSummary } {
  const rng = opts.rng ?? Math.random;
  const state = createRun(opts.survivor, opts.zone, undefined, undefined, undefined, { rng });
  const maxSearches = opts.maxSearches ?? 8;
  let i = 0;
  while (i < maxSearches && state.phase === 'searching') {
    search(state, rng);
    if (state.pendingSearch) resolveBagFull(state, 'abandon', rng);
    if (state.encounter) resolveEncounter(state, 'fight', rng);
    if (state.corpse) lootCorpse(state, rng);
    // 当前区搜满则向相邻区移动一次，继续探索分支图
    if ((state.zoneSearches[state.zone.id] ?? 0) >= MAX_ZONE_SEARCHES) {
      const nb = zoneNeighbors(state)[0];
      if (nb) moveToNode(state, nb.id, rng);
    }
    i++;
  }
  const outcome: ExtractOutcome =
    state.phase === 'dead' ? 'death' : state.phase === 'timeout' ? 'timeout' : extract(state);
  return { state, summary: buildSummary(state, outcome) };
}

export { sumValue };
