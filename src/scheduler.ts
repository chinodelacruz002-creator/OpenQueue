import type { AutoAssignment, Court, Match, Player, QueueGroup } from './types';

const GROUP_SIZE = 4;

export const getAvailablePlayers = (players: Player[]): Player[] =>
  players
    .filter((player) => player.arrivalStatus === 'present');

export const createGroupsFromAvailablePlayers = (
  players: Player[],
  courts: Court[],
): QueueGroup[] => {
  const neutral: Player[] = [];
  const winners: Player[] = [];
  const losers: Player[] = [];

  for (const player of players) {
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

  const ordered = [...neutral, ...winners, ...losers];
  const unusedPlayers = [...ordered];
  const groups: QueueGroup[] = [];

  while (unusedPlayers.length >= GROUP_SIZE) {
    const anchor = unusedPlayers.shift();
    if (!anchor) {
      break;
    }

    const partner = takePreferredPartner(anchor, unusedPlayers);
    const groupPlayers = partner ? [anchor, partner] : [anchor];

    while (groupPlayers.length < GROUP_SIZE && unusedPlayers.length > 0) {
      const nextPlayer = unusedPlayers.shift();
      if (nextPlayer) {
        groupPlayers.push(nextPlayer);
      }
    }

    if (groupPlayers.length === GROUP_SIZE) {
      groups.push(createQueueGroup(groupPlayers, courts));
    }
  }

  return groups;
};

export const buildAutoAssignments = (
  courts: Court[],
  queueGroups: QueueGroup[],
): AutoAssignment[] => {
  const usedGroupIds = new Set<string>();

  return courts.reduce<AutoAssignment[]>((assignments, court) => {
    if (court.status !== 'ready' || court.match) {
      return assignments;
    }

    const group = queueGroups.find(
      (candidate) =>
        !usedGroupIds.has(candidate.id) &&
        candidate.compatibleCourtIds.includes(court.id),
    );

    if (!group) {
      return assignments;
    }

    usedGroupIds.add(group.id);
    assignments.push({ court, group });
    return assignments;
  }, []);
};

export const getElapsedSeconds = (match: Match | null, now: number): number => {
  if (!match?.startedAt) {
    return 0;
  }

  return Math.floor((now - match.startedAt) / 1000);
};

export const formatElapsedTime = (seconds: number): string => {
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;

  return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
};

const takePreferredPartner = (
  anchor: Player,
  candidates: Player[],
): Player | undefined => {
  if (!anchor.preferredPartnerName) {
    return undefined;
  }

  const partnerIndex = candidates.findIndex(
    (candidate) =>
      candidate.name.toLowerCase() === anchor.preferredPartnerName.toLowerCase(),
  );

  if (partnerIndex < 0) {
    return undefined;
  }

  return candidates.splice(partnerIndex, 1).at(0);
};

const createQueueGroup = (players: Player[], courts: Court[]): QueueGroup => {
  const averageLevel = getAverageLevel(players);
  const minLevel = Math.min(...players.map((player) => player.level));
  const maxLevel = Math.max(...players.map((player) => player.level));

  return {
    id: players.map((player) => player.id).join('-'),
    playerIds: players.map((player) => player.id),
    players,
    averageLevel,
    minLevel,
    maxLevel,
    compatibleCourtIds: courts.filter(() => isGroupCompatibleWithCourt()).map((court) => court.id),
    priorityScore: players.reduce(
      (sum, player) =>
        sum + player.waitScore + player.rankingScore + player.wins * 3 - player.losses,
      0,
    ),
    reason: players.some((player) => player.preferredPartnerName)
      ? 'Includes preferred partner request'
      : 'Balanced by wait priority',
  };
};

const getAverageLevel = (players: Player[]): number =>
  players.reduce((sum, player) => sum + player.level, 0) / players.length;

const isGroupCompatibleWithCourt = (): boolean => true;
