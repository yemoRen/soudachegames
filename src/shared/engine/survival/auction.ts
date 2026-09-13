import type { RNG } from './rng';
import { rollGearDrop } from './affixes';
import { GEAR_SLOT_LABEL, type GearItem } from './economy';
import type { SurvivalGameState } from './state';

/** 拍卖行一次性呈现的装备数量 */
export const AUCTION_COUNT = 10;
/** 自动刷新间隔：30 分钟 */
export const AUCTION_REFRESH_MS = 30 * 60 * 1000;
/** 立即再刷一轮所需废土币 */
export const AUCTION_INSTANT_REFRESH_COST = 500;

export interface AuctionItem {
  id: string;
  gear: GearItem;
  price: number;
  sold: boolean;
}

export interface AuctionState {
  items: AuctionItem[];
  /** 下次自动刷新的时间戳（ms） */
  refreshAt: number;
  /** 上次刷新的时间戳（ms，用于展示） */
  lastRefresh: number;
}

/**
 * 每轮拍卖的危险度分布（危1~危7）。
 * 取 [1,1,2,2,3,3,4,5,6,7] 并随机打乱 → 10 件装备覆盖「低→中→高」品质梯度，
 * 既有新手买得起的低阶，也偶尔上架高阶（霸主/超凡/神话）供后期捡漏。
 */
const BASE_DANGER: readonly number[] = [1, 1, 2, 2, 3, 3, 4, 5, 6, 7];

function shuffle<T>(rng: RNG, arr: readonly T[]): T[] {
  const pool = [...arr];
  const out: T[] = [];
  while (pool.length) {
    const i = Math.floor(rng() * pool.length);
    out.push(pool.splice(i, 1)[0]);
  }
  return out;
}

/**
 * 拍卖行各阶级基础定价（白阶约 200，红阶约 20000）。
 * 其余阶级按指数平滑分配，再叠加 ±8% 抖动并取整到 5 币。
 */
const AUCTION_TIER_BASE_PRICE: readonly number[] = [200, 430, 930, 2000, 4310, 9270, 20000];

export function auctionPrice(rng: RNG, gear: GearItem): number {
  const tier = Math.max(0, Math.min(6, gear.tier ?? 0));
  const base = AUCTION_TIER_BASE_PRICE[tier];
  const jitter = 0.92 + rng() * 0.16;
  return Math.max(30, Math.round((base * jitter) / 5) * 5);
}

/** 生成一整轮拍卖装备（AUCTION_COUNT 件）。 */
export function generateAuctionItems(rng: RNG, _state: SurvivalGameState): AuctionItem[] {
  const dangers = shuffle(rng, BASE_DANGER);
  return dangers.map((d, i) => {
    const loot = rollGearDrop(rng, d, 0.1, 0, false);
    const gear = loot.gear;
    const price = auctionPrice(rng, gear);
    const id = `auc-${Date.now().toString(36)}-${i}-${Math.floor(rng() * 1e6).toString(36)}`;
    return { id, gear, price, sold: false };
  });
}

/**
 * 重铸（刷新）拍卖行。
 * @param cost 为 0 表示自动/免费刷新；否则为「立即刷新」付费（AUCTION_INSTANT_REFRESH_COST）。
 * 余额不足时返回原状态（空操作），调用方据此提示。
 */
export function rollNewAuction(
  state: SurvivalGameState,
  rng: RNG,
  now: number,
  cost = 0,
): SurvivalGameState {
  if (cost > 0 && state.coins < cost) return state;
  const items = generateAuctionItems(rng, state);
  // v1.1.9：立即刷新只重Roll商品，不重置「下次自动刷新」倒计时，两者独立。
  const refreshAt =
    cost > 0 && state.auction ? state.auction.refreshAt : now + AUCTION_REFRESH_MS;
  return {
    ...state,
    coins: state.coins - cost,
    auction: {
      items,
      refreshAt,
      lastRefresh: now,
    },
    log: [
      `【拍卖行】新一轮废土装备上架，共 ${items.length} 件（${cost > 0 ? `花费 ${cost} 废土币立即刷新` : '自动刷新'}）。`,
      ...state.log,
    ].slice(0, 50),
  };
}

/** 购买某一件拍卖装备：扣废土币、入背包、标记已售。余额不足或已售返回原状态。 */
export function buyAuctionItem(state: SurvivalGameState, listingId: string): SurvivalGameState {
  const auc = state.auction;
  if (!auc) return state;
  const it = auc.items.find((x) => x.id === listingId);
  if (!it || it.sold) return state;
  if (state.coins < it.price) return state;
  const gear = it.gear;
  return {
    ...state,
    coins: state.coins - it.price,
    gear: [...state.gear, gear],
    auction: {
      ...auc,
      items: auc.items.map((x) => (x.id === listingId ? { ...x, sold: true } : x)),
    },
    log: [
      `【拍卖行】购入 ${gear.name}（${gear.rarityName ?? gear.rarity}），花费 ${it.price} 废土币。`,
      ...state.log,
    ].slice(0, 50),
  };
}

/** 拍卖是否过期（无数据或已到刷新时间）。 */
export function isAuctionExpired(auc: AuctionState | undefined, now: number): boolean {
  return !auc || auc.refreshAt <= now;
}

export { GEAR_SLOT_LABEL };
