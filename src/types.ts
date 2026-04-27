export type PlayerStatus = 'present' | 'assigned' | 'playing' | 'away' | 'left';

export type CourtStatus = 'ready' | 'reserved' | 'loaded' | 'playing' | 'unavailable';

export type LastResult = 'won' | 'lost' | null;

export interface Player {
  id: string;
  persistentId: string | null;
  name: string;
  level: number;
  minLevel: number;
  maxLevel: number;
  paddle: string;
  gripColor: string;
  preferredPartnerName: string;
  /** Digits-only phone; optional; used for self-check-in and duplicate checks. */
  phone: string;
  partnerId: string | null;
  arrivalStatus: PlayerStatus;
  /** Today’s session only (not lifetime). */
  wins: number;
  losses: number;
  gamesPlayed: number;
  waitScore: number;
  lastResult: LastResult;
  lockedGroupId: string | null;
  /** Today’s session ranking score only. */
  rankingScore: number;
  /** When this player last entered the waiting queue (`present`); null if not waiting. */
  joinedQueueAt: number | null;
}

export interface SavedPlayer {
  id: string;
  name: string;
  level: number;
  minLevel: number;
  maxLevel: number;
  paddle: string;
  gripColor: string;
  preferredPartnerName: string;
  phone: string;
  wins: number;
  losses: number;
  gamesPlayed: number;
  rankingScore: number;
}

export interface Court {
  id: string;
  name: string;
  minLevel: number;
  maxLevel: number;
  status: CourtStatus;
  match: Match | null;
}

export interface Match {
  id: string;
  startedAt: number | null;
  durationMinutes: number;
  players: Player[];
  winnerIds: string[];
}

export interface QueueGroup {
  id: string;
  playerIds: string[];
  players: Player[];
  averageLevel: number;
  minLevel: number;
  maxLevel: number;
  compatibleCourtIds: string[];
  priorityScore: number;
  reason: string;
}

export interface AutoAssignment {
  court: Court;
  group: QueueGroup;
}

export type DragData =
  | {
      type: 'group';
      groupId: string;
      playerIds: string[];
    }
  | {
      type: 'player';
      playerId: string;
    };

export interface PlayerForm {
  name: string;
  level: number;
  minLevel: number;
  maxLevel: number;
  paddle: string;
  gripColor: string;
  preferredPartnerName: string;
  phone: string;
  arrivalStatus: PlayerStatus;
}

export interface OpenPlaySession {
  sessionDate: string;
  players: Player[];
  courts: Court[];
  maxMinutes: number;
  paddleOptions: string[];
  gripColorOptions: string[];
}

export interface AppData {
  sessionDate: string;
  players: Player[];
  courts: Court[];
  maxMinutes: number;
  savedPlayers: SavedPlayer[];
  savedPaddles: string[];
  savedGripColors: string[];
  /** When false, public links hide standings and scoring on the queue. */
  showPublicRanking: boolean;
}
