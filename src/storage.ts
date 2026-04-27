import {
  LOCAL_STORAGE_KEY,
  SUPABASE_MIRROR_STORAGE_KEY,
  normalizePhoneDigits,
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
  queue_player_order?: string[] | null;
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
  queuePlayerOrder: data.queuePlayerOrder ?? [],
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
      writeOptimisticMirror(next);
      const persistenceGenAtSave = getPersistenceGenSnapshot().persistenceGen;
      await saveOpenPlayData(next, persistenceGenAtSave);
      return { ok: true, playerId: playerToAdd.id };
    } catch {
      // Retry on conflict
    }
  }

  return { ok: false, error: 'Could not save — try again in a moment.' };
};

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

/**
 * Update mirror `app` only (keeps `persistenceGen` / `savedGen`). Use after a server-driven
 * `applyLoad` so we do not fake an unsaved local revision.
 */
export const syncMirrorToApp = (data: AppData): void => {
  const prev = readMirrorEnvelope();
  if (!prev) {
    writeOptimisticMirror(migrateAppData(data));
    return;
  }
  writeMirrorEnvelope({
    ...prev,
    app: migrateAppData(data),
  });
};

const fetchOpenPlayFromSupabase = async (): Promise<AppData | null> => {
  if (!supabase) {
    return null;
  }

  const mirrorBeforeFetch = readMirrorEnvelope();
  /**
   * Local state was written to the mirror before the last successful save — do not clobber
   * admin edits with a stale `open_play_state` row. Skip only after we have any server
   * `updated_at` in the mirror so the first load can still hydrate from the network.
   */
  if (
    mirrorBeforeFetch &&
    mirrorBeforeFetch.persistenceGen > mirrorBeforeFetch.savedGen &&
    mirrorBeforeFetch.serverUpdatedAt
  ) {
    return mirrorBeforeFetch.app;
  }

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

  if (stateError || !stateRow) {
    const fallback: AppData = migrateAppData({
      sessionDate: getTodayKey(),
      players: [],
      courts: [],
      maxMinutes: 15,
      savedPlayers,
      savedPaddles: uniqueValues([...playerRows.map((row) => row.paddle)]),
      savedGripColors: uniqueValues([...playerRows.map((row) => row.grip_color)]),
      showPublicRanking: true,
      queuePlayerOrder: [],
    });
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

  const merged: AppData = migrateAppData({
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
    queuePlayerOrder: stateRow.queue_player_order ?? [],
  });

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

/**
 * Persists to Supabase. `persistenceGenAtSave` must be the `persistenceGen` in the local mirror
 * right after the same snapshot was written to the mirror (see `writeOptimisticMirror`). On
 * success we advance `savedGen` only to that value and keep the latest `app` from the mirror so
 * we never clobber newer in-memory / UI state with a stale saved payload.
 */
export const saveOpenPlayData = async (data: AppData, persistenceGenAtSave: number): Promise<void> => {
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
        show_public_ranking: data.showPublicRanking,
        queue_player_order: data.queuePlayerOrder,
        updated_at: new Date().toISOString(),
      })
      .select('updated_at')
      .single(),
  ]);

  const errors = [playersResult.error, stateResult.error].filter(
    (e): e is NonNullable<typeof playersResult.error> => Boolean(e),
  );
  if (errors.length > 0) {
    const message = errors
      .map((e) =>
        [e.message, (e as { details?: string }).details, (e as { hint?: string }).hint, e.code]
          .filter(Boolean)
          .join(' | '),
      )
      .join('; ');
    throw new Error(message);
  }

  const serverUpdatedAt =
    stateResult.data && typeof stateResult.data === 'object' && 'updated_at' in stateResult.data
      ? String((stateResult.data as { updated_at: string }).updated_at)
      : new Date().toISOString();

  const current = readMirrorEnvelope();
  if (!current) {
    const merged = migrateAppData(data);
    writeMirrorEnvelope({
      v: MIRROR_VERSION,
      app: merged,
      persistenceGen: Math.max(persistenceGenAtSave, 1),
      savedGen: persistenceGenAtSave,
      serverUpdatedAt,
    });
    return;
  }

  writeMirrorEnvelope({
    v: MIRROR_VERSION,
    app: current.app,
    persistenceGen: current.persistenceGen,
    savedGen: persistenceGenAtSave,
    serverUpdatedAt,
  });
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
