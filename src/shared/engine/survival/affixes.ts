/*
 * affixes.ts — 废土词条 / 稀有度体系（白-绿-蓝-紫-黄-橙-红）。
 *
 * 设计意图（呼应最初游戏「用颜色区分词条阶级」）：
 *  - 7 阶稀有度，配色与最初游戏完全一致：白(普通) → 绿 → 蓝 → 紫 → 黄 → 橙 → 红(传说)，
 *    阶级逐级提升：数值更强、出现概率更低。
 *  - 敌人 / 掉落装备都从同一套 tier 体系取词缀；副本危险度(dangerLevel)决定可达的最高阶
 *    与词缀数量——危险度越高，遇到的敌人词缀越狠、掉落的装备阶级越高。
 *
 * 关于「对接 creation-v2 词条库」：creation-v2 的 AffixRarity 只有 4 阶且依赖整套
 * creation-tag / 监听器 / 能量预算管线，直接拉入会拖垮本搜打撤模块。这里沿用其
 * 「稀有度 → 权重 → 词缀数量 → 数值缩放」的分层思想，但落到自包含的废土词条模型，
 * 保证可复现、可 lint、低风险。
 */

import type { Attributes } from '@shared/types/cultivator';
import type { GearItem, GearSlot } from './economy';
import { type RNG, pickN, weightedPick } from './rng';

// ===== 7 阶稀有度（颜色即阶级） =====

export type AffixTierKey =
  | 'white'
  | 'green'
  | 'blue'
  | 'purple'
  | 'yellow'
  | 'orange'
  | 'red';

export interface AffixTier {
  key: AffixTierKey;
  /** 0..6，数字越大阶级越高 */
  tier: number;
  /** 中文阶级名（白/绿/蓝/紫/黄/橙/红） */
  label: string;
  /** 阶级配色（与最初游戏一致） */
  color: string;
  /** 抽取权重（越高阶越稀有） */
  weight: number;
  /** 该阶级词缀数值倍率（逐级提升） */
  affixMag: number;
  /** 阶级后缀（用于装备命名，如「·蓝」） */
  suffix: string;
}

export const AFFIX_TIERS: AffixTier[] = [
  { key: 'white', tier: 0, label: '白', color: '#cbd5e1', weight: 40, affixMag: 1.0, suffix: '·白' },
  { key: 'green', tier: 1, label: '绿', color: '#4ade80', weight: 28, affixMag: 1.4, suffix: '·绿' },
  { key: 'blue', tier: 2, label: '蓝', color: '#38bdf8', weight: 18, affixMag: 1.9, suffix: '·蓝' },
  { key: 'purple', tier: 3, label: '紫', color: '#c084fc', weight: 10, affixMag: 2.5, suffix: '·紫' },
  { key: 'yellow', tier: 4, label: '黄', color: '#facc15', weight: 4, affixMag: 3.2, suffix: '·黄' },
  { key: 'orange', tier: 5, label: '橙', color: '#fb923c', weight: 1.5, affixMag: 4.0, suffix: '·橙' },
  { key: 'red', tier: 6, label: '红', color: '#f87171', weight: 0.5, affixMag: 5.0, suffix: '·红' },
];

export function tierByTier(tier: number): AffixTier {
  return AFFIX_TIERS[Math.max(0, Math.min(AFFIX_TIERS.length - 1, Math.round(tier)))];
}

export function tierColor(tier: number): string {
  return tierByTier(tier).color;
}

export function tierLabel(tier: number): string {
  return tierByTier(tier).label;
}

/** 按阶级 key 取配色（词条天赋着色用） */
export function affixColor(key: AffixTierKey): string {
  return AFFIX_TIERS.find((t) => t.key === key)?.color ?? '#cbd5e1';
}

/** 按阶级 key 取中文阶级名（词条天赋着色用） */
export function affixLabel(key: AffixTierKey): string {
  return AFFIX_TIERS.find((t) => t.key === key)?.label ?? '白';
}

/** UI 用的图例（白-绿-蓝-紫-黄-橙-红） */
export const RARITY_LEGEND = AFFIX_TIERS.map((t) => ({ label: t.label, color: t.color }));

// ===== 词条定义（敌人 / 装备共用一套分层思想） =====

export type AffixKind = 'offense' | 'defense' | 'utility';

export interface SurvivalAffix {
  id: string;
  name: string;
  /** 描述模板，{n} 会被最终数值替换 */
  desc: string;
  /** 属性增量（按 affixMag 缩放） */
  modifiers?: Partial<Attributes>;
  /** 战斗增益（按 affixMag 缩放） */
  combat?: {
    hpBonus?: number;
    critBonus?: number;
    lootLuck?: number;
    xpBonus?: number;
    coinBonus?: number;
  };
  weight: number;
  /** 仅在该阶级及以上才会出现（高价值词缀锁高阶） */
  minTier?: number;
  kind: AffixKind;
}

/** 已结算、可直接展示与应用的词缀实例 */
export interface AppliedAffix {
  id: string;
  name: string;
  tier: number;
  tierKey: AffixTierKey;
  color: string;
  /** 展示名，如「凶暴·蓝」 */
  label: string;
  /** 最终描述（{n} 已替换） */
  text: string;
  modifiers?: Partial<Attributes>;
  combat?: {
    hpBonus?: number;
    critBonus?: number;
    lootLuck?: number;
    xpBonus?: number;
    coinBonus?: number;
  };
}

// ===== 敌人词缀池（作用于敌人战斗单元） =====

export const ENEMY_AFFIXES: SurvivalAffix[] = [
  { id: 'ea-ferocious', name: '凶暴', desc: '力量 +{n}', modifiers: { strength: 3 }, weight: 12, kind: 'offense' },
  { id: 'ea-bloodthirsty', name: '嗜血', desc: '暴击 +{n}%', combat: { critBonus: 0.03 }, weight: 10, kind: 'offense' },
  { id: 'ea-ironhide', name: '铁甲', desc: '耐力 +{n}', modifiers: { endurance: 3 }, weight: 12, kind: 'defense' },
  { id: 'ea-tough', name: '重甲', desc: '气血 +{n}', combat: { hpBonus: 10 }, weight: 10, kind: 'defense' },
  { id: 'ea-swift', name: '迅捷', desc: '敏捷 +{n}', modifiers: { speed: 4 }, weight: 11, kind: 'utility' },
  { id: 'ea-sensor', name: '感知', desc: '感知 +{n}', modifiers: { spirit: 3 }, weight: 10, kind: 'utility' },
  { id: 'ea-rage', name: '狂怒', desc: '力量 +{n}/暴击 +{n}%', modifiers: { strength: 2 }, combat: { critBonus: 0.04 }, weight: 8, minTier: 2, kind: 'offense' },
  { id: 'ea-regen', name: '再生', desc: '体质 +{n}/气血 +{n}', modifiers: { vitality: 3 }, combat: { hpBonus: 8 }, weight: 8, minTier: 2, kind: 'defense' },
  { id: 'ea-savage', name: '凶性', desc: '力量 +{n}/暴击 +{n}%', modifiers: { strength: 3 }, combat: { critBonus: 0.05 }, weight: 6, minTier: 3, kind: 'offense' },
  { id: 'ea-steelbone', name: '钢骨', desc: '耐力 +{n}/气血 +{n}', modifiers: { endurance: 5 }, combat: { hpBonus: 20 }, weight: 5, minTier: 3, kind: 'defense' },
  { id: 'ea-apex', name: '巅峰', desc: '全属性 +{n}/暴击 +{n}%', modifiers: { vitality: 3, strength: 3, speed: 2 }, combat: { critBonus: 0.06 }, weight: 3, minTier: 4, kind: 'offense' },
  { id: 'ea-unbroken', name: '不灭', desc: '气血 +{n}', combat: { hpBonus: 40 }, weight: 3, minTier: 5, kind: 'defense' },
];

// ===== 装备掉落词缀池（v1.0.2：只加特殊属性，不加六维） =====
//
// 设计原则：装备自身的六维 = 槽位基础属性（灰字，固定可靠）；
// 生成的「词条」只提供特殊属性 —— 生命值 / 暴击 / 搜刮运势 / 经验获取 / 金币获取。
// 数值随词条阶级（affixMag）缩放：白阶通常只有 1 条低数值词条，
// 高阶有概率多条 + 更高数值；低阶也有小概率出多词条（搏一搏的惊喜）。

export const GEAR_AFFIXES: SurvivalAffix[] = [
  { id: 'ga-hp', name: '强化装甲', desc: '生命值 +{n}', combat: { hpBonus: 20 }, weight: 12, kind: 'defense' },
  { id: 'ga-crit', name: '致命一击', desc: '暴击率 +{n}%', combat: { critBonus: 0.03 }, weight: 9, minTier: 1, kind: 'offense' },
  { id: 'ga-scav', name: '搜刮直觉', desc: '搜刮运势 +{n}%', combat: { lootLuck: 0.08 }, weight: 8, minTier: 1, kind: 'utility' },
  { id: 'ga-coin', name: '拾荒嗅觉', desc: '金币获取 +{n}%', combat: { coinBonus: 0.10 }, weight: 9, kind: 'utility' },
  { id: 'ga-xp', name: '实战淬炼', desc: '经验获取 +{n}%', combat: { xpBonus: 0.10 }, weight: 8, minTier: 2, kind: 'utility' },
  { id: 'ga-bigHP', name: '泰坦装甲', desc: '生命值 +{n}', combat: { hpBonus: 45 }, weight: 5, minTier: 3, kind: 'defense' },
  { id: 'ga-deadly', name: '死神印记', desc: '暴击率 +{n}%', combat: { critBonus: 0.06 }, weight: 4, minTier: 4, kind: 'offense' },
  { id: 'ga-midas', name: '点石成金', desc: '金币获取 +{n}%/搜刮运势 +{n}%', combat: { coinBonus: 0.10, lootLuck: 0.08 }, weight: 3, minTier: 4, kind: 'utility' },
  { id: 'ga-veteran', name: '老兵传承', desc: '经验获取 +{n}%/生命值 +{n}', combat: { xpBonus: 0.12, hpBonus: 25 }, weight: 3, minTier: 5, kind: 'utility' },
  { id: 'ga-mythic', name: '神话锻造', desc: '生命值 +{n}/暴击率 +{n}%', combat: { hpBonus: 60, critBonus: 0.08 }, weight: 2, minTier: 6, kind: 'defense' },
];

const GEAR_SLOT_NAMES: Record<GearSlot, string> = {
  weapon: '主武器',
  offWeapon: '副武器',
  head: '头部',
  armor: '护甲',
  legs: '腿部',
  accessory: '配件',
};

/**
 * 装备品质的废土风中文名（替代底层颜色阶级 t.label 用于装备命名/展示）。
 * 阶梯：锈蚀(白)→改制(绿)→精工(蓝)→军用(紫)→霸主(黄)→超凡(橙)→神话(红)。
 * 仅用于装备显示；词条/天赋的配色与阶级标识（t.label）保持不变，避免牵动整个稀有度体系。
 */
const GEAR_TIER_NAMES: Record<AffixTierKey, string> = {
  white: '锈蚀',
  green: '改制',
  blue: '精工',
  purple: '军用',
  yellow: '霸主',
  orange: '超凡',
  red: '神话',
};

/**
 * 按数字阶级取装备废土风品质名（锈蚀/改制/…）。装备命名统一走这里，
 * 避免 rollGearDrop 与读档迁移两处各写一份导致不一致。
 */
export function gearTierName(tier: number): string {
  return GEAR_TIER_NAMES[tierByTier(tier).key];
}

/** 装备完整显示名：废土风品质名 + 槽位名（如「锈蚀主武器」）。 */
export function buildGearName(tier: number, slot: GearSlot): string {
  return `${gearTierName(tier)}${GEAR_SLOT_NAMES[slot]}`;
}

const GEAR_SLOT_BASE: Record<GearSlot, Partial<Attributes>> = {
  weapon: { strength: 3, spirit: 1 },
  offWeapon: { strength: 2, speed: 1 },
  head: { spirit: 2, willpower: 2 },
  armor: { endurance: 3, vitality: 1 },
  legs: { speed: 3, endurance: 1 },
  accessory: { speed: 2, willpower: 2 },
};

/**
 * 装备本身价值（即售出价值）：基础值随阶级与词条数线性成长，再乘稀有度系数（白 1.0× → 红 2.2×）。
 * v1.1.9：让「显示价值」直接等于原售出价，避免两件价不一致。
 */
export function gearBaseValue(tier: number, affixCount: number): number {
  const raw = 40 + tier * 45 + affixCount * 25;
  return Math.max(1, Math.round(raw * (1 + tier * 0.2)));
}

// ===== 阶级抽取（随副本难度提升） =====

// ===== v1.0.10：装备掉落品质权重表（按副本危险度 危1..危7）=====
//
// 语义：一旦「判定掉落装备」，按下表抽品质。行 = 危1..危7，列 = 白/绿/蓝/紫/黄/橙/红（单位 %）。
// 小怪（普通敌人 / 翻箱倒柜）并非必爆装备，先过 mobGearDropChance；霸主必定爆装备，走 BOSS 表。
// 这是「基础概率权重」，实际还会被感知 / 搜刮运势（luckBias）向高阶拉动。

/** 小怪掉落分布（掉落装备时品质权重，%） */
export const MOB_GEAR_QUALITY_WEIGHTS: readonly (readonly number[])[] = [
  //        白   绿   蓝   紫   黄   橙   红
  /* 危1 */ [70, 22, 7, 1, 0, 0, 0],
  /* 危2 */ [58, 28, 11, 2.5, 0.5, 0, 0],
  /* 危3 */ [45, 30, 18, 5.5, 1, 0.5, 0],
  /* 危4 */ [32, 28, 24, 11, 3.5, 1.5, 0],
  /* 危5 */ [20, 24, 26, 18, 8, 3.5, 0.5],
  /* 危6 */ [10, 18, 24, 24, 14, 8, 2],
  /* 危7 */ [4, 10, 18, 26, 20, 16, 6],
];

/** BOSS 掉落分布（掉落装备时品质权重，%） */
export const BOSS_GEAR_QUALITY_WEIGHTS: readonly (readonly number[])[] = [
  //        白   绿   蓝   紫   黄   橙   红
  /* 危1 */ [40, 38, 18, 4, 0, 0, 0],
  /* 危2 */ [30, 35, 24, 9, 2, 0, 0],
  /* 危3 */ [20, 28, 30, 16, 5, 1, 0],
  /* 危4 */ [12, 22, 28, 24, 10, 4, 0],
  /* 危5 */ [6, 14, 24, 28, 16, 10, 2],
  /* 危6 */ [3, 8, 18, 26, 22, 16, 7],
  /* 危7 */ [1, 4, 12, 22, 24, 24, 13],
];

/**
 * 蜃景密室专属掉落分布（掉落装备时品质权重，%）。
 * 高风险高回报：整体比 BOSS 表更豪——低难保底蓝装、高阶橙红更肥。
 * 仅 mirageChamber 调用，不影响任何正常副本 / 搜刮 / 霸主掉落。
 */
export const MIRAGE_GEAR_QUALITY_WEIGHTS: readonly (readonly number[])[] = [
  //        白   绿   蓝   紫   黄   橙   红
  /* 危1 */ [10, 30, 40, 15, 5, 0, 0],
  /* 危2 */ [6, 24, 40, 20, 7, 3, 0],
  /* 危3 */ [3, 18, 38, 25, 10, 5, 1],
  /* 危4 */ [1, 12, 34, 28, 15, 8, 2],
  /* 危5 */ [0, 8, 28, 30, 18, 12, 4],
  /* 危6 */ [0, 4, 22, 28, 20, 18, 8],
  /* 危7 */ [0, 2, 14, 24, 22, 24, 14],
];

/** 危险度归一到 1..7（副本难度统一为危1~危7） */
export function clampDanger(dangerLevel: number): number {
  const d = Math.round(Number.isFinite(dangerLevel) ? dangerLevel : 1);
  return Math.max(1, Math.min(7, d));
}

/**
 * 小怪掉落装备的基础概率：并不是每只小怪都会爆装备。
 * 危1 20% → 危7 44%，受搜刮运势（luck，0.2 = +20%）线性放大，上限 90%。
 */
export function mobGearDropChance(dangerLevel: number, luck = 0): number {
  const d = clampDanger(dangerLevel);
  const base = 0.2 + 0.04 * (d - 1);
  return Math.max(0, Math.min(0.9, base * (1 + Math.max(0, luck))));
}

/**
 * 按危险度 + 是否霸主，抽掉落装备的品质阶级（0..6）。
 * luckBias（感知 / 搜刮运势）会把权重整体向高阶推移：weight *= (1 + gamma * tier)。
 */
export function rollGearTier(
  rng: RNG,
  dangerLevel: number,
  boss = false,
  luckBias = 0,
  mirage = false,
): number {
  const d = clampDanger(dangerLevel);
  const table = (mirage
    ? MIRAGE_GEAR_QUALITY_WEIGHTS
    : boss
      ? BOSS_GEAR_QUALITY_WEIGHTS
      : MOB_GEAR_QUALITY_WEIGHTS)[d - 1];
  const gamma = Math.max(-0.5, Math.min(1, luckBias)) * 0.35;
  const candidates = table.map((base, tier) => ({
    value: tier,
    weight: Math.max(0, base * (1 + gamma * tier)),
  }));
  return weightedPick(rng, candidates);
}

/**
 * 依副本危险度抽一个阶级。
 * 危险度越高，可达最高阶越高，且权重分布整体向高阶偏移（gamma 随危险度增大），
 * 所以高难副本里遇到的词缀阶级明显更狠；运势 luckBias 进一步放大高阶权重。
 */
export function rollTier(rng: RNG, dangerLevel: number, luckBias = 0): number {
  const maxTier = Math.max(0, Math.min(AFFIX_TIERS.length - 1, Math.round(dangerLevel)));
  const gamma = 0.15 + 0.18 * Math.max(0, dangerLevel) + luckBias;
  const candidates: { value: number; weight: number }[] = [];
  for (let t = 0; t <= maxTier; t++) {
    const base = AFFIX_TIERS[t].weight;
    const weight = base * (1 + gamma * t);
    candidates.push({ value: t, weight });
  }
  return weightedPick(rng, candidates);
}

function scaleModifiers(
  mods: Partial<Attributes> | undefined,
  mag: number,
): Partial<Attributes> | undefined {
  if (!mods) return undefined;
  const out: Partial<Attributes> = {};
  for (const k of Object.keys(mods) as (keyof Attributes)[]) {
    out[k] = Math.round((mods[k] ?? 0) * mag);
  }
  return out;
}

function scaleCombat(
  c: SurvivalAffix['combat'],
  mag: number,
): AppliedAffix['combat'] | undefined {
  if (!c) return undefined;
  const out: NonNullable<AppliedAffix['combat']> = {};
  if (c.hpBonus) out.hpBonus = Math.round(c.hpBonus * mag);
  if (c.critBonus) out.critBonus = Number((c.critBonus * mag).toFixed(3));
  if (c.lootLuck) out.lootLuck = Number((c.lootLuck * mag).toFixed(3));
  if (c.xpBonus) out.xpBonus = Number((c.xpBonus * mag).toFixed(3));
  if (c.coinBonus) out.coinBonus = Number((c.coinBonus * mag).toFixed(3));
  return Object.keys(out).length ? out : undefined;
}

function instantiate(def: SurvivalAffix, tier: number): AppliedAffix {
  const t = tierByTier(tier);
  const mag = t.affixMag;
  const modifiers = scaleModifiers(def.modifiers, mag);
  const combat = scaleCombat(def.combat, mag);
  // 按出现顺序收集展示数值：属性增量(整数) → 战斗增益(生命值整数/百分比类取整百分数)
  const displayValues: number[] = [];
  if (modifiers) {
    for (const k of Object.keys(modifiers) as (keyof Attributes)[]) {
      displayValues.push(modifiers[k] ?? 0);
    }
  }
  if (combat) {
    if (combat.hpBonus != null) displayValues.push(combat.hpBonus);
    if (combat.critBonus != null) displayValues.push(Math.round(combat.critBonus * 100));
    if (combat.lootLuck != null) displayValues.push(Math.round(combat.lootLuck * 100));
    if (combat.xpBonus != null) displayValues.push(Math.round(combat.xpBonus * 100));
    if (combat.coinBonus != null) displayValues.push(Math.round(combat.coinBonus * 100));
  }
  let text = def.desc;
  for (const v of displayValues) {
    text = text.replace('{n}', String(v));
  }
  return {
    id: def.id,
    name: def.name,
    tier,
    tierKey: t.key,
    color: t.color,
    label: `${def.name}${t.suffix}`,
    text,
    modifiers,
    combat,
  };
}

/**
 * 抽 N 条敌人词缀。N 与阶级都随副本危险度提升：
 * 危险度越高 → 词缀越多、单条阶级越高 → 敌人越凶。
 */
export function rollEnemyAffixes(rng: RNG, dangerLevel: number): AppliedAffix[] {
  const count = Math.min(4, 1 + Math.floor(dangerLevel / 2));
  const out: AppliedAffix[] = [];
  for (let i = 0; i < count; i++) {
    const tier = rollTier(rng, dangerLevel, 0.15);
    const pool = ENEMY_AFFIXES.filter((a) => (a.minTier ?? 0) <= tier);
    const def = weightedPick(
      rng,
      pool.map((a) => ({ value: a, weight: a.weight })),
    );
    out.push(instantiate(def, tier));
  }
  return out;
}

/** 把敌人词缀聚合成「属性增量 + 战斗加成」，供 buildEnemyUnit 应用。 */
export function aggregateEnemyAffixes(
  affixes: AppliedAffix[],
): { attributes: Partial<Attributes>; hpBonus: number; critBonus: number } {
  const attributes: Partial<Attributes> = {};
  let hpBonus = 0;
  let critBonus = 0;
  for (const a of affixes) {
    if (a.modifiers) {
      for (const k of Object.keys(a.modifiers) as (keyof Attributes)[]) {
        attributes[k] = (attributes[k] ?? 0) + (a.modifiers[k] ?? 0);
      }
    }
    if (a.combat) {
      hpBonus += a.combat.hpBonus ?? 0;
      critBonus += a.combat.critBonus ?? 0;
    }
  }
  return { attributes, hpBonus, critBonus };
}

/**
 * 随机掉落一件装备（带阶级词条）。阶级随副本危险度提升。
 * v1.0.2：
 *  - 掉落槽位覆盖全部 6 个主槽（武器/护甲权重更高，头部/腿部/副武器/饰品不再缺席）；
 *  - 词条只加特殊属性（生命/暴击/搜刮/经验/金币），六维 = 槽位基础属性（灰字，随阶级小幅成长）；
 *  - 白阶通常 1 条词条，高阶有概率多条更高数值；低阶保留小概率多词条；
 *  - minTier：保底品阶（Boss 掉落用，保证比同地图小怪高一截）。
 * 返回可直接放进 carriedLoot 的 LootItem（gear 字段携带完整 GearItem）。
 */
export function rollGearDrop(
  rng: RNG,
  dangerLevel: number,
  luckBias = 0.1,
  minTier = 0,
  boss = false,
  mirage = false,
): LootItemGear {
  // v1.0.10：改为查表（危1~危7 的小怪 / 霸主品质权重），保底品阶仍可叠加
  // mirage=true 时走蜃景密室专属表，不影响其他副本 / 搜刮 / 霸主掉落
  const tier = Math.max(
    rollGearTier(rng, dangerLevel, boss, luckBias, mirage),
    Math.max(0, Math.min(6, minTier)),
  );
  const t = tierByTier(tier);
  // 全 6 槽位加权：武器/护甲是核心输出与减伤位，权重更高；其余四槽均分剩余权重
  const slot = weightedPick(rng, [
    { value: 'weapon' as GearSlot, weight: 24 },
    { value: 'armor' as GearSlot, weight: 22 },
    { value: 'offWeapon' as GearSlot, weight: 14 },
    { value: 'head' as GearSlot, weight: 14 },
    { value: 'legs' as GearSlot, weight: 13 },
    { value: 'accessory' as GearSlot, weight: 13 },
  ]);
  // 词条数量：低阶通常 1 条（6% 出 2 条），阶级越高多词条概率越高（最多 3 条）
  const extraChance = tier >= 4 ? 0.75 : tier >= 2 ? 0.45 : tier >= 1 ? 0.15 : 0.06;
  let affixCount = 1;
  if (rng() < extraChance) affixCount++;
  if (affixCount === 2 && rng() < extraChance * 0.5) affixCount++;

  const pool = GEAR_AFFIXES.filter((a) => (a.minTier ?? 0) <= tier);
  const chosen = pickN(rng, pool, affixCount);

  // 灰字：槽位基础属性，随装备阶级小幅成长（白 +0% → 红 +120%）
  const baseScale = 1 + 0.2 * tier;
  const modifiers: Partial<Attributes> = {};
  for (const k of Object.keys(GEAR_SLOT_BASE[slot]) as (keyof Attributes)[]) {
    modifiers[k] = Math.round((GEAR_SLOT_BASE[slot][k] ?? 0) * baseScale);
  }
  const combat: NonNullable<AppliedAffix['combat']> = {};
  const affixInstances: AppliedAffix[] = [];
  const affixStrings: string[] = [];

  for (const def of chosen) {
    const inst = instantiate(def, tier);
    affixInstances.push(inst);
    affixStrings.push(inst.text);
    if (inst.combat) {
      combat.hpBonus = (combat.hpBonus ?? 0) + (inst.combat.hpBonus ?? 0);
      combat.critBonus = Number(((combat.critBonus ?? 0) + (inst.combat.critBonus ?? 0)).toFixed(3));
      combat.lootLuck = Number(((combat.lootLuck ?? 0) + (inst.combat.lootLuck ?? 0)).toFixed(3));
      combat.xpBonus = Number(((combat.xpBonus ?? 0) + (inst.combat.xpBonus ?? 0)).toFixed(3));
      combat.coinBonus = Number(((combat.coinBonus ?? 0) + (inst.combat.coinBonus ?? 0)).toFixed(3));
    }
  }

  const gear: GearItem = {
    id: `drop-${Date.now().toString(36)}-${Math.floor(rng() * 1e6).toString(36)}`,
    name: buildGearName(tier, slot),
    slot,
    rarity: gearTierName(tier),
    modifiers,
    affixes: affixStrings,
    combat: Object.keys(combat).length ? combat : undefined,
    value: gearBaseValue(tier, affixInstances.length),
    tier,
    tierColor: t.color,
    rarityName: gearTierName(tier),
  };

  return {
    id: `loot-${gear.id}`,
    name: gear.name,
    kind: 'gear',
    value: gear.value,
    tier,
    rarityName: gearTierName(tier),
    gear,
    affixes: affixInstances,
  };
}

/** rollGearDrop 的返回类型（LootItem 在 extraction/types 中定义，这里用结构化等价） */
export interface LootItemGear {
  id: string;
  name: string;
  kind: 'gear';
  value: number;
  tier: number;
  rarityName: string;
  gear: GearItem;
  affixes: AppliedAffix[];
}

/**
 * 按指定阶级重铸一件已有装备（保留 id 与槽位）。
 * 用于「装备改装」：重随机灰字基础属性与同阶级词缀；若 tier 比之前高，则按新阶级生成。
 */
export function rebuildGearAtTier(
  rng: RNG,
  gear: GearItem,
  tier: number,
): GearItem {
  const slot = gear.slot;
  const t = tierByTier(tier);

  // 词条数量：与 rollGearDrop 保持一致（低阶通常 1 条，高阶概率多条，最多 3 条）
  const extraChance = tier >= 4 ? 0.75 : tier >= 2 ? 0.45 : tier >= 1 ? 0.15 : 0.06;
  let affixCount = 1;
  if (rng() < extraChance) affixCount++;
  if (affixCount === 2 && rng() < extraChance * 0.5) affixCount++;

  const pool = GEAR_AFFIXES.filter((a) => (a.minTier ?? 0) <= tier);
  const chosen = pickN(rng, pool, affixCount);

  // 灰字：槽位基础属性，随装备阶级小幅成长（白 +0% → 红 +120%）
  const baseScale = 1 + 0.2 * tier;
  const modifiers: Partial<Attributes> = {};
  for (const k of Object.keys(GEAR_SLOT_BASE[slot]) as (keyof Attributes)[]) {
    modifiers[k] = Math.round((GEAR_SLOT_BASE[slot][k] ?? 0) * baseScale);
  }

  const combat: NonNullable<AppliedAffix['combat']> = {};
  const affixStrings: string[] = [];

  for (const def of chosen) {
    const inst = instantiate(def, tier);
    affixStrings.push(inst.text);
    if (inst.combat) {
      combat.hpBonus = (combat.hpBonus ?? 0) + (inst.combat.hpBonus ?? 0);
      combat.critBonus = Number(((combat.critBonus ?? 0) + (inst.combat.critBonus ?? 0)).toFixed(3));
      combat.lootLuck = Number(((combat.lootLuck ?? 0) + (inst.combat.lootLuck ?? 0)).toFixed(3));
      combat.xpBonus = Number(((combat.xpBonus ?? 0) + (inst.combat.xpBonus ?? 0)).toFixed(3));
      combat.coinBonus = Number(((combat.coinBonus ?? 0) + (inst.combat.coinBonus ?? 0)).toFixed(3));
    }
  }

  return {
    ...gear,
    tier,
    name: buildGearName(tier, slot),
    rarity: gearTierName(tier),
    rarityName: gearTierName(tier),
    tierColor: t.color,
    modifiers,
    affixes: affixStrings,
    combat: Object.keys(combat).length ? combat : undefined,
    value: gearBaseValue(tier, affixStrings.length),
  };
}
