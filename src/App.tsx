import {
  ArrowDownUp,
  CheckCircle2,
  Clock3,
  GripVertical,
  Plus,
  RotateCcw,
  Settings,
  Trophy,
  UserRound,
  UsersRound,
} from 'lucide-react';
import { DragEvent, FormEvent, useEffect, useMemo, useState } from 'react';
import {
  AutoAssignment,
  Court,
  CourtStatus,
  DragData,
  Match,
  MatchTeam,
  Player,
  PlayerForm,
} from './types';
import {
  buildAutoAssignments,
  createGroupsFromAvailablePlayers,
  formatElapsedTime,
  getAvailablePlayers,
  getElapsedSeconds,
} from './scheduler';
import './styles.css';

const DEFAULT_FORM: PlayerForm = {
  name: '',
  level: 2,
  minLevel: 1,
  maxLevel: 4,
  paddle: '',
  gripColor: '',
  preferredPartnerName: '',
  arrivalStatus: 'present',
};

const DEFAULT_COURTS = 4;
const DEFAULT_MAX_MINUTES = 15;
const LEVELS = [1, 2, 3, 4, 5];

const createInitialCourts = (): Court[] =>
  Array.from({ length: DEFAULT_COURTS }, (_, index) => ({
    id: `court-${index + 1}`,
    name: `Court ${index + 1}`,
    minLevel: Math.max(1, index + 1),
    maxLevel: Math.min(5, index + 2),
    status: 'ready',
    match: null,
  }));

const buildPlayer = (form: PlayerForm): Player => ({
  id: crypto.randomUUID(),
  name: form.name.trim(),
  level: Number(form.level),
  minLevel: Number(form.minLevel),
  maxLevel: Number(form.maxLevel),
  paddle: form.paddle.trim(),
  gripColor: form.gripColor.trim(),
  preferredPartnerName: form.preferredPartnerName.trim(),
  partnerId: null,
  arrivalStatus: form.arrivalStatus,
  wins: 0,
  losses: 0,
  gamesPlayed: 0,
  waitScore: 0,
  lastResult: null,
  lockedGroupId: null,
});

const scoreLabel = (player: Player) =>
  `${player.wins}W-${player.losses}L / L${player.level}`;

const teamLabel = (team: MatchTeam) =>
  team.players.map((player) => player.name).join(' & ');

const groupClassName = (canUseSelectedCourt: boolean) =>
  canUseSelectedCourt ? 'queue-card compatible' : 'queue-card';

export default function App() {
  const [players, setPlayers] = useState<Player[]>([]);
  const [courts, setCourts] = useState<Court[]>(createInitialCourts);
  const [form, setForm] = useState<PlayerForm>(DEFAULT_FORM);
  const [maxMinutes, setMaxMinutes] = useState(DEFAULT_MAX_MINUTES);
  const [selectedCourtId, setSelectedCourtId] = useState('court-1');
  const [now, setNow] = useState(0);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

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

  const handlePlayerSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (!form.name.trim()) {
      return;
    }

    const player = buildPlayer(form);
    setPlayers((currentPlayers) => [...currentPlayers, player]);
    setForm(DEFAULT_FORM);
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
            maxLevel: 5,
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
      teams: [
        { id: 'team-a', players: groupPlayers.slice(0, 2) },
        { id: 'team-b', players: groupPlayers.slice(2, 4) },
      ],
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
      currentPlayers.map((player) =>
        groupPlayerIds.includes(player.id)
          ? { ...player, arrivalStatus: 'playing' }
          : player,
      ),
    );
  };

  const autoAssignGroup = (assignment: AutoAssignment) => {
    assignGroupToCourt(assignment.court.id, assignment.group.playerIds);
  };

  const startMatch = (courtId: string) => {
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
  };

  const closeMatch = (courtId: string, winningTeamId: string) => {
    const court = courts.find((item) => item.id === courtId);

    if (!court?.match) {
      return;
    }

    const matchPlayerIds = court.match.teams.flatMap((team) =>
      team.players.map((player) => player.id),
    );
    const winnerIds = court.match.teams
      .find((team) => team.id === winningTeamId)
      ?.players.map((player) => player.id);

    if (!winnerIds) {
      return;
    }

    setPlayers((currentPlayers) =>
      currentPlayers.map((player) => {
        if (!matchPlayerIds.includes(player.id)) {
          return player;
        }

        const isWinner = winnerIds.includes(player.id);

        return {
          ...player,
          arrivalStatus: 'present',
          wins: player.wins + (isWinner ? 1 : 0),
          losses: player.losses + (isWinner ? 0 : 1),
          gamesPlayed: player.gamesPlayed + 1,
          waitScore: isWinner ? player.waitScore + 2 : player.waitScore + 1,
          lastResult: isWinner ? 'won' : 'lost',
        };
      }),
    );

    updateCourt(courtId, { status: 'ready', match: null });
  };

  const resetCourt = (courtId: string) => {
    const court = courts.find((item) => item.id === courtId);

    if (court?.match) {
      const playerIds = court.match.teams.flatMap((team) =>
        team.players.map((player) => player.id),
      );

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

  const updateFormNumber = (field: keyof PlayerForm, value: number) => {
    setForm((currentForm) => ({ ...currentForm, [field]: value }));
  };

  return (
    <main className="app-shell">
      <section className="hero">
        <div>
          <span className="eyebrow">Admin-only open play manager</span>
          <h1>OpenQueue</h1>
          <p>
            Stack doubles groups, route them to compatible courts, and keep the
            room moving with visible wait priority, timers, and results.
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
            <strong>{courts.length}</strong>
            <span>courts</span>
          </div>
        </div>
      </section>

      <section className="layout">
        <aside className="panel admin-panel">
          <div className="panel-title">
            <UserRound />
            <h2>Add Player</h2>
          </div>

          <form onSubmit={handlePlayerSubmit} className="player-form">
            <label>
              Player name
              <input
                value={form.name}
                onChange={(event) =>
                  setForm({ ...form, name: event.target.value })
                }
                placeholder="Jane Smith"
              />
            </label>
            <div className="form-grid">
              <label>
                Level
                <select
                  value={form.level}
                  onChange={(event) =>
                    updateFormNumber('level', Number(event.target.value))
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
                Paddle
                <input
                  value={form.paddle}
                  onChange={(event) =>
                    setForm({ ...form, paddle: event.target.value })
                  }
                  placeholder="Selkirk"
                />
              </label>
            </div>
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
                value={form.gripColor}
                onChange={(event) =>
                  setForm({ ...form, gripColor: event.target.value })
                }
                placeholder="Blue"
              />
            </label>
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
                              courts.find((court) => court.id === courtId)
                                ?.name,
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
                      {court.match.teams.map((team) => (
                        <div className="team-row" key={team.id}>
                          <strong>{team.id === 'team-a' ? 'Team A' : 'Team B'}</strong>
                          <span>{teamLabel(team)}</span>
                          {court.status === 'playing' && (
                            <button
                              className="ghost-button"
                              onClick={(event) => {
                                event.stopPropagation();
                                closeMatch(court.id, team.id);
                              }}
                            >
                              <Trophy size={16} />
                              Won
                            </button>
                          )}
                        </div>
                      ))}
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
                    {player.paddle || 'No paddle'} · {player.gripColor || 'No grip'}
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
        </aside>
      </section>
    </main>
  );
}
