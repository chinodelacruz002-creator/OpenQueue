export type PlayerStatus = 'present' | 'playing' | 'away' | 'left';

export type CourtStatus = 'ready' | 'reserved' | 'loaded' | 'playing';

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
  partnerId: string | null;
  arrivalStatus: PlayerStatus;
  wins: number;
  losses: number;
  gamesPlayed: number;
  waitScore: number;
  lastResult: LastResult;
  lockedGroupId: string | null;
  rankingScore: number;
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
  savedPlayers: SavedPlayer[];
  savedPaddles: string[];
  savedGripColors: string[];
}
