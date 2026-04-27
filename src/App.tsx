import {
  CheckCircle2,
  Clock3,
  Database,
  GripVertical,
  Plus,
  RotateCcw,
  Settings,
  Trophy,
  UsersRound,
  X,
} from 'lucide-react';
import {
  DragEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { flushSync } from 'react-dom';
import { logUserInteraction, type UserActionLogStatus } from './actionLog';
import {
  ADMIN_UNLOCK_KEY,
  DEVICE_REGISTRATION_KEY,
  GRIP_COLOR_OPTIONS,
  LEVELS,
  PADDLE_OPTIONS,
  getLevelRange,
  normalizePhoneDigits,
} from './constants';
import {
  createGroupsFromAvailablePlayers,
  formatElapsedTime,
  getAvailablePlayers,
  getElapsedSeconds,
} from './scheduler';
import {
  appendSelfRegisteredPlayer,
  hasSupabaseConfig,
  loadOpenPlayData,
  migrateAppData,
  saveOpenPlayData,
  subscribeOpenPlayRealtime,
  syncMirrorToApp,
  writeOptimisticMirror,
} from './storage';
import type {
  AppData,
  Court,
  CourtStatus,
  DragData,
  Match,
  Player,
  PlayerForm,
  SavedPlayer,
} from './types';
import './styles.css';

const DEFAULT_COURTS = 4;
const DEFAULT_MAX_MINUTES = 15;
const SAVE_DEBOUNCE_MS = 500;
const BRAND_FOOTER =
  'Beta Version | Dev in Progress | Open Play Queue for Camsur Pickleball Club by Dev.Onich';

const normalizePlayerName = (name: string) => name.trim().toLowerCase();

const persistenceLabel = (): 'supabase' | 'local' =>
  hasSupabaseConfig ? 'supabase' : 'local';

const getInitialViewParam = () => new URLSearchParams(window.location.search).get('view');
const isLockedPublicView = (() => {
  const param = getInitialViewParam();
  return param === 'player' || param === 'standings';
})();
const isRegisterView = getInitialViewParam() === 'register';

const getExpectedAdminAccessCode = (): string =>
  (import.meta.env.VITE_ADMIN_ACCESS_CODE as string | undefined)?.trim() ?? '';

const resetCourtsKeepingLayout = (courtList: Court[]): Court[] =>
  courtList.map((court) => ({
    ...court,
    status: 'ready',
    match: null,
  }));

interface BulkPlayerRow extends PlayerForm {
  rowId: string;
  savedPlayerId: string;
  playerId: string | null;
}

const BULK_MIN_ROWS = 10;

const todayKey = () => new Date().toISOString().slice(0, 10);

const createBulkRow = (): BulkPlayerRow => ({
  rowId: crypto.randomUUID(),
  name: '',
  level: 3,
  ...getLevelRange(3),
  paddle: '',
  gripColor: '',
  preferredPartnerName: '',
  phone: '',
  savedPlayerId: '',
  playerId: null,
  arrivalStatus: 'present',
});

/** At least 10 rows; if the last has a name, one empty row after; drop duplicate trailing empties. */
const normalizeBulkRowsState = (rows: BulkPlayerRow[]): BulkPlayerRow[] => {
  const out = [...rows];
  while (out.length > BULK_MIN_ROWS && !out[out.length - 1]!.name.trim() && !out[out.length - 2]!.name.trim()) {
    out.pop();
  }
  while (out.length < BULK_MIN_ROWS) {
    out.push(createBulkRow());
  }
  if (out[out.length - 1]!.name.trim()) {
    out.push(createBulkRow());
  }
  return out;
};

const createInitialBulkRows = () => normalizeBulkRowsState([]);

const buildBulkRowsFromPlayers = (players: Player[]): BulkPlayerRow[] => {
  const dataRows: BulkPlayerRow[] = players.map((player) => ({
    ...createBulkRow(),
    rowId: crypto.randomUUID(),
    playerId: player.id,
    name: player.name,
    level: player.level,
    minLevel: player.minLevel,
    maxLevel: player.maxLevel,
    paddle: player.paddle,
    gripColor: player.gripColor,
    preferredPartnerName: player.preferredPartnerName,
    phone: player.phone ?? '',
    arrivalStatus: player.arrivalStatus,
    savedPlayerId: player.persistentId ?? '',
  }));
  return normalizeBulkRowsState(dataRows);
};

const createInitialCourts = (): Court[] =>
  Array.from({ length: DEFAULT_COURTS }, (_, index) => ({
    id: `court-${index + 1}`,
    name: `Court ${index + 1}`,
    minLevel: Math.max(1, index + 1),
    maxLevel: Math.min(4, index + 2),
    status: 'ready',
    match: null,
  }));

const createAppData = (): AppData => ({
  sessionDate: todayKey(),
  players: [],
  courts: createInitialCourts(),
  maxMinutes: DEFAULT_MAX_MINUTES,
  savedPlayers: [],
  savedPaddles: PADDLE_OPTIONS,
  savedGripColors: GRIP_COLOR_OPTIONS,
  showPublicRanking: true,
  queuePlayerOrder: [],
});

const mergeSavedAfterMatch = (
  prev: SavedPlayer | undefined,
  sessionPlayer: Player,
  isWinner: boolean,
): SavedPlayer => {
  const id = prev?.id ?? sessionPlayer.persistentId ?? crypto.randomUUID();
  const base =
    prev ?? {
      id,
      name: sessionPlayer.name,
      level: sessionPlayer.level,
      minLevel: sessionPlayer.minLevel,
      maxLevel: sessionPlayer.maxLevel,
      paddle: sessionPlayer.paddle,
      gripColor: sessionPlayer.gripColor,
      preferredPartnerName: sessionPlayer.preferredPartnerName,
      phone: sessionPlayer.phone ?? '',
      wins: 0,
      losses: 0,
      gamesPlayed: 0,
      rankingScore: 0,
    };

  return {
    ...base,
    id,
    name: sessionPlayer.name,
    level: sessionPlayer.level,
    minLevel: sessionPlayer.minLevel,
    maxLevel: sessionPlayer.maxLevel,
    paddle: sessionPlayer.paddle,
    gripColor: sessionPlayer.gripColor,
    preferredPartnerName: sessionPlayer.preferredPartnerName,
    phone: (sessionPlayer.phone ?? '').trim() || base.phone,
    wins: base.wins + (isWinner ? 1 : 0),
    losses: base.losses + (isWinner ? 0 : 1),
    gamesPlayed: base.gamesPlayed + 1,
    rankingScore: base.rankingScore + (isWinner ? 3 : 0),
  };
};

/** Today’s session: wins, losses, games played (no ranking score in UI). */
const sessionDayRecordLabel = (player: Player) =>
  `${player.wins}W-${player.losses}L · ${player.gamesPlayed} games today`;

const groupClassName = (canUseSelectedCourt: boolean) =>
  canUseSelectedCourt ? 'queue-card compatible' : 'queue-card';

const mergeOptions = (baseOptions: string[], newOptions: string[]) =>
  Array.from(
    new Set([...baseOptions, ...newOptions].map((option) => option.trim()).filter(Boolean)),
  ).sort((first, second) => first.localeCompare(second));

const upsertSavedPlayer = (
  savedPlayers: SavedPlayer[],
  incomingPlayer: SavedPlayer,
): SavedPlayer[] => {
  const incomingName = incomingPlayer.name.toLowerCase();
  const incomingPhone = normalizePhoneDigits(incomingPlayer.phone);
  const existingIndex = savedPlayers.findIndex((player) => {
    if (player.id === incomingPlayer.id) {
      return true;
    }
    if (player.name.toLowerCase() === incomingName) {
      return true;
    }
    if (incomingPhone && normalizePhoneDigits(player.phone) === incomingPhone) {
      return true;
    }
    return false;
  });

  if (existingIndex < 0) {
    return [...savedPlayers, incomingPlayer].sort((first, second) =>
      first.name.localeCompare(second.name),
    );
  }

  return savedPlayers.map((player, index) =>
    index === existingIndex ? { ...player, ...incomingPlayer, id: player.id } : player,
  );
};

/**
 * Links session players to `public.players` rows. Without a `persistentId`, Supabase upserts skip
 * that person even though they appear in open play JSON — so they look "not saved" in the DB.
 */
const ensureSavedProfilesForSession = (
  sessionPlayers: Player[],
  currentSaved: SavedPlayer[],
): { players: Player[]; savedPlayers: SavedPlayer[] } => {
  let saved = currentSaved;
  const players = sessionPlayers.map((p) => {
    if (p.persistentId) {
      return p;
    }
    const nameKey = normalizePlayerName(p.name);
    const phoneDigits = normalizePhoneDigits(p.phone);
    const existing = saved.find((s) => {
      if (normalizePlayerName(s.name) !== nameKey) {
        return false;
      }
      if (!phoneDigits) {
        return true;
      }
      return normalizePhoneDigits(s.phone) === phoneDigits;
    });
    if (existing) {
      return { ...p, persistentId: existing.id };
    }
    const incoming: SavedPlayer = {
      id: crypto.randomUUID(),
      name: p.name.trim(),
      level: p.level,
      minLevel: p.minLevel,
      maxLevel: p.maxLevel,
      paddle: p.paddle,
      gripColor: p.gripColor,
      preferredPartnerName: p.preferredPartnerName,
      phone: p.phone,
      wins: 0,
      losses: 0,
      gamesPlayed: 0,
      rankingScore: 0,
    };
    saved = upsertSavedPlayer(saved, incoming);
    const linked =
      saved.find((s) => s.id === incoming.id) ??
      saved.find(
        (s) =>
          normalizePlayerName(s.name) === nameKey &&
          (!phoneDigits || normalizePhoneDigits(s.phone) === phoneDigits),
      );
    return { ...p, persistentId: linked?.id ?? incoming.id };
  });
  return { players, savedPlayers: saved };
};

const getPlayerIdsInMatch = (match: Match) => match.players.map((player) => player.id);

const isPlayerCompatibleWithCourt = (): boolean => true;

const replacePlayerInMatch = (
  match: Match,
  removedPlayerId: string,
  replacementPlayer: Player,
): Match => ({
  ...match,
  players: match.players.map((player) =>
    player.id === removedPlayerId ? replacementPlayer : player,
  ),
  winnerIds: match.winnerIds.filter((winnerId) => winnerId !== removedPlayerId),
});

export default function App() {
  const pagePath = window.location.pathname;
  const playerQueueUrl = `${pagePath}?view=player`;
  const standingsUrl = `${pagePath}?view=standings`;
  const registerUrl = `${pagePath}?view=register`;
  const initialViewParam = getInitialViewParam();
  const [players, setPlayers] = useState<Player[]>([]);
  const [savedPlayers, setSavedPlayers] = useState<SavedPlayer[]>([]);
  const [paddleOptions, setPaddleOptions] = useState(PADDLE_OPTIONS);
  const [gripColorOptions, setGripColorOptions] = useState(GRIP_COLOR_OPTIONS);
  const [courts, setCourts] = useState<Court[]>(createInitialCourts);
  const [bulkRows, setBulkRows] = useState<BulkPlayerRow[]>(() => createInitialBulkRows());
  const [isBulkModalOpen, setIsBulkModalOpen] = useState(false);
  const [isSettingsModalOpen, setIsSettingsModalOpen] = useState(false);
  const [maxMinutes, setMaxMinutes] = useState(DEFAULT_MAX_MINUTES);
  const [selectedCourtId, setSelectedCourtId] = useState('court-1');
  const [sessionDate, setSessionDate] = useState(todayKey);
  const [saveStatus, setSaveStatus] = useState('Loading saved players...');
  const [viewMode, setViewMode] = useState<'admin' | 'player'>(() =>
    isLockedPublicView ? 'player' : (initialViewParam === 'player' ? 'player' : 'admin'),
  );
  const [publicPage, setPublicPage] = useState<'queue' | 'standings'>(() =>
    initialViewParam === 'standings' ? 'standings' : 'queue',
  );
  const [bulkAddError, setBulkAddError] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const savePromiseRef = useRef<Promise<void> | null>(null);
  const flushSaveRef = useRef<(trigger?: string) => Promise<void>>(async () => {});
  /** When true, the next layout pass is from `applyLoad` (network), not a local admin edit. */
  const applyLoadInProgressRef = useRef(false);
  const [now, setNow] = useState(0);
  const [showPublicRanking, setShowPublicRanking] = useState(true);
  const [adminUnlocked, setAdminUnlocked] = useState(
    () => sessionStorage.getItem(ADMIN_UNLOCK_KEY) === '1',
  );
  const [passcodeInput, setPasscodeInput] = useState('');
  const [passcodeError, setPasscodeError] = useState('');
  const [publicStandingsScope, setPublicStandingsScope] = useState<'today' | 'overall'>('today');
  const [registerName, setRegisterName] = useState('');
  const [registerPhone, setRegisterPhone] = useState('');
  const [registerLevel, setRegisterLevel] = useState(3);
  const [registerError, setRegisterError] = useState('');
  const [registerDone, setRegisterDone] = useState('');
  /** Manual order of waiting `present` players for standby groups (swap / reorder). */
  const [queueManualOrder, setQueueManualOrder] = useState<string[]>([]);
  const [publicPhoneInput, setPublicPhoneInput] = useState('');
  const [publicLookupMessage, setPublicLookupMessage] = useState('');

  const logUserAction = useCallback(
    (
      action: string,
      trigger: string,
      status: UserActionLogStatus,
      options?: { detail?: Record<string, unknown>; throttleKey?: string },
    ) => {
      logUserInteraction(
        {
          action,
          trigger,
          status,
          persistence: persistenceLabel(),
          detail: options?.detail,
        },
        options?.throttleKey ? { throttleKey: options.throttleKey } : undefined,
      );
    },
    [],
  );

  const buildAppData = useCallback(
    (): AppData => ({
      sessionDate,
      players,
      courts,
      maxMinutes,
      savedPlayers,
      savedPaddles: paddleOptions,
      savedGripColors: gripColorOptions,
      showPublicRanking,
      queuePlayerOrder: queueManualOrder,
    }),
    [
      courts,
      gripColorOptions,
      maxMinutes,
      paddleOptions,
      players,
      queueManualOrder,
      savedPlayers,
      sessionDate,
      showPublicRanking,
    ],
  );

  const buildAppDataRef = useRef(buildAppData);
  buildAppDataRef.current = buildAppData;

  const flushSave = useCallback(
    async (saveTrigger = 'debounced_state_change') => {
      if (isLockedPublicView) {
        return;
      }

      // Wait for any in-flight save, then always persist the latest snapshot (never drop debounced
      // updates that arrived while a previous save was running).
      let pendingSave = savePromiseRef.current;
      while (pendingSave) {
        await pendingSave;
        pendingSave = savePromiseRef.current;
      }

      setIsSaving(true);

      const snapshot = buildAppData();
      writeOptimisticMirror(snapshot);

      const promise = saveOpenPlayData(snapshot)
        .then(() => {
          setSaveStatus(hasSupabaseConfig ? 'Connected to Supabase' : 'Local-only (this browser)');
        })
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          setSaveStatus('Save failed');
          if (saveTrigger !== 'debounced_state_change') {
            console.error('[OpenQueue] saveOpenPlayData failed', error);
            logUserInteraction({
              action: 'save_open_play',
              trigger: saveTrigger,
              status: 'failed',
              persistence: persistenceLabel(),
              error: message,
            });
          }
        })
        .finally(() => {
          setIsSaving(false);
          savePromiseRef.current = null;
        });

      savePromiseRef.current = promise;
      await promise;
    },
    [buildAppData],
  );

  // Keep this ref in sync during render so timers never call a stale save closure.
  // eslint-disable-next-line react-hooks/refs -- useEffect runs after paint; setTimeout(0) can fire first and would call a stale flushSave without this.
  flushSaveRef.current = flushSave;

  /** Run persist after React applies batched state from the current event (avoids stale saves). */
  const schedulePersistAfterMutation = useCallback((saveTrigger: string) => {
    queueMicrotask(() => {
      void flushSaveRef.current(saveTrigger);
    });
  }, []);

  /** Commit pending state synchronously, then persist on the next microtask (avoids stale buildAppData when saving right after setState). */
  const persistAfterFlushSync = useCallback((saveTrigger: string, commit: () => void) => {
    flushSync(commit);
    queueMicrotask(() => {
      void flushSaveRef.current(saveTrigger);
    });
  }, []);

  const goToViewMode = (mode: 'admin' | 'player') => {
    if (isLockedPublicView) {
      return;
    }
    logUserAction('switch_view_mode', `header.view_${mode}`, 'applied', { detail: { mode } });
    setViewMode(mode);
  };

  const setPublicViewAndUrl = (page: 'queue' | 'standings') => {
    logUserAction('public_kiosk_page', `kiosk.${page}`, 'applied', { detail: { page } });
    setPublicPage(page);
    const view = page === 'standings' ? 'standings' : 'player';
    window.history.replaceState(null, '', `${pagePath}?view=${view}`);
  };

  const fullResetToday = async () => {
    if (
      !window.confirm(
        'Remove every player from today’s session and reset all courts? Lifetime saved profiles are kept.',
      )
    ) {
      return;
    }
    if (isSaving) {
      return;
    }
    logUserAction('full_reset_today', 'admin.full_reset', 'applied');
    setPlayers([]);
    setQueueManualOrder([]);
    setCourts((c) => resetCourtsKeepingLayout(c));
    setBulkRows(createInitialBulkRows());
    await flushSave('full_reset_today');
  };

  const clearAllTodaySession = async () => {
    if (
      !window.confirm(
        'Clear all courts, reset today’s in-session stats (W/L, games) for everyone still listed, and clear standby order? Saved player profiles in the database are not deleted.',
      )
    ) {
      return;
    }
    if (isSaving) {
      return;
    }
    logUserAction('clear_all_today', 'admin.clear_all_today', 'applied');
    const nextPlayers = players.map((p) => ({
      ...p,
      wins: 0,
      losses: 0,
      gamesPlayed: 0,
      waitScore: 0,
      rankingScore: 0,
      lastResult: null,
      lockedGroupId: null,
      arrivalStatus: 'present' as const,
      joinedQueueAt: Date.now(),
    }));
    setPlayers(nextPlayers);
    setBulkRows(buildBulkRowsFromPlayers(nextPlayers));
    setQueueManualOrder([]);
    setCourts((c) => resetCourtsKeepingLayout(c));
    await flushSave('clear_all_today');
  };

  const tryAdminUnlock = () => {
    const expected = getExpectedAdminAccessCode();
    if (!expected) {
      setPasscodeError('Admin access is not configured. Set VITE_ADMIN_ACCESS_CODE for this build (see README).');
      return;
    }
    if (passcodeInput.trim() === expected) {
      sessionStorage.setItem(ADMIN_UNLOCK_KEY, '1');
      setAdminUnlocked(true);
      setPasscodeError('');
      setPasscodeInput('');
    } else {
      setPasscodeError('Incorrect access code.');
    }
  };

  const lockAdmin = () => {
    sessionStorage.removeItem(ADMIN_UNLOCK_KEY);
    setAdminUnlocked(false);
    setPasscodeInput('');
    setPasscodeError('');
  };

  const submitSelfRegister = async () => {
    setRegisterError('');
    setRegisterDone('');
    const name = registerName.trim();
    if (!name) {
      setRegisterError('Please enter your name.');
      return;
    }
    const phoneDigits = normalizePhoneDigits(registerPhone);
    if (!phoneDigits) {
      setRegisterError('Please enter a phone number so you can use the public queue view.');
      return;
    }
    const range = getLevelRange(registerLevel);
    const newPlayer: Player = {
      id: crypto.randomUUID(),
      persistentId: null,
      name,
      level: registerLevel,
      minLevel: range.minLevel,
      maxLevel: range.maxLevel,
      paddle: '',
      gripColor: '',
      preferredPartnerName: '',
      phone: registerPhone.trim(),
      partnerId: null,
      arrivalStatus: 'present',
      wins: 0,
      losses: 0,
      gamesPlayed: 0,
      waitScore: 0,
      lastResult: null,
      lockedGroupId: null,
      rankingScore: 0,
      joinedQueueAt: Date.now(),
    };

    const result = await appendSelfRegisteredPlayer(newPlayer);
    if (!result.ok) {
      setRegisterError(result.error);
      return;
    }
    const data = await loadOpenPlayData();
    const sessionKey = data?.sessionDate ?? todayKey();
    localStorage.setItem(
      DEVICE_REGISTRATION_KEY,
      JSON.stringify({ playerId: result.playerId, sessionDate: sessionKey }),
    );
    setRegisterDone(
      `You are on the list for ${sessionKey}. Open the queue link on this device to track your spot.`,
    );
    setRegisterName('');
    setRegisterPhone('');
    setRegisterLevel(3);
  };

  const applyLoad = useCallback((data: AppData | null, kind: 'initial' | 'sync') => {
    applyLoadInProgressRef.current = true;
    const appData = migrateAppData(data ?? createAppData());
    setSessionDate(appData.sessionDate || todayKey());
    setPlayers(appData.players ?? []);
    setCourts(appData.courts?.length ? appData.courts : createInitialCourts());
    setMaxMinutes(appData.maxMinutes ?? DEFAULT_MAX_MINUTES);
    setSavedPlayers(appData.savedPlayers ?? []);
    setPaddleOptions(mergeOptions(PADDLE_OPTIONS, appData.savedPaddles ?? []));
    setGripColorOptions(mergeOptions(GRIP_COLOR_OPTIONS, appData.savedGripColors ?? []));
    setShowPublicRanking(appData.showPublicRanking !== false);
    setQueueManualOrder(appData.queuePlayerOrder ?? []);
    if (kind === 'initial') {
      setSaveStatus(hasSupabaseConfig ? 'Connected to Supabase' : 'Local-only (this browser)');
    } else {
      setSaveStatus(hasSupabaseConfig ? 'Connected to Supabase' : 'Local-only (this browser)');
    }
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    let mounted = true;
    void loadOpenPlayData().then((data) => {
      if (!mounted) {
        return;
      }
      applyLoad(data, 'initial');
    });

    return () => {
      mounted = false;
    };
  }, [applyLoad]);

  useEffect(() => {
    if (!hasSupabaseConfig) {
      return;
    }
    return subscribeOpenPlayRealtime(() => {
      void loadOpenPlayData().then((data) => {
        applyLoad(data, 'sync');
      });
    });
  }, [applyLoad]);

  useEffect(() => {
    let timer = 0;
    const needsPoll =
      !hasSupabaseConfig &&
      (isLockedPublicView || isRegisterView || viewMode === 'player');
    if (hasSupabaseConfig) {
      timer = window.setInterval(() => {
        void loadOpenPlayData().then((data) => {
          applyLoad(data, 'sync');
        });
      }, 25000);
    } else if (needsPoll) {
      timer = window.setInterval(() => {
        void loadOpenPlayData().then((data) => {
          applyLoad(data, 'sync');
        });
      }, 5000);
    }
    return () => {
      if (timer) {
        window.clearInterval(timer);
      }
    };
  }, [applyLoad, viewMode]);

  useEffect(() => {
    const ids = new Set(players.map((p) => p.id));
    setQueueManualOrder((prev) => prev.filter((id) => ids.has(id)));
  }, [players]);

  useEffect(() => {
    if (!isLockedPublicView) {
      return;
    }
    const params = new URLSearchParams(window.location.search);
    const phoneParam = params.get('phone');
    if (!phoneParam) {
      return;
    }
    setPublicPhoneInput(phoneParam);
    const digits = normalizePhoneDigits(phoneParam);
    if (!digits) {
      return;
    }
    const found = players.find((pl) => normalizePhoneDigits(pl.phone) === digits);
    if (found) {
      localStorage.setItem(
        DEVICE_REGISTRATION_KEY,
        JSON.stringify({ playerId: found.id, sessionDate }),
      );
      setPublicLookupMessage('This device is now linked to your place in the queue for today.');
    } else {
      setPublicLookupMessage('That phone is not on today’s list yet. Register first.');
    }
  }, [isLockedPublicView, players, sessionDate]);

  // Keep the Supabase mirror in sync on every local commit (layout) so fetches can skip
  // clobbering with stale server rows. Do not bump persistenceGen after `applyLoad` — that
  // would look like an unsaved draft and block cross-client updates.
  useLayoutEffect(() => {
    if (isLockedPublicView || isRegisterView) {
      return;
    }
    const snapshot = buildAppData();
    if (applyLoadInProgressRef.current) {
      applyLoadInProgressRef.current = false;
      syncMirrorToApp(snapshot);
      return;
    }
    writeOptimisticMirror(snapshot);
  }, [courts, gripColorOptions, maxMinutes, paddleOptions, players, queueManualOrder, savedPlayers, sessionDate, showPublicRanking, buildAppData]);

  useEffect(() => {
    if (isLockedPublicView || isRegisterView) {
      return;
    }
    const saveTimer = window.setTimeout(() => {
      void flushSave('debounced_state_change');
    }, SAVE_DEBOUNCE_MS);

    return () => window.clearTimeout(saveTimer);
  }, [
    courts,
    gripColorOptions,
    maxMinutes,
    paddleOptions,
    players,
    queueManualOrder,
    savedPlayers,
    sessionDate,
    showPublicRanking,
    flushSave,
  ]);

  const availablePlayers = useMemo(
    () => getAvailablePlayers(players),
    [players],
  );

  const waitingPlayers = availablePlayers;

  const orderedAvailablePlayers = useMemo(() => {
    const waiting = getAvailablePlayers(players);
    const byId = new Map(waiting.map((p) => [p.id, p]));
    const listed = queueManualOrder
      .map((id) => byId.get(id))
      .filter((p): p is Player => Boolean(p));
    const listedIds = new Set(listed.map((p) => p.id));
    const rest = waiting.filter((p) => !listedIds.has(p.id));
    return [...listed, ...rest];
  }, [players, queueManualOrder]);

  const queueGroups = useMemo(
    () => createGroupsFromAvailablePlayers(orderedAvailablePlayers, courts),
    [orderedAvailablePlayers, courts],
  );

  const nextGroups = useMemo(
    () => queueGroups.filter((g) => g.playerIds.length > 0).slice(0, 4),
    [queueGroups],
  );
  const nextGroupedIds = useMemo(
    () => new Set(nextGroups.flatMap((group) => group.playerIds)),
    [nextGroups],
  );
  const fifoQueueOrder = useMemo(() => {
    const neutral: Player[] = [];
    const winners: Player[] = [];
    const losers: Player[] = [];

    for (const player of orderedAvailablePlayers) {
      if (player.gamesPlayed === 0 || player.lastResult === null) {
        neutral.push(player);
        continue;
      }
      if (player.lastResult === 'won') {
        winners.push(player);
        continue;
      }
      losers.push(player);
    }

    return [...neutral, ...winners, ...losers];
  }, [orderedAvailablePlayers]);

  const upNextPlayers = useMemo(
    () => fifoQueueOrder.filter((player) => !nextGroupedIds.has(player.id)),
    [fifoQueueOrder, nextGroupedIds],
  );

  const selectedCourt = courts.find((court) => court.id === selectedCourtId);

  const { rosterActive, rosterInactive } = useMemo(() => {
    const active: Player[] = [];
    const inactive: Player[] = [];
    for (const player of players) {
      if (player.arrivalStatus === 'left' || player.arrivalStatus === 'away') {
        inactive.push(player);
      } else {
        active.push(player);
      }
    }
    return { rosterActive: active, rosterInactive: inactive };
  }, [players]);

  const standingsRowsToday = useMemo(
    () =>
      [...players].sort((a, b) => {
        const byRank = b.rankingScore - a.rankingScore;
        if (byRank !== 0) {
          return byRank;
        }
        return a.name.localeCompare(b.name);
      }),
    [players],
  );

  const standingsRowsOverall = useMemo(
    () =>
      [...savedPlayers].sort((a, b) => {
        const byRank = b.rankingScore - a.rankingScore;
        if (byRank !== 0) {
          return byRank;
        }
        return a.name.localeCompare(b.name);
      }),
    [savedPlayers],
  );

  const updateBulkRow = (
    rowId: string,
    updates: Partial<BulkPlayerRow>,
  ) => {
    setBulkRows((currentRows) => {
      const next = currentRows.map((row) => (row.rowId === rowId ? { ...row, ...updates } : row));
      return normalizeBulkRowsState(next);
    });
  };

  const updateBulkName = (rowId: string, name: string) => {
    const savedPlayer = savedPlayers.find(
      (player) => player.name.toLowerCase() === name.trim().toLowerCase(),
    );

    if (!savedPlayer) {
      updateBulkRow(rowId, { name, savedPlayerId: '' });
      return;
    }

    updateBulkRow(rowId, {
      savedPlayerId: savedPlayer.id,
      name: savedPlayer.name,
      level: savedPlayer.level,
      minLevel: savedPlayer.minLevel,
      maxLevel: savedPlayer.maxLevel,
      paddle: savedPlayer.paddle,
      gripColor: '',
      preferredPartnerName: '',
      phone: savedPlayer.phone ?? '',
    });
  };

  const updateBulkLevel = (rowId: string, level: number) => {
    updateBulkRow(rowId, { level, ...getLevelRange(level) });
  };

  const resetBulkRows = () => {
    setBulkRows(createInitialBulkRows());
  };

  const clearBulkRow = (rowId: string) => {
    logUserAction('bulk_clear_row', 'bulk_modal.clear_row', 'applied', { detail: { rowId } });
    persistAfterFlushSync('bulk_clear_row', () => {
      setBulkRows((currentRows) => {
        const next = currentRows.filter((row) => row.rowId !== rowId);
        return normalizeBulkRowsState(next);
      });
    });
  };

  const handleBulkAdd = () => {
    logUserAction('bulk_update_players', 'bulk_modal.update_players', 'started', {
      detail: { namedRowCount: bulkRows.filter((row) => row.name.trim()).length },
    });
    setBulkAddError('');

    const rawNamedRows = bulkRows.filter((row) => row.name.trim());
    const uniqueRows: BulkPlayerRow[] = [];
    const seenInForm = new Set<string>();
    const duplicateInForm: string[] = [];

    for (const row of rawNamedRows) {
      const key = normalizePlayerName(row.name);
      if (seenInForm.has(key)) {
        duplicateInForm.push(row.name.trim());
        continue;
      }
      seenInForm.add(key);
      uniqueRows.push(row);
    }

    const existingNames = new Set(players.map((player) => normalizePlayerName(player.name)));
    const alreadyInRoster: string[] = [];
    const relinkedRows = uniqueRows.map((row) => {
      const key = normalizePlayerName(row.name);
      if (row.playerId) {
        return row;
      }
      const sessionMatch = players.find((pl) => normalizePlayerName(pl.name) === key);
      return sessionMatch ? { ...row, playerId: sessionMatch.id } : row;
    });
    const rowsToApply = relinkedRows.filter((row) => {
      const key = normalizePlayerName(row.name);
      if (existingNames.has(key) && !row.playerId) {
        alreadyInRoster.push(row.name.trim());
        return false;
      }
      return true;
    });

    const editedPlayers = rowsToApply.map((row) => {
      const existing = row.playerId ? players.find((player) => player.id === row.playerId) : null;
      const savedPlayer = savedPlayers.find((player) => player.id === row.savedPlayerId);

      if (existing) {
        return {
          ...existing,
          name: row.name.trim(),
          level: Number(row.level),
          minLevel: Number(row.minLevel),
          maxLevel: Number(row.maxLevel),
          paddle: row.paddle.trim(),
          preferredPartnerName: row.preferredPartnerName.trim(),
          phone: row.phone.trim(),
        } satisfies Player;
      }

      return {
        id: crypto.randomUUID(),
        persistentId: savedPlayer?.id ?? null,
        name: row.name.trim(),
        level: Number(row.level),
        minLevel: Number(row.minLevel),
        maxLevel: Number(row.maxLevel),
        paddle: row.paddle.trim(),
        gripColor: '',
        preferredPartnerName: row.preferredPartnerName.trim(),
        phone: row.phone.trim(),
        partnerId: null,
        arrivalStatus: 'present',
        wins: 0,
        losses: 0,
        gamesPlayed: 0,
        waitScore: 0,
        lastResult: null,
        lockedGroupId: null,
        rankingScore: 0,
        joinedQueueAt: Date.now(),
      } satisfies Player;
    });

    const existingIdToName = new Map(
      players.map((player) => [player.id, normalizePlayerName(player.name)] as const),
    );

    for (const player of editedPlayers) {
      const otherName = Array.from(existingIdToName.entries()).find(
        ([id, name]) => id !== player.id && name === normalizePlayerName(player.name),
      );
      if (otherName) {
        setBulkAddError(`Duplicate name: ${player.name}. Each player name must be unique.`);
        logUserAction('bulk_update_players', 'bulk_modal.update_players', 'failed', {
          detail: { reason: 'duplicate_name', playerName: player.name },
        });
        return;
      }
    }

    for (const player of editedPlayers) {
      const digits = normalizePhoneDigits(player.phone);
      if (!digits) {
        continue;
      }
      const otherPhone = editedPlayers.find(
        (p) => p.id !== player.id && normalizePhoneDigits(p.phone) === digits,
      );
      if (otherPhone) {
        setBulkAddError(
          `Duplicate phone on roster: ${player.name} and ${otherPhone.name}.`,
        );
        logUserAction('bulk_update_players', 'bulk_modal.update_players', 'failed', {
          detail: { reason: 'duplicate_phone' },
        });
        return;
      }
    }

    if (duplicateInForm.length || alreadyInRoster.length) {
      const parts: string[] = [];
      if (duplicateInForm.length) {
        parts.push(
          `Ignored duplicate rows: ${Array.from(new Set(duplicateInForm))
            .slice(0, 6)
            .join(', ')}${duplicateInForm.length > 6 ? '…' : ''}.`,
        );
      }
      if (alreadyInRoster.length) {
        parts.push(
          `Already added (skipped): ${Array.from(new Set(alreadyInRoster))
            .slice(0, 6)
            .join(', ')}${alreadyInRoster.length > 6 ? '…' : ''}.`,
        );
      }
      setBulkAddError(parts.join(' '));
    }

    const { players: sessionWithSaved, savedPlayers: mergedSaved } =
      ensureSavedProfilesForSession(editedPlayers, savedPlayers);

    logUserAction('bulk_update_players', 'bulk_modal.update_players', 'applied', {
      detail: { playerCount: sessionWithSaved.length },
    });
    persistAfterFlushSync('bulk_update_players', () => {
      setPlayers(sessionWithSaved);
      setSavedPlayers(mergedSaved);
      setBulkRows(buildBulkRowsFromPlayers(sessionWithSaved));
    });
  };

  const updatePlayer = (playerId: string, updates: Partial<Player>) => {
    setPlayers((currentPlayers) =>
      currentPlayers.map((player) => {
        if (player.id !== playerId) {
          return player;
        }
        let next: Player = { ...player, ...updates };
        if (updates.arrivalStatus !== undefined) {
          if (updates.arrivalStatus === 'present' && player.arrivalStatus !== 'present') {
            next = { ...next, joinedQueueAt: Date.now() };
          } else if (updates.arrivalStatus !== 'present') {
            next = { ...next, joinedQueueAt: null };
          }
        }
        return next;
      }),
    );
  };

  const onPlayerFieldChange = (playerId: string, field: string, updates: Partial<Player>) => {
    const current = players.find((p) => p.id === playerId);
    if (field === 'arrivalStatus' && current?.arrivalStatus === 'playing') {
      return;
    }
    logUserAction('player_field_edit', `player.${field}`, 'applied', {
      detail: { playerId, field },
      throttleKey: `player:${playerId}:${field}`,
    });
    updatePlayer(playerId, updates);
  };

  const updateCourtCount = (count: number) => {
    const safeCount = Math.max(1, count);
    logUserAction('settings_court_count', 'settings.court_count', 'applied', {
      detail: { count: safeCount },
    });

    setCourts((currentCourts) =>
      Array.from({ length: safeCount }, (_, index) => {
        const existing = currentCourts[index];
        return (
          existing ?? {
            id: `court-${index + 1}`,
            name: `Court ${index + 1}`,
            minLevel: 1,
            maxLevel: 4,
            status: 'ready',
            match: null,
          }
        );
      }),
    );
  };

  const updateCourt = (courtId: string, updates: Partial<Court>) => {
    setCourts((currentCourts) =>
      currentCourts.map((court) =>
        court.id === courtId ? { ...court, ...updates } : court,
      ),
    );
  };

  const onCourtFieldChange = (courtId: string, field: string, updates: Partial<Court>) => {
    logUserAction('court_field_edit', `court.${field}`, 'applied', {
      detail: { courtId, field },
      throttleKey: `court:${courtId}:${field}`,
    });
    updateCourt(courtId, updates);
  };

  const onBulkFieldChange = (
    rowId: string,
    field: string,
    apply: () => void,
  ) => {
    logUserAction('bulk_modal_field_edit', `bulk_row.${field}`, 'applied', {
      detail: { rowId, field },
      throttleKey: `bulk:${rowId}:${field}`,
    });
    apply();
  };

  const findReplacementPlayer = (
    court: Court,
    removedPlayerId: string,
  ): Player | undefined => {
    const currentPlayerIds = new Set(
      court.match?.players
        .map((player) => player.id)
        .filter((playerId) => playerId !== removedPlayerId) ?? [],
    );

    return availablePlayers.find(
      (player) =>
        !currentPlayerIds.has(player.id) && isPlayerCompatibleWithCourt(),
    );
  };

  const markPlayerLeft = (playerId: string) => {
    logUserAction('mark_player_left', 'roster.mark_left', 'applied', { detail: { playerId } });
    persistAfterFlushSync('mark_player_left', () => {
      updatePlayer(playerId, { arrivalStatus: 'left', joinedQueueAt: null });
    });
  };

  const buildMatch = (groupPlayerIds: string[]): Match | null => {
    const groupPlayers = groupPlayerIds
      .map((playerId) => players.find((player) => player.id === playerId))
      .filter((player): player is Player => Boolean(player));

    if (groupPlayers.length !== 4) {
      return null;
    }

    return {
      id: crypto.randomUUID(),
      startedAt: null,
      durationMinutes: maxMinutes,
      players: groupPlayers,
      winnerIds: [],
    };
  };

  const assignGroupToCourt = (courtId: string, groupPlayerIds: string[]) => {
    const match = buildMatch(groupPlayerIds);

    if (!match) {
      logUserAction('assign_group_to_court', 'court.assign_group', 'failed', {
        detail: { courtId, groupSize: groupPlayerIds.length, reason: 'need_four_players' },
      });
      return;
    }

    logUserAction('assign_group_to_court', 'court.assign_group', 'applied', {
      detail: { courtId, matchId: match.id, playerIds: groupPlayerIds },
    });

    flushSync(() => {
      setCourts((currentCourts) =>
        currentCourts.map((c) =>
          c.id === courtId
            ? {
                ...c,
                status: 'playing',
                match: { ...match, startedAt: Date.now() },
              }
            : c,
        ),
      );

      setPlayers((currentPlayers) =>
        currentPlayers.map((player) => {
          if (!groupPlayerIds.includes(player.id)) {
            return player;
          }

          return {
            ...player,
            arrivalStatus: 'playing',
            joinedQueueAt: null,
          };
        }),
      );
    });

    if (!isLockedPublicView && !isRegisterView) {
      writeOptimisticMirror(buildAppDataRef.current());
    }
    schedulePersistAfterMutation('assign_group_to_court');
  };

  const startMatch = (courtId: string) => {
    const court = courts.find((item) => item.id === courtId);
    const playerIds = court?.match ? getPlayerIdsInMatch(court.match) : [];

    logUserAction('start_match', 'court.start_timer', 'applied', {
      detail: { courtId, playerIds },
    });

    setCourts((currentCourts) =>
      currentCourts.map((court) =>
        court.id === courtId && court.match
          ? {
              ...court,
              status: 'playing',
              match: { ...court.match, startedAt: Date.now() },
            }
          : court,
      ),
    );

    setPlayers((currentPlayers) =>
      currentPlayers.map((player) =>
        playerIds.includes(player.id) ? { ...player, arrivalStatus: 'playing' } : player,
      ),
    );
    schedulePersistAfterMutation('start_match');
  };

  const toggleMatchWinner = (courtId: string, playerId: string) => {
    logUserAction('toggle_match_winner', 'court.toggle_winner', 'applied', {
      detail: { courtId, playerId },
    });

    setCourts((currentCourts) =>
      currentCourts.map((court) => {
        if (court.id !== courtId || !court.match) {
          return court;
        }

        const current = court.match.winnerIds;
        const winnerIds = current.includes(playerId)
          ? current.filter((winnerId) => winnerId !== playerId)
          : current.length >= 2
            ? current
            : [...current, playerId];

        return { ...court, match: { ...court.match, winnerIds } };
      }),
    );
    schedulePersistAfterMutation('toggle_match_winner');
  };

  const closeMatch = (courtId: string) => {
    const court = courts.find((item) => item.id === courtId);

    if (!court?.match) {
      logUserAction('close_match', 'court.save_results', 'skipped', {
        detail: { courtId, reason: 'no_match' },
      });
      return;
    }

    if (court.match.winnerIds.length !== 2) {
      logUserAction('close_match', 'court.save_results', 'skipped', {
        detail: { courtId, reason: 'need_two_winners' },
      });
      return;
    }

    logUserAction('close_match', 'court.save_results', 'applied', {
      detail: {
        courtId,
        winnerIds: court.match.winnerIds,
        playerIds: getPlayerIdsInMatch(court.match),
      },
    });

    const matchPlayerIds = getPlayerIdsInMatch(court.match);
    const winnerIds = new Set(court.match.winnerIds);
    const savedMutations: SavedPlayer[] = [];
    const sessionUpdates = new Map<string, Player>();

    for (const playerId of matchPlayerIds) {
      const player = players.find((p) => p.id === playerId);
      if (!player) {
        continue;
      }
      const isWinner = winnerIds.has(playerId);
      const prevProfile = player.persistentId
        ? savedPlayers.find((s) => s.id === player.persistentId)
        : undefined;
      const mergedSaved = mergeSavedAfterMatch(prevProfile, player, isWinner);
      savedMutations.push(mergedSaved);

      const updatedPlayer: Player = {
        ...player,
        persistentId: player.persistentId ?? mergedSaved.id,
        arrivalStatus: 'present',
        wins: player.wins + (isWinner ? 1 : 0),
        losses: player.losses + (isWinner ? 0 : 1),
        gamesPlayed: player.gamesPlayed + 1,
        waitScore: player.waitScore + (isWinner ? 2 : 1),
        rankingScore: player.rankingScore + (isWinner ? 3 : 0),
        lastResult: isWinner ? 'won' : 'lost',
        joinedQueueAt: Date.now(),
      };
      sessionUpdates.set(playerId, updatedPlayer);
    }

    setSavedPlayers((prevSaved) => {
      let next = prevSaved;
      for (const merged of savedMutations) {
        next = upsertSavedPlayer(next, merged);
      }
      return next;
    });

    const keptPlayers = players.filter((p) => !matchPlayerIds.includes(p.id));
    const returningWinners: Player[] = [];
    const returningLosers: Player[] = [];

    for (const playerId of matchPlayerIds) {
      const updated = sessionUpdates.get(playerId);
      if (!updated) {
        continue;
      }
      if (winnerIds.has(playerId)) {
        returningWinners.push(updated);
      } else {
        returningLosers.push(updated);
      }
    }

    const nextPlayers = [...keptPlayers, ...returningWinners, ...returningLosers];
    setPlayers(nextPlayers);
    setQueueManualOrder(nextPlayers.map((p) => p.id));

    updateCourt(courtId, { status: 'ready', match: null });
    schedulePersistAfterMutation('close_match');
  };

  const resetCourt = (courtId: string) => {
    const court = courts.find((item) => item.id === courtId);

    logUserAction('reset_court', 'court.reset', 'applied', {
      detail: { courtId, hadMatch: Boolean(court?.match) },
    });

    if (court?.match) {
      const playerIds = getPlayerIdsInMatch(court.match);

      setPlayers((currentPlayers) =>
        currentPlayers.map((player) =>
          playerIds.includes(player.id)
            ? { ...player, arrivalStatus: 'present', joinedQueueAt: Date.now() }
            : player,
        ),
      );
    }

    updateCourt(courtId, { status: 'ready', match: null });
    schedulePersistAfterMutation('reset_court');
  };

  const removeLoadedPlayer = (courtId: string, removedPlayerId: string) => {
    const court = courts.find((item) => item.id === courtId);

    if (!court?.match || court.status === 'playing') {
      logUserAction('remove_loaded_player', 'court.remove_and_fill', 'skipped', {
        detail: {
          courtId,
          removedPlayerId,
          reason: !court?.match ? 'no_match' : 'court_playing',
        },
      });
      return;
    }

    const replacement = findReplacementPlayer(court, removedPlayerId);

    if (!replacement) {
      logUserAction('remove_loaded_player', 'court.remove_and_fill', 'applied', {
        detail: { courtId, removedPlayerId, filledWith: null, clearedCourt: true },
      });
      setPlayers((currentPlayers) =>
        currentPlayers.map((player) =>
          player.id === removedPlayerId
            ? { ...player, arrivalStatus: 'away', joinedQueueAt: null }
            : player,
        ),
      );
      updateCourt(courtId, {
        status: 'ready',
        match: null,
      });
      schedulePersistAfterMutation('remove_loaded_player');
      return;
    }

    logUserAction('remove_loaded_player', 'court.remove_and_fill', 'applied', {
      detail: {
        courtId,
        removedPlayerId,
        filledWith: replacement.id,
        clearedCourt: false,
      },
    });

    const nextMatch = replacePlayerInMatch(court.match, removedPlayerId, replacement);

    setPlayers((currentPlayers) =>
      currentPlayers.map((player) => {
        if (player.id === removedPlayerId) {
          return { ...player, arrivalStatus: 'away', joinedQueueAt: null };
        }

        if (player.id === replacement.id) {
          return { ...player, arrivalStatus: 'assigned', joinedQueueAt: null };
        }

        return player;
      }),
    );
    updateCourt(courtId, { status: 'loaded', match: nextMatch });
    setSelectedCourtId(courtId);
    schedulePersistAfterMutation('remove_loaded_player');
  };

  const handleDragStart = (
    event: DragEvent<HTMLElement>,
    data: DragData,
  ) => {
    if (data.type === 'group') {
      logUserAction('drag_start_group', 'queue.drag_group', 'started', {
        detail: { groupId: data.groupId, playerIds: data.playerIds },
      });
    } else {
      logUserAction('drag_start_player', 'queue.drag_player', 'started', {
        detail: { playerId: data.playerId },
      });
    }
    event.dataTransfer.setData('application/json', JSON.stringify(data));
    event.dataTransfer.effectAllowed = 'move';
  };

  const handleCourtDrop = (
    event: DragEvent<HTMLElement>,
    courtId: string,
  ) => {
    event.preventDefault();
    const targetCourt = courts.find((c) => c.id === courtId);
    if (!targetCourt || targetCourt.match || targetCourt.status !== 'ready') {
      logUserAction('court_drop', 'court.drop', 'skipped', {
        detail: { courtId, reason: 'court_not_free' },
      });
      return;
    }
    let data: DragData;
    try {
      const rawData = event.dataTransfer.getData('application/json');
      data = JSON.parse(rawData) as DragData;
    } catch {
      logUserAction('court_drop', 'court.drop', 'failed', {
        detail: { courtId, reason: 'invalid_drag_payload' },
      });
      return;
    }

    if (data.type === 'group') {
      if (data.playerIds.length < 4) {
        logUserAction('court_drop', 'court.drop', 'skipped', {
          detail: { courtId, reason: 'incomplete_group' },
        });
        return;
      }
      assignGroupToCourt(courtId, data.playerIds);
      // assignGroupToCourt already schedules persist
      return;
    }

    logUserAction('select_court', 'court.drop_non_group', 'applied', { detail: { courtId } });
    setSelectedCourtId(courtId);
  };

  const handleQueueDrop = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    let data: DragData;
    try {
      const rawData = event.dataTransfer.getData('application/json');
      data = JSON.parse(rawData) as DragData;
    } catch {
      logUserAction('queue_drop', 'queue.drop', 'failed', {
        detail: { reason: 'invalid_drag_payload' },
      });
      return;
    }

    if (data.type !== 'player') {
      logUserAction('queue_drop', 'queue.drop', 'skipped', {
        detail: { dragType: data.type },
      });
      return;
    }

    logUserAction('return_player_to_queue', 'queue.drop_player', 'applied', {
      detail: { playerId: data.playerId },
    });

    setPlayers((currentPlayers) =>
      currentPlayers.map((player) =>
        player.id === data.playerId
          ? { ...player, arrivalStatus: 'present', joinedQueueAt: Date.now() }
          : player,
      ),
    );
    schedulePersistAfterMutation('return_player_to_queue');
  };

  const swapQueuePlayers = useCallback(
    (playerIdA: string, playerIdB: string) => {
      if (playerIdA === playerIdB) {
        return;
      }
      setQueueManualOrder((prev) => {
        const waiting = getAvailablePlayers(players);
        const base =
          prev.length > 0
            ? prev.filter((id) => waiting.some((p) => p.id === id))
            : waiting.map((p) => p.id);
        const i = base.indexOf(playerIdA);
        const j = base.indexOf(playerIdB);
        if (i < 0 || j < 0) {
          return prev;
        }
        const next = [...base];
        const tmp = next[i]!;
        next[i] = next[j]!;
        next[j] = tmp;
        return next;
      });
      schedulePersistAfterMutation('queue_reorder');
    },
    [players, schedulePersistAfterMutation],
  );

  const handleStandbyPlayerDrop = useCallback(
    (event: DragEvent<HTMLElement>, targetPlayerId: string) => {
      event.preventDefault();
      event.stopPropagation();
      let data: DragData;
      try {
        const rawData = event.dataTransfer.getData('application/json');
        data = JSON.parse(rawData) as DragData;
      } catch {
        return;
      }
      if (data.type !== 'player' || data.playerId === targetPlayerId) {
        return;
      }
      const dragging = players.find((p) => p.id === data.playerId);
      const target = players.find((p) => p.id === targetPlayerId);
      if (
        !dragging ||
        !target ||
        dragging.arrivalStatus !== 'present' ||
        target.arrivalStatus !== 'present'
      ) {
        return;
      }
      logUserAction('queue_swap', 'queue.standby_swap', 'applied', {
        detail: { a: data.playerId, b: targetPlayerId },
      });
      swapQueuePlayers(dragging.id, target.id);
    },
    [players, logUserAction, swapQueuePlayers],
  );

  const renderBulkModal = () => (
    <div className="modal-backdrop" role="presentation">
      <section className="bulk-modal" aria-labelledby="bulk-add-title" role="dialog">
        <div className="modal-header bulk-modal-header">
          <div>
            <h2 id="bulk-add-title">Manage Players</h2>
            <p>
              Type a new player or select an existing saved player. Existing
              players auto-fill paddle, level, and grip color.
            </p>
          </div>
          <div className="bulk-modal-header-actions">
            <button
              className="ghost-button"
              type="button"
              onClick={() => {
                logUserAction('bulk_reset_rows', 'bulk_modal.reset_rows', 'applied');
                resetBulkRows();
              }}
            >
              Reset rows
            </button>
            <button className="primary-button" type="button" onClick={handleBulkAdd}>
              Update players
            </button>
            <button
              className="ghost-button"
              type="button"
              onClick={() => {
                logUserAction('bulk_modal_close', 'bulk_modal.close', 'applied');
                setBulkAddError('');
                setIsBulkModalOpen(false);
              }}
            >
              <X size={18} />
              Close
            </button>
          </div>
        </div>

        {bulkAddError ? <p className="bulk-error" role="alert">{bulkAddError}</p> : null}

        <div className="bulk-table-groups">
          <div className="bulk-table-wrap">
            <table className="bulk-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Player</th>
                  <th>Lvl</th>
                  <th>Min</th>
                  <th>Max</th>
                  <th>Paddle</th>
                  <th>Phone</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {bulkRows.map((row, rowIndex) => (
                  <tr key={row.rowId}>
                    <td className="bulk-row-number">{rowIndex + 1}</td>
                    <td>
                      <input
                        list="bulk-saved-player-names"
                        value={row.name}
                        onChange={(event) =>
                          onBulkFieldChange(row.rowId, 'name', () =>
                            updateBulkName(row.rowId, event.target.value),
                          )
                        }
                        placeholder="Player"
                      />
                    </td>
                    <td>
                      <select
                        value={row.level}
                        onChange={(event) =>
                          onBulkFieldChange(row.rowId, 'level', () =>
                            updateBulkLevel(row.rowId, Number(event.target.value)),
                          )
                        }
                      >
                        {LEVELS.map((level) => (
                          <option value={level} key={level}>
                            {level}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <select
                        value={row.minLevel}
                        onChange={(event) =>
                          onBulkFieldChange(row.rowId, 'minLevel', () =>
                            updateBulkRow(row.rowId, {
                              minLevel: Number(event.target.value),
                            }),
                          )
                        }
                      >
                        {LEVELS.map((level) => (
                          <option value={level} key={level}>
                            {level}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <select
                        value={row.maxLevel}
                        onChange={(event) =>
                          onBulkFieldChange(row.rowId, 'maxLevel', () =>
                            updateBulkRow(row.rowId, {
                              maxLevel: Number(event.target.value),
                            }),
                          )
                        }
                      >
                        {LEVELS.map((level) => (
                          <option value={level} key={level}>
                            {level}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <input
                        list="paddle-options"
                        value={row.paddle}
                        onChange={(event) =>
                          onBulkFieldChange(row.rowId, 'paddle', () =>
                            updateBulkRow(row.rowId, { paddle: event.target.value }),
                          )
                        }
                        placeholder="Paddle"
                      />
                    </td>
                    <td>
                      <input
                        value={row.phone}
                        onChange={(event) =>
                          onBulkFieldChange(row.rowId, 'phone', () =>
                            updateBulkRow(row.rowId, { phone: event.target.value }),
                          )
                        }
                        placeholder="Optional"
                        inputMode="tel"
                        autoComplete="tel"
                      />
                    </td>
                    <td>
                      {row.name.trim() ? <span className="bulk-status">Ready</span> : null}
                    </td>
                    <td>
                      <button
                        className="ghost-button danger compact-button"
                        type="button"
                        onClick={() => clearBulkRow(row.rowId)}
                      >
                        X
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <datalist id="bulk-saved-player-names">
            {savedPlayers.map((player) => (
              <option value={player.name} key={player.id} />
            ))}
          </datalist>
          <datalist id="paddle-options">
            {paddleOptions.map((option) => (
              <option value={option} key={option} />
            ))}
          </datalist>
        </div>
      </section>
    </div>
  );

  const renderSettingsModal = () => (
    <div className="modal-backdrop" role="presentation">
      <section className="settings-modal" aria-labelledby="settings-title" role="dialog">
        <div className="modal-header">
          <div>
            <h2 id="settings-title">Admin Settings</h2>
            <p>Configure the open play date, court count, and max play time.</p>
          </div>
          <button
            className="ghost-button"
            type="button"
            onClick={() => {
              logUserAction('settings_modal_close', 'settings.close', 'applied');
              setIsSettingsModalOpen(false);
            }}
          >
            <X size={18} />
            Close
          </button>
        </div>

        <div className="settings-grid">
          <label>
            Open Play Date
            <input
              type="date"
              value={sessionDate}
              onChange={(event) => {
                const next = event.target.value;
                logUserAction('settings_session_date', 'settings.session_date', 'applied', {
                  detail: { sessionDate: next },
                });
                setSessionDate(next);
              }}
            />
          </label>
          <label>
            Courts available
            <input
              min={1}
              type="number"
              value={courts.length}
              onChange={(event) => updateCourtCount(Number(event.target.value))}
            />
          </label>
          <label>
            Max minutes of play
            <input
              min={1}
              type="number"
              value={maxMinutes}
              onChange={(event) => {
                const next = Number(event.target.value);
                logUserAction('settings_max_minutes', 'settings.max_minutes', 'applied', {
                  detail: { maxMinutes: next },
                });
                setMaxMinutes(next);
              }}
            />
          </label>
          <label className="settings-checkbox">
            <input
              type="checkbox"
              checked={showPublicRanking}
              onChange={(event) => {
                const next = event.target.checked;
                logUserAction('settings_public_ranking', 'settings.public_ranking', 'applied', {
                  detail: { showPublicRanking: next },
                });
                setShowPublicRanking(next);
              }}
            />
            Show rankings on public queue / standings links
          </label>
        </div>

        <div className="settings-danger-zone">
          <p>
            <strong>Full reset today</strong> removes every player from the session and clears
            court matches. Saved lifetime profiles are not deleted.
          </p>
          <button className="ghost-button danger" type="button" onClick={() => void fullResetToday()}>
            Full reset today
          </button>
        </div>

        <div className="settings-danger-zone">
          <p>
            <strong>All clear today</strong> clears courts, zeros today’s W/L and games for
            everyone still listed, and clears standby order. Saved profile rows in the database are
            unchanged.
          </p>
          <button className="ghost-button danger" type="button" onClick={() => void clearAllTodaySession()}>
            All clear today
          </button>
        </div>

        <div className="storage-status">
          <Database size={16} />
          <span>{saveStatus}</span>
        </div>
      </section>
    </div>
  );

  const renderPlayerView = () => {
    const rankingOnPublic = !isLockedPublicView || showPublicRanking;
    let deviceReg: { playerId: string; sessionDate: string } | null = null;
    try {
      const raw = localStorage.getItem(DEVICE_REGISTRATION_KEY);
      if (raw) {
        deviceReg = JSON.parse(raw) as { playerId: string; sessionDate: string };
      }
    } catch {
      deviceReg = null;
    }
    const myPlayer =
      deviceReg && deviceReg.sessionDate === sessionDate
        ? players.find((p) => p.id === deviceReg!.playerId)
        : undefined;
    const fifoIndex =
      myPlayer && myPlayer.arrivalStatus === 'present'
        ? fifoQueueOrder.findIndex((p) => p.id === myPlayer.id)
        : -1;
    const todayRankIndex =
      myPlayer && rankingOnPublic
        ? standingsRowsToday.findIndex((p) => p.id === myPlayer.id)
        : -1;
    const waitSeconds =
      myPlayer?.joinedQueueAt && myPlayer.arrivalStatus === 'present'
        ? Math.max(0, Math.floor((now - myPlayer.joinedQueueAt) / 1000))
        : 0;

    return (
      <section className="player-view">
        {!isLockedPublicView && (
          <p className="public-view-link-row">
            <a className="ghost-button" href={standingsUrl}>
              View full standings
            </a>
          </p>
        )}
        {isLockedPublicView && (
          <p className="public-view-link-row">
            <a className="ghost-button" href={registerUrl}>
              Register for today&apos;s game
            </a>
          </p>
        )}

        {isLockedPublicView ? (
          <section className="panel">
            <div className="panel-title">
              <UsersRound />
              <h2>Find your spot with phone</h2>
            </div>
            <p className="hint">
              Use the same digits you gave at check-in. Your place is stored on this device after
              lookup.
            </p>
            <label className="register-field">
              Phone
              <input
                value={publicPhoneInput}
                onChange={(event) => {
                  setPublicPhoneInput(event.target.value);
                  setPublicLookupMessage('');
                }}
                inputMode="tel"
                autoComplete="tel"
                placeholder="Digits only"
              />
            </label>
            <button
              className="primary-button"
              type="button"
              onClick={() => {
                const digits = normalizePhoneDigits(publicPhoneInput);
                if (!digits) {
                  setPublicLookupMessage('Enter a phone number.');
                  return;
                }
                const found = players.find((pl) => normalizePhoneDigits(pl.phone) === digits);
                if (!found) {
                  setPublicLookupMessage('Not on today’s list. Register or ask staff.');
                  return;
                }
                localStorage.setItem(
                  DEVICE_REGISTRATION_KEY,
                  JSON.stringify({ playerId: found.id, sessionDate }),
                );
                setPublicLookupMessage('Saved on this device — scroll to “You”.');
              }}
            >
              Show my place
            </button>
            {publicLookupMessage ? (
              <p className="hint" role="status">
                {publicLookupMessage}
              </p>
            ) : null}
          </section>
        ) : null}

        {myPlayer ? (
          <section className="panel you-panel">
            <div className="panel-title">
              <CheckCircle2 />
              <h2>You ({myPlayer.name})</h2>
            </div>
            <div className="public-list">
              <article className="public-card">
                <strong>Status</strong>
                <span>{myPlayer.arrivalStatus}</span>
                {myPlayer.arrivalStatus === 'present' && fifoIndex >= 0 ? (
                  <small>
                    Queue position (FIFO): #{fifoIndex + 1} of {fifoQueueOrder.length}
                  </small>
                ) : null}
                {myPlayer.arrivalStatus === 'present' && myPlayer.joinedQueueAt ? (
                  <small>Waiting about {formatElapsedTime(waitSeconds)}</small>
                ) : null}
                {rankingOnPublic && todayRankIndex >= 0 ? (
                  <small>
                    Today&apos;s ranking: #{todayRankIndex + 1} · {sessionDayRecordLabel(myPlayer)}
                  </small>
                ) : null}
              </article>
            </div>
          </section>
        ) : deviceReg && deviceReg.sessionDate !== sessionDate ? (
          <p className="hint">
            This device was registered for {deviceReg.sessionDate}. Register again for {sessionDate}{' '}
            or open the queue link after check-in.
          </p>
        ) : null}

        <section className="panel player-queue-panel">
          <div className="panel-title">
            <UsersRound />
            <h2>Up next</h2>
          </div>
          <div className="public-list">
            {nextGroups.length > 0 ? (
              <article className="public-card">
                <strong>Standby groups (up to 4)</strong>
                <span>
                  {nextGroups.map((group, index) => (
                    <span key={group.id}>
                      #{index + 1}:{' '}
                      {group.players.map((player) => player.name).join(', ') || '—'}
                      {index === nextGroups.length - 1 ? '' : ' · '}
                    </span>
                  ))}
                </span>
                <small>
                  After each match, players who were waiting move ahead in the queue so they get
                  the next open spots.
                </small>
              </article>
            ) : null}

            {upNextPlayers.map((player, index) => (
              <article className="public-card" key={player.id}>
                <strong>
                  #{index + 1} {player.name}
                </strong>
                <span>In line (FIFO)</span>
                {rankingOnPublic ? <small>{sessionDayRecordLabel(player)}</small> : null}
              </article>
            ))}

            {!waitingPlayers.length && (
              <p className="hint">No waiting players are currently in the queue.</p>
            )}
          </div>
        </section>

        <section className="panel">
          <div className="panel-title">
            <Clock3 />
            <h2>Now playing / loaded</h2>
          </div>
          <div className="public-list">
            {courts.map((court) => {
              const elapsedSeconds = getElapsedSeconds(court.match, now);
              const fourNames =
                court.match?.players.map((player) => player.name).join(' · ') || '';
              const emptyCourtLabel =
                court.status === 'reserved' || court.status === 'unavailable'
                  ? court.status
                  : 'Available for next group';

              return (
                <article className={`public-card court-public-card ${court.status}`} key={court.id}>
                  <strong>{court.name}</strong>
                  {court.match ? (
                    <div className="public-court-teams">
                      <span>{fourNames || '—'}</span>
                    </div>
                  ) : (
                    <span>{emptyCourtLabel}</span>
                  )}
                  <small>
                    {court.status}
                    {court.match?.startedAt ? ` · ${formatElapsedTime(elapsedSeconds)}` : ''}
                  </small>
                </article>
              );
            })}
          </div>
        </section>
      </section>
    );
  };

  const renderStandingsView = () => {
    const isToday = publicStandingsScope === 'today';
    const rowsToday = standingsRowsToday;
    const rowsOverall = standingsRowsOverall;

    const showOverallTab = !isLockedPublicView;

    return (
      <section className="player-view standings-view">
        {showOverallTab && showPublicRanking ? (
          <div className="public-nav view-toggle standings-subtoggle">
            <button
              className={publicStandingsScope === 'today' ? 'primary-button' : 'ghost-button'}
              onClick={() => setPublicStandingsScope('today')}
              type="button"
            >
              Today
            </button>
            <button
              className={publicStandingsScope === 'overall' ? 'primary-button' : 'ghost-button'}
              onClick={() => setPublicStandingsScope('overall')}
              type="button"
            >
              Overall
            </button>
          </div>
        ) : null}
        <section className="panel">
          <div className="panel-title">
            <Trophy />
            <h2>
              {isToday || isLockedPublicView
                ? 'Standings — today’s session'
                : 'Standings — overall (saved profiles)'}
            </h2>
          </div>
          <div className="standings-table-wrap">
            <table className="standings-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Name</th>
                  <th>W</th>
                  <th>L</th>
                  <th>{isToday || isLockedPublicView ? 'Games today' : 'Rank score'}</th>
                </tr>
              </thead>
              <tbody>
                {isToday || isLockedPublicView
                  ? rowsToday.map((player, index) => (
                      <tr key={player.id}>
                        <td>{index + 1}</td>
                        <td>{player.name}</td>
                        <td>{player.wins}</td>
                        <td>{player.losses}</td>
                        <td>{player.gamesPlayed}</td>
                      </tr>
                    ))
                  : rowsOverall.map((player, index) => (
                      <tr key={player.id}>
                        <td>{index + 1}</td>
                        <td>{player.name}</td>
                        <td>{player.wins}</td>
                        <td>{player.losses}</td>
                        <td>{player.rankingScore}</td>
                      </tr>
                    ))}
              </tbody>
            </table>
            {(isToday || isLockedPublicView) && !rowsToday.length && (
              <p className="hint">No players in today&apos;s session yet.</p>
            )}
            {showOverallTab && !isToday && !rowsOverall.length && (
              <p className="hint">No saved profiles yet.</p>
            )}
          </div>
        </section>
      </section>
    );
  };

  if (isRegisterView) {
    return (
      <main className="app-shell register-shell">
        <section className="hero hero-slim">
          <div>
            <span className="eyebrow">Self check-in</span>
            <h1>Register for today&apos;s game</h1>
            <p>
              Add yourself to the queue for {sessionDate}. Add your phone so you can find your
              place on the public queue link and so staff can match your profile.
            </p>
          </div>
        </section>
        <section className="panel register-panel">
          <label className="register-field">
            Name
            <input
              value={registerName}
              onChange={(event) => setRegisterName(event.target.value)}
              placeholder="Your name"
              autoComplete="name"
            />
          </label>
          <label className="register-field">
            Level
            <select
              value={registerLevel}
              onChange={(event) => setRegisterLevel(Number(event.target.value))}
            >
              {LEVELS.map((level) => (
                <option value={level} key={level}>
                  {level}
                </option>
              ))}
            </select>
          </label>
          <label className="register-field">
            Phone
            <input
              value={registerPhone}
              onChange={(event) => setRegisterPhone(event.target.value)}
              placeholder="Digits — used on the queue view and to avoid dupes"
              inputMode="tel"
              autoComplete="tel"
            />
          </label>
          {registerError ? (
            <p className="bulk-error" role="alert">
              {registerError}
            </p>
          ) : null}
          {registerDone ? (
            <p className="hint" role="status">
              {registerDone}
            </p>
          ) : null}
          <div className="register-actions">
            <button className="primary-button" type="button" onClick={() => void submitSelfRegister()}>
              Join today&apos;s queue
            </button>
            <a className="ghost-button" href={playerQueueUrl}>
              Open queue view
            </a>
          </div>
        </section>
        <footer className="app-footer">{BRAND_FOOTER}</footer>
      </main>
    );
  }

  if (isLockedPublicView) {
    return (
      <main className="app-shell public-kiosk">
        <section className="hero hero-slim">
          <div>
            <span className="eyebrow">Open play</span>
            <h1>OpenQueue</h1>
            <p>
              {sessionDate}. Live queue
              {showPublicRanking ? ' and standings' : ''}. Ask staff for the admin link; this page is
              read-only.
            </p>
          </div>
          <div className="public-kiosk-status">
            <span>{saveStatus}</span>
          </div>
        </section>
        <div className="public-nav view-toggle">
          <button
            className={publicPage === 'queue' ? 'primary-button' : 'ghost-button'}
            onClick={() => setPublicViewAndUrl('queue')}
            type="button"
          >
            Queue
          </button>
          {showPublicRanking ? (
            <button
              className={publicPage === 'standings' ? 'primary-button' : 'ghost-button'}
              onClick={() => setPublicViewAndUrl('standings')}
              type="button"
            >
              Standings
            </button>
          ) : null}
        </div>
        {publicPage === 'standings' && showPublicRanking ? renderStandingsView() : renderPlayerView()}
        <footer className="app-footer">{BRAND_FOOTER}</footer>
      </main>
    );
  }

  if (!adminUnlocked) {
    return (
      <main className="app-shell admin-passcode-shell">
        <section className="hero hero-slim">
          <div>
            <span className="eyebrow">Staff only</span>
            <h1>Admin access</h1>
            <p>Enter the access code from your organizer.</p>
          </div>
        </section>
        <section className="panel passcode-panel">
          <label className="register-field">
            Access code
            <input
              type="password"
              value={passcodeInput}
              onChange={(event) => setPasscodeInput(event.target.value)}
              autoComplete="off"
              placeholder="Access Code"
            />
          </label>
          {passcodeError ? (
            <p className="bulk-error" role="alert">
              {passcodeError}
            </p>
          ) : null}
          <button className="primary-button" type="button" onClick={tryAdminUnlock}>
            Unlock admin board
          </button>
        </section>
        <footer className="app-footer">{BRAND_FOOTER}</footer>
      </main>
    );
  }

  return (
    <main className="app-shell">
      {isBulkModalOpen && renderBulkModal()}
      {isSettingsModalOpen && renderSettingsModal()}
      {!hasSupabaseConfig && (
        <div className="local-only-banner" role="status">
          Not connected to Supabase at build time. Data is only saved in this browser. Add
          <code> VITE_SUPABASE_URL</code> and <code> VITE_SUPABASE_PUBLISHABLE_KEY</code> to
          GitHub Actions secrets for a shared live site.
        </div>
      )}
      <section className="hero">
        <div>
          <span className="eyebrow">Admin open play manager</span>
          <h1>OpenQueue</h1>
          <p className="hero-brand-line">
            {BRAND_FOOTER}
          </p>
          <p>
            Open play for {sessionDate}. Add players, build groups in standby, then drag a full
            foursome to a free ready court. Share the player link for the live list.
          </p>
        </div>
        <div className="hero-stats">
          <div>
            <strong>{players.length}</strong>
            <span>players</span>
          </div>
          <div>
            <strong>{availablePlayers.length}</strong>
            <span>waiting</span>
          </div>
          <div>
            <strong>{savedPlayers.length}</strong>
            <span>saved</span>
          </div>
        </div>
      </section>

      <div className="view-toggle">
        <button
          className={viewMode === 'admin' ? 'primary-button' : 'ghost-button'}
          onClick={() => goToViewMode('admin')}
          type="button"
        >
          Admin View
        </button>
        <button
          className={viewMode === 'player' ? 'primary-button' : 'ghost-button'}
          onClick={() => goToViewMode('player')}
          type="button"
        >
          Player Queue View
        </button>
      </div>

      {viewMode === 'player' ? (
        renderPlayerView()
      ) : (
        <section className="admin-board">
          <section className="admin-actions panel">
            <div>
              <strong>Open Play for {sessionDate}</strong>
              <span className="save-status-muted">{saveStatus}</span>
            </div>
            <div className="inline-actions">
              <button
                className="primary-button"
                type="button"
                onClick={() => {
                  logUserAction('open_manage_players', 'admin.manage_players_open', 'applied', {
                    detail: { playerCount: players.length },
                  });
                  setBulkAddError('');
                  setBulkRows(buildBulkRowsFromPlayers(players));
                  setIsBulkModalOpen(true);
                }}
              >
                <Plus size={18} />
                Manage players
              </button>
              <button
                className="ghost-button"
                type="button"
                onClick={() => {
                  logUserAction('open_settings', 'admin.settings_open', 'applied');
                  setIsSettingsModalOpen(true);
                }}
              >
                <Settings size={18} />
                Settings
              </button>
              <a className="ghost-button" href={playerQueueUrl} target="_blank" rel="noreferrer">
                Player queue link
              </a>
              <a className="ghost-button" href={registerUrl} target="_blank" rel="noreferrer">
                Register link
              </a>
              <button className="ghost-button" type="button" onClick={lockAdmin}>
                Lock admin
              </button>
            </div>
          </section>

          <section className="court-grid court-grid-compact">
            {courts.map((court) => {
              const match = court.match;
              const elapsedSeconds = getElapsedSeconds(match, now);
              const isOverTime = Boolean(
                match?.startedAt && elapsedSeconds >= match.durationMinutes * 60,
              );

              return (
                <article
                  className={`court-card ${court.status} ${
                    selectedCourtId === court.id ? 'selected' : ''
                  }`}
                  key={court.id}
                  onClick={() => {
                    logUserAction('select_court', 'court.card_click', 'applied', {
                      detail: { courtId: court.id },
                    });
                    setSelectedCourtId(court.id);
                  }}
                  onDrop={(event) => handleCourtDrop(event, court.id)}
                  onDragOver={(event) => event.preventDefault()}
                >
                  <div className="court-header">
                    <div>
                      <input
                        aria-label={`${court.name} name`}
                        value={court.name}
                        onChange={(event) =>
                          onCourtFieldChange(court.id, 'name', { name: event.target.value })
                        }
                      />
                      <span>
                        Levels {court.minLevel}-{court.maxLevel}
                      </span>
                    </div>
                    <select
                      value={court.status}
                      onChange={(event) =>
                        onCourtFieldChange(court.id, 'status', {
                          status: event.target.value as CourtStatus,
                        })
                      }
                    >
                      <option value="ready">Ready</option>
                      <option value="reserved">Reserved</option>
                      <option value="unavailable">Unavailable</option>
                      <option value="loaded">Loaded</option>
                      <option value="playing">Playing</option>
                    </select>
                  </div>

                  {court.match ? (
                    <div className="match-card court-surface">
                      <span className="kitchen-line top" aria-hidden="true" />
                      <span className="kitchen-line bottom" aria-hidden="true" />
                      <div className={`timer ${isOverTime ? 'overtime' : ''}`}>
                        <Clock3 size={18} />
                        {formatElapsedTime(elapsedSeconds)} /{' '}
                        {court.match.durationMinutes}:00
                      </div>
                      <div className="match-teams">
                        {[court.match.players.slice(0, 2), court.match.players.slice(2, 4)].map(
                          (team, teamIndex) => (
                            <div className="team-row" key={`team-${teamIndex}`}>
                              {team.map((player) => {
                                const isWinner = court.match?.winnerIds.includes(player.id);
                                const canSubstitute = court.status === 'loaded';

                                return (
                                  <div
                                    className={`match-player-card ${isWinner ? 'winner' : ''}`}
                                    key={player.id}
                                  >
                                    <button
                                      className="match-result-button"
                                      disabled={court.status !== 'playing'}
                                      onClick={(event) => {
                                        event.stopPropagation();
                                        toggleMatchWinner(court.id, player.id);
                                      }}
                                    >
                                      <strong>{player.name}</strong>
                                      <span>
                                        {court.status === 'playing'
                                          ? isWinner
                                            ? 'Winner'
                                            : 'Tap if won'
                                          : 'Loaded'}
                                      </span>
                                    </button>
                                    {canSubstitute && (
                                      <button
                                        className="substitute-button"
                                        onClick={(event) => {
                                          event.stopPropagation();
                                          removeLoadedPlayer(court.id, player.id);
                                        }}
                                      >
                                        Remove + fill
                                      </button>
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                          ),
                        )}
                      </div>
                      <div className="court-actions">
                        {court.status !== 'playing' && (
                          <button
                            className="primary-button small"
                            onClick={(event) => {
                              event.stopPropagation();
                              startMatch(court.id);
                            }}
                          >
                            Start timer
                          </button>
                        )}
                        {court.status === 'playing' && (
                          <button
                            className="primary-button small"
                            type="button"
                            disabled={court.match.winnerIds.length !== 2}
                            title={
                              court.match.winnerIds.length === 2
                                ? 'Save this match and return players to the queue'
                                : 'Select exactly two winners first (2v2).'
                            }
                            onClick={(event) => {
                              event.stopPropagation();
                              closeMatch(court.id);
                            }}
                          >
                            <Trophy size={16} />
                            Save results
                          </button>
                        )}
                        <button
                          className="ghost-button"
                          onClick={(event) => {
                            event.stopPropagation();
                            resetCourt(court.id);
                          }}
                        >
                          <RotateCcw size={16} />
                          Reset
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="court-surface">
                      <span className="kitchen-line top" aria-hidden="true" />
                      <span className="kitchen-line bottom" aria-hidden="true" />
                      <div className="drop-zone">
                        <CheckCircle2 />
                        Drop a full group here (ready court)
                      </div>
                    </div>
                  )}
                </article>
              );
            })}
          </section>

          <section
            className="panel queue-panel"
            onDrop={handleQueueDrop}
            onDragOver={(event) => event.preventDefault()}
          >
            <div className="panel-title">
              <UsersRound />
              <h2>Standby queue</h2>
            </div>
            <p className="hint">
              Four group slots; each group lists one player per row. Drag a full group of four to a
              free ready court (timer starts on drop). Drag a player onto another waiting player to
              swap order and regroup.
            </p>

            <div className="queue-grid queue-grid-standby">
              {queueGroups.map((group) => {
                const canUseSelectedCourt =
                  Boolean(selectedCourt) &&
                  group.compatibleCourtIds.includes(selectedCourtId) &&
                  group.playerIds.length === 4;
                const isFull = group.playerIds.length === 4;

                return (
                  <article
                    className={groupClassName(canUseSelectedCourt)}
                    draggable={isFull}
                    key={group.id}
                    onDragStart={(event) => {
                      if (!isFull) {
                        return;
                      }
                      handleDragStart(event, {
                        type: 'group',
                        groupId: group.id,
                        playerIds: group.playerIds,
                      });
                    }}
                  >
                    <div className="queue-card-header">
                      <span>
                        <GripVertical size={16} />
                        {isFull ? 'Group of 4' : 'Open slot'}
                      </span>
                      <small>
                        {group.players.length
                          ? `Avg L${group.averageLevel.toFixed(1)}`
                          : 'Add players from the list below'}
                      </small>
                    </div>
                    <div className="player-stack player-stack-standby">
                      {group.players.length === 0 ? (
                        <p className="hint">—</p>
                      ) : (
                        group.players.map((player) => (
                          <div
                            className="player-chip"
                            draggable
                            key={player.id}
                            onDragStart={(event) =>
                              handleDragStart(event, {
                                type: 'player',
                                playerId: player.id,
                              })
                            }
                            onDragOver={(event) => event.preventDefault()}
                            onDrop={(event) => handleStandbyPlayerDrop(event, player.id)}
                          >
                            <span>
                              <span className="player-chip-level">L{player.level}</span>
                              {player.name}
                              <small>{sessionDayRecordLabel(player)}</small>
                            </span>
                            <span
                              className="color-dot"
                              style={{
                                background: player.gripColor || '#94a3b8',
                              }}
                            />
                          </div>
                        ))
                      )}
                    </div>
                    <div className="compatibility-list">
                      Can play:{' '}
                      {group.compatibleCourtIds.length
                        ? group.compatibleCourtIds
                            .map((courtId) =>
                              courts.find((court) => court.id === courtId)?.name,
                            )
                            .join(', ')
                        : '—'}
                    </div>
                  </article>
                );
              })}
            </div>
          </section>

          <section className="panel player-table-panel">
            <div className="panel-title">
              <UsersRound />
              <h2>Players</h2>
            </div>
            <div className="player-admin-table-wrap">
              <table className="player-admin-table">
                <thead>
                  <tr>
                    <th className="roster-drag-col" aria-label="Drag to standby" />
                    <th>Name</th>
                    <th>Status</th>
                    <th>Lvl</th>
                    <th>Min</th>
                    <th>Max</th>
                    <th>Paddle</th>
                    <th>Phone</th>
                    <th>Record</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {rosterActive.map((player) => (
                    <tr key={player.id}>
                      <td className="roster-drag-col">
                        <span
                          className="roster-drag-handle"
                          draggable
                          role="button"
                          tabIndex={0}
                          title="Drag onto a standby player to swap queue order"
                          onDragStart={(event) =>
                            handleDragStart(event, { type: 'player', playerId: player.id })
                          }
                        >
                          <GripVertical size={16} />
                        </span>
                      </td>
                      <td>
                        <input
                          value={player.name}
                          onChange={(event) =>
                            onPlayerFieldChange(player.id, 'name', { name: event.target.value })
                          }
                        />
                      </td>
                      <td>
                        <select
                          value={player.arrivalStatus}
                          title={
                            player.arrivalStatus === 'playing'
                              ? 'Status is locked while the player is in an active match.'
                              : 'Change freely while the player is not on court.'
                          }
                          disabled={player.arrivalStatus === 'playing'}
                          onChange={(event) =>
                            onPlayerFieldChange(player.id, 'arrivalStatus', {
                              arrivalStatus: event.target.value as Player['arrivalStatus'],
                            })
                          }
                        >
                          <option value="present">Waiting</option>
                          <option value="away">Unavailable</option>
                          <option value="assigned">Assigned</option>
                          <option value="playing">Playing</option>
                          <option value="left">Left</option>
                        </select>
                      </td>
                      <td>
                        <select
                          value={player.level}
                          onChange={(event) =>
                            onPlayerFieldChange(player.id, 'level', {
                              level: Number(event.target.value),
                              ...getLevelRange(Number(event.target.value)),
                            })
                          }
                        >
                          {LEVELS.map((level) => (
                            <option value={level} key={level}>
                              {level}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td>
                        <select
                          value={player.minLevel}
                          onChange={(event) =>
                            onPlayerFieldChange(player.id, 'minLevel', {
                              minLevel: Number(event.target.value),
                            })
                          }
                        >
                          {LEVELS.map((level) => (
                            <option value={level} key={level}>
                              {level}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td>
                        <select
                          value={player.maxLevel}
                          onChange={(event) =>
                            onPlayerFieldChange(player.id, 'maxLevel', {
                              maxLevel: Number(event.target.value),
                            })
                          }
                        >
                          {LEVELS.map((level) => (
                            <option value={level} key={level}>
                              {level}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td>
                        <input
                          list="paddle-options"
                          value={player.paddle}
                          onChange={(event) =>
                            onPlayerFieldChange(player.id, 'paddle', { paddle: event.target.value })
                          }
                        />
                      </td>
                      <td>
                        <input
                          value={player.phone}
                          onChange={(event) =>
                            onPlayerFieldChange(player.id, 'phone', { phone: event.target.value })
                          }
                          placeholder="Optional"
                          inputMode="tel"
                        />
                      </td>
                      <td className="record-cell">
                        {sessionDayRecordLabel(player)}
                      </td>
                      <td>
                        <button
                          className="ghost-button danger compact-button"
                          onClick={() => markPlayerLeft(player.id)}
                          type="button"
                        >
                          Mark left
                        </button>
                      </td>
                    </tr>
                  ))}
                  {rosterInactive.length > 0 && (
                    <tr className="roster-subhead">
                      <td colSpan={11}>Left or unavailable (still listed for today)</td>
                    </tr>
                  )}
                  {rosterInactive.map((player) => (
                    <tr className="roster-inactive" key={player.id}>
                      <td className="roster-drag-col" />
                      <td>
                        <input
                          value={player.name}
                          onChange={(event) =>
                            onPlayerFieldChange(player.id, 'name', { name: event.target.value })
                          }
                        />
                      </td>
                      <td>
                        <select
                          value={player.arrivalStatus}
                          title={
                            player.arrivalStatus === 'playing'
                              ? 'Status is locked while the player is in an active match.'
                              : 'Change freely while the player is not on court.'
                          }
                          disabled={player.arrivalStatus === 'playing'}
                          onChange={(event) =>
                            onPlayerFieldChange(player.id, 'arrivalStatus', {
                              arrivalStatus: event.target.value as Player['arrivalStatus'],
                            })
                          }
                        >
                          <option value="present">Waiting</option>
                          <option value="away">Unavailable</option>
                          <option value="assigned">Assigned</option>
                          <option value="playing">Playing</option>
                          <option value="left">Left</option>
                        </select>
                      </td>
                      <td>
                        <select
                          value={player.level}
                          onChange={(event) =>
                            onPlayerFieldChange(player.id, 'level', {
                              level: Number(event.target.value),
                              ...getLevelRange(Number(event.target.value)),
                            })
                          }
                        >
                          {LEVELS.map((level) => (
                            <option value={level} key={level}>
                              {level}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td>
                        <select
                          value={player.minLevel}
                          onChange={(event) =>
                            onPlayerFieldChange(player.id, 'minLevel', {
                              minLevel: Number(event.target.value),
                            })
                          }
                        >
                          {LEVELS.map((level) => (
                            <option value={level} key={level}>
                              {level}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td>
                        <select
                          value={player.maxLevel}
                          onChange={(event) =>
                            onPlayerFieldChange(player.id, 'maxLevel', {
                              maxLevel: Number(event.target.value),
                            })
                          }
                        >
                          {LEVELS.map((level) => (
                            <option value={level} key={level}>
                              {level}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td>
                        <input
                          list="paddle-options"
                          value={player.paddle}
                          onChange={(event) =>
                            onPlayerFieldChange(player.id, 'paddle', { paddle: event.target.value })
                          }
                        />
                      </td>
                      <td>
                        <input
                          value={player.phone}
                          onChange={(event) =>
                            onPlayerFieldChange(player.id, 'phone', { phone: event.target.value })
                          }
                          placeholder="Optional"
                          inputMode="tel"
                        />
                      </td>
                      <td className="record-cell">
                        {sessionDayRecordLabel(player)}
                      </td>
                      <td>—</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!players.length && <p className="hint">Use Manage players to start.</p>}
          </section>
        </section>
      )}
      <footer className="app-footer">{BRAND_FOOTER}</footer>
    </main>
  );
}
