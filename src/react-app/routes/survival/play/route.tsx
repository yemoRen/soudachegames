/**
 * 全境求生・系统搜打撤 — 主玩法 Hub（Phase 2 + 3 整合界面）
 *
 * 仿原游戏「底部常驻导航」：角色 / 背包 / 基地 / 出击。
 * 全部状态走 @shared/engine/survival，并通过 localStorage 持久化（刷新不丢）。
 * 出击页复用 extraction 引擎跑真实战斗，并把入库物资/废土币写回存档。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from '@app/components/router/AppLink';
import { useNavigate } from 'react-router';
import type { Attributes } from '@shared/types/cultivator';
import type {
  SurvivalGameState,
  GearSlot,
  GearItem,
  SurvivorTrait,
} from '@shared/engine/survival';
import {
  newGame,
  bankLoot,
  ALL_ATTR_KEYS,
  addRecruit,
  acceptRecruit,
  dismissRecruit,
  equipGear,
  unequipGear,
  applyFailureGearLoss,
  setQuickSlot,
  upgradeFacility,
  nextUpgradeCost,
  investFaction,
  nextFactionCost,
  buildSortieLoadout,
  computeShelterBonuses,
  SHELTER_FACILITIES,
  FACTIONS,
  MATERIAL_LABEL,
  attrLabel,
  recruitFee,
  dismissSurvivor,
  treatNearDeathWithCoins,
  WARBAND_CAP,
  NEAR_DEATH_TREAT_COST,
  applyMedicineToSurvivor,
  type RNG,
  seededRng,
  hashSeed,
  chance,
  applySortieResult,
  recoverAll as _recoverAll,
  MEDICINES,
  MED_CRAFT_RECIPES,
  type MedicineId,
  MAIN_EQUIP_SLOTS,
  QUICK_SLOTS,
  THROWABLES,
  getThrowable,
  GEAR_SLOT_LABEL,
  LOOT_MEDICINE_MAP,
  xpNeededForLevel,
  allocateFreePoint,
  chooseTraitPick,
  grantSortieXp,
  recycleGear,
  gearAttrBonus,
  aggregateGearCombat,
  gearSellPrice,
  createProtagonistGame,
  // v1.1.0：行动点
  ACTION_POINT_CAP,
  actionPointView,
  tickActionPoints,
  trySpendActionPoints,
  sortieActionPointCost,
  // 副本等级门槛（原 UI 局部常量，现提升到引擎层，手动与漫游共用）
  DANGER_LEVEL_REQ,
} from '@shared/engine/survival';
import {
  createRun,
  search,
  rollRescue,
  extract,
  getZone,
  DANGER_ZONES,
  addCarriedLoot,
  resolveEncounter,
  lootCorpse,
  consumeCarriedItem,
  equipCarriedGear,
  unequipRunGear,
  effectiveRunMaxHp,
  runEffectiveAttributes,
  injuryAttrTextOf,
  cureInjuries,
  moveToNode,
  resolveBagFull,
  currentZoneOf,
  zoneNeighbors,
  nearestExtractZone,
  isBossZone,
  runPackCapacity,
  threatTierOf,
  THREAT_TIERS,
  EXTRACT_POINT_COUNT,
  ZONE_POOL_SIZE,
  leaveExtract,
  dropCarried,
  moveToSecure,
  takeFromSecure,
  bankSecureIntoBanked,
  timeLeft,
  fmtClock,
  zoneSearchLeft,
  RUN_TIME_LIMIT_SEC,
  MAX_ZONE_SEARCHES,
  SECURE_BOX_SLOTS,
  FIGHT_AMMO_COST,
  type ExtractionRunState,
  type EncounterAction,
  type BattleReplayEntry,
} from '@shared/engine/extraction';
import { generateSurvivor, tierNameFromTier } from '@shared/engine/survival/chargen';
import { loadGame, saveGame, clearSave, saveRun, loadRun, clearRun } from '@shared/engine/survival';
import { ResetSaveDialog } from '../components/ResetSaveDialog';
import {
  INJURY_LABEL,
  INJURY_DESC,
  hpStage,
  HP_STAGE_META,
  applyInjuryToBase,
  type Injury,
} from '@shared/engine/survival/recovery';
import { getCurrentUser } from '@shared/engine/survival/account';
import { MenuDrawer } from '../menu/MenuDrawer';
import {
  rollGearDrop,
  tierColor,
  RARITY_LEGEND,
  affixColor,
  affixLabel,
} from '@shared/engine/survival/affixes';

// v1.0.11：副本等级门槛（危N → 最低等级）。危1 不限（主角恒 ≥ Lv1，恒满足）。
// ===== 出击临时制作台（v1.0.3c）=====
// 材料大类 → 本局背包内对应的 loot id（用于把「医疗制作台」配方映射到副本内可搜到的物资）
const MATERIAL_TO_LOOT: Record<string, string> = {
  metal: 'scrap',
  chems: 'chempack',
  food: 'ration',
  electronics: 'parts',
};

// 药品 → 本局背包内对应的 loot 模板（产出的医疗品以 loot 形式进入临时背包，可直接「💊 使用」）
const MED_LOOT_TEMPLATE: Partial<Record<MedicineId, { id: string; name: string; value: number }>> = {
  bandage: { id: 'meds', name: '绷带', value: 12 },
  medkit: { id: 'medkit', name: '急救包', value: 40 },
  stim: { id: 'stim', name: '肾上腺素', value: 22 },
  nutrient: { id: 'nutrient', name: '营养剂', value: 18 },
  serum: { id: 'serum', name: '抗辐射血清', value: 30 },
  nanogel: { id: 'nanogel', name: '纳米凝胶', value: 60 },
  splint: { id: 'splint', name: '夹板绷带', value: 25 },
};

// loot id → 中文显示名（仅用于合成面板展示需求）
const LOOT_NAME: Record<string, string> = {
  scrap: '废金属',
  chempack: '化学试剂',
  ration: '压缩口粮',
  parts: '电子零件',
  meds: '绷带',
};

interface SortieCraftDef {
  id: string;
  medicine: MedicineId;
  name: string;
  needs: { lootId: string; qty: number }[];
  /** 合成所需废土币：从本局临时背包搜到的废土币（carriedCredits）中扣除 */
  costCoins: number;
}

// 由「医疗制作台」配方派生出击临时制作台配方：优先用 sortieNeeds，否则按材料大类映射
const SORTIE_MED_CRAFT: SortieCraftDef[] = MED_CRAFT_RECIPES.map((r) => ({
  id: r.id,
  medicine: r.medicine,
  name: r.name,
  needs:
    r.sortieNeeds && r.sortieNeeds.length > 0
      ? r.sortieNeeds
      : r.costMaterials.map((c) => ({ lootId: MATERIAL_TO_LOOT[c.kind] ?? c.kind, qty: c.qty })),
  costCoins: r.costCoins,
}));

/**
 * 词条说明：点击展开小气泡（移动端友好），点击其他区域自动关闭，不遮挡屏幕。
 * 取代原先鼠标 hover 才显示的 title 提示。
 */
function TraitBonusText({ trait }: { trait: SurvivorTrait }) {
  const mods = (Object.keys(trait.modifiers) as (keyof Attributes)[])
    .filter((k) => (trait.modifiers[k] ?? 0) !== 0)
    .map((k) => `${attrLabel(k)} +${trait.modifiers[k]}`);
  const combat: string[] = [];
  if (trait.combat?.hpBonus) combat.push(`气血 +${trait.combat.hpBonus}`);
  if (trait.combat?.critBonus) combat.push(`暴击 +${Math.round(trait.combat.critBonus * 100)}%`);
  if (trait.combat?.lootLuck) combat.push(`搜刮 +${Math.round(trait.combat.lootLuck * 100)}%`);
  if (trait.combat?.startHpRatio) combat.push(`初始血量 +${Math.round(trait.combat.startHpRatio * 100)}%`);
  if (mods.length === 0 && combat.length === 0) return null;
  return (
    <div className="mt-1.5 space-y-1 border-t border-zinc-700 pt-1.5">
      {mods.length > 0 && (
        <div className="text-emerald-300">属性加成：{mods.join(' · ')}</div>
      )}
      {combat.length > 0 && (
        <div className="text-sky-300">增益效果：{combat.join(' · ')}</div>
      )}
    </div>
  );
}

function TraitChip({ trait }: { trait: SurvivorTrait }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);
  const color = affixColor(trait.quality);
  return (
    <span ref={ref} className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="rounded border px-2 py-0.5 text-[11px]"
        style={{ color, borderColor: `${color}66`, backgroundColor: `${color}1a` }}
      >
        {trait.name}
        <span className="ml-1 opacity-70" style={{ color }}>{affixLabel(trait.quality)}</span>
      </button>
      {open && (
        <span
          role="dialog"
          onClick={(e) => e.stopPropagation()}
          className="absolute left-0 top-full z-30 mt-1 w-60 rounded-lg border border-zinc-700 bg-zinc-900 p-2 text-[11px] leading-relaxed text-zinc-200 shadow-xl"
        >
          <div className="mb-1 flex items-center justify-between">
            <span className="font-medium" style={{ color }}>{trait.name}</span>
            <span className="rounded px-1 text-[10px]" style={{ color, border: `1px solid ${color}66` }}>
              {affixLabel(trait.quality)}阶词条
            </span>
          </div>
          <div className="text-zinc-400">{trait.description}</div>
          <TraitBonusText trait={trait} />
        </span>
      )}
    </span>
  );
}

type Tab = 'character' | 'inventory' | 'base' | 'sortie';

const TABS: { id: Tab; label: string }[] = [
  { id: 'character', label: '角色' },
  { id: 'inventory', label: '背包' },
  { id: 'base', label: '基地' },
  { id: 'sortie', label: '出击' },
];

const DANGER_LABEL: Record<number, string> = {
  1: '危1·安全',
  2: '危2·谨慎',
  3: '危3·凶险',
  4: '危4·高危',
  5: '危5·死地',
  6: '危6·禁区',
  7: '危7·绝境',
};

/**
 * 六维属性条：最终值（基础值+加成值-减损值）
 *  - 基础值：白色（角色原始六维）
 *  - 加成值：绿色（装备 + 词条等正向加成）
 *  - 减损值：红色（伤势 debuff 对基础六维的削减）
 *  - 最终值：有减损时呈粉红，否则常规色
 */
function attrBars(base: Attributes, bonus?: Partial<Attributes>, reduction?: Partial<Attributes>) {
  const keys = Object.keys(base) as (keyof Attributes)[];
  const finals = keys.map((k) => (base[k] ?? 0) + (bonus?.[k] ?? 0) - (reduction?.[k] ?? 0));
  const maxV = Math.max(20, ...finals);
  return (
    <div className="grid grid-cols-3 gap-x-3 gap-y-1.5 text-[12px]">
      {keys.map((k, i) => {
        const b = bonus?.[k] ?? 0;
        const r = reduction?.[k] ?? 0;
        const final = finals[i];
        const reduced = r > 0;
        const showParen = b !== 0 || r !== 0;
        return (
          <div key={k}>
            <div className="flex justify-between text-zinc-400">
              <span>{attrLabel(k)}</span>
              <span className={reduced ? 'font-semibold text-pink-400' : 'text-zinc-200'}>
                {final}
                {showParen && (
                  <span className="ml-0.5 text-[10px]">
                    {'('}
                    <span className="text-zinc-100">{base[k]}</span>
                    {b !== 0 && <span className="text-emerald-400">{b > 0 ? `+${b}` : b}</span>}
                    {r !== 0 && <span className="text-rose-500">-{r}</span>}
                    {')'}
                  </span>
                )}
              </span>
            </div>
            <div className="mt-0.5 h-1.5 overflow-hidden rounded bg-zinc-800">
              <div
                className={`h-full ${reduced ? 'bg-pink-500/70' : 'bg-emerald-500/70'}`}
                style={{ width: `${Math.min(100, (final / maxV) * 100)}%` }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** 由基础六维与伤势列表推导各属性被削减的数值（六维"减损值"展示用） */
function injuryReduction(base: Attributes, injuries: Injury[]): Partial<Attributes> {
  const injured = applyInjuryToBase(base, injuries);
  const out: Partial<Attributes> = {};
  for (const k of Object.keys(base) as (keyof Attributes)[]) {
    out[k] = Math.max(0, (base[k] ?? 0) - (injured[k] ?? base[k] ?? 0));
  }
  return out;
}

/** 装备属性 / 词条加成小标签（出击背包与穿戴面板复用，便于直观对比是否更换） */
function GearBonusChips({ gear }: { gear: GearItem }) {
  const chips: { text: string; tone: 'attr' | 'combat' }[] = [];
  for (const k of Object.keys(gear.modifiers) as (keyof Attributes)[]) {
    const v = gear.modifiers[k] ?? 0;
    if (v !== 0) chips.push({ text: `${attrLabel(k)}+${v}`, tone: 'attr' });
  }
  const c = gear.combat;
  if (c) {
    if (c.hpBonus) chips.push({ text: `气血+${c.hpBonus}`, tone: 'combat' });
    if (c.critBonus) chips.push({ text: `暴击+${c.critBonus}`, tone: 'combat' });
    if (c.lootLuck) chips.push({ text: `搜刮+${Math.round((c.lootLuck ?? 0) * 100)}%`, tone: 'combat' });
    if (c.xpBonus) chips.push({ text: `经验+${Math.round((c.xpBonus ?? 0) * 100)}%`, tone: 'combat' });
    if (c.coinBonus) chips.push({ text: `金币+${Math.round((c.coinBonus ?? 0) * 100)}%`, tone: 'combat' });
  }
  if (chips.length === 0) {
    return <div className="mt-0.5 text-[11px] text-zinc-600">无属性加成</div>;
  }
  return (
    <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]">
      {chips.map((c, i) => (
        <span
          key={i}
          className={`rounded px-1.5 py-0.5 text-[11px] ${
            c.tone === 'attr' ? 'bg-emerald-900/40 text-emerald-300' : 'bg-sky-900/40 text-sky-300'
          }`}
        >
          {c.text}
        </span>
      ))}
    </div>
  );
}

function Coin({ n }: { n: number }) {
  return (
    <span className="rounded bg-zinc-800 px-2 py-0.5 text-sm font-semibold text-amber-300">
      ⛁ {n}
    </span>
  );
}

/** 简单分页：返回当前页切片与翻页控制。items 数量变化时自动收束越界页码。 */
function usePagination<T>(items: T[], pageSize: number) {
  const [page, setPage] = useState(0);
  const pageCount = Math.max(1, Math.ceil(items.length / pageSize));
  const safePage = Math.min(page, pageCount - 1);
  const slice = items.slice(safePage * pageSize, safePage * pageSize + pageSize);
  return { page: safePage, setPage, pageCount, slice };
}

function Pager({
  page,
  pageCount,
  total,
  onPrev,
  onNext,
}: {
  page: number;
  pageCount: number;
  total: number;
  onPrev: () => void;
  onNext: () => void;
}) {
  if (pageCount <= 1) return null;
  return (
    <div className="mt-3 flex items-center justify-between text-[11px] text-zinc-500">
      <button
        onClick={onPrev}
        disabled={page <= 0}
        className="rounded border border-zinc-700 px-2 py-1 text-zinc-300 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-30"
      >
        ‹ 上一页
      </button>
      <span>
        第 {page + 1}/{pageCount} 页 · 共 {total} 件
      </span>
      <button
        onClick={onNext}
        disabled={page >= pageCount - 1}
        className="rounded border border-zinc-700 px-2 py-1 text-zinc-300 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-30"
      >
        下一页 ›
      </button>
    </div>
  );
}

export default function SurvivalHub() {
  const [state, setState] = useState<SurvivalGameState>(() => {
    const loaded = loadGame() ?? newGame();
    // v1.1.0：载入时先把离线期间应恢复的行动点补上
    return tickActionPoints(_recoverAll(loaded));
  });
  const [tab, setTab] = useState<Tab>('character');
  const goToTab = (t: Tab) => {
    // 切换 tab 前先结算一次时间戳恢复（事件回调中 setState，符合 lint 规则）
    setState((prev) => _recoverAll(prev));
    setTab(t);
  };

  const navigate = useNavigate();
  const [user] = useState(() => getCurrentUser());
  const [menuOpen, setMenuOpen] = useState(false);


  // 存档随状态变化持久化（按当前账号独立槽位，见 persistence.ts）
  useEffect(() => {
    saveGame(state);
  }, [state]);

  useEffect(() => {
    if (!user) navigate('/survival/login', { replace: true });
  }, [user, navigate]);

  // ===== 出击（sortie）run 状态提升到 Hub 层：便于「角色 / 背包」页实时同步与编辑锁定 =====
  // 必须放在未登录 early-return 之前，避免条件调用 Hook（rules-of-hooks）。
  const [run, setRun] = useState<ExtractionRunState | null>(null);
  const runRef = useRef<ExtractionRunState | null>(null);
  const rngRef = useRef<RNG>(Math.random as RNG);
  const writtenRef = useRef(false);
  const syncRun = useCallback(
    () => setRun(runRef.current ? structuredClone(runRef.current) : null),
    [],
  );

  // stateRef 始终指向「最新已提交状态」，使连续点击（同一 tick 内）也能基于最新状态累计，避免丢更新。
  // 必须放在未登录 early-return 之前，避免条件调用 Hook（rules-of-hooks）。
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  // 未登录闸门：进入避难所前必须先通过幸存者核验（各账号独立存档）
  if (!user) {
    return (
      <div className="flex min-h-[100svh] items-center justify-center bg-zinc-950 text-zinc-400">
        未登录 · 正在跳转至幸存者核验…
      </div>
    );
  }

  const mutate = (fn: (s: SurvivalGameState) => SurvivalGameState) =>
    setState((prev) => fn(prev));

  /**
   * v1.0.10 补充：重置存档 = 先退出出击 + 清空存档 + 以「重生者姓名」重建主角。
   * 关键：必须先清掉进行中的对局（run / clearRun），否则重生的主角（id 与旧主角同名时相同）
   * 会被判定仍在副本中 —— 状态条沿用副本内血量，表现为「出击状态 + 血量不满」。
   */
  const resetGame = (name: string) => {
    runRef.current = null;
    writtenRef.current = false;
    setRun(null);
    const u = getCurrentUser();
    if (u) clearRun(u);
    clearSave();
    mutate(() => createProtagonistGame(name));
  };

  // 实时同步：档案（角色页 / 出击页共用）的加点与选词条，立即同步进副本血量，实现两边完全一致。
  // stateRef 已置于 early-return 之前，此处直接复用。

  /** 把档案最大血量的变化量（加点 / 词条引起）同步进副本：profileMaxHpBonus + max 同增；
   *  当前血量仅当增量 > 0 时同增（体质点 / 带气血词条「最大 + 当前一起提升」）。 */
  const syncProfileMaxHpDeltaToRun = (
    prev: SurvivalGameState,
    next: SurvivalGameState,
    survivorId: string,
  ) => {
    const s = runRef.current;
    if (!s || s.survivor.profile?.id !== survivorId) return;
    const before = prev.survivorStatus[survivorId]?.maxHp ?? 0;
    const after = next.survivorStatus[survivorId]?.maxHp ?? 0;
    const delta = after - before;
    if (delta === 0) return;
    s.profileMaxHpBonus = (s.profileMaxHpBonus ?? 0) + delta;
    s.condition.resources.hp.max = (s.condition.resources.hp.max ?? 0) + delta;
    if (delta > 0) {
      s.condition.resources.hp.current = (s.condition.resources.hp.current ?? 0) + delta;
    }
  };

  /** 分配 1 点自由属性点（角色页 / 出击页共用）：档案立即生效，并同步副本血量 / 有效六维 */
  const onAllocatePoint = (survivorId: string, attr: keyof Attributes) => {
    const prev = stateRef.current;
    const next = allocateFreePoint(prev, survivorId, attr);
    stateRef.current = next;
    const s = runRef.current;
    if (s && s.survivor.profile?.id === survivorId) {
      // 词条 / 属性增量即时映射到副本有效六维（出击途中加点立即影响后续战斗）
      s.baseAttributes = { ...s.baseAttributes, [attr]: (s.baseAttributes?.[attr] ?? 0) + 1 };
    }
    syncProfileMaxHpDeltaToRun(prev, next, survivorId);
    setState(next);
    syncRun();
  };

  /** 升级词条三选一（角色页 / 出击页共用）：档案立即生效，并同步副本血量 / 有效六维
   * v1.1.2 补充：改为队列式，始终操作当前第一组 (candidateIndex)。 */
  const onPickTrait = (survivorId: string, candidateIndex: number) => {
    const prev = stateRef.current;
    const p = prev.survivors.find((x) => x.id === survivorId);
    const sets = p?.pendingTraitPick ?? [];
    const trait = sets[0]?.[candidateIndex];
    const next = chooseTraitPick(prev, survivorId, candidateIndex);
    stateRef.current = next;
    const s = runRef.current;
    if (s && s.survivor.profile?.id === survivorId && trait) {
      // 词条属性增量 → 本局有效六维（及时生效）
      for (const k of ALL_ATTR_KEYS) {
        const d = trait.modifiers[k];
        if (d) s.baseAttributes = { ...s.baseAttributes, [k]: (s.baseAttributes?.[k] ?? 0) + d };
      }
      // 词条气血加成已由 chooseTraitPick 抬高档案 maxHp，syncProfileMaxHpDeltaToRun 会把增量同步进副本
    }
    syncProfileMaxHpDeltaToRun(prev, next, survivorId);
    setState(next);
    syncRun();
  };

  return (
    <div className="flex min-h-[100svh] flex-col bg-zinc-950 text-zinc-200">
      {/* 顶部 HUD */}
      <header className="sticky top-0 z-10 border-b border-zinc-800 bg-zinc-950/95 px-4 py-3 backdrop-blur">
        <div className="mx-auto flex max-w-3xl items-center justify-between">
          <div className="flex items-center gap-2">
            <Link href="/survival" className="text-sm text-zinc-400 hover:text-zinc-200">
              ‹ 首页
            </Link>
            <h1 className="text-base font-semibold tracking-wide text-emerald-400">
              全境求生 · 系统搜打撤
            </h1>
          </div>
          <div className="flex items-center gap-2">
            <Link href="/survival/login" className="rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:border-emerald-500 hover:text-emerald-300">
              账号
            </Link>
            <Coin n={state.coins} />
          </div>
        </div>
      </header>

      {/* 主内容：四个面板常驻挂载，仅用 hidden 切换可见性——
          这样切到「角色/背包/基地」再切回「出击」时，出击中的 run 状态不会因卸载而丢失 */}
      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-4">
        <div className={tab === 'character' ? '' : 'hidden'}>
          <CharacterPanel
            state={state}
            mutate={mutate}
            rng={Math.random as RNG}
            run={run}
            onAllocatePoint={onAllocatePoint}
            onPickTrait={onPickTrait}
          />
        </div>
        <div className={tab === 'inventory' ? '' : 'hidden'}>
          <InventoryPanel state={state} mutate={mutate} rng={Math.random as RNG} run={run} />
        </div>
        <div className={tab === 'base' ? '' : 'hidden'}>
          <BasePanel state={state} mutate={mutate} onResetGame={resetGame} />
        </div>
        <div className={tab === 'sortie' ? '' : 'hidden'}>
          <SortiePanel
            state={state}
            setState={setState}
            onExit={() => goToTab('character')}
            run={run}
            setRun={setRun}
            runRef={runRef}
            rngRef={rngRef}
            writtenRef={writtenRef}
            syncRun={syncRun}
            onAllocatePoint={onAllocatePoint}
            onPickTrait={onPickTrait}
            stateRef={stateRef}
          />
        </div>
      </main>

      {/* 底部常驻导航 */}
      <footer className="sticky bottom-0 z-10 border-t border-dashed border-zinc-700 bg-zinc-950/95">
        <nav className="mx-auto flex max-w-3xl items-stretch justify-around">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => goToTab(t.id)}
              className={`flex-1 py-3 text-sm tracking-wide transition ${
                tab === t.id
                  ? 'border-t-2 border-emerald-500 text-emerald-400'
                  : 'border-t-2 border-transparent text-zinc-400 hover:text-zinc-200'
              }`}
            >
              [{t.label}]
            </button>
          ))}
          {/* 末世行止：从右侧滑出抽屉（不离开避难所、不重新加载） */}
          <button
            onClick={() => setMenuOpen(true)}
            className="relative flex-1 py-3 text-sm tracking-wide text-amber-300/90 hover:text-amber-200"
          >
            <span className="mr-1">‹</span>末世行止
            <span className="ml-1 text-[10px] text-amber-400/60">›</span>
          </button>
        </nav>
      </footer>

      {/* 末世行止侧滑抽屉 */}
      <MenuDrawer
        state={state}
        mutate={mutate}
        setState={setState}
        onResetGame={resetGame}
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
      />
    </div>
  );
}

// ===== 角色 =====
function CharacterPanel(props: {
  state: SurvivalGameState;
  mutate: (fn: (s: SurvivalGameState) => SurvivalGameState) => void;
  rng: RNG;
  run: ExtractionRunState | null;
  onAllocatePoint: (survivorId: string, attr: keyof Attributes) => void;
  onPickTrait: (survivorId: string, candidateIndex: number) => void;
}) {
  const { state, mutate, run, onAllocatePoint, onPickTrait } = props;
  const [confirmDismissId, setConfirmDismissId] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const full = state.survivors.length >= WARBAND_CAP;
  const sortieId = run?.survivor.profile?.id ?? undefined;

  const warbandHp = (id: string) => {
    const st = state.survivorStatus[id];
    const inSortie = !!run && run.survivor.profile?.id === id;
    // 出击实时同步：同一角色正在副本中时，生命条显示副本内当前血量
    const cur = inSortie ? (run!.condition.resources.hp.current ?? 0) : (st?.currentHp ?? 0);
    const max = inSortie ? (run!.condition.resources.hp.max ?? 0) : (st?.maxHp ?? 0);
    if (max <= 0) return null;
    const pct = Math.max(0, Math.min(100, (cur / max) * 100));
    const stage = hpStage(pct);
    const meta = HP_STAGE_META[stage];
    return (
      <div className="mt-2">
        <div className="mb-1 flex justify-between text-[11px] text-zinc-500">
          <span>
            生命 <span className={meta.text}>{meta.label}</span>
            {inSortie && <span className="ml-1 text-sky-400/80">· 副本同步</span>}
          </span>
          <span>{cur} / {max}</span>
        </div>
        <div className="h-2 overflow-hidden rounded bg-zinc-800">
          <div className={`h-full ${meta.bar} transition-all`} style={{ width: `${pct}%` }} />
        </div>
      </div>
    );
  };

  return (
    <section className="space-y-6">
      {/* ===== 战团成员 ===== */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium text-zinc-300">
            战团成员（{state.survivors.length} / {WARBAND_CAP}）
          </h2>
          {full && <span className="text-[11px] text-rose-400">战团已满，招募需先遣散</span>}
        </div>

        {state.survivors.map((s) => {
          const isActive = s.id === state.activeSurvivorId;
          const st = state.survivorStatus[s.id];
          const dyingUntil = st?.dyingUntil ? new Date(st.dyingUntil).getTime() : 0;
          const isDying = dyingUntil > now;
          const dyingLeft = isDying ? Math.ceil((dyingUntil - now) / 60000) : 0;
          // 该角色是否正在副本中（出击实时同步的来源）
          const inSortie = sortieId === s.id;
          const liveInjuries = inSortie && run ? (run.injuries ?? []) : (st?.injuries ?? []);
          // 六维分解（基础值 / 加成值 / 减损值）：出击中实时取副本内有效六维
          let sixBase: Attributes;
          let sixBonus: Partial<Attributes>;
          let sixReduction: Partial<Attributes>;
          if (inSortie && run) {
            sixBase = run.baseAttributes ?? s.attributes;
            const finalAttrs = runEffectiveAttributes(run);
            sixReduction = injuryReduction(sixBase, run.injuries);
            sixBonus = {};
            for (const k of ALL_ATTR_KEYS) {
              sixBonus[k] = (finalAttrs[k] ?? sixBase[k]) - (sixBase[k] ?? 0) + (sixReduction[k] ?? 0);
            }
          } else {
            sixBase = s.attributes;
            // 词条（trait）属性加成在升级选取时已并入 s.attributes（基础六维），故绿字仅显示装备加成；
            // 这样未穿戴装备时不会凭空出现绿字，词条带来的六维算作基础数值（不再被重复计为加成）。
            sixBonus = gearAttrBonus(state, s.id);
            sixReduction = st ? injuryReduction(s.attributes, st.injuries) : {};
          }
          return (
            <div
              key={s.id}
              className={`rounded-lg border p-4 transition ${
                isDying
                  ? 'border-rose-600 bg-rose-950/30'
                  : isActive
                    ? 'border-emerald-500 bg-emerald-500/5'
                    : 'border-zinc-800 bg-zinc-900'
              }`}
            >
              <div className="flex items-start justify-between">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-zinc-100">{s.name}</span>
                    {s.isProtagonist && (
                      <span className="rounded bg-amber-900/50 px-1.5 py-0.5 text-[11px] text-amber-300">主角</span>
                    )}
                    <span
                      className="rounded-full border px-1.5 py-0.5 text-[11px] font-semibold"
                      style={{ color: tierColor(s.tier - 1), borderColor: `${tierColor(s.tier - 1)}66`, background: `${tierColor(s.tier - 1)}1a` }}
                    >
                      {tierNameFromTier(s.tier)}
                    </span>
                  </div>
                  <div className="mt-0.5 text-xs text-zinc-500">
                    {s.origin} · {s.age}岁 · 战力 {s.power}
                  </div>
                </div>
                <button
                  onClick={() => mutate((st2) => ({ ...st2, activeSurvivorId: s.id }))}
                  disabled={isDying || !!sortieId}
                  title={sortieId && !isActive ? '另一成员正在副本中，请先撤离或返回基地' : undefined}
                  className={`rounded px-3 py-1 text-xs ${
                    isActive
                      ? 'bg-emerald-600 text-white'
                      : isDying || !!sortieId
                        ? 'cursor-not-allowed bg-zinc-800 text-zinc-600'
                        : 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700'
                  }`}
                >
                  {isActive ? '出战中' : isDying ? '濒死' : sortieId ? (s.id === sortieId ? '副本中' : '暂不可选') : '选为出击'}
                </button>
              </div>

              {warbandHp(s.id)}

              {isDying && (
                <div className="mt-2 rounded border border-rose-700 bg-rose-950/40 p-2 text-[12px] text-rose-200">
                  <div className="flex items-center justify-between gap-2">
                    <span>☠ 撤离失败·濒死，约 {dyingLeft} 分钟内未救治将真正离世</span>
                    <div className="flex shrink-0 items-center gap-1.5">
                      {((state.medicines.nanogel ?? 0) > 0) && (
                        <button
                          onClick={() => mutate((st2) => applyMedicineToSurvivor(st2, s.id, 'nanogel'))}
                          className="rounded bg-fuchsia-600 px-2 py-1 text-xs text-white hover:bg-fuchsia-500"
                        >
                          纳米凝胶救治（×{state.medicines.nanogel}）
                        </button>
                      )}
                      <button
                        onClick={() => mutate((st2) => treatNearDeathWithCoins(st2, s.id))}
                        disabled={state.coins < NEAR_DEATH_TREAT_COST}
                        className={`rounded px-2 py-1 text-xs ${
                          state.coins >= NEAR_DEATH_TREAT_COST
                            ? 'bg-rose-600 text-white hover:bg-rose-500'
                            : 'cursor-not-allowed bg-zinc-800 text-zinc-500'
                        }`}
                      >
                        救治（⛁{NEAR_DEATH_TREAT_COST}）
                      </button>
                    </div>
                  </div>
                  <div className="mt-1 text-[11px] text-rose-300/80">也可用医疗品在「末世行止·医疗中心」救治。</div>
                </div>
              )}

              {/* 伤势 debuff：出击实时同步副本内状态；出击中锁定角色页治疗 */}
              {!isDying && liveInjuries.length > 0 && (
                <div className="mt-2 space-y-2">
                  <div className="text-[11px] text-rose-300/80">
                    当前伤势（debuff）{inSortie && <span className="text-sky-400/80">· 副本同步</span>}
                  </div>
                  {liveInjuries.map((inj) => {
                    const treatMeds = MEDICINES.filter(
                      (m) => m.treats?.includes(inj) && (state.medicines[m.id] ?? 0) > 0,
                    );
                    return (
                      <div key={inj} className="rounded border border-rose-800/50 bg-rose-950/20 p-2">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-[12px] font-medium text-rose-300">⚠ {INJURY_LABEL[inj]}</span>
                          <span className="text-[11px] text-rose-300/70">{INJURY_DESC[inj]}</span>
                        </div>
                        <div className="mt-1 flex flex-wrap items-center gap-1 text-[11px]">
                          {inSortie ? (
                            <span className="rounded border border-sky-800/60 bg-sky-950/30 px-1.5 py-0.5 text-sky-300">
                              该角色出击中，请在出击页使用道具消除
                            </span>
                          ) : treatMeds.length > 0 ? (
                            <>
                              <span className="text-zinc-500">可用药物恢复：</span>
                              {treatMeds.map((m) => (
                                <button
                                  key={m.id}
                                  onClick={() => mutate((st2) => applyMedicineToSurvivor(st2, s.id, m.id))}
                                  className="rounded border border-emerald-800 bg-emerald-900/40 px-1.5 py-0.5 text-emerald-200 hover:bg-emerald-800/60"
                                >
                                  用 {m.name} 治疗
                                </button>
                              ))}
                            </>
                          ) : (
                            <span className="text-amber-400">无对应药物，请先采购或在「末世行止·医疗中心」救治。</span>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              <div className="mt-3">
                {attrBars(sixBase, sixBonus, sixReduction)}
              </div>

              {/* 等级 / 经验 / 自由属性点 / 升级词条三选一（系统流） */}
              {(() => {
                const lvl = s.level ?? 1;
                const xp = s.xp ?? 0;
                const need = xpNeededForLevel(lvl);
                const fp = s.freePoints ?? 0;
                const cands = s.pendingTraitPick ?? [];
                return (
                  <div className="mt-2 rounded border border-sky-900/50 bg-zinc-950/50 p-2">
                    <div className="flex items-center justify-between text-[11px]">
                      <span className="text-sky-300">
                        Lv.{lvl}
                        <span className="ml-2 text-zinc-500">经验 {xp} / {need}</span>
                      </span>
                      {fp > 0 && (
                        <span className="rounded bg-amber-900/50 px-1.5 py-0.5 text-amber-300">
                          ⬆ 自由属性点 ×{fp}
                        </span>
                      )}
                    </div>
                    <div className="mt-1 h-1.5 overflow-hidden rounded bg-zinc-800">
                      <div className="h-full bg-sky-500/70" style={{ width: `${Math.min(100, (xp / need) * 100)}%` }} />
                    </div>
                    {fp > 0 && (
                      <div className="mt-2">
                        <div className="mb-1 text-[10px] text-zinc-500">分配自由属性点 ×{fp}（每点 +1）：</div>
                        <div className="flex flex-wrap gap-1">
                          {(Object.keys(s.attributes) as (keyof Attributes)[]).map((k) => (
                            <button
                              key={k}
                              onClick={() => onAllocatePoint(s.id, k)}
                              className="rounded border border-amber-700/60 px-1.5 py-0.5 text-[10px] text-amber-200 hover:bg-amber-900/40"
                            >
                              {attrLabel(k)} +1
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                    {cands.length > 0 && (() => {
                      const set = cands[0];
                      const remaining = cands.length;
                      return (
                        <div className="mt-2 rounded border border-purple-800/60 bg-purple-950/20 p-2">
                          <div className="text-[11px] text-purple-300">
                            🔗【系统】检测到宿主等级提升……请选择词条强化
                            {remaining > 1 ? `（剩余 ${remaining} 组，三选一）` : '（三选一）'}：
                          </div>
                          <div className="mt-1.5 grid gap-1.5 sm:grid-cols-3">
                            {set.map((t, i) => (
                              <button
                                key={`${t.id}-0-${i}`}
                                onClick={() => onPickTrait(s.id, i)}
                                className="rounded border p-2 text-left transition hover:bg-zinc-800/60"
                                style={{ borderColor: affixColor(t.quality) }}
                              >
                                <div className="text-xs font-medium" style={{ color: affixColor(t.quality) }}>
                                  {affixLabel(t.quality)}·{t.name}
                                </div>
                                <div className="mt-0.5 text-[10px] leading-snug text-zinc-400">{t.description}</div>
                                {(() => {
                                  const modsTxt = (Object.keys(t.modifiers) as (keyof Attributes)[])
                                    .filter((k) => (t.modifiers[k] ?? 0) !== 0)
                                    .map((k) => `${attrLabel(k)}+${t.modifiers[k]}`)
                                    .join(' ');
                                  const combatTxt = [
                                    t.combat?.hpBonus ? `气血+${t.combat.hpBonus}` : '',
                                    t.combat?.critBonus ? `暴击+${Math.round(t.combat.critBonus * 100)}%` : '',
                                    t.combat?.lootLuck ? `搜刮+${Math.round(t.combat.lootLuck * 100)}%` : '',
                                    t.combat?.startHpRatio ? `初始血量+${Math.round(t.combat.startHpRatio * 100)}%` : '',
                                  ].filter(Boolean).join(' ');
                                  return (
                                    <>
                                      {modsTxt && (
                                        <div className="mt-0.5 text-[10px] text-emerald-300">属性加成：{modsTxt}</div>
                                      )}
                                      {combatTxt && (
                                        <div className="mt-0.5 text-[10px] text-sky-300">增益效果：{combatTxt}</div>
                                      )}
                                    </>
                                  );
                                })()}
                              </button>
                            ))}
                          </div>
                        </div>
                      );
                    })()}
                  </div>
                );
              })()}

              <div className="mt-3 flex flex-wrap items-center gap-1.5">
                {s.traits.map((t) => (
                  <TraitChip key={t.id} trait={t} />
                ))}
                {!s.isProtagonist && (
                  inSortie ? (
                    <span
                      className="ml-auto rounded border border-zinc-700 px-2 py-1 text-[11px] text-zinc-600"
                      title="该成员正在副本中出击，无法遣散，请先撤离或返回基地"
                    >
                      出击中·不可遣散
                    </span>
                  ) : isDying ? (
                    <span
                      className="ml-auto rounded border border-zinc-700 px-2 py-1 text-[11px] text-zinc-600"
                      title="成员正处于濒死状态，无法遣散，请先救治"
                    >
                      濒死·不可遣散
                    </span>
                  ) : confirmDismissId === s.id ? (
                    <span className="ml-auto flex items-center gap-1.5">
                      <span className="text-[11px] text-rose-300">确认遣散？</span>
                      <button
                        onClick={() => {
                          mutate((st2) => dismissSurvivor(st2, s.id));
                          setConfirmDismissId(null);
                        }}
                        className="rounded border border-rose-600 px-2 py-1 text-[11px] text-rose-300 hover:bg-rose-900/40"
                      >
                        确认
                      </button>
                      <button
                        onClick={() => setConfirmDismissId(null)}
                        className="rounded border border-zinc-700 px-2 py-1 text-[11px] text-zinc-400 hover:bg-zinc-800"
                      >
                        取消
                      </button>
                    </span>
                  ) : (
                    <button
                      onClick={() => setConfirmDismissId(s.id)}
                      className="ml-auto rounded border border-zinc-700 px-2 py-1 text-[11px] text-zinc-400 hover:border-rose-600 hover:text-rose-300"
                    >
                      遣散{typeof s.recruitValue === 'number' && s.recruitValue > 0 ? `（返还 ⛁${Math.floor(s.recruitValue / 3)}）` : ''}
                    </button>
                  )
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* ===== 幸存者花名册（副本中找到、待招募） ===== */}
      <div className="space-y-3">
        <div>
          <h2 className="text-sm font-medium text-zinc-300">幸存者花名册（{state.recruits.length}）</h2>
          <p className="mt-1 text-[11px] text-zinc-500">
            副本中救出的幸存者会来到这里，用废土币招募后加入战团。越厉害越贵；战团满员需先遣散腾位。
          </p>
        </div>

        {state.recruits.length === 0 ? (
          <div className="rounded-lg border border-dashed border-zinc-800 bg-zinc-900/50 p-4 text-center text-sm text-zinc-600">
            暂无待招募幸存者。出击搜打撤时，有概率在副本中救出幸存者。
          </div>
        ) : (
          state.recruits.map((r) => {
            const fee = recruitFee(r.tier);
            const canAfford = state.coins >= fee && !full;
            return (
              <div key={r.id} className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
                <div className="flex items-start justify-between">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-semibold" style={{ color: tierColor(r.tier - 1) }}>{r.name}</span>
                      <span
                        className="rounded-full border px-1.5 py-0.5 text-[11px] font-semibold"
                        style={{ color: tierColor(r.tier - 1), borderColor: `${tierColor(r.tier - 1)}66`, background: `${tierColor(r.tier - 1)}1a` }}
                      >
                        {tierNameFromTier(r.tier)}
                      </span>
                    </div>
                    <div className="mt-0.5 text-xs text-zinc-500">
                      {r.origin} · {r.age}岁 · 战力 {r.power}
                    </div>
                  </div>
                  <div className="flex flex-col items-end gap-1">
                    <button
                      onClick={() => mutate((s) => acceptRecruit(s, r.id))}
                      disabled={!canAfford}
                      className={`rounded px-3 py-1 text-xs ${
                        canAfford
                          ? 'bg-emerald-600 text-white hover:bg-emerald-500'
                          : 'cursor-not-allowed bg-zinc-800 text-zinc-500'
                      }`}
                    >
                      招募（⛁{fee}）
                    </button>
                    <button
                      onClick={() => mutate((s) => dismissRecruit(s, r.id))}
                      className="rounded border border-zinc-700 px-2 py-0.5 text-[11px] text-zinc-400 hover:border-zinc-500"
                    >
                      放走
                    </button>
                  </div>
                </div>
                <div className="mt-3">{attrBars(r.attributes)}</div>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {r.traits.map((t) => (
                    <TraitChip key={t.id} trait={t} />
                  ))}
                </div>
              </div>
            );
          })
        )}
      </div>
    </section>
  );
}

// ===== 背包 =====
function InventoryPanel(props: {
  state: SurvivalGameState;
  mutate: (fn: (s: SurvivalGameState) => SurvivalGameState) => void;
  rng: RNG;
  run: ExtractionRunState | null;
}) {
  const { state, mutate, rng, run } = props;
  const active = state.survivors.find((s) => s.id === state.activeSurvivorId) ?? null;
  const matPage = usePagination(state.materials, 12);
  // 装备库：已被任意角色穿戴的装备不予显示（穿戴独立性，卸下后回归）；支持分类筛选 + 批量回收
  const [gearCat, setGearCat] = useState<'all' | GearSlot>('all');
  const [recycleSel, setRecycleSel] = useState<Record<string, boolean>>({});
  const [confirmRecycle, setConfirmRecycle] = useState(false);
  const equippedGearIds = new Set(
    Object.values(state.equipped).flatMap((slots) =>
      Object.values(slots).filter((x): x is string => typeof x === 'string'),
    ),
  );
  // v1.0.4：装备库按阶位从高到低降序显示（高阶置顶）
  const ownedGear = state.gear
    .filter((g) => !equippedGearIds.has(g.id))
    .slice()
    .sort((a, b) => (b.tier ?? 0) - (a.tier ?? 0) || (b.value ?? 0) - (a.value ?? 0));
  const filteredGear = gearCat === 'all' ? ownedGear : ownedGear.filter((g) => g.slot === gearCat);
  const gearPage = usePagination(filteredGear, 6);
  const selectedGear = ownedGear.filter((g) => recycleSel[g.id]);
  const refundTotal = selectedGear.reduce((a, g) => a + g.value, 0);

  // 出击实时同步：若该角色正在副本中，装备栏显示副本内「当前穿戴」并锁定更换
  const inSortie = !!run && run.survivor.profile?.id === state.activeSurvivorId;
  const runEquippedMap: Partial<Record<GearSlot, GearItem>> = {};
  if (run) for (const e of run.equipped) runEquippedMap[e.slot] = e.gear;

  return (
    <section className="space-y-4">
      <h2 className="text-sm font-medium text-zinc-300">背包物资</h2>

      {inSortie && (
        <div className="rounded-lg border border-sky-800/60 bg-sky-950/30 p-3 text-[12px] text-sky-200">
          ⚠ 该角色正在出击中，装备/道具更换已锁定。副本内状态（装备·生命·伤势）已实时同步至本页，换装请在「出击」页进行。
        </div>
      )}

      {/* 装备栏：6 主槽（常驻穿戴）+ 3 快捷槽 */}
      <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-xs uppercase tracking-wider text-zinc-500">
            装备栏 · {active?.name ?? '无成员'}
          </h3>
          <span className="text-[11px] text-zinc-500">6 主槽 + 3 快捷槽</span>
        </div>
        {!active ? (
          <p className="text-sm text-zinc-600">暂无战团成员。</p>
        ) : (
          <>
            {/* 6 个主装备槽 */}
            <div className="grid grid-cols-3 gap-2">
              {MAIN_EQUIP_SLOTS.map((slot) => {
                const gid = (state.equipped[active.id] ?? {})[slot.key];
                const g = inSortie
                  ? runEquippedMap[slot.key]
                  : gid
                    ? state.gear.find((x) => x.id === gid)
                    : undefined;
                return (
                  <div
                    key={slot.key}
                    className="rounded border border-zinc-800 bg-zinc-950/60 p-2"
                  >
                    <div className="text-[10px] text-zinc-500">
                      {slot.icon} {slot.label}
                    </div>
                    {g ? (
                      <>
                        <div
                          className="mt-0.5 truncate text-xs"
                          style={{ color: g.tierColor ?? '#e4e4e7' }}
                          title={g.name}
                        >
                          {g.name}
                          {inSortie && (
                            <span className="ml-1 text-[10px] text-sky-400/80">
                              {run!.equipped.find((e) => e.slot === slot.key)?.fromRun ? '·副本' : '·常驻'}
                            </span>
                          )}
                        </div>
                        <div className="text-[10px] text-zinc-500">
                          {g.rarityName ?? g.rarity}
                        </div>
                        <GearBonusChips gear={g} />
                        <button
                          disabled={inSortie}
                          onClick={() => mutate((s) => unequipGear(s, active.id, slot.key))}
                          className={`mt-1 w-full rounded px-1 py-0.5 text-[10px] ${
                            inSortie
                              ? 'cursor-not-allowed bg-zinc-800 text-zinc-600'
                              : 'bg-zinc-700 text-zinc-200 hover:bg-zinc-600'
                          }`}
                        >
                          {inSortie ? '出击中' : '卸下'}
                        </button>
                      </>
                    ) : (
                      <div className="mt-0.5 text-[11px] text-zinc-600">空</div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* 3 个快捷消耗槽 */}
            <div className="mt-3 grid grid-cols-3 gap-2">
              {QUICK_SLOTS.map((qs) => {
                const cur = (state.equipped[active.id] ?? {})[qs.key];
                const opts =
                  qs.key === 'quickThrow'
                    ? THROWABLES.filter((t) => (state.throwables?.[t.id] ?? 0) > 0).map((t) => ({
                        id: t.id,
                        name: `${t.name}×${state.throwables?.[t.id] ?? 0}`,
                      }))
                    : qs.key === 'quickBuff'
                      ? MEDICINES.filter((m) => m.id === 'stim' && (state.medicines[m.id] ?? 0) > 0).map((m) => ({
                          id: m.id,
                          name: `${m.name}×${state.medicines[m.id] ?? 0}`,
                        }))
                      : MEDICINES.filter((m) => m.id !== 'stim' && (state.medicines[m.id] ?? 0) > 0).map((m) => ({
                          id: m.id,
                          name: `${m.name}×${state.medicines[m.id] ?? 0}`,
                        }));
                return (
                  <div
                    key={qs.key}
                    className="rounded border border-zinc-800 bg-zinc-950/60 p-2"
                  >
                    <div className="text-[10px] text-zinc-500">
                      {qs.icon} {qs.label}
                    </div>
                    <select
                      value={cur ?? ''}
                      disabled={inSortie}
                      onChange={(e) =>
                        mutate((s) =>
                          setQuickSlot(s, active.id, qs.key, e.target.value || undefined),
                        )
                      }
                      className="mt-1 w-full rounded border border-zinc-700 bg-zinc-900 px-1 py-0.5 text-[11px] text-zinc-200 disabled:opacity-50"
                    >
                      <option value="">—</option>
                      {opts.map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.name}
                        </option>
                      ))}
                    </select>
                  </div>
                );
              })}
            </div>
            <p className="mt-2 text-[11px] text-zinc-600">
              主槽装备常驻生效，撤离失败时有概率被夺走；快捷槽供战斗中一键使用。
            </p>
            {/* 已穿戴装备属性增益统计（出击/副本内临时换装时实时同步）——v1.0.9 补充：六维属性 + 气血/暴击/搜刮/经验/金币 等 CombatBonus 词条 */}
            {(() => {
              const eb: Partial<Attributes> = {};
              let hpBonus = 0;
              let critBonus = 0;
              let lootLuck = 0;
              let xpBonus = 0;
              let coinBonus = 0;
              if (inSortie && run) {
                for (const e of run.equipped) {
                  for (const k of Object.keys(e.gear.modifiers) as (keyof Attributes)[]) {
                    eb[k] = (eb[k] ?? 0) + (e.gear.modifiers[k] ?? 0);
                  }
                  const c = e.gear.combat;
                  if (c) {
                    hpBonus += c.hpBonus ?? 0;
                    critBonus += c.critBonus ?? 0;
                    lootLuck += c.lootLuck ?? 0;
                    xpBonus += c.xpBonus ?? 0;
                    coinBonus += c.coinBonus ?? 0;
                  }
                }
              } else {
                const g = gearAttrBonus(state, active.id);
                for (const k of Object.keys(g) as (keyof Attributes)[]) {
                  eb[k] = (eb[k] ?? 0) + (g[k] ?? 0);
                }
                const gc = aggregateGearCombat(state, active.id);
                hpBonus = gc.hpBonus ?? 0;
                critBonus = gc.critBonus ?? 0;
                lootLuck = gc.lootLuck ?? 0;
                xpBonus = gc.xpBonus ?? 0;
                coinBonus = gc.coinBonus ?? 0;
              }
              const entries = (Object.keys(eb) as (keyof Attributes)[]).filter((k) => (eb[k] ?? 0) !== 0);
              const affixEntries: { label: string; value: string }[] = [];
              if (hpBonus !== 0) affixEntries.push({ label: '气血', value: `${hpBonus > 0 ? '+' : ''}${hpBonus}` });
              if (critBonus !== 0) affixEntries.push({ label: '暴击', value: `+${(critBonus * 100).toFixed(1)}%` });
              if (lootLuck !== 0) affixEntries.push({ label: '搜刮运势', value: `+${(lootLuck * 100).toFixed(1)}%` });
              if (xpBonus !== 0) affixEntries.push({ label: '经验加成', value: `+${(xpBonus * 100).toFixed(1)}%` });
              if (coinBonus !== 0) affixEntries.push({ label: '金币加成', value: `+${(coinBonus * 100).toFixed(1)}%` });
              if (entries.length === 0 && affixEntries.length === 0) return null;
              return (
                <div className="mt-3 rounded border border-emerald-900/40 bg-emerald-950/20 p-2">
                  <div className="mb-1 text-[11px] uppercase tracking-wider text-emerald-300/70">已穿戴装备属性增益</div>
                  <div className="flex flex-wrap gap-1.5">
                    {entries.map((k) => (
                      <span key={k} className="rounded bg-emerald-900/40 px-1.5 py-0.5 text-[11px] text-emerald-300">
                        {attrLabel(k)}+{eb[k]}
                      </span>
                    ))}
                    {affixEntries.map((a) => (
                      <span key={a.label} className="rounded bg-amber-900/40 px-1.5 py-0.5 text-[11px] text-amber-200">
                        {a.label}{a.value}
                      </span>
                    ))}
                  </div>
                </div>
              );
            })()}
          </>
        )}
      </div>

      {/* 装备库（已穿戴的不显示；分类筛选 + 多选批量回收，两步确认防误触） */}
      <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-xs uppercase tracking-wider text-zinc-500">装备库</h3>
          <span className="text-[11px] text-zinc-500">当前出击：{active?.name ?? '无'}</span>
        </div>
        <p className="mb-2 text-[11px] text-zinc-600">
          已被角色穿戴的装备不在此显示（穿戴独立），卸下后回归装备库。回收金额 = 装备自身价值。
        </p>
        {/* 分类筛选 */}
        <div className="mb-2 flex flex-wrap gap-1.5">
          {GEAR_CATS.map((c) => (
            <button
              key={c.key}
              onClick={() => { setGearCat(c.key); setConfirmRecycle(false); }}
              className={`rounded border px-2 py-0.5 text-[11px] transition ${
                gearCat === c.key
                  ? 'border-emerald-500 bg-emerald-500/10 text-emerald-300'
                  : 'border-zinc-700 text-zinc-400 hover:border-zinc-500'
              }`}
            >
              {c.label}
            </button>
          ))}
        </div>
        {state.gear.length === 0 ? (
          <p className="text-sm text-zinc-600">尚未获得任何装备。</p>
        ) : filteredGear.length === 0 ? (
          <p className="text-sm text-zinc-600">该分类下暂无可显示的装备。</p>
        ) : (
          <>
            <ul className="space-y-2">
              {gearPage.slice.map((g, gi) => {
                const checked = !!recycleSel[g.id];
                return (
                  <li
                    key={`${g.id}-${gi}`}
                    className={`rounded border p-3 transition ${
                      checked ? 'border-rose-700/60 bg-rose-950/10' : 'border-zinc-800 bg-zinc-950/50'
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex min-w-0 items-center gap-2">
                        {/* 多选框（批量回收用） */}
                        <button
                          onClick={() => { setRecycleSel((s0) => ({ ...s0, [g.id]: !s0[g.id] })); setConfirmRecycle(false); }}
                          title="勾选以加入批量回收"
                          className={`h-4 w-4 shrink-0 rounded border text-[10px] leading-none transition ${
                            checked
                              ? 'border-rose-500 bg-rose-600 text-white'
                              : 'border-zinc-600 text-transparent hover:border-zinc-400'
                          }`}
                        >
                          ✓
                        </button>
                        <span className="text-sm" style={{ color: g.tierColor ?? tierColor(g.tier ?? 0) }}>
                          {g.name}
                        </span>
                        <span className="ml-1 rounded bg-zinc-800 px-1.5 py-0.5 text-[11px] text-zinc-400">
                          {g.rarityName ?? g.rarity}·{GEAR_SLOT_LABEL[g.slot]}
                        </span>
                        <span className="shrink-0 text-[11px] text-zinc-500">⛁{gearSellPrice(g)}</span>
                      </div>
                      {active && (
                        <button
                          disabled={inSortie}
                          onClick={() => mutate((s) => equipGear(s, active.id, g.id))}
                          className={`shrink-0 rounded px-2 py-1 text-xs text-white ${
                            inSortie
                              ? 'cursor-not-allowed bg-zinc-700 text-zinc-500'
                              : 'bg-emerald-700 hover:bg-emerald-600'
                          }`}
                        >
                          {inSortie ? '出击中' : '装备'}
                        </button>
                      )}
                    </div>
                    <div className="mt-1">
                      <GearBonusChips gear={g} />
                    </div>
                  </li>
                );
              })}
            </ul>
            <Pager
              page={gearPage.page}
              pageCount={gearPage.pageCount}
              total={filteredGear.length}
              onPrev={() => gearPage.setPage(gearPage.page - 1)}
              onNext={() => gearPage.setPage(gearPage.page + 1)}
            />
            {/* 批量回收（两步确认防误触） */}
            {selectedGear.length > 0 && (
              <div className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded border border-amber-800/60 bg-amber-950/20 p-2 text-xs">
                <span className="text-amber-200">
                  已选 {selectedGear.length} 件 · 回收可得 ⛁{refundTotal}
                </span>
                {!confirmRecycle ? (
                  <button
                    onClick={() => setConfirmRecycle(true)}
                    className="rounded bg-rose-700 px-3 py-1 font-medium text-white hover:bg-rose-600"
                  >
                    ♻ 回收选中
                  </button>
                ) : (
                  <span className="flex flex-wrap items-center gap-1.5">
                    <span className="text-rose-300">⚠ 再次确认：回收后装备永久消失！</span>
                    <button
                      onClick={() => {
                        mutate((s) => recycleGear(s, selectedGear.map((g) => g.id)));
                        setRecycleSel({});
                        setConfirmRecycle(false);
                      }}
                      className="rounded bg-rose-700 px-3 py-1 font-medium text-white hover:bg-rose-600"
                    >
                      确认回收
                    </button>
                    <button
                      onClick={() => setConfirmRecycle(false)}
                      className="rounded border border-zinc-600 px-2 py-1 text-zinc-300 hover:bg-zinc-800"
                    >
                      取消
                    </button>
                  </span>
                )}
              </div>
            )}
          </>
        )}
      </div>

      {/* 材料 */}
      <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
        <h3 className="mb-2 flex items-center gap-1.5 text-xs uppercase tracking-wider text-zinc-500">
          <span>📦</span>材料
        </h3>
        {state.materials.length === 0 ? (
          <p className="text-sm text-zinc-600">暂无材料，出击搜刮或拆解战利品获取。</p>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {matPage.slice.map((m) => {
                const dot = (
                  { metal: '#94a3b8', electronics: '#38bdf8', chems: '#a78bfa', mutant: '#34d399', food: '#fbbf24', misc: '#cbd5e1' } as Record<string, string>
                )[m.kind] ?? '#cbd5e1';
                return (
                  <div key={m.id} className="rounded border border-zinc-800 bg-zinc-950/50 p-2">
                    <div className="flex items-center gap-1.5">
                      <span className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: dot }} />
                      <span className="text-sm text-zinc-200">{m.name}</span>
                    </div>
                    <div className="mt-0.5 text-[11px] text-zinc-500">
                      {MATERIAL_LABEL[m.kind]} · x{m.quantity} · ⛁{m.value}
                    </div>
                  </div>
                );
              })}
            </div>
            <Pager
              page={matPage.page}
              pageCount={matPage.pageCount}
              total={state.materials.length}
              onPrev={() => matPage.setPage(matPage.page - 1)}
              onNext={() => matPage.setPage(matPage.page + 1)}
            />
          </>
        )}
      </div>

    </section>
  );
}

/** 装备库分类（全部 + 6 主槽位） */
const GEAR_CATS: Array<{ key: 'all' | GearSlot; label: string }> = [
  { key: 'all', label: '全部' },
  ...(Object.keys(GEAR_SLOT_LABEL) as GearSlot[]).map((k) => ({ key: k, label: GEAR_SLOT_LABEL[k] })),
];

// ===== 基地 =====
function BasePanel(props: {
  state: SurvivalGameState;
  mutate: (fn: (s: SurvivalGameState) => SurvivalGameState) => void;
  /** v1.0.10 补充：重置存档（含退出出击）；由 Hub 统一实现，保证对局状态一并清空 */
  onResetGame: (name: string) => void;
}) {
  const { state, mutate, onResetGame } = props;
  // v1.0.10：重置存档不再沿用「玩家代号」，改为弹窗输入重生者姓名
  const [resetOpen, setResetOpen] = useState(false);
  const suggestedName = (
    state.playerCodename ||
    state.survivors.find((s) => s.isProtagonist)?.name ||
    state.survivors[0]?.name ||
    ''
  ).trim();
  const bonuses = computeShelterBonuses(state.facilities, state.factionRep);
  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-zinc-300">避难所</h2>
        <button
          onClick={() => setResetOpen(true)}
          className="rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-800"
        >
          重置存档
        </button>
      </div>

      {resetOpen ? (
        <ResetSaveDialog
          defaultName={suggestedName}
          onCancel={() => setResetOpen(false)}
          onConfirm={(name) => {
            onResetGame(name);
            setResetOpen(false);
          }}
        />
      ) : null}

      {/* 设施 */}
      <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
        <h3 className="mb-2 text-xs uppercase tracking-wider text-zinc-500">设施升级</h3>
        <div className="space-y-2">
          {SHELTER_FACILITIES.map((f) => {
            const lvl = state.facilities[f.id] ?? 0;
            const cost = nextUpgradeCost(state, f.id);
            const maxed = cost == null;
            const can = !maxed && state.coins >= (cost ?? 0);
            return (
              <div key={f.id} className="flex items-center justify-between rounded border border-zinc-800 bg-zinc-950/50 p-3">
                <div className="min-w-0">
                  <div className="text-sm text-zinc-100">
                    {f.name} <span className="text-[11px] text-zinc-500">Lv.{lvl}/{f.maxLevel}</span>
                  </div>
                  <div className="mt-0.5 text-[11px] text-zinc-500">{f.description}</div>
                  <div className="mt-0.5 text-[11px] text-emerald-400/80">
                    每级：{[f.lootPerLevel > 0 ? `搜刮运势 +${(f.lootPerLevel * 100).toFixed(0)}%` : null, f.recoveryPerLevel > 0 ? `恢复速率 +${(f.recoveryPerLevel * 100).toFixed(0)}%` : null, f.discountPerLevel > 0 ? `改装折扣 -${(f.discountPerLevel * 100).toFixed(0)}%` : null, (f.plantTimeReductionPerLevel ?? 0) > 0 ? `种植时间 -${((f.plantTimeReductionPerLevel ?? 0) * 100).toFixed(0)}%` : null, ...(Object.keys(f.attrPerLevel).map((k) => `${attrLabel(k as keyof Attributes)} +${f.attrPerLevel[k as keyof Attributes]}/级`))].filter(Boolean).join(' · ') || '暂无数值加成'}
                  </div>
                </div>
                {maxed ? (
                  <span className="rounded bg-zinc-800 px-2 py-1 text-xs text-zinc-400">已满级</span>
                ) : (
                  <button
                    disabled={!can}
                    onClick={() => mutate((s) => upgradeFacility(s, f.id))}
                    className={`rounded px-3 py-1.5 text-xs font-medium ${
                      can ? 'bg-amber-600 text-white hover:bg-amber-500' : 'cursor-not-allowed bg-zinc-800 text-zinc-500'
                    }`}
                  >
                    升级 ⛁{cost}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* 势力 */}
      <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
        <h3 className="mb-2 text-xs uppercase tracking-wider text-zinc-500">势力 / 战团</h3>
        <div className="space-y-2">
          {FACTIONS.map((fac) => {
            const rep = state.factionRep[fac.id] ?? 0;
            const cost = nextFactionCost(state, fac.id);
            const maxed = cost == null;
            const can = !maxed && state.coins >= (cost ?? 0);
            return (
              <div key={fac.id} className="flex items-center justify-between rounded border border-zinc-800 bg-zinc-950/50 p-3">
                <div className="min-w-0">
                  <div className="text-sm text-zinc-100">
                    {fac.name} <span className="text-[11px] text-zinc-500">声望 {rep}/5</span>
                  </div>
                  <div className="mt-0.5 text-[11px] text-zinc-500">{fac.description}</div>
                  <div className="mt-0.5 text-[11px] text-purple-300/80">
                    每级声望：{Object.entries(fac.attrPerRepLevel).map(([k, v]) => `${attrLabel(k as keyof Attributes)} +${v}`).join(' · ')}
                  </div>
                </div>
                {maxed ? (
                  <span className="rounded bg-zinc-800 px-2 py-1 text-xs text-zinc-400">已信赖</span>
                ) : (
                  <button
                    disabled={!can}
                    onClick={() => mutate((s) => investFaction(s, fac.id))}
                    className={`rounded px-3 py-1.5 text-xs font-medium ${
                      can ? 'bg-purple-700 text-white hover:bg-purple-600' : 'cursor-not-allowed bg-zinc-800 text-zinc-500'
                    }`}
                  >
                    投资 ⛁{cost}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* 驻防加成 */}
      <div className="rounded-lg border border-emerald-800/50 bg-emerald-900/20 p-4 text-sm">
        <h3 className="mb-1 text-xs uppercase tracking-wider text-emerald-300/70">驻防加成</h3>
        <div className="grid grid-cols-2 gap-2 text-zinc-300">
          <div>搜刮运势 +{(bonuses.lootLuck * 100).toFixed(0)}%</div>
          <div>改装折扣 -{(bonuses.craftDiscount * 100).toFixed(0)}%</div>

          <div>驻防恢复 +{(bonuses.recoveryBonus * 100).toFixed(0)}%</div>
          {(() => {
            const sum: Partial<Attributes> = {};
            for (const k of Object.keys(bonuses.attrBonus) as (keyof Attributes)[]) {
              sum[k] = (sum[k] ?? 0) + (bonuses.attrBonus[k] ?? 0);
            }
            for (const k of Object.keys(bonuses.factionAttrBonus) as (keyof Attributes)[]) {
              sum[k] = (sum[k] ?? 0) + (bonuses.factionAttrBonus[k] ?? 0);
            }
            const entries = (Object.keys(sum) as (keyof Attributes)[]).filter((k) => (sum[k] ?? 0) !== 0);
            if (entries.length === 0) return null;
            return (
              <div className="col-span-2 mt-1 flex flex-wrap gap-x-2 gap-y-1 text-emerald-300">
                {entries.map((k) => (
                  <span key={k}>{attrLabel(k)}+{sum[k]}</span>
                ))}
              </div>
            );
          })()}

        </div>
      </div>
    </section>
  );
}

// ===== 出击（搜打撤）=====
function SortiePanel(props: {
  state: SurvivalGameState;
  setState: React.Dispatch<React.SetStateAction<SurvivalGameState>>;
  onExit: () => void;
  run: ExtractionRunState | null;
  setRun: React.Dispatch<React.SetStateAction<ExtractionRunState | null>>;
  runRef: React.MutableRefObject<ExtractionRunState | null>;
  rngRef: React.MutableRefObject<RNG>;
  writtenRef: React.MutableRefObject<boolean>;
  syncRun: () => void;
  onAllocatePoint: (survivorId: string, attr: keyof Attributes) => void;
  onPickTrait: (survivorId: string, candidateIndex: number) => void;
  stateRef: React.MutableRefObject<SurvivalGameState>;
}) {
  const { state, setState, onExit, run, setRun, runRef, rngRef, writtenRef, syncRun, onAllocatePoint, onPickTrait, stateRef } = props;
  const active = state.survivors.find((s) => s.id === state.activeSurvivorId) ?? null;
  const [zoneId, setZoneId] = useState(DANGER_ZONES[0].id);
  const [seed, setSeed] = useState('');
  // v1.1.0：行动点实时恢复展示的本地时钟（每秒刷新，不写存档，避免高频落盘）
  const [apNow, setApNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setApNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // 系统消息日志：出现新内容时自动滚动到最新处，免去手动滑动
  const logScrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = logScrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [run ? run.log[run.log.length - 1] : undefined]);
  // 出击（run）状态已提升到 Hub 层，本组件通过 props 读写，确保「角色 / 背包」页可实时同步

  const sync = () => syncRun();

  /** 把当前 run 的结局写回归档：入库物资 + 救援者入花名册 + 回写 HP/伤势/濒死 */
  const persistRunResult = useCallback(() => {
    const s = runRef.current;
    if (!s) return;
    const prof = s.survivor.profile;
    if (!prof) return;
    // 撤离成功才入库；阵亡/失败不入库（extract 内部已按 phase 处理）
    if (s.phase === 'searching' || s.phase === 'combat') extract(s);
    // 死亡/超时结算：战局背包清零，但安全箱 100% 保留（搜打撤保底设计）
    if (s.phase === 'dead' || s.phase === 'timeout') bankSecureIntoBanked(s);
    const failed = s.phase === 'dead' || s.phase === 'timeout';
      // v1.0.4：金币获取加成（拾荒嗅觉 / 装备词条）已在「搜刮」时直接计入废土币数量，
      // 故此处只做结算文案，不再重复折算（carriedCredits 已含加成）。
      setState((prev) => {
        let next = bankLoot(prev, s.bankedLoot);
        if (!failed && s.carriedCreditsBonus > 0) {
          // 仅展示加成部分，避免金额被重复加算
          next = { ...next, log: [`【词条】拾荒嗅觉生效，搜刮废土币额外 +${s.carriedCreditsBonus}（已计入本局废土币）。`, ...next.log].slice(0, 50) };
        }
      // v1.0.4：撤离成功后，本局搜刮的直接钱财（废土币）折算入基地货币；阵亡/超时则不结算（随战局背包一起遗失）
      if (!failed && s.carriedCredits > 0) {
        const gained = s.carriedCredits;
        next = { ...next, coins: next.coins + gained };
        next = { ...next, log: [`【撤离结算】本局搜刮废土币 ×${gained} 已折算入基地货币。`, ...next.log].slice(0, 50) };
      }
      if (s.bankedNpc) next = addRecruit(next, s.bankedNpc);
      let after = applySortieResult(next, {
        survivorId: prof.id,
        survivorName: prof.name,
        zoneName: s.zone.name,
        outcome: failed ? 'death' : 'success',
        bankedItems: s.bankedLoot.reduce((a, b) => a + (b.qty ?? 1), 0),
        bankedValue: s.bankedLoot.reduce((a, b) => a + b.value * (b.qty ?? 1), 0),
        enemyFaced: s.log.find((l) => l.includes('⚔'))?.match(/【(.+?)】/)?.[1],
        rescued: !!s.bankedNpc,
        // 经验已在战斗后实时结算（doEncounter 中 grantSortieXp），此处 xpGained 置 0 避免重复入账
        xpGained: 0,
        // bug2：结算回写用「持久 baseMaxHp」，剔除临时驻防加成，避免驻防 HP 泄漏进角色档案；
        // 剩余血量封顶到 baseMaxHp（超出的部分只是本局临时驻防血量，不带回基地）。
        finalHp: Math.min(s.condition.resources.hp.current, s.baseMaxHp || s.condition.resources.hp.max || 0),
        maxHp: s.baseMaxHp || s.condition.resources.hp.max || 0,
        // bug1：把本局（含带入与战斗中产生/治愈的）伤势写回角色档案
        injuries: s.injuries,
      });
      // 撤离失败 / 阵亡 / 超时：战局背包（carriedLoot）已由 extract 拦下不入库；
      // 身上常驻穿戴的装备还要按概率被搜刮者夺走。
      if (failed) {
        after = applyFailureGearLoss(after, prof.id, rngRef.current).state;
      }
      // v1.0.3b（修订）：把本局（含副本内换上的掉落装备）的主槽装备写回角色档案，使副本内换装影响后续出击。
      // 成功撤离：把穿戴中的装备（含副本掉落品）一并入库，确保佩戴状态得以保留；
      // 撤离失败/阵亡：装备由 applyFailureGearLoss 按概率夺走，此处不再写回（避免「死了还保留装备」）。
      if (!failed) {
        const runEquipped = s.equipped ?? [];
        // 先把穿戴中的装备并入装备库（副本掉落品换上后也应带回基地），避免悬空引用
        let mergedGear = after.gear;
        for (const e of runEquipped) {
          if (!mergedGear.some((g) => g.id === e.gear.id)) mergedGear = [...mergedGear, e.gear];
        }
        const ownedIds = new Set(mergedGear.map((g) => g.id));
        const present = new Map<GearSlot, string>();
        for (const e of runEquipped) {
          if (ownedIds.has(e.gear.id)) present.set(e.slot, e.gear.id);
        }
        if (present.size > 0 || runEquipped.length > 0) {
          const slots: Record<string, string | undefined> = { ...(after.equipped[prof.id] ?? {}) };
          for (const slot of MAIN_EQUIP_SLOTS.map((sl) => sl.key)) {
            if (present.has(slot)) slots[slot] = present.get(slot);
            else delete slots[slot];
          }
          after = { ...after, gear: mergedGear, equipped: { ...after.equipped, [prof.id]: slots } };
        }
      }
      return after;
    });
  }, [setState, state, runRef, rngRef]);

  const start = () => {
    if (!active) return;
    // v1.0.11：等级门槛 —— 低于目标危险度要求等级禁止出击
    const reqLv = DANGER_LEVEL_REQ[getZone(zoneId).dangerLevel] ?? 1;
    if ((active.level ?? 1) < reqLv) return;
    // v1.0.11：濒死角色禁止出击
    const st0 = state.survivorStatus[active.id];
    if (st0?.dyingUntil && new Date(st0.dyingUntil).getTime() > Date.now()) return;
    // v1.1.0：行动点门槛 —— 先按当前时间结算恢复，不足则禁止出击（UI 也会置灰按钮）
    const apCost = sortieActionPointCost(getZone(zoneId).dangerLevel);
    if ((tickActionPoints(state, Date.now()).actionPoints ?? ACTION_POINT_CAP) < apCost) return;
    writtenRef.current = false;
    const loadout = buildSortieLoadout(state, active.id);
    if (!loadout) return;
    const zone = getZone(zoneId);
    const status = state.survivorStatus[active.id];
    const baseMax = status?.maxHp ?? 0;
    // 驻防全属性加成（避难所设施 + 势力声望）折算为气血增益：体质×20 + 耐力×3
    const garrisonBonuses = computeShelterBonuses(state.facilities, state.factionRep);
    const garrisonAttrHp =
      ((garrisonBonuses.attrBonus.vitality ?? 0) + (garrisonBonuses.factionAttrBonus.vitality ?? 0)) * 20 +
      ((garrisonBonuses.attrBonus.endurance ?? 0) + (garrisonBonuses.factionAttrBonus.endurance ?? 0)) * 3;
    // 出击前已穿戴装备（带入本局）；用于把其「完整气血贡献」从持久最大血中剥离，
    // 副本 createRun 会依据「当前实穿装备」重新累加 equippedHpBonus（含体质×20/耐力×3 + 气血词条），
    // 换装有体质词条的装备时副本最大血量才会随之变化（修复仅改气血词条才生效的问题）。
    const eqMap = state.equipped[active.id] ?? {};
    const equippedGear: GearItem[] = (Object.values(eqMap) as (string | undefined)[])
      .filter((id): id is string => !!id)
      .map((id) => state.gear.find((g) => g.id === id))
      .filter((g): g is GearItem => !!g);
    const preSortieGearHp = equippedGear.reduce(
      (sum, g) =>
        sum + ((g.modifiers?.vitality ?? 0) * 20 + (g.modifiers?.endurance ?? 0) * 3) + (g.combat?.hpBonus ?? 0),
      0,
    );
    // 彻底剥离出击前装备气血后，只剩「基础 + 特质 + 驻防」；副本起始最大血量 = 此基础 + 临时驻防气血
    const baseNoGear = Math.max(0, baseMax - preSortieGearHp);
    const startMax = baseNoGear + garrisonAttrHp;
    // 持久 HP 作为出击起始；附加词条「初始血量」头领（封顶 baseMax，不叠加装备）
    let startHp = status?.currentHp ?? 0;
    if (status && loadout.bonus) {
      const headStart = Math.round(baseMax * (loadout.bonus.startHpRatio ?? 0));
      startHp = Math.min(startHp + headStart, baseMax);
    }
    // v1.0.7：当前血进入副本 = 持久当前血 + 驻防气血，封顶为「副本最大血量」(baseMax+garrisonAttrHp)；
    // 不可封顶到 startMax（startMax 仅含基础无装备，会凭空削掉装备气血，导致 yemo 1935→1415）。
    startHp = Math.min(startHp + garrisonAttrHp, baseMax + garrisonAttrHp);
    // 护甲耐久 / 弹药由穿戴装备推算：护甲阶级→耐久，武器阶级→携弹量
    const armorGear = eqMap.armor ? state.gear.find((g) => g.id === eqMap.armor) : undefined;
    const armorMax = armorGear ? 40 + (armorGear.tier ?? 0) * 30 : 0;
    const weaponGear = eqMap.weapon ? state.gear.find((g) => g.id === eqMap.weapon) : undefined;
    const startAmmo = 24 + (weaponGear ? (weaponGear.tier ?? 0) * 8 : 0);
    // v1.0.5：本局 RNG 由种子字符串决定（同种子可复现本局分支图/撤离点/霸主）；不填则用随机种子。
    const seedInput = seed.trim();
    const seedNum = seedInput ? hashSeed(seedInput) : Math.floor(Math.random() * 2147483647);
    const runRng = seededRng(seedNum);
    const r = createRun(loadout, zone, startHp, { current: armorMax, max: armorMax }, startAmmo, {
      equipped: equippedGear,
      // bug1：把角色档案已有的伤势（debuff）一并带进本局，六维削弱与加成才会生效
      injuries: status?.injuries ?? [],
      // bug2：出击起始 maxHp = 持久 maxHp + 临时驻防加成；baseMaxHp 仅供结算回写时剔除驻防加成
      startMaxHp: startMax,
      baseMaxHp: baseMax,
      // v1.0.5：把确定性 RNG 注入建局（分支图/撤离点/霸主），并保存种子用于刷新重建
      rng: runRng,
      seed: seedNum,
    });
    // v1.0.2：快捷·投掷槽的伤害类投掷物（无 extractBonus 即手雷类）在自动战斗中概率先手引爆
    const throwId = eqMap.quickThrow;
    const throwSpec = throwId ? getThrowable(throwId) : undefined;
    if (throwId && throwSpec && !throwSpec.extractBonus && (state.throwables?.[throwId] ?? 0) > 0) {
      r.quickThrow = throwId;
    }
    runRef.current = r;
    rngRef.current = runRng;
    // v1.1.0：进图瞬间扣除行动点（不足时 trySpendActionPoints 返回 null，保持原状）
    setState((prev) => trySpendActionPoints(prev, apCost) ?? prev);
    sync();
  };

  const makeBonusLoot = (): ExtractionRunState['carriedLoot'][number] => {
    // 瞭望塔额外掉落：按当前所在区域危险度产出一件带阶级词缀的装备
    const zone = runRef.current?.zone ?? getZone(zoneId);
    return rollGearDrop(rngRef.current, zone.dangerLevel, 0.25);
  };

  const doSearch = () => {
    const s = runRef.current;
    if (!s || s.phase !== 'searching' || s.encounter || s.atExtract || s.bagFullPrompt) return;
    const lootLuck = active
      ? buildSortieLoadout(state, active.id)?.bonus.lootLuck ?? 0
      : 0;
    search(s, rngRef.current, lootLuck);
    if (s.phase !== 'searching') {
      sync();
      return;
    }
    // v1.0.5：背包已满已在引擎置位 pendingSearch，跳出搜刮流程（不触发救援 / 瞭望塔）
    if (s.bagFullPrompt) {
      sync();
      return;
    }
    if (!s.encounter) {
      // 救援事件：按概率带回幸存者（仅在未遭遇敌人的平静搜索中触发）
      if (active) {
        rollRescue(s, rngRef.current, () => generateSurvivor(rngRef.current));
      }
      // 瞭望塔：搜刮运势额外掉落（词条/装备/避难所聚合）
      if (chance(rngRef.current, lootLuck)) {
        addCarriedLoot(s, makeBonusLoot());
        s.log.push(`[${fmtClock(s.elapsedSec)}] 【系统】瞭望塔侦察生效，额外发现一批物资。`);
      }
    }
    sync();
  };

  /** v1.0.5：背包已满弹窗的「放弃 / 取消」抉择 */
  const doResolveBagFull = (mode: 'abandon' | 'cancel') => {
    const s = runRef.current;
    if (!s || !s.bagFullPrompt) return;
    resolveBagFull(s, mode, rngRef.current);
    sync();
  };

  /** 遭遇抉择：开战 / 潜行 / 投掷物脱离 / 突围撤离点 */
  const doEncounter = (action: EncounterAction) => {
    const s = runRef.current;
    if (!s || !s.encounter || s.phase !== 'searching') return;
    if (action === 'throw') {
      // 投掷物脱离：优先消耗战利品临时背包里的投掷物，其次消耗基地库存；无则不可用
      const carriedIdx = ['smoke', 'flash'].find((id) => s.carriedLoot.some((it) => it && it.id === id));
      const hasBase = (state.throwables?.smoke ?? 0) > 0 || (state.throwables?.flash ?? 0) > 0;
      if (carriedIdx === undefined && !hasBase) return;
    }
    // 新需求①：战斗后实时结算经验（含装备 xpBonus 加成），立即写入角色档案；途中升级则副本状态回复全满、伤势清除
    const xpBefore = s.xpGained ?? 0;
    resolveEncounter(s, action, rngRef.current);
    const xpDelta = (s.xpGained ?? 0) - xpBefore;
    if (xpDelta > 0 && active) {
      const special = buildSortieLoadout(state, active.id)?.bonus;
      const xpFinal = Math.round(xpDelta * (1 + (special?.xpBonus ?? 0)));
      const prev = stateRef.current;
      const prevLvl = prev.survivors.find((x) => x.id === active.id)?.level ?? 1;
      const next = grantSortieXp(prev, active.id, xpFinal);
      stateRef.current = next;
      const newLvl = next.survivors.find((x) => x.id === active.id)?.level ?? 1;
      if (newLvl > prevLvl && s && s.survivor.profile?.id === active.id) {
        // 出击途中升级 → 副本状态回复全满、伤势清除（与角色页升级一致）
        s.condition.resources.hp.current = s.condition.resources.hp.max ?? 0;
        s.injuries = [];
      }
      setState(next);
    }
    if (action === 'throw') {
      // 扣库存：先检索战利品临时背包，再检索基地库存；均优先烟雾弹、其次闪光弹
      const carriedIdx = ['smoke', 'flash']
        .map((id) => ({ id, idx: s.carriedLoot.findIndex((it) => it && it.id === id) }))
        .find((x) => x.idx >= 0);
      const rs = runRef.current;
      if (carriedIdx) {
        const it = s.carriedLoot[carriedIdx.idx];
        consumeCarriedItem(s, carriedIdx.idx);
        if (rs) {
          const name = carriedIdx.id === 'smoke' ? '烟雾弹' : '闪光弹';
          rs.log.push(`[${fmtClock(rs.elapsedSec)}] 消耗战利品背包中的【${name}】×1（投掷物脱离）。`);
        }
      } else {
        const used = (state.throwables?.smoke ?? 0) > 0 ? 'smoke' : 'flash';
        setState((prev) => ({
          ...prev,
          throwables: { ...prev.throwables, [used]: Math.max(0, (prev.throwables?.[used] ?? 0) - 1) },
        }));
        if (rs) {
          const name = used === 'smoke' ? '烟雾弹' : '闪光弹';
          rs.log.push(`[${fmtClock(rs.elapsedSec)}] 消耗【${name}】×1（基地库存同步扣减）。`);
        }
      }
    }
    sync();
  };

  const doLootCorpse = () => {
    const s = runRef.current;
    if (!s || !s.corpse || s.phase !== 'searching') return;
    lootCorpse(s, rngRef.current);
    sync();
  };

  /** v1.0.5：沿分支图移动到相邻区域（图移动模型的核心） */
  const doMoveToNode = (targetId: string) => {
    const s = runRef.current;
    if (!s || s.phase !== 'searching' || s.encounter || s.atExtract || s.bagFullPrompt) return;
    moveToNode(s, targetId, rngRef.current);
    sync();
  };

  const doLeaveExtract = () => {
    const s = runRef.current;
    if (!s || s.phase !== 'searching' || !s.atExtract) return;
    leaveExtract(s);
    sync();
  };

  const doDropCarried = (index: number) => {
    const s = runRef.current;
    if (!s || s.phase !== 'searching') return;
    dropCarried(s, index);
    sync();
  };

  const doToSecure = (index: number) => {
    const s = runRef.current;
    if (!s || s.phase !== 'searching') return;
    moveToSecure(s, index);
    sync();
  };

  const doFromSecure = (slot: number) => {
    const s = runRef.current;
    if (!s || s.phase !== 'searching') return;
    takeFromSecure(s, slot);
    sync();
  };

  /** v1.0.3 副本内换装：把临时背包里的装备穿戴上（若同槽已有装备则替换，旧装备回临时背包） */
  const doEquipCarried = (index: number) => {
    const s = runRef.current;
    if (!s || s.phase !== 'searching') return;
    // equipCarriedGear 内部会调用 recomputeRunMaxHp：hp.max 按 effectiveRunMaxHp 重算、
    // hp.current = min(hp.max, hp.current)——只改最大血，不叠加当前血。
    // v1.0.7：移除旧版「delta>0 时把 hpBonus 直接加到 current」的回血分支，防止反复穿脱气血装备回血。
    equipCarriedGear(s, index);
    sync();
  };

  /** v1.0.3 副本内卸下本局穿戴的装备（放回临时背包） */
  const doUnequipRun = (slot: GearSlot) => {
    const s = runRef.current;
    if (!s || s.phase !== 'searching') return;
    // unequipRunGear 内部会调用 recomputeRunMaxHp：hp.max 按 effectiveRunMaxHp 重算、
    // hp.current = min(hp.max, hp.current)——卸下气血装备只让 max 降低、current 跟随夹取上限。
    // v1.0.7：移除冗余的 max 重算块，避免与引擎内部状态相互覆盖。
    unequipRunGear(s, slot);
    sync();
  };

  /** 副本内使用搜到的回复类道具（绷带/急救包/血清等）：立即回血并消除对应伤势；肾上腺素单独走增益buff逻辑 */
  const applyCarriedMed = (index: number) => {
    const s = runRef.current;
    if (!s || s.phase !== 'searching') return;
    const it = s.carriedLoot[index];
    if (!it) return;
    const medId = LOOT_MEDICINE_MAP[it.id];
    const med = medId ? MEDICINES.find((m) => m.id === medId) : undefined;
    if (!med) return;
    const maxHp = s.condition.resources.hp.max ?? 0;
    const cur = s.condition.resources.hp.current;
    const canTreat = (med.treats ?? []).some((inj) => s.injuries.includes(inj));
    // v1.1.7：肾上腺素从临时背包使用也要正确激活增益buff，允许满血使用
    if (med.id === 'stim') {
      const consumed = consumeCarriedItem(s, index);
      if (!consumed) return;
      s.buffUntilSec = (s.elapsedSec ?? 0) + 600;
      s.log.push(
        `[${fmtClock(s.elapsedSec)}] 🧪 使用战利品【${it.name}】，激活肾上腺素：副本时间 10 分钟内六维全属性 +5（剩余约 10 分钟）。`,
      );
      sync();
      return;
    }
    if (cur >= maxHp && !canTreat) return;
    const heal = cur >= maxHp ? 0 : Math.round(med.healPct * maxHp) + med.healFlat;
    const consumed = consumeCarriedItem(s, index);
    if (!consumed) return;
    if (heal > 0) s.condition.resources.hp.current = Math.min(maxHp, cur + heal);
    const cured = cureInjuries(s, med.treats ?? []);
    const parts: string[] = [];
    if (heal > 0) parts.push(`恢复 ${heal} 点生命（${s.condition.resources.hp.current}/${maxHp}）`);
    if (cured.length > 0) parts.push(`消除伤势：${cured.map((i) => INJURY_LABEL[i]).join('、')}`);
    s.log.push(
      `[${fmtClock(s.elapsedSec)}] 💊 使用战利品【${it.name}】${parts.length ? '，' + parts.join('；') : '（无效果）'}。`,
    );
    sync();
  };

  /** v1.1.1② 副本内从临时背包检索使用搜到的投掷物：装入基地投掷袋（state.throwables），供 quickThrow / 投掷物脱离 使用 */
  const useCarriedThrowable = (index: number) => {
    const s = runRef.current;
    if (!s || s.phase !== 'searching') return;
    const it = s.carriedLoot[index];
    if (!it) return;
    if (!THROWABLES.some((t) => t.id === it.id)) return;
    const moved = 1;
    const consumed = consumeCarriedItem(s, index);
    if (!consumed) return;
    setState((prev) => ({
      ...prev,
      throwables: { ...(prev.throwables ?? {}), [it.id]: (prev.throwables?.[it.id] ?? 0) + moved },
    }));
    s.log.push(
      `[${fmtClock(s.elapsedSec)}] 💣 从战利品背包检索【${it.name}】×${moved}，装入投掷袋（基地投掷库存，可于战斗投掷或脱离时使用）。`,
    );
    sync();
  };

    /** v1.0.3c 出击临时制作台：判断能否用本局背包材料 + 本局废土币合成某药品 */
  const canCraftInSortie = (r: SortieCraftDef): boolean => {
    const s = runRef.current;
    if (!s || s.phase !== 'searching') return false;
    const counts: Record<string, number> = {};
    for (const it of s.carriedLoot) counts[it.id] = (counts[it.id] ?? 0) + (it.qty ?? 1);
    return (
      r.needs.every((n) => (counts[n.lootId] ?? 0) >= n.qty) && s.carriedCredits >= r.costCoins
    );
  };

  /** v1.0.3c 出击临时制作台：消耗本局背包内的材料 + 本局搜到的废土币，合成对应药品（进入临时背包，可就地使用） */
  const doCraftInSortie = (recipeId: string) => {
    const s = runRef.current;
    if (!s || s.phase !== 'searching') return;
    const r = SORTIE_MED_CRAFT.find((x) => x.id === recipeId);
    if (!r || !canCraftInSortie(r)) return;
    // 1) 按 loot id 消耗所需材料（整格/堆叠均可）
    for (const n of r.needs) {
      let remain = n.qty;
      for (let i = 0; i < s.carriedLoot.length && remain > 0; i++) {
        const it = s.carriedLoot[i];
        if (it.id !== n.lootId) continue;
        const take = Math.min(it.qty ?? 1, remain);
        it.qty = (it.qty ?? 1) - take;
        remain -= take;
      }
    }
    s.carriedLoot = s.carriedLoot.filter((it) => (it.qty ?? 1) > 0);
    // 2) 扣除本局废土币（从临时背包搜到的货币里结算）
    if (r.costCoins > 0) s.carriedCredits -= r.costCoins;
    // 3) 产出对应药品 loot（若背包格已满则顺延到下一次搜刮/撤离带回，这里忽略极端满格）
    const tpl = MED_LOOT_TEMPLATE[r.medicine];
    const medName = MEDICINES.find((m) => m.id === r.medicine)?.name ?? r.medicine;
    if (tpl) addCarriedLoot(s, { id: tpl.id, name: tpl.name, kind: 'consumable', value: tpl.value, qty: 1 });
    s.log.push(`[${fmtClock(s.elapsedSec)}] ⚗️ 临时制作台合成【${medName}】×1（消耗本局背包材料 + 废土币 ${r.costCoins}）。`);
    sync();
  };

  const doExtract = () => {
    const s = runRef.current;
    if (!s || s.phase === 'dead' || s.phase === 'extracted') return;
    // v1.0.11：boss 深7 区域撤离守卫——必须在撤离点（atExtract=true）才能撤离。
    // 修复原因：之前仅有 UI 层 disabled 拦截（被 React 渲染节流/状态时序可能绕过），
    // 逻辑层缺少 atExtract 校验，极端路径会绕过撤离条件直接结算为撤离成功。
    if (!s.atExtract) {
      s.log.push(`[${fmtClock(s.elapsedSec)}] ⛔ 此处尚未触发撤离信号——继续搜刮或击败本区霸主。`);
      sync();
      return;
    }
    extract(s);
    sync();
    // 结算（入库物资 + 救援者入花名册 + 回写 HP/濒死）由 isOver 的 useEffect 统一写入，
    // 同时覆盖「撤离成功」与「阵亡/撤离失败」两种结局，避免阵亡时漏写导致血条仍满。
  };

  /** 出击途中使用药物恢复生命——只能使用已装备到「快捷·医疗槽」的药物；可同时消除对应伤势 */
  const takeMedicine = () => {
    const s = runRef.current;
    if (!s || s.phase !== 'searching' || !active) return;
    // 仅允许使用快捷·医疗槽里装备的药品；库存不足或无装备则忽略
    const quickMedId = state.equipped[active.id]?.quickMed;
    if (!quickMedId) return;
    const spec = MEDICINES.find((m) => m.id === quickMedId);
    if (!spec) return;
    const have = state.medicines[quickMedId] ?? 0;
    if (have <= 0) return;
    const maxHp = s.condition.resources.hp.max ?? 0;
    const cur = s.condition.resources.hp.current ?? 0;
    const canTreat = (spec.treats ?? []).some((inj) => s.injuries.includes(inj));
    if (cur >= maxHp && !canTreat) return;
    const heal = cur >= maxHp ? 0 : Math.round(spec.healPct * maxHp) + spec.healFlat;
    if (heal > 0) s.condition.resources.hp.current = Math.min(maxHp, cur + heal);
    const gained = s.condition.resources.hp.current - cur;
    const cured = cureInjuries(s, spec.treats ?? []);
    const parts: string[] = [];
    if (gained > 0) parts.push(`恢复 ${gained} 生命（${s.condition.resources.hp.current}/${maxHp}）`);
    if (cured.length > 0) parts.push(`消除伤势：${cured.map((i) => INJURY_LABEL[i]).join('、')}`);
    s.log.push(`💊 使用【${spec.name}】${parts.length ? '，' + parts.join('；') : '（无效果）'}`);
    sync();
    setState((prev) => ({
      ...prev,
      medicines: { ...prev.medicines, [quickMedId]: Math.max(0, (prev.medicines[quickMedId] ?? 0) - 1) },
    }));
  };

  /** v1.1.1⑥ 使用增益补给：消耗快捷·增益槽对应的基地库存，激活「副本时间 10 分钟内六维全属性 +5」计时增益 */
  const applyBuff = () => {
    const s = runRef.current;
    if (!s || s.phase !== 'searching' || !active) return;
    const quickBuffId = state.equipped[active.id]?.quickBuff;
    if (!quickBuffId || (state.medicines[quickBuffId] ?? 0) <= 0) return;
    const spec = MEDICINES.find((m) => m.id === quickBuffId);
    // 计时窗口：当前 elapsedSec 起 10 分钟内持续生效（六维 +5 由 runEffectiveAttributes 统一注入）
    s.buffUntilSec = (s.elapsedSec ?? 0) + 600;
    s.log.push(
      `[${fmtClock(s.elapsedSec)}] 🧪 使用增益补给【${spec?.name ?? quickBuffId}】，激活肾上腺素：副本时间 10 分钟内六维全属性 +5（剩余约 10 分钟）。`,
    );
    sync();
    setState((prev) => ({
      ...prev,
      medicines: { ...prev.medicines, [quickBuffId]: Math.max(0, (prev.medicines[quickBuffId] ?? 0) - 1) },
    }));
  };

  const reset = () => {
    runRef.current = null;
    setRun(null);
    writtenRef.current = false;
    const u = getCurrentUser();
    if (u) clearRun(u);
  };

  // 出击结局统一结算：run 进入 dead / extracted 时写回归档一次。
  // 关键修复：阵亡（撤离失败）时 phase 先变 dead、summary 直接出现，不会经过 doExtract，
  // 故必须在此补写 applyNearDeath，否则战团血条仍显示出击前的满血、且再次出击也满血。
  useEffect(() => {
    const s = runRef.current;
    if (!s) return;
    if ((s.phase === 'dead' || s.phase === 'extracted') && !writtenRef.current) {
      writtenRef.current = true;
      persistRunResult();
    }
  }, [run, persistRunResult, runRef, writtenRef]);

  // v1.0.5：出击对局持久化 —— 刷新 / 重进不退出出击
  // 挂载时尝试恢复进行中的对局（仅当本地尚无进行中 run 时，避免覆盖刚开的新局）
  useEffect(() => {
    if (runRef.current) return;
    const u = getCurrentUser();
    if (!u) return;
    const saved = loadRun(u);
    if (saved && (saved.phase === 'searching' || saved.phase === 'combat')) {
      runRef.current = saved;
      rngRef.current = seededRng(saved.rngSeed);
      writtenRef.current = false;
      sync();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 进行中的对局：每次状态变化后落盘（刷新后可重建）；终局由结算 effect 写回归档并清理
  useEffect(() => {
    const u = getCurrentUser();
    if (!u || !run) return;
    if (run.phase === 'dead' || run.phase === 'extracted' || run.phase === 'timeout') {
      clearRun(u);
      return;
    }
    saveRun(u, run);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run]);

  if (!active) {
    return (
      <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-6 text-center text-zinc-400">
        请先在「角色」中选择一名出击幸存者。
      </div>
    );
  }

  // hp/armor 为战斗引擎状态对象（非 React ref），用 ?? 0 兜底可选字段
  const hp = run?.condition.resources.hp;
  const hpCur = hp?.current ?? 0;
  const hpMax = hp?.max ?? 0;
  const armor = run?.armor;
  const armorCur = armor?.current ?? 0;
  const armorMax = armor?.max ?? 0;
  const carried = run?.carriedLoot ?? [];
  const carriedSorted = carried
    .map((it, idx) => ({ it, idx }))
    .sort((a, b) => {
      const rank = (k: string) => (k === 'consumable' ? 0 : k === 'material' ? 1 : k === 'gear' ? 2 : 3);
      const ra = rank(a.it.kind), rb = rank(b.it.kind);
      if (ra !== rb) return ra - rb;
      if (a.it.kind === 'gear' && b.it.kind === 'gear') return (b.it.tier ?? 0) - (a.it.tier ?? 0);
      return (a.it.name ?? '').localeCompare(b.it.name ?? '');
    })
    .map((x) => ({ item: x.it, index: x.idx }));
  // v1.0.4：携带估值仅统计战局背包内的物资（材料/装备/药品等）；废土币为单独直接钱财，已在独立行展示，不计入此处估值
  const carriedValue = carried.reduce((a, b) => a + b.value * (b.qty ?? 1), 0);
  const banked = run?.bankedLoot ?? [];
  const bankedValue = banked.reduce((a, b) => a + b.value * (b.qty ?? 1), 0);
  const bankedQty = banked.reduce((a, b) => a + (b.qty ?? 1), 0);
  // 出击途中可使用的药物：仅限已装备到「快捷·医疗槽」的那种（且基地库存 > 0）
  const quickMedId = active ? state.equipped[active.id]?.quickMed : undefined;
  const equippedMed = quickMedId ? MEDICINES.find((m) => m.id === quickMedId) : undefined;
  const availableMeds =
    quickMedId && equippedMed && (state.medicines[quickMedId] ?? 0) > 0 ? [equippedMed] : [];
  // v1.0.2 增益补给：快捷·增益槽 + 基地库存 > 0 时可在出击途中使用
  const quickBuffId = active ? state.equipped[active.id]?.quickBuff : undefined;
  const buffSpec = quickBuffId ? MEDICINES.find((m) => m.id === quickBuffId) : undefined;
  const buffStock = quickBuffId ? state.medicines[quickBuffId] ?? 0 : 0;
  const buffRemainMin = run?.buffUntilSec ? Math.max(0, Math.ceil((run.buffUntilSec - (run.elapsedSec ?? 0)) / 60)) : 0;
  const isOver = run?.phase === 'dead' || run?.phase === 'extracted' || run?.phase === 'timeout';
  const failed = run?.phase === 'dead' || run?.phase === 'timeout';
  /** ⚔ 摘要行下标 → 战斗回放（日志行内展开用） */
  const battleByLogIndex = new Map((run?.battles ?? []).map((b) => [b.logIndex, b]));
  // v1.1.2：群怪战斗回放合并——把同一敌群（groupTotal>1 且顺序连续）的逐只回放收拢为一个可折叠「敌群战斗回放」
  const renderReplayBody = (b: BattleReplayEntry) => (
    <div className="mt-1.5 space-y-1.5">
      {b.attrNotes.length > 0 && (
        <div className="rounded bg-zinc-900/70 p-1.5">
          <div className="mb-0.5 text-[10px] uppercase tracking-wider text-zinc-500">六维属性与战斗</div>
          {b.attrNotes.map((n, ni) => (
            <p key={ni} className="text-[11px] text-sky-300/90">◈ {n}</p>
          ))}
        </div>
      )}
      {b.rounds.map((r) => (
        <div key={r.round} className="rounded bg-zinc-900/50 p-1.5">
          <div className="flex items-center justify-between text-[10px] text-zinc-500">
            <span>第 {r.round} 回合</span>
            <span className="font-mono">❤ 你 {r.hpSelf} ｜ 敌 {r.hpEnemy}</span>
          </div>
          <p className="mt-0.5 text-[11px] leading-relaxed text-zinc-300">{r.text}</p>
        </div>
      ))}
      <p className="rounded border-l-2 border-rose-700/60 bg-zinc-900/60 p-1.5 text-[11px] italic leading-relaxed text-zinc-300">{b.narrative}</p>
    </div>
  );
  const battleGroups: { entries: BattleReplayEntry[]; containerLogIndex: number }[] = [];
  {
    let cur: BattleReplayEntry[] | null = null;
    for (const b of run?.battles ?? []) {
      if (b.groupTotal && b.groupTotal > 1) {
        if (cur && cur[0].groupTotal === b.groupTotal && cur[cur.length - 1].groupIndex === (b.groupIndex ?? 0) - 1) {
          cur.push(b);
        } else {
          if (cur) battleGroups.push({ entries: cur, containerLogIndex: cur[0].logIndex });
          cur = [b];
        }
      } else {
        if (cur) { battleGroups.push({ entries: cur, containerLogIndex: cur[0].logIndex }); cur = null; }
        battleGroups.push({ entries: [b], containerLogIndex: b.logIndex });
      }
    }
    if (cur) battleGroups.push({ entries: cur, containerLogIndex: cur[0].logIndex });
  }
  const groupContainerByLogIndex = new Map<number, BattleReplayEntry[]>();
  const groupSuppress = new Set<number>();
  for (const g of battleGroups) {
    if (g.entries.length > 1) {
      groupContainerByLogIndex.set(g.containerLogIndex, g.entries);
      for (let k = 1; k < g.entries.length; k++) groupSuppress.add(g.entries[k].logIndex);
    }
  }
  const hpPct = hpMax > 0 ? Math.max(0, (hpCur / hpMax) * 100) : 0;
  const hpStageNow = hpStage(hpPct);
  const hpMeta = HP_STAGE_META[hpStageNow];
  // v1.0.3 本局有效六维 / 基础六维（伤势削减对照，用于红色呈现被削弱的属性）
  const effAttrs = run ? runEffectiveAttributes(run) : null;
  const baseAttrs = run
    ? run.baseAttributes ?? run.survivor.profile?.attributes ?? run.survivor.attributes
    : null;
  // 六维分解（基础值 / 加成值 / 减损值），供 attrBars 新格式展示
  const sortieSixReduction = run && baseAttrs ? injuryReduction(baseAttrs, run.injuries) : {};
  const sortieSixBonus: Partial<Attributes> = {};
  if (effAttrs && baseAttrs) {
    for (const k of ALL_ATTR_KEYS) {
      sortieSixBonus[k] = (effAttrs[k] ?? baseAttrs[k]) - (baseAttrs[k] ?? 0) + (sortieSixReduction[k] ?? 0);
    }
  }
  // 驻防「每属性 +N」：取 attrBonus 所有非零项的最小值，代表每个属性至少 +N。
  // 例：训练场 Lv5（六维各+1）→ min=5，「每属性 +5」（不堆成"全属性+30"）。
  const garrisonBonusPerAttr = run
    ? (() => {
        const gb = computeShelterBonuses(state.facilities, state.factionRep);
        const vals = (Object.keys(gb.attrBonus) as (keyof Attributes)[])
          .map((k) => gb.attrBonus[k] ?? 0)
          .filter((v) => v > 0);
        return vals.length === 0 ? 0 : Math.min(...vals);
      })()
    : 0;
  // 对局状态栏派生值
  const left = run ? timeLeft(run) : 0;
  const urgent = left > 0 && left <= RUN_TIME_LIMIT_SEC * 0.2;
  const searchLeft = run ? zoneSearchLeft(run) : 0;
  const usedSearches = run ? run.zoneSearches[run.zone.id] ?? 0 : 0;
  const secureUsed = run ? run.secureBox.filter((x) => x !== null).length : 0;
  // v1.1.6：投掷物脱离可用总量 = 基地库存 + 战利品临时背包，先消耗临时背包里的投掷物
  const baseThrowableStock = (state.throwables?.smoke ?? 0) + (state.throwables?.flash ?? 0);
  const carriedThrowableStock = run
    ? run.carriedLoot.reduce(
        (sum, it) =>
          sum + (it && (it.id === 'smoke' || it.id === 'flash') ? (it.qty ?? 1) : 0),
        0,
      )
    : 0;
  const throwableStock = baseThrowableStock + carriedThrowableStock;
  // v1.0.5：威胁档 / 区域图派生展示
  const tier = run ? threatTierOf(run.elapsedSec) : 0;
  const tierDef = THREAT_TIERS[tier];
  const extractNames = run
    ? run.graph.extractZones
        .map((id) => {
          const n = run.graph.nodes.find((nn) => nn.id === id);
          return n ? `${n.name} 深${n.depth}` : id;
        })
        .join('、')
    : '';
  const curNode = run ? currentZoneOf(run) : null;

  const sortieBonus = active ? buildSortieLoadout(state, active.id)?.bonus : undefined;
  const activeStatus = active ? state.survivorStatus[active.id] : undefined;
  const activeDying = !!activeStatus?.dyingUntil;
  const selReqForSortie = DANGER_LEVEL_REQ[getZone(zoneId).dangerLevel] ?? 1;
  const selLocked = (active.level ?? 1) < selReqForSortie;
  // v1.1.0：行动点展示（apNow 每秒刷新，不写存档）
  const apView = actionPointView(state, apNow);
  const apCost = sortieActionPointCost(getZone(zoneId).dangerLevel);
  const apLocked = apView.current < apCost;
  const apRemainClock = `${Math.floor(apView.remainMs / 60000)}:${String(
    Math.floor((apView.remainMs % 60000) / 1000),
  ).padStart(2, '0')}`;

  return (
    <section className="space-y-4">
      {!run && (
        <div className="space-y-4 rounded-lg border border-zinc-800 bg-zinc-900 p-5">
          <div className="text-sm text-zinc-400">
            出击者：<span className="text-zinc-100">{active.name}</span>
            <span
              className="ml-2 rounded-full border px-1.5 py-0.5 text-xs font-semibold"
              style={{ color: tierColor(active.tier - 1), borderColor: `${tierColor(active.tier - 1)}66`, background: `${tierColor(active.tier - 1)}1a` }}
            >
              {tierNameFromTier(active.tier)}
            </span>
          </div>
          {/* v1.1.0：行动点（出击消耗 / 每 5 分钟恢复 1 点） */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded border border-zinc-800 bg-zinc-950 px-3 py-2 text-xs">
            <span className="text-zinc-400">
              ⚡ 行动点{' '}
              <span
                className={`font-mono text-sm font-semibold ${
                  apView.full ? 'text-emerald-400' : 'text-amber-400'
                }`}
              >
                {apView.current}
              </span>
              <span className="text-zinc-600"> / {apView.cap}</span>
            </span>
            <span className="text-zinc-500">
              {apView.full ? '已满（暂停恢复）' : `下一点 ${apRemainClock} 后 · 每 5 分钟 +1`}
            </span>
            <span className="ml-auto text-zinc-400">
              本次出击消耗 <span className="font-mono text-amber-300">{apCost}</span> 点
            </span>
          </div>
          {activeDying && (
            <div className="rounded border border-rose-700 bg-rose-950/40 px-3 py-2 text-xs text-rose-200">
              ⚠ 该成员正处于濒死状态，请先在「战团成员」中用货币或医疗品救治，再出击。
            </div>
          )}
          {sortieBonus && (
            <div className="flex flex-wrap gap-2 text-xs">
              <span className="rounded bg-sky-900/40 px-2 py-1 text-sky-300">
                搜刮加成 +{Math.round(sortieBonus.lootLuck * 100)}%
              </span>
              <span className="rounded bg-emerald-900/40 px-2 py-1 text-emerald-300">
                经验加成 +{Math.round((sortieBonus.xpBonus ?? 0) * 100)}%
              </span>
              <span className="rounded bg-amber-900/40 px-2 py-1 text-amber-300">
                金币加成 +{Math.round((sortieBonus.coinBonus ?? 0) * 100)}%
              </span>
            </div>
          )}
          <div>
            <h2 className="mb-2 text-sm font-medium text-zinc-300">选择危险区域</h2>
            <div className="grid gap-2 sm:grid-cols-2">
              {DANGER_ZONES.map((z) => (
                <button
                  key={z.id}
                  onClick={() => setZoneId(z.id)}
                  disabled={(active.level ?? 1) < (DANGER_LEVEL_REQ[z.dangerLevel] ?? 1)}
                  title={(active.level ?? 1) < (DANGER_LEVEL_REQ[z.dangerLevel] ?? 1) ? `需等级 Lv.${DANGER_LEVEL_REQ[z.dangerLevel] ?? 1} 才能进入（当前 Lv.${active.level ?? 1}）` : undefined}
                  className={`rounded-lg border p-3 text-left transition ${
                    (active.level ?? 1) < (DANGER_LEVEL_REQ[z.dangerLevel] ?? 1)
                      ? 'cursor-not-allowed border-zinc-800 bg-zinc-900 opacity-50'
                      : zoneId === z.id
                        ? 'border-emerald-500 bg-emerald-500/10'
                        : 'border-zinc-700 hover:border-zinc-500'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="font-medium text-zinc-100">{z.name}</span>
                    <span className="flex items-center gap-1">
                      {(DANGER_LEVEL_REQ[z.dangerLevel] ?? 1) > 1 && (
                        <span className={`rounded px-1.5 py-0.5 text-[11px] ${(active.level ?? 1) < (DANGER_LEVEL_REQ[z.dangerLevel] ?? 1) ? 'bg-rose-900/60 text-rose-300' : 'bg-zinc-800 text-zinc-400'}`}>
                          需 Lv.{(DANGER_LEVEL_REQ[z.dangerLevel] ?? 1)}
                        </span>
                      )}
                      <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-amber-300">
                        {DANGER_LABEL[z.dangerLevel] ?? `危${z.dangerLevel}`}
                      </span>
                      <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[11px] text-sky-300">
                        ⚡{sortieActionPointCost(z.dangerLevel)}
                      </span>
                    </span>
                  </div>
                  <p className="mt-1 text-xs leading-5 text-zinc-500">{z.flavor}</p>
                </button>
              ))}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <label className="text-sm text-zinc-400">随机种子（可选，同种子可复现）</label>
            <input
              value={seed}
              onChange={(e) => setSeed(e.target.value)}
              placeholder="例如 42"
              className="w-32 rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm text-zinc-200 outline-none focus:border-emerald-500"
            />
            <button
              onClick={start}
              disabled={selLocked || activeDying || apLocked}
              className="ml-auto rounded-lg bg-emerald-600 px-6 py-2.5 font-medium text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-400"
            >
              出击 ▶
            </button>
          </div>
          {selLocked && (
            <p className="text-xs text-rose-300">⚠ 等级不足：进入「{getZone(zoneId).name}」需 Lv.{selReqForSortie}（当前 Lv.{active.level ?? 1}）。</p>
          )}
          {activeDying && (
            <p className="text-xs text-rose-300">⚠ 你正处于濒死状态，无法出击，请先在「战团成员」中救治。</p>
          )}
          {apLocked && !selLocked && !activeDying && (
            <p className="text-xs text-rose-300">
              ⚠ 行动点不足：本次需 {apCost} 点，当前 {apView.current} 点（每 5 分钟恢复 1 点，上限 {apView.cap}）。
            </p>
          )}
        </div>
      )}

      {run && (
        <>
          {/* ① 对局状态栏（常驻：v1.0.12 紧凑化）—— 时间+携带估值同行；位置/撤离/威胁/安全箱成行；生命/经验 同尺寸 2 列；护甲/弹药/负重 3 列；6 维 + buff + 自由点 + 词条三选一 全部并入主面板，去掉独立蓝框 */}
          <div className="sticky top-0 z-20 rounded-lg border border-zinc-800 bg-zinc-900 p-3">
            {/* Row 1：对局剩余（左） + 携带估值（右） */}
            <div className="flex items-center justify-between text-xs">
              <span className="text-zinc-400">
                ⏱ 对局剩余{' '}
                <span className={`font-mono text-sm font-semibold ${urgent ? 'text-rose-400' : 'text-emerald-400'}`}>
                  {fmtClock(left)}
                </span>
                <span className="text-zinc-600"> / {fmtClock(RUN_TIME_LIMIT_SEC)}</span>
              </span>
              <span className="text-zinc-400">
                💰 携带估值 <span className="font-semibold text-emerald-400">{carriedValue}</span> 废土币
              </span>
            </div>
            {/* Row 2：位置 / 撤离 / 威胁 / 安全箱 —— 紧凑单行 */}
            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
              <span className="text-zinc-400">
                📍 <span className="text-zinc-100">{run.zone.name}</span>
                <span className="ml-1 rounded bg-zinc-800 px-1.5 py-0.5 text-[11px] text-amber-300">
                  {DANGER_LABEL[run.zone.dangerLevel] ?? `危${run.zone.dangerLevel}`}
                </span>
                <span className="ml-1 rounded bg-zinc-800 px-1.5 py-0.5 text-[11px] text-emerald-300">
                  深度 {curNode?.depth ?? 1}
                </span>
                <span className="ml-1 text-zinc-500">
                  搜刮 {usedSearches}/{MAX_ZONE_SEARCHES}
                </span>
              </span>
              <span className="text-zinc-400">
                🚁 撤离点：
                <span className={run.atExtract ? 'text-emerald-300' : 'text-sky-300'}>
                  {run.extractRevealed ? (run.atExtract ? '已抵达' : '已开启') : '未显形（约第5分钟 / 搜满3区）'}
                </span>
              </span>
              <span className="text-zinc-400">
                🔥 威胁：
                <span style={{ color: tierDef.color }}>{tierDef.label}</span>
              </span>
            </div>
            {/* Row 3：生命 / 等级·经验 —— 同尺寸 2 列（同为 h-2 bar） */}
            <div className="mt-2.5 grid grid-cols-2 gap-3 text-xs">
              <div>
                <div className="mb-1 flex justify-between text-zinc-500">
                  <span>❤ 生命 <span className={hpMeta.text}>{hpMeta.label}</span></span>
                  <span className="text-zinc-200">{hpCur} / {hpMax}</span>
                </div>
                <div className="h-2 overflow-hidden rounded bg-zinc-800">
                  <div className={`h-full ${hpMeta.bar} transition-all`} style={{ width: `${hpPct}%` }} />
                </div>
              </div>
              <div>
                <div className="mb-1 flex justify-between text-sky-300">
                  <span>⬆ Lv.{active.level ?? 1} <span className="ml-1 text-zinc-400">经验 {(active.xp ?? 0)} / {xpNeededForLevel(active.level ?? 1)}</span></span>
                  {/* v1.0.12 补充：「自由点 ×N」徽标已挪到下方「分配自由属性点 ×N」标签里，避免重复 */}
                </div>
                <div className="h-2 overflow-hidden rounded bg-zinc-800">
                  <div
                    className="h-full bg-sky-500/70 transition-all"
                    style={{ width: `${Math.min(100, ((active.xp ?? 0) / xpNeededForLevel(active.level ?? 1)) * 100)}%` }}
                  />
                </div>
              </div>
            </div>
            {/* Row 4：护甲 / 弹药 / 负重 / 安全箱 —— 4 列纵向 stack（手机端防折行对齐，v1.0.12 补充） */}
            <div className="mt-2 grid grid-cols-4 gap-2 text-xs">
              <div className="flex flex-col items-start">
                <span className="text-zinc-500">🛡 护甲</span>
                <span className="text-zinc-200">{armorCur} / {armorMax}</span>
              </div>
              <div className="flex flex-col items-start">
                <span className="text-zinc-500">🔫 弹药</span>
                <span className={run.ammo >= FIGHT_AMMO_COST ? 'text-zinc-200' : 'text-rose-400'}>
                  {run.ammo} 发
                </span>
              </div>
              <div className="flex flex-col items-start">
                <span className="text-zinc-500">🎒 负重</span>
                <span className="text-zinc-200">{carried.length} / {runPackCapacity(run)}</span>
              </div>
              <div className="flex flex-col items-start">
                <span className="text-zinc-500">📦 安全箱</span>
                <span className="text-amber-300">{secureUsed}/{SECURE_BOX_SLOTS}</span>
              </div>
            </div>

            {/* 角色属性 / 增益 / 伤势 —— v1.0.12 整合进主面板，去掉独立蓝框 */}
            {effAttrs && baseAttrs && (
              <div className="mt-2.5 space-y-1.5 border-t border-sky-900/40 pt-2">
                <div className="scale-[0.92] origin-left">{attrBars(baseAttrs, sortieSixBonus, sortieSixReduction)}</div>
                <div className="flex flex-wrap items-center gap-1 text-[10px]">
                  {garrisonBonusPerAttr > 0 && (
                    <span className="rounded bg-emerald-900/40 px-2 py-0.5 text-emerald-300" title="避难所设施提供的属性加成（取每属性的最小值，已并入有效六维）">
                      🏰 驻防·全属性+{garrisonBonusPerAttr}
                    </span>
                  )}
                  {FACTIONS.filter((fac) => (state.factionRep[fac.id] ?? 0) > 0).map((fac) => (
                    <span key={fac.id} className="rounded bg-purple-900/40 px-2 py-0.5 text-purple-300" title="势力声望提供的全属性加成（已并入有效六维）">
                      🤝 {fac.name} Lv{state.factionRep[fac.id]}
                    </span>
                  ))}
                  <span
                    className={
                      buffRemainMin > 0
                        ? "rounded bg-sky-900/40 px-2 py-0.5 text-sky-300"
                        : "rounded bg-zinc-800 px-2 py-0.5 text-zinc-500"
                    }
                    title="肾上腺素生效中：副本时间 10 分钟内六维全属性 +5"
                  >
                    🧪 增益 buff · 剩余 {buffRemainMin} 分钟
                  </span>
                  {run.injuries.length > 0 ? (
                    <>
                      <span className="text-zinc-500">伤势：</span>
                      {run.injuries.map((inj) => (
                        <span
                          key={inj}
                          className="rounded border border-rose-800/60 bg-rose-950/30 px-2 py-0.5 text-rose-300"
                          title={injuryAttrTextOf(run, inj)}
                        >
                          ⚠ {INJURY_LABEL[inj]} · {injuryAttrTextOf(run, inj)}
                        </span>
                      ))}
                    </>
                  ) : (
                    <span className="rounded bg-zinc-800 px-2 py-0.5 text-zinc-500">无伤势 debuff</span>
                  )}
                </div>
              </div>
            )}

            {(active.freePoints ?? 0) > 0 && (
              <div className="mt-2">
                <div className="mb-1 text-[10px] text-zinc-500">分配自由属性点 ×{active.freePoints ?? 0}（每点 +1，出击途中即时生效）：</div>
                <div className="flex flex-wrap gap-1">
                  {(Object.keys(active.attributes) as (keyof Attributes)[]).map((k) => (
                    <button
                      key={k}
                      onClick={() => onAllocatePoint(active.id, k)}
                      className="rounded border border-amber-700/60 px-1.5 py-0.5 text-[10px] text-amber-200 hover:bg-amber-900/40"
                    >
                      {attrLabel(k)} +1
                    </button>
                  ))}
                </div>
              </div>
            )}
            {(active.pendingTraitPick ?? []).length > 0 && (() => {
              const cands = active.pendingTraitPick!;
              const set = cands[0];
              const remaining = cands.length;
              return (
                <div className="mt-2 rounded border border-purple-800/60 bg-purple-950/20 p-2">
                  <div className="text-[11px] text-purple-300">
                    🔗【系统】检测到宿主等级提升……请选择词条强化
                    {remaining > 1 ? `（剩余 ${remaining} 组，三选一）` : '（三选一）'}：
                  </div>
                  <div className="mt-1.5 grid gap-1.5 sm:grid-cols-3">
                    {set.map((t, i) => (
                      <button
                        key={`${t.id}-0-${i}`}
                        onClick={() => onPickTrait(active.id, i)}
                        className="rounded border p-2 text-left transition hover:bg-zinc-800/60"
                        style={{ borderColor: affixColor(t.quality) }}
                      >
                        <div className="text-xs font-medium" style={{ color: affixColor(t.quality) }}>
                          {affixLabel(t.quality)}·{t.name}
                        </div>
                        <div className="mt-0.5 text-[10px] leading-snug text-zinc-400">{t.description}</div>
                        {(() => {
                          const modsTxt = (Object.keys(t.modifiers) as (keyof Attributes)[])
                            .filter((k) => (t.modifiers[k] ?? 0) !== 0)
                            .map((k) => `${attrLabel(k)}+${t.modifiers[k]}`)
                            .join(' ');
                          const combatTxt = [
                            t.combat?.hpBonus ? `气血+${t.combat.hpBonus}` : '',
                            t.combat?.critBonus ? `暴击+${Math.round(t.combat.critBonus * 100)}%` : '',
                            t.combat?.lootLuck ? `搜刮+${Math.round(t.combat.lootLuck * 100)}%` : '',
                            t.combat?.startHpRatio ? `初始血量+${Math.round(t.combat.startHpRatio * 100)}%` : '',
                          ].filter(Boolean).join(' ');
                          return (
                            <>
                              {modsTxt && (
                                <div className="mt-0.5 text-[10px] text-emerald-300">属性加成：{modsTxt}</div>
                              )}
                              {combatTxt && (
                                <div className="mt-0.5 text-[10px] text-sky-300">增益效果：{combatTxt}</div>
                              )}
                            </>
                          );
                        })()}
                      </button>
                    ))}
                  </div>
                </div>
              );
            })()}
          </div>

          {/* v1.0.5：背包已满弹窗（放弃 / 取消 抉择） */}
          {run.bagFullPrompt && !isOver && (
            <div className="rounded-lg border border-amber-700 bg-amber-950/30 p-4">
              <h2 className="mb-1 text-sm font-semibold text-amber-300">🎒 背包已满！</h2>
              <p className="mb-3 text-xs text-zinc-300">
                本轮搜刮翻出了物资却装不下了。可【放弃本轮拾取】（时间照耗、弹药与废土币照常获得），或【取消】（腾出空间后重新点击搜索）。
              </p>
              <div className="grid gap-2 sm:grid-cols-2">
                <button
                  onClick={(e) => { doResolveBagFull('cancel'); e.currentTarget.blur(); }}
                  className="rounded-lg border border-zinc-600 px-4 py-3 text-sm text-zinc-200 hover:bg-zinc-800"
                >
                  ↩ 取消（保留本轮，去清背包）
                </button>
                <button
                  onClick={(e) => { doResolveBagFull('abandon'); e.currentTarget.blur(); }}
                  className="rounded-lg bg-amber-700 px-4 py-3 font-medium text-white hover:bg-amber-600"
                >
                  🗑 放弃本轮拾取
                </button>
              </div>
            </div>
          )}

          {/* v1.0.12：场景 + 系统消息日志 整合为单一紧凑面板。
              场景限高 3 行（line-clamp-3），日志限高 112px，字号统一 9~10px，内边距收紧 —— 整体占比更小。 */}
          <div className="rounded-lg border border-sky-900/50 bg-zinc-950/70">
            <div className="border-b border-sky-900/40 px-2.5 py-1.5">
              <div className="mb-0.5 text-[9px] uppercase tracking-wider text-sky-500/60">场景</div>
              <pre className="line-clamp-3 whitespace-pre-wrap font-mono text-[10px] leading-tight text-sky-100/90">
                {run.scene}
              </pre>
            </div>
            <div className="px-2.5 py-1.5">
              <div className="mb-1 text-[9px] uppercase tracking-wider text-zinc-500">系统消息</div>
              <div ref={logScrollRef} className="max-h-[112px] space-y-0.5 overflow-y-auto pr-1 font-mono text-[9px] leading-snug">
                {run.log.map((line, i) => {
                  const m = line.match(/^\[(\d{2}:\d{2})\]\s*/);
                  const body = m ? line.slice(m[0].length) : line;
                  const tone =
                    body.startsWith('⚔') || body.startsWith('⚠') || body.startsWith('⏰')
                      ? 'text-rose-300'
                      : body.startsWith('✔') || body.startsWith('🚁') || body.startsWith('❗')
                        ? 'text-emerald-300'
                        : body.startsWith('【系统】') || body.startsWith('【生存系统】')
                          ? 'text-sky-300'
                          : 'text-zinc-400';
                  const battle = battleByLogIndex.get(i);
                  return (
                    <div key={i}>
                      <p className={tone}>
                        {m && <span className="mr-1 text-zinc-600">[{m[1]}]</span>}
                        {body}
                      </p>
                      {battle && groupSuppress.has(i) ? null : battle && groupContainerByLogIndex.has(i) ? (() => {
                        const entries = groupContainerByLogIndex.get(i)!;
                        const total0 = entries.length;
                        const sumRounds = entries.reduce((a, b) => a + b.rounds.length, 0);
                        const sumDealt = entries.reduce((a, b) => a + b.dmgDealt, 0);
                        const sumTaken = entries.reduce((a, b) => a + b.dmgTaken, 0);
                        const allWin = entries.every((b) => b.win);
                        const lastEntry = entries[entries.length - 1];
                        const lastHp = lastEntry.rounds[lastEntry.rounds.length - 1]?.hpSelf ?? 0;
                        return (
                          <details className="my-1 rounded border border-rose-900/60 bg-rose-950/10 px-2 py-1">
                            <summary className="cursor-pointer select-none text-[11px] text-rose-300/90 hover:text-rose-200">
                              📊 展开敌群战斗回放（共 {total0} 只 · 总回合 {sumRounds} · 输出 {sumDealt} / 承伤 {sumTaken}
                              {allWin ? ' · 全歼' : ' · 阵亡'}）
                            </summary>
                            <div className="mt-1 space-y-2">
                              {entries.map((b) => (
                                <div key={b.logIndex} className="rounded border border-zinc-800 bg-zinc-900/40 p-1.5">
                                  <div className="mb-1 text-[11px] font-medium text-rose-200/90">
                                    第 {b.groupIndex}/{b.groupTotal} 只：【{b.enemyName}】{b.win ? ' ✓ 击倒' : ' ✗ 阵亡'}
                                  </div>
                                  {renderReplayBody(b)}
                                </div>
                              ))}
                              <div className="rounded bg-zinc-900/70 p-1.5 text-[10px] leading-relaxed text-zinc-400">
                                ⚔ 敌群合计 {total0} 只，{allWin ? '全部放倒' : '未能全歼'}；累计输出 {sumDealt} / 承伤 {sumTaken}
                                {lastHp > 0 ? `，残血 ${lastHp}` : ''}。
                              </div>
                            </div>
                          </details>
                        );
                      })() : battle && (
                        <details className="my-1 rounded border border-rose-900/60 bg-rose-950/10 px-2 py-1">
                          <summary className="cursor-pointer select-none text-[11px] text-rose-300/90 hover:text-rose-200">
                            📊 展开战斗回放（{battle.rounds.length} 回合 · 输出 {battle.dmgDealt} / 承伤 {battle.dmgTaken}
                            {battle.win ? ' · 胜利' : ' · 战败'}）
                          </summary>
                          {renderReplayBody(battle)}
                        </details>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>





          {isOver && (
            <div
              className={`rounded-lg border p-5 ${
                failed ? 'border-rose-800 bg-rose-900/30' : 'border-emerald-700 bg-emerald-900/30'
              }`}
            >
              <h2 className={`mb-1 text-lg font-semibold ${failed ? 'text-rose-300' : 'text-emerald-300'}`}>
                {run.phase === 'extracted'
                  ? '✔ 撤离成功'
                  : run.phase === 'timeout'
                    ? '⏰ 时间耗尽 · 未能撤离'
                    : '✘ 撤离失败 · 幸存者濒死'}
              </h2>
              <p className="mb-3 text-sm text-zinc-300">
                {run.phase === 'extracted'
                  ? `撤离结算：本局搜刮废土币 ×${run.carriedCredits} 已 1:1 折算入基地货币；带回物资估值 ⛁${bankedValue}（入库为材料/装备/药品，需贩卖/回收才折算为废土币）。`
                  : run.phase === 'timeout'
                    ? `对局时间耗尽，救援未能抵达。未撤离的 ${carriedValue} 废土币物资已遗失（安全箱 ${secureUsed} 格物资已保底入库）；${active?.name ?? '出击者'} 重伤濒死，需在战团中救治。`
                    : `未撤离的 ${carriedValue} 废土币物资已遗失（安全箱 ${secureUsed} 格物资已保底入库）；${active?.name ?? '出击者'} 重伤濒死，需在战团中用货币或医疗品救治，否则将离世。`}
              </p>
              {activeDying && (
                <p className="mb-3 text-sm text-rose-300">⚠ 你正处于濒死状态，无法再次出击。请在「战团成员」中用货币或医疗品救治后再战。</p>
              )}
              <div className="flex gap-3">
                <button
                  onClick={start}
                  disabled={activeDying}
                  title={activeDying ? '当前角色处于濒死状态，无法再次出击，请先救治' : undefined}
                  className="flex-1 rounded-lg bg-emerald-600 px-4 py-3 font-medium text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-400"
                >
                  再次出击
                </button>
                <button
                  onClick={() => {
                    // 兜底：若 effect 尚未写回归档（极端时序），先补写再退出
                    const s = runRef.current;
                    if (s && (s.phase === 'dead' || s.phase === 'extracted' || s.phase === 'timeout') && !writtenRef.current) {
                      persistRunResult();
                    }
                    reset();
                    onExit();
                  }}
                  className="rounded-lg border border-zinc-700 px-4 py-3 text-zinc-300 hover:bg-zinc-800"
                >
                  返回
                </button>
              </div>
            </div>
          )}

          {/* ③ 操作按钮组：遭遇抉择 / 撤离点抉择 / 常规行动（三态互斥） */}
          {run.encounter ? (
            <div className="rounded-lg border border-rose-800 bg-rose-950/20 p-4">
              <h2 className="mb-1 text-sm font-semibold text-rose-300">⚠️ 遭遇敌人 —— 必须做出抉择</h2>
              <div className="mb-3 text-xs text-zinc-400">
                【{run.encounter.enemy.name}】
                {run.encounter.enemy.threatNote ? ` · ${run.encounter.enemy.threatNote}` : ''}
                {run.encounter.enemy.affixes && run.encounter.enemy.affixes.length > 0 && (
                  <span className="ml-2">
                    {run.encounter.enemy.affixes.map((a, i) => (
                      <span key={i} className="mr-1 rounded px-1" style={{ color: a.color }}>
                        {a.label}
                      </span>
                    ))}
                  </span>
                )}
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                <button
                  onClick={(e) => { doEncounter('fight'); e.currentTarget.blur(); }}
                  className="rounded-lg bg-rose-700 px-4 py-3 text-sm font-medium text-white hover:bg-rose-600"
                >
                  ⚔ 主动开战
                  {run.ammo < FIGHT_AMMO_COST && (
                    <span className="ml-1 text-[11px] text-rose-200">（弹药不足·被迫肉搏）</span>
                  )}
                </button>
                <button
                  onClick={(e) => { doEncounter('sneak'); e.currentTarget.blur(); }}
                  className="rounded-lg border border-zinc-600 px-4 py-3 text-sm text-zinc-200 hover:bg-zinc-800"
                >
                  🌫 潜行绕行
                  <span className="ml-1 text-[11px] text-zinc-500">（耗费大量时间潜行通过，可能暴露）</span>
                </button>
                <button
                  onClick={(e) => { doEncounter('throw'); e.currentTarget.blur(); }}
                  disabled={throwableStock <= 0}
                  className="rounded-lg border border-sky-700 bg-sky-900/30 px-4 py-3 text-sm text-sky-200 hover:bg-sky-800/40 disabled:cursor-not-allowed disabled:border-zinc-800 disabled:bg-zinc-900 disabled:text-zinc-600"
                >
                  💣 投掷物脱离
                  <span className="ml-1 text-[11px] opacity-70">
                    （烟雾弹/闪光弹 可用×{throwableStock}，先扣战利品再扣基地）
                  </span>
                </button>
              </div>
            </div>
          ) : run.atExtract && !isOver ? (
            <div className="rounded-lg border border-sky-800 bg-sky-950/20 p-4">
              <h2 className="mb-1 text-sm font-semibold text-sky-300">🚁 撤离信号区</h2>
              <p className="mb-3 text-xs text-zinc-400">
                救援直升机正在接近——确认撤离将结算本局；继续搜刮则放弃本次机会，贪心者自负风险。
              </p>
              <div className="grid gap-2 sm:grid-cols-2">
                <button
                  onClick={(e) => { doExtract(); e.currentTarget.blur(); }}
                  className="rounded-lg bg-emerald-600 px-4 py-3 font-medium text-white hover:bg-emerald-500"
                >
                  ✔ 确认撤离（估值 {carriedValue} 废土币）
                </button>
                <button
                  onClick={(e) => { doLeaveExtract(); e.currentTarget.blur(); }}
                  className="rounded-lg border border-zinc-600 px-4 py-3 text-sm text-zinc-200 hover:bg-zinc-800"
                >
                  ↩ 返回继续搜刮
                </button>
              </div>
            </div>
          ) : !isOver ? (
            <div className="space-y-3">
              {run.corpse && (
                <button
                  onClick={(e) => { doLootCorpse(); e.currentTarget.blur(); }}
                  className="w-full rounded-lg border border-amber-800 bg-amber-950/30 px-4 py-2.5 text-sm text-amber-200 hover:bg-amber-900/40"
                >
                  🩸 搜刮【{run.corpse.enemyName}】的尸体
                  <span className="ml-1 text-[11px] opacity-70">（战斗胜利后的额外战利品）</span>
                </button>
              )}
              <div className="flex gap-3">
                <button
                  onClick={(e) => { doSearch(); e.currentTarget.blur(); }}
                  disabled={searchLeft <= 0 || run.bagFullPrompt}
                  className="flex-1 rounded-lg bg-emerald-600 px-4 py-3 font-medium text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:bg-zinc-800 disabled:text-zinc-500"
                >
                  🛰 搜索当前区域
                  <span className="ml-1 text-xs opacity-80">
                    （剩 {searchLeft}/{MAX_ZONE_SEARCHES} 次）
                  </span>
                </button>
                <button
                  onClick={(e) => { doExtract(); e.currentTarget.blur(); }}
                  disabled={!run.atExtract || run.bagFullPrompt}
                  className="flex-1 rounded-lg bg-sky-700 px-4 py-3 font-medium text-white hover:bg-sky-600 disabled:cursor-not-allowed disabled:bg-zinc-800 disabled:text-zinc-500"
                >
                  🏃 撤离
                </button>
              </div>
              {/* v1.0.11：搜刮 3 次后的独立黄字提示已合并到上方「当前区域名（已搜尽）」，此处移除 */}
              <div>
                <div className="mb-1.5 flex items-center justify-between text-[11px] uppercase tracking-wider text-zinc-500">
                  <span>区域图（共 {run.graph.nodes.length} 区 · 数字=本区深度，越深遇敌越凶）</span>
                  <span className="text-amber-400/80">当前深度 {curNode?.depth ?? 0}</span>
                </div>
                {/* 当前所在区域 —— v1.0.12：外框色随深度 1~7 从白(白阶)渐变到红(红阶)，与装备阶级色一致（tierColor 映射 depth-1 → 0..6） */}
                <div
                  className="mb-2 rounded border p-2"
                  style={{
                    borderColor: `${tierColor((curNode?.depth ?? 1) - 1)}99`,
                    backgroundColor: `${tierColor((curNode?.depth ?? 1) - 1)}14`,
                  }}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-sm" style={{ color: tierColor((curNode?.depth ?? 1) - 1) }}>
                      📍 {curNode?.name}
                      {/* v1.0.11：搜刮 3 次后，把「已搜尽」紧凑地紧贴在区域名后（）内 */}
                      {searchLeft <= 0 && (
                        <span className="ml-1 text-[11px] text-amber-400/90">（已搜尽）</span>
                      )}
                    </span>
                    <span
                      className="rounded bg-zinc-800 px-1.5 py-0.5 text-[11px]"
                      style={{ color: tierDef.color }}
                    >
                      {DANGER_LABEL[curNode?.danger ?? 1] ?? `危${curNode?.danger ?? 1}`} · 深度
                      {curNode?.depth ?? 1}
                    </span>
                  </div>
                  <div className="mt-0.5 text-[11px] text-zinc-500">
                    搜刮 {usedSearches}/{MAX_ZONE_SEARCHES}
                    {isBossZone(run) ? ' · 👑 霸主领地' : ''}
                    {run.extractRevealed && run.graph.extractZones.includes(run.currentZoneId) ? ' · 🚁 撤离点' : ''}
                  </div>
                </div>
                {/* 相邻可移动区域（点击移动） */}
                <div className="mb-1 text-[11px] text-zinc-500">相邻区域（点击移动）：</div>
                <div className="mb-2 flex flex-wrap gap-1">
                  {zoneNeighbors(run).map((n) => {
                    const revealedExtract = run.graph.extractZones.includes(n.id) && run.extractRevealed;
                    const isBoss = n.id === run.graph.bossZoneId;
                    return (
                      <button
                        key={n.id}
                        onClick={(e) => { doMoveToNode(n.id); e.currentTarget.blur(); }}
                        className={`rounded border px-2 py-1 text-[11px] ${
                          revealedExtract
                            ? 'border-sky-500 bg-sky-900/30 text-sky-200 hover:bg-sky-800/50'
                            : isBoss
                              ? 'border-rose-700 bg-rose-900/20 text-rose-200 hover:bg-rose-800/40'
                              : 'border-zinc-700 text-zinc-300 hover:border-emerald-500 hover:text-emerald-300'
                        }`}
                      >
                        {n.name}
                        <span className="ml-1 opacity-70">深{n.depth}</span>
                        {revealedExtract && <span className="ml-0.5">🚁</span>}
                        {isBoss && <span className="ml-0.5">👑</span>}
                      </button>
                    );
                  })}
                  {zoneNeighbors(run).length === 0 && (
                    <span className="text-[11px] text-zinc-600">无相邻区域</span>
                  )}
                </div>
                {/* 撤离点（显形后列出） */}
                {run.extractRevealed && (
                  <div className="mb-2 text-[11px] text-sky-300/80">
                    🚁 本局撤离点：{extractNames}
                  </div>
                )}
                {/* 抄近路直奔按钮已移除：撤离仅可在身处撤离点区域时进行（见下方本局撤离点 + 区域图 🚁） */}
              </div>
            </div>
          ) : null}

          {/* 💊 药物恢复 + 🧪 增益补给 —— v1.0.12 合并为同一 UI 区域，左右双栏排版 */}
          {!isOver && (availableMeds.length > 0 || (buffSpec && buffStock > 0)) ? (
            <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-3">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {availableMeds.length > 0 ? (
                  <div>
                    <h2 className="mb-2 flex items-center gap-1 text-sm font-medium text-zinc-300">
                      💊 使用药物恢复
                      <span className="text-[11px] font-normal text-zinc-500">
                        （仅限快捷·医疗槽已装备的药品，消耗基地库存）
                      </span>
                    </h2>
                    <div className="flex flex-wrap gap-2">
                      {availableMeds.map((m) => {
                        const maxHp = hpMax;
                        const heal = Math.round(m.healPct * maxHp) + m.healFlat;
                        const cur = hpCur;
                        const canTreat = (m.treats ?? []).some((inj) => (run?.injuries ?? []).includes(inj));
                        const disabled = cur >= maxHp && !canTreat;
                        return (
                          <button
                            key={m.id}
                            onClick={(e) => { takeMedicine(); e.currentTarget.blur(); }}
                            disabled={disabled}
                            className="rounded-lg border border-emerald-800 bg-emerald-900/40 px-3 py-2 text-xs text-emerald-200 hover:bg-emerald-800/60 disabled:cursor-not-allowed disabled:opacity-40"
                          >
                            {m.name}
                            <span className="ml-1 opacity-70">×{state.medicines[m.id]}</span>
                            <span className="ml-1 text-emerald-400">+{heal}</span>
                            {(m.treats ?? []).length > 0 && (
                              <span className="ml-1 text-rose-300/80">治:{m.treats!.map((t) => INJURY_LABEL[t]).join('/')}</span>
                            )}
                            {disabled && <span className="ml-1 text-zinc-500">（已满）</span>}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ) : null}
                {buffSpec && buffStock > 0 ? (
                  <div>
                    <h2 className="mb-2 flex items-center gap-1 text-sm font-medium text-zinc-300">
                      🧪 增益补给
                      <span className="text-[11px] font-normal text-zinc-500">
                        （使用后激活副本时间 10 分钟内六维全属性 +5；消耗基地库存）
                      </span>
                    </h2>
                    <button
                      onClick={(e) => { applyBuff(); e.currentTarget.blur(); }}
                      className="rounded-lg border border-sky-800 bg-sky-900/40 px-3 py-2 text-xs text-sky-200 hover:bg-sky-800/60"
                    >
                      使用 {buffSpec.name}
                      <span className="ml-1 opacity-70">×{buffStock}</span>
                      {buffRemainMin > 0 && (
                        <span className="ml-1 text-sky-300">（剩余 {buffRemainMin} 分钟）</span>
                      )}
                    </button>
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}

          {/* ④ 本局临时背包 + 安全箱（与基地背包完全隔离） */}
          <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
            <h2 className="mb-2 flex items-center justify-between text-sm font-medium text-zinc-300">
              <span>🎒 本局临时背包</span>
              <span className="text-xs text-zinc-500">
                {carried.length} / {runPackCapacity(run)} 格 · 估值 {carriedValue}
              </span>
            </h2>
            <div className="mb-2 flex items-center justify-between rounded border border-amber-900/40 bg-amber-950/10 px-2 py-1 text-[11px]">
              <span className="text-amber-300">💰 废土币（直接钱财，不占背包格）</span>
              <span className="font-semibold text-amber-200">×{run.carriedCredits}（撤离后折算入基地货币）</span>
            </div>
            <p className="mb-2 text-[11px] text-amber-500/80">
              本局搜刮的战利品：撤离成功才入库，阵亡 / 超时将全部清零；安全箱内物资 100% 保留。穿戴装备不在本局背包内。
              回复类物资（绷带/急救包/血清等）可就地「💊 使用」（可消除对应伤势），没用完的撤离成功后自动带回基地医疗背包。
              搜索有概率翻出【弹药补给】，直接装填进弹匣（不占背包格）；搜到的装备可在此就地「🎽 佩戴」换装。
            </p>
            <div className="mb-2 flex flex-wrap items-center gap-1 text-[11px] text-zinc-500">
              <span>阶级：</span>
              {RARITY_LEGEND.map((r) => (
                <span key={r.label} className="font-medium" style={{ color: r.color }}>
                  {r.label}
                </span>
              ))}
            </div>

            {/* v1.0.3 本局穿戴：出击途中可临时换装，换装带来的属性/能力变化立即生效 */}
            <div className="mb-2 rounded border border-sky-900/40 bg-sky-950/15 p-2">
              <div className="mb-1 flex items-center justify-between text-[11px] text-sky-400/90">
                <span>🎽 本局穿戴（副本内可换装）</span>
                <span>
                  {run.equipped.length
                    ? `${run.equipped.length} 件 · 气血上限 ${run.condition.resources.hp.max ?? 0}`
                    : '尚未穿戴'}
                </span>
              </div>
              {run.equipped.length === 0 ? (
                <div className="text-[11px] text-zinc-600">出击前未携带 / 未穿戴任何装备。</div>
              ) : (
                <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
                  {[...run.equipped].sort((a, b) => MAIN_EQUIP_SLOTS.findIndex((s) => s.key === a.slot) - MAIN_EQUIP_SLOTS.findIndex((s) => s.key === b.slot)).map((e) => {
                    const gColor = e.gear.tier != null ? tierColor(e.gear.tier) : '#a1a1aa';
                    return (
                      <div
                        key={e.slot}
                        className="flex items-center justify-between rounded border border-zinc-800 bg-zinc-950/60 px-1.5 py-1"
                      >
                        <span className="flex flex-col leading-tight">
                          <span className="text-[10px] text-zinc-500">{GEAR_SLOT_LABEL[e.slot]}</span>
                          <span
                            className="text-[11px]"
                            style={{ color: e.gear.tier != null ? gColor : '#d4d4d8' }}
                          >
                            {e.gear.name}
                            {e.fromRun && <span className="ml-0.5 text-sky-400/70">·副本</span>}
                          </span>
                          <GearBonusChips gear={e.gear} />
                        </span>
                        {!isOver && (
                          <button
                            onClick={() => doUnequipRun(e.slot)}
                            disabled={(carried.length >= runPackCapacity(run))}
                            className="rounded border border-zinc-700 px-1 py-0.5 text-[10px] text-zinc-400 hover:border-rose-600 hover:text-rose-300 disabled:cursor-not-allowed disabled:border-zinc-800 disabled:text-zinc-600"
                            title="卸下放回战局背包"
                          >
                            卸下
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
            {carried.length === 0 ? (
              <p className="text-sm text-zinc-600">尚未搜到任何物资。</p>
            ) : (
              <ul className="max-h-[320px] space-y-1 overflow-y-auto pr-1 text-sm">
                {carriedSorted.map(({ item: it, index: origIdx }) => {
                  const color = it.tier != null ? tierColor(it.tier) : '#a1a1aa';
                  const qty = it.qty ?? 1;
                  // 预计算该道具对应的医疗品及其可治伤势（避免在渲染闭包里即时调用函数表达式）
                  const medId = LOOT_MEDICINE_MAP[it.id];
                  const med = medId ? MEDICINES.find((m) => m.id === medId) : undefined;
                  const canTreat = med ? (med.treats ?? []).some((inj) => (run?.injuries ?? []).includes(inj)) : false;
                  const medDisabled = hpCur >= hpMax && !canTreat;
                  const isThrowable = THROWABLES.some((t) => t.id === it.id);
                  return (
                    <li key={`${it.id}-${origIdx}`} className="border-b border-zinc-800/60 py-1">
                      <div className="flex items-center justify-between">
                        <span className="flex items-center gap-2">
                          {it.tier != null && (
                            <span
                              className="rounded px-1.5 py-0.5 text-xs font-medium"
                              style={{ color, border: `1px solid ${color}` }}
                            >
                              {it.rarityName}
                            </span>
                          )}
                          <span style={{ color: it.tier != null ? color : undefined }} className={it.tier != null ? 'font-medium' : 'text-zinc-300'}>
                            {it.name}
                            {qty > 1 && <span className="ml-1 text-emerald-400">×{qty}</span>}
                          </span>
                        </span>
                        <span className="text-emerald-400">{it.value * qty}</span>
                      </div>
                      {it.affixes && it.affixes.length > 0 && !it.gear && (
                        <div className="mt-0.5 flex flex-wrap gap-1">
                          {it.affixes.map((a, j) => (
                            <span key={j} className="rounded px-1 text-[11px]" style={{ color: a.color }}>
                              {a.text}
                            </span>
                          ))}
                        </div>
                      )}
                      {it.gear && <GearBonusChips gear={it.gear} />}
                      {!isOver && (
                        <div className="mt-1 flex flex-wrap gap-1">
                          {med && (
                            <button
                              onClick={() => applyCarriedMed(origIdx)}
                              disabled={medDisabled}
                              className="rounded border border-emerald-700/60 px-1.5 py-0.5 text-[10px] text-emerald-300 hover:bg-emerald-900/40 disabled:cursor-not-allowed disabled:border-zinc-800 disabled:text-zinc-600"
                              title="在本局内立即使用，恢复生命；可消除对应伤势"
                            >
                              💊 使用
                              {(med.treats ?? []).length > 0 && (
                                <span className="ml-0.5 text-rose-300/80">
                                  治:{med.treats!.map((t) => INJURY_LABEL[t]).join('/')}
                                </span>
                              )}
                            </button>
                          )}
                          {it.gear && (
                            <button
                              onClick={() => doEquipCarried(origIdx)}
                              className="rounded border border-sky-700/60 px-1.5 py-0.5 text-[10px] text-sky-300 hover:bg-sky-900/40"
                              title="佩戴此装备（同槽已有则替换，旧装备回背包）"
                            >
                              🎽 佩戴
                            </button>
                          )}
                          {isThrowable && (
                            <button
                              onClick={() => useCarriedThrowable(origIdx)}
                              className="rounded border border-orange-700/60 px-1.5 py-0.5 text-[10px] text-orange-300 hover:bg-orange-900/40"
                              title="检索装入投掷袋，供战斗投掷 / 投掷物脱离使用（占用背包格子直到装入）"
                            >
                              💣 检索使用
                            </button>
                          )}
                          <button
                            onClick={() => doToSecure(origIdx)}
                            disabled={secureUsed >= SECURE_BOX_SLOTS}
                            className="rounded border border-amber-700/60 px-1.5 py-0.5 text-[10px] text-amber-300 hover:bg-amber-900/40 disabled:cursor-not-allowed disabled:border-zinc-800 disabled:text-zinc-600"
                          >
                            🛡 移入安全箱
                          </button>
                          <button
                            onClick={() => doDropCarried(origIdx)}
                            className="rounded border border-zinc-700 px-1.5 py-0.5 text-[10px] text-zinc-400 hover:border-rose-600 hover:text-rose-300"
                          >
                            🗑 丢弃
                          </button>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
            {/* 安全箱（阵亡 100% 保留） */}
            <div className="mt-3 rounded border border-amber-900/50 bg-amber-950/10 p-2">
              <div className="mb-1.5 flex items-center justify-between text-[11px] text-amber-400/90">
                <span>🛡 安全箱（阵亡也保留的保底格）</span>
                <span>{secureUsed} / {SECURE_BOX_SLOTS}</span>
              </div>
              <div className="grid grid-cols-2 gap-1.5">
                {run.secureBox.map((slotItem, si) =>
                  slotItem ? (
                    <button
                      key={si}
                      onClick={() => doFromSecure(si)}
                      disabled={isOver}
                      className="truncate rounded border border-amber-800/60 bg-zinc-950/60 px-1.5 py-1 text-left text-[11px] text-amber-200 hover:bg-amber-900/30 disabled:cursor-default"
                      title="点击取回战局背包"
                    >
                      {slotItem.name}
                      {(slotItem.qty ?? 1) > 1 && `×${slotItem.qty}`}
                      <span className="ml-1 text-zinc-500">（取回）</span>
                    </button>
                  ) : (
                    <div key={si} className="rounded border border-dashed border-zinc-800 px-1.5 py-1 text-[11px] text-zinc-600">
                      空格位
                    </div>
                  ),
                )}
              </div>
            </div>
            {/* ⑤ 临时制作台：用本局背包材料合成医疗品（与基地「医疗·制作台」同源） */}
            <div className="mt-3 rounded border border-sky-900/50 bg-sky-950/10 p-2">
              <div className="mb-1.5 flex items-center gap-1 text-[11px] text-sky-400/90">
                <span>⚗️ 临时制作台</span>
                <span className="text-zinc-500">（消耗本局背包材料，合成「医疗·制作台」里的物品）</span>
              </div>
              {SORTIE_MED_CRAFT.map((r) => {
                const medName = MEDICINES.find((m) => m.id === r.medicine)?.name ?? r.medicine;
                const counts: Record<string, number> = {};
                for (const it of carried) counts[it.id] = (counts[it.id] ?? 0) + (it.qty ?? 1);
                const ok = r.needs.every((n) => (counts[n.lootId] ?? 0) >= n.qty) && run.carriedCredits >= r.costCoins;
                return (
                  <div key={r.id} className="mb-1.5 rounded border border-zinc-800 bg-zinc-950/60 px-2 py-1.5">
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] text-zinc-200">合成 {medName}</span>
                      <button
                        onClick={() => doCraftInSortie(r.id)}
                        disabled={!ok || isOver}
                        className="rounded border border-sky-700/60 px-1.5 py-0.5 text-[10px] text-sky-300 hover:bg-sky-900/40 disabled:cursor-not-allowed disabled:border-zinc-800 disabled:text-zinc-600"
                      >
                        合成
                      </button>
                    </div>
                    <div className="mt-1 flex flex-wrap gap-x-2 gap-y-0.5 text-[10px]">
                      {r.needs.map((n) => {
                        const have = counts[n.lootId] ?? 0;
                        return (
                          <span key={n.lootId} className={have >= n.qty ? 'text-emerald-400' : 'text-rose-400'}>
                            {LOOT_NAME[n.lootId] ?? n.lootId}×{n.qty}
                            <span className="opacity-70">（持 {have}）</span>
                          </span>
                        );
                      })}
                      {r.costCoins > 0 && (
                        <span className={run.carriedCredits >= r.costCoins ? 'text-emerald-400' : 'text-rose-400'}>
                          废土币×{r.costCoins}
                          <span className="opacity-70">（持 {run.carriedCredits}）</span>
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
            <p className="mt-3 border-t border-zinc-800 pt-2 text-xs text-zinc-500">
              已入库：<span className="text-emerald-400">{bankedValue}</span> 废土币（{bankedQty} 件）
            </p>
          </div>

        </>


      )}
    </section>
  );
}
