/*
 * persistence.ts — 浏览器端存档（localStorage）。
 * 服务端/Node 环境（如 demo、测试）无 localStorage，做好守卫，回退为空。
 *
 * 存档按「当前登录账号」隔离：每个账号拥有独立存档槽位，
 * 不同账号/密码对应不同的游戏进度。未登录时不读写（由玩法页登录门禁保证）。
 */
import type { SurvivalGameState } from './state';
import type { ExtractionRunState } from '../extraction/types';
import { emptyGardenPlots, ACTION_POINT_CAP, START_SEEDS } from './state';
import { getCurrentUser } from './account';
import { DEPRECATED_PROTAGONIST_TRAIT_IDS, ensureBaseAttributes, tierFromPower, TIERS } from './chargen';
import { buildGearName, gearBaseValue, gearTierName } from './affixes';

const SAVE_PREFIX = 'wqqs-survival-save-v1:';
const RUN_PREFIX = 'wqqs-survival-run-v1:';

function slotKey(name: string): string {
  return `${SAVE_PREFIX}${name}`;
}

function runSlotKey(name: string): string {
  return `${RUN_PREFIX}${name}`;
}

function getStorage(): Storage | null {
  try {
    if (typeof localStorage !== 'undefined') return localStorage;
  } catch {
    /* 某些环境访问 localStorage 会抛错 */
  }
  return null;
}

export function hasSave(): boolean {
  const s = getStorage();
  const name = getCurrentUser();
  if (!s || !name) return false;
  return s.getItem(slotKey(name)) != null;
}

export function loadGame(): SurvivalGameState | null {
  const s = getStorage();
  const name = getCurrentUser();
  if (!s || !name) return null;
  const raw = s.getItem(slotKey(name));
  if (!raw) return null;
  try {
    const data = JSON.parse(raw) as SurvivalGameState;
    if (data && data.version && Array.isArray(data.survivors)) {
      // 旧存档补齐菜园地块，避免切页种植后丢失
      if (!data.gardenPlots || data.gardenPlots.length === 0) {
        data.gardenPlots = emptyGardenPlots();
      }
      // v1.0.10：主角不再附带「退役兵 / 战地医护」，旧存档读取时剥离（已计入的六维保留）
      data.survivors = data.survivors.map((sv) =>
        sv.isProtagonist && Array.isArray(sv.traits)
          ? { ...sv, traits: sv.traits.filter((t) => !DEPRECATED_PROTAGONIST_TRAIT_IDS.includes(t.id)) }
          : sv,
      );
      // v1.1.0：行动点字段补齐（旧存档视为满点；漫游记录缺省为空）
      if (typeof data.actionPoints !== 'number') data.actionPoints = ACTION_POINT_CAP;
      if (typeof data.actionPointsAt !== 'number') data.actionPointsAt = Date.now();
      if (!Array.isArray(data.wanderLog)) data.wanderLog = [];
      // v1.1.0：种子库存迁移 —— 旧存档没有该字段时发放开局种子，避免菜园直接锁死
      if (!data.seeds || typeof data.seeds !== 'object') data.seeds = { ...START_SEEDS };
      // v1.1.0：补齐「初始六维基础属性」（重塑六维依赖；缺省以 当前属性 − 词条加成 回填）
      data.survivors = data.survivors.map((sv) => ensureBaseAttributes(sv));
      if (Array.isArray(data.recruits)) {
        data.recruits = data.recruits.map((sv) => ensureBaseAttributes(sv));
      }
      // v1.1.4：仅当 tier 字段缺失或其 tierName 不在合法段位名称集合时，才按当前 power 重算；
      // 否则保留现有 tier（保护「生成锁定的段位 genTier」与 v1.1.3 已迁移正确的 7 档旧存档）。
      const TIER_NAMES = new Set(TIERS.map((t) => t.name));
      const migrateTier = <T extends { tier?: number; power?: number; tierName?: string }>(
        sv: T,
      ): T => {
        const valid = typeof sv.tier === 'number' && TIER_NAMES.has(sv.tierName ?? '');
        if (valid) return sv;
        const { tier, name: tierName } = tierFromPower(sv.power ?? 0);
        return { ...sv, tier, tierName } as T;
      };
      data.survivors = data.survivors.map(migrateTier);
      if (Array.isArray(data.recruits)) {
        data.recruits = data.recruits.map(migrateTier);
      }
      // v1.1.6：装备废土风命名迁移 —— 旧存档「白阶主武器」等按 tier+slot 重算为「锈蚀主武器」。
      // 幂等：重算结果与当前命名一致，已迁移的存档再次读档无副作用；tierColor 不动，旧装备颜色不变。
      if (Array.isArray(data.gear)) {
        data.gear = data.gear.map((g) => {
          if (!g || typeof g !== 'object') return g;
          const tier = typeof g.tier === 'number' ? g.tier : 0;
          const slot = (g.slot as 'weapon' | 'armor' | 'offWeapon' | 'head' | 'legs' | 'accessory') ?? 'weapon';
          const newRarity = gearTierName(tier);
          return { ...g, name: buildGearName(tier, slot), rarity: newRarity, rarityName: newRarity };
        });
      }
      return data;
    }
  } catch {
    /* 损坏存档直接忽略 */
  }
  return null;
}

export function saveGame(state: SurvivalGameState): void {
  const s = getStorage();
  const name = getCurrentUser();
  if (!s || !name) return;
  try {
    s.setItem(slotKey(name), JSON.stringify(state));
  } catch {
    /* 配额溢出等忽略 */
  }
}

export function clearSave(): void {
  const s = getStorage();
  const name = getCurrentUser();
  if (!s || !name) return;
  s.removeItem(slotKey(name));
}

// ===== 出击对局（sortie run）独立存档：刷新/重进不退出出击 =====

/** 持久化当前出击对局（仅在进行中写入；终局由调用方负责清理） */
export function saveRun(name: string, run: ExtractionRunState): void {
  const s = getStorage();
  if (!s || !name) return;
  try {
    s.setItem(runSlotKey(name), JSON.stringify(run));
  } catch {
    /* 配额溢出等忽略 */
  }
}

/** 读取进行中的出击对局（无则返回 null） */
export function loadRun(name: string): ExtractionRunState | null {
  const s = getStorage();
  if (!s || !name) return null;
  const raw = s.getItem(runSlotKey(name));
  if (!raw) return null;
  try {
    const data = JSON.parse(raw) as ExtractionRunState;
    if (data && typeof data === 'object' && 'phase' in data && 'graph' in data) return data;
  } catch {
    /* 损坏存档直接忽略 */
  }
  return null;
}

/** 清除进行中的出击对局 */
export function clearRun(name: string): void {
  const s = getStorage();
  if (!s || !name) return;
  s.removeItem(runSlotKey(name));
}
