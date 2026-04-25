# OpenQueue

OpenQueue is an admin-only web app for managing doubles open play. It helps a
single organizer add players, form standby groups, assign groups to compatible
courts, start match timers, and track person-by-person results.

## Features

- Add one player or open a compact two-column bulk-add table for 35-40 players;
  saved selections auto-fill level, paddle, and grip color.
- Auto-fill level bandwidth defaults by player level. New players default to
  level 3 with a 2-3 accepted range; supported levels are 1-4.
- Reuse saved player profiles, paddle options, and grip color options.
- Configure the number of courts, each court name, court level range, max
  minutes of play, and visible court status colors for ready, reserved,
  unavailable, loaded, and playing.
- View four-player standby groups and the courts each group can play on.
- Drag a group to a court or use automatic assignments for ready courts.
- Remove an unavailable player from a loaded, not-yet-started court and
  automatically fill the slot with the next compatible standby player.
- Switch to a player queue view so waiting players can see their queue position
  and expected groupmates, while assigned/playing players are shown only under
  currently loaded or playing courts.
- Start a court timer, mark individual winners, and return players to the queue.
- Save wins, losses, games played, and ranking score for the next open play.
- Mark late, unavailable, or leaving players directly from the roster.

## Supabase Persistence

The app uses Supabase as the public shared state when configured, so the admin
page and player phones see the same live queue and courts. Browser local storage
is only a fallback for local development without Supabase env variables.

Create the reusable player profile table:

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

Create the live open play state table:

```sql
create table open_play_state (
  id text primary key,
  session_date date not null,
  players jsonb not null default '[]'::jsonb,
  courts jsonb not null default '[]'::jsonb,
  max_minutes integer not null default 15,
  saved_paddles text[] not null default '{}',
  saved_grip_colors text[] not null default '{}',
  updated_at timestamptz not null default now()
);
```

For a public no-login deployment, enable Row Level Security and add public
read/write policies for both tables:

```sql
alter table players enable row level security;
alter table open_play_state enable row level security;

create policy "Public read players" on players for select using (true);
create policy "Public write players" on players for insert with check (true);
create policy "Public update players" on players for update using (true);

create policy "Public read open play state" on open_play_state for select using (true);
create policy "Public write open play state" on open_play_state for insert with check (true);
create policy "Public update open play state" on open_play_state for update using (true);
```

Then set these environment variables. For Vite, use the `VITE_` names:

```bash
VITE_SUPABASE_URL=your-project-url
VITE_SUPABASE_PUBLISHABLE_KEY=your-publishable-key
```

The app also accepts `NEXT_PUBLIC_SUPABASE_URL` and
`NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` as aliases, so the values copied from
Supabase's Next.js setup guide can be reused. The `@supabase/ssr` package and
middleware files from that guide are only needed for Next.js apps; OpenQueue is
a Vite app and uses the browser Supabase client.

For GitHub Pages, add these repository secrets before deploying:

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_PUBLISHABLE_KEY`

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
