import { LOCAL_STORAGE_KEY } from './constants';
import type { AppData, Court, Player, SavedPlayer } from './types';
import { hasSupabaseConfig, supabase } from './utils/supabase';

export { hasSupabaseConfig };

interface PlayerRow {
  id: string;
  name: string;
  level: number;
  min_level: number;
  max_level: number;
  paddle: string;
  grip_color: string;
  preferred_partner_name: string;
  wins: number;
  losses: number;
  games_played: number;
  ranking_score: number;
}

interface OpenPlayStateRow {
  id: string;
  session_date: string;
  players: Player[];
  courts: Court[];
  max_minutes: number;
  saved_paddles: string[];
  saved_grip_colors: string[];
  updated_at: string;
}

const OPEN_PLAY_STATE_ID = 'current';

export const loadOpenPlayData = async (): Promise<AppData | null> => {
  if (!supabase) {
    return loadLocalData();
  }

  clearLocalData();

  const { data: playerRows, error: playerError } = await supabase
    .from('players')
    .select('*')
    .order('ranking_score', { ascending: false })
    .order('name', { ascending: true });

  if (playerError) {
    return null;
  }

  const { data: stateRow, error: stateError } = await supabase
    .from('open_play_state')
    .select('*')
    .eq('id', OPEN_PLAY_STATE_ID)
    .maybeSingle<OpenPlayStateRow>();

  const savedPlayers = playerRows.map(mapRowToSavedPlayer);

  if (stateError || !stateRow) {
    return {
      sessionDate: getTodayKey(),
      players: [],
      courts: [],
      maxMinutes: 15,
      savedPlayers,
      savedPaddles: uniqueValues([
        ...playerRows.map((row) => row.paddle),
      ]),
      savedGripColors: uniqueValues([
        ...playerRows.map((row) => row.grip_color),
      ]),
    };
  }

  return {
    sessionDate: stateRow.session_date,
    players: stateRow.players ?? [],
    courts: stateRow.courts ?? [],
    maxMinutes: stateRow.max_minutes ?? 15,
    savedPlayers,
    savedPaddles: uniqueValues([
      ...(stateRow.saved_paddles ?? []),
      ...playerRows.map((row) => row.paddle),
    ]),
    savedGripColors: uniqueValues([
      ...(stateRow.saved_grip_colors ?? []),
      ...playerRows.map((row) => row.grip_color),
    ]),
  };
};

export const saveOpenPlayData = async (data: AppData): Promise<void> => {
  if (!supabase) {
    saveLocalData(data);
    return;
  }

  clearLocalData();

  await Promise.all([
    supabase.from('players').upsert(data.savedPlayers.map(mapSavedPlayerToRow)),
    supabase.from('open_play_state').upsert({
      id: OPEN_PLAY_STATE_ID,
      session_date: data.sessionDate,
      players: data.players,
      courts: data.courts,
      max_minutes: data.maxMinutes,
      saved_paddles: data.savedPaddles,
      saved_grip_colors: data.savedGripColors,
      updated_at: new Date().toISOString(),
    }),
  ]);
};

const loadLocalData = (): AppData | null => {
  const rawData = window.localStorage.getItem(LOCAL_STORAGE_KEY);

  if (!rawData) {
    return null;
  }

  try {
    return JSON.parse(rawData) as AppData;
  } catch {
    return null;
  }
};

const saveLocalData = (data: AppData): void => {
  window.localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(data));
};

const clearLocalData = (): void => {
  window.localStorage.removeItem(LOCAL_STORAGE_KEY);
};

const mapRowToSavedPlayer = (row: PlayerRow): SavedPlayer => ({
  id: row.id,
  name: row.name,
  level: row.level,
  minLevel: row.min_level,
  maxLevel: row.max_level,
  paddle: row.paddle,
  gripColor: row.grip_color,
  preferredPartnerName: row.preferred_partner_name,
  wins: row.wins,
  losses: row.losses,
  gamesPlayed: row.games_played,
  rankingScore: row.ranking_score,
});

const mapSavedPlayerToRow = (player: SavedPlayer): PlayerRow => ({
  id: player.id,
  name: player.name,
  level: player.level,
  min_level: player.minLevel,
  max_level: player.maxLevel,
  paddle: player.paddle,
  grip_color: player.gripColor,
  preferred_partner_name: player.preferredPartnerName,
  wins: player.wins,
  losses: player.losses,
  games_played: player.gamesPlayed,
  ranking_score: player.rankingScore,
});

const uniqueValues = (values: string[]): string[] =>
  Array.from(new Set(values.map((value) => value.trim()).filter(Boolean))).sort(
    (first, second) => first.localeCompare(second),
  );

const getTodayKey = (): string => new Date().toISOString().slice(0, 10);

/**
 * Fires when `open_play_state` changes in Supabase (requires table in the `supabase_realtime` publication).
 */
export const subscribeOpenPlayRealtime = (onChange: () => void): (() => void) => {
  if (!supabase) {
    return () => {
      // No-op: Realtime is unavailable without a client.
    };
  }

  const channel = supabase
    .channel('open_play_state_changes')
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'open_play_state' },
      () => {
        onChange();
      },
    )
    .subscribe();

  return () => {
    void supabase.removeChannel(channel);
  };
};
