# OpenQueue

OpenQueue is an admin-only web app for managing doubles open play. It helps a
single organizer add players, form standby groups, assign groups to compatible
courts, start match timers, and track person-by-person results.

## Features

- Add one player or paste multiple Excel-style rows with level, paddle, grip
  color, and optional preferred partner.
- Auto-fill level bandwidth defaults by player level. New players default to
  level 3 with a 2-3 accepted range; supported levels are 1-4.
- Reuse saved player profiles, paddle options, and grip color options.
- Configure the number of courts, each court name, court level range, and max
  minutes of play.
- View four-player standby groups and the courts each group can play on.
- Drag a group to a court or use automatic assignments for ready courts.
- Remove an unavailable player from a loaded, not-yet-started court and
  automatically fill the slot with the next compatible standby player.
- Switch to a player queue view so players can see their queue position,
  expected groupmates, and currently loaded or playing courts.
- Start a court timer, mark individual winners, and return players to the queue.
- Save wins, losses, games played, and ranking score for the next open play.
- Mark late, unavailable, or leaving players directly from the roster.

## Supabase Persistence

The app works with browser local storage by default. To save reusable player
profiles in Supabase, create a `players` table with these columns:

```sql
create table players (
  id text primary key,
  name text not null,
  level integer not null,
  min_level integer not null,
  max_level integer not null,
  paddle text not null default '',
  grip_color text not null default '',
  preferred_partner_name text not null default '',
  wins integer not null default 0,
  losses integer not null default 0,
  games_played integer not null default 0,
  ranking_score integer not null default 0
);
```

Then set these environment variables:

```bash
VITE_SUPABASE_URL=your-project-url
VITE_SUPABASE_ANON_KEY=your-anon-key
```

## Getting Started

```bash
npm install
npm run dev
```

## Verification

```bash
npm run lint
npm run build
```
