/*
 * recovery.ts — 末世 HP 恢复系统。
 *
 * 设计目标：让受伤的幸存者「不能立刻再出击」。
 *
 * 恢复公式（每分钟）：
 *   base  = maxHp * 0.005 + 体质 * 0.4             // 基础：最大生命 0.5%/分 + 体质每点 +0.4/分（叠加 maxHp 间接 0.1 ≈ +0.5/分）
 *   rate  = base * (1 + recoveryBonus)             // recoveryBonus 由 computeShelterBonuses 统一给出（医疗站等设施的 recoveryPerLevel），单一来源
 *   rate *= max(0.1, 1 - 累加伤势惩罚)
 *   若医疗消耗品激活中：rate *= 2（MED_MULTIPLIER）
 *   设计：2026-09-08 重做——移除原先「×0.1 全局缩放」与「医疗站等级硬编码 1+0.5×级」的双重问题。
 *        医疗站恢复改为只走 recoveryBonus（recoveryPerLevel=0.2，Lv5=+100% 即 ×2 翻倍），体质项重新标定（VITALITY_PER_POINT=0.4，每点体质约 +0.5/分）。
 *
 * 时间戳驱动恢复：UI 加载/切换 tab 时按 now - lastRecoveredAt 计算
 * 一次性结算，避免每帧 setState。
 */

import type { SurvivalGameState } from './state';
import type { SurvivorProfile } from './chargen';
import { aggregateTraitCombat } from './chargen';
import type { Attributes } from '@shared/types/cultivator';
import { computeShelterBonuses } from './economy';

export type Injury = 'fracture' | 'infection' | 'bleeding' | 'shellShock' | 'fatigue';

export const INJURY_LABEL: Record<Injury, string> = {
  fracture: '骨折',
  infection: '感染',
  bleeding: '失血',
  shellShock: '震伤',
  fatigue: '疲惫',
};

export const INJURY_DESC: Record<Injury, string> = {
  fracture: '骨头错位：力量/敏捷/耐力 -1/3，恢复速度 -25%',
  infection: '病毒侵蚀：体质/意志 -1/4，恢复速度 -50%',
  bleeding: '血流不止：体质/耐力 -1/3，恢复速度 -35%',
  shellShock: '耳鸣目眩：感知/意志 -1/3，恢复速度 -15%',
  fatigue: '体力透支：全六维 -1/4，恢复速度 -10%',
};

export const INJURY_PENALTY: Record<Injury, number> = {
  fracture: 0.25,
  infection: 0.5,
  bleeding: 0.35,
  shellShock: 0.15,
  fatigue: 0.1,
};

// ===== v1.0.3：伤势对「基础六维」的临时削减 =====
//
// 设计：伤势削减的是角色**基础六维**（profile.attributes，不含装备/词条/避难所加成），
// 削减后再叠加装备等外部加成 —— 即「debuff 只削弱底子，不削装备」。
// UI 上被削减的属性以红色数字呈现。

export interface InjuryAttrDef {
  /** 受影响的六维键 */
  attrs: (keyof Attributes)[];
  /** 削减比例（0.333… = 三分之一） */
  ratio: number;
}

export const INJURY_ATTR_PENALTY: Record<Injury, InjuryAttrDef> = {
  fracture: { attrs: ['strength', 'speed', 'endurance'], ratio: 1 / 3 },
  bleeding: { attrs: ['vitality', 'endurance'], ratio: 1 / 3 },
  shellShock: { attrs: ['spirit', 'willpower'], ratio: 1 / 3 },
  infection: { attrs: ['vitality', 'willpower'], ratio: 1 / 4 },
  fatigue: { attrs: ['vitality', 'strength', 'spirit', 'endurance', 'speed', 'willpower'], ratio: 1 / 4 },
};

/** 汇总一组伤势对每个六维的削减比例（叠加但不超过 60%，避免出现 0 属性） */
export function injuryAttrPenalty(injuries: Injury[]): Partial<Record<keyof Attributes, number>> {
  const out: Partial<Record<keyof Attributes, number>> = {};
  for (const inj of injuries) {
    const def = INJURY_ATTR_PENALTY[inj];
    if (!def) continue;
    for (const k of def.attrs) {
      out[k] = Math.min(0.6, (out[k] ?? 0) + def.ratio);
    }
  }
  return out;
}

/** 把伤势削减施加到基础六维上，返回「受伤后的基础六维」（每项最低 1） */
export function applyInjuryToBase(base: Attributes, injuries: Injury[]): Attributes {
  if (!injuries || injuries.length === 0) return { ...base };
  const pen = injuryAttrPenalty(injuries);
  const out: Attributes = { ...base };
  for (const k of Object.keys(pen) as (keyof Attributes)[]) {
    const ratio = pen[k] ?? 0;
    out[k] = Math.max(1, Math.floor((base[k] ?? 0) * (1 - ratio)));
  }
  return out;
}

/** 单条伤势对人类可读的六维影响文本（如「力量 -5」） */
export function injuryAttrText(base: Attributes, inj: Injury): string {
  const def = INJURY_ATTR_PENALTY[inj];
  if (!def) return '';
  const after = applyInjuryToBase(base, [inj]);
  return def.attrs
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

// ===== v1.0.3：血量三阶段 =====

export type HpStage = 'gray' | 'red' | 'orange' | 'green';

/** 血量百分比（0~100）→ 阶段：1~30 红血 / 31~70 橙血 / 70 以上绿血 / 0 灰（倒地） */
export function hpStage(hpPct: number): HpStage {
  if (hpPct <= 0) return 'gray';
  if (hpPct <= 30) return 'red';
  if (hpPct <= 70) return 'orange';
  return 'green';
}

export const HP_STAGE_META: Record<HpStage, { label: string; bar: string; text: string; hex: string }> = {
  gray: { label: '倒地', bar: 'bg-zinc-600', text: 'text-zinc-400', hex: '#52525b' },
  red: { label: '红血·危', bar: 'bg-rose-600', text: 'text-rose-400', hex: '#e11d48' },
  orange: { label: '橙血·险', bar: 'bg-amber-500', text: 'text-amber-400', hex: '#f59e0b' },
  green: { label: '绿血·稳', bar: 'bg-emerald-500', text: 'text-emerald-400', hex: '#10b981' },
};

/**
 * v1.0.3：战斗后按「战后剩余血量阶段」概率产生伤势。
 *  - 震伤：全阶段都可能，血量越低概率越高；
 *  - 失血：血量跌到 70% 以下才可能；
 *  - 骨折：血量跌到 30% 以下才可能（最凶险的红血阶段专属）。
 * 意志削减震伤概率，体质削减失血概率（抗毒抗辐射/止血能力）。
 */
export function rollCombatInjuries(
  rng: () => number,
  hpPct: number, // 0~100
  attrs: Attributes,
): Injury[] {
  const p = Math.max(0, Math.min(100, hpPct)) / 100;
  const out: Injury[] = [];
  // 意志抗性：意志 10 → ×0.85；意志 20 → ×0.70（下限 0.55）；意志 30 → ×0.55（封底）
  const willResist = Math.max(0.55, 1 - (attrs.willpower ?? 10) * 0.015);
  // 体质抗性：体质 10 → ×0.90；体质 25 → ×0.75（下限 0.6）；体质 40 → ×0.60（封底）
  const vitResist = Math.max(0.6, 1 - (attrs.vitality ?? 10) * 0.01);

  // 震伤：仅在血量受损（<100%）时才可能触发；血量越低概率越高
  // 满血 0%，50% 约 22%，10% 约 40%（再受意志抗性削减）
  const shockP = p >= 1 ? 0 : 0.45 * (1 - p) * willResist;
  if (rng() < shockP) out.push('shellShock');

  // 失血（<70%）：70% → 0%，30% → 约 26%，10% → 约 39%
  if (p < 0.7) {
    const bleedP = 0.45 * ((0.7 - p) / 0.7) * vitResist;
    if (rng() < bleedP) out.push('bleeding');
  }

  // 骨折（<30%）：30% → 0%，15% → 30%，濒死 → 60%
  if (p < 0.3) {
    const fracP = 0.6 * ((0.3 - p) / 0.3);
    if (rng() < fracP) out.push('fracture');
  }
  return out;
}

export interface SurvivorStatus {
  currentHp: number;
  maxHp: number;
  injuries: Injury[];
  lastRecoveredAt: string; // ISO
  medActiveUntil?: string; // ISO — 医疗品 2x 恢复窗口
  /** 濒死截止时间（ISO）。存在表示正处于「撤离失败」后的濒死状态，需救治，超时则真正离世 */
  dyingUntil?: string;
  /** 出击前是否满血（决定是否允许立刻再出击） */
  sortieReady: boolean;
}

/** 撤离失败后的濒死宽限期（分钟）：超时未救治则成员真正离世 */
export const NEAR_DEATH_GRACE_MIN = 10;

const BASE_REGEN_RATIO = 0.005; // 基础回血：最大生命的 0.5% / 分钟（无设施加成时的底速）
const VITALITY_PER_POINT = 0.4; // 每点体质 +0.4 气血 / 分钟（固定补足；叠加 maxHp 间接 20×0.005=0.1 后约 +0.5/分）
const MED_MULTIPLIER = 2;
const MED_DURATION_MIN = 5;

/** 由六维属性推导 battle-v5 气血上限（与 createCombatUnitFromCultivator 同公式） */
export function deriveMaxHp(attrs: Attributes, hpBonus = 0): number {
  return Math.round(400 + attrs.vitality * 20 + attrs.endurance * 3 + hpBonus);
}

/** 给幸存者建立初始 status（满血、刚建档） */
export function freshStatus(survivor: SurvivorProfile, now: number, baseMaxHp = 600): SurvivorStatus {
  // baseMaxHp 仅作兜底；实际以 battle-v5 公式 + 词条气血为准，保证恢复/战斗同口径
  const traitC = aggregateTraitCombat(survivor.traits);
  const maxHp = Math.max(baseMaxHp, deriveMaxHp(survivor.attributes, traitC.hpBonus));
  return {
    currentHp: maxHp,
    maxHp,
    injuries: [],
    lastRecoveredAt: new Date(now).toISOString(),
    sortieReady: true,
  };
}

/** 计算单人恢复速率（HP/分钟）。UI 显示用。 */
export function regenPerMinute(survivor: SurvivorProfile, status: SurvivorStatus, state: SurvivalGameState, now: number): number {
  const bonuses = computeShelterBonuses(state.facilities, state.factionRep);

  // 单一来源：医疗站等设施的恢复加成只来自 recoveryBonus（computeShelterBonuses），
  // 不再在 regenPerMinute 内硬编码「1 + 0.5 × 医疗站等级」，避免与 recoveryBonus 重复叠加。
  let rate = status.maxHp * BASE_REGEN_RATIO + survivor.attributes.vitality * VITALITY_PER_POINT;
  rate *= 1 + bonuses.recoveryBonus;
  const injuryPenalty = status.injuries.reduce((acc, inj) => acc + INJURY_PENALTY[inj], 0);
  rate *= Math.max(0.1, 1 - injuryPenalty);
  if (status.medActiveUntil && new Date(status.medActiveUntil).getTime() > now) {
    rate *= MED_MULTIPLIER;
  }
  return rate;
}

/** 应用单人时间戳恢复（不可变）。返回新 status。 */
export function recoverOne(
  survivor: SurvivorProfile,
  status: SurvivorStatus,
  state: SurvivalGameState,
  now: number,
): SurvivorStatus {
  // 处于濒死状态：不自动恢复，等待救治（真正死亡由 recoverAll 在宽限到期时处理）
  if (status.dyingUntil && new Date(status.dyingUntil).getTime() > now) {
    return status;
  }
  if (status.currentHp >= status.maxHp) {
    // 已满血：仅更新时间戳
    return { ...status, lastRecoveredAt: new Date(now).toISOString(), sortieReady: true };
  }
  const last = new Date(status.lastRecoveredAt).getTime();
  const minutes = Math.max(0, (now - last) / 60000);
  if (minutes < 0.05) return status; // <3 秒跳过

  const rate = regenPerMinute(survivor, status, state, now);
  const heal = Math.floor(rate * minutes);
  if (heal <= 0) return status;

  const nextHp = Math.min(status.maxHp, status.currentHp + heal);
  return {
    ...status,
    currentHp: nextHp,
    lastRecoveredAt: new Date(now).toISOString(),
    sortieReady: nextHp >= status.maxHp * 0.95,
  };
}

/** 一次性结算全部幸存者的恢复；返回新 state 或原 state（无变化）。 */
export function recoverAll(state: SurvivalGameState, now: number = Date.now()): SurvivalGameState {
  const next: Record<string, SurvivorStatus> = { ...state.survivorStatus };
  let changed = false;
  const deadIds: string[] = [];

  for (const s of state.survivors) {
    const cur = state.survivorStatus[s.id];
    if (!cur) {
      next[s.id] = freshStatus(s, now);
      changed = true;
      continue;
    }
    // 濒死宽限到期 → 真正离世，移出战团
    if (cur.dyingUntil && new Date(cur.dyingUntil).getTime() <= now) {
      deadIds.push(s.id);
      delete next[s.id];
      changed = true;
      continue;
    }
    const upd = recoverOne(s, cur, state, now);
    if (upd !== cur) {
      next[s.id] = upd;
      changed = true;
    }
  }

  if (!changed) return state;

  // 处理真正离世的成员：移出战团、卸装备、必要时改派出击者
  let survivors = state.survivors;
  let equipped = state.equipped;
  let activeSurvivorId = state.activeSurvivorId;
  const logs: string[] = [];
  if (deadIds.length > 0) {
    const deadNames = new Map(state.survivors.filter((s) => deadIds.includes(s.id)).map((s) => [s.id, s.name]));
    survivors = state.survivors.filter((s) => !deadIds.includes(s.id));
    equipped = { ...state.equipped };
    for (const id of deadIds) delete equipped[id];
    if (activeSurvivorId && deadIds.includes(activeSurvivorId)) {
      activeSurvivorId = survivors[0]?.id ?? null;
    }
    for (const id of deadIds) {
      logs.push(`【阵亡】${deadNames.get(id) ?? '幸存者'} 因伤重未及救治，离开了战团。`);
    }
  }

  return {
    ...state,
    survivors,
    equipped,
    activeSurvivorId,
    survivorStatus: next,
    log: logs.length > 0 ? [...logs, ...state.log].slice(0, 50) : state.log,
  };
}

/** 出击结束回写 HP（不可变）；按伤害比例追加伤势。 */
export function applyPostSortie(
  status: SurvivorStatus,
  finalHp: number,
  damageRatio: number, // 0~1
  now: number = Date.now(),
): SurvivorStatus {
  const injuries = [...status.injuries];
  // 损失越多越容易挂彩
  if (damageRatio > 0.3 && !injuries.includes('fracture')) injuries.push('fracture');
  if (damageRatio > 0.5 && !injuries.includes('bleeding')) injuries.push('bleeding');
  if (damageRatio > 0.75 && !injuries.includes('shellShock')) injuries.push('shellShock');
  return {
    ...status,
    currentHp: Math.max(0, Math.round(finalHp)),
    injuries,
    // 成功回战团即脱离濒死（若之前处于撤离失败后的濒死状态）
    dyingUntil: undefined,
    lastRecoveredAt: new Date(now).toISOString(),
    sortieReady: finalHp >= status.maxHp * 0.95 && injuries.length === 0,
  };
}

/** 阵亡回写（满伤势 + 重伤） */
export function applyPostDeath(status: SurvivorStatus, now: number = Date.now()): SurvivorStatus {
  return {
    ...status,
    currentHp: Math.max(1, Math.round(status.maxHp * 0.2)),
    injuries: ['fracture', 'bleeding', 'shellShock'],
    lastRecoveredAt: new Date(now).toISOString(),
    sortieReady: false,
  };
}

/**
 * 撤离失败回写：幸存者回战团进入「濒死」状态（仅余微弱生命、满身伤势、限时救治）。
 * 若宽限期内未用药/付费救治，由 recoverAll 判定其真正离世并移出战团。
 */
export function applyNearDeath(status: SurvivorStatus, now: number = Date.now()): SurvivorStatus {
  const until = new Date(now + NEAR_DEATH_GRACE_MIN * 60_000).toISOString();
  return {
    ...status,
    currentHp: Math.max(1, Math.round(status.maxHp * 0.05)),
    injuries: ['fracture', 'bleeding', 'shellShock'],
    dyingUntil: until,
    lastRecoveredAt: new Date(now).toISOString(),
    sortieReady: false,
  };
}

/** 使用医疗品：立即回血 + 开启恢复加速窗口 */
export function applyMedicine(
  status: SurvivorStatus,
  healAmount: number,
  now: number = Date.now(),
): SurvivorStatus {
  const until = new Date(now + MED_DURATION_MIN * 60_000).toISOString();
  const nextHp = Math.min(status.maxHp, status.currentHp + healAmount);
  return {
    ...status,
    currentHp: nextHp,
    medActiveUntil: until,
    lastRecoveredAt: new Date(now).toISOString(),
    sortieReady: nextHp >= status.maxHp * 0.95 && status.injuries.length === 0,
  };
}

/** 治疗一处伤势（医疗站 Lv3 启用 / 药品消耗） */
export function treatInjury(status: SurvivorStatus, injury: Injury): SurvivorStatus {
  return {
    ...status,
    injuries: status.injuries.filter((i) => i !== injury),
    sortieReady: status.currentHp >= status.maxHp * 0.95 && status.injuries.length - 1 === 0,
  };
}

/** 估计「满血还需多久」(秒)。负数 = 已满血。 */
export function timeToFullSeconds(
  survivor: SurvivorProfile,
  status: SurvivorStatus,
  state: SurvivalGameState,
  now: number,
): number {
  if (status.currentHp >= status.maxHp) return 0;
  const rate = regenPerMinute(survivor, status, state, now);
  if (rate <= 0.01) return Number.POSITIVE_INFINITY;
  const minutes = (status.maxHp - status.currentHp) / rate;
  return Math.ceil(minutes * 60);
}

export { MED_DURATION_MIN, MED_MULTIPLIER };