/*
 * menu/views.tsx — 末世行止菜单各子页面实现。
 *
 * 每个 subView 接收统一签名：(state, mutate, setState) => JSX.Element，
 * mutate(fn) 走不可变更新、setState 直接替换（极少用）。
 * 实现原则：能复用真实引擎的就复用（医疗/任务/战绩/招募集合），
 * 否则保持轻量占位（拍卖/赌战等需后端支持的项）。
 */
import { useCallback, useEffect, useMemo, useRef, useState, Fragment } from 'react';
import { ResetSaveDialog } from '../components/ResetSaveDialog';
import { attrLabel, tierColor, tierNameFromTier, ALL_ATTR_KEYS, rollTraitCandidates, type SurvivorTrait, type SurvivorProfile, generateSurvivor } from '@shared/engine/survival/chargen';
import { affixColor, affixLabel } from '@shared/engine/survival/affixes';
import type { AffixTierKey } from '@shared/engine/survival/affixes';
import type { Attributes } from '@shared/types/cultivator';
import type { SurvivalGameState, SortieLog } from '@shared/engine/survival/state';
import {
  prepareArenaDuel,
  arenaStep,
  restoreArenaDuelSession,
  type ArenaDuelHandle,
} from '@shared/engine/survival/arenaDuel';
import type { WagerState, WagerLogLine, WagerBetSide } from '@shared/engine/survival/wager';
import {
  AUCTION_COUNT,
  AUCTION_INSTANT_REFRESH_COST,
  rollNewAuction,
  buyAuctionItem,
  type AuctionItem,
} from '@shared/engine/survival/auction';
import type { UnitStateSnapshot } from '@shared/engine/battle-v5/systems/state/types';
import type { CombatSequenceV3 } from '@shared/engine/battle-v5/v3/types';
import {
  bankLoot,
  buyMedicine,
  applyMedicineToSurvivor,
  acceptRecruit,
  dismissRecruit,
  addRecruit,
  applySortieResult,
  MEDICINES,
  type MedicineSpec,
  MED_CRAFT_RECIPES,
  canCraftMedicine,
  craftMedicine,
  recruitFee,
  treatNearDeathWithCoins,
  NEAR_DEATH_TREAT_COST,
  oneClickHeal,
  ONE_CLICK_HEAL_COST,
  WARBAND_CAP,
  todayQuestsProgress,
  claimQuest,
  buildSortieLoadout,
  recoverAll,
  GARDEN_CROPS,
  plantGardenCrop,
  harvestGardenPlot,
  clearGardenPlot,
  // v1.1.0：菜园种子
  seedStock,
  buySeeds,
  gardenCropValue,
  emptyGardenPlots,
  createProtagonistGame,
  // v1.1.0：行动点 / 重塑六维 / 市场出售
  ACTION_POINT_CAP,
  actionPointView,
  trySpendActionPoints,
  sortieActionPointCost,
  REROLL_ATTR_COST,
  REROLL_TRAIT_COST,
  rerollBaseAttributes,
  rerollTrait,
  // v1.1.0 补充：GM 调试工具
  verifyGmKey,
  gmGrantXp,
  gmGrantCoins,
  gmGrantActionPoints,
  materialSellPrice,
  gearSellPrice,
  sellMaterials,
  recycleGear,
  activeSurvivor,
  reforgeEquippedGear,
  fullHealTeam,
  addSummonedSurvivor,
  upgradeEquippedGearTier,
  addRedeemTicket,
  useBackboneRecruitTicket,
} from '@shared/engine/survival/state';
import { saveGame } from '@shared/engine/survival/persistence';
import { getCurrentUser } from '@shared/engine/survival/account';
import {
  runMirageChamber,
  MIRAGE_AP_COST,
  type MirageResult,
} from '@shared/engine/survival/mirageChamber';
import { compressToBase64, decompressFromBase64 } from 'lz-string';
import type { RNG } from '@shared/engine/survival/rng';
import {
  MATERIAL_LABEL,
  materialCount,
  FACTIONS,
  type MaterialItem,
  GEAR_SLOT_LABEL,
  type GearSlot,
} from '@shared/engine/survival/economy';
import { INJURY_LABEL, regenPerMinute, timeToFullSeconds, freshStatus } from '@shared/engine/survival/recovery';
// v1.1.0：漫游 = 模拟一次完整副本（同源结算）
import { simulateWanderSortie, type WanderReport } from '@shared/engine/survival/wander';
import { createRun, search, rollRescue, fight, extract, mulberry32, sumValue } from '@shared/engine/extraction';
import { DANGER_ZONES } from '@shared/engine/extraction/content';

/** 药品效果简写：回血型→「回复 X% 生命 +Y」；清伤型→「清除伤势：…」；纯增益（肾上腺素）→「增益补给，副本时间 10 分钟内六维全属性 +5」 */
function medEffectShort(m: MedicineSpec): string {
  if (m.healPct > 0 || m.healFlat > 0) {
    return `回复 ${Math.round(m.healPct * 100)}% 生命 +${m.healFlat}`;
  }
  if (m.treats && m.treats.length > 0) {
    return `清除伤势：${m.treats.map((t) => INJURY_LABEL[t]).join('、')}`;
  }
  return '增益补给，副本时间 10 分钟内六维全属性 +5';
}

type Mutate = (fn: (s: SurvivalGameState) => SurvivalGameState) => void;
type SetState = React.Dispatch<React.SetStateAction<SurvivalGameState>>;

interface ViewProps {
  state: SurvivalGameState;
  mutate: Mutate;
  setState: SetState;
  rng: RNG;
  /** v1.0.10 补充：重置存档（含退出出击）。由避难所 Hub 注入；缺省时退化为仅重建档案 */
  onResetGame?: (name: string) => void;
}

const Section: React.FC<{ title: string; subtitle?: React.ReactNode; children: React.ReactNode; right?: React.ReactNode }> = ({ title, subtitle, children, right }) => (
  <div className="space-y-4">
    <div className="flex items-end justify-between gap-4 border-b border-zinc-800 pb-3">
      <div>
        <h2 className="text-xl font-semibold text-zinc-100">{title}</h2>
        {subtitle && <p className="mt-1 text-sm text-zinc-400">{subtitle}</p>}
      </div>
      {right}
    </div>
    {children}
  </div>
);

const Card: React.FC<{ children: React.ReactNode; className?: string; style?: React.CSSProperties }> = ({ children, className, style }) => (
  <div className={`rounded-xl border border-zinc-800 bg-zinc-900 p-4 shadow-sm ${className ?? ''}`} style={style}>{children}</div>
);

const Pill: React.FC<{ children: React.ReactNode; tone?: 'green' | 'red' | 'amber' | 'sky' | 'stone' }> = ({ children, tone = 'stone' }) => {
  const map: Record<string, string> = {
    green: 'bg-emerald-900/40 text-emerald-300',
    red: 'bg-rose-900/40 text-rose-300',
    amber: 'bg-amber-900/40 text-amber-300',
    sky: 'bg-sky-900/40 text-sky-300',
    stone: 'bg-zinc-800 text-zinc-200',
  };
  return <span className={`inline-block rounded px-2 py-0.5 text-xs ${map[tone]}`}>{children}</span>;
};

/** 段位徽标：按段位序号取配色与名称（白→红），文字+描边+底色同色系
 * 名称从 tier 推导，避免旧存档 stale tierName 与颜色不一致。
 */
const TierBadge: React.FC<{ tier: number; name?: string; size?: 'sm' | 'md' }> = ({ tier, size = 'md' }) => {
  const c = tierColor(tier);
  const name = tierNameFromTier(tier);
  const pad = size === 'sm' ? 'px-1.5 py-0 text-[10px]' : 'px-2 py-0.5 text-xs';
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border font-semibold ${pad}`}
      style={{ color: c, borderColor: `${c}66`, background: `${c}1a` }}
    >
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: c }} />
      {name}
    </span>
  );
};

const AttrBar: React.FC<{ label: string; value: number; max: number }> = ({ label, value, max }) => (
  <div className="flex items-center gap-2 text-xs">
    <span className="w-10 text-zinc-400">{label}</span>
    <div className="h-1.5 flex-1 overflow-hidden rounded bg-zinc-800">
      <div className="h-full bg-emerald-500" style={{ width: `${Math.min(100, (value / max) * 100)}%` }} />
    </div>
    <span className="w-8 text-right font-mono text-zinc-200">{value}</span>
  </div>
);

const hpBar = (current: number, max: number) => {
  const pct = max > 0 ? Math.max(0, Math.min(100, (current / max) * 100)) : 0;
  const tone = pct > 60 ? 'bg-emerald-500' : pct > 30 ? 'bg-amber-400' : 'bg-rose-500';
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="w-6 text-zinc-400">HP</span>
      <div className="h-2 flex-1 overflow-hidden rounded bg-zinc-800">
        <div className={`h-full ${tone}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="w-16 text-right font-mono text-zinc-200">{current}/{max}</span>
    </div>
  );
};

// ===== 1. 避难所菜园（6 块地 · v1.1.0：种植消耗种子，种子在下方种子商店购买） =====
export const ViewGarden: React.FC<ViewProps> = ({ state, mutate }) => {
  const gardenLevel = state.facilities['garden'] ?? 0;
  // 旧存档可能没有 gardenPlots，用空 6 地块兜底；新存档与种植动作都走 persist
  const plots = state.gardenPlots && state.gardenPlots.length > 0 ? state.gardenPlots : emptyGardenPlots();
  const [sel, setSel] = useState<Record<number, string>>({}); // 每块地当前选中的作物
  const [now, setNow] = useState(0);
  // v1.1.0：铲除未成熟地块会损失种子，需内联二次确认
  const [confirmClear, setConfirmClear] = useState<number | null>(null);
  const [shopMsg, setShopMsg] = useState<string | null>(null);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const cropName = (id: string | null) =>
    id ? (GARDEN_CROPS.find((c) => c.id === id)?.name ?? id) : '';
  const productLabel = (c: (typeof GARDEN_CROPS)[number]) =>
    c.yields ? `${MEDICINES.find((m) => m.id === c.yields)?.name ?? c.yields}×${c.qty}` : `+${c.coins} 废土币`;

  const doBuy = (cropId: string, qty: number) => {
    const crop = GARDEN_CROPS.find((c) => c.id === cropId);
    if (!crop) return;
    const total = crop.seedPrice * qty;
    if (state.coins < total) {
      setShopMsg(`⚠ 废土币不足，${crop.name}种子×${qty} 需 ${total} 币。`);
      return;
    }
    mutate((st) => buySeeds(st, cropId, qty));
    setShopMsg(`✅ 购入 ${crop.name}种子×${qty}，花费 ${total} 废土币。`);
  };

  return (
    <Section
      title="避难所·菜园"
      subtitle="6 块地，每块可任选一种作物种植。种植需消耗对应种子。种植状态已存档，切走再切回不会丢失。"
    >
      <div className="mb-3 flex flex-wrap items-center gap-2 text-sm text-zinc-300">
        <Pill tone="sky">菜园等级 {gardenLevel}</Pill>
        <span className="text-xs text-zinc-400">每升 1 级收成时间 -10%（下限 30%）</span>
      </div>

      {/* ===== 种子商店 ===== */}
      <Card className="mb-4">
        <h3 className="font-semibold text-zinc-100">种子商店</h3>
        <p className="mt-1 text-xs text-zinc-400">
          种子价恒低于产物市价，差额即为你等待成熟应得的利润。未成熟就铲除会损失该颗种子。
        </p>
        {shopMsg && (
          <div
            className={`mt-2 rounded border px-2 py-1 text-xs ${
              shopMsg.startsWith('⚠')
                ? 'border-rose-800 bg-rose-950/30 text-rose-300'
                : 'border-emerald-800 bg-emerald-950/30 text-emerald-300'
            }`}
          >
            {shopMsg}
          </div>
        )}
        <div className="mt-3 space-y-1.5">
          {GARDEN_CROPS.map((c) => {
            const stock = seedStock(state, c.id);
            const value = gardenCropValue(c);
            return (
              <div
                key={c.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded border border-zinc-800 px-2 py-1.5"
              >
                <div className="min-w-0">
                  <div className="text-sm text-zinc-100">
                    {c.icon} {c.name}
                    <span className="ml-2 font-mono text-xs text-sky-300">库存 {stock}</span>
                  </div>
                  <div className="text-[11px] text-zinc-500">
                    {c.minutes} 分钟 → {productLabel(c)}（市价 {value} 币）· 种子 {c.seedPrice} 币
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <button
                    onClick={() => doBuy(c.id, 1)}
                    disabled={state.coins < c.seedPrice}
                    className="rounded bg-stone-600 px-2 py-1 text-xs text-white hover:bg-stone-700 disabled:opacity-40"
                  >
                    ×1 / {c.seedPrice}
                  </button>
                  <button
                    onClick={() => doBuy(c.id, 5)}
                    disabled={state.coins < c.seedPrice * 5}
                    className="rounded bg-stone-700 px-2 py-1 text-xs text-white hover:bg-stone-600 disabled:opacity-40"
                  >
                    ×5 / {c.seedPrice * 5}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
        <div className="mt-2 text-[11px] text-zinc-500">当前废土币：{state.coins}</div>
      </Card>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {plots.map((plot, idx) => {
          const crop = plot.cropId ? GARDEN_CROPS.find((c) => c.id === plot.cropId) : null;
          const ready = plot.readyAt != null && now >= plot.readyAt;
          const leftMin = plot.readyAt && !ready ? Math.max(0, Math.ceil((plot.readyAt - now) / 60_000)) : 0;
          return (
            <Card key={idx}>
              <div className="flex items-center justify-between">
                <div className="text-sm font-semibold text-zinc-100">第 {idx + 1} 块地</div>
                {!plot.cropId && <span className="text-xs text-zinc-500">空地</span>}
                {plot.cropId && !ready && <span className="text-xs text-amber-300">种植中…</span>}
                {ready && <span className="text-xs font-medium text-emerald-300">已成熟</span>}
              </div>

              {!plot.cropId ? (
                <div className="mt-3 space-y-2">
                  <select
                    value={sel[idx] ?? ''}
                    onChange={(e) => setSel((s) => ({ ...s, [idx]: e.target.value }))}
                    className="w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-200"
                  >
                    <option value="">选择作物…</option>
                    {GARDEN_CROPS.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.icon} {c.name}（{c.minutes} 分 →{' '}
                        {c.yields ? MEDICINES.find((m) => m.id === c.yields)?.name : `+${c.coins} 废土币`}
                        ）· 种子库存 {seedStock(state, c.id)}
                      </option>
                    ))}
                  </select>
                  {sel[idx] && seedStock(state, sel[idx]) === 0 && (
                    <div className="text-[11px] text-rose-300">
                      ⚠ 没有{cropName(sel[idx])}种子，请先在上方种子商店购买。
                    </div>
                  )}
                  <button
                    disabled={!sel[idx] || seedStock(state, sel[idx]) === 0}
                    onClick={() => {
                      if (!sel[idx]) return;
                      mutate((s) => plantGardenCrop(s, idx, sel[idx], Date.now()));
                      setSel((s) => ({ ...s, [idx]: '' }));
                    }}
                    className="w-full rounded bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-40"
                    title={
                      !sel[idx]
                        ? '先选择作物'
                        : seedStock(state, sel[idx]) === 0
                          ? '缺少种子'
                          : `消耗 1 颗${cropName(sel[idx])}种子`
                    }
                  >
                    种植（消耗种子 ×1）
                  </button>
                </div>
              ) : (
                <div className="mt-3">
                  <div className="text-base font-semibold text-zinc-100">
                    {crop?.icon} {cropName(plot.cropId)}
                  </div>
                  <div className="mt-1 text-xs text-zinc-400">收成：{crop ? productLabel(crop) : ''}</div>
                  {ready ? (
                    <button
                      onClick={() => mutate((s) => harvestGardenPlot(s, idx, Date.now()))}
                      className="mt-3 w-full rounded bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-700"
                    >
                      收获
                    </button>
                  ) : (
                    <div className="mt-3 text-xs text-zinc-400">剩余约 {leftMin} 分钟成熟</div>
                  )}
                  {confirmClear === idx ? (
                    <div className="mt-2 rounded border border-rose-800 bg-rose-950/30 px-2 py-1.5">
                      <div className="text-[11px] text-rose-200">
                        {ready
                          ? '确认铲除？该地块将被清空。'
                          : '⚠ 作物尚未成熟，铲除将损失这颗种子，确认？'}
                      </div>
                      <div className="mt-1.5 flex gap-1.5">
                        <button
                          onClick={() => {
                            mutate((s) => clearGardenPlot(s, idx));
                            setConfirmClear(null);
                          }}
                          className="rounded bg-rose-600 px-2 py-1 text-[11px] text-white hover:bg-rose-700"
                        >
                          确认铲除
                        </button>
                        <button
                          onClick={() => setConfirmClear(null)}
                          className="rounded bg-zinc-700 px-2 py-1 text-[11px] text-white hover:bg-zinc-600"
                        >
                          取消
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      onClick={() => setConfirmClear(idx)}
                      className="mt-2 w-full rounded border border-zinc-700 px-3 py-1 text-[11px] text-zinc-400 hover:bg-zinc-800"
                    >
                      铲除重种
                    </button>
                  )}
                </div>
              )}
            </Card>
          );
        })}
      </div>
    </Section>
  );
};

// ===== 1b. 医疗制作 =====
export const ViewCraft: React.FC<ViewProps> = ({ state, mutate }) => {
  return (
    <Section
      title="⚗️ 医疗·制作台"
      subtitle="用废土材料合成医疗品，无副本也能补给。"
      right={<span className="rounded-full bg-zinc-800 px-2 py-0.5 text-[11px] text-zinc-400">就地补给</span>}
    >
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {MED_CRAFT_RECIPES.map((r) => {
          const med = MEDICINES.find((m) => m.id === r.medicine);
          const ok = canCraftMedicine(state, r);
          return (
            <Card key={r.id} className="flex flex-col">
              <div className="flex items-start justify-between gap-2">
                <div className="text-base font-semibold text-zinc-100">{r.name}</div>
                <span className="shrink-0 rounded-full bg-rose-900/40 px-2 py-0.5 text-[11px] text-rose-300">
                  {med ? `产出 ${med.name}` : r.medicine}
                </span>
              </div>
              <div className="mt-1 text-xs text-zinc-400">
                效果：{med ? medEffectShort(med) : '—'}
              </div>
              <ul className="mt-3 space-y-1.5 text-xs">
                {r.costMaterials.map((c) => {
                  const have = materialCount(state.materials, c.kind);
                  const enough = have >= c.qty;
                  return (
                    <li
                      key={c.kind}
                      className="flex items-center justify-between rounded bg-zinc-950/60 px-2 py-1"
                    >
                      <span className={enough ? 'text-emerald-300' : 'text-rose-300'}>
                        {MATERIAL_LABEL[c.kind]}
                      </span>
                      <span className={enough ? 'font-mono text-emerald-300' : 'font-mono text-rose-300'}>
                        {have}/{c.qty}
                      </span>
                    </li>
                  );
                })}
                <li className="flex items-center justify-between rounded bg-zinc-950/60 px-2 py-1 text-zinc-300">
                  <span>废土币</span>
                  <span className="font-mono">⛁{r.costCoins}</span>
                </li>
              </ul>
              <button
                onClick={() => mutate((s) => craftMedicine(s, r.id))}
                disabled={!ok}
                className="mt-3 w-full rounded-md bg-sky-600 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-sky-500 disabled:cursor-not-allowed disabled:bg-zinc-800 disabled:text-zinc-500"
              >
                {ok ? '合成' : '材料 / 币不足'}
              </button>
            </Card>
          );
        })}
      </div>
    </Section>
  );
};

// ===== 2. 战术手册 =====
export const ViewTactics: React.FC<ViewProps> = ({ state }) => {
  const active = state.survivors.find((s) => s.id === state.activeSurvivorId);
  if (!active) return <Section title="📓 战术手册"><div className="text-zinc-400">未指定出击者。</div></Section>;
  return (
    <Section
      title="📓 战术手册"
      subtitle={
        <span>
          当前出击者：{active.name}（<TierBadge tier={active.tier} name={active.tierName} size="sm" />）
        </span>
      }
    >
      <Card>
        <h3 className="text-sm font-semibold text-zinc-200">六维基础属性</h3>
        <div className="mt-3 space-y-2">
          {(Object.keys(active.attributes) as (keyof Attributes)[]).map((k) => (
            <AttrBar key={k} label={attrLabel(k)} value={active.attributes[k]} max={30} />
          ))}
        </div>
      </Card>
      <Card>
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-zinc-200">被动技 · 战斗词条</h3>
          <span className="text-[11px] text-zinc-500">按品质着色</span>
        </div>
        {active.traits.length === 0 ? (
          <div className="mt-2 text-sm text-zinc-400">无词条。</div>
        ) : (
          <ul className="mt-3 space-y-2">
            {active.traits.map((t) => {
              const c = affixColor(t.quality);
              const qlabel = affixLabel(t.quality);
              const hasBonus =
                t.combat ||
                Object.keys(t.modifiers ?? {}).some(
                  (k) => (t.modifiers?.[k as keyof Attributes] ?? 0) !== 0,
                );
              return (
                <li
                  key={t.id}
                  className="rounded-lg border bg-zinc-950/40 p-3"
                  style={{ borderColor: `${c}66`, boxShadow: `inset 3px 0 0 ${c}` }}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="font-medium" style={{ color: c }}>
                      {t.name}
                    </div>
                    <span
                      className="shrink-0 rounded px-1.5 py-0.5 text-[10px]"
                      style={{ color: c, border: `1px solid ${c}88`, backgroundColor: `${c}1f` }}
                    >
                      {qlabel}
                    </span>
                  </div>
                  <div className="mt-1 text-xs text-zinc-400">{t.description}</div>
                  {hasBonus && (
                    <div className="mt-2 flex flex-wrap gap-1 text-xs">
                      {(Object.keys(t.modifiers ?? {}) as (keyof Attributes)[])
                        .filter((k) => (t.modifiers?.[k] ?? 0) !== 0)
                        .map((k) => (
                          <Pill key={k} tone="green">{attrLabel(k)} +{t.modifiers?.[k]}</Pill>
                        ))}
                      {t.combat?.hpBonus && <Pill tone="green">HP +{t.combat.hpBonus}</Pill>}
                      {t.combat?.critBonus && <Pill tone="amber">暴击 +{Math.round(t.combat.critBonus * 100)}%</Pill>}
                      {t.combat?.lootLuck && <Pill tone="sky">搜刮 +{Math.round(t.combat.lootLuck * 100)}%</Pill>}
                      {t.combat?.startHpRatio && <Pill>初始 HP +{Math.round(t.combat.startHpRatio * 100)}%</Pill>}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </Section>
  );
};

// ===== 3. 掌握技能（词条总览） =====
// v1.1.3（攒）：① 词条按品质着色；② 花费废土币重洗单项词条（二次确认 + 三选一，且不重复已掌握项）
const traitStyle = (q: AffixTierKey): React.CSSProperties => {
  const c = affixColor(q);
  return { color: c, borderColor: `${c}88`, backgroundColor: `${c}1f` };
};

export const ViewSkills: React.FC<ViewProps> = ({ state, mutate, rng }) => {
  const [confirm, setConfirm] = useState<{ survivorId: string; traitId: string; traitName: string } | null>(null);
  const [options, setOptions] = useState<{ survivorId: string; traitId: string; list: SurvivorTrait[] } | null>(null);

  const beginReroll = (survivorId: string, t: SurvivorTrait) => {
    setOptions(null);
    setConfirm({ survivorId, traitId: t.id, traitName: t.name });
  };

  const doConfirm = () => {
    if (!confirm) return;
    const s = state.survivors.find((x) => x.id === confirm.survivorId);
    if (!s || state.coins < REROLL_TRAIT_COST) return;
    // 排除该成员已拥有的全部词条（含被重洗的那条），保证新候选不重复
    const exclude = s.traits.map((t) => t.id);
    const list = rollTraitCandidates(rng, exclude, 3);
    setOptions({ survivorId: confirm.survivorId, traitId: confirm.traitId, list });
    setConfirm(null);
  };

  const pickOption = (newTrait: SurvivorTrait) => {
    if (!options) return;
    mutate((s) => rerollTrait(s, options.survivorId, options.traitId, newTrait));
    setOptions(null);
  };

  return (
    <Section title="掌握技能" subtitle="全员词条与被动一览。可花费废土币重洗单项词条（新词条不会与已掌握项重复）。">
      <div className="space-y-3">
        {state.survivors.map((s) => (
          <Card key={s.id}>
            <div className="flex items-center justify-between">
              <div>
                <span className="text-base font-semibold text-zinc-100">{s.name}</span>
                <TierBadge tier={s.tier} name={s.tierName} size="sm" />
                <span className="ml-1 text-xs text-zinc-400">· 战力 {s.power}</span>
              </div>
            </div>
            <ul className="mt-2 flex flex-wrap gap-1 text-xs">
              {s.traits.map((t) => (
                <li key={t.id} className="flex items-center gap-1 rounded border px-2 py-1" style={traitStyle(t.quality)}>
                  <span>{t.name}</span>
                  <span className="text-[10px] opacity-70">{affixLabel(t.quality)}</span>
                  <button
                    type="button"
                    onClick={() => beginReroll(s.id, t)}
                    className="ml-1 rounded bg-black/30 px-1 text-[10px] hover:bg-black/50"
                    title={`花费 ${REROLL_TRAIT_COST} 废土币重洗该词条`}
                  >重洗</button>
                </li>
              ))}
              {s.traits.length === 0 && <li className="text-zinc-400">（无被动技能）</li>}
            </ul>
          </Card>
        ))}
      </div>

      {/* 二次确认弹层 */}
      {confirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-sm rounded-xl border border-zinc-700 bg-zinc-900 p-4 shadow-lg">
            <h3 className="text-base font-semibold text-zinc-100">重洗词条确认</h3>
            <p className="mt-2 text-sm text-zinc-300">
              将花费 <span className="font-semibold text-amber-300">{REROLL_TRAIT_COST}</span> 废土币，
              把 <span className="font-semibold text-zinc-100">{confirm.traitName}</span> 重洗为从「未掌握词条」中抽出的 3 选 1。
            </p>
            <p className="mt-1 text-xs text-zinc-500">替换后不可撤销，且新词条不会与已掌握项重复。</p>
            {state.coins < REROLL_TRAIT_COST && (
              <p className="mt-2 text-xs text-rose-300">⚠ 废土币不足，还差 {REROLL_TRAIT_COST - state.coins} 币。</p>
            )}
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" onClick={() => setConfirm(null)} className="rounded border border-zinc-700 px-3 py-1 text-sm text-zinc-300 hover:bg-zinc-800">取消</button>
              <button
                type="button"
                disabled={state.coins < REROLL_TRAIT_COST}
                onClick={doConfirm}
                className="rounded bg-amber-600 px-3 py-1 text-sm font-medium text-white disabled:opacity-40 hover:bg-amber-500"
              >确认重洗</button>
            </div>
          </div>
        </div>
      )}

      {/* 三选一候选 */}
      {options && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-md rounded-xl border border-zinc-700 bg-zinc-900 p-4 shadow-lg">
            <h3 className="text-base font-semibold text-zinc-100">选择重洗后的词条</h3>
            <p className="mt-1 text-xs text-zinc-500">选定后立即替换原词条，并扣除 {REROLL_TRAIT_COST} 废土币。</p>
            {options.list.length === 0 ? (
              <p className="mt-3 text-sm text-rose-300">已掌握全部词条，无可用候选。</p>
            ) : (
              <ul className="mt-3 space-y-2">
                {options.list.map((t) => (
                  <li key={t.id}>
                    <button type="button" onClick={() => pickOption(t)} className="w-full rounded-lg border px-3 py-2 text-left hover:bg-zinc-800" style={traitStyle(t.quality)}>
                      <div className="flex items-center justify-between">
                        <span className="font-medium">{t.name}</span>
                        <span className="text-[10px] opacity-70">{affixLabel(t.quality)}</span>
                      </div>
                      <div className="mt-0.5 text-[11px] opacity-80">{t.description}</div>
                      <div className="mt-1 flex flex-wrap gap-2 text-[11px]">
                        {Object.entries(t.modifiers).filter(([, v]) => v).map(([k, v]) => (
                          <span key={k}>{attrLabel(k as keyof Attributes)}+{v}</span>
                        ))}
                        {t.combat?.hpBonus && <span>气血+{t.combat.hpBonus}</span>}
                        {t.combat?.critBonus && <span>暴击+{Math.round(t.combat.critBonus * 100)}%</span>}
                        {t.combat?.lootLuck && <span>搜刮+{Math.round(t.combat.lootLuck * 100)}%</span>}
                        {t.combat?.startHpRatio && <span>初始HP+{Math.round(t.combat.startHpRatio * 100)}%</span>}
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div className="mt-4 flex justify-end">
              <button type="button" onClick={() => setOptions(null)} className="rounded border border-zinc-700 px-3 py-1 text-sm text-zinc-300 hover:bg-zinc-800">取消</button>
            </div>
          </div>
        </div>
      )}
    </Section>
  );
};

// ===== 4. 战团技能 =====
const FACTION_META: Record<string, { icon: string; accent: string }> = {
  'iron-wall': { icon: '🛡️', accent: '#f87171' },
  'silver-hand': { icon: '💰', accent: '#fbbf24' },
  'free-scouts': { icon: '🧭', accent: '#38bdf8' },
};

export const ViewFactionSkills: React.FC<ViewProps> = ({ state }) => (
  <Section title="🏛️ 战团技能" subtitle="投资势力声望，全战团获得永久属性加成（每级 +1 档）。">
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {FACTIONS.map((f) => {
        const rep = state.factionRep[f.id] ?? 0;
        const meta = FACTION_META[f.id] ?? { icon: '🏳️', accent: '#9ca3af' };
        const bonusParts = Object.entries(f.attrPerRepLevel).map(
          ([k, v]) => `${attrLabel(k as keyof Attributes)}+${(v ?? 0) * rep}`,
        );
        return (
          <Card key={f.id} className="overflow-hidden" style={{ borderColor: `${meta.accent}55` }}>
            <div className="flex items-start justify-between gap-2">
              <div className="flex items-center gap-2">
                <span className="text-2xl leading-none">{meta.icon}</span>
                <div>
                  <div className="text-base font-semibold text-zinc-100">{f.name}</div>
                  <div className="mt-0.5 text-xs text-zinc-400">{f.description}</div>
                </div>
              </div>
              <Pill tone={rep > 0 ? 'sky' : 'stone'}>声望 {rep}/5</Pill>
            </div>
            <div className="mt-3 flex gap-1">
              {[0, 1, 2, 3, 4].map((lv) => (
                <div
                  key={lv}
                  className="h-1.5 flex-1 rounded-full"
                  style={{ backgroundColor: lv < rep ? meta.accent : '#3f3f46' }}
                />
              ))}
            </div>
            <ul className="mt-3 space-y-1 text-xs">
              {Object.entries(f.attrPerRepLevel).map(([k, v]) => (
                <li
                  key={k}
                  className="flex items-center justify-between rounded bg-zinc-950/40 px-2 py-1"
                >
                  <span className="text-zinc-300">{attrLabel(k as keyof Attributes)}</span>
                  <span className="font-medium" style={{ color: meta.accent }}>+{v ?? 0} / 级</span>
                </li>
              ))}
            </ul>
            <div className="mt-2 text-[11px] text-zinc-500">
              当前全团加成：{bonusParts.length ? bonusParts.join(' · ') : '—'}
            </div>
          </Card>
        );
      })}
    </div>
  </Section>
);

// ===== 5. 全部战绩 =====
const SORTIE_OUTCOME_META: Record<SortieLog['outcome'], { label: string; color: string; icon: string }> = {
  success: { label: '撤离成功', color: '#34d399', icon: '✅' },
  death: { label: '阵亡', color: '#f87171', icon: '💀' },
  timeout: { label: '超时撤离', color: '#fbbf24', icon: '⏳' },
};

export const ViewBattleLog: React.FC<ViewProps> = ({ state }) => (
  <Section title="📜 全部战绩" subtitle={`累计出击 ${state.sortieHistory.length} 次 · 展示最近 30 条`}>
    {state.sortieHistory.length === 0 ? (
      <Card><div className="text-sm text-zinc-400">尚无出击记录。前往「出击」体验首次搜打撤。</div></Card>
    ) : (
      <div className="space-y-2">
        {state.sortieHistory.slice(0, 30).map((s) => {
          const m = SORTIE_OUTCOME_META[s.outcome];
          const d = new Date(s.at);
          return (
            <Card key={s.id} className="!p-0 overflow-hidden">
              <div className="flex">
                <div className="w-1.5 shrink-0" style={{ backgroundColor: m.color }} />
                <div className="flex-1 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 text-sm">
                      <span className="font-semibold text-zinc-100">{s.survivorName}</span>
                      <span className="text-zinc-500">→</span>
                      <span className="text-zinc-300">{s.zoneName}</span>
                    </div>
                    <span
                      className="shrink-0 rounded px-2 py-0.5 text-xs font-medium"
                      style={{ color: m.color, backgroundColor: `${m.color}22` }}
                    >
                      {m.icon} {m.label}
                    </span>
                  </div>
                  <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-400">
                    <span>🕒 {d.toLocaleDateString()} {d.toLocaleTimeString()}</span>
                    <span className="text-emerald-300/80">📦 入库 {s.bankedItems} 件</span>
                    <span className="text-amber-300/80">⛁ {s.bankedValue}</span>
                    {s.enemyFaced && <span>· 遭遇 {s.enemyFaced}</span>}
                    {s.rescued && (
                      <span className="rounded bg-sky-500/15 px-1.5 py-0.5 text-sky-300">🤝 救援</span>
                    )}
                  </div>
                </div>
              </div>
            </Card>
          );
        })}
      </div>
    )}
  </Section>
);

// ===== 6. 探险日志（区域发现） =====
export const ViewExplorationNotes: React.FC<ViewProps> = ({ state }) => {
  const discovered = new Set(state.sortieHistory.map((s) => s.zoneName));
  return (
    <Section title="探险札记" subtitle="每次成功出击会解锁该区域的札记条目。">
      <div className="grid gap-3 sm:grid-cols-2">
        {DANGER_ZONES.map((z) => {
          const known = discovered.has(z.name);
          return (
            <Card key={z.id}>
              <div className="flex items-center justify-between">
                <div className="text-base font-semibold text-zinc-100">{known ? z.name : '【未探索】'}</div>
                <Pill tone={z.dangerLevel >= 4 ? 'red' : z.dangerLevel >= 2 ? 'amber' : 'green'}>危险 {z.dangerLevel}</Pill>
              </div>
              {known ? (
                <div className="mt-2 text-sm text-zinc-300">{z.flavor}</div>
              ) : (
                <div className="mt-2 text-sm text-zinc-500">完成该区域出击以解锁详细描述。</div>
              )}
            </Card>
          );
        })}
      </div>
    </Section>
  );
};

// ===== 7. 漫游搜打撤（v1.1.0：模拟跑一次完整副本，结算与手动出击同源） =====
export const ViewWandering: React.FC<ViewProps> = ({ state, mutate, rng }) => {
  // 行动点实时恢复展示：每秒刷新本地时钟（不写存档，避免高频落盘）
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const ap = actionPointView(state, now);
  const [report, setReport] = useState<WanderReport | null>(null);
  const [running, setRunning] = useState(false);
  const active = state.survivors.find((s) => s.id === state.activeSurvivorId);
  const remainClock = `${Math.floor(ap.remainMs / 60000)}:${String(
    Math.floor((ap.remainMs % 60000) / 1000),
  ).padStart(2, '0')}`;

  const runOnce = () => {
    if (!active) return;
    const { state: nextState, report: r } = simulateWanderSortie(state, { rng });
    if (!r.ok) {
      setReport(r);
      return;
    }
    setReport(r);
    mutate(() => nextState);
  };

  const logs = state.wanderLog ?? [];

  return (
    <Section
      title="漫游搜打撤"
      subtitle="派出击者自动下一次副本：会真的搜刮、遇敌、战斗、掉血、负伤，甚至阵亡濒死；结算规则与手动出击完全一致。"
    >
      <Card className="mb-3 !bg-zinc-900">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
          <span className="text-zinc-300">
            ⚡ 行动点{' '}
            <span
              className={`font-mono font-semibold ${
                ap.current >= ACTION_POINT_CAP ? 'text-emerald-400' : 'text-amber-400'
              }`}
            >
              {ap.current}
            </span>
            <span className="text-zinc-500"> / {ap.cap}</span>
          </span>
          <span className="text-xs text-zinc-400">
            {ap.full ? '已满（暂停恢复）' : `下一点 ${remainClock} 后 · 每 5 分钟 +1`}
          </span>
        </div>
      </Card>

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <button
          onClick={() => {
            setRunning(true);
            runOnce();
            setRunning(false);
          }}
          disabled={running || !active || ap.current < 6}
          className="rounded bg-emerald-600 px-4 py-2 text-white hover:bg-emerald-700 disabled:opacity-40"
        >
          派{active ? active.name : '未指定'}出击
        </button>
        <span className="text-xs text-zinc-400">
          消耗：危1 6 点 … 危7 12 点（区域随机，派出瞬间扣除）
        </span>
      </div>

      <div className="mb-4 rounded border border-amber-900/60 bg-amber-950/20 px-3 py-2 text-[11px] leading-relaxed text-amber-200/90">
        ⚠ 漫游并非无损：会按副本真实流程掉血、附加战后伤势，阵亡/超时同样进入<b>濒死</b>并可能
        <b>被夺走已穿戴装备</b>（安全箱内物品 100% 保留）。撤离失败时经验与搜刮废土币一律作废。
      </div>

      {report && !report.ok && (
        <div className="mb-3 rounded border border-rose-800 bg-rose-950/30 px-3 py-1.5 text-xs text-rose-300">
          {report.reason}
        </div>
      )}

      {report && report.ok && (
        <Card className="mb-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="font-semibold text-zinc-100">本局战报</h3>
            <Pill tone={report.outcome === 'success' ? 'green' : 'red'}>
              {report.outcome === 'success' ? '撤离成功' : report.outcome === 'timeout' ? '超时失败' : '阵亡'}
            </Pill>
          </div>
          <div className="mt-2 grid gap-2 text-xs sm:grid-cols-2">
            <div className="text-zinc-300">
              区域：<span className="text-zinc-100">{report.zoneName}</span>（危{report.dangerLevel}）· 消耗{' '}
              <span className="font-mono text-amber-300">{report.apCost}</span> 行动点
            </div>
            <div className="text-zinc-300">
              生命：
              <span className="font-mono text-zinc-100">
                {report.hpBefore} → {report.hpAfter}
              </span>
              <span className="text-zinc-500"> / {report.maxHp}</span>
            </div>
            <div className="text-zinc-300">
              入库：<span className="text-zinc-100">{report.items}</span> 件（估值{' '}
              <span className="font-mono text-amber-300">{report.value}</span>）
            </div>
            <div className="text-zinc-300">
              废土币：<span className="font-mono text-amber-300">+{report.credits}</span> · 经验：
              <span className="font-mono text-sky-300">+{report.xp}</span>
            </div>
            {report.enemyFaced && (
              <div className="text-zinc-300">
                遭遇：<span className="text-rose-300">{report.enemyFaced}</span>
              </div>
            )}
            {report.rescued && <div className="text-emerald-300">救出 1 名幸存者（已入花名册）</div>}
          </div>
          {(report.injuries.length > 0 || report.lostGear > 0 || report.dying) && (
            <div className="mt-2 space-y-1 text-xs">
              {report.injuries.length > 0 && (
                <div className="text-rose-300">
                  🩹 新增伤势：{report.injuries.map((i) => INJURY_LABEL[i]).join('、')}
                </div>
              )}
              {report.lostGear > 0 && <div className="text-rose-300">💀 被夺走装备 {report.lostGear} 件</div>}
              {report.dying && (
                <div className="text-rose-300">⚠ 已进入濒死状态，需救治后才能再次出击</div>
              )}
            </div>
          )}
        </Card>
      )}

      <div className="space-y-1">
        {logs.map((l, i) => (
          <div key={i} className="rounded bg-zinc-950 px-3 py-1 text-xs text-zinc-200">
            {l}
          </div>
        ))}
        {logs.length === 0 && <div className="text-sm text-zinc-500">还没有记录。</div>}
      </div>
    </Section>
  );
};

// ===== 8. 蜃景密室（高危 boss 连战，v1.1.10 实装） =====
export const ViewMirage: React.FC<ViewProps> = ({ state, mutate, rng }) => {
  const active = state.survivors.find((s) => s.id === state.activeSurvivorId) ?? null;
  const status = active ? state.survivorStatus[active.id] : undefined;
  const ap = actionPointView(state, Date.now());
  const dying =
    !!status?.dyingUntil && new Date(status.dyingUntil).getTime() > Date.now();
  const canEnter = !!active && !!status && !dying && ap.current >= MIRAGE_AP_COST;

  // 初始化：若存档里有上次连战日志则直接展示
  const [result, setResult] = useState<MirageResult | null>(() =>
    state.mirage && state.mirage.log.length > 0
      ? {
          ok: true,
          survivorName: active?.name,
          rounds: [],
          cleared: state.mirage.cleared,
          totalDrops: [],
          finalHp: status?.currentHp ?? 0,
          maxHp: status?.maxHp ?? 0,
          log: state.mirage.log,
        }
      : null,
  );
  const [busy, setBusy] = useState(false);

  const enter = () => {
    if (!active || busy || !canEnter) return;
    setBusy(true);
    const res = runMirageChamber(state, active.id, rng, Date.now());
    if (res.result.ok) {
      mutate(() => res.state);
      setResult(res.result);
    } else {
      setResult(res.result);
    }
    setBusy(false);
  };

  return (
    <Section title="蜃景密室" subtitle="危险等级 7 的扭曲时空，高风险高回报。">
      <Card className="mb-3 !bg-violet-950/20">
        <div className="text-sm text-zinc-200">
          消耗 <b className="text-amber-300">{MIRAGE_AP_COST}</b> 行动点，派当前出击者连战危1 → 危7 的 7 名 boss：
        </div>
        <ul className="mt-2 list-disc space-y-0.5 pl-5 text-[12px] text-zinc-400">
          <li>连战无休息——血量跨场继承，越往后越凶险；</li>
          <li>无经验获取，但每击败一名 boss 必掉落两件带阶级词缀的战利品；</li>
          <li>中途阵亡即结束，成员进入濒死（需救治）；通关则携战利品全身而退。</li>
        </ul>
        <div className="mt-3 flex items-center justify-between text-xs">
          <span className="text-zinc-400">
            当前出击者：<b className="text-zinc-100">{active?.name ?? '无'}</b>
            {status && `（${status.currentHp}/${status.maxHp}）`}
          </span>
          <span className="text-zinc-400">
            行动点：
            <b className={ap.current >= MIRAGE_AP_COST ? 'text-emerald-300' : 'text-rose-300'}>
              {ap.current}/{ap.cap}
            </b>
          </span>
        </div>
        {dying && <div className="mt-2 text-xs text-rose-300">⚠ 该成员处于濒死状态，无法进入。</div>}
        <button
          onClick={enter}
          disabled={!canEnter || busy}
          className="mt-3 rounded bg-violet-600 px-4 py-2 text-sm font-medium text-white hover:bg-violet-700 disabled:opacity-40"
        >
          {busy ? '连战中…' : `进入蜃景密室（耗 ${MIRAGE_AP_COST} 行动点）`}
        </button>
        {!active && <div className="mt-2 text-xs text-zinc-500">请先在避难所选好出击者。</div>}
        {active && !dying && ap.current < MIRAGE_AP_COST && (
          <div className="mt-2 text-xs text-rose-300">
            行动点不足，需 {MIRAGE_AP_COST} 点（每 5 分钟恢复 1 点）。
          </div>
        )}
      </Card>

      {result && (
        <Card>
          <div className="flex items-center justify-between">
            <div className="font-semibold text-zinc-100">
              战斗日志
              {result.cleared ? (
                <span className="text-emerald-300"> · 全 7 关通关 🏆</span>
              ) : (
                <span className="text-rose-300"> · 中途阵亡</span>
              )}
            </div>
            {result.totalDrops.length > 0 && (
              <div className="text-xs text-amber-300">获得装备 ×{result.totalDrops.length}</div>
            )}
          </div>
          <div className="mt-2 max-h-80 overflow-y-auto rounded bg-zinc-950/60 p-2 font-mono text-[11px] leading-relaxed text-zinc-300">
            {result.log.map((line, i) => (
              <div
                key={i}
                className={
                  line.includes('🎁')
                    ? 'text-emerald-300'
                    : line.includes('❌') || line.includes('⚠')
                      ? 'text-rose-300'
                      : line.includes('🏆')
                        ? 'text-amber-300'
                        : ''
                }
              >
                {line}
              </div>
            ))}
          </div>
          {result.totalDrops.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1">
              {result.totalDrops.map((g, i) => (
                <span
                  key={i}
                  className="rounded border px-1.5 py-0.5 text-[10px]"
                  style={{ borderColor: `${g.tierColor}66`, color: g.tierColor }}
                >
                  {g.name}
                </span>
              ))}
            </div>
          )}
        </Card>
      )}
    </Section>
  );
};

// ===== 9. 重塑六维（v1.1.0：取代旧「重塑天赋」，只重随初始基础六维） =====
export const ViewRerollAttributes: React.FC<ViewProps> = ({ state, mutate, rng }) => {
  // v1.1.0 补充：花费 500 币且不可逆，需要内联二次确认（window.confirm 在本壳内不可靠）
  const [confirming, setConfirming] = useState(false);
  const active = state.survivors.find((s) => s.id === state.activeSurvivorId);
  if (!active) {
    return (
      <Section title="重塑六维">
        <div className="text-zinc-400">未指定出击者。</div>
      </Section>
    );
  }
  const base = active.baseAttributes;
  const afford = state.coins >= REROLL_ATTR_COST;
  const doReroll = () => {
    if (!afford) return;
    if (!confirming) {
      setConfirming(true);
      return;
    }
    mutate((s) => rerollBaseAttributes(s, active.id, rng));
    setConfirming(false);
  };
  return (
    <Section
      title="重塑六维"
      subtitle={
        <span>
          当前出击者：{active.name}（<TierBadge tier={active.tier} name={active.tierName} size="sm" />）
        </span>
      }
    >
      <Card>
        <div className="text-sm text-zinc-200">
          消耗 <span className="font-semibold text-amber-300">{REROLL_ATTR_COST}</span> 废土币，把{' '}
          <span className="text-zinc-100">{active.name}</span> 的
          <b> 初始六维基础属性 </b>重新随机（每项 6~25）。
        </div>
        <div className="mt-2 text-xs text-zinc-400">
          只重随「最原始的初始基础属性」——词条加成、升级加点、等级、经验、装备与伤势全部保留；段位随新战力重算。
        </div>
        {base ? (
          <div className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-6">
            {ALL_ATTR_KEYS.map((k) => (
              <div
                key={k}
                className="rounded border border-zinc-800 bg-zinc-950 px-2 py-1.5 text-center"
              >
                <div className="text-[11px] text-zinc-500">{attrLabel(k)}</div>
                <div className="font-mono text-sm text-zinc-100">{base[k]}</div>
              </div>
            ))}
          </div>
        ) : (
          <div className="mt-3 text-xs text-zinc-500">（该存档尚未记录初始基础属性，重随时会自动补齐）</div>
        )}
        <div className="mt-3 text-xs text-zinc-400">
          费用：{REROLL_ATTR_COST} 废土币 · 当前余额 {state.coins}
        </div>
        {confirming ? (
          <div className="mt-3 rounded border border-amber-700 bg-amber-950/30 px-3 py-2">
            <div className="text-sm text-amber-200">
              ⚠ 确认消耗 {REROLL_ATTR_COST} 废土币，将 {active.name} 的初始六维基础属性全部重新随机（6~25）？
            </div>
            <div className="mt-1 text-xs text-amber-300/80">此操作不可撤销，可能抽到比现在更差的属性。</div>
            <div className="mt-2 flex gap-2">
              <button
                onClick={doReroll}
                className="rounded bg-amber-600 px-3 py-1 text-xs text-white hover:bg-amber-700"
              >
                确认重塑
              </button>
              <button
                onClick={() => setConfirming(false)}
                className="rounded bg-zinc-700 px-3 py-1 text-xs text-white hover:bg-zinc-600"
              >
                取消
              </button>
            </div>
          </div>
        ) : (
          <button
            onClick={doReroll}
            disabled={!afford}
            className="mt-3 rounded bg-amber-600 px-4 py-2 text-white hover:bg-amber-700 disabled:opacity-40"
          >
            消耗 {REROLL_ATTR_COST} 重塑六维
          </button>
        )}
        {!afford && (
          <p className="mt-2 text-xs text-rose-300">⚠ 废土币不足，还差 {REROLL_ATTR_COST - state.coins} 币。</p>
        )}
      </Card>
    </Section>
  );
};

// ===== 10. 任务中心 =====
export const ViewQuests: React.FC<ViewProps> = ({ state, mutate }) => {
  const progress = useMemo(() => todayQuestsProgress(state), [state]);
  return (
    <Section title="任务中心" subtitle="每日悬赏：完成出击目标领取废土币与医疗物资。">
      <div className="space-y-3">
        {progress.map(({ quest, done, target, doneGoal, claimed }) => (
          <Card key={quest.id}>
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="font-semibold text-zinc-100">{quest.name}</div>
                <div className="text-sm text-zinc-400">{quest.desc}</div>
                <div className="mt-2 text-xs text-zinc-400">进度 {done} / {target}</div>
              </div>
              <div className="text-right">
                <Pill tone={claimed ? 'stone' : doneGoal ? 'green' : 'amber'}>
                  {claimed ? '已领' : doneGoal ? '可领' : '进行中'}
                </Pill>
                <div className="mt-2 text-xs text-zinc-300">奖励 {quest.rewardCoins} 废土币{quest.rewardMedicineId && '+1 ' + (MEDICINES.find((m) => m.id === quest.rewardMedicineId)?.name ?? '')}</div>
                <button
                  onClick={() => mutate((s) => claimQuest(s, quest.id))}
                  disabled={!doneGoal || claimed}
                  className="mt-2 rounded bg-emerald-600 px-3 py-1 text-xs text-white hover:bg-emerald-700 disabled:opacity-40"
                >领取</button>
              </div>
            </div>
          </Card>
        ))}
      </div>
    </Section>
  );
};

// ===== 11. 废土市场（NPC 交易） =====
export const ViewMarket: React.FC<ViewProps> = ({ state, mutate }) => {
  // v1.0.2：购买需二次确认防误触；支持批量 ×1 / ×5；确认后扣币入库
  const [pending, setPending] = useState<{ id: MedicineSpec['id']; qty: number } | null>(null);
  const [bought, setBought] = useState<string | null>(null);
  // v1.1.0：出售区 —— 材料按基础价 ×2；装备按稀有度阶级浮动计价
  const [soldMsg, setSoldMsg] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  // v1.1.8：材料「全部」出售二次确认 / 仓库装备按阶一键批量出售二次确认
  const [pendingSellMat, setPendingSellMat] = useState<{ id: string; qty: number } | null>(null);
  const [pendingSellTier, setPendingSellTier] = useState<{ tier: number; name: string; ids: string[]; gain: number } | null>(null);
  const equippedIds = useMemo(
    () =>
      new Set(
        Object.values(state.equipped).flatMap((slots) =>
          Object.values(slots).filter((x): x is string => typeof x === 'string'),
        ),
      ),
    [state.equipped],
  );
  const sellable = state.gear.filter((g) => !equippedIds.has(g.id));
  // v1.1.8：仓库装备按阶级升序（锈蚀 → 神话）排列
  const sortedSellable = useMemo(
    () => [...sellable].sort((a, b) => (a.tier ?? 0) - (b.tier ?? 0)),
    [sellable],
  );
  // v1.1.8：按阶级聚合仓库装备 id，供「一键出售某阶」使用
  const sellByTier = useMemo(() => {
    const map = new Map<number, string[]>();
    for (const g of sellable) {
      const t = g.tier ?? 0;
      if (!map.has(t)) map.set(t, []);
      map.get(t)!.push(g.id);
    }
    return map;
  }, [sellable]);
  // v1.1.8：可一键出售的 4 个低阶（锈蚀/改制/精工/军用）
  const SELL_TIERS = [
    { tier: 0, name: '锈蚀' },
    { tier: 1, name: '改制' },
    { tier: 2, name: '精工' },
    { tier: 3, name: '军用' },
  ];
  const selectedTotal = selected.reduce((acc, id) => {
    const g = state.gear.find((x) => x.id === id);
    return acc + (g ? gearSellPrice(g) : 0);
  }, 0);

  const doBuy = (id: MedicineSpec['id'], qty: number) => {
    const spec = MEDICINES.find((m) => m.id === id);
    if (!spec) return;
    mutate((s) => buyMedicine(s, id, qty));
    setBought(`✅ 已购买 ${spec.name}×${qty}，消耗 ${spec.costCoins * qty} 废土币（库存 +${qty}）。`);
    setPending(null);
    setSoldMsg(null);
  };

  const doSellMaterial = (m: MaterialItem, qty: number) => {
    const sell = Math.min(Math.floor(qty), m.quantity);
    if (sell <= 0) return;
    const gain = materialSellPrice(m) * sell;
    mutate((s) => sellMaterials(s, m.id, sell));
    setSoldMsg(`✅ 卖出 ${m.name}×${sell}，+${gain} 废土币。`);
    setBought(null);
  };

  const doSellGear = () => {
    if (selected.length === 0) return;
    const gain = selectedTotal;
    const n = selected.length;
    mutate((s) => recycleGear(s, selected));
    setSoldMsg(`✅ 卖出 ${n} 件装备，+${gain} 废土币。`);
    setBought(null);
    setSelected([]);
  };

  // v1.1.8：一键出售某一阶级的全部仓库装备（二次确认后执行）
  const doSellTier = () => {
    if (!pendingSellTier || pendingSellTier.ids.length === 0) return;
    const ids = pendingSellTier.ids;
    const gain = pendingSellTier.gain;
    const n = ids.length;
    const name = pendingSellTier.name;
    mutate((s) => recycleGear(s, ids));
    setSoldMsg(`✅ 卖出 ${n} 件${name}阶装备，+${gain} 废土币。`);
    setBought(null);
    setSelected((prev) => prev.filter((x) => !ids.includes(x)));
    setPendingSellTier(null);
  };

  return (
    <Section title="废土市场" subtitle="从市集购入医疗物资，出售多余材料与仓库装备。">
      <div className="grid gap-3 sm:grid-cols-2">
        <Card>
          <h3 className="font-semibold text-zinc-100">购入医疗品</h3>
          <p className="mt-1 text-xs text-zinc-400">
            当前废土币：<span className="font-medium text-zinc-200">{state.coins}</span>
          </p>
          {bought && <div className="mt-2 rounded border border-emerald-800 bg-emerald-950/30 px-2 py-1 text-xs text-emerald-300">{bought}</div>}
          <div className="mt-3 space-y-3">
            {MEDICINES.map((m) => {
              const stock = state.medicines[m.id] ?? 0;
              const isPending = pending?.id === m.id;
              const qty = isPending ? pending.qty : 1;
              const total = m.costCoins * qty;
              const afford = state.coins >= m.costCoins;
              const affordQty = state.coins >= total;
              return (
                <div key={m.id} className="rounded border border-zinc-800 p-2.5">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="font-medium text-zinc-100">
                        {m.name}
                        <span className="ml-2 text-xs text-zinc-400">库存 ×{stock}</span>
                      </div>
                      <div className="text-xs text-zinc-400">{m.description}</div>
                      <div className="mt-0.5 text-xs text-zinc-300">单价 {m.costCoins} 废土币</div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      {[1, 5].map((q) => (
                        <button
                          key={q}
                          onClick={() => { setPending({ id: m.id, qty: q }); setBought(null); }}
                          disabled={!afford}
                          className={`rounded px-2 py-1 text-xs transition ${
                            isPending && qty === q
                              ? 'bg-sky-700 text-white'
                              : 'bg-sky-600 text-white hover:bg-sky-700'
                          } disabled:opacity-40`}
                        >
                          ×{q}
                        </button>
                      ))}
                    </div>
                  </div>
                  {isPending && (
                    <div className="mt-2 flex items-center justify-between rounded border border-amber-700 bg-amber-950/30 px-2 py-1.5">
                      <span className="text-xs text-amber-300">
                        确认购买 {m.name}×{qty}？将消耗 <span className="font-semibold">{total}</span> 废土币
                        {!affordQty && '（废土币不足！）'}
                      </span>
                      <span className="flex gap-1">
                        <button
                          onClick={() => doBuy(m.id, qty)}
                          disabled={!affordQty}
                          className="rounded bg-emerald-600 px-2 py-1 text-xs text-white hover:bg-emerald-700 disabled:opacity-40"
                        >
                          确认购买
                        </button>
                        <button
                          onClick={() => setPending(null)}
                          className="rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
                        >
                          取消
                        </button>
                      </span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </Card>
        <Card>
          <h3 className="font-semibold text-zinc-100">出售物资</h3>
          <p className="mt-1 text-xs text-zinc-400">
            材料按基础价 ×2 回收；装备按稀有度阶级浮动计价（白 1.0× → 红 2.2×）。已穿戴的装备需先卸下。
          </p>
          {soldMsg && (
            <div className="mt-2 rounded border border-emerald-800 bg-emerald-950/30 px-2 py-1 text-xs text-emerald-300">
              {soldMsg}
            </div>
          )}

          <div className="mt-3">
            <div className="text-xs text-zinc-400">材料</div>
            <div className="mt-1.5 space-y-1.5">
              {state.materials.length === 0 && (
                <div className="text-xs text-zinc-500">暂无材料可出售。</div>
              )}
              {state.materials.map((m) => {
                const isMatPending = pendingSellMat?.id === m.id;
                const matPendingQty = isMatPending ? pendingSellMat!.qty : 0;
                const matPendingGain = isMatPending ? materialSellPrice(m) * matPendingQty : 0;
                return (
                  <Fragment key={m.id}>
                    <div
                      className="flex items-center justify-between gap-2 rounded border border-zinc-800 px-2 py-1.5"
                    >
                      <div className="min-w-0">
                        <div className="truncate text-sm text-zinc-100">{m.name}</div>
                        <div className="text-[11px] text-zinc-500">
                          库存 ×{m.quantity} · 单价 {materialSellPrice(m)} 币
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        <button
                          onClick={() => doSellMaterial(m, 1)}
                          className="rounded bg-stone-600 px-2 py-1 text-xs text-white hover:bg-stone-700"
                        >
                          ×1
                        </button>
                        <button
                          onClick={() => doSellMaterial(m, 5)}
                          className="rounded bg-stone-600 px-2 py-1 text-xs text-white hover:bg-stone-700"
                        >
                          ×5
                        </button>
                        <button
                          onClick={() => setPendingSellMat({ id: m.id, qty: Math.max(1, m.quantity) })}
                          className="rounded bg-stone-700 px-2 py-1 text-xs text-white hover:bg-stone-600"
                        >
                          全部
                        </button>
                      </div>
                    </div>
                    {isMatPending && (
                      <div className="mt-1 flex items-center justify-between rounded border border-amber-700 bg-amber-950/30 px-2 py-1.5">
                        <span className="text-xs text-amber-300">
                          确认卖出全部 {m.name}（×{matPendingQty}）？将获得{' '}
                          <span className="font-semibold">{matPendingGain}</span> 废土币
                        </span>
                        <span className="flex shrink-0 gap-1">
                          <button
                            onClick={() => {
                              doSellMaterial(m, matPendingQty);
                              setPendingSellMat(null);
                            }}
                            className="rounded bg-emerald-600 px-2 py-1 text-xs text-white hover:bg-emerald-700"
                          >
                            确认卖出
                          </button>
                          <button
                            onClick={() => setPendingSellMat(null)}
                            className="rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
                          >
                            取消
                          </button>
                        </span>
                      </div>
                    )}
                  </Fragment>
                );
              })}
            </div>
          </div>

          <div className="mt-4">
            <div className="flex items-center justify-between text-xs text-zinc-400">
              <span>仓库装备（{sellable.length} 件可出售）</span>
              <span>
                已选 {selected.length} 件 · 可得{' '}
                <span className="font-mono text-amber-300">{selectedTotal}</span> 币
              </span>
            </div>
            {sellable.length === 0 ? (
              <div className="mt-1.5 text-xs text-zinc-500">
                仓库没有可出售的装备（已穿戴的需先卸下）。
              </div>
            ) : (
              <>
                {/* v1.1.8：按阶级一键出售（二次确认） */}
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {SELL_TIERS.map(({ tier, name }) => {
                    const ids = sellByTier.get(tier) ?? [];
                    const gain = ids.reduce((acc, id) => {
                      const g = state.gear.find((x) => x.id === id);
                      return acc + (g ? gearSellPrice(g) : 0);
                    }, 0);
                    const disabled = ids.length === 0;
                    const active = pendingSellTier?.tier === tier;
                    return (
                      <button
                        key={tier}
                        disabled={disabled}
                        onClick={() => setPendingSellTier({ tier, name, ids, gain })}
                        title={`一键出售所有${name}阶仓库装备`}
                        className={`rounded px-2 py-1 text-xs transition ${
                          active
                            ? 'bg-amber-700 text-white'
                            : disabled
                            ? 'cursor-not-allowed bg-zinc-800 text-zinc-600'
                            : 'bg-zinc-700 text-zinc-100 hover:bg-zinc-600'
                        }`}
                      >
                        一键出售{name}阶（{ids.length}）
                      </button>
                    );
                  })}
                </div>
                {pendingSellTier && (
                  <div className="mt-2 flex items-center justify-between rounded border border-amber-700 bg-amber-950/30 px-2 py-1.5">
                    <span className="text-xs text-amber-300">
                      确认出售全部{pendingSellTier.name}阶装备（{pendingSellTier.ids.length} 件）？将获得{' '}
                      <span className="font-semibold">{pendingSellTier.gain}</span> 废土币
                    </span>
                    <span className="flex shrink-0 gap-1">
                      <button
                        onClick={doSellTier}
                        className="rounded bg-emerald-600 px-2 py-1 text-xs text-white hover:bg-emerald-700"
                      >
                        确认出售
                      </button>
                      <button
                        onClick={() => setPendingSellTier(null)}
                        className="rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
                      >
                        取消
                      </button>
                    </span>
                  </div>
                )}
                <div className="mt-2 max-h-56 space-y-1 overflow-y-auto pr-1">
                  {sortedSellable.map((g) => {
                    const on = selected.includes(g.id);
                    return (
                      <button
                        key={g.id}
                        onClick={() =>
                          setSelected((prev) =>
                            on ? prev.filter((x) => x !== g.id) : [...prev, g.id],
                          )
                        }
                        className={`flex w-full items-center justify-between gap-2 rounded border px-2 py-1.5 text-left transition ${
                          on
                            ? 'border-amber-600 bg-amber-950/30'
                            : 'border-zinc-800 hover:border-zinc-600'
                        }`}
                      >
                        <span className="min-w-0">
                          <span
                            className="block truncate text-sm"
                            style={{ color: g.tierColor ?? '#e4e4e7' }}
                          >
                            {g.name}
                          </span>
                          <span className="block text-[11px] text-zinc-500">
                            {g.rarityName ?? g.rarity} · {g.affixes.length} 词条
                          </span>
                        </span>
                        <span className="shrink-0 font-mono text-xs text-amber-300">
                          {gearSellPrice(g)} 币
                        </span>
                      </button>
                    );
                  })}
                </div>
              </>
            )}
            <button
              onClick={doSellGear}
              disabled={selected.length === 0}
              className="mt-2 rounded bg-stone-600 px-3 py-1 text-xs text-white hover:bg-stone-700 disabled:opacity-40"
            >
              出售选中装备
            </button>
          </div>
        </Card>
      </div>
    </Section>
  );
};

// ===== 12. 装备改装：选择当前出击者的已装备装备，500 币重 roll 词条，5% 升 1 阶 =====
export const ViewReforge: React.FC<ViewProps> = ({ state, mutate, rng }) => {
  const hero = activeSurvivor(state);
  const slots: GearSlot[] = ['weapon', 'offWeapon', 'head', 'armor', 'legs', 'accessory'];
  const equipped = state.equipped[hero?.id ?? ''] ?? {};
  const [lastResult, setLastResult] = useState<{ name: string; tierUp: boolean; affixes: string[] } | null>(null);

  return (
    <Section
      title="装备改装"
      subtitle={
        hero
          ? `选择 ${hero.name} 已穿戴的装备，消耗 500 废土币重 roll 词条（5% 概率升 1 阶，最高红阶）。`
          : '未指定当前出击者，请先在战团界面选择一名幸存者。'
      }
    >
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {slots.map((slot) => {
          const gearId = equipped[slot];
          const gear = gearId ? state.gear.find((g) => g.id === gearId) : undefined;
          const can = hero && gear && state.coins >= 500;
          return (
            <Card key={slot}>
              <div className="font-semibold text-zinc-100">{GEAR_SLOT_LABEL[slot]}</div>
              {gear ? (
                <>
                  <div className="mt-2 text-sm font-medium" style={{ color: gear.tierColor ?? '#e4e4e7' }}>
                    {gear.name}
                  </div>
                  <div className="mt-1 text-xs text-zinc-400">
                    {gear.affixes.length ? gear.affixes.join(' / ') : '无额外词缀'}
                  </div>
                  <div className="mt-1 text-xs text-zinc-500">估值 ⛁{gearSellPrice(gear)}</div>
                </>
              ) : (
                <div className="mt-2 text-xs text-zinc-500">当前出击者在此槽位没有装备。</div>
              )}
              <button
                onClick={() => {
                  if (!hero || !gear) return;
                  const res = reforgeEquippedGear(state, rng, hero.id, slot);
                  if (res.gear) {
                    mutate(() => res.state);
                    setLastResult({
                      name: res.gear.name,
                      tierUp: res.tierUp,
                      affixes: res.gear.affixes,
                    });
                  }
                }}
                disabled={!can}
                className="mt-3 rounded bg-amber-600 px-3 py-1 text-xs text-white hover:bg-amber-700 disabled:opacity-40"
              >
                改装（500 币）
              </button>
            </Card>
          );
        })}
      </div>

      {lastResult && (
        <div className="mt-4 rounded-lg border border-zinc-800 bg-zinc-900 p-3 text-sm">
          <div className="font-semibold text-zinc-200">
            {lastResult.tierUp ? '🎉 改装大成功！' : '改装完成'}
          </div>
          <div className="mt-1 text-zinc-400">
            {lastResult.name}
            {lastResult.tierUp ? ' 阶级提升' : ''}：
            {lastResult.affixes.length ? lastResult.affixes.join(' / ') : '无额外词缀'}
          </div>
        </div>
      )}
    </Section>
  );
};

// ===== 13. 英雄商城（废土钻石 premiumCoins 购买稀有道具，v1.1.10 实装） =====
export const ViewPremiumShop: React.FC<ViewProps> = ({ state, mutate, rng }) => {
  const premium = state.premiumCoins ?? 0;
  const charms = state.tierCharms ?? 0;
  const hero = activeSurvivor(state);
  const slots: GearSlot[] = ['weapon', 'offWeapon', 'head', 'armor', 'legs', 'accessory'];
  const equipped = state.equipped[hero?.id ?? ''] ?? {};

  const [toast, setToast] = useState<string | null>(null);
  const [useCharm, setUseCharm] = useState(false);
  const [confirmSlot, setConfirmSlot] = useState<GearSlot | null>(null);
  const [lastResult, setLastResult] = useState<{ name: string; tierUp: boolean } | null>(null);
  const [gmUnlocked, setGmUnlocked] = useState(() => readGmUnlocked());

  // 用废土钻石购买：校验 + 扣钻 + 应用效果；effect 在 apply 内完成（caller 已校验钻充足）
  const buy = (cost: number, label: string, apply: (s: SurvivalGameState) => SurvivalGameState) => {
    if (premium < cost) {
      setToast(`⚠️ 废土钻石不足，需要 ${cost}（当前 ${premium}）。`);
      return;
    }
    mutate((s) => {
      if ((s.premiumCoins ?? 0) < cost) return s;
      const spent = { ...s, premiumCoins: (s.premiumCoins ?? 0) - cost };
      return apply(spent);
    });
    setToast(`✅ 已用 ${cost} 废土钻石购买：${label}。`);
  };

  const onBuySummon = () => {
    if (state.survivors.length >= WARBAND_CAP) {
      setToast('⚠️ 战团已满，招募需先遣散。');
      return;
    }
    buy(100, '钢铁幸存者招募券', (s) => addSummonedSurvivor(s, generateSurvivor(rng, { genTier: 4 }), Date.now()));
  };
  const onBuyHeal = () => buy(20, '全队满血包', (s) => fullHealTeam(s, Date.now()));
  const onBuyCharm = () => buy(200, '装备升阶符', (s) => ({ ...s, tierCharms: (s.tierCharms ?? 0) + 1 }));

  const onUseCharm = (slot: GearSlot) => {
    if (!hero) return;
    const res = upgradeEquippedGearTier(state, rng, hero.id, slot);
    if (!res.gear) {
      setToast('该槽位没有装备或升阶符不足。');
      setConfirmSlot(null);
      return;
    }
    mutate(() => res.state);
    setConfirmSlot(null);
    setUseCharm(false);
    setLastResult({ name: res.gear.name, tierUp: res.tierUp });
  };

  const shopBtn = (disabled: boolean, onClick: () => void, label: string) => (
    <button
      onClick={onClick}
      disabled={disabled}
      className="mt-3 rounded bg-amber-600 px-3 py-1 text-xs text-white hover:bg-amber-700 disabled:opacity-40"
    >
      {label}
    </button>
  );

  return (
    <Section
      title="英雄商城"
      subtitle="使用废土钻石购买稀有道具。"
      right={<span className="text-xs text-amber-300">当前废土钻石：{premium}</span>}
    >
      {toast && (
        <div className="rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-200">{toast}</div>
      )}

      <Card className="mb-3 !bg-amber-950/30">
        <div className="text-sm text-amber-300">废土钻石：{premium}</div>
        <p className="mt-1 text-[11px] text-zinc-500">钻石为高级货币，用于兑换英雄商城的稀有道具。</p>
        {gmUnlocked && (
          <button
            onClick={() => mutate((s) => ({ ...s, premiumCoins: (s.premiumCoins ?? 0) + 20 }))}
            className="mt-2 rounded bg-amber-600 px-3 py-1 text-xs text-white hover:bg-amber-700"
          >
            +20（演示按钮）
          </button>
        )}
      </Card>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {/* 钢铁幸存者招募券 */}
        <Card>
          <div className="font-semibold text-zinc-100">钢铁幸存者招募券</div>
          <div className="mt-1 text-xs text-zinc-400">使用后获得一名钢铁幸存者（段位4 资质）。</div>
          <div className="mt-2 text-xs text-amber-300">100 废土钻石</div>
          {shopBtn(premium < 100, onBuySummon, '兑换（100 钻石）')}
        </Card>

        {/* 全队满血包 */}
        <Card>
          <div className="font-semibold text-zinc-100">全队满血包</div>
          <div className="mt-1 text-xs text-zinc-400">所有幸存者立即满血、清除全部伤势与濒死状态。</div>
          <div className="mt-2 text-xs text-amber-300">20 废土钻石</div>
          {shopBtn(premium < 20, onBuyHeal, '兑换（20 钻石）')}
        </Card>

        {/* 装备升阶符 */}
        <Card>
          <div className="font-semibold text-zinc-100">装备升阶符</div>
          <div className="mt-1 text-xs text-zinc-400">对当前出击者的一件已装备升 1 阶（最高神话）。持有 {charms} 张。</div>
          <div className="mt-2 text-xs text-amber-300">200 废土钻石</div>
          {shopBtn(premium < 200, onBuyCharm, '兑换（200 钻石）')}
          {charms > 0 && (
            <button
              onClick={() => setUseCharm((v) => !v)}
              className="ml-2 mt-3 rounded bg-stone-600 px-3 py-1 text-xs text-white hover:bg-stone-700"
            >
              选择使用（{charms}）
            </button>
          )}
        </Card>
      </div>

      {/* 升阶符使用面板：列出当前出击者装备栏，逐件升阶（二次确认） */}
      {useCharm && (
        <Card className="mt-3">
          <div className="font-semibold text-zinc-100">
            装备升阶符 · 选择使用
            <span className="ml-2 text-xs font-normal text-zinc-500">当前出击者：{hero ? hero.name : '未指定'}</span>
          </div>
          {!hero ? (
            <div className="mt-2 text-xs text-zinc-500">请先在战团界面选择一名当前出击者。</div>
          ) : (
            <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {slots.map((slot) => {
                const gearId = equipped[slot];
                const gear = gearId ? state.gear.find((g) => g.id === gearId) : undefined;
                const isMax = (gear?.tier ?? 0) >= 6;
                return (
                  <div key={slot} className="rounded border border-zinc-800 p-2">
                    <div className="text-xs text-zinc-400">{GEAR_SLOT_LABEL[slot]}</div>
                    {gear ? (
                      <>
                        <div className="mt-1 text-sm font-medium" style={{ color: gear.tierColor ?? '#e4e4e7' }}>
                          {gear.name}
                        </div>
                        <div className="text-[11px] text-zinc-500">
                          {gear.rarityName ?? gear.rarity} · {gear.affixes.length} 词条
                        </div>
                        {confirmSlot === slot ? (
                          <div className="mt-2 flex gap-2">
                            <button
                              onClick={() => onUseCharm(slot)}
                              disabled={charms <= 0}
                              className="rounded bg-amber-600 px-2 py-1 text-[11px] text-white hover:bg-amber-700 disabled:opacity-40"
                            >
                              确认升阶
                            </button>
                            <button
                              onClick={() => setConfirmSlot(null)}
                              className="rounded bg-zinc-700 px-2 py-1 text-[11px] text-white hover:bg-zinc-600"
                            >
                              取消
                            </button>
                          </div>
                        ) : (
                          <button
                            onClick={() => setConfirmSlot(slot)}
                            disabled={charms <= 0 || isMax}
                            className="mt-2 rounded bg-amber-600 px-2 py-1 text-[11px] text-white hover:bg-amber-700 disabled:opacity-40"
                          >
                            {isMax ? '已是最高阶' : '升阶'}
                          </button>
                        )}
                      </>
                    ) : (
                      <div className="mt-2 text-xs text-zinc-600">（空）</div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </Card>
      )}

      {lastResult && (
        <div className="mt-4 rounded-lg border border-zinc-800 bg-zinc-900 p-3 text-sm">
          <div className="font-semibold text-zinc-200">
            {lastResult.tierUp ? '🎉 升阶成功！' : '升阶符已使用'}
          </div>
          <div className="mt-1 text-zinc-400">
            {lastResult.name}
            {lastResult.tierUp ? ' 阶级已提升。' : '（已是最高阶，未消耗升阶符）'}
          </div>
        </div>
      )}
    </Section>
  );
};

// ===== 14. 拍卖行（v1.1.9：本地单用户拍卖，随机刷装备 + 废土币购买） =====
export const ViewAuction: React.FC<ViewProps> = ({ state, mutate, rng }) => {
  const [now, setNow] = useState(() => Date.now());
  const [toast, setToast] = useState<string | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;

  // 倒计时：每秒刷新一次 now
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const doRefresh = useCallback(
    (paid: boolean) => {
      const cost = paid ? AUCTION_INSTANT_REFRESH_COST : 0;
      if (paid && stateRef.current.coins < cost) {
        setToast(`⚠️ 废土币不足，立即刷新需要 ${cost} 币（当前 ${stateRef.current.coins}）。`);
        return;
      }
      mutate((s) => rollNewAuction(s, rng, Date.now(), cost));
      setToast(paid ? `✅ 花费 ${cost} 废土币刷新了拍卖行。` : '✅ 拍卖行已刷新。');
    },
    [mutate, rng],
  );

  // 挂载时若无拍卖数据或已过期则自动刷新；倒计时归零也会自动刷新
  useEffect(() => {
    const a = stateRef.current.auction;
    if (!a || a.refreshAt <= now) doRefresh(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [now]);

  const auc = state.auction;
  const remainingMs = Math.max(0, (auc?.refreshAt ?? 0) - now);
  const mm = Math.floor(remainingMs / 60000);
  const ss = Math.floor((remainingMs % 60000) / 1000);
  const countdown = `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;

  const onBuy = (item: AuctionItem) => {
    if (item.sold) return;
    if (state.coins < item.price) {
      setToast(`⚠️ 废土币不足，需要 ${item.price} 币（当前 ${state.coins}）。`);
      return;
    }
    mutate((s) => buyAuctionItem(s, item.id));
    setToast(`✅ 已购入 ${item.gear.name}（${item.gear.rarityName ?? item.gear.rarity}）。`);
  };

  const canInstant = state.coins >= AUCTION_INSTANT_REFRESH_COST;

  return (
    <Section
      title="拍卖行"
      subtitle={
        <span>
          废土游商随机上架 {AUCTION_COUNT} 件装备，每 <b className="text-amber-300">30 分钟</b> 自动刷新；
          也可花 <b className="text-amber-300">{AUCTION_INSTANT_REFRESH_COST} 废土币</b> 立即再刷一轮（不影响自动倒计时）。
        </span>
      }
      right={
        <div className="flex items-center gap-2">
          <div className="text-right">
            <div className="font-mono text-xs text-zinc-400">下次刷新</div>
            <div className="font-mono text-lg font-semibold text-amber-300">{countdown}</div>
          </div>
          <button
            onClick={() => doRefresh(true)}
            disabled={!canInstant}
            title={canInstant ? '立即再刷一轮' : `需要 ${AUCTION_INSTANT_REFRESH_COST} 废土币`}
            className="rounded bg-amber-600 px-3 py-2 text-xs font-medium text-white transition hover:bg-amber-500 disabled:cursor-not-allowed disabled:opacity-40"
          >
            立即刷新<br />({AUCTION_INSTANT_REFRESH_COST} 币)
          </button>
        </div>
      }
    >
      <div className="mb-3 flex items-center justify-between text-xs text-zinc-400">
        <span>当前废土币：<span className="font-mono text-amber-300">{state.coins}</span></span>
        <span>已上架 {auc?.items.length ?? 0} 件 · 余 {auc?.items.filter((x) => !x.sold).length ?? 0} 件可购</span>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {(auc?.items ?? []).map((item) => {
          const g = item.gear;
          const color = g.tierColor ?? '#e4e4e7';
          const mods = Object.entries(g.modifiers ?? {}).filter(([, v]) => (v ?? 0) !== 0);
          const combat = g.combat
            ? [
                g.combat.hpBonus ? `生命 +${g.combat.hpBonus}` : '',
                g.combat.critBonus ? `暴击 +${Math.round(g.combat.critBonus * 100)}%` : '',
                g.combat.lootLuck ? `搜刮 +${Math.round(g.combat.lootLuck * 100)}%` : '',
                g.combat.xpBonus ? `经验 +${Math.round(g.combat.xpBonus * 100)}%` : '',
                g.combat.coinBonus ? `金币 +${Math.round(g.combat.coinBonus * 100)}%` : '',
              ].filter(Boolean)
            : [];
          const affordable = !item.sold && state.coins >= item.price;
          return (
            <Card
              key={item.id}
              className="flex flex-col"
              style={{ borderColor: item.sold ? '#3f3f46' : color }}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold" style={{ color }}>
                    {g.name}
                  </div>
                  <div className="text-[11px] text-zinc-400">
                    {GEAR_SLOT_LABEL[g.slot]} · {g.rarityName ?? g.rarity}
                  </div>
                </div>
                <span
                  className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium"
                  style={{ background: `${color}22`, color }}
                >
                  {g.rarityName ?? g.rarity}
                </span>
              </div>

              <div className="mt-2 flex flex-wrap gap-x-2 gap-y-1 text-[11px]">
                {(() => {
                  const chips: { text: string; tone: 'attr' | 'combat' }[] = [];
                  for (const [k, v] of Object.entries(g.modifiers ?? {})) {
                    if ((v ?? 0) !== 0) {
                      chips.push({ text: `${attrLabel(k as keyof Attributes)}+${v}`, tone: 'attr' });
                    }
                  }
                  const c = g.combat;
                  if (c) {
                    if (c.hpBonus) chips.push({ text: `生命+${c.hpBonus}`, tone: 'combat' });
                    if (c.critBonus) chips.push({ text: `暴击+${Math.round(c.critBonus * 100)}%`, tone: 'combat' });
                    if (c.lootLuck) chips.push({ text: `搜刮+${Math.round((c.lootLuck ?? 0) * 100)}%`, tone: 'combat' });
                    if (c.xpBonus) chips.push({ text: `经验+${Math.round((c.xpBonus ?? 0) * 100)}%`, tone: 'combat' });
                    if (c.coinBonus) chips.push({ text: `金币+${Math.round((c.coinBonus ?? 0) * 100)}%`, tone: 'combat' });
                  }
                  return chips.map((chip, i) => (
                    <span
                      key={i}
                      className="rounded px-1.5 py-0.5 text-[11px]"
                      style={{
                        background: chip.tone === 'attr' ? 'rgba(63,63,70,0.5)' : `${color}22`,
                        color: chip.tone === 'attr' ? '#d4d4d8' : color,
                      }}
                    >
                      {chip.text}
                    </span>
                  ));
                })()}
              </div>

              <div className="mt-auto flex items-center justify-between pt-3">
                <span className="font-mono text-sm text-amber-300">⛁ {item.price}</span>
                {item.sold ? (
                  <span className="rounded bg-zinc-800 px-3 py-1 text-xs text-zinc-500">已售出</span>
                ) : (
                  <button
                    onClick={() => onBuy(item)}
                    disabled={!affordable}
                    className="rounded bg-stone-600 px-3 py-1 text-xs font-medium text-white transition hover:bg-stone-500 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {state.coins < item.price ? '币不足' : '购买'}
                  </button>
                )}
              </div>
            </Card>
          );
        })}
      </div>

      {toast && <div className="mt-3 text-xs text-emerald-300">{toast}</div>}
    </Section>
  );
};

// ===== 15. 英雄榜 =====
const LEADERBOARD_MEDAL = ['🥇', '🥈', '🥉'];

export const ViewLeaderboard: React.FC<ViewProps> = ({ state }) => {
  // 战团上限 10 人，前 30 名为兜底；按战力降序
  const sorted = [...state.survivors].sort((a, b) => b.power - a.power).slice(0, 30);
  return (
    <Section title="🏆 英雄榜" subtitle={`战团悍将按战力排序（共 ${state.survivors.length} 人，展示前 30）`}>
      <Card className="!p-0 overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-zinc-400">
              <th className="py-2 pl-3">排名</th>
              <th>姓名</th>
              <th>段位</th>
              <th className="text-right">战力</th>
              <th className="pr-3">词条</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((s, i) => {
              return (
                <tr key={s.id} className="border-t border-zinc-800/70 transition-colors hover:bg-zinc-800/30">
                  <td className="py-2 pl-3 font-mono text-zinc-400">
                    {i < 3 ? <span className="text-lg">{LEADERBOARD_MEDAL[i]}</span> : i + 1}
                  </td>
                  <td className="font-semibold text-zinc-100">{s.name}</td>
                  <td><TierBadge tier={s.tier} name={s.tierName} size="sm" /></td>
                  <td className="text-right font-mono font-semibold text-amber-300">{s.power}</td>
                  <td className="pr-3 text-xs text-zinc-400">{s.traits.length} 条</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Card>
    </Section>
  );
};

// ===== 16. 末世赌局（v1.1.9：本地 1v1 押注对决） =====
const WAGER_BET = 500;
const EMPTY_TIMELINE: import('@shared/engine/battle-v5/v3/types').BattleStateTimelineV3 = {
  frames: [],
  unitIds: [],
  unitNames: {},
};

function generateWagerFighters(rng: RNG): { a: SurvivorProfile; b: SurvivorProfile } {
  // 随机选 1~4 段，让两名选手同段生成，战力天然相近
  const tier = Math.floor(rng() * 4) + 1;
  const a = generateSurvivor(rng, { genTier: tier });
  let b = generateSurvivor(rng, { genTier: tier });
  // 若战力差过大，最多重抽 20 次
  for (let i = 0; i < 20 && Math.abs(a.power - b.power) > 12; i++) {
    b = generateSurvivor(rng, { genTier: tier });
  }
  return { a, b };
}

const WAGER_ATTRS: { key: keyof Attributes; label: string }[] = [
  { key: 'vitality', label: '体质' },
  { key: 'strength', label: '力量' },
  { key: 'spirit', label: '感知' },
  { key: 'endurance', label: '耐力' },
  { key: 'speed', label: '敏捷' },
  { key: 'willpower', label: '意志' },
];

function WagerHpBar({ current, max }: { current: number; max: number }) {
  const pct = Math.max(0, Math.min(100, max > 0 ? (current / max) * 100 : 0));
  const color = pct > 50 ? 'bg-emerald-500' : pct > 20 ? 'bg-amber-500' : 'bg-rose-500';
  return (
    <div className="h-3 w-full overflow-hidden rounded bg-zinc-800">
      <div className={`h-full ${color} transition-all duration-300`} style={{ width: `${pct}%` }} />
    </div>
  );
}

function WagerFighterPanel({
  fighter,
  betSide,
  onBet,
  disabled,
  highlight,
}: {
  fighter: SurvivorProfile;
  betSide: 'a' | 'b';
  onBet: (side: 'a' | 'b') => void;
  disabled: boolean;
  highlight?: boolean;
}) {
  const status = freshStatus(fighter, Date.now());
  const maxHp = status.maxHp;
  return (
    <Card className={`flex-1 !p-3 ${highlight ? 'ring-2 ring-emerald-500/60' : ''}`}>
      <div className="mb-2 flex items-center justify-between">
        <div>
          <div className="text-sm font-semibold text-zinc-100">{fighter.name}</div>
          <div className="text-[11px]" style={{ color: tierColor(fighter.tier) }}>
            {fighter.tierName} · 战力 {fighter.power}
          </div>
        </div>
        <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-300">满血</span>
      </div>
      <div className="mb-1 flex items-center justify-between text-xs">
        <span className="text-zinc-400">生命</span>
        <span className="tabular-nums text-zinc-200">
          {maxHp} / {maxHp}
        </span>
      </div>
      <WagerHpBar current={maxHp} max={maxHp} />
      <div className="mt-3">
        <div className="mb-1 text-[11px] font-medium tracking-wide text-zinc-500">六维</div>
        <div className="grid grid-cols-3 gap-x-2 gap-y-1 text-[11px]">
          {WAGER_ATTRS.map(({ key, label }) => (
            <div key={label} className="flex items-center justify-between">
              <span className="text-zinc-500">{label}</span>
              <span className="tabular-nums text-zinc-300">
                {Math.round((fighter.attributes[key] as number) ?? 0)}
              </span>
            </div>
          ))}
        </div>
      </div>
      <div className="mt-3">
        <div className="mb-1 text-[11px] font-medium tracking-wide text-zinc-500">天赋</div>
        <div className="flex flex-wrap gap-1">
          {fighter.traits.length === 0 ? (
            <span className="text-[10px] text-zinc-500">无</span>
          ) : (
            fighter.traits.map((t, i) => (
              <span
                key={`${t.id}-${i}`}
                className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-300"
                title={t.description}
              >
                {t.name}
              </span>
            ))
          )}
        </div>
      </div>
      <button
        onClick={() => onBet(betSide)}
        disabled={disabled}
        className="mt-3 w-full rounded bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-40"
      >
        押 {fighter.name} 胜（-{WAGER_BET}）
      </button>
    </Card>
  );
}

export const ViewWager: React.FC<ViewProps> = ({ state, mutate, rng }) => {
  const initialWager = state.wager;
  const [fighters, setFighters] = useState<{ a: SurvivorProfile; b: SurvivorProfile } | null>(
    initialWager?.fighters ?? null,
  );
  const [bet, setBet] = useState<WagerBetSide | null>(initialWager?.bet ?? null);
  const [duel, setDuel] = useState<ArenaDuelHandle | null>(null);
  const duelRef = useRef<ArenaDuelHandle | null>(null);
  const [started, setStarted] = useState<boolean>(initialWager?.started ?? false);
  const [round, setRound] = useState(initialWager?.round ?? 0);
  const [snaps, setSnaps] = useState<{ a: UnitStateSnapshot | null; b: UnitStateSnapshot | null }>(
    initialWager?.snaps ?? { a: null, b: null },
  );
  const [log, setLog] = useState<WagerLogLine[]>(initialWager?.log ?? []);
  const [ended, setEnded] = useState<boolean>(initialWager?.ended ?? false);
  const [winnerId, setWinnerId] = useState<string | null>(initialWager?.winnerId ?? null);
  const [settled, setSettled] = useState<boolean>(initialWager?.settled ?? false);
  const [resultMsg, setResultMsg] = useState<string | null>(initialWager?.resultMsg ?? null);
  const logEndRef = useRef<HTMLDivElement | null>(null);

  const canAfford = state.coins >= WAGER_BET;

  const generateNewPair = useCallback(() => {
    const pair = generateWagerFighters(rng);
    setFighters(pair);
    setBet(null);
    setDuel(null);
    duelRef.current = null;
    setStarted(false);
    setRound(0);
    setSnaps({ a: null, b: null });
    setLog([]);
    setEnded(false);
    setWinnerId(null);
    setSettled(false);
    setResultMsg(null);
    mutate((s) => {
      const ws: WagerState = {
        version: 1,
        fighters: pair,
        bet: null,
        started: false,
        battleId: '',
        playerId: pair.a.id,
        opponentId: pair.b.id,
        save: null,
        initialTimeline: EMPTY_TIMELINE,
        round: 0,
        ended: false,
        winnerId: null,
        settled: false,
        resultMsg: null,
        log: [],
        snaps: { a: null, b: null },
      };
      return { ...s, wager: ws };
    });
  }, [rng, mutate]);

  // 首次挂载：从存档恢复赌局（含未完成的 mid-duel），否则生成新一组
  useEffect(() => {
    if (initialWager?.started && initialWager.save) {
      const session = restoreArenaDuelSession(
        initialWager.save,
        initialWager.playerId,
        initialWager.opponentId,
        initialWager.initialTimeline,
      );
      if (session) {
        const handle = { session, idA: initialWager.fighters.a.id, idB: initialWager.fighters.b.id };
        duelRef.current = handle;
        setDuel(handle);
      }
    } else if (!initialWager) {
      generateNewPair();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [log]);

  const placeBet = (side: WagerBetSide) => {
    if (!fighters || !canAfford || started) return;
    setBet(side);
    mutate((s) => {
      const base = s.wager;
      const ws: WagerState = {
        version: 1,
        fighters,
        bet: side,
        started: base?.started ?? false,
        battleId: base?.battleId ?? '',
        playerId: fighters.a.id,
        opponentId: fighters.b.id,
        save: base?.save ?? null,
        initialTimeline: base?.initialTimeline ?? EMPTY_TIMELINE,
        round: base?.round ?? 0,
        ended: base?.ended ?? false,
        winnerId: base?.winnerId ?? null,
        settled: base?.settled ?? false,
        resultMsg: base?.resultMsg ?? null,
        log: base?.log ?? [],
        snaps: base?.snaps ?? { a: null, b: null },
      };
      return {
        ...s,
        coins: s.coins - WAGER_BET,
        wager: ws,
        log: [
          `【赌局】押注 ${side === 'a' ? fighters.a.name : fighters.b.name}，投入 ${WAGER_BET} 废土币。`,
          ...s.log,
        ].slice(0, 50),
      };
    });
  };

  const startDuel = () => {
    if (!fighters || !bet) return;
    const syntheticState: SurvivalGameState = {
      ...state,
      survivors: [fighters.a, fighters.b],
      survivorStatus: {
        [fighters.a.id]: freshStatus(fighters.a, Date.now()),
        [fighters.b.id]: freshStatus(fighters.b, Date.now()),
      },
      equipped: {},
    };
    const handle = prepareArenaDuel(syntheticState, fighters.a.id, fighters.b.id);
    if (!handle) return;
    duelRef.current = handle;
    setDuel(handle);
    setStarted(true);
    setRound(0);
    setEnded(false);
    setWinnerId(null);
    const frame = handle.session.initialTimeline.frames[handle.session.initialTimeline.frames.length - 1];
    const nextSnaps = {
      a: frame?.units[handle.session.playerId] ?? null,
      b: frame?.units[handle.session.opponentId] ?? null,
    };
    setSnaps(nextSnaps);
    const nextLog: WagerLogLine[] = [
      { round: 0, text: `⚔ 末世赌局开始：${fighters.a.name} vs ${fighters.b.name}`, tone: 'header' },
    ];
    setLog(nextLog);
    mutate((s) => ({
      ...s,
      wager: {
        version: 1,
        fighters,
        bet,
        started: true,
        battleId: handle.session.battleId,
        playerId: handle.session.playerId,
        opponentId: handle.session.opponentId,
        save: handle.session.save,
        initialTimeline: handle.session.initialTimeline,
        round: 0,
        ended: false,
        winnerId: null,
        settled: false,
        resultMsg: null,
        log: nextLog,
        snaps: nextSnaps,
      },
    }));
  };

  const nextRound = () => {
    const handle = duelRef.current;
    if (!handle || ended) return;
    const res = arenaStep(handle.session);
    handle.session.save = res.save;
    const r = res.round;
    setRound(r);
    const frame = res.stateTimeline.frames[res.stateTimeline.frames.length - 1];
    const pa = frame?.units[handle.session.playerId] ?? null;
    const pb = frame?.units[handle.session.opponentId] ?? null;
    setSnaps({ a: pa, b: pb });
    if (!fighters) return;
    const lines = arenaLogFromSequences(res.sequences).map((l) => ({ round: r, ...l }));
    const nextLog: WagerLogLine[] = [...log, { round: r, text: `—— 第 ${r} 回合 ——`, tone: 'neutral' }, ...lines];
    setLog(nextLog);
    let nextEnded: boolean = ended;
    let nextWinnerId = winnerId;
    if (res.outcome.battleEnded) {
      nextEnded = true;
      nextWinnerId = pa?.alive ? handle.session.playerId : pb?.alive ? handle.session.opponentId : null;
      setEnded(true);
      setWinnerId(nextWinnerId);
    }
    mutate((s) => ({
      ...s,
      wager: {
        version: 1,
        fighters,
        bet,
        started: true,
        battleId: handle.session.battleId,
        playerId: handle.session.playerId,
        opponentId: handle.session.opponentId,
        save: handle.session.save,
        initialTimeline: handle.session.initialTimeline,
        round: r,
        ended: nextEnded,
        winnerId: nextWinnerId,
        settled: false,
        resultMsg: null,
        log: nextLog,
        snaps: { a: pa, b: pb },
      },
    }));
  };

  useEffect(() => {
    if (!ended || !winnerId || settled || !fighters) return;
    const won = winnerId === (bet === 'a' ? fighters.a.id : fighters.b.id);
    setSettled(true);
    const msg = won
      ? `🎉 押中胜者！赢得 ${WAGER_BET * 2} 废土币（净赚 ${WAGER_BET}）。`
      : `💸 押注落空，损失 ${WAGER_BET} 废土币。`;
    setResultMsg(msg);
    mutate((s) => ({
      ...s,
      coins: s.coins + (won ? WAGER_BET * 2 : 0),
      wager: s.wager
        ? {
            ...s.wager,
            settled: true,
            resultMsg: msg,
          }
        : undefined,
      log: [
        `【赌局】${won ? '押中胜者，赢得' : '押注落空，损失'} ${won ? WAGER_BET * 2 : WAGER_BET} 废土币。`,
        ...s.log,
      ].slice(0, 50),
    }));
  }, [ended, winnerId, settled, bet, fighters, mutate]);

  if (!fighters) {
    return (
      <Section title="末世赌局" subtitle="以废土币押注两位临时幸存者的 1v1 对决结果">
        <Card>
          <div className="text-sm text-zinc-300">正在生成对战选手…</div>
        </Card>
      </Section>
    );
  }

  return (
    <Section title="末世赌局" subtitle="以废土币押注两位临时幸存者的 1v1 对决结果">
      <Card>
        <p className="mb-2 text-xs text-zinc-400">
          系统会随机生成两名<strong className="text-zinc-200">战力相近</strong>的临时幸存者，双方均无装备、以满血开局。
          你可以先查看面板与天赋，再押注其中一方。下注<strong className="text-zinc-200"> {WAGER_BET} 废土币</strong>，
          猜中胜者即返还 <strong className="text-zinc-200">{WAGER_BET * 2}</strong>（净赚 {WAGER_BET}），猜错则本金归庄家。
        </p>
        <p className="text-xs text-zinc-500">对决为本地模拟，不改变战团成员与装备。</p>
      </Card>

      {!started && (
        <>
          <div className="flex gap-3">
            <WagerFighterPanel
              fighter={fighters.a}
              betSide="a"
              onBet={placeBet}
              disabled={!canAfford || started}
              highlight={bet === 'a'}
            />
            <WagerFighterPanel
              fighter={fighters.b}
              betSide="b"
              onBet={placeBet}
              disabled={!canAfford || started}
              highlight={bet === 'b'}
            />
          </div>
          {bet && (
            <div className="rounded border border-emerald-900/60 bg-emerald-950/20 px-3 py-2 text-center text-sm text-emerald-200">
              已押注 {bet === 'a' ? fighters.a.name : fighters.b.name} · 投入 {WAGER_BET} 废土币
            </div>
          )}
          <div className="flex gap-3">
            <button
              onClick={startDuel}
              disabled={!bet || !canAfford}
              className="flex-1 rounded bg-rose-700 px-4 py-2 text-sm font-semibold text-white hover:bg-rose-600 disabled:cursor-not-allowed disabled:opacity-40"
            >
              开始切磋
            </button>
            <button
              onClick={generateNewPair}
              disabled={!!bet || started}
              className="rounded bg-zinc-700 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-600 disabled:cursor-not-allowed disabled:opacity-40"
            >
              换一组
            </button>
          </div>
        </>
      )}

      {started && (
        <>
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-zinc-200">
              第 {round} 回合{ended ? '（已结束）' : ''}
            </h3>
            {ended && winnerId && (
              <Pill tone="green">
                🏆 {winnerId === fighters.a.id ? fighters.a.name : fighters.b.name} 获胜
              </Pill>
            )}
          </div>

          <div className="flex gap-3">
            <CombatantCard
              snap={snaps.a}
              name={fighters.a.name}
              highlight={ended && winnerId === fighters.a.id}
            />
            <CombatantCard
              snap={snaps.b}
              name={fighters.b.name}
              highlight={ended && winnerId === fighters.b.id}
            />
          </div>

          <div className="flex gap-3">
            <button
              onClick={nextRound}
              disabled={ended}
              className="flex-1 rounded bg-rose-700 px-4 py-2 text-sm font-semibold text-white hover:bg-rose-600 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {ended ? '对决已结束' : '⚔ 下一回合'}
            </button>
            {ended && (
              <button
                onClick={generateNewPair}
                className="rounded bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700"
              >
                再来一局
              </button>
            )}
          </div>

          {resultMsg && (
            <div
              className={`rounded px-3 py-2 text-center text-sm ${
                resultMsg.includes('🎉')
                  ? 'bg-emerald-950/30 text-emerald-300'
                  : 'bg-rose-950/30 text-rose-300'
              }`}
            >
              {resultMsg}
            </div>
          )}

          <Card className="!p-0">
            <div className="max-h-64 overflow-y-auto p-3 text-xs leading-relaxed">
              {log.map((l, i) => {
                const cls =
                  l.tone === 'header'
                    ? 'font-semibold text-emerald-300'
                    : l.tone === 'damage'
                      ? 'text-rose-300'
                      : l.tone === 'dodge'
                        ? 'text-sky-300'
                        : l.tone === 'death'
                          ? 'font-semibold text-rose-400'
                          : l.tone === 'heal'
                            ? 'text-emerald-400'
                            : 'text-zinc-400';
                return (
                  <div key={i} className={cls}>
                    {l.text}
                  </div>
                );
              })}
              <div ref={logEndRef} />
            </div>
          </Card>
        </>
      )}
    </Section>
  );
};

// ===== 17. 擂台切磋（本地 1v1 模拟对决） =====

/** 从本回合交战序列中抽取可读的战斗日志行。 */
function arenaLogFromSequences(seqs: CombatSequenceV3[]): { text: string; tone: WagerLogLine['tone'] }[] {
  const out: { text: string; tone: WagerLogLine['tone'] }[] = [];
  for (const seq of seqs) {
    for (const fact of seq.facts) {
      const atkName =
        seq.actor?.name ?? (fact.origin.kind === 'owned' ? fact.origin.owner.name : '系统');
      if (fact.type === 'damage') {
        out.push({
          text: `${atkName} 对 ${fact.target.name} 造成 ${fact.amount} 点伤害${fact.critical ? '（暴击！）' : ''}`,
          tone: 'damage',
        });
      } else if (fact.type === 'defense' && fact.defense === 'dodge') {
        out.push({ text: `${fact.target.name} 灵巧地闪避了 ${atkName} 的攻击`, tone: 'dodge' });
      } else if (fact.type === 'unit_died') {
        out.push({ text: `${fact.target.name} 倒下了！`, tone: 'death' });
      } else if (fact.type === 'recovery') {
        out.push({ text: `${fact.target.name} 恢复了 ${fact.amount} 点生命`, tone: 'heal' });
      }
    }
  }
  return out;
}

function HpBar({ hp }: { hp: { current: number; max: number; percent: number } }) {
  const pct = Math.max(0, Math.min(100, hp.percent));
  const color = pct > 50 ? 'bg-emerald-500' : pct > 20 ? 'bg-amber-500' : 'bg-rose-500';
  return (
    <div className="h-3 w-full overflow-hidden rounded bg-zinc-800">
      <div className={`h-full ${color} transition-all duration-300`} style={{ width: `${pct}%` }} />
    </div>
  );
}

const SIX_ATTRS: { key: keyof UnitStateSnapshot['attrs']; label: string }[] = [
  { key: 'vitality', label: '体质' },
  { key: 'strength', label: '力量' },
  { key: 'spirit', label: '精神' },
  { key: 'endurance', label: '耐力' },
  { key: 'speed', label: '敏捷' },
  { key: 'willpower', label: '意志' },
];

function CombatantCard({
  snap,
  name,
  highlight,
}: {
  snap: UnitStateSnapshot | null;
  name: string;
  highlight?: boolean;
}) {
  if (!snap) {
    return (
      <Card className="flex-1 !p-3">
        <div className="text-sm text-zinc-500">等待选将…</div>
      </Card>
    );
  }
  const a = snap.attrs;
  const pct = (v: number | undefined) => (typeof v === 'number' ? `${Math.round(v * 100)}%` : '—');
  return (
    <Card className={`flex-1 !p-3 ${highlight ? 'ring-2 ring-emerald-500/60' : ''}`}>
      <div className="mb-1 flex items-center justify-between">
        <span className="truncate text-sm font-semibold text-zinc-100">{name}</span>
        <span className="text-[11px] text-zinc-400">{snap.alive ? '存活' : '倒地'}</span>
      </div>
      <div className="mb-1 flex items-baseline justify-between text-xs">
        <span className="flex items-center gap-1.5 text-zinc-400">
          生命
          {snap.hp.current >= snap.hp.max && (
            <span className="rounded bg-emerald-900/60 px-1 text-[10px] leading-tight text-emerald-300">
              满血
            </span>
          )}
        </span>
        <span className="tabular-nums text-zinc-200">
          {Math.max(0, Math.round(snap.hp.current))} / {Math.round(snap.hp.max)}
        </span>
      </div>
      <HpBar hp={snap.hp} />
      <div className="mt-3">
        <div className="mb-1 text-[11px] font-medium tracking-wide text-zinc-500">六维</div>
        <div className="grid grid-cols-3 gap-x-2 gap-y-1 text-[11px]">
          {SIX_ATTRS.map(({ key, label }) => (
            <div key={label} className="flex items-center justify-between">
              <span className="text-zinc-500">{label}</span>
              <span className="tabular-nums text-zinc-300">{Math.round((a[key] as number) ?? 0)}</span>
            </div>
          ))}
        </div>
        <div className="mb-1 mt-3 text-[11px] font-medium tracking-wide text-zinc-500">战斗属性</div>
        <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
          <div className="flex items-center justify-between">
            <span className="text-zinc-500">攻击</span>
            <span className="tabular-nums text-rose-300">{Math.round(a.atk)}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-zinc-500">防御</span>
            <span className="tabular-nums text-sky-300">{Math.round(a.def)}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-zinc-500">暴击</span>
            <span className="tabular-nums text-amber-300">{pct(a.critRate)}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-zinc-500">闪避</span>
            <span className="tabular-nums text-emerald-300">{pct(a.evasionRate)}</span>
          </div>
        </div>
      </div>
    </Card>
  );
}

export const ViewArena: React.FC<ViewProps> = ({ state }) => {
  const survivors = state.survivors;
  const [selA, setSelA] = useState<string>(survivors[0]?.id ?? '');
  const [selB, setSelB] = useState<string>(survivors[1]?.id ?? survivors[0]?.id ?? '');
  const [duel, setDuel] = useState<ArenaDuelHandle | null>(null);
  const duelRef = useRef<ArenaDuelHandle | null>(null);
  const [round, setRound] = useState(0);
  const [snaps, setSnaps] = useState<{ a: UnitStateSnapshot | null; b: UnitStateSnapshot | null }>({
    a: null,
    b: null,
  });
  const [log, setLog] = useState<WagerLogLine[]>([]);
  const [ended, setEnded] = useState(false);
  const [winnerId, setWinnerId] = useState<string | null>(null);
  const logEndRef = useRef<HTMLDivElement | null>(null);

  const nameOf = (id: string) => state.survivors.find((s) => s.id === id)?.name ?? '—';
  const ids = duel ? { a: duel.session.playerId, b: duel.session.opponentId } : { a: selA, b: selB };

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [log]);

  const startDuel = () => {
    if (!selA || !selB || selA === selB) return;
    const handle = prepareArenaDuel(state, selA, selB);
    if (!handle) return;
    duelRef.current = handle;
    setDuel(handle);
    setRound(0);
    setEnded(false);
    setWinnerId(null);
    const frame = handle.session.initialTimeline.frames[handle.session.initialTimeline.frames.length - 1];
    setSnaps({
      a: frame?.units[handle.session.playerId] ?? null,
      b: frame?.units[handle.session.opponentId] ?? null,
    });
    setLog([{ round: 0, text: `⚔ 擂台切磋开始：${nameOf(selA)} vs ${nameOf(selB)}`, tone: 'header' }]);
  };

  const nextRound = () => {
    const handle = duelRef.current;
    if (!handle || ended) return;
    const res = arenaStep(handle.session);
    handle.session.save = res.save;
    const r = res.round;
    setRound(r);
    const frame = res.stateTimeline.frames[res.stateTimeline.frames.length - 1];
    const pa = frame?.units[handle.session.playerId] ?? null;
    const pb = frame?.units[handle.session.opponentId] ?? null;
    setSnaps({ a: pa, b: pb });
    const lines = arenaLogFromSequences(res.sequences).map((l) => ({ round: r, ...l }));
    setLog((prev) => [
      ...prev,
      { round: r, text: `—— 第 ${r} 回合 ——`, tone: 'neutral' },
      ...lines,
    ]);
    if (res.outcome.battleEnded) {
      setEnded(true);
      const win = pa?.alive ? handle.session.playerId : pb?.alive ? handle.session.opponentId : null;
      setWinnerId(win);
      setLog((prev) => [
        ...prev,
        {
          round: r,
          text: `🏆 ${win ? nameOf(win === handle.session.playerId ? selA : selB) : '胜者'} 获胜，对决结束！`,
          tone: 'header',
        },
      ]);
    }
  };

  const resetDuel = () => {
    duelRef.current = null;
    setDuel(null);
    setEnded(false);
    setWinnerId(null);
    setSnaps({ a: null, b: null });
    setLog([]);
    setRound(0);
  };

  if (survivors.length < 2) {
    return (
      <Section title="擂台切磋" subtitle="本地 1v1 模拟对决">
        <Card>
          <div className="text-sm text-zinc-300">
            战团至少需要 2 名成员才能切磋。请先通过出击救援或花名册招募扩充战团。
          </div>
        </Card>
      </Section>
    );
  }

  const pickA = survivors.find((s) => s.id === selA);
  const pickB = survivors.find((s) => s.id === selB);

  return (
    <Section title="擂台切磋" subtitle="选择两位战团成员进行 1v1 模拟对决（本地，不联网）">
      <Card>
          <p className="mb-3 text-xs text-zinc-400">
            切磋为本地模拟，<strong className="text-zinc-200">双方以满血开局</strong>、仅按<strong className="text-zinc-200">角色六维 + 装备属性</strong>对决（不含基地/避难所/势力的各类属性 buff），<strong className="text-zinc-200">不改变成员真实状态</strong>；对决结束即自动恢复如初。
          </p>

        {/* 选将 */}
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-xs text-zinc-400">
            选手 A
            <select
              value={selA}
              disabled={!!duel}
              onChange={(e) => setSelA(e.target.value)}
              className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm text-zinc-100"
            >
              {survivors.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}（{s.tierName} · 战力 {s.power}）
                </option>
              ))}
            </select>
          </label>
          <span className="pb-1 text-lg font-bold text-zinc-600">VS</span>
          <label className="flex flex-col gap-1 text-xs text-zinc-400">
            选手 B
            <select
              value={selB}
              disabled={!!duel}
              onChange={(e) => setSelB(e.target.value)}
              className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm text-zinc-100"
            >
              {survivors.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}（{s.tierName} · 战力 {s.power}）
                </option>
              ))}
            </select>
          </label>
          {!duel ? (
            <button
              onClick={startDuel}
              disabled={!selA || !selB || selA === selB}
              className="rounded bg-emerald-700 px-4 py-1.5 text-sm font-medium text-white hover:bg-emerald-600 disabled:cursor-not-allowed disabled:opacity-40"
            >
              开始切磋
            </button>
          ) : (
            <button
              onClick={resetDuel}
              className="rounded bg-zinc-700 px-4 py-1.5 text-sm font-medium text-white hover:bg-zinc-600"
            >
              退出切磋
            </button>
          )}
        </div>
        {!duel && selA === selB && (
          <div className="mt-2 text-xs text-rose-300">两位选手不能是同一名成员。</div>
        )}
      </Card>

      {/* 对决进行中 */}
      {duel && (
        <>
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-zinc-200">
              第 {round} 回合{ended ? '（已结束）' : ''}
            </h3>
            {ended && winnerId && (
              <Pill tone="green">
                🏆 {nameOf(winnerId === duel.session.playerId ? selA : selB)} 获胜
              </Pill>
            )}
          </div>

          <div className="flex gap-3">
            <CombatantCard snap={snaps.a} name={nameOf(selA)} highlight={winnerId === duel.session.playerId} />
            <CombatantCard snap={snaps.b} name={nameOf(selB)} highlight={winnerId === duel.session.opponentId} />
          </div>

          <div className="flex gap-3">
            <button
              onClick={nextRound}
              disabled={ended}
              className="flex-1 rounded bg-rose-700 px-4 py-2 text-sm font-semibold text-white hover:bg-rose-600 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {ended ? '对决已结束' : '⚔ 下一回合'}
            </button>
          </div>

          {/* 交战日志 */}
          <Card className="!p-0">
            <div className="max-h-64 overflow-y-auto p-3 text-xs leading-relaxed">
              {log.map((l, i) => {
                const cls =
                  l.tone === 'header'
                    ? 'text-emerald-300 font-semibold'
                    : l.tone === 'damage'
                      ? 'text-rose-300'
                      : l.tone === 'dodge'
                        ? 'text-sky-300'
                        : l.tone === 'death'
                          ? 'text-rose-400 font-semibold'
                          : l.tone === 'heal'
                            ? 'text-emerald-400'
                            : 'text-zinc-400';
                return (
                  <div key={i} className={cls}>
                    {l.text}
                  </div>
                );
              })}
              <div ref={logEndRef} />
            </div>
          </Card>
        </>
      )}

      {!duel && (
        <Card>
          <div className="text-sm text-zinc-300">
            当前候选：
            <span className="text-zinc-100">{pickA?.name ?? '—'}</span>
            <span className="mx-2 text-zinc-600">vs</span>
            <span className="text-zinc-100">{pickB?.name ?? '—'}</span>
          </div>
          <p className="mt-2 text-xs text-zinc-500">
            每点击一次「下一回合」即推进一回合交手，实时显示双方血量、属性与交手日志；一方生命归零即判负，对决结束。
          </p>
        </Card>
      )}
    </Section>
  );
};

// ===== 18. 世界传闻 =====
export const ViewNews: React.FC<ViewProps> = ({ state }) => {
  // 由战役历史 + 当前状态派生
  const messages: { tone: 'green' | 'red' | 'amber' | 'sky' | 'stone'; text: string }[] = [];
  const today = state.sortieHistory.filter((s) => s.at.slice(0, 10) === new Date().toISOString().slice(0, 10));
  if (today.length > 0) messages.push({ tone: 'sky', text: `今日共记录 ${today.length} 次出击，最近一次由 ${today[0].survivorName} 在【${today[0].zoneName}】执行。` });
  if (state.recruits.length > 0) messages.push({ tone: 'amber', text: `幸存者花名册里还有 ${state.recruits.length} 名待招募幸存者，用废土币招募后可入战团。` });
  if (state.survivors.some((s) => (state.survivorStatus[s.id]?.injuries.length ?? 0) > 0)) {
    messages.push({ tone: 'red', text: '部分队员带伤，请关注「医疗」面板。' });
  }
  const completed = state.sortieHistory.length;
  if (completed >= 5) messages.push({ tone: 'stone', text: `累计出击 ${completed} 次，已算是一名老练的拾荒人。` });
  if (state.coins >= 1000) messages.push({ tone: 'green', text: '废土币储备充裕，可以考虑升级避难所设施。' });
  if (messages.length === 0) messages.push({ tone: 'stone', text: '一切平静——末世最稀缺的奢侈品。' });
  return (
    <Section title="世界传闻" subtitle="系统从最近出击/避难所状态聚合而成的情报摘要。">
      <div className="space-y-2">
        {messages.map((m, i) => (
          <Card key={i} className="!p-3">
            <div className="flex items-start gap-2">
              <Pill tone={m.tone}>{m.tone === 'green' ? '利好' : m.tone === 'red' ? '警报' : m.tone === 'amber' ? '提醒' : m.tone === 'sky' ? '情报' : '日常'}</Pill>
              <div className="text-sm text-zinc-200">{m.text}</div>
            </div>
          </Card>
        ))}
      </div>
    </Section>
  );
};

// ===== 19. 兑换码 =====
export const ViewRedeem: React.FC<ViewProps> = ({ state, mutate, rng }) => {
  const [code, setCode] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [pendingTicket, setPendingTicket] = useState<string | null>(null);

  type RedeemReward = { coins?: number; med?: 'bandage' | 'antibiotic' | 'medkit'; qty?: number; ticket?: string; ticketQty?: number };
  const valid: Record<string, RedeemReward> = {
    'WASTELAND2026': { coins: 200, med: 'bandage', qty: 3 },
    'FIRSTSTEP': { coins: 100 },
    'LASTHOPE': { coins: 500, med: 'medkit', qty: 1 },
    'CESHI1': { ticket: 'backbone-recruit', ticketQty: 1 },
  };

  const apply = () => {
    if (!valid[code]) {
      setMsg('兑换码无效');
      return;
    }
    const used = state.redeemedCodes ?? [];
    if (used.includes(code)) {
      setMsg('该兑换码已使用');
      return;
    }
    const r = valid[code];
    mutate((s) => {
      const codes = s.redeemedCodes ?? [];
      if (codes.includes(code)) return s;
      const ns: SurvivalGameState = { ...s, coins: s.coins + (r.coins ?? 0), redeemedCodes: [...codes, code] };
      if (r.med) ns.medicines = { ...ns.medicines, [r.med]: (ns.medicines[r.med] ?? 0) + (r.qty ?? 1) };
      if (r.ticket) {
        ns.redeemTickets = { ...(ns.redeemTickets ?? {}), [r.ticket]: ((ns.redeemTickets ?? {})[r.ticket] ?? 0) + (r.ticketQty ?? 1) };
      }
      return ns;
    });
    const parts: string[] = [];
    if (r.coins) parts.push(`+${r.coins} 废土币`);
    if (r.med) parts.push(`+${r.qty ?? 1}×${r.med}`);
    if (r.ticket) parts.push('+战团骨干招募券×1');
    setMsg(`兑换成功：${parts.join('、')}`);
  };

  const tickets = Object.entries(state.redeemTickets ?? {}).filter(([_, qty]) => qty > 0);

  const useTicket = (ticketId: string) => {
    if (ticketId !== 'backbone-recruit') return;
    const res = useBackboneRecruitTicket(state, rng, Date.now());
    if (res.full) {
      setMsg('⚠️ 战团已满，招募需先遣散。');
      setPendingTicket(null);
      return;
    }
    if (!res.npc) {
      setMsg('没有可使用的战团骨干招募券。');
      return;
    }
    mutate(() => res.state);
    setMsg(
      `✅ 战团骨干招募券使用成功：${res.npc.name}（${res.npc.tierName}）已加入战团。`,
    );
    setPendingTicket(null);
  };

  return (
    <Section title="兑换码" subtitle="输入官方兑换码获得物资。">
      <Card>
        <div className="flex items-center gap-2">
          <input
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder="输入兑换码"
            className="flex-1 rounded border border-zinc-700 px-3 py-2 text-sm"
          />
          <button onClick={apply} className="rounded bg-emerald-600 px-4 py-2 text-sm text-white hover:bg-emerald-700">兑换</button>
        </div>
        {msg && <div className="mt-2 text-xs text-zinc-300">{msg}</div>}
      </Card>

      {tickets.length > 0 && (
        <Card className="mt-3">
          <div className="font-semibold text-zinc-100">已兑换道具</div>
          <div className="mt-2 flex flex-wrap gap-2">
            {tickets.map(([id, qty]) => (
              <div key={id} className="flex items-center gap-2 rounded border border-zinc-800 bg-zinc-900 px-2 py-1">
                <span className="text-xs text-zinc-300">战团骨干招募券 ×{qty}</span>
                {pendingTicket === id ? (
                  <div className="flex gap-1">
                    <button
                      onClick={() => useTicket(id)}
                      className="rounded bg-emerald-600 px-2 py-0.5 text-[11px] text-white hover:bg-emerald-700"
                    >
                      确认使用
                    </button>
                    <button
                      onClick={() => setPendingTicket(null)}
                      className="rounded bg-zinc-700 px-2 py-0.5 text-[11px] text-white hover:bg-zinc-600"
                    >
                      取消
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => setPendingTicket(id)}
                    className="rounded bg-amber-600 px-2 py-0.5 text-[11px] text-white hover:bg-amber-700"
                  >
                    使用
                  </button>
                )}
              </div>
            ))}
          </div>
        </Card>
      )}
    </Section>
  );
};

// ===== 20. 救济簿（捐赠/善举记录） =====
export const ViewMerit: React.FC<ViewProps> = ({ state }) => {
  const merit = state.sortieHistory.filter((s) => s.rescued).length;
  const deaths = state.sortieHistory.filter((s) => s.outcome === 'death').length;
  const totalRecruits = state.totalRecruits ?? Math.max(1, state.survivors.length);
  return (
    <Section title="救济簿" subtitle="系统自动统计你的善举与代价。">
      <Card>
        <div className="grid grid-cols-3 gap-3 text-center">
          <div>
            <div className="text-2xl font-bold text-emerald-300">{merit}</div>
            <div className="mt-1 text-xs text-zinc-400">累计救援</div>
          </div>
          <div>
            <div className="text-2xl font-bold text-amber-300">{totalRecruits}</div>
            <div className="mt-1 text-xs text-zinc-400">累计招募</div>
          </div>
          <div>
            <div className="text-2xl font-bold text-rose-300">{deaths}</div>
            <div className="mt-1 text-xs text-zinc-400">队员牺牲</div>
          </div>
        </div>
      </Card>
      <div className="mt-3 text-xs text-zinc-500">* 仅统计本存档。多次出击叠加。</div>
    </Section>
  );
};

// ===== 21. 幸存者社群（占位） =====
export const ViewCommunity: React.FC = () => (
  <Section title="幸存者社群" subtitle="玩家交流群">
    <Card>
      <div className="text-sm text-zinc-300">本地单人版本不展示真实社群入口。正式版会接入官方 QQ/Discord 群链接。</div>
    </Card>
  </Section>
);

// ===== 22. 意见反馈（占位） =====
export const ViewFeedback: React.FC = () => (
  <Section title="意见反馈" subtitle="把体验上的问题告诉我们">
    <Card>
      <textarea rows={4} placeholder="写下你的建议…" className="w-full rounded border border-zinc-700 p-2 text-sm" disabled />
      <div className="mt-2 text-xs text-zinc-500">（演示版本：服务端未启用，正式环境会写入反馈表）</div>
    </Card>
  </Section>
);

// ===== 23b. GM 调试面板（v1.1.0：需密钥解锁） =====
const GM_UNLOCK_FLAG = 'wasteland-gm-unlocked';

function readGmUnlocked(): boolean {
  try {
    return window.localStorage.getItem(GM_UNLOCK_FLAG) === '1';
  } catch {
    return false;
  }
}

function writeGmUnlocked(on: boolean): void {
  try {
    if (on) window.localStorage.setItem(GM_UNLOCK_FLAG, '1');
    else window.localStorage.removeItem(GM_UNLOCK_FLAG);
  } catch {
    /* 隐私模式等场景下忽略 */
  }
}

/** GM 加经验的固定额度 */
const GM_XP_AMOUNT = 200;
/** GM 加废土币的固定额度 */
const GM_COIN_AMOUNT = 1000;

const GmPanel: React.FC<{ state: SurvivalGameState; mutate: Mutate }> = ({ state, mutate }) => {
  const [unlocked, setUnlocked] = useState(() => readGmUnlocked());
  const [keyInput, setKeyInput] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const active = state.survivors.find((s) => s.id === state.activeSurvivorId);

  const tryUnlock = () => {
    if (verifyGmKey(keyInput)) {
      writeGmUnlocked(true);
      setUnlocked(true);
      setErr(null);
      setKeyInput('');
      setToast('✅ GM 功能已解锁（本机记住，可随时锁定）。');
    } else {
      setErr('密钥错误，无法使用 GM 功能。');
    }
  };

  const lock = () => {
    writeGmUnlocked(false);
    setUnlocked(false);
    setToast(null);
  };

  if (!unlocked) {
    return (
      <Card>
        <h3 className="font-semibold text-zinc-100">GM 功能（未解锁）</h3>
        <div className="mt-1 text-xs text-zinc-400">
          输入 GM 密钥以启用调试功能（仅本机有效，不影响其他存档）。
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <input
            type="password"
            value={keyInput}
            onChange={(e) => {
              setKeyInput(e.target.value);
              setErr(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') tryUnlock();
            }}
            placeholder="请输入 GM 密钥"
            className="rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm text-zinc-100 outline-none focus:border-zinc-500"
          />
          <button
            onClick={tryUnlock}
            disabled={keyInput.trim().length === 0}
            className="rounded bg-zinc-700 px-3 py-1 text-xs text-white hover:bg-zinc-600 disabled:opacity-40"
          >
            验证密钥
          </button>
        </div>
        {err && <div className="mt-2 text-xs text-rose-300">⚠ {err}</div>}
      </Card>
    );
  }

  return (
    <Card>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="font-semibold text-emerald-300">GM 功能（已解锁）</h3>
          <div className="mt-1 text-xs text-zinc-400">
            当前出击者：
            <span className="text-zinc-100">
              {active ? (
                <>
                  {active.name}（Lv.{active.level ?? 1} · <TierBadge tier={active.tier} name={active.tierName} size="sm" />）
                </>
              ) : (
                '未指定'
              )}
            </span>
          </div>
        </div>
        <button
          onClick={lock}
          className="shrink-0 rounded bg-zinc-700 px-3 py-1 text-xs text-white hover:bg-zinc-600"
        >
          锁定 GM
        </button>
      </div>

      {toast && <div className="mt-2 text-xs text-emerald-300">{toast}</div>}

      <div className="mt-3 flex flex-wrap gap-2">
        <button
          onClick={() => {
            if (!active) return;
            mutate((s) => gmGrantXp(s, active.id, GM_XP_AMOUNT));
            setToast(`✅ ${active.name} 经验 +${GM_XP_AMOUNT}（满经验会自动升级并发放属性点）。`);
          }}
          disabled={!active}
          className="rounded bg-emerald-600 px-3 py-1 text-xs text-white hover:bg-emerald-700 disabled:opacity-40"
        >
          出击者经验 +{GM_XP_AMOUNT}
        </button>
        <button
          onClick={() => {
            mutate((s) => gmGrantCoins(s, GM_COIN_AMOUNT));
            setToast(`✅ 废土币 +${GM_COIN_AMOUNT}。`);
          }}
          className="rounded bg-emerald-600 px-3 py-1 text-xs text-white hover:bg-emerald-700"
        >
          废土币 +{GM_COIN_AMOUNT}
        </button>
        <button
          onClick={() => {
            const before = state.actionPoints ?? 0;
            mutate((s) => gmGrantActionPoints(s));
            setToast(
              before >= 120
                ? `ℹ️ 行动点已是 ${before}/120，无需恢复。`
                : `✅ 行动点恢复至 ${before} → 120/120。`,
            );
          }}
          className="rounded bg-emerald-600 px-3 py-1 text-xs text-white hover:bg-emerald-700"
        >
          恢复行动点 120
        </button>
        <button
          onClick={() => {
            // GM：随机生成一名幸存者并加入待招募（按 GEN_TIERS 权重抽段位 1~5），用于验证生成逻辑
            const rng = mulberry32((Math.random() * 0xffffffff) >>> 0);
            const s = generateSurvivor(rng);
            mutate((st) => addRecruit(st, s));
            setToast(
              `✅ 生成幸存者 ${s.name}（${s.tierName} · 战力 ${s.power} · 六维 ${Object.values(s.attributes).reduce((a, b) => a + b, 0)}）。已加入花名册待招募区。`,
            );
          }}
          className="rounded bg-amber-600 px-3 py-1 text-xs text-white hover:bg-amber-700"
        >
          随机生成幸存者
        </button>
      </div>
      <div className="mt-2 text-[11px] text-zinc-500">
        经验按正常升级流程结算：满经验升级会给自由属性点、触发词条三选一，并将状态回满。
      </div>
    </Card>
  );
};

// ===== 23. 系统设置 =====
// 跨设备存档码复制：优先 Clipboard API，失败回退 execCommand；返回是否成功
async function safeCopy(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* 继续回退 */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.top = '-9999px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

/**
 * 跨设备存档同步：导出前裁剪「纯展示性历史」字段，避免存档码（微信约 1.6 万字符上限）过长。
 * log / sortieHistory / wanderLog 都是只增不减的日志/历史，删减不影响任何玩法进度，
 * 接收端随事件会重新累积。实测：重度存档（800 条 log）压缩码 ~2.7 万字符，
 * 裁剪后降到 ~1 万字符以内，远低于微信上限。
 *
 * v1.1.5 补充②：装备与待招募也会无限制累积，进一步裁剪（仅用于跨设备传输快照，
 * 本地存档 / 存档文件导出 完整保留）：
 * - 已装备 gear 全部保留（防止引用断裂）
 * - 未装备 gear 按价值保留前 50 件
 * - 待招募幸存者按战力保留前 10 人
 */
function buildTransferSnapshot(state: SurvivalGameState): SurvivalGameState {
  const equippedIds = new Set<string>();
  Object.values(state.equipped).forEach((slots) => {
    if (!slots) return;
    Object.values(slots).forEach((id) => {
      if (typeof id === 'string') equippedIds.add(id);
    });
  });

  const equippedGear = state.gear.filter((g) => equippedIds.has(g.id));
  const unequippedGear = state.gear
    .filter((g) => !equippedIds.has(g.id))
    .sort((a, b) => (b.value ?? 0) - (a.value ?? 0))
    .slice(0, 50);

  const trimmedRecruits = Array.isArray(state.recruits)
    ? [...state.recruits].sort((a, b) => (b.power ?? 0) - (a.power ?? 0)).slice(0, 10)
    : [];

  return {
    ...state,
    gear: [...equippedGear, ...unequippedGear],
    recruits: trimmedRecruits,
    log: Array.isArray(state.log) ? state.log.slice(-30) : [],
    sortieHistory: Array.isArray(state.sortieHistory) ? state.sortieHistory.slice(-20) : [],
    wanderLog: Array.isArray(state.wanderLog) ? state.wanderLog.slice(-10) : [],
  };
}

export const ViewSettings: React.FC<ViewProps> = ({ state, mutate, onResetGame }) => {
  // v1.0.10：重置存档不再沿用「玩家代号」，改为弹窗输入重生者姓名
  const [resetOpen, setResetOpen] = useState(false);
  const suggestedName = (
    (state.playerCodename as string | undefined) ||
    state.survivors.find((s) => s.isProtagonist)?.name ||
    state.survivors[0]?.name ||
    ''
  ).trim();
  // v1.1.5：跨设备存档同步（方案 A，零后端）—— 导出/导入
  const [exportCode, setExportCode] = useState('');
  const [importCode, setImportCode] = useState('');
  const [syncToast, setSyncToast] = useState<string | null>(null);
  // 导入二次确认：先校验内容，确认后再写盘（避免 window.confirm 在部分环境失效导致导入无反应）
  const [importConfirmOpen, setImportConfirmOpen] = useState(false);
  const [importPayload, setImportPayload] = useState<SurvivalGameState | null>(null);
  // 生成存档码二次确认：提醒用户存档码会裁剪部分信息，完整数据请用「下载存档文件」
  const [exportConfirmOpen, setExportConfirmOpen] = useState(false);
  // 手机/微信环境下「下载存档文件」无法触发真实下载，回退为完整文本供复制保存
  const [exportFileText, setExportFileText] = useState('');
  // 手机/微信环境：点击「下载存档文件」先弹窗选择导出方式（① .json 文件 ② 完整文本）
  const [exportFileChoiceOpen, setExportFileChoiceOpen] = useState(false);

  const parseSave = (text: string): SurvivalGameState | null => {
    const raw = (text || '').trim();
    if (!raw) return null;
    // 统一校验：解析出的对象须含 version 且 survivors 为数组
    const tryJson = (s: string): SurvivalGameState | null => {
      try {
        const data = JSON.parse(s);
        if (data && data.version && Array.isArray(data.survivors)) return data as SurvivalGameState;
      } catch {
        /* 不是合法 JSON */
      }
      return null;
    };
    // 1) 原始 JSON（存档文件 / 调试粘贴）
    const asJson = tryJson(raw);
    if (asJson) return asJson;
    // 2) lz-string 压缩存档码（v1.1.5 补充起导出默认格式，最短，适合微信）
    const lz = decompressFromBase64(raw);
    if (lz) {
      const fromLz = tryJson(lz);
      if (fromLz) return fromLz;
    }
    // 3) 旧版 base64 存档码（v1.1.5 初版 btoa 编码，向后兼容）
    if (/^[A-Za-z0-9+/=\r\n\s]+$/.test(raw) && raw.replace(/\s/g, '').length > 20) {
      try {
        const b64 = decodeURIComponent(escape(atob(raw.replace(/\s/g, ''))));
        const fromB64 = tryJson(b64);
        if (fromB64) return fromB64;
      } catch {
        /* 不是合法 base64 */
      }
    }
    return null;
  };

  // 第一步：校验存档码/文件内容，合法则弹出内联二次确认
  const openImportConfirm = (parsed: SurvivalGameState | null) => {
    if (!parsed) {
      setImportConfirmOpen(false);
      setSyncToast('❌ 存档解析失败：内容不是有效的存档。请确认已完整复制或选择了正确文件。');
      return;
    }
    setImportPayload(parsed);
    setImportConfirmOpen(true);
  };

  // 从文本框（存档码）导入
  const startImportFromText = () => openImportConfirm(parseSave(importCode));

  // 从文件（.json 存档文件）导入
  const startImportFromFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => openImportConfirm(parseSave(String(reader.result)));
    reader.onerror = () => setSyncToast('❌ 读取文件失败，请重试。');
    reader.readAsText(file);
    e.target.value = ''; // 允许重复选择同一文件
  };

  // 生成完整存档 JSON 文本（手机/微信回退方案，完整无裁剪）
  const buildFullJson = () =>
    JSON.stringify(state, null, 2);

  // 导出存档文件（真实下载）—— 完整保留所有装备与信息，不做任何裁剪
  // 桌面端直接成功；手机/微信端若被静默拦截（a.click 无报错也无文件），在 catch 里回退为完整文本
  const doDownloadFile = () => {
    const json = buildFullJson();
    const name = (getCurrentUser() || 'save').replace(/[^\w一-龥-]/g, '_');
    try {
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `wasteland-save-${name}-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      setSyncToast('✅ 存档文件已生成，请在下载目录查收（若未弹出下载，请改用「生成完整文本」方式）。');
    } catch {
      setExportFileText(json);
      setSyncToast('⚠️ 生成存档文件失败，已生成完整存档文本供复制。');
    }
  };

  // 手机/微信环境：生成完整文本供复制保存（弹窗选项②）
  const showExportFileText = () => {
    setExportFileText(buildFullJson());
    setExportFileChoiceOpen(false);
    setSyncToast(
      '⚠️ 已生成完整存档文本。请长按文本框全选复制，转发给自己保存（电脑端可粘贴回「方式一」导入）。如需标准 .json 文件，请在电脑浏览器导出。',
    );
  };

  // 点击「下载存档文件」的入口：手机/微信先弹窗选择导出方式，桌面端直接下载
  const onDownloadClick = () => {
    const isMobileLike = /MicroMessenger|Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
    if (isMobileLike) {
      setExportFileChoiceOpen(true);
      return;
    }
    doDownloadFile();
  };

  // 生成存档码（使用裁剪后的传输快照，确保字符数不超过微信上限）
  const doGenerateCode = () => {
    setExportConfirmOpen(false);
    const code = compressToBase64(JSON.stringify(buildTransferSnapshot(state)));
    setExportCode(code);
    setSyncToast('✅ 已生成压缩存档码（已裁剪历史日志与低价值装备，可直接发微信），复制下方文本框内容即可。');
  };

  // 第二步：确认导入——写盘并刷新
  const confirmImport = () => {
    const parsed = importPayload;
    if (!parsed) return;
    if (!getCurrentUser()) {
      setImportConfirmOpen(false);
      setSyncToast('❌ 导入失败：当前未登录账号，请先在「末世行止」登录后再导入。');
      return;
    }
    saveGame(parsed);
    setImportConfirmOpen(false);
    setSyncToast('✅ 导入成功，正在刷新…');
    setTimeout(() => window.location.reload(), 600);
  };

  return (
    <Section title="系统设置">
      <Card>
        <h3 className="font-semibold text-zinc-100">存档</h3>
        <div className="mt-2 text-xs text-zinc-400">本存档创建于 {new Date(state.createdAt).toLocaleString()}。</div>
        <div className="mt-3 flex gap-2">
          <button
            onClick={() => setResetOpen(true)}
            className="rounded bg-rose-600 px-3 py-1 text-xs text-white hover:bg-rose-700"
          >重置存档</button>
          <span className="self-center text-xs text-zinc-500">
            清空当前避难所，重建一名新的主角（需输入重生者姓名，不可撤销）
          </span>
        </div>
        {resetOpen ? (
          <ResetSaveDialog
            defaultName={suggestedName}
            onCancel={() => setResetOpen(false)}
            onConfirm={(name) => {
              // v1.0.10 补充：优先走 Hub 的重置（会一并退出出击），避免重生主角仍处于副本中
              if (onResetGame) onResetGame(name);
              else mutate(() => createProtagonistGame(name));
              setResetOpen(false);
            }}
          />
        ) : null}
      </Card>

      {/* v1.1.5 补充：跨设备存档同步 —— 两种方式：① 压缩存档码（适合微信）② 存档文件（下载/上传） */}
      <Card>
        <h3 className="font-semibold text-zinc-100">跨设备存档同步（存档码 / 存档文件）</h3>
        <p className="mt-1 text-xs text-zinc-400">
          两种方式任选其一：①「生成存档码」得到一段<strong className="text-zinc-200">已压缩</strong>文本，可直接粘贴到微信 / 邮件，但会裁剪部分信息（详见生成时的二次提醒）；②「下载存档文件」导出 .json，<strong className="text-zinc-200">完整保留全部装备与信息</strong>，换设备后上传导入。<strong className="text-amber-200">在手机 / 微信内点击「下载存档文件」会弹出选择：可尝试导出 .json 文件，或生成完整文本供复制</strong>。两者都需在新设备登录同一账号才生效。
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            onClick={() => setExportConfirmOpen(true)}
            className="rounded bg-sky-600 px-3 py-1 text-xs text-white hover:bg-sky-700"
          >
            生成存档码
          </button>
          <button
            onClick={onDownloadClick}
            className="rounded bg-emerald-700 px-3 py-1 text-xs text-white hover:bg-emerald-600"
          >
            下载存档文件
          </button>
          {exportCode ? (
            <button
              onClick={async () => {
                const ok = await safeCopy(exportCode);
                setSyncToast(ok ? '✅ 已复制到剪贴板。' : '⚠️ 自动复制失败，请手动选中文本框复制。');
              }}
              className="rounded bg-zinc-700 px-3 py-1 text-xs text-white hover:bg-zinc-600"
            >
              复制存档码
            </button>
          ) : null}
        </div>
        {exportCode ? (
          <textarea
            readOnly
            value={exportCode}
            onFocus={(e) => e.currentTarget.select()}
            className="mt-2 h-24 w-full rounded border border-zinc-700 bg-zinc-900 p-2 font-mono text-[10px] text-zinc-300"
          />
        ) : null}

        {/* 手机/微信环境：完整存档以文本形式呈现，供长按复制保存 */}
        {exportFileText ? (
          <div className="mt-2 rounded border border-zinc-700 bg-zinc-900 p-2">
            <p className="text-[11px] text-amber-200/80">
              完整存档文本（已完整保留全部装备与信息，可长按全选复制后转发保存；电脑端粘贴回「方式一 · 从存档码导入」框即可导入）：
            </p>
            <textarea
              readOnly
              value={exportFileText}
              onFocus={(e) => e.currentTarget.select()}
              className="mt-2 h-32 w-full rounded border border-zinc-700 bg-zinc-950 p-2 font-mono text-[10px] text-zinc-300"
            />
            <button
              onClick={async () => {
                const ok = await safeCopy(exportFileText);
                setSyncToast(ok ? '✅ 已复制完整存档文本，可粘贴保存。' : '⚠️ 自动复制失败，请长按文本框手动全选复制。');
              }}
              className="mt-2 rounded bg-zinc-700 px-3 py-1 text-xs text-white hover:bg-zinc-600"
            >
              复制完整文本
            </button>
          </div>
        ) : null}

        {/* 手机/微信环境：点击「下载存档文件」后弹出选择导出方式 */}
        {exportFileChoiceOpen ? (
          <div className="mt-4 rounded border border-emerald-600/60 bg-emerald-950/20 p-3">
            <p className="text-xs font-semibold text-emerald-200">选择存档导出方式</p>
            <p className="mt-1 text-[11px] text-emerald-200/80">
              当前为手机 / 微信环境，请选择一种方式：① 导出 .json 文件（部分手机浏览器 / 微信可能拦截直接下载）；② 生成完整存档文本，可复制保存（兼容微信）。
            </p>
            <div className="mt-2 flex flex-col gap-2">
              <button
                onClick={() => {
                  setExportFileChoiceOpen(false);
                  doDownloadFile();
                }}
                className="rounded bg-emerald-700 px-3 py-1.5 text-xs text-white hover:bg-emerald-600"
              >
                ① 导出为 .json 文件（尝试下载）
              </button>
              <button
                onClick={showExportFileText}
                className="rounded bg-zinc-700 px-3 py-1.5 text-xs text-white hover:bg-zinc-600"
              >
                ② 生成完整文本（可复制保存）
              </button>
              <button
                onClick={() => setExportFileChoiceOpen(false)}
                className="mt-1 self-end rounded bg-zinc-800 px-3 py-1 text-[11px] text-zinc-300 hover:bg-zinc-700"
              >
                取消
              </button>
            </div>
          </div>
        ) : null}

        {/* 生成存档码二次确认：提示存档码会裁剪部分信息 */}
        {exportConfirmOpen ? (
          <div className="mt-4 rounded border border-amber-600/60 bg-amber-950/30 p-3">
            <p className="text-xs font-semibold text-amber-200">
              ⚠️ 生成存档码须知
            </p>
            <p className="mt-1 text-[11px] text-amber-200/80">
              存档码为便于微信发送已做压缩裁剪：仅保留已装备的装备，未装备装备按价值保留前 50 件，待招募保留战力前 10 人，历史日志、出击记录、漫游记录各保留近期少量。导入存档码后，被裁剪的装备与待招募信息将<strong className="text-amber-100">无法恢复</strong>。
            </p>
            <p className="mt-1 text-[11px] text-amber-200/80">
              如需<strong className="text-amber-100">完整无裁剪</strong>的备份，请改用「下载存档文件」（.json）方式。确认仍要生成存档码？
            </p>
            <div className="mt-2 flex gap-2">
              <button
                onClick={() => setExportConfirmOpen(false)}
                className="rounded bg-zinc-700 px-3 py-1 text-xs text-white hover:bg-zinc-600"
              >
                取消
              </button>
              <button
                onClick={doGenerateCode}
                className="rounded bg-sky-600 px-3 py-1 text-xs text-white hover:bg-sky-700"
              >
                确认生成
              </button>
            </div>
          </div>
        ) : null}

        {/* 方式一：存档码（已压缩，适合微信） */}
        <div className="mt-4 border-t border-zinc-800 pt-3">
          <h4 className="text-xs font-semibold text-zinc-200">方式一 · 从存档码导入</h4>
          <p className="mt-1 text-[11px] text-zinc-500">导入将覆盖当前账号存档，导入前请先备份。粘贴「生成存档码」得到的文本即可。</p>
          <textarea
            value={importCode}
            onChange={(e) => {
              setImportCode(e.target.value);
              setImportConfirmOpen(false);
            }}
            placeholder="粘贴存档码…"
            className="mt-2 h-20 w-full rounded border border-zinc-700 bg-zinc-900 p-2 font-mono text-[10px] text-zinc-300"
          />
          <button
            onClick={startImportFromText}
            disabled={!importCode.trim() || importConfirmOpen}
            className="mt-2 rounded bg-sky-600 px-3 py-1 text-xs text-white hover:bg-sky-700 disabled:opacity-40"
          >
            导入存档码
          </button>
        </div>

        {/* 方式二：存档文件（下载 / 上传 .json） */}
        <div className="mt-4 border-t border-zinc-800 pt-3">
          <h4 className="text-xs font-semibold text-zinc-200">方式二 · 从存档文件导入</h4>
          <p className="mt-1 text-[11px] text-zinc-500">选择此前「下载存档文件」得到的 .json 文件即可导入。</p>
          <label className="mt-2 inline-block cursor-pointer rounded bg-sky-600 px-3 py-1 text-xs text-white hover:bg-sky-700">
            选择存档文件…
            <input
              type="file"
              accept=".json,application/json"
              onChange={startImportFromFile}
              className="hidden"
            />
          </label>
        </div>

        {/* 内联二次确认（两种导入方式共用） */}
        {importConfirmOpen ? (
          <div className="mt-4 rounded border border-amber-600/60 bg-amber-950/30 p-3">
            <p className="text-xs font-semibold text-amber-200">
              ⚠️ 二次确认：即将覆盖当前账号「{getCurrentUser() ?? '未登录'}」的存档
            </p>
            <p className="mt-1 text-[11px] text-amber-200/80">
              此操作不可撤销，导入后当前避难所的全部进度将被存档内容替换。确认继续？
            </p>
            <div className="mt-2 flex gap-2">
              <button
                onClick={() => setImportConfirmOpen(false)}
                className="rounded bg-zinc-700 px-3 py-1 text-xs text-white hover:bg-zinc-600"
              >
                取消
              </button>
              <button
                onClick={confirmImport}
                className="rounded bg-rose-600 px-3 py-1 text-xs text-white hover:bg-rose-700"
              >
                确认导入
              </button>
            </div>
          </div>
        ) : null}
        {syncToast ? <div className="mt-2 text-xs text-emerald-300">{syncToast}</div> : null}
      </Card>

      {/* v1.1.0：GM 调试面板（需密钥解锁） */}
      <GmPanel state={state} mutate={mutate} />
    </Section>
  );
};

// ===== 24. 幸存者花名册（副本中找到、待招募的幸存者） =====
export const ViewRecruits: React.FC<ViewProps> = ({ state, mutate }) => {
  const full = state.survivors.length >= WARBAND_CAP;
  return (
    <Section
      title="🪪 幸存者花名册"
      subtitle={`目前 ${state.recruits.length} 名待招募 · 战团 ${state.survivors.length}/${WARBAND_CAP}`}
    >
      {state.recruits.length === 0 ? (
        <Card><div className="text-sm text-zinc-400">暂无待招募成员。出击搜打撤时，有概率在副本中救出幸存者，他们会先进入这里的花名册，用废土币招募后加入战团。越厉害的幸存者招募费越高。</div></Card>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {state.recruits.map((r) => {
            const fee = recruitFee(r.tier);
            const canAfford = state.coins >= fee && !full;
            const tc = tierColor(r.tier);
            return (
              <Card key={r.id} className="overflow-hidden" style={{ borderColor: `${tc}55` }}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-base font-semibold" style={{ color: tc }}>{r.name}</span>
                    </div>
                    <div className="mt-0.5 flex items-center gap-1 text-xs text-zinc-400">
                      <TierBadge tier={r.tier} name={r.tierName} size="sm" /> · 战力 {r.power}
                    </div>
                    {r.traits.length > 0 && (
                      <ul className="mt-2 flex flex-wrap gap-1">
                        {r.traits.map((t) => {
                          const c = affixColor(t.quality as AffixTierKey);
                          return (
                            <li
                              key={t.id}
                              className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs"
                              style={{ color: c, backgroundColor: `${c}22`, border: `1px solid ${c}55` }}
                            >
                              <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ backgroundColor: c }} />
                              {t.name}
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    <span className="text-[11px] text-zinc-500">招募费</span>
                    <span className={`text-sm font-semibold ${canAfford ? 'text-emerald-400' : 'text-rose-400'}`}>⛁ {fee}</span>
                  </div>
                </div>
                <div className="mt-3 flex gap-2">
                  <button
                    onClick={() => mutate((s) => acceptRecruit(s, r.id))}
                    disabled={!canAfford}
                    className="flex-1 rounded bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-700 disabled:opacity-40"
                    title={full ? '战团已满，需先遣散' : state.coins < fee ? '废土币不足' : ''}
                  >招募入团</button>
                  <button
                    onClick={() => mutate((s) => dismissRecruit(s, r.id))}
                    className="rounded bg-zinc-800 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-700"
                  >放走</button>
                </div>
              </Card>
            );
          })}
        </div>
      )}
      {full && <div className="text-xs text-rose-300">战团已满（{WARBAND_CAP} 人），无法招募新成员，请先在「战团成员」中遣散腾位。</div>}
    </Section>
  );
};

// ===== 25. 医疗中心（HP/伤势/药品） =====
export const ViewMedical: React.FC<ViewProps> = ({ state, mutate, setState }) => {
  const [now, setNow] = useState(0);
  // 每次进入页面应用一次时间戳恢复
  useEffect(() => {
    const healed = recoverAll(state);
    if (healed !== state) setState(healed);
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // v1.1.7：医疗中心右上角「一键救治」——当前出击者，消耗 500 废土币，生命拉满 + 清除全部 debuff/濒死
  const active = activeSurvivor(state);
  const canOneClickHeal = !!active && state.coins >= ONE_CLICK_HEAL_COST;
  return (
    <Section title="医疗中心" subtitle="按时间戳结算全员恢复；伤势越重越慢。">
      <div className="mb-3 flex items-center justify-end gap-2">
        <button
          onClick={() => mutate((st) => (active ? oneClickHeal(st, active.id) : st))}
          disabled={!canOneClickHeal}
          className="rounded bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-40"
        >
          一键救治（当前出击者：{active?.name ?? '未选出击者'} · ⛁{ONE_CLICK_HEAL_COST}）
        </button>
      </div>
      <div className="space-y-3">
        {state.survivors.map((s) => {
          const status = state.survivorStatus[s.id];
          if (!status) return null;
          const rate = regenPerMinute(s, status, state, now);
          const eta = timeToFullSeconds(s, status, state, now);
          const etaText = eta === 0 ? '已满血' : eta === Number.POSITIVE_INFINITY ? '需要治疗' : `${Math.floor(eta / 60)} 分 ${eta % 60} 秒`;
          const dyingUntil = status.dyingUntil ? new Date(status.dyingUntil).getTime() : 0;
          const isDying = dyingUntil > now;
          const dyingLeft = isDying ? Math.ceil((dyingUntil - now) / 60000) : 0;
          return (
            <Card key={s.id}>
              <div className="flex items-center justify-between">
                <div>
                  <div className="font-semibold text-zinc-100">{s.name}</div>
                  <div className="flex items-center gap-1 text-xs text-zinc-400">
                    <TierBadge tier={s.tier} name={s.tierName} size="sm" /> · 体质 {s.attributes.vitality}
                  </div>
                </div>
                <div className="text-right text-xs text-zinc-400">
                  恢复速率 {rate.toFixed(2)}/分<br />
                  预计满血 {etaText}
                </div>
              </div>
              <div className="mt-3">{hpBar(status.currentHp, status.maxHp)}</div>
              {isDying && (
                <div className="mt-2 rounded border border-rose-800 bg-rose-950/30 p-2 text-xs text-rose-300">
                  <div className="flex items-center justify-between gap-2">
                    <span>☠ 濒死状态·约 {dyingLeft} 分钟内未救治将离世</span>
                    <button
                      onClick={() => mutate((st) => treatNearDeathWithCoins(st, s.id))}
                      disabled={state.coins < NEAR_DEATH_TREAT_COST}
                      className="rounded bg-rose-600 px-2 py-1 text-white hover:bg-rose-700 disabled:opacity-40"
                    >救治（{NEAR_DEATH_TREAT_COST} 币）</button>
                  </div>
                </div>
              )}
              {status.injuries.length > 0 && (
                <ul className="mt-2 flex flex-wrap gap-1">
                  {status.injuries.map((inj) => (
                    <li key={inj}>
                      <Pill tone="red">{INJURY_LABEL[inj]}</Pill>
                    </li>
                  ))}
                </ul>
              )}
              <div className="mt-3 flex flex-wrap gap-2">
                {MEDICINES.filter((m) => m.id !== 'stim' && (state.medicines[m.id] ?? 0) > 0).map((m) => (
                  <button
                    key={m.id}
                    onClick={() => mutate((st) => applyMedicineToSurvivor(st, s.id, m.id))}
                    className="rounded bg-sky-600 px-3 py-1 text-xs text-white hover:bg-sky-700"
                  >使用 {m.name}（{medEffectShort(m)}）x{state.medicines[m.id] ?? 0}</button>
                ))}
                {MEDICINES.every((m) => (state.medicines[m.id] ?? 0) === 0) && (
                  <span className="text-xs text-zinc-500">没有医疗品了，去「废土市场」购买</span>
                )}
              </div>
            </Card>
          );
        })}
      </div>
    </Section>
  );
};