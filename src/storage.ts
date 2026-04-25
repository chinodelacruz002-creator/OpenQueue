import { createClient } from '@supabase/supabase-js';
import { LOCAL_STORAGE_KEY } from './constants';
import type { AppData, SavedPlayer } from './types';

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

const supabaseUrl =
  import.meta.env.VITE_SUPABASE_URL ?? import.meta.env.VITE_NEXT_PUBLIC_SUPABASE_URL;
const supabasePublishableKey =
  import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ??
  import.meta.env.VITE_SUPABASE_ANON_KEY ??
  import.meta.env.VITE_NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

const supabase =
  supabaseUrl && supabasePublishableKey
    ? createClient(supabaseUrl, supabasePublishableKey)
    : null;

export const hasSupabaseConfig = Boolean(supabase);

export const loadOpenPlayData = async (): Promise<AppData | null> => {
  if (!supabase) {
    return loadLocalData();
  }

  const { data, error } = await supabase
    .from('players')
    .select('*')
    .order('ranking_score', { ascending: false })
    .order('name', { ascending: true });

  if (error) {
    return loadLocalData();
  }

  const localData = loadLocalData();
  return {
    sessionDate: localData?.sessionDate ?? getTodayKey(),
    players: localData?.players ?? [],
    savedPlayers: data.map(mapRowToSavedPlayer),
    savedPaddles: uniqueValues(data.map((row) => row.paddle)),
    savedGripColors: uniqueValues(data.map((row) => row.grip_color)),
  };
};

export const saveOpenPlayData = async (data: AppData): Promise<void> => {
  saveLocalData(data);

  if (!supabase) {
    return;
  }

  await supabase.from('players').upsert(data.savedPlayers.map(mapSavedPlayerToRow));
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
