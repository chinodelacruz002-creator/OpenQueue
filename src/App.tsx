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
import { DragEvent, useCallback, useEffect, useMemo, useState } from 'react';
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

const getInitialViewParam = () => new URLSearchParams(window.location.search).get('view');
const isLockedPublicView = (() => {
  const param = getInitialViewParam();
  return param === 'player' || param === 'standings';
})();

interface BulkPlayerRow extends PlayerForm {
  rowId: string;
  savedPlayerId: string;
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
  arrivalStatus: 'present',
});

const createBulkRows = () => Array.from({ length: 40 }, createBulkRow);

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

const buildPlayer = (form: PlayerForm, savedPlayer?: SavedPlayer): Player => ({
  id: crypto.randomUUID(),
  persistentId: savedPlayer?.id ?? null,
  name: form.name.trim(),
  level: Number(form.level),
  minLevel: Number(form.minLevel),
  maxLevel: Number(form.maxLevel),
  paddle: form.paddle.trim(),
  gripColor: form.gripColor.trim(),
  preferredPartnerName: form.preferredPartnerName.trim(),
  partnerId: null,
  arrivalStatus: form.arrivalStatus,
  wins: savedPlayer?.wins ?? 0,
  losses: savedPlayer?.losses ?? 0,
  gamesPlayed: savedPlayer?.gamesPlayed ?? 0,
  waitScore: 0,
  lastResult: null,
  lockedGroupId: null,
  rankingScore: savedPlayer?.rankingScore ?? 0,
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

const isPlayerCompatibleWithCourt = (player: Player, court: Court): boolean =>
  player.maxLevel >= court.minLevel && player.minLevel <= court.maxLevel;

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
  const [now, setNow] = useState(0);

  const goToViewMode = (mode: 'admin' | 'player') => {
    if (isLockedPublicView) {
      return;
    }
    setViewMode(mode);
  };

  const setPublicViewAndUrl = (page: 'queue' | 'standings') => {
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
        void loadOpenPlayData().then((data) => applyLoad(data, 'sync'));
      }, 25000);
    } else if (needsPoll) {
      timer = window.setInterval(() => {
        void loadOpenPlayData().then((data) => applyLoad(data, 'sync'));
      }, 5000);
    }
    return () => {
      if (timer) {
        window.clearInterval(timer);
      }
    };
  }, [applyLoad, hasSupabaseConfig, isLockedPublicView, viewMode]);

  useEffect(() => {
    if (isLockedPublicView) {
      return;
    }
    const saveTimer = window.setTimeout(() => {
      const data: AppData = {
        sessionDate,
        players,
        courts,
        maxMinutes,
        savedPlayers,
        savedPaddles: paddleOptions,
        savedGripColors: gripColorOptions,
      };

      saveOpenPlayData(data)
        .then(() => setSaveStatus(hasSupabaseConfig ? 'Connected to Supabase' : 'Local-only (this browser)'))
        .catch(() => setSaveStatus('Save failed'));
    }, SAVE_DEBOUNCE_MS);

    return () => window.clearTimeout(saveTimer);
  }, [courts, gripColorOptions, maxMinutes, paddleOptions, players, savedPlayers, sessionDate]);

  const availablePlayers = useMemo(
    () => getAvailablePlayers(players),
    [players],
  );

  const waitingPlayers = availablePlayers;

  const queueGroups = useMemo(
    () => createGroupsFromAvailablePlayers(availablePlayers, courts),
    [availablePlayers, courts],
  );

  const selectedCourt = courts.find((court) => court.id === selectedCourtId);

  const autoAssignments = useMemo(
    () => buildAutoAssignments(courts, queueGroups),
    [courts, queueGroups],
  );

  const playerQueueRows = useMemo(
    () =>
      queueGroups.flatMap((group, groupIndex) =>
        group.players.map((player) => ({
          player,
          queuePosition: groupIndex + 1,
          groupMates: group.players.filter((groupPlayer) => groupPlayer.id !== player.id),
        })),
      ),
    [queueGroups],
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

  const updateKnownOptions = (addedPlayers: Player[]) => {
    setPaddleOptions((currentOptions) =>
      mergeOptions(currentOptions, addedPlayers.map((player) => player.paddle)),
    );
    setGripColorOptions((currentOptions) =>
      mergeOptions(currentOptions, addedPlayers.map((player) => player.gripColor)),
    );
  };

  const addPlayersToSession = (newPlayers: Player[]) => {
    if (!newPlayers.length) {
      return;
    }

    setPlayers((currentPlayers) => [...currentPlayers, ...newPlayers]);
    setSavedPlayers((currentSavedPlayers) =>
      newPlayers.reduce(
        (savedList, player) => upsertSavedPlayer(savedList, buildSavedPlayer(player)),
        currentSavedPlayers,
      ),
    );
    updateKnownOptions(newPlayers);
  };

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
      gripColor: savedPlayer.gripColor,
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
    setBulkRows((currentRows) =>
      currentRows.map((row) =>
        row.rowId === rowId ? { ...createBulkRow(), rowId: row.rowId } : row,
      ),
    );
  };

  const handleBulkAdd = () => {
    setBulkAddError('');

    const namedRows = bulkRows.filter((row) => row.name.trim());
    const seenInForm = new Set<string>();

    for (const row of namedRows) {
      const key = normalizePlayerName(row.name);
      if (seenInForm.has(key)) {
        setBulkAddError('Duplicate name in the form. Remove or fix duplicate rows.');
        return;
      }
      seenInForm.add(key);
    }

    const waitingNames = new Set(
      players
        .filter((player) => player.arrivalStatus === 'present')
        .map((player) => normalizePlayerName(player.name)),
    );
    for (const row of namedRows) {
      if (waitingNames.has(normalizePlayerName(row.name))) {
        setBulkAddError(
          `Already in the waiting queue: ${row.name.trim()}. You cannot add the same person twice.`,
        );
        return;
      }
    }

    const onCourt = new Set(
      players
        .filter(
          (player) => player.arrivalStatus === 'assigned' || player.arrivalStatus === 'playing',
        )
        .map((player) => normalizePlayerName(player.name)),
    );
    for (const row of namedRows) {
      if (onCourt.has(normalizePlayerName(row.name))) {
        setBulkAddError(
          `This person is already on a court: ${row.name.trim()}. Finish or reset the match first.`,
        );
        return;
      }
    }

    const newPlayers = namedRows.map((row) => {
      const savedPlayer = savedPlayers.find((player) => player.id === row.savedPlayerId);
      return buildPlayer(row, savedPlayer);
    });

    addPlayersToSession(newPlayers);
    setBulkRows(createBulkRows());
    setIsBulkModalOpen(false);
  };

  const updatePlayer = (playerId: string, updates: Partial<Player>) => {
    setPlayers((currentPlayers) =>
      currentPlayers.map((player) =>
        player.id === playerId ? { ...player, ...updates } : player,
      ),
    );
  };

  const updateCourtCount = (count: number) => {
    const safeCount = Math.max(1, count);

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
        !currentPlayerIds.has(player.id) && isPlayerCompatibleWithCourt(player, court),
    );
  };

  const markPlayerLeft = (playerId: string) => {
    updatePlayer(playerId, { arrivalStatus: 'left' });
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
      return;
    }

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
  };

  const autoAssignGroup = (assignment: AutoAssignment) => {
    assignGroupToCourt(assignment.court.id, assignment.group.playerIds);
  };

  const startMatch = (courtId: string) => {
    const court = courts.find((item) => item.id === courtId);
    const playerIds = court?.match ? getPlayerIdsInMatch(court.match) : [];

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
  };

  const toggleMatchWinner = (courtId: string, playerId: string) => {
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
  };

  const closeMatch = (courtId: string) => {
    const court = courts.find((item) => item.id === courtId);

    if (!court?.match) {
      return;
    }

    const matchPlayerIds = getPlayerIdsInMatch(court.match);
    const winnerIds = court.match.winnerIds;

    setPlayers((currentPlayers) => {
      const updatedPlayers = currentPlayers.map((player) => {
        if (!matchPlayerIds.includes(player.id)) {
          return player;
        }

        const isWinner = winnerIds.includes(player.id);
        const updatedPlayer = {
          ...player,
          arrivalStatus: 'present' as const,
          wins: player.wins + (isWinner ? 1 : 0),
          losses: player.losses + (isWinner ? 0 : 1),
          gamesPlayed: player.gamesPlayed + 1,
          waitScore: player.waitScore + (isWinner ? 2 : 1),
          rankingScore: player.rankingScore + (isWinner ? 3 : 0),
          lastResult: isWinner ? 'won' as const : 'lost' as const,
        };

        setSavedPlayers((currentSavedPlayers) =>
          upsertSavedPlayer(currentSavedPlayers, buildSavedPlayer(updatedPlayer)),
        );
        return updatedPlayer;
      });

      return updatedPlayers;
    });

    updateCourt(courtId, { status: 'ready', match: null });
  };

  const resetCourt = (courtId: string) => {
    const court = courts.find((item) => item.id === courtId);

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
  };

  const removeLoadedPlayer = (courtId: string, removedPlayerId: string) => {
    const court = courts.find((item) => item.id === courtId);

    if (!court?.match || court.status === 'playing') {
      return;
    }

    const replacement = findReplacementPlayer(court, removedPlayerId);

    if (!replacement) {
      setPlayers((currentPlayers) =>
        currentPlayers.map((player) =>
          player.id === removedPlayerId ? { ...player, arrivalStatus: 'away' } : player,
        ),
      );
      updateCourt(courtId, {
        status: 'ready',
        match: null,
      });
      return;
    }

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
  };

  const handleDragStart = (
    event: DragEvent<HTMLElement>,
    data: DragData,
  ) => {
    event.dataTransfer.setData('application/json', JSON.stringify(data));
    event.dataTransfer.effectAllowed = 'move';
  };

  const handleCourtDrop = (
    event: DragEvent<HTMLElement>,
    courtId: string,
  ) => {
    event.preventDefault();
    const rawData = event.dataTransfer.getData('application/json');
    const data = JSON.parse(rawData) as DragData;

    if (data.type === 'group') {
      assignGroupToCourt(courtId, data.playerIds);
      return;
    }

    setSelectedCourtId(courtId);
  };

  const handleQueueDrop = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    const rawData = event.dataTransfer.getData('application/json');
    const data = JSON.parse(rawData) as DragData;

    if (data.type !== 'player') {
      return;
    }

    setPlayers((currentPlayers) =>
      currentPlayers.map((player) =>
        player.id === data.playerId
          ? { ...player, arrivalStatus: 'present' }
          : player,
      ),
    );
  };

  const renderBulkModal = () => (
    <div className="modal-backdrop" role="presentation">
      <section className="bulk-modal" aria-labelledby="bulk-add-title" role="dialog">
        <div className="modal-header bulk-modal-header">
          <div>
            <h2 id="bulk-add-title">Bulk Add Players</h2>
            <p>
              Type a new player or select an existing saved player. Existing
              players auto-fill paddle, level, and grip color.
            </p>
          </div>
          <div className="bulk-modal-header-actions">
            <button
              className="ghost-button"
              type="button"
              onClick={resetBulkRows}
            >
              Reset rows
            </button>
            <button className="primary-button" type="button" onClick={handleBulkAdd}>
              Add players
            </button>
            <button
              className="ghost-button"
              type="button"
              onClick={() => {
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
                    <th>Grip</th>
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
                          onChange={(event) => updateBulkName(row.rowId, event.target.value)}
                          placeholder="Player"
                        />
                      </td>
                      <td>
                        <select
                          value={row.level}
                          onChange={(event) =>
                            updateBulkLevel(row.rowId, Number(event.target.value))
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
                            updateBulkRow(row.rowId, {
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
                          value={row.maxLevel}
                          onChange={(event) =>
                            updateBulkRow(row.rowId, {
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
                          value={row.paddle}
                          onChange={(event) =>
                            updateBulkRow(row.rowId, { paddle: event.target.value })
                          }
                          placeholder="Paddle"
                        />
                      </td>
                      <td>
                        <input
                          list="grip-color-options"
                          value={row.gripColor}
                          onChange={(event) =>
                            updateBulkRow(row.rowId, { gripColor: event.target.value })
                          }
                          placeholder="Color"
                        />
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
          <datalist id="grip-color-options">
            {gripColorOptions.map((option) => (
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
            onClick={() => setIsSettingsModalOpen(false)}
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
              onChange={(event) => setSessionDate(event.target.value)}
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
              onChange={(event) => setMaxMinutes(Number(event.target.value))}
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
          <h2>Your queue</h2>
        </div>
        <div className="public-list">
          {playerQueueRows.map((row) => (
            <article className="public-card" key={row.player.id}>
              <strong>
                Group #{row.queuePosition} — {row.player.name}
              </strong>
              <span>
                Waiting with:{' '}
                {row.groupMates.length
                  ? row.groupMates.map((player) => player.name).join(', ')
                  : 'forming group'}
              </span>
              <small>{scoreLabel(row.player)} · Standby</small>
            </article>
          ))}
          {!playerQueueRows.length && (
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
                  Levels {court.minLevel}-{court.maxLevel} · {court.status}
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
                  setBulkAddError('');
                  setIsBulkModalOpen(true);
                }}
              >
                <Plus size={18} />
                Add / edit players
              </button>
              <button
                className="ghost-button"
                type="button"
                onClick={() => setIsSettingsModalOpen(true)}
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
                  onClick={() => setSelectedCourtId(court.id)}
                  onDrop={(event) => handleCourtDrop(event, court.id)}
                  onDragOver={(event) => event.preventDefault()}
                >
                  <div className="court-header">
                    <div>
                      <input
                        aria-label={`${court.name} name`}
                        value={court.name}
                        onChange={(event) =>
                          updateCourt(court.id, { name: event.target.value })
                        }
                      />
                      <span>
                        Levels {court.minLevel}-{court.maxLevel}
                      </span>
                    </div>
                    <select
                      value={court.status}
                      onChange={(event) =>
                        updateCourt(court.id, {
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

                  <div className="level-settings">
                    <label>
                      Min
                      <select
                        value={court.minLevel}
                        onChange={(event) =>
                          updateCourt(court.id, {
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
                    </label>
                    <label>
                      Max
                      <select
                        value={court.maxLevel}
                        onChange={(event) =>
                          updateCourt(court.id, {
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
                    </label>
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
                    <div className="drop-zone">
                      <CheckCircle2 />
                      Drop group here or use auto assign
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
                    <th>Grip</th>
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
                            updatePlayer(player.id, { name: event.target.value })
                          }
                        />
                      </td>
                      <td>
                        <select
                          value={player.arrivalStatus}
                          onChange={(event) =>
                            updatePlayer(player.id, {
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
                            updatePlayer(player.id, {
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
                            updatePlayer(player.id, { minLevel: Number(event.target.value) })
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
                            updatePlayer(player.id, { maxLevel: Number(event.target.value) })
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
                            updatePlayer(player.id, { paddle: event.target.value })
                          }
                        />
                      </td>
                      <td>
                        <input
                          list="grip-color-options"
                          value={player.gripColor}
                          onChange={(event) =>
                            updatePlayer(player.id, { gripColor: event.target.value })
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
                            updatePlayer(player.id, { name: event.target.value })
                          }
                        />
                      </td>
                      <td>
                        <select
                          value={player.arrivalStatus}
                          onChange={(event) =>
                            updatePlayer(player.id, {
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
                            updatePlayer(player.id, {
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
                            updatePlayer(player.id, { minLevel: Number(event.target.value) })
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
                            updatePlayer(player.id, { maxLevel: Number(event.target.value) })
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
                            updatePlayer(player.id, { paddle: event.target.value })
                          }
                        />
                      </td>
                      <td>
                        <input
                          list="grip-color-options"
                          value={player.gripColor}
                          onChange={(event) =>
                            updatePlayer(player.id, { gripColor: event.target.value })
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
            {!players.length && <p className="hint">Use Add / edit players to start.</p>}
          </section>
        </section>
      )}
    </main>
  );
}
