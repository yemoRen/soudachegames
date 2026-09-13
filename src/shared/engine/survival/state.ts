/*
 * state.ts — 持久化游戏状态：花名册 / 背包 / 装备 / 货币 / 避难所 / 势力。
 *
 * 纯函数 mutators（不可变更新），UI 层可丢进 React state。
 * 与 extraction 引擎解耦：bankLoot 把入库战利品折算成材料 + 废土币。
 */
import type { Attributes } from '@shared/types/cultivator';
import type { LootItem, CombatBonus } from '@shared/engine/extraction';
import {
  generateSurvivor,
  aggregateTraitCombat,
  makeProtagonist,
  computePower,
  tierFromPower,
  tierNameFromTier,
  GEN_TIERS,
  rollTraitCandidates,
  ALL_ATTR_KEYS,
  ensureBaseAttributes,
  type SurvivorProfile,
} from './chargen';
import {
  type GearItem,
  type MaterialItem,
  type MaterialKind,
  type CraftRecipe,
  type GearSlot,
  RECIPES,
  SHELTER_FACILITIES,
  FACTIONS,
  computeShelterBonuses,
  materialCount,
  rollGear,
  MATERIAL_LABEL,
} from './economy';
import { rebuildGearAtTier, gearBaseValue } from './affixes';
import { type RNG, randInt, emptyAttributes, weightedPick } from './rng';
import {
  type MainSlotKey,
  type QuickSlotKey,
  type ThrowableId,
  gearDropChance,
  RAID_PACK_CAPACITY,
} from './equipment';
import type { Injury, SurvivorStatus } from './recovery';
import { type SurvivorTrait } from './chargen';
import {
  freshStatus,
  recoverAll as recoverAllImpl,
  applyMedicine,
  treatInjury as treatInjuryImpl,
  applyPostSortie as applyPostSortieImpl,
  applyNearDeath as applyNearDeathImpl,
  deriveMaxHp,
  MED_DURATION_MIN,
} from './recovery';

export interface EquipSlots {
  weapon?: string; // 主武器（右手）
  offWeapon?: string; // 副武器（左手）
  head?: string; // 头部
  armor?: string; // 躯干护甲
  legs?: string; // 腿部
  accessory?: string; // 饰品 / 战术挂件
  quickMed?: string; // 快捷·医疗
  quickThrow?: string; // 快捷·投掷物
  quickBuff?: string; // 快捷·增益补给
}

// ===== 菜园系统（持久化到存档，切页不丢） =====

export interface GardenPlot {
  /** 已种作物 id；null 表示空地 */
  cropId: string | null;
  /** 种植时间戳（epoch ms）；null 表示未种 */
  plantedAt: number | null;
  /** 预计成熟时间戳（epoch ms）；null 表示未种 */
  readyAt: number | null;
}

export interface GardenCrop {
  id: string;
  name: string;
  /** 收成产出的药品 id；null 表示售出换废土币 */
  yields: string | null;
  qty: number;
  /** 售出作物的废土币收益（yields 为 null 时生效） */
  coins?: number;
  minutes: number;
  icon: string;
  /**
   * 种子单价（废土币）。v1.1.0：种植必须先有种子。
   * 硬约束：seedPrice 必须 < 产物价值（gardenCropValue），否则种植毫无意义。
   */
  seedPrice: number;
}

/** 基础 6 块地，每块地可任选一种作物种植 */
export const GARDEN_PLOT_COUNT = 6;

/**
 * 作物表。seedPrice 为固定种子成本。
 * v1.1.8：产物市价（医疗品 costCoins）已上调至 2 倍，但 seedPrice 未同步上调，
 * 故每季单位利润相应提高；种子价仍恒低于产物价值，种植始终划算。
 *  草药 7/30 · 变异菌 12/50 · 兴奋草 22/80 · 高能作物 33/120
 *  血清藤 38/140 · 纳米菇 70/240 · 口粮 16/30（口粮非医疗品，市价 30 不变）
 */
export const GARDEN_CROPS: GardenCrop[] = [
  { id: 'herb', name: '草药', yields: 'bandage', qty: 1, minutes: 6, icon: '🌿', seedPrice: 7 },
  { id: 'mush', name: '变异菌', yields: 'antibiotic', qty: 1, minutes: 12, icon: '🍄', seedPrice: 12 },
  { id: 'nutr', name: '高能作物', yields: 'medkit', qty: 1, minutes: 25, icon: '🌾', seedPrice: 33 },
  { id: 'exg', name: '兴奋草', yields: 'stim', qty: 1, minutes: 14, icon: '⚡', seedPrice: 22 },
  { id: 'sera', name: '血清藤', yields: 'serum', qty: 1, minutes: 20, icon: '🩸', seedPrice: 38 },
  { id: 'nano', name: '纳米菇', yields: 'nanogel', qty: 1, minutes: 35, icon: '🧬', seedPrice: 70 },
  { id: 'feed', name: '口粮作物', yields: null, coins: 30, qty: 1, minutes: 8, icon: '🥫', seedPrice: 16 },
];

/** 开局赠送 / 旧存档迁移发放的初始种子 */
export const START_SEEDS: Record<string, number> = { herb: 3, feed: 2 };

/** 作物产物的折算价值（医疗品按市价 costCoins，口粮按售币） */
export function gardenCropValue(crop: GardenCrop): number {
  if (crop.yields) return MEDICINES.find((m) => m.id === crop.yields)?.costCoins ?? 0;
  return crop.coins ?? 0;
}

/** 单季净利润 = 产物价值 − 种子价（恒 > 0） */
export function gardenCropProfit(crop: GardenCrop): number {
  return gardenCropValue(crop) - crop.seedPrice;
}

/** 某种作物的种子库存 */
export function seedStock(state: SurvivalGameState, cropId: string): number {
  return state.seeds?.[cropId] ?? 0;
}

/** 购买种子：扣废土币、入种子库存；币不足或数量非法则原样返回 */
export function buySeeds(
  state: SurvivalGameState,
  cropId: string,
  qty: number,
): SurvivalGameState {
  const crop = GARDEN_CROPS.find((c) => c.id === cropId);
  const q = Math.floor(qty);
  if (!crop || q <= 0) return state;
  const total = crop.seedPrice * q;
  if (state.coins < total) return state;
  return {
    ...state,
    coins: state.coins - total,
    seeds: { ...(state.seeds ?? {}), [cropId]: (state.seeds?.[cropId] ?? 0) + q },
    log: [
      `【菜园】购买 ${crop.name}种子×${q}，花费 ${total} 废土币。`,
      ...state.log,
    ].slice(0, 50),
  };
}

export function emptyGardenPlots(): GardenPlot[] {
  return Array.from({ length: GARDEN_PLOT_COUNT }, () => ({ cropId: null, plantedAt: null, readyAt: null }));
}

/** 菜园收成时间随等级缩短：每级 -10%（下限 30%） */
export function gardenCropDurationMs(crop: GardenCrop, gardenLevel: number): number {
  const factor = Math.max(0.3, 1 - 0.1 * gardenLevel);
  return Math.round(crop.minutes * 60_000 * factor);
}

/** 种植：在指定地块种下作物（若该地块已种则忽略） */
export function plantGardenCrop(
  state: SurvivalGameState,
  plotIndex: number,
  cropId: string,
  now: number = Date.now(),
): SurvivalGameState {
  const crop = GARDEN_CROPS.find((c) => c.id === cropId);
  const plots = state.gardenPlots ?? emptyGardenPlots();
  if (!crop || plotIndex < 0 || plotIndex >= plots.length) return state;
  if (plots[plotIndex].cropId) return state; // 已种，不改
  // v1.1.0：种植消耗 1 颗种子，没有种子则无法种植
  const stock = seedStock(state, cropId);
  if (stock <= 0) return state;
  const next = plots.slice();
  next[plotIndex] = { cropId, plantedAt: now, readyAt: now + gardenCropDurationMs(crop, state.facilities['garden'] ?? 0) };
  return {
    ...state,
    gardenPlots: next,
    seeds: { ...(state.seeds ?? {}), [cropId]: stock - 1 },
    log: [
      `【菜园】第 ${plotIndex + 1} 块地种下 ${crop.name}（种子 -1，余 ${stock - 1}）。`,
      ...state.log,
    ].slice(0, 50),
  };
}

/** 收获：成熟的地块结算产出并清空；未成熟或无作物返回原状态 */
export function harvestGardenPlot(
  state: SurvivalGameState,
  plotIndex: number,
  now: number = Date.now(),
): SurvivalGameState {
  const plots = state.gardenPlots ?? emptyGardenPlots();
  if (plotIndex < 0 || plotIndex >= plots.length) return state;
  const plot = plots[plotIndex];
  if (!plot.cropId || !plot.readyAt || now < plot.readyAt) return state;
  const crop = GARDEN_CROPS.find((c) => c.id === plot.cropId);
  if (!crop) return state;
  const next = plots.slice();
  next[plotIndex] = { cropId: null, plantedAt: null, readyAt: null };
  const ns: SurvivalGameState = { ...state, gardenPlots: next };
  if (crop.yields) {
    ns.medicines = { ...ns.medicines, [crop.yields]: (ns.medicines[crop.yields] ?? 0) + crop.qty };
    ns.log = [`【菜园】收获 ${crop.name}×${crop.qty}。`, ...ns.log].slice(0, 50);
  } else {
    ns.coins += crop.coins ?? 0;
    ns.log = [`【菜园】出售 ${crop.name} 得 ${crop.coins} 废土币。`, ...ns.log].slice(0, 50);
  }
  return ns;
}

/** 铲除：清空某地块（未收获也可清除重种） */
export function clearGardenPlot(state: SurvivalGameState, plotIndex: number): SurvivalGameState {
  const plots = state.gardenPlots ?? emptyGardenPlots();
  if (plotIndex < 0 || plotIndex >= plots.length) return state;
  const next = plots.slice();
  next[plotIndex] = { cropId: null, plantedAt: null, readyAt: null };
  return { ...state, gardenPlots: next };
}

export interface SurvivalGameState {
  version: number;
  createdAt: string;
  survivors: SurvivorProfile[];
  activeSurvivorId: string | null;
  survivorStatus: Record<string, SurvivorStatus>;
  materials: MaterialItem[];
  gear: GearItem[];
  equipped: Record<string, EquipSlots>;
  medicines: Record<string, number>;
  /** 投掷物库存（快捷·投掷槽的来源），可选字段以兼容旧存档 */
  throwables?: Record<string, number>;
  coins: number;
  facilities: Record<string, number>;
  factionRep: Record<string, number>;
  /** 菜园地块（基础 6 块，每块可种一种作物，种植状态持久化） */
  gardenPlots?: GardenPlot[];
  /** 种子库存：作物 id → 数量（v1.1.0，种植需先消耗种子） */
  seeds?: Record<string, number>;
  recruits: SurvivorProfile[];
  sortieHistory: SortieLog[];
  log: string[];
  // === 任选扩展字段（兑换码记录、世界种子、Mirage 解锁等） ===
  claimedQuests?: string[];
  worldSeed?: number;
  mirageUnlocked?: boolean;
  premiumCoins?: number;
  redeemedCodes?: string[];
  /** 玩家注册代号；重置存档后用于重生同名主角（可选，兼容旧存档） */
  playerCodename?: string;
  // ===== v1.1.0：行动点系统 =====
  /** 当前行动点（出击消耗，随时间恢复）；缺省视为满点 */
  actionPoints?: number;
  /** 行动点上次结算时刻（ms），用于离线/实时恢复计算 */
  actionPointsAt?: number;
  /** 漫游搜打撤最近 10 条记录（v1.1.0：写入存档，不再只存组件内存） */
  wanderLog?: string[];
  /** 末世赌局进行中的状态（v1.1.9：切出菜单后保留） */
  wager?: import('./wager').WagerState;
  /** 拍卖行进行中的状态（v1.1.9：本地单用户拍卖，30 分钟自动刷新） */
  auction?: import('./auction').AuctionState;
}

export interface SortieLog {
  id: string;
  at: string;
  survivorName: string;
  zoneName: string;
  outcome: 'success' | 'death' | 'timeout';
  bankedValue: number;
  bankedItems: number;
  enemyFaced?: string;
  rescued?: boolean;
}

const SAVE_VERSION = 1;
const START_COINS = 120;
const START_MEDICINES = { bandage: 3, antibiotic: 2, medkit: 1, stim: 1, nutrient: 1, serum: 1, nanogel: 0 };

/** 战团成员上限（含主角） */
export const WARBAND_CAP = 10;

// ===== 行动点系统（v1.1.0） =====
/** 行动点上限（初始即满点） */
export const ACTION_POINT_CAP = 120;
/** 每恢复 1 点行动点所需时间（5 分钟） */
export const ACTION_POINT_REGEN_MS = 5 * 60 * 1000;
/** 「重塑六维」费用（废土币） */
export const REROLL_ATTR_COST = 500;
/** v1.1.3（攒）：重洗已掌握词条的费用 */
export const REROLL_TRAIT_COST = 1000;

/** 出击一次的消耗：危1 = 6 点 … 危7 = 12 点（每级 +1） */
export function sortieActionPointCost(dangerLevel: number): number {
  const d = Math.max(1, Math.min(7, Math.floor(dangerLevel) || 1));
  return 5 + d;
}

/**
 * 副本等级门槛（v1.0.12 引入，原仅 UI 局部常量，现提升到引擎层）：
 * 危险度 → 进入所需最低等级。手动出击与漫游搜打撤共用，避免「1 级角色被随机扔到危7」。
 * 危1 不限 → 危7 需 Lv15。
 */
export const DANGER_LEVEL_REQ: Record<number, number> = {
  1: 1,
  2: 3,
  3: 5,
  4: 8,
  5: 10,
  6: 12,
  7: 15,
};

/** 出击者等级是否满足某危险度副本的进入门槛 */
export function meetsDangerLevelReq(level: number, dangerLevel: number): boolean {
  return (level ?? 1) >= (DANGER_LEVEL_REQ[dangerLevel] ?? 1);
}

/** 按时间恢复行动点（纯函数，可安全重复调用）；已满时只推进结算时刻 */
export function tickActionPoints(
  state: SurvivalGameState,
  now: number = Date.now(),
): SurvivalGameState {
  const cur = state.actionPoints ?? ACTION_POINT_CAP;
  if (cur >= ACTION_POINT_CAP) {
    if (state.actionPoints === ACTION_POINT_CAP && typeof state.actionPointsAt === 'number') return state;
    return { ...state, actionPoints: ACTION_POINT_CAP, actionPointsAt: now };
  }
  const at = typeof state.actionPointsAt === 'number' ? state.actionPointsAt : now;
  const elapsed = Math.max(0, now - at);
  const gain = Math.floor(elapsed / ACTION_POINT_REGEN_MS);
  if (gain <= 0) return state;
  const next = Math.min(ACTION_POINT_CAP, cur + gain);
  const carry = elapsed - gain * ACTION_POINT_REGEN_MS;
  return {
    ...state,
    actionPoints: next,
    actionPointsAt: next >= ACTION_POINT_CAP ? now : now - carry,
  };
}

/** 行动点展示信息（当前值 / 上限 / 距下一点的剩余毫秒） */
export function actionPointView(
  state: SurvivalGameState,
  now: number = Date.now(),
): { current: number; cap: number; full: boolean; remainMs: number } {
  const ticked = tickActionPoints(state, now);
  const current = ticked.actionPoints ?? ACTION_POINT_CAP;
  if (current >= ACTION_POINT_CAP) {
    return { current: ACTION_POINT_CAP, cap: ACTION_POINT_CAP, full: true, remainMs: 0 };
  }
  const at = typeof ticked.actionPointsAt === 'number' ? ticked.actionPointsAt : now;
  const elapsed = Math.max(0, now - at);
  return {
    current,
    cap: ACTION_POINT_CAP,
    full: false,
    remainMs: Math.max(0, ACTION_POINT_REGEN_MS - (elapsed % ACTION_POINT_REGEN_MS)),
  };
}

/** 尝试扣除行动点：足够则返回新状态，不足返回 null（调用方据此拦截） */
export function trySpendActionPoints(
  state: SurvivalGameState,
  cost: number,
  now: number = Date.now(),
): SurvivalGameState | null {
  const ticked = tickActionPoints(state, now);
  const cur = ticked.actionPoints ?? ACTION_POINT_CAP;
  if (cur < cost) return null;
  const next = cur - cost;
  return {
    ...ticked,
    actionPoints: next,
    actionPointsAt:
      next >= ACTION_POINT_CAP ? now : ticked.actionPointsAt ?? now,
  };
}

function emptyFacilities(): Record<string, number> {
  const o: Record<string, number> = {};
  for (const f of SHELTER_FACILITIES) o[f.id] = 0;
  return o;
}
function emptyFactionRep(): Record<string, number> {
  const o: Record<string, number> = {};
  for (const f of FACTIONS) o[f.id] = 0;
  return o;
}

function seedMaterials(): MaterialItem[] {
  const kit: { kind: MaterialKind; name: string; qty: number }[] = [
    { kind: 'metal', name: '废金属', qty: 4 },
    { kind: 'electronics', name: '电路板', qty: 2 },
    { kind: 'chems', name: '医用试剂', qty: 2 },
    { kind: 'food', name: '压缩口粮', qty: 3 },
  ];
  return kit.map((k, i) => ({
    id: `mat-seed-${i}`,
    name: k.name,
    kind: k.kind,
    value: 5,
    quantity: k.qty,
  }));
}

export function newGame(): SurvivalGameState {
  const now = Date.now();
  // 注意：newGame 只建立「空避难所」，不预置任何成员。
  // 初创战团由 createProtagonistGame 以玩家注册代号命名的主角填充。
  return {
    version: SAVE_VERSION,
    createdAt: new Date(now).toISOString(),
    survivors: [],
    activeSurvivorId: null,
    survivorStatus: {},
    materials: seedMaterials(),
    gear: [],
    equipped: {},
    medicines: { ...START_MEDICINES },
    throwables: { grenade: 1, smoke: 0, flash: 0 },
    coins: START_COINS,
    facilities: emptyFacilities(),
    factionRep: emptyFactionRep(),
    gardenPlots: emptyGardenPlots(),
    seeds: { ...START_SEEDS },
    recruits: [],
    sortieHistory: [],
    log: ['【系统】避难所已建立，开始末世求生。'],
    playerCodename: '',
    // v1.1.0：行动点初始满点
    actionPoints: ACTION_POINT_CAP,
    actionPointsAt: now,
    wanderLog: [],
  };
}

export function activeSurvivor(state: SurvivalGameState): SurvivorProfile | null {
  return state.survivors.find((s) => s.id === state.activeSurvivorId) ?? null;
}

/**
 * 注册代号时创建的首发存档：仅含一名以玩家代号命名的主角，属性均衡固定。
 * 其余避难所/物资等沿用 newGame 的初始化。
 */
export function createProtagonistGame(name: string, now: number = Date.now()): SurvivalGameState {
  const base = newGame();
  const hero = makeProtagonist(name);
  const status: Record<string, SurvivorStatus> = {
    [hero.id]: freshStatus(hero, now),
  };
  return {
    ...base,
    survivors: [hero],
    activeSurvivorId: hero.id,
    survivorStatus: status,
    playerCodename: name,
    log: [`【系统】代号「${name}」已在避难所登记，开启末世求生。`, ...base.log].slice(0, 50),
  };
}

export function getGear(state: SurvivalGameState, id: string): GearItem | undefined {
  return state.gear.find((g) => g.id === id);
}

/** 普通招募最低门槛（实际招募费按生成段位付费，见 recruitSurvivor） */
export function recruitCost(state: SurvivalGameState): number {
  return GEN_TIERS[0].recruitCost;
}

export function canRecruit(state: SurvivalGameState): boolean {
  return state.coins >= recruitCost(state);
}

export function recruitSurvivor(
  state: SurvivalGameState,
  rng: RNG,
): SurvivalGameState {
  // 按余额在「付得起的生成段位（1~5）」内加权抽取，避免抽到付不起的档
  let gt = weightedPick(rng, GEN_TIERS.map((g) => ({ value: g, weight: g.weight })));
  if (state.coins < gt.recruitCost) {
    const affordable = GEN_TIERS.filter((g) => g.recruitCost <= state.coins);
    if (affordable.length === 0) return state;
    gt = weightedPick(rng, affordable.map((g) => ({ value: g, weight: g.weight })));
  }
  const cost = gt.recruitCost;
  if (state.coins < cost) return state;
  const s = generateSurvivor(rng, { genTier: gt.tier });
  return {
    ...state,
    coins: state.coins - cost,
    survivors: [...state.survivors, s],
    log: [`【招募】新幸存者 ${s.name} 加入避难所（${s.tierName}）。`, ...state.log].slice(0, 50),
  };
}

/** 副本掉落的「药剂类」战利品 → 直接进医疗背包（而非折算材料/币）；映射表定义见文件尾部导出 */
/** 副本掉落的「投掷物」战利品 → 进投掷物库存（快捷·投掷槽来源） */
const LOOT_THROWABLE_MAP: Record<string, ThrowableId> = {
  grenade: 'grenade',
  smoke: 'smoke',
  flash: 'flash',
};

/** 入库战利品：折算废土币 + 转为材料进背包；药剂类直接入医疗背包 */
export function bankLoot(
  state: SurvivalGameState,
  banked: LootItem[],
): SurvivalGameState {
  if (banked.length === 0) return state;
  const coins = state.coins;
  const materials = [...state.materials];
  const gear = [...state.gear];
  const medicines = { ...state.medicines };
  const throwables = { ...(state.throwables ?? {}) };
  let gearCount = 0;
  let medCount = 0;
  let throwCount = 0;
  for (const item of banked) {
    const qty = item.qty ?? 1;
    // 装备掉落：入库为可装备库存（带阶级词缀），不折算为材料/币
    if (item.gear) {
      // v1.0.4：防御同 id 装备重复入库（避免装备库出现重复/假显示与勾选串号）
      const droppedGear = item.gear;
      if (!gear.some((x) => x.id === droppedGear.id)) gear.push(droppedGear);
      gearCount += qty;
      continue;
    }
    // 药剂类战利品：直接进医疗背包
    const medId = LOOT_MEDICINE_MAP[item.id];
    if (medId) {
      medicines[medId] = (medicines[medId] ?? 0) + qty;
      medCount += qty;
      continue;
    }
    // 投掷物战利品：进投掷物库存
    const throwId = LOOT_THROWABLE_MAP[item.id];
    if (throwId) {
      throwables[throwId] = (throwables[throwId] ?? 0) + qty;
      throwCount += qty;
      continue;
    }
    // v1.0.4：材料仅入库为背包材料，不再折算为废土币（金额仅由本局搜刮的废土币以 1:1 折算，见 persistRunResult）
    const kind = inferMaterialKind(item.name);
    const existing = materials.find((m) => m.kind === kind && m.name === item.name);
    if (existing) {
      existing.quantity += qty;
      existing.value = Math.max(existing.value, item.value);
    } else {
      materials.push({
        id: `mat-${item.id}`,
        name: item.name,
        kind,
        value: item.value,
        quantity: qty,
      });
    }
  }
  const gearNote = gearCount > 0 ? `，缴获装备 ${gearCount} 件` : '';
  const medNote = medCount > 0 ? `，回收医疗品 ${medCount} 份` : '';
  const throwNote = throwCount > 0 ? `，回收投掷物 ${throwCount} 件` : '';
  const bankedQty = banked.reduce((a, b) => a + (b.qty ?? 1), 0);
  return {
    ...state,
    coins,
    materials,
    gear,
    medicines,
    throwables,
    log: [`【入库】${bankedQty} 件物资入库（废土币由本局携带额单独 1:1 折算，材料/装备/药品仅入库、不折算）${gearNote}${medNote}${throwNote}。`, ...state.log].slice(0, 50),
  };
}

function inferMaterialKind(name: string): MaterialKind {
  if (/药|试剂|血清|针/.test(name)) return 'chems';
  if (/口粮|食物|罐头/.test(name)) return 'food';
  if (/电子|芯片|电路/.test(name)) return 'electronics';
  if (/异变|组织|肉/.test(name)) return 'mutant';
  if (/金属|零件|钢|枪|甲/.test(name)) return 'metal';
  return 'misc';
}

// ===== 装备 =====

export function equipGear(
  state: SurvivalGameState,
  survivorId: string,
  gearId: string,
): SurvivalGameState {
  const gear = getGear(state, gearId);
  if (!gear) return state;
  const current = state.equipped[survivorId] ?? {};
  // 同槽位旧装备若被替换，不会从 gear 列表删除（仍留在背包，可再换）
  const next = { ...current, [gear.slot]: gearId } as EquipSlots;
  // 防止同一件装备同时装备给两个幸存者：从其人处卸下
  const equippedByOthers = Object.entries(state.equipped).filter(
    ([sid, slots]) => sid !== survivorId && Object.values(slots).includes(gearId),
  );
  const equipped = { ...state.equipped, [survivorId]: next };
  for (const [sid] of equippedByOthers) {
    const slots = equipped[sid];
    equipped[sid] = {
      weapon: slots.weapon === gearId ? undefined : slots.weapon,
      offWeapon: slots.offWeapon === gearId ? undefined : slots.offWeapon,
      head: slots.head === gearId ? undefined : slots.head,
      armor: slots.armor === gearId ? undefined : slots.armor,
      legs: slots.legs === gearId ? undefined : slots.legs,
      accessory: slots.accessory === gearId ? undefined : slots.accessory,
    };
  }
  const nextState = { ...state, equipped };
  // v1.0.5 修复 Bug3：佩戴装备后按 六维+词条+装备 重算气血上限并同步角色页
  return recomputeMaxHpIncludingGear(nextState, survivorId);
}

export function unequipGear(
  state: SurvivalGameState,
  survivorId: string,
  slot: GearSlot,
): SurvivalGameState {
  const current = state.equipped[survivorId] ?? {};
  const next = {
    ...state,
    equipped: { ...state.equipped, [survivorId]: { ...current, [slot]: undefined } },
  };
  // v1.0.5 修复 Bug3：卸下装备后重算气血上限并同步角色页
  return recomputeMaxHpIncludingGear(next, survivorId);
}

/** 设置快捷消耗槽：医疗 / 投掷物 / 增益补给 */
export function setQuickSlot(
  state: SurvivalGameState,
  survivorId: string,
  slot: QuickSlotKey,
  itemId: string | undefined,
): SurvivalGameState {
  const current = state.equipped[survivorId] ?? {};
  return {
    ...state,
    equipped: { ...state.equipped, [survivorId]: { ...current, [slot]: itemId } },
  };
}

/** 战局背包容量上限：每次开局清空，撤离成功才入库，失败则全部清零 */
export function raidPackCapacity(): number {
  return RAID_PACK_CAPACITY;
}

/** 持有指定投掷物的数量 */
export function throwableCount(state: SurvivalGameState, id: string): number {
  return state.throwables?.[id] ?? 0;
}

/**
 * 撤离失败 / 阵亡结算：
 *  - 战局背包（carriedLoot）物资全部遗失 —— 由 extraction 引擎处理，不入库；
 *  - 身上常驻穿戴的装备按概率被搜刮者夺走（永久失去）。
 * 饰品（探测/幸运类词条）可显著降低掉落概率。
 */
export function applyFailureGearLoss(
  state: SurvivalGameState,
  survivorId: string,
  rng: RNG,
): { state: SurvivalGameState; lost: GearItem[] } {
  const slots = state.equipped[survivorId] ?? {};
  // 饰品提供的「降低掉落概率」庇护
  const trinket = slots.accessory ? getGear(state, slots.accessory) : undefined;
  const trinketReduce = trinket?.combat?.lootLuck
    ? Math.min(0.2, trinket.combat.lootLuck * 0.5)
    : 0;

  const lost: GearItem[] = [];
  const nextSlots: EquipSlots = { ...slots };
  const mainKeys: MainSlotKey[] = ['weapon', 'offWeapon', 'head', 'armor', 'legs', 'accessory'];
  for (const key of mainKeys) {
    const id = nextSlots[key];
    if (!id) continue;
    const g = getGear(state, id);
    if (!g) continue;
    if (rng() < gearDropChance(g.tier ?? 0, trinketReduce)) {
      lost.push(g);
      nextSlots[key] = undefined;
    }
  }
  if (lost.length === 0) return { state, lost };
  const lostIds = new Set(lost.map((g) => g.id));
  return {
    state: {
      ...state,
      gear: state.gear.filter((g) => !lostIds.has(g.id)),
      equipped: { ...state.equipped, [survivorId]: nextSlots },
      log: [
        `【损失】撤离失败，${lost.length} 件穿戴装备被夺走：${lost.map((g) => g.name).join('、')}。`,
        ...state.log,
      ].slice(0, 50),
    },
    lost,
  };
}

function equippedGearList(state: SurvivalGameState, survivorId: string): GearItem[] {
  const slots = state.equipped[survivorId] ?? {};
  return [
    slots.weapon,
    slots.offWeapon,
    slots.head,
    slots.armor,
    slots.legs,
    slots.accessory,
  ]
    .map((id) => (id ? getGear(state, id) : undefined))
    .filter((g): g is GearItem => !!g);
}

// ===== 制造改装 =====

export function canCraft(state: SurvivalGameState, recipe: CraftRecipe): boolean {
  const discount = computeShelterBonuses(state.facilities, state.factionRep).craftDiscount;
  const costCoins = Math.round(recipe.costCoins * (1 - discount));
  if (state.coins < costCoins) return false;
  for (const need of recipe.costMaterials) {
    if (materialCount(state.materials, need.kind) < need.qty) return false;
  }
  return true;
}

export function craftCost(state: SurvivalGameState, recipe: CraftRecipe) {
  const discount = computeShelterBonuses(state.facilities, state.factionRep).craftDiscount;
  return {
    coins: Math.round(recipe.costCoins * (1 - discount)),
    materials: recipe.costMaterials,
  };
}

export function craftGear(
  state: SurvivalGameState,
  rng: RNG,
  recipeId: string,
): { state: SurvivalGameState; gear?: GearItem } {
  const recipe = RECIPES.find((r) => r.id === recipeId);
  if (!recipe || !canCraft(state, recipe)) return { state };
  const { coins: costCoins } = craftCost(state, recipe);
  // 扣材料
  let materials = [...state.materials];
  for (const need of recipe.costMaterials) {
    let remaining = need.qty;
    for (const m of materials) {
      if (remaining <= 0) break;
      if (m.kind === need.kind) {
        const take = Math.min(m.quantity, remaining);
        m.quantity -= take;
        remaining -= take;
      }
    }
  }
  materials = materials.filter((m) => m.quantity > 0);
  const gear = rollGear(rng, recipe);
  return {
    state: {
      ...state,
      coins: state.coins - costCoins,
      materials,
      gear: [...state.gear, gear],
      log: [`【改装】造出 ${gear.name}（${gear.rarity}）：${gear.affixes.join('、')}。`, ...state.log].slice(0, 50),
    },
    gear,
  };
}

const REFORGE_COST = 500;
const REFORGE_TIER_UP_CHANCE = 0.05;

/**
 * 装备改装：指定出击者已穿戴的某槽位装备，支付 500 废土币后重 roll 词缀。
 * 有 5% 概率装备阶级 +1（最高红阶 6）。原 id、槽位保留，旧词条/灰字/名字/价值按新阶级刷新。
 */
export function reforgeEquippedGear(
  state: SurvivalGameState,
  rng: RNG,
  survivorId: string,
  slot: GearSlot,
): { state: SurvivalGameState; gear?: GearItem; tierUp: boolean } {
  if (state.coins < REFORGE_COST) return { state, tierUp: false };
  const gearId = state.equipped[survivorId]?.[slot];
  if (!gearId) return { state, tierUp: false };

  const index = state.gear.findIndex((g) => g.id === gearId);
  if (index < 0) return { state, tierUp: false };

  const old = state.gear[index];
  const tierUp = rng() < REFORGE_TIER_UP_CHANCE;
  const newTier = Math.min(6, (old.tier ?? 0) + (tierUp ? 1 : 0));
  const gear = rebuildGearAtTier(rng, old, newTier);

  const nextGear = [...state.gear];
  nextGear[index] = gear;

  const log = tierUp
    ? `【改装】${old.name} 阶级提升为 ${gear.name}（${gear.rarityName ?? gear.rarity}）：${gear.affixes.join('、')}。`
    : `【改装】${gear.name} 词条已重 roll：${gear.affixes.join('、')}。`;

  return {
    state: {
      ...state,
      coins: state.coins - REFORGE_COST,
      gear: nextGear,
      log: [log, ...state.log].slice(0, 50),
    },
    gear,
    tierUp,
  };
}

// ===== 避难所设施 =====

export function nextUpgradeCost(state: SurvivalGameState, facilityId: string): number | null {
  const spec = SHELTER_FACILITIES.find((f) => f.id === facilityId);
  if (!spec) return null;
  const lvl = state.facilities[facilityId] ?? 0;
  if (lvl >= spec.maxLevel) return null;
  return spec.upgradeCost[lvl];
}

export function upgradeFacility(
  state: SurvivalGameState,
  facilityId: string,
): SurvivalGameState {
  const cost = nextUpgradeCost(state, facilityId);
  if (cost == null || state.coins < cost) return state;
  const spec = SHELTER_FACILITIES.find((f) => f.id === facilityId)!;
  return {
    ...state,
    coins: state.coins - cost,
    facilities: { ...state.facilities, [facilityId]: (state.facilities[facilityId] ?? 0) + 1 },
    log: [`【建设】${spec.name} 升至 ${state.facilities[facilityId] + 1} 级。`, ...state.log].slice(0, 50),
  };
}

// ===== 势力 / 战团 =====

export function nextFactionCost(state: SurvivalGameState, factionId: string): number | null {
  const rep = state.factionRep[factionId] ?? 0;
  if (rep >= 5) return null;
  return (50 + rep * 30) * 5;
}

export function investFaction(
  state: SurvivalGameState,
  factionId: string,
): SurvivalGameState {
  const cost = nextFactionCost(state, factionId);
  if (cost == null || state.coins < cost) return state;
  const spec = FACTIONS.find((f) => f.id === factionId)!;
  return {
    ...state,
    coins: state.coins - cost,
    factionRep: { ...state.factionRep, [factionId]: (state.factionRep[factionId] ?? 0) + 1 },
    log: [`【势力】与 ${spec.name} 声望提升至 ${state.factionRep[factionId] + 1} 级。`, ...state.log].slice(0, 50),
  };
}

// ===== 出击装配 =====

/**
 * 由存档 + 幸存者推导「出击者」六维属性：
 * 基础属性 + 已装备词缀 + 避难所/势力加成。
 */
export function buildLoadout(
  state: SurvivalGameState,
  survivorId: string,
): { name: string; attributes: Attributes } | null {
  const profile = state.survivors.find((s) => s.id === survivorId);
  if (!profile) return null;
  const bonuses = computeShelterBonuses(state.facilities, state.factionRep);
  const attrs: Attributes = { ...profile.attributes };
  for (const g of equippedGearList(state, survivorId)) {
    for (const k of Object.keys(g.modifiers) as (keyof Attributes)[]) {
      attrs[k] += g.modifiers[k] ?? 0;
    }
  }
  for (const k of Object.keys(bonuses.attrBonus) as (keyof Attributes)[]) {
    attrs[k] += bonuses.attrBonus[k] ?? 0;
  }
  for (const k of Object.keys(bonuses.factionAttrBonus) as (keyof Attributes)[]) {
    attrs[k] += bonuses.factionAttrBonus[k] ?? 0;
  }
  return { name: profile.name, attributes: attrs };
}

// ===== 出击战斗加成聚合（词条 + 装备 + 避难所） =====

/** 已装备装备的战斗词条汇总（v1.0.2：含经验/金币获取加成等特殊词条） */
export function aggregateGearCombat(state: SurvivalGameState, survivorId: string): CombatBonus {
  let hpBonus = 0;
  let critBonus = 0;
  let lootLuck = 0;
  let xpBonus = 0;
  let coinBonus = 0;
  for (const g of equippedGearList(state, survivorId)) {
    const c = g.combat;
    if (!c) continue;
    hpBonus += c.hpBonus ?? 0;
    critBonus += c.critBonus ?? 0;
    lootLuck += c.lootLuck ?? 0;
    xpBonus += c.xpBonus ?? 0;
    coinBonus += c.coinBonus ?? 0;
  }
  return { hpBonus, critBonus, lootLuck, startHpRatio: 0, xpBonus, coinBonus };
}

/**
 * 推导「完整出击单元」：档案 + 已结算属性 + 战斗加成。
 * 供搜打撤引擎走 createCombatUnitFromCultivator 正式链路（装备/词条进入 battle-v5）。
 */
export function buildSortieLoadout(
  state: SurvivalGameState,
  survivorId: string,
): { name: string; attributes: Attributes; profile: SurvivorProfile; bonus: CombatBonus } | null {
  const profile = state.survivors.find((s) => s.id === survivorId);
  if (!profile) return null;
  const loadout = buildLoadout(state, survivorId);
  if (!loadout) return null;
  const traitC = aggregateTraitCombat(profile.traits);
  const gearC = aggregateGearCombat(state, survivorId);
  const bonuses = computeShelterBonuses(state.facilities, state.factionRep);
  const bonus: CombatBonus = {
    hpBonus: traitC.hpBonus + gearC.hpBonus,
    critBonus: traitC.critBonus + gearC.critBonus,
    lootLuck: traitC.lootLuck + gearC.lootLuck + bonuses.lootLuck,
    startHpRatio: traitC.startHpRatio,
    xpBonus: gearC.xpBonus,
    coinBonus: gearC.coinBonus,
  };
  return { name: profile.name, attributes: loadout.attributes, profile, bonus };
}

/**
 * 推导「擂台切磋单元」：仅用角色自身六维 + 已装备装备属性，
 * 刻意排除避难所/势力（基地页）提供的各种属性 buff（驻防全属性加成、势力声望、搜刮运势等）。
 * 即「角色页面所展示的属性」= 档案六维（基础+词条+加点）+ 装备词条/战斗加成，不与基地联动。
 */
export function buildArenaLoadout(
  state: SurvivalGameState,
  survivorId: string,
): { name: string; attributes: Attributes; profile: SurvivorProfile; bonus: CombatBonus } | null {
  const profile = state.survivors.find((s) => s.id === survivorId);
  if (!profile) return null;
  // 六维 = 档案属性（基础+词条+加点，已并入 profile.attributes）+ 已装备装备六维词条；
  // 注意：不叠加 computeShelterBonuses 的 attrBonus / factionAttrBonus（基地页 buff）。
  const attrs: Attributes = { ...profile.attributes };
  for (const g of equippedGearList(state, survivorId)) {
    for (const k of Object.keys(g.modifiers) as (keyof Attributes)[]) {
      attrs[k] += g.modifiers[k] ?? 0;
    }
  }
  // 战斗加成 = 词条 + 装备（不含避难所/势力）；搜刮运势不取基地部分。
  const traitC = aggregateTraitCombat(profile.traits);
  const gearC = aggregateGearCombat(state, survivorId);
  const bonus: CombatBonus = {
    hpBonus: traitC.hpBonus + gearC.hpBonus,
    critBonus: traitC.critBonus + gearC.critBonus,
    lootLuck: traitC.lootLuck + gearC.lootLuck,
    startHpRatio: traitC.startHpRatio,
    xpBonus: gearC.xpBonus,
    coinBonus: gearC.coinBonus,
  };
  return { name: profile.name, attributes: attrs, profile, bonus };
}

export { computeShelterBonuses, MATERIAL_LABEL, RECIPES, SHELTER_FACILITIES, FACTIONS };

// ===== 医疗消耗品 =====

export type MedicineId = 'bandage' | 'antibiotic' | 'medkit' | 'stim' | 'nutrient' | 'serum' | 'nanogel' | 'splint';

export interface MedicineSpec {
  id: MedicineId;
  name: string;
  /** 立即回复「最大生命值」的百分比（0~1），随角色血量放大 */
  healPct: number;
  /** 立即回复的固定生命值 */
  healFlat: number;
  /** 治疗伤势的效果（清除指定伤势） */
  treats?: Injury[];
  costCoins: number;
  description: string;
}

export const MEDICINES: MedicineSpec[] = [
  // v1.1.8：医疗品单价统一翻倍
  { id: 'bandage', name: '止血绷带', healPct: 0.12, healFlat: 20, costCoins: 30, description: '立即回复 12% 生命 + 20 点，无伤势治疗。' },
  { id: 'antibiotic', name: '抗生素', healPct: 0.10, healFlat: 16, treats: ['infection'], costCoins: 50, description: '立即回复 10% 生命 + 16 点，清除感染。' },
  { id: 'medkit', name: '急救箱', healPct: 0.30, healFlat: 60, treats: ['bleeding', 'shellShock'], costCoins: 120, description: '立即回复 30% 生命 + 60 点，清除失血/震伤。' },
  // —— 新增恢复道具 ——（v1.1.7：肾上腺素改为纯增益补给，不再回血/消疲惫；营养剂仍可消除「疲惫」）
  { id: 'stim', name: '肾上腺素', healPct: 0, healFlat: 0, costCoins: 80, description: '增益补给，副本时间 10 分钟内六维全属性 +5。' },
  { id: 'nutrient', name: '营养剂', healPct: 0.10, healFlat: 50, treats: ['fatigue'], costCoins: 70, description: '立即回复 10% 生命 + 50 点，消除疲惫（厚血兜底）。' },
  { id: 'serum', name: '血清', healPct: 0.25, healFlat: 50, treats: ['infection', 'bleeding'], costCoins: 140, description: '立即回复 25% 生命 + 50 点，清除感染与失血。' },
  { id: 'nanogel', name: '纳米凝胶', healPct: 0.45, healFlat: 80, treats: ['bleeding', 'fracture', 'shellShock', 'infection', 'fatigue'], costCoins: 240, description: '立即回复 45% 生命 + 80 点，清除全部伤势（可把濒死者拉回）。' },
  { id: 'splint', name: '夹板绷带', healPct: 0.12, healFlat: 20, treats: ['fracture'], costCoins: 100, description: '立即回复 12% 生命 + 20 点，专门清除骨折（伤势专用）。' },
];

export function medicineQty(state: SurvivalGameState, id: MedicineSpec['id']): number {
  return state.medicines[id] ?? 0;
}

export function buyMedicine(state: SurvivalGameState, id: MedicineSpec['id'], qty = 1): SurvivalGameState {
  const spec = MEDICINES.find((m) => m.id === id);
  if (!spec) return state;
  const total = spec.costCoins * qty;
  if (state.coins < total) return state;
  return {
    ...state,
    coins: state.coins - total,
    medicines: { ...state.medicines, [id]: (state.medicines[id] ?? 0) + qty },
    log: [`【采购】购买 ${spec.name}×${qty}。`, ...state.log].slice(0, 50),
  };
}

export function applyMedicineToSurvivor(
  state: SurvivalGameState,
  survivorId: string,
  medicineId: MedicineSpec['id'],
  now: number = Date.now(),
): SurvivalGameState {
  const spec = MEDICINES.find((m) => m.id === medicineId);
  if (!spec) return state;
  if ((state.medicines[medicineId] ?? 0) <= 0) return state;
  const status = state.survivorStatus[survivorId];
  if (!status) return state;
  // 回血量 = 百分比（随角色最大血量放大）+ 固定值
  const healAmount = Math.round(spec.healPct * status.maxHp) + spec.healFlat;
  let nextStatus = applyMedicine(status, healAmount, now);
  if (spec.treats) {
    for (const inj of spec.treats) {
      if (nextStatus.injuries.includes(inj)) {
        nextStatus = treatInjuryImpl(nextStatus, inj);
      }
    }
  }
  // 濒死者：只有把全部伤势都治好（伤势清空），才算真正脱离濒死
  if (nextStatus.dyingUntil && nextStatus.injuries.length === 0) {
    nextStatus = {
      ...nextStatus,
      dyingUntil: undefined,
      lastRecoveredAt: new Date(now).toISOString(),
      sortieReady: false,
    };
  }
  return {
    ...state,
    survivorStatus: { ...state.survivorStatus, [survivorId]: nextStatus },
    medicines: { ...state.medicines, [medicineId]: state.medicines[medicineId] - 1 },
    log: [`【医疗】使用 ${spec.name}（${spec.description}）。`, ...state.log].slice(0, 50),
  };
}

/** 用货币救治濒死成员（不消耗药品，按固定费用结算） */
export const NEAR_DEATH_TREAT_COST = 200;

export function treatNearDeathWithCoins(
  state: SurvivalGameState,
  survivorId: string,
  now: number = Date.now(),
): SurvivalGameState {
  const status = state.survivorStatus[survivorId];
  if (!status || !status.dyingUntil) return state; // 非濒死无需救治
  if (state.coins < NEAR_DEATH_TREAT_COST) return state;
  const member = state.survivors.find((s) => s.id === survivorId);
  const nextStatus: SurvivorStatus = {
    ...status,
    currentHp: Math.max(1, Math.round(status.maxHp * 0.5)),
    injuries: status.injuries.filter((i) => i !== 'bleeding' && i !== 'fracture'),
    dyingUntil: undefined,
    lastRecoveredAt: new Date(now).toISOString(),
    sortieReady: false,
  };
  return {
    ...state,
    coins: state.coins - NEAR_DEATH_TREAT_COST,
    survivorStatus: { ...state.survivorStatus, [survivorId]: nextStatus },
    log: [
      `【救治】花费 ${NEAR_DEATH_TREAT_COST} 废土币稳定了 ${member?.name ?? '幸存者'} 的伤势。`,
      ...state.log,
    ].slice(0, 50),
  };
}

/** v1.1.7：一键救治——支付固定费用把目标成员生命拉满、清除全部伤势与濒死（含所有 debuff） */
export const ONE_CLICK_HEAL_COST = 500;

export function oneClickHeal(
  state: SurvivalGameState,
  survivorId: string,
  now: number = Date.now(),
): SurvivalGameState {
  const status = state.survivorStatus[survivorId];
  if (!status) return state;
  if (state.coins < ONE_CLICK_HEAL_COST) return state;
  const member = state.survivors.find((s) => s.id === survivorId);
  const nextStatus: SurvivorStatus = {
    ...status,
    currentHp: status.maxHp,
    injuries: [],
    dyingUntil: undefined,
    lastRecoveredAt: new Date(now).toISOString(),
    sortieReady: true,
  };
  return {
    ...state,
    coins: state.coins - ONE_CLICK_HEAL_COST,
    survivorStatus: { ...state.survivorStatus, [survivorId]: nextStatus },
    log: [
      `【一键救治】花费 ${ONE_CLICK_HEAL_COST} 废土币，将 ${member?.name ?? '幸存者'} 完全治愈（生命全满、伤势清零）。`,
      ...state.log,
    ].slice(0, 50),
  };
}

// ===== 医疗道具制作（道具制作） =====

export interface MedCraftRecipe {
  id: string;
  name: string;
  /** 产出药品 id */
  medicine: MedicineId;
  /** 消耗材料（按材料大类计） */
  costMaterials: { kind: MaterialKind; qty: number }[];
  costCoins: number;
  /** v1.0.3c：出击临时制作台专用需求（用本局背包内的 loot id 物资合成）；缺省则按 costMaterials 映射材料大类 */
  sortieNeeds?: { lootId: string; qty: number }[];
}

export const MED_CRAFT_RECIPES: MedCraftRecipe[] = [
  // v1.1.8：制作手续费随医疗品单价同步翻倍
  { id: 'craft-bandage', name: '自制绷带', medicine: 'bandage', costMaterials: [{ kind: 'chems', qty: 1 }], costCoins: 10 },
  { id: 'craft-stim', name: '调配肾上腺素', medicine: 'stim', costMaterials: [{ kind: 'chems', qty: 2 }], costCoins: 24 },
  { id: 'craft-nutrient', name: '调配营养剂', medicine: 'nutrient', costMaterials: [{ kind: 'food', qty: 1 }, { kind: 'chems', qty: 1 }], costCoins: 16 },
  { id: 'craft-serum', name: '提纯血清', medicine: 'serum', costMaterials: [{ kind: 'chems', qty: 2 }, { kind: 'electronics', qty: 1 }], costCoins: 36 },
  { id: 'craft-nanogel', name: '合成纳米凝胶', medicine: 'nanogel', costMaterials: [{ kind: 'chems', qty: 3 }, { kind: 'electronics', qty: 1 }], costCoins: 70 },
  { id: 'craft-splint', name: '夹板绷带', medicine: 'splint', costMaterials: [{ kind: 'metal', qty: 2 }], costCoins: 50, sortieNeeds: [{ lootId: 'scrap', qty: 2 }] },
];

function countMaterial(state: SurvivalGameState, kind: MaterialKind): number {
  return materialCount(state.materials, kind);
}

export function canCraftMedicine(state: SurvivalGameState, recipe: MedCraftRecipe): boolean {
  if (state.coins < recipe.costCoins) return false;
  for (const need of recipe.costMaterials) {
    if (countMaterial(state, need.kind) < need.qty) return false;
  }
  return true;
}

export function craftMedicine(
  state: SurvivalGameState,
  recipeId: string,
): SurvivalGameState {
  const recipe = MED_CRAFT_RECIPES.find((r) => r.id === recipeId);
  if (!recipe || !canCraftMedicine(state, recipe)) return state;
  const materials = state.materials.map((m) => ({ ...m }));
  for (const need of recipe.costMaterials) {
    let remain = need.qty;
    for (const m of materials) {
      if (m.kind !== need.kind || remain <= 0) continue;
      const take = Math.min(m.quantity, remain);
      m.quantity -= take;
      remain -= take;
    }
  }
  const medName = MEDICINES.find((m) => m.id === recipe.medicine)?.name ?? recipe.medicine;
  return {
    ...state,
    coins: state.coins - recipe.costCoins,
    materials: materials.filter((m) => m.quantity > 0),
    medicines: { ...state.medicines, [recipe.medicine]: (state.medicines[recipe.medicine] ?? 0) + 1 },
    log: [`【制作】合成 ${medName}×1。`, ...state.log].slice(0, 50),
  };
}

// ===== 恢复（HP/伤势/医疗持续） =====

export function recoverAll(state: SurvivalGameState, now: number = Date.now()): SurvivalGameState {
  return recoverAllImpl(state, now);
}

export { MED_DURATION_MIN };

// ===== NPC 招募集合（副本发现的幸存者进入花名册，付费收编） =====

export function addRecruit(state: SurvivalGameState, npc: SurvivorProfile): SurvivalGameState {
  return {
    ...state,
    recruits: [...state.recruits, npc],
    log: [`【救援】发现可招募幸存者 ${npc.name}（${npc.tierName}）。`, ...state.log].slice(0, 50),
  };
}

/** 招募费用按段位阶梯（越厉害越贵）：废土新人200 / 资深拾荒者800 / 战团骨干2000 / 钢铁幸存者5000 / 旷野狂徒10000 */
export function recruitFee(tier: number): number {
  return [200, 800, 2000, 5000, 10000][Math.min(4, Math.max(0, tier - 1))] ?? 10000;
}

export function acceptRecruit(
  state: SurvivalGameState,
  recruitId: string,
  now: number = Date.now(),
): SurvivalGameState {
  const npc = state.recruits.find((r) => r.id === recruitId);
  if (!npc) return state;
  if (state.survivors.length >= WARBAND_CAP) return state; // 战团已满，无法招募
  const fee = recruitFee(npc.tier);
  if (state.coins < fee) return state;
  const status: Record<string, SurvivorStatus> = { ...state.survivorStatus };
  status[npc.id] = freshStatus(npc, now);
  // 记录招募价值，便于日后遣散返还
  const recruited: SurvivorProfile = { ...npc, recruitValue: fee };
  return {
    ...state,
    coins: state.coins - fee,
    survivors: [...state.survivors, recruited],
    survivorStatus: status,
    recruits: state.recruits.filter((r) => r.id !== recruitId),
    activeSurvivorId: state.activeSurvivorId ?? recruited.id,
    log: [`【招募】${npc.name}（${npc.tierName}）入伙，付费 ${fee} 废土币。`, ...state.log].slice(0, 50),
  };
}

/**
 * 遣散战团成员：移出战团、卸下装备、清除状态，并返还 1/3 招募价值。
 * 主角（玩家代号）不可遣散。
 */
export function dismissSurvivor(
  state: SurvivalGameState,
  survivorId: string,
): SurvivalGameState {
  const member = state.survivors.find((s) => s.id === survivorId);
  if (!member) return state;
  if (member.isProtagonist) {
    return {
      ...state,
      log: [`【遣散】主角 ${member.name} 是避难所的核心，不可遣散。`, ...state.log].slice(0, 50),
    };
  }
  // v1.0.11：濒死成员不可遣散（避免带伤成员被悄悄移除，需先救治）
  const st = state.survivorStatus[survivorId];
  if (st?.dyingUntil && new Date(st.dyingUntil).getTime() > Date.now()) {
    return {
      ...state,
      log: [`【遣散】${member.name} 正处于濒死状态，无法遣散，请先救治。`, ...state.log].slice(0, 50),
    };
  }
  const refund = Math.floor((member.recruitValue ?? 0) / 3);
  const survivors = state.survivors.filter((s) => s.id !== survivorId);
  const survivorStatus = { ...state.survivorStatus };
  delete survivorStatus[survivorId];
  const equipped = { ...state.equipped };
  delete equipped[survivorId];
  const activeSurvivorId =
    state.activeSurvivorId === survivorId ? (survivors[0]?.id ?? null) : state.activeSurvivorId;
  return {
    ...state,
    survivors,
    survivorStatus,
    equipped,
    coins: state.coins + refund,
    activeSurvivorId,
    log: [
      `【遣散】${member.name} 离开战团${refund > 0 ? `，返还 ${refund} 废土币（招募价值 1/3）` : ''}。`,
      ...state.log,
    ].slice(0, 50),
  };
}

export function dismissRecruit(state: SurvivalGameState, recruitId: string): SurvivalGameState {
  const npc = state.recruits.find((r) => r.id === recruitId);
  if (!npc) return state;
  return {
    ...state,
    recruits: state.recruits.filter((r) => r.id !== recruitId),
    log: [`【拒收】放走 ${npc.name}。`, ...state.log].slice(0, 50),
  };
}

// ===== 出击结算（回写 HP/伤势/战绩） =====

export interface SortieResultInput {
  survivorId: string;
  survivorName: string;
  zoneName: string;
  outcome: 'success' | 'death';
  bankedItems: number;
  bankedValue: number;
  enemyFaced?: string;
  rescued?: boolean;
  /** 该幸存者此次出击的最终 HP / maxHp（battle-v5 实际值） */
  finalHp: number;
  maxHp: number;
  /** 本次出击战斗获得的经验（撤离成功才结算入账） */
  xpGained?: number;
  /** v1.0.3：本局在副本中累积的伤势（战斗/疲惫产生），撤离成功也带回基地 */
  injuries?: Injury[];
}

export function applySortieResult(state: SurvivalGameState, input: SortieResultInput, now: number = Date.now()): SurvivalGameState {
  const status = state.survivorStatus[input.survivorId];
  if (!status) return state;
  // 用持久化侧 maxHp 兜底：若 battle-v5 给出更大的 maxHp（装备/buff），采纳高值；
  // 但 finalHp 不得超出现有 maxHp。
  const nextMaxHp = Math.max(status.maxHp, input.maxHp);
  const finalHp = Math.max(0, Math.min(nextMaxHp, Math.round(input.finalHp)));
  const damageRatio = 1 - finalHp / Math.max(1, nextMaxHp);
  // 撤离失败/阵亡：幸存者回战团进入「濒死」状态，需救治；长期未救治才真正离世（见 recoverAll）
  const nextStatus = input.outcome === 'death'
    ? applyNearDeathImpl(status, now)
    : applyPostSortieImpl(status, finalHp, damageRatio, now);
  // 同步 maxHp
  nextStatus.maxHp = nextMaxHp;
  // v1.0.3：把副本内累积的伤势（震伤/失血/骨折/疲惫）带回基地
  if (input.injuries && input.injuries.length > 0) {
    for (const inj of input.injuries) {
      if (!nextStatus.injuries.includes(inj)) nextStatus.injuries = [...nextStatus.injuries, inj];
    }
  }
  // 带伤即不能立刻再出击（sortieReady 需「近满血 + 无伤」）
  nextStatus.sortieReady = finalHp >= nextMaxHp * 0.95 && nextStatus.injuries.length === 0;
  const logEntry: SortieLog = {
    id: `sl-${now}-${Math.random().toString(36).slice(2, 8)}`,
    at: new Date(now).toISOString(),
    survivorName: input.survivorName,
    zoneName: input.zoneName,
    outcome: input.outcome,
    bankedItems: input.bankedItems,
    bankedValue: input.bankedValue,
    enemyFaced: input.enemyFaced,
    rescued: input.rescued,
  };
  let next: SurvivalGameState = {
    ...state,
    survivorStatus: { ...state.survivorStatus, [input.survivorId]: nextStatus },
    sortieHistory: [logEntry, ...state.sortieHistory].slice(0, 100),
  };
  // 经验结算：撤离成功才入账（阵亡/超时的经验作废——搜打撤的残酷法则）
  if (input.outcome === 'success' && (input.xpGained ?? 0) > 0) {
    next = grantSortieXp(next, input.survivorId, input.xpGained ?? 0);
  }
  return next;
}

// ===== 等级 / 经验 / 自由属性点 / 升级词条三选一（系统流） =====

/** 每次升级获得的自由六维属性点 */
export const FREE_POINTS_PER_LEVEL = 3;

/** 升到下一级所需经验：100 × 1.35^(level-1)，逐级递增 */
export function xpNeededForLevel(level: number): number {
  return Math.round(100 * Math.pow(1.35, Math.max(0, level - 1)));
}

/**
 * 发放经验并结算升级（可连升多级）：
 *  - 每升 1 级：+3 自由属性点、状态补满；
 *  - 若当前无待选词条，生成「三选一」词条候选（按品质概率加权）。
 */
export function grantSortieXp(state: SurvivalGameState, survivorId: string, xp: number): SurvivalGameState {
  if (xp <= 0) return state;
  const idx = state.survivors.findIndex((s) => s.id === survivorId);
  if (idx < 0) return state;
  const p: SurvivorProfile = { ...state.survivors[idx] };
  p.level = p.level ?? 1;
  p.xp = (p.xp ?? 0) + xp;
  let levels = 0;
  while (p.xp >= xpNeededForLevel(p.level ?? 1)) {
    p.xp = (p.xp ?? 0) - xpNeededForLevel(p.level ?? 1);
    p.level = (p.level ?? 1) + 1;
    levels += 1;
    p.freePoints = (p.freePoints ?? 0) + FREE_POINTS_PER_LEVEL;
  }
  const survivors = [...state.survivors];
  survivors[idx] = p;
  if (levels === 0) {
    return { ...state, survivors };
  }
  // v1.0.3：升级＝状态全满 + 伤势（debuff）全部清除
  const status = state.survivorStatus[survivorId];
  const survivorStatus = status
    ? {
        ...state.survivorStatus,
        [survivorId]: {
          ...status,
          currentHp: status.maxHp,
          injuries: [],
          lastRecoveredAt: new Date(Date.now()).toISOString(),
          sortieReady: true,
        },
      }
    : state.survivorStatus;
  // 词条三选一（系统提示）：v1.1.2 补充 —— 连升 N 级时一次性从池子无放回抽 3N 个候选，
  // 再分成 N 组依次排队；同一次升级内不会出现重复天赋。UI 一次只展示第一组，选完再弹出下一组。
  if (levels > 0) {
    const existing = p.pendingTraitPick ?? [];
    // 排除已拥有 + 仍在待选队列中的词条，连升多级或多次升级都不会重复出现同一天赋
    const pendingIds = (p.pendingTraitPick ?? []).flat().map((t) => t.id);
    const excludeIds = [...p.traits.map((t) => t.id), ...pendingIds];
    const pool = rollTraitCandidates(Math.random, excludeIds, levels * 3);
    const newSets: SurvivorTrait[][] = [];
    for (let i = 0; i < levels; i++) {
      const set = pool.slice(i * 3, i * 3 + 3);
      if (set.length > 0) newSets.push(set);
    }
    p.pendingTraitPick = [...existing, ...newSets];
  }
  return {
    ...state,
    survivors,
    survivorStatus,
    log: [
      `【系统】${p.name} 升至 Lv.${p.level}！状态已补满、伤势全清，获得 ${levels * FREE_POINTS_PER_LEVEL} 点自由属性点与词条强化三选一。`,
      ...state.log,
    ].slice(0, 50),
  };
}

/**
 * 重算某成员最大生命上限，纳入：六维（含装备六维词条）+ 词条气血 + 已装备装备气血(hpBonus)。
 * 同步当前生命：按增量调整（上限升降，当前生命同步增减，封顶于新上限、封底于 0）。
 *
 * 早返守卫 `if (newMax <= st.maxHp) return` 必须保留（v1.0.12 第 5 项回归修复）：
 * - `freshStatus` 给新成员按 `Math.max(600, deriveMaxHp(...))` 固化了「新手保护」缓冲，
 *   低体质新角色的 st.maxHp 会高于纯 derived 值（如 6 体质约 538 但 st.maxHp=600）；
 *   若无条件写回 derived，加 1 体质时 derived 仍 <600，会把上限从 600 压到 ~558，
 *   表现为「血量倒扣」（run.currentHp 因 delta<0 不同步，UI 显示 current>max 的怪象）。
 * - 该守卫保证：仅在 derived 严格更大时才提升上限，历史缓冲/旧档偏高值被保留，会随加点自愈。
 */
function recomputeMaxHpFor(state: SurvivalGameState, survivorId: string): SurvivalGameState {
  const p = state.survivors.find((s) => s.id === survivorId);
  const st = state.survivorStatus[survivorId];
  if (!p || !st) return state;
  const traitC = aggregateTraitCombat(p.traits);
  // 有效属性（含装备六维词条）+ 词条气血 + 装备气血(hpBonus)，使穿戴气血装备时上限正确提升。
  const gearC = aggregateGearCombat(state, survivorId);
  const eff = effectiveAttributes(state, survivorId);
  const newMax = deriveMaxHp(eff, traitC.hpBonus + gearC.hpBonus);
  // 早返守卫：preserve st.maxHp（含 freshStatus 的 +42 新手保护），仅当 derived 严格更大才更新
  if (newMax <= st.maxHp) return state;
  const delta = newMax - st.maxHp;
  const newCur = Math.min(newMax, Math.max(0, st.currentHp + delta));
  return {
    ...state,
    survivorStatus: {
      ...state.survivorStatus,
      [survivorId]: {
        ...st,
        maxHp: newMax,
        currentHp: newCur,
      },
    },
  };
}

/**
 * 重算某成员最大生命上限，纳入：六维 + 词条气血 + 已装备装备气血（v1.0.5 修复 Bug3：
 * 佩戴/卸下装备后气血上限未同步至角色页）。
 * 同步当前生命：按增量等比调整（上限升降，当前生命同步增减，封顶于新上限、封底于 0）。
 */
/** 计算角色有效六维（最终值）：基础属性 + 已穿戴装备的六维词条加成。用于战力与气血上限。 */
function effectiveAttributes(state: SurvivalGameState, survivorId: string): Attributes {
  const p = state.survivors.find((s) => s.id === survivorId);
  const eff: Attributes = p
    ? { ...p.attributes }
    : { vitality: 0, strength: 0, spirit: 0, endurance: 0, speed: 0, willpower: 0 };
  for (const g of equippedGearList(state, survivorId)) {
    for (const k of Object.keys(g.modifiers) as (keyof Attributes)[]) {
      eff[k] = (eff[k] ?? 0) + (g.modifiers[k] ?? 0);
    }
  }
  return eff;
}

function recomputeMaxHpIncludingGear(state: SurvivalGameState, survivorId: string): SurvivalGameState {
  const p = state.survivors.find((s) => s.id === survivorId);
  const st = state.survivorStatus[survivorId];
  if (!p || !st) return state;
  const traitC = aggregateTraitCombat(p.traits);
  const gearC = aggregateGearCombat(state, survivorId);
  const totalHpBonus = traitC.hpBonus + gearC.hpBonus;
  // v1.0.6：用含装备六维加成的有效属性重算气血上限（修复装备体质不减血量的问题）
  const eff = effectiveAttributes(state, survivorId);
  const newMax = deriveMaxHp(eff, totalHpBonus);
  const delta = newMax - st.maxHp;
  const newCur = Math.min(newMax, Math.max(0, st.currentHp + delta));
  // v1.0.6：战力统计六维最终值（含装备六维加成）
  const power = computePower(eff);
  const derived = tierFromPower(power);
  const newTier = Math.max(p.genTier ?? derived.tier, derived.tier);
  const survivors = state.survivors.map((s) =>
    s.id === survivorId ? { ...s, power, tier: newTier, tierName: tierNameFromTier(newTier) } : s,
  );
  return {
    ...state,
    survivors,
    survivorStatus: {
      ...state.survivorStatus,
      [survivorId]: { ...st, maxHp: newMax, currentHp: newCur },
    },
  };
}

/** 分配 1 点自由属性点（六维任选），并重算战力/段位 */
export function allocateFreePoint(
  state: SurvivalGameState,
  survivorId: string,
  attr: keyof Attributes,
): SurvivalGameState {
  const idx = state.survivors.findIndex((s) => s.id === survivorId);
  if (idx < 0) return state;
  const p = { ...state.survivors[idx] };
  if ((p.freePoints ?? 0) <= 0) return state;
  p.freePoints = (p.freePoints ?? 0) - 1;
  p.attributes = { ...p.attributes, [attr]: (p.attributes[attr] ?? 0) + 1 };
  p.power = computePower(effectiveAttributes({ ...state, survivors: state.survivors.map((s, i) => (i === idx ? p : s)) }, survivorId));
  const derived = tierFromPower(p.power);
  const newTier = Math.max(p.genTier ?? derived.tier, derived.tier);
  p.tier = newTier;
  p.tierName = tierNameFromTier(newTier);
  const survivors = [...state.survivors];
  survivors[idx] = p;
  return recomputeMaxHpFor({ ...state, survivors }, survivorId);
}

/** 升级词条三选一：选定候选 → 词条入库 + 属性增量叠加 + 重算战力段位
 * v1.1.2 补充：`pendingTraitPick` 改为 SurvivorTrait[][] 分组排队。
 *   签名改为 (candidateIndex)；总是取当前第一组（sets[0]），选中后移除该组。 */
export function chooseTraitPick(
  state: SurvivalGameState,
  survivorId: string,
  candidateIndex: number,
): SurvivalGameState {
  const idx = state.survivors.findIndex((s) => s.id === survivorId);
  if (idx < 0) return state;
  const p = { ...state.survivors[idx] };
  const sets = p.pendingTraitPick ?? [];
  const current = sets[0];
  if (!current) return state;
  const trait = current[candidateIndex];
  if (!trait) return state;
  // 移除当前第一组（含同组另外 2 个未选），下一组自动顶上
  p.pendingTraitPick = sets.slice(1);
  p.traits = [...p.traits, trait];
  const attributes = { ...p.attributes };
  for (const k of ALL_ATTR_KEYS) {
    const delta = trait.modifiers[k];
    if (delta) attributes[k] += delta;
  }
  p.attributes = attributes;
  p.power = computePower(effectiveAttributes({ ...state, survivors: state.survivors.map((s, i) => (i === idx ? p : s)) }, survivorId));
  const derived = tierFromPower(p.power);
  const newTier = Math.max(p.genTier ?? derived.tier, derived.tier);
  p.tier = newTier;
  p.tierName = tierNameFromTier(newTier);
  const survivors = [...state.survivors];
  survivors[idx] = p;
  const next = {
    ...state,
    survivors,
    log: [`【系统】${p.name} 觉醒词条「${trait.name}」！`, ...state.log].slice(0, 50),
  };
  // v1.0.3b：词条可能改体质/带气血加成，重算最大生命上限
  return recomputeMaxHpFor(next, survivorId);
}

/**
 * v1.1.3（攒）：重洗某成员一项已掌握词条。
 * 花费 REROLL_TRAIT_COST 废土币，将该词条替换为从「全部未拥有词条」中抽出的 3 选 1 之一。
 *  - 旧词条属性增量先回退，再叠加新词条增量；
 *  - 抽取侧（rollTraitCandidates）应已排除该成员当前拥有的全部词条（含被重洗的那条），保证不重复；
 *  - 余额不足 / 待替换项不存在时原样返回。
 */
export function rerollTrait(
  state: SurvivalGameState,
  survivorId: string,
  oldTraitId: string,
  newTrait: SurvivorTrait,
): SurvivalGameState {
  const idx = state.survivors.findIndex((s) => s.id === survivorId);
  if (idx < 0) return state;
  if (state.coins < REROLL_TRAIT_COST) return state;
  const p = { ...state.survivors[idx] };
  const oldIdx = p.traits.findIndex((t) => t.id === oldTraitId);
  if (oldIdx < 0) return state;
  const oldTrait = p.traits[oldIdx];

  // 1) 回退旧词条属性增量
  const attributes = { ...p.attributes };
  for (const k of ALL_ATTR_KEYS) {
    const delta = oldTrait.modifiers[k];
    if (delta) attributes[k] -= delta;
  }
  // 2) 替换并叠加新词条属性增量
  const traits = [...p.traits];
  traits[oldIdx] = newTrait;
  for (const k of ALL_ATTR_KEYS) {
    const delta = newTrait.modifiers[k];
    if (delta) attributes[k] += delta;
  }
  p.traits = traits;
  p.attributes = attributes;
  // 3) 重算战力 / 段位
  const tmpState: SurvivalGameState = {
    ...state,
    survivors: state.survivors.map((s, i) => (i === idx ? p : s)),
  };
  p.power = computePower(effectiveAttributes(tmpState, survivorId));
  const derived = tierFromPower(p.power);
  const newTier = Math.max(p.genTier ?? derived.tier, derived.tier);
  p.tier = newTier;
  p.tierName = tierNameFromTier(newTier);
  const survivors = [...state.survivors];
  survivors[idx] = p;
  const next: SurvivalGameState = {
    ...state,
    survivors,
    coins: state.coins - REROLL_TRAIT_COST,
    log: [
      `【词条重洗】${p.name} 将「${oldTrait.name}」重洗为「${newTrait.name}」，消耗 ${REROLL_TRAIT_COST} 废土币。`,
      ...state.log,
    ].slice(0, 50),
  };
  // 词条气血变动，重算最大生命上限（沿用 chooseTraitPick 的口径）
  return recomputeMaxHpFor(next, survivorId);
}

// ===== 装备回收 / 装备库辅助 =====

/**
 * 批量回收装备：按物品自身价值折算废土币。
 * 防呆：被任意角色穿戴中的装备会被整体拒绝（须先卸下）。
 */
export function recycleGear(state: SurvivalGameState, gearIds: string[]): SurvivalGameState {
  const ids = new Set(gearIds);
  if (ids.size === 0) return state;
  const equippedIds = new Set(
    Object.values(state.equipped).flatMap((slots) =>
      Object.values(slots).filter((x): x is string => typeof x === 'string'),
    ),
  );
  const targets = state.gear.filter((g) => ids.has(g.id));
  if (targets.length === 0) return state;
  if (targets.some((g) => equippedIds.has(g.id))) return state; // 有穿戴中的装备混入，整体拒绝
  // v1.1.0：按稀有度阶级浮动计价（白 1.0× → 红 2.2×）
  const refund = targets.reduce((a, g) => a + gearSellPrice(g), 0);
  return {
    ...state,
    gear: state.gear.filter((g) => !ids.has(g.id)),
    coins: state.coins + refund,
    log: [`【出售】${targets.length} 件装备折算 ${refund} 废土币。`, ...state.log].slice(0, 50),
  };
}

// ===== v1.1.0：重塑六维 =====

/**
 * 重塑当前出击者的「初始六维基础属性」：六维各在 6~25 重新随机。
 * 只改写 baseAttributes，词条加成 / 升级加点 / 等级 / 经验 / 装备 / 段位算法全部保留
 * （段位由新战力重算）。消耗 REROLL_ATTR_COST 废土币，余额不足时原样返回。
 * 注意：不再重建成员对象，因此成员 id 不变 —— 装备、状态、出击引用均不会断裂。
 */
export function rerollBaseAttributes(
  state: SurvivalGameState,
  survivorId: string,
  rng: RNG,
  now: number = Date.now(),
): SurvivalGameState {
  const idx = state.survivors.findIndex((s) => s.id === survivorId);
  if (idx < 0) return state;
  if (state.coins < REROLL_ATTR_COST) return state;
  const cur = ensureBaseAttributes(state.survivors[idx]);

  const rolled = emptyAttributes();
  for (const k of ALL_ATTR_KEYS) rolled[k] = randInt(rng, 6, 25);

  // 保留「词条加成 + 升级加点」的差值，只替换基础部分
  const attrs = emptyAttributes();
  for (const k of ALL_ATTR_KEYS) {
    attrs[k] = rolled[k] + ((cur.attributes?.[k] ?? 0) - (cur.baseAttributes?.[k] ?? 0));
  }

  const survivors = [...state.survivors];
  survivors[idx] = { ...cur, baseAttributes: rolled, attributes: attrs };
  const tmp: SurvivalGameState = { ...state, survivors };
  const power = computePower(effectiveAttributes(tmp, survivorId));
  const { tier, name: tierName } = tierFromPower(power);
  survivors[idx] = { ...survivors[idx], power, tier, tierName };

  const next: SurvivalGameState = {
    ...tmp,
    survivors,
    coins: state.coins - REROLL_ATTR_COST,
    log: [
      `【重塑六维】${cur.name} 初始基础属性重随，消耗 ${REROLL_ATTR_COST} 废土币。`,
      ...state.log,
    ].slice(0, 50),
  };
  return recomputeMaxHpFor(next, survivorId);
}

// ===== v1.1.0：GM 调试工具 =====

/** GM 功能密钥（纯本地调试用，输入正确才解锁 GM 面板） */
export const GM_ACCESS_KEY = '5362895';

/** 校验 GM 密钥（去除首尾空白后比对） */
export function verifyGmKey(input: string): boolean {
  return (input ?? '').trim() === GM_ACCESS_KEY;
}

/** GM：给出击者加经验（走正常升级流程：升级给自由点 + 词条三选一 + 状态回满） */
export function gmGrantXp(
  state: SurvivalGameState,
  survivorId: string,
  amount: number,
): SurvivalGameState {
  const amt = Math.floor(amount);
  if (amt <= 0) return state;
  const target = state.survivors.find((s) => s.id === survivorId);
  if (!target) return state;
  const next = grantSortieXp(state, survivorId, amt);
  const name = target.name;
  return {
    ...next,
    log: [`【GM】${name} 经验 +${amt}。`, ...next.log].slice(0, 50),
  };
}

/** GM：加废土币 */
export function gmGrantCoins(state: SurvivalGameState, amount: number): SurvivalGameState {
  const amt = Math.floor(amount);
  if (amt <= 0) return state;
  return {
    ...state,
    coins: state.coins + amt,
    log: [`【GM】废土币 +${amt}。`, ...state.log].slice(0, 50),
  };
}

/** GM：恢复行动点到上限（默认满 120 点） */
export function gmGrantActionPoints(
  state: SurvivalGameState,
  amount: number = ACTION_POINT_CAP,
): SurvivalGameState {
  const cap = ACTION_POINT_CAP;
  const target = Math.max(0, Math.min(cap, Math.floor(amount)));
  const current = Math.max(0, Math.min(cap, Math.floor(state.actionPoints ?? 0)));
  if (target <= current) return state; // 已满或更高 → 跳过
  return {
    ...state,
    actionPoints: target,
    log: [`【GM】行动点恢复至 ${target}/${cap}。`, ...state.log].slice(0, 50),
  };
}

// ===== v1.1.0：废土市场出售价 =====

/** 材料出售单价：基础价值 ×2（与旧「10 币/件」口径一致） */
export function materialSellPrice(m: MaterialItem): number {
  return Math.max(1, Math.round(m.value * 2));
}

/** 装备出售价：v1.1.9 起按「阶级 + 词条数」实时重算，不依赖可能为旧值的 g.value，
 * 避免旧存档/已生成装备售出价值偏低。
 */
export function gearSellPrice(g: GearItem): number {
  const tier = typeof g.tier === 'number' ? g.tier : 0;
  const affixCount = Array.isArray(g.affixes) ? g.affixes.length : 1;
  return Math.max(1, gearBaseValue(tier, affixCount));
}

/** 出售指定材料的若干件（数量自动夹到库存上限） */
export function sellMaterials(
  state: SurvivalGameState,
  materialId: string,
  qty: number,
): SurvivalGameState {
  const q = Math.floor(qty);
  if (q <= 0) return state;
  const m = state.materials.find((x) => x.id === materialId);
  if (!m) return state;
  const sell = Math.min(q, m.quantity);
  if (sell <= 0) return state;
  const gain = materialSellPrice(m) * sell;
  const left = m.quantity - sell;
  const materials =
    left > 0
      ? state.materials.map((x) => (x.id === materialId ? { ...x, quantity: left } : x))
      : state.materials.filter((x) => x.id !== materialId);
  return {
    ...state,
    materials,
    coins: state.coins + gain,
    log: [`【出售】${m.name}×${sell}，+${gain} 废土币。`, ...state.log].slice(0, 50),
  };
}

/** 单角色六维装备加成（角色面板括号显示用） */
export function gearAttrBonus(state: SurvivalGameState, survivorId: string): Partial<Attributes> {
  const out: Partial<Attributes> = {};
  for (const g of equippedGearList(state, survivorId)) {
    for (const k of Object.keys(g.modifiers) as (keyof Attributes)[]) {
      out[k] = (out[k] ?? 0) + (g.modifiers[k] ?? 0);
    }
  }
  return out;
}

/** 副本掉落的「药剂类」战利品 → 直接进医疗背包（而非折算材料/币） */
export const LOOT_MEDICINE_MAP: Record<string, MedicineId> = {
  meds: 'bandage',
  serum: 'serum',
  medkit: 'medkit',
  stim: 'stim',
  nutrient: 'nutrient',
  nanogel: 'nanogel',
  splint: 'splint',
};

// ===== 任务 / 悬赏（轻量版） =====

export interface DailyQuest {
  id: string;
  name: string;
  desc: string;
  /** 完成条件：出击次数 */
  sortieTarget: number;
  rewardCoins: number;
  rewardMedicineId?: MedicineSpec['id'];
}

/** 每日悬赏任务池（v1.1.9 扩至 10 个，覆盖出击/区域/撤离/出货等维度）。
 *  id 前缀约定：q1 出击数 / q2 高危区域 / q3 搜刮 / q4 成功撤离 /
 *              q5 地下 / q6 医院 / q7 研究所 / q8 军事 / q9 出货价值 / q10 大丰收 */
export const DAILY_QUESTS: DailyQuest[] = [
  { id: 'q1', name: '每日出击·3 次', desc: '今日完成 3 次搜打撤（任意区域、任意结果）。', sortieTarget: 3, rewardCoins: 80 },
  { id: 'q2', name: '远征·高危区域', desc: '今日完成 1 次危险等级 ≥4 的区域出击（地下/医院/研究所/军事）。', sortieTarget: 1, rewardCoins: 150, rewardMedicineId: 'antibiotic' },
  { id: 'q3', name: '搜刮行家', desc: '今日累计搜刮 ≥6 次。', sortieTarget: 6, rewardCoins: 60 },
  { id: 'q4', name: '成功撤离', desc: '今日以撤离成功结束 2 次出击。', sortieTarget: 2, rewardCoins: 100, rewardMedicineId: 'bandage' },
  { id: 'q5', name: '地下清道夫', desc: '今日在「地下」区域完成 2 次出击。', sortieTarget: 2, rewardCoins: 120 },
  { id: 'q6', name: '医院猎手', desc: '今日在「废弃医院」完成 2 次出击。', sortieTarget: 2, rewardCoins: 100, rewardMedicineId: 'medkit' },
  { id: 'q7', name: '研究所探索', desc: '今日在「研究所」完成 1 次出击。', sortieTarget: 1, rewardCoins: 130, rewardMedicineId: 'serum' },
  { id: 'q8', name: '军事禁区', desc: '今日在「军事基地」完成 1 次出击。', sortieTarget: 1, rewardCoins: 180 },
  { id: 'q9', name: '小有斩获', desc: '今日撤离成功时累计带回价值 ≥500 的战利品。', sortieTarget: 500, rewardCoins: 100, rewardMedicineId: 'nutrient' },
  { id: 'q10', name: '满载而归', desc: '今日撤离成功时累计带回价值 ≥1500 的战利品。', sortieTarget: 1500, rewardCoins: 200, rewardMedicineId: 'nanogel' },
];

export function todayQuestsProgress(state: SurvivalGameState): { quest: DailyQuest; done: number; target: number; doneGoal: boolean; claimed: boolean }[] {
  const today = new Date().toISOString().slice(0, 10);
  const todays = state.sortieHistory.filter((s) => s.at.slice(0, 10) === today);
  const totalSorties = todays.length;
  const successSorties = todays.filter((s) => s.outcome === 'success').length;
  const highDangerSorties = todays.filter((s) =>
    s.zoneName.includes('地下') || s.zoneName.includes('医院') || s.zoneName.includes('研究所') || s.zoneName.includes('军事'),
  ).length;
  const undergroundSorties = todays.filter((s) => s.zoneName.includes('地下')).length;
  const hospitalSorties = todays.filter((s) => s.zoneName.includes('医院')).length;
  const labSorties = todays.filter((s) => s.zoneName.includes('研究所')).length;
  const militarySorties = todays.filter((s) => s.zoneName.includes('军事')).length;
  // 估算：每次出击平均 2 次搜刮（兼容旧存档无精确计数）
  const totalSearches = todays.reduce((acc) => acc + 2, 0);
  // 仅统计撤离成功局带回的战利品总价值
  const bankedValueSuccess = todays
    .filter((s) => s.outcome === 'success')
    .reduce((acc, s) => acc + (s.bankedValue ?? 0), 0);
  const claimed = (state as { claimedQuests?: string[] }).claimedQuests ?? [];
  return DAILY_QUESTS.map((q) => {
    let done = 0;
    switch (q.id) {
      case 'q1':
        done = totalSorties;
        break;
      case 'q2':
        done = highDangerSorties;
        break;
      case 'q3':
        done = totalSearches;
        break;
      case 'q4':
        done = successSorties;
        break;
      case 'q5':
        done = undergroundSorties;
        break;
      case 'q6':
        done = hospitalSorties;
        break;
      case 'q7':
        done = labSorties;
        break;
      case 'q8':
        done = militarySorties;
        break;
      case 'q9':
      case 'q10':
        done = bankedValueSuccess;
        break;
    }
    return {
      quest: q,
      done: Math.min(done, q.sortieTarget),
      target: q.sortieTarget,
      doneGoal: done >= q.sortieTarget,
      claimed: claimed.includes(today + ':' + q.id),
    };
  });
}

export function claimQuest(state: SurvivalGameState, questId: string): SurvivalGameState {
  const today = new Date().toISOString().slice(0, 10);
  const claimed = (state as { claimedQuests?: string[] }).claimedQuests ?? [];
  const key = today + ':' + questId;
  if (claimed.includes(key)) return state;
  const quest = DAILY_QUESTS.find((q) => q.id === questId);
  if (!quest) return state;
  const progress = todayQuestsProgress(state).find((p) => p.quest.id === questId);
  if (!progress || !progress.doneGoal) return state;
  const medicines = { ...state.medicines };
  if (quest.rewardMedicineId) medicines[quest.rewardMedicineId] = (medicines[quest.rewardMedicineId] ?? 0) + 1;
  return {
    ...state,
    coins: state.coins + quest.rewardCoins,
    medicines,
    log: [`【任务】完成「${quest.name}」，奖励 ${quest.rewardCoins} 废土币${quest.rewardMedicineId ? '+1 ' + (MEDICINES.find((m) => m.id === quest.rewardMedicineId)?.name ?? '') : ''}。`, ...state.log].slice(0, 50),
    claimedQuests: [...claimed, key],
  } as SurvivalGameState;
}
