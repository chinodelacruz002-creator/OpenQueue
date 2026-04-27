import {
  ArrowDownUp,
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
import { DragEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { logUserInteraction, type UserActionLogStatus } from './actionLog';
import { GRIP_COLOR_OPTIONS, LEVELS, PADDLE_OPTIONS, getLevelRange } from './constants';
import {
  buildAutoAssignments,
  createGroupsFromAvailablePlayers,
  formatElapsedTime,
  getAvailablePlayers,
  getElapsedSeconds,
} from './scheduler';
import {
  hasSupabaseConfig,
  loadOpenPlayData,
  saveOpenPlayData,
  subscribeOpenPlayRealtime,
} from './storage';
import type {
  AppData,
  AutoAssignment,
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

const normalizePlayerName = (name: string) => name.trim().toLowerCase();

const persistenceLabel = (): 'supabase' | 'local' =>
  hasSupabaseConfig ? 'supabase' : 'local';

const getInitialViewParam = () => new URLSearchParams(window.location.search).get('view');
const isLockedPublicView = (() => {
  const param = getInitialViewParam();
  return param === 'player' || param === 'standings';
})();

interface BulkPlayerRow extends PlayerForm {
  rowId: string;
  savedPlayerId: string;
  playerId: string | null;
}

const splitRowsIntoColumns = (rows: BulkPlayerRow[]): BulkPlayerRow[][] => {
  const midpoint = Math.ceil(rows.length / 2);
  return [rows.slice(0, midpoint), rows.slice(midpoint)];
};

const todayKey = () => new Date().toISOString().slice(0, 10);

const createBulkRow = (): BulkPlayerRow => ({
  rowId: crypto.randomUUID(),
  name: '',
  level: 3,
  ...getLevelRange(3),
  paddle: '',
  gripColor: '',
  preferredPartnerName: '',
  savedPlayerId: '',
  playerId: null,
  arrivalStatus: 'present',
});

const createBulkRows = () => Array.from({ length: 40 }, createBulkRow);

const buildBulkRowsFromPlayers = (players: Player[]): BulkPlayerRow[] => {
  const rows: BulkPlayerRow[] = createBulkRows();
  const taken = new Set<number>();

  players.forEach((player) => {
    const index = rows.findIndex((_, idx) => !taken.has(idx));
    if (index < 0) {
      return;
    }
    taken.add(index);
    rows[index] = {
      ...rows[index],
      playerId: player.id,
      name: player.name,
      level: player.level,
      minLevel: player.minLevel,
      maxLevel: player.maxLevel,
      paddle: player.paddle,
      gripColor: player.gripColor,
      preferredPartnerName: player.preferredPartnerName,
      arrivalStatus: player.arrivalStatus,
      savedPlayerId: player.persistentId ?? '',
    };
  });

  return rows;
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
});

const buildSavedPlayer = (player: Player): SavedPlayer => ({
  id: player.persistentId ?? player.id,
  name: player.name,
  level: player.level,
  minLevel: player.minLevel,
  maxLevel: player.maxLevel,
  paddle: player.paddle,
  gripColor: player.gripColor,
  preferredPartnerName: player.preferredPartnerName,
  wins: player.wins,
  losses: player.losses,
  gamesPlayed: player.gamesPlayed,
  rankingScore: player.rankingScore,
});

const scoreLabel = (player: Player) =>
  `${player.wins}W-${player.losses}L / Rank ${player.rankingScore}`;

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
  const existingIndex = savedPlayers.findIndex(
    (player) => player.id === incomingPlayer.id || player.name.toLowerCase() === incomingName,
  );

  if (existingIndex < 0) {
    return [...savedPlayers, incomingPlayer].sort((first, second) =>
      first.name.localeCompare(second.name),
    );
  }

  return savedPlayers.map((player, index) =>
    index === existingIndex ? { ...player, ...incomingPlayer } : player,
  );
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
  const initialViewParam = getInitialViewParam();
  const [players, setPlayers] = useState<Player[]>([]);
  const [savedPlayers, setSavedPlayers] = useState<SavedPlayer[]>([]);
  const [paddleOptions, setPaddleOptions] = useState(PADDLE_OPTIONS);
  const [gripColorOptions, setGripColorOptions] = useState(GRIP_COLOR_OPTIONS);
  const [courts, setCourts] = useState<Court[]>(createInitialCourts);
  const [bulkRows, setBulkRows] = useState<BulkPlayerRow[]>(createBulkRows());
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
  const [now, setNow] = useState(0);

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
    }),
    [courts, gripColorOptions, maxMinutes, paddleOptions, players, savedPlayers, sessionDate],
  );

  const flushSave = useCallback(
    async (saveTrigger = 'debounced_state_change') => {
      if (isLockedPublicView) {
        return;
      }

      // User-triggered saves must not be dropped if another save is in flight; debounced saves
      // bail after waiting so we do not duplicate writes for the same revision.
      let pendingSave = savePromiseRef.current;
      while (pendingSave) {
        await pendingSave;
        if (saveTrigger === 'debounced_state_change') {
          return;
        }
        pendingSave = savePromiseRef.current;
      }

      setIsSaving(true);

      const promise = saveOpenPlayData(buildAppData())
        .then(() => {
          setSaveStatus(hasSupabaseConfig ? 'Connected to Supabase' : 'Local-only (this browser)');
        })
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          setSaveStatus('Save failed');
          if (saveTrigger !== 'debounced_state_change') {
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

  const applyLoad = useCallback((data: AppData | null, kind: 'initial' | 'sync') => {
    const appData = data ?? createAppData();
    setSessionDate(appData.sessionDate || todayKey());
    setPlayers(appData.players ?? []);
    setCourts(appData.courts?.length ? appData.courts : createInitialCourts());
    setMaxMinutes(appData.maxMinutes ?? DEFAULT_MAX_MINUTES);
    setSavedPlayers(appData.savedPlayers ?? []);
    setPaddleOptions(mergeOptions(PADDLE_OPTIONS, appData.savedPaddles ?? []));
    setGripColorOptions(mergeOptions(GRIP_COLOR_OPTIONS, appData.savedGripColors ?? []));
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
    const needsPoll = !hasSupabaseConfig && (isLockedPublicView || viewMode === 'player');
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
    if (isLockedPublicView) {
      return;
    }
    const saveTimer = window.setTimeout(() => {
      void flushSave('debounced_state_change');
    }, SAVE_DEBOUNCE_MS);

    return () => window.clearTimeout(saveTimer);
  }, [courts, gripColorOptions, maxMinutes, paddleOptions, players, savedPlayers, sessionDate, flushSave]);

  const availablePlayers = useMemo(
    () => getAvailablePlayers(players),
    [players],
  );

  const waitingPlayers = availablePlayers;

  const queueGroups = useMemo(
    () => createGroupsFromAvailablePlayers(availablePlayers, courts),
    [availablePlayers, courts],
  );

  const nextGroups = useMemo(() => queueGroups.slice(0, 2), [queueGroups]);
  const nextGroupedIds = useMemo(() => new Set(nextGroups.flatMap((group) => group.playerIds)), [nextGroups]);
  const fifoQueueOrder = useMemo(() => {
    const neutral: Player[] = [];
    const winners: Player[] = [];
    const losers: Player[] = [];

    for (const player of waitingPlayers) {
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
  }, [waitingPlayers]);

  const upNextPlayers = useMemo(
    () => fifoQueueOrder.filter((player) => !nextGroupedIds.has(player.id)),
    [fifoQueueOrder, nextGroupedIds],
  );

  const selectedCourt = courts.find((court) => court.id === selectedCourtId);

  const autoAssignments = useMemo(
    () => buildAutoAssignments(courts, queueGroups),
    [courts, queueGroups],
  );

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

  const standingsRows = useMemo(
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

  const bulkRowsPerColumn = Math.ceil(bulkRows.length / 2);
  const bulkColumnRows = splitRowsIntoColumns(bulkRows);

  const updateBulkRow = (
    rowId: string,
    updates: Partial<BulkPlayerRow>,
  ) => {
    setBulkRows((currentRows) =>
      currentRows.map((row) => (row.rowId === rowId ? { ...row, ...updates } : row)),
    );
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
    });
  };

  const updateBulkLevel = (rowId: string, level: number) => {
    updateBulkRow(rowId, { level, ...getLevelRange(level) });
  };

  const resetBulkRows = () => {
    setBulkRows(createBulkRows());
  };

  const clearBulkRow = (rowId: string) => {
    if (isSaving) {
      logUserAction('bulk_clear_row', 'bulk_modal.clear_row', 'skipped', {
        detail: { rowId, reason: 'save_in_progress' },
      });
      return;
    }
    logUserAction('bulk_clear_row', 'bulk_modal.clear_row', 'applied', { detail: { rowId } });
    persistAfterFlushSync('bulk_clear_row', () => {
      setBulkRows((currentRows) =>
        currentRows.map((row) =>
          row.rowId === rowId ? { ...createBulkRow(), rowId: row.rowId } : row,
        ),
      );
    });
  };

  const handleBulkAdd = () => {
    if (isSaving) {
      logUserAction('bulk_update_players', 'bulk_modal.update_players', 'skipped', {
        detail: { reason: 'save_in_progress' },
      });
      return;
    }
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
    const rowsToApply = uniqueRows.filter((row) => {
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
        partnerId: null,
        arrivalStatus: 'present',
        wins: savedPlayer?.wins ?? 0,
        losses: savedPlayer?.losses ?? 0,
        gamesPlayed: savedPlayer?.gamesPlayed ?? 0,
        waitScore: 0,
        lastResult: null,
        lockedGroupId: null,
        rankingScore: savedPlayer?.rankingScore ?? 0,
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

    logUserAction('bulk_update_players', 'bulk_modal.update_players', 'applied', {
      detail: { playerCount: editedPlayers.length },
    });
    persistAfterFlushSync('bulk_update_players', () => {
      setPlayers(editedPlayers);
      setBulkRows(buildBulkRowsFromPlayers(editedPlayers));
    });
  };

  const updatePlayer = (playerId: string, updates: Partial<Player>) => {
    setPlayers((currentPlayers) =>
      currentPlayers.map((player) =>
        player.id === playerId ? { ...player, ...updates } : player,
      ),
    );
  };

  const onPlayerFieldChange = (playerId: string, field: string, updates: Partial<Player>) => {
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
    if (isSaving) {
      logUserAction('mark_player_left', 'roster.mark_left', 'skipped', {
        detail: { playerId, reason: 'save_in_progress' },
      });
      return;
    }
    logUserAction('mark_player_left', 'roster.mark_left', 'applied', { detail: { playerId } });
    persistAfterFlushSync('mark_player_left', () => {
      updatePlayer(playerId, { arrivalStatus: 'left' });
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

    setCourts((currentCourts) =>
      currentCourts.map((court) =>
        court.id === courtId
          ? {
              ...court,
              status: 'loaded',
              match,
            }
          : court,
      ),
    );

    setPlayers((currentPlayers) =>
      currentPlayers.map((player) => {
        if (!groupPlayerIds.includes(player.id)) {
          return player;
        }

        return {
          ...player,
          arrivalStatus: 'assigned',
        };
      }),
    );
    schedulePersistAfterMutation('assign_group_to_court');
  };

  const autoAssignGroup = (assignment: AutoAssignment) => {
    logUserAction('auto_assign_group', 'suggestions.auto_assign', 'applied', {
      detail: {
        courtId: assignment.court.id,
        groupId: assignment.group.id,
        playerIds: assignment.group.playerIds,
      },
    });
    assignGroupToCourt(assignment.court.id, assignment.group.playerIds);
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

        const winnerIds = court.match.winnerIds.includes(playerId)
          ? court.match.winnerIds.filter((winnerId) => winnerId !== playerId)
          : [...court.match.winnerIds, playerId];

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

    logUserAction('close_match', 'court.save_results', 'applied', {
      detail: {
        courtId,
        winnerIds: court.match.winnerIds,
        playerIds: getPlayerIdsInMatch(court.match),
      },
    });

    const matchPlayerIds = getPlayerIdsInMatch(court.match);
    const winnerIds = court.match.winnerIds;

    setPlayers((currentPlayers) => {
      const returningWinners: Player[] = [];
      const returningLosers: Player[] = [];
      const keptPlayers: Player[] = [];

      for (const player of currentPlayers) {
        if (!matchPlayerIds.includes(player.id)) {
          keptPlayers.push(player);
          continue;
        }

        const isWinner = winnerIds.includes(player.id);
        const updatedPlayer: Player = {
          ...player,
          arrivalStatus: 'present',
          wins: player.wins + (isWinner ? 1 : 0),
          losses: player.losses + (isWinner ? 0 : 1),
          gamesPlayed: player.gamesPlayed + 1,
          waitScore: player.waitScore + (isWinner ? 2 : 1),
          rankingScore: player.rankingScore + (isWinner ? 3 : 0),
          lastResult: isWinner ? 'won' : 'lost',
        };

        setSavedPlayers((currentSavedPlayers) =>
          upsertSavedPlayer(currentSavedPlayers, buildSavedPlayer(updatedPlayer)),
        );

        if (isWinner) {
          returningWinners.push(updatedPlayer);
        } else {
          returningLosers.push(updatedPlayer);
        }
      }

      // FIFO fairness: returning players go behind anyone already waiting.
      // Within the returning batch, winners are appended before losers so they stack together.
      return [...keptPlayers, ...returningWinners, ...returningLosers];
    });

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
            ? { ...player, arrivalStatus: 'present' }
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
          player.id === removedPlayerId ? { ...player, arrivalStatus: 'away' } : player,
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
          return { ...player, arrivalStatus: 'away' };
        }

        if (player.id === replacement.id) {
          return { ...player, arrivalStatus: 'assigned' };
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
          ? { ...player, arrivalStatus: 'present' }
          : player,
      ),
    );
    schedulePersistAfterMutation('return_player_to_queue');
  };

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
          {bulkColumnRows.map((columnRows, columnIndex) => (
            <div className="bulk-table-wrap" key={`bulk-column-${columnIndex + 1}`}>
              <table className="bulk-table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Player</th>
                    <th>Lvl</th>
                    <th>Min</th>
                    <th>Max</th>
                    <th>Paddle</th>
                    <th>Status</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {columnRows.map((row, rowIndex) => (
                    <tr key={row.rowId}>
                      <td className="bulk-row-number">
                        {columnIndex * bulkRowsPerColumn + rowIndex + 1}
                      </td>
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
          ))}
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
        </div>

        <div className="storage-status">
          <Database size={16} />
          <span>{saveStatus}</span>
        </div>
      </section>
    </div>
  );

  const renderPlayerView = () => (
    <section className="player-view">
      {!isLockedPublicView && (
        <p className="public-view-link-row">
          <a className="ghost-button" href={standingsUrl}>
            View full standings
          </a>
        </p>
      )}
      <section className="panel player-queue-panel">
        <div className="panel-title">
          <UsersRound />
          <h2>Up next</h2>
        </div>
        <div className="public-list">
          {nextGroups.length > 0 ? (
            <article className="public-card">
              <strong>Next groups (2)</strong>
              <span>
                {nextGroups.map((group, index) => (
                  <span key={group.id}>
                    #{index + 1}:{' '}
                    {group.players.map((player) => player.name).join(', ')}
                    {index === nextGroups.length - 1 ? '' : ' · '}
                  </span>
                ))}
              </span>
              <small>Neutral players first, then winners, then losers.</small>
            </article>
          ) : null}

          {upNextPlayers.map((player, index) => (
            <article className="public-card" key={player.id}>
              <strong>
                #{index + 1} {player.name}
              </strong>
              <span>In line (FIFO)</span>
              <small>{scoreLabel(player)}</small>
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
            const topNames = court.match?.players.slice(0, 2).map((player) => player.name).join(', ');
            const bottomNames = court.match?.players.slice(2, 4).map((player) => player.name).join(', ');
            const emptyCourtLabel =
              court.status === 'reserved' || court.status === 'unavailable'
                ? court.status
                : 'Available for next group';

            return (
              <article className={`public-card court-public-card ${court.status}`} key={court.id}>
                <strong>{court.name}</strong>
                {court.match ? (
                  <div className="public-court-teams">
                    <span>
                      Top: {topNames || '—'}
                    </span>
                    <span>
                      Bottom: {bottomNames || '—'}
                    </span>
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

  const renderStandingsView = () => (
    <section className="player-view standings-view">
      <section className="panel">
        <div className="panel-title">
          <Trophy />
          <h2>Standings (today&apos;s session)</h2>
        </div>
        <div className="standings-table-wrap">
          <table className="standings-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Name</th>
                <th>Record</th>
                <th>Rank score</th>
              </tr>
            </thead>
            <tbody>
              {standingsRows.map((player, index) => (
                <tr key={player.id}>
                  <td>{index + 1}</td>
                  <td>{player.name}</td>
                  <td>
                    {player.wins}W — {player.losses}L
                  </td>
                  <td>{player.rankingScore}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!standingsRows.length && (
            <p className="hint">No players in today&apos;s session yet.</p>
          )}
        </div>
      </section>
    </section>
  );

  if (isLockedPublicView) {
    return (
      <main className="app-shell public-kiosk">
        <section className="hero hero-slim">
          <div>
            <span className="eyebrow">Open play</span>
            <h1>OpenQueue</h1>
            <p>
              {sessionDate}. Live queue and standings. Ask staff for the admin link; this
              page is read-only.
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
          <button
            className={publicPage === 'standings' ? 'primary-button' : 'ghost-button'}
            onClick={() => setPublicViewAndUrl('standings')}
            type="button"
          >
            Standings
          </button>
        </div>
        {publicPage === 'standings' ? renderStandingsView() : renderPlayerView()}
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
          <p>
            Open Play for {sessionDate}. Courts first, then auto-assign, then the
            waiting queue. Player view is shareable by link.
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
            </div>
          </section>

          <section className="court-grid">
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
                        Drop group here or use auto assign
                      </div>
                    </div>
                  )}
                </article>
              );
            })}
          </section>

          <section className="panel suggestions-panel">
            <div className="panel-title">
              <ArrowDownUp />
              <h2>Automatic Assignments</h2>
            </div>
            <div className="suggestion-list">
              {autoAssignments.map((assignment) => (
                <button
                  className="suggestion-card"
                  key={`${assignment.court.id}-${assignment.group.id}`}
                  onClick={() => autoAssignGroup(assignment)}
                >
                  <strong>{assignment.court.name}</strong>
                  <span>
                    {assignment.group.players
                      .map((player) => `${player.name} (L${player.level})`)
                      .join(', ')}
                  </span>
                </button>
              ))}
              {!autoAssignments.length && (
                <p className="hint">No ready court currently matches a full group.</p>
              )}
            </div>
          </section>

          <section
            className="panel queue-panel"
            onDrop={handleQueueDrop}
            onDragOver={(event) => event.preventDefault()}
          >
            <div className="panel-title">
              <UsersRound />
              <h2>Standby Queue</h2>
            </div>
            <p className="hint">
              Winners receive a higher wait priority when they return. Drag a
              four-player group to a court, or use a suggested assignment.
            </p>

            {waitingPlayers.length > 0 && waitingPlayers.length < 4 && (
              <p className="hint">
                Waiting players: {waitingPlayers.length}. Need at least 4 waiting players to form a
                standby group.
              </p>
            )}

            <div className="queue-grid">
              {queueGroups.map((group) => {
                const canUseSelectedCourt =
                  Boolean(selectedCourt) &&
                  group.compatibleCourtIds.includes(selectedCourtId);

                return (
                  <article
                    className={groupClassName(canUseSelectedCourt)}
                    draggable
                    key={group.id}
                    onDragStart={(event) =>
                      handleDragStart(event, {
                        type: 'group',
                        groupId: group.id,
                        playerIds: group.playerIds,
                      })
                    }
                  >
                    <div className="queue-card-header">
                      <span>
                        <GripVertical size={16} />
                        Group of 4
                      </span>
                      <small>Avg L{group.averageLevel.toFixed(1)}</small>
                    </div>
                    <div className="player-stack">
                      {group.players.map((player) => (
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
                        >
                          <span>
                            {player.name}
                            <small>{scoreLabel(player)}</small>
                          </span>
                          <span
                            className="color-dot"
                            style={{
                              background: player.gripColor || '#94a3b8',
                            }}
                          />
                        </div>
                      ))}
                    </div>
                    <div className="compatibility-list">
                      Can play:{' '}
                      {group.compatibleCourtIds.length
                        ? group.compatibleCourtIds
                            .map((courtId) =>
                              courts.find((court) => court.id === courtId)?.name,
                            )
                            .join(', ')
                        : 'No court fits'}
                    </div>
                  </article>
                );
              })}

              {!queueGroups.length && (
                <div className="empty-state">
                  {waitingPlayers.length < 4
                    ? 'Add at least four waiting players to form the first group.'
                    : 'No groups can be formed right now.'}
                  {waitingPlayers.length > 0 && waitingPlayers.length < 4 ? (
                    <div className="waiting-preview">
                      {waitingPlayers.map((player) => (
                        <span className="waiting-chip" key={player.id}>
                          {player.name}
                        </span>
                      ))}
                    </div>
                  ) : null}
                </div>
              )}
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
                    <th>Name</th>
                    <th>Status</th>
                    <th>Lvl</th>
                    <th>Min</th>
                    <th>Max</th>
                    <th>Paddle</th>
                    <th>Record</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {rosterActive.map((player) => (
                    <tr key={player.id}>
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
                      <td>{scoreLabel(player)}</td>
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
                      <td colSpan={9}>Left or unavailable (still listed for today)</td>
                    </tr>
                  )}
                  {rosterInactive.map((player) => (
                    <tr className="roster-inactive" key={player.id}>
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
                      <td>{scoreLabel(player)}</td>
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
    </main>
  );
}
