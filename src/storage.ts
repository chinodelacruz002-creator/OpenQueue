import {
  LOCAL_STORAGE_KEY,
  SUPABASE_MIRROR_STORAGE_KEY,
} from './constants';
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

let loadOpenPlayInFlight: Promise<AppData | null> | null = null;

const MIRROR_VERSION = 1 as const;

interface MirrorEnvelope {
  v: typeof MIRROR_VERSION;
  app: AppData;
  persistenceGen: number;
  savedGen: number;
  serverUpdatedAt: string | null;
}

const emptyEnvelope = (app: AppData): MirrorEnvelope => ({
  v: MIRROR_VERSION,
  app,
  persistenceGen: 0,
  savedGen: 0,
  serverUpdatedAt: null,
});

const isAppDataShape = (value: unknown): value is AppData => {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const o = value as Record<string, unknown>;
  return typeof o.sessionDate === 'string' && Array.isArray(o.players) && Array.isArray(o.courts);
};

const readMirrorEnvelope = (): MirrorEnvelope | null => {
  const raw = window.localStorage.getItem(SUPABASE_MIRROR_STORAGE_KEY);
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && 'v' in parsed && (parsed as MirrorEnvelope).v === MIRROR_VERSION) {
      const env = parsed as MirrorEnvelope;
      if (isAppDataShape(env.app)) {
        return env;
      }
      return null;
    }
    if (isAppDataShape(parsed)) {
      return emptyEnvelope(parsed);
    }
    return null;
  } catch {
    return null;
  }
};

const writeMirrorEnvelope = (envelope: MirrorEnvelope): void => {
  try {
    window.localStorage.setItem(SUPABASE_MIRROR_STORAGE_KEY, JSON.stringify(envelope));
  } catch {
    // Quota or private mode — ignore; network path still works.
  }
};

const nextMirrorGeneration = (): number => {
  const prev = readMirrorEnvelope();
  return Math.max(prev?.persistenceGen ?? 0, prev?.savedGen ?? 0) + 1;
};

/** Exposed for tests / debugging; mirror is the source of truth for stale-fetch detection. */
export const getPersistenceGenSnapshot = (): { persistenceGen: number; savedGen: number } => {
  const env = readMirrorEnvelope();
  return {
    persistenceGen: env?.persistenceGen ?? 0,
    savedGen: env?.savedGen ?? 0,
  };
};

/**
 * Writes the latest app snapshot to the local mirror immediately so a concurrent
 * Supabase fetch cannot replace fresher UI state with an in-flight stale row.
 */
export const writeOptimisticMirror = (data: AppData): void => {
  const prev = readMirrorEnvelope();
  const next: MirrorEnvelope = {
    v: MIRROR_VERSION,
    app: data,
    persistenceGen: nextMirrorGeneration(),
    savedGen: prev?.savedGen ?? 0,
    serverUpdatedAt: prev?.serverUpdatedAt ?? null,
  };
  writeMirrorEnvelope(next);
};

const fetchOpenPlayFromSupabase = async (): Promise<AppData | null> => {
  if (!supabase) {
    return null;
  }

  const mirrorBeforeFetch = readMirrorEnvelope();
  const hadPending = Boolean(
    mirrorBeforeFetch && mirrorBeforeFetch.persistenceGen > mirrorBeforeFetch.savedGen,
  );

  const { data: playerRows, error: playerError } = await supabase
    .from('players')
    .select('*')
    .order('ranking_score', { ascending: false })
    .order('name', { ascending: true });

  if (playerError) {
    return mirrorBeforeFetch?.app ?? null;
  }

  const { data: stateRow, error: stateError } = await supabase
    .from('open_play_state')
    .select('*')
    .eq('id', OPEN_PLAY_STATE_ID)
    .maybeSingle<OpenPlayStateRow>();

  const savedPlayers = playerRows.map(mapRowToSavedPlayer);

  const serverTs = stateRow?.updated_at ?? null;

  if (hadPending && mirrorBeforeFetch) {
    if (!serverTs || !mirrorBeforeFetch.serverUpdatedAt) {
      return mirrorBeforeFetch.app;
    }
    const serverTime = new Date(serverTs).getTime();
    const mirrorTime = new Date(mirrorBeforeFetch.serverUpdatedAt).getTime();
    if (serverTime <= mirrorTime) {
      return mirrorBeforeFetch.app;
    }
  }

  if (stateError || !stateRow) {
    const fallback: AppData = {
      sessionDate: getTodayKey(),
      players: [],
      courts: [],
      maxMinutes: 15,
      savedPlayers,
      savedPaddles: uniqueValues([...playerRows.map((row) => row.paddle)]),
      savedGripColors: uniqueValues([...playerRows.map((row) => row.grip_color)]),
    };
    const syncedGen = nextMirrorGeneration();
    writeMirrorEnvelope({
      v: MIRROR_VERSION,
      app: fallback,
      persistenceGen: syncedGen,
      savedGen: syncedGen,
      serverUpdatedAt: serverTs,
    });
    return fallback;
  }

  const merged: AppData = {
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

  const syncedGen = nextMirrorGeneration();
  const envelope: MirrorEnvelope = {
    v: MIRROR_VERSION,
    app: merged,
    persistenceGen: syncedGen,
    savedGen: syncedGen,
    serverUpdatedAt: stateRow.updated_at ?? null,
  };
  writeMirrorEnvelope(envelope);
  return merged;
};

export const loadOpenPlayData = async (): Promise<AppData | null> => {
  if (!supabase) {
    return loadLocalData();
  }

  if (loadOpenPlayInFlight) {
    return loadOpenPlayInFlight;
  }

  loadOpenPlayInFlight = (async () => {
    try {
      return await fetchOpenPlayFromSupabase();
    } catch {
      return readMirrorEnvelope()?.app ?? null;
    } finally {
      loadOpenPlayInFlight = null;
    }
  })();

  return loadOpenPlayInFlight;
};

export const saveOpenPlayData = async (data: AppData): Promise<void> => {
  if (!supabase) {
    saveLocalData(data);
    return;
  }

  const [playersResult, stateResult] = await Promise.all([
    supabase.from('players').upsert(data.savedPlayers.map(mapSavedPlayerToRow)),
    supabase
      .from('open_play_state')
      .upsert({
        id: OPEN_PLAY_STATE_ID,
        session_date: data.sessionDate,
        players: data.players,
        courts: data.courts,
        max_minutes: data.maxMinutes,
        saved_paddles: data.savedPaddles,
        saved_grip_colors: data.savedGripColors,
        updated_at: new Date().toISOString(),
      })
      .select('updated_at')
      .single(),
  ]);

  const errors = [playersResult.error, stateResult.error].filter(
    (e): e is NonNullable<typeof playersResult.error> => Boolean(e),
  );
  if (errors.length > 0) {
    const message = errors.map((e) => e.message).join('; ');
    throw new Error(message);
  }

  const serverUpdatedAt =
    stateResult.data && typeof stateResult.data === 'object' && 'updated_at' in stateResult.data
      ? String((stateResult.data as { updated_at: string }).updated_at)
      : new Date().toISOString();

  const pending = readMirrorEnvelope();
  const gen = pending?.persistenceGen ?? nextMirrorGeneration();
  writeMirrorEnvelope({
    v: MIRROR_VERSION,
    app: data,
    persistenceGen: gen,
    savedGen: gen,
    serverUpdatedAt,
  });
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
