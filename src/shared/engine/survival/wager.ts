/*
 * survival/wager.ts — 末世赌局持久化状态
 *
 * v1.1.9：把赌局进行中的数据写入 SurvivalGameState，避免切换菜单后状态丢失。
 * 只存可 JSON 序列化的数据；DuelSession 本身在恢复时根据 BattleSaveV1 重建。
 */
import type { SurvivorProfile } from './chargen';
import type { BattleSaveV1 } from '@shared/engine/battle-v5/persistence/types';
import type { BattleStateTimelineV3 } from '@shared/engine/battle-v5/v3/types';
import type { UnitStateSnapshot } from '@shared/engine/battle-v5/systems/state/types';

export type WagerBetSide = 'a' | 'b';

export type ArenaLogTone = 'header' | 'damage' | 'dodge' | 'death' | 'heal' | 'neutral';

export interface WagerLogLine {
  round: number;
  text: string;
  tone: ArenaLogTone;
}

/** 写入 SurvivalGameState.wager 的持久化结构 */
export interface WagerState {
  version: 1;
  fighters: { a: SurvivorProfile; b: SurvivorProfile };
  bet: WagerBetSide | null;
  /** 是否已点击「开始切磋」生成 save */
  started: boolean;
  battleId: string;
  playerId: string;
  opponentId: string;
  /** 当前 battle save；started 为 true 时不为空 */
  save: BattleSaveV1 | null;
  /** 开局状态时间线（用于恢复 DuelSession） */
  initialTimeline: BattleStateTimelineV3;
  round: number;
  ended: boolean;
  winnerId: string | null;
  settled: boolean;
  resultMsg: string | null;
  log: WagerLogLine[];
  snaps: { a: UnitStateSnapshot | null; b: UnitStateSnapshot | null };
}
