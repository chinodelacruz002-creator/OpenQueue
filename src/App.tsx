import {
  ArrowDownUp,
  CheckCircle2,
  Clock3,
  Database,
  GripVertical,
  Plus,
  RotateCcw,
  Save,
  Settings,
  Trophy,
  UserRound,
  UsersRound,
} from 'lucide-react';
import { DragEvent, FormEvent, useEffect, useMemo, useState } from 'react';
import { GRIP_COLOR_OPTIONS, LEVELS, PADDLE_OPTIONS, getLevelRange } from './constants';
import {
  buildAutoAssignments,
  createGroupsFromAvailablePlayers,
  formatElapsedTime,
  getAvailablePlayers,
  getElapsedSeconds,
} from './scheduler';
import { hasSupabaseConfig, loadOpenPlayData, saveOpenPlayData } from './storage';
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

const todayKey = () => new Date().toISOString().slice(0, 10);

const createDefaultForm = (): PlayerForm => ({
  name: '',
  level: 3,
  ...getLevelRange(3),
  paddle: '',
  gripColor: '',
  preferredPartnerName: '',
  arrivalStatus: 'present',
});

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

const buildPlayerFromSaved = (savedPlayer: SavedPlayer): Player =>
  buildPlayer(
    {
      name: savedPlayer.name,
      level: savedPlayer.level,
      minLevel: savedPlayer.minLevel,
      maxLevel: savedPlayer.maxLevel,
      paddle: savedPlayer.paddle,
      gripColor: savedPlayer.gripColor,
      preferredPartnerName: savedPlayer.preferredPartnerName,
      arrivalStatus: 'present',
    },
    savedPlayer,
  );

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

const parseBulkPlayers = (rawText: string, form: PlayerForm): Player[] =>
  rawText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [name, levelText, paddle, gripColor, preferredPartnerName] = line
        .split(/\t|,/)
        .map((value) => value.trim());
      const level = Number(levelText) || form.level;
      const range = getLevelRange(level);

      return buildPlayer({
        ...form,
        name,
        level,
        minLevel: range.minLevel,
        maxLevel: range.maxLevel,
        paddle: paddle || form.paddle,
        gripColor: gripColor || form.gripColor,
        preferredPartnerName: preferredPartnerName || '',
      });
    });

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
  const [players, setPlayers] = useState<Player[]>([]);
  const [savedPlayers, setSavedPlayers] = useState<SavedPlayer[]>([]);
  const [paddleOptions, setPaddleOptions] = useState(PADDLE_OPTIONS);
  const [gripColorOptions, setGripColorOptions] = useState(GRIP_COLOR_OPTIONS);
  const [courts, setCourts] = useState<Court[]>(createInitialCourts);
  const [form, setForm] = useState<PlayerForm>(createDefaultForm);
  const [bulkText, setBulkText] = useState('');
  const [maxMinutes, setMaxMinutes] = useState(DEFAULT_MAX_MINUTES);
  const [selectedCourtId, setSelectedCourtId] = useState('court-1');
  const [sessionDate, setSessionDate] = useState(todayKey);
  const [saveStatus, setSaveStatus] = useState('Loading saved players...');
  const [viewMode, setViewMode] = useState<'admin' | 'player'>('admin');
  const [now, setNow] = useState(0);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    let mounted = true;

    loadOpenPlayData().then((data) => {
      if (!mounted) {
        return;
      }

      const appData = data ?? createAppData();
      setSessionDate(appData.sessionDate || todayKey());
      setPlayers(appData.players ?? []);
      setSavedPlayers(appData.savedPlayers ?? []);
      setPaddleOptions(mergeOptions(PADDLE_OPTIONS, appData.savedPaddles ?? []));
      setGripColorOptions(mergeOptions(GRIP_COLOR_OPTIONS, appData.savedGripColors ?? []));
      setSaveStatus(hasSupabaseConfig ? 'Loaded from Supabase' : 'Loaded from this browser');
    });

    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    const saveTimer = window.setTimeout(() => {
      const data: AppData = {
        sessionDate,
        players,
        savedPlayers,
        savedPaddles: paddleOptions,
        savedGripColors: gripColorOptions,
      };

      saveOpenPlayData(data)
        .then(() => setSaveStatus(hasSupabaseConfig ? 'Saved to Supabase' : 'Saved locally'))
        .catch(() => setSaveStatus('Save failed'));
    }, SAVE_DEBOUNCE_MS);

    return () => window.clearTimeout(saveTimer);
  }, [gripColorOptions, paddleOptions, players, savedPlayers, sessionDate]);

  const availablePlayers = useMemo(
    () => getAvailablePlayers(players),
    [players],
  );

  const queueGroups = useMemo(
    () => createGroupsFromAvailablePlayers(availablePlayers, courts),
    [availablePlayers, courts],
  );

  const selectedCourt = courts.find((court) => court.id === selectedCourtId);

  const autoAssignments = useMemo(
    () => buildAutoAssignments(courts, queueGroups),
    [courts, queueGroups],
  );

  const activePlayerNames = useMemo(
    () => new Set(players.map((player) => player.name.toLowerCase())),
    [players],
  );

  const playerQueueRows = useMemo(
    () =>
      players.map((player) => {
        const loadedCourt = courts.find((court) =>
          court.match?.players.some((matchPlayer) => matchPlayer.id === player.id),
        );
        const queueGroupIndex = queueGroups.findIndex((group) =>
          group.playerIds.includes(player.id),
        );
        const queueGroup = queueGroupIndex >= 0 ? queueGroups[queueGroupIndex] : null;

        return {
          player,
          loadedCourt,
          queuePosition: queueGroupIndex >= 0 ? queueGroupIndex + 1 : null,
          groupMates:
            queueGroup?.players.filter((groupPlayer) => groupPlayer.id !== player.id) ?? [],
        };
      }),
    [courts, players, queueGroups],
  );

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

  const handlePlayerSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (!form.name.trim()) {
      return;
    }

    const matchingSavedPlayer = savedPlayers.find(
      (player) => player.name.toLowerCase() === form.name.trim().toLowerCase(),
    );
    addPlayersToSession([buildPlayer(form, matchingSavedPlayer)]);
    setForm(createDefaultForm());
  };

  const handleBulkAdd = () => {
    const parsedPlayers = parseBulkPlayers(bulkText, form);
    addPlayersToSession(parsedPlayers);
    setBulkText('');
  };

  const addSavedPlayerToSession = (savedPlayer: SavedPlayer) => {
    if (activePlayerNames.has(savedPlayer.name.toLowerCase())) {
      return;
    }

    addPlayersToSession([buildPlayerFromSaved(savedPlayer)]);
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

  const togglePlayerAvailability = (playerId: string) => {
    setPlayers((currentPlayers) =>
      currentPlayers.map((player) =>
        player.id === playerId
          ? {
              ...player,
              arrivalStatus:
                player.arrivalStatus === 'present' ? 'away' : 'present',
            }
          : player,
      ),
    );
  };

  const removePlayer = (playerId: string) => {
    setPlayers((currentPlayers) =>
      currentPlayers.filter((player) => player.id !== playerId),
    );
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

  const updateFormLevel = (level: number) => {
    setForm((currentForm) => ({
      ...currentForm,
      level,
      ...getLevelRange(level),
    }));
  };

  const updateFormNumber = (field: keyof PlayerForm, value: number) => {
    setForm((currentForm) => ({ ...currentForm, [field]: value }));
  };

  const renderPlayerView = () => (
    <section className="player-view">
      <section className="panel player-queue-panel">
        <div className="panel-title">
          <UsersRound />
          <h2>Your Queue</h2>
        </div>
        <div className="public-list">
          {playerQueueRows.map((row) => (
            <article className="public-card" key={row.player.id}>
              <strong>
                {row.queuePosition ? `#${row.queuePosition}` : row.loadedCourt?.name ?? '-'}{' '}
                {row.player.name}
              </strong>
              <span>
                {row.loadedCourt
                  ? `Assigned with ${row.loadedCourt.match?.players
                      .filter((player) => player.id !== row.player.id)
                      .map((player) => player.name)
                      .join(', ')}`
                  : `Waiting with ${
                      row.groupMates.length
                        ? row.groupMates.map((player) => player.name).join(', ')
                        : 'forming group'
                    }`}
              </span>
              <small>
                {row.loadedCourt
                  ? `${row.loadedCourt.name} · ${row.loadedCourt.status}`
                  : row.queuePosition
                    ? 'Standby queue'
                    : row.player.arrivalStatus}
              </small>
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
          <h2>Now Playing / Loaded</h2>
        </div>
        <div className="public-list">
          {courts.map((court) => {
            const elapsedSeconds = getElapsedSeconds(court.match, now);
            const playerNames = court.match?.players.map((player) => player.name).join(', ');

            return (
              <article className="public-card court-public-card" key={court.id}>
                <strong>{court.name}</strong>
                <span>
                  {playerNames ||
                    (court.status === 'reserved' ? 'Reserved' : 'Available for next group')}
                </span>
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

  return (
    <main className="app-shell">
      <section className="hero">
        <div>
          <span className="eyebrow">Admin-only open play manager</span>
          <h1>OpenQueue</h1>
          <p>
            Open Play for {sessionDate}. Add players once, reuse saved profiles,
            stack doubles groups, and score winners person by person.
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
          onClick={() => setViewMode('admin')}
        >
          Admin View
        </button>
        <button
          className={viewMode === 'player' ? 'primary-button' : 'ghost-button'}
          onClick={() => setViewMode('player')}
        >
          Player Queue View
        </button>
      </div>

      {viewMode === 'player' ? (
        renderPlayerView()
      ) : (
        <section className="layout">
        <aside className="panel admin-panel">
          <div className="panel-title">
            <UserRound />
            <h2>Add Player</h2>
          </div>

          <label>
            Open Play Date
            <input
              type="date"
              value={sessionDate}
              onChange={(event) => setSessionDate(event.target.value)}
            />
          </label>
          <p className="hint lock-note">
            This locks the screen to one open play session date. Saved player
            profiles stay reusable for future dates.
          </p>

          <form onSubmit={handlePlayerSubmit} className="player-form">
            <label>
              Player name
              <input
                list="saved-player-names"
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
                placeholder="Jane Smith"
              />
            </label>
            <datalist id="saved-player-names">
              {savedPlayers.map((player) => (
                <option value={player.name} key={player.id} />
              ))}
            </datalist>

            <div className="form-grid">
              <label>
                Level
                <select
                  value={form.level}
                  onChange={(event) => updateFormLevel(Number(event.target.value))}
                >
                  {LEVELS.map((level) => (
                    <option value={level} key={level}>
                      {level}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Paddle
                <input
                  list="paddle-options"
                  value={form.paddle}
                  onChange={(event) => setForm({ ...form, paddle: event.target.value })}
                  placeholder="Selkirk Boomstik"
                />
              </label>
            </div>
            <datalist id="paddle-options">
              {paddleOptions.map((option) => (
                <option value={option} key={option} />
              ))}
            </datalist>

            <div className="form-grid">
              <label>
                Min level
                <select
                  value={form.minLevel}
                  onChange={(event) =>
                    updateFormNumber('minLevel', Number(event.target.value))
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
                Max level
                <select
                  value={form.maxLevel}
                  onChange={(event) =>
                    updateFormNumber('maxLevel', Number(event.target.value))
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

            <label>
              Grip color
              <input
                list="grip-color-options"
                value={form.gripColor}
                onChange={(event) => setForm({ ...form, gripColor: event.target.value })}
                placeholder="Blue"
              />
            </label>
            <datalist id="grip-color-options">
              {gripColorOptions.map((option) => (
                <option value={option} key={option} />
              ))}
            </datalist>

            <label>
              Preferred partner
              <input
                value={form.preferredPartnerName}
                onChange={(event) =>
                  setForm({
                    ...form,
                    preferredPartnerName: event.target.value,
                  })
                }
                placeholder="Optional"
              />
            </label>
            <button className="primary-button" type="submit">
              <Plus size={18} />
              Add to queue
            </button>
          </form>

          <div className="panel-title compact">
            <UsersRound />
            <h2>Bulk Add</h2>
          </div>
          <textarea
            className="bulk-input"
            value={bulkText}
            onChange={(event) => setBulkText(event.target.value)}
            placeholder="Paste Excel rows: Name, Level, Paddle, Grip Color, Preferred Partner"
          />
          <button className="ghost-button" type="button" onClick={handleBulkAdd}>
            <Plus size={18} />
            Add pasted players
          </button>

          <div className="panel-title compact">
            <Settings />
            <h2>Admin Settings</h2>
          </div>
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

          <div className="storage-status">
            <Database size={16} />
            <span>{saveStatus}</span>
          </div>
        </aside>

        <section className="main-board">
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
                <div className="empty-state">Add at least four available players.</div>
              )}
            </div>
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
                    <div className="match-card">
                      <div className={`timer ${isOverTime ? 'overtime' : ''}`}>
                        <Clock3 size={18} />
                        {formatElapsedTime(elapsedSeconds)} /{' '}
                        {court.match.durationMinutes}:00
                      </div>
                      <div className="match-player-grid">
                        {court.match.players.map((player) => {
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
        </section>

        <aside className="panel roster-panel">
          <div className="panel-title">
            <UsersRound />
            <h2>Roster</h2>
          </div>
          <div className="roster-list">
            {players.map((player) => (
              <article className="roster-card" key={player.id}>
                <div>
                  <strong>{player.name}</strong>
                  <span>
                    L{player.level} accepts {player.minLevel}-{player.maxLevel}
                  </span>
                  <small>
                    {player.paddle || 'No paddle'} · {player.gripColor || 'No grip'} ·{' '}
                    {scoreLabel(player)}
                  </small>
                </div>
                <div className="roster-actions">
                  <button
                    className={
                      player.arrivalStatus === 'present'
                        ? 'status present'
                        : 'status away'
                    }
                    onClick={() => togglePlayerAvailability(player.id)}
                  >
                    {player.arrivalStatus}
                  </button>
                  <button
                    className="ghost-button danger"
                    onClick={() => removePlayer(player.id)}
                  >
                    Left
                  </button>
                </div>
              </article>
            ))}
            {!players.length && (
              <p className="hint">Late arrivals can be added any time.</p>
            )}
          </div>

          <div className="panel-title compact">
            <Save />
            <h2>Saved Players</h2>
          </div>
          <div className="saved-player-list">
            {savedPlayers.map((player) => (
              <button
                className="saved-player-card"
                disabled={activePlayerNames.has(player.name.toLowerCase())}
                key={player.id}
                onClick={() => addSavedPlayerToSession(player)}
              >
                <strong>{player.name}</strong>
                <span>
                  L{player.level} · {player.wins}W-{player.losses}L · Rank{' '}
                  {player.rankingScore}
                </span>
              </button>
            ))}
            {!savedPlayers.length && (
              <p className="hint">Saved profiles appear after players are added.</p>
            )}
          </div>
        </aside>
        </section>
      )}
    </main>
  );
}
