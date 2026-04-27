import { logOpenQueueAction } from './actionLog';
import { LOCAL_STORAGE_KEY, normalizePhoneDigits } from './constants';
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
  phone?: string | null;
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
  show_public_ranking?: boolean | null;
  updated_at: string;
}

const getTodayKey = (): string => new Date().toISOString().slice(0, 10);

const DEFAULT_COURT_COUNT = 4;

const defaultCourtsIfEmpty = (courts: Court[]): Court[] => {
  if (courts?.length) {
    return courts;
  }
  return Array.from({ length: DEFAULT_COURT_COUNT }, (_, index) => ({
    id: `court-${index + 1}`,
    name: `Court ${index + 1}`,
    minLevel: Math.max(1, index + 1),
    maxLevel: Math.min(4, index + 2),
    status: 'ready' as const,
    match: null,
  }));
};

const migratePlayerRecord = (player: Player): Player => ({
  ...player,
  phone: player.phone ?? '',
  joinedQueueAt:
    player.joinedQueueAt === undefined
      ? null
      : player.joinedQueueAt,
});

const migrateSavedRecord = (saved: SavedPlayer): SavedPlayer => ({
  ...saved,
  phone: saved.phone ?? '',
});

export const migrateAppData = (data: AppData): AppData => ({
  ...data,
  sessionDate: data.sessionDate || getTodayKey(),
  showPublicRanking: data.showPublicRanking !== false,
  players: (data.players ?? []).map(migratePlayerRecord),
  savedPlayers: (data.savedPlayers ?? []).map(migrateSavedRecord),
  courts: data.courts ?? [],
  maxMinutes: data.maxMinutes ?? 15,
  savedPaddles: data.savedPaddles ?? [],
  savedGripColors: data.savedGripColors ?? [],
});

const phoneConflictInSession = (players: Player[], digits: string, excludeId?: string): boolean => {
  if (!digits) {
    return false;
  }
  return players.some(
    (p) => p.id !== excludeId && normalizePhoneDigits(p.phone) === digits,
  );
};

export type SelfRegisterResult =
  | { ok: true; playerId: string }
  | { ok: false; error: string };

/**
 * Appends a self-registered player with read–modify–write and retries (best-effort for concurrent admins).
 */
export const appendSelfRegisteredPlayer = async (
  newPlayer: Player,
): Promise<SelfRegisterResult> => {
  const digits = normalizePhoneDigits(newPlayer.phone);
  const nameKey = newPlayer.name.trim().toLowerCase();

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const data = await loadOpenPlayData();
    if (!data) {
      return { ok: false, error: 'Could not load current queue. Try again.' };
    }
    const base = migrateAppData(data);

    if (digits && phoneConflictInSession(base.players, digits)) {
      return { ok: false, error: 'That phone number is already checked in today.' };
    }
    if (
      base.players.some((p) => p.name.trim().toLowerCase() === nameKey)
    ) {
      return { ok: false, error: 'That name is already on today’s list.' };
    }

    const savedMatch =
      digits.length > 0
        ? base.savedPlayers.find((s) => normalizePhoneDigits(s.phone) === digits)
        : undefined;

    const playerToAdd: Player = {
      ...newPlayer,
      persistentId: savedMatch?.id ?? newPlayer.persistentId,
    };

    const next: AppData = {
      ...base,
      courts: defaultCourtsIfEmpty(base.courts),
      players: [...base.players, playerToAdd],
    };

    try {
      await saveOpenPlayData(next);
      return { ok: true, playerId: playerToAdd.id };
    } catch {
      // Retry on conflict
    }
  }

  return { ok: false, error: 'Could not save — try again in a moment.' };
};

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
    logOpenQueueAction({
      category: 'data_load',
      action: 'load_players',
      trigger: 'storage.loadOpenPlayData',
      status: 'failed',
      persistence: 'supabase',
      error: playerError.message,
    });
    return null;
  }

  const { data: stateRow, error: stateError } = await supabase
    .from('open_play_state')
    .select('*')
    .eq('id', OPEN_PLAY_STATE_ID)
    .maybeSingle<OpenPlayStateRow>();

  const savedPlayers = playerRows.map(mapRowToSavedPlayer);

  if (stateError || !stateRow) {
    return migrateAppData({
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
      showPublicRanking: true,
    });
  }

  return migrateAppData({
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
    showPublicRanking: stateRow.show_public_ranking !== false,
  });
};

export const saveOpenPlayData = async (data: AppData): Promise<void> => {
  if (!supabase) {
    saveLocalData(data);
    return;
  }

  clearLocalData();

  const [playersResult, stateResult] = await Promise.all([
    supabase.from('players').upsert(data.savedPlayers.map(mapSavedPlayerToRow)),
    supabase.from('open_play_state').upsert({
      id: OPEN_PLAY_STATE_ID,
      session_date: data.sessionDate,
      players: data.players,
      courts: data.courts,
      max_minutes: data.maxMinutes,
      saved_paddles: data.savedPaddles,
      saved_grip_colors: data.savedGripColors,
      show_public_ranking: data.showPublicRanking,
      updated_at: new Date().toISOString(),
    }),
  ]);

  const errors = [playersResult.error, stateResult.error].filter(
    (e): e is NonNullable<typeof playersResult.error> => Boolean(e),
  );
  if (errors.length > 0) {
    const message = errors.map((e) => e.message).join('; ');
    logOpenQueueAction({
      category: 'persistence',
      action: 'supabase_upsert',
      trigger: 'storage.saveOpenPlayData',
      status: 'failed',
      persistence: 'supabase',
      detail: {
        playersError: playersResult.error?.message ?? null,
        stateError: stateResult.error?.message ?? null,
      },
      error: message,
    });
    throw new Error(message);
  }
};

const loadLocalData = (): AppData | null => {
  const rawData = window.localStorage.getItem(LOCAL_STORAGE_KEY);

  if (!rawData) {
    return null;
  }

  try {
    return migrateAppData(JSON.parse(rawData) as AppData);
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
  phone: row.phone ?? '',
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
  phone: player.phone || null,
  wins: player.wins,
  losses: player.losses,
  games_played: player.gamesPlayed,
  ranking_score: player.rankingScore,
});

const uniqueValues = (values: string[]): string[] =>
  Array.from(new Set(values.map((value) => value.trim()).filter(Boolean))).sort(
    (first, second) => first.localeCompare(second),
  );

/**
 * Fires when `open_play_state` changes in Supabase (requires table in the `supabase_realtime` publication).
 */
export const subscribeOpenPlayRealtime = (onChange: () => void): (() => void) => {
  if (!supabase) {
    return () => {
      // No-op: Realtime is unavailable without a client.
    };
  }

  const client = supabase;
  const channel = client
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
    void client.removeChannel(channel);
  };
};
