# OpenQueue

OpenQueue is a public open play web app with an admin board and a player queue
view. It hel`ps a single organizer manage courts, add players through a table,
form standby groups, assign groups to compatible courts, start match timers, and
track person-by-person results.

## Features

- Add and edit players through a compact two-column table for 35-40 players;
  saved selections auto-fill level, paddle, and grip color.
- Auto-fill level bandwidth defaults by player level. New players default to
  level 3 with a 2-3 accepted range; supported levels are 1-4.
- Reuse saved player profiles, paddle options, and grip color options.
- Courts appear first on the admin board, followed by automatic assignment,
  standby queue, and the editable player table.
- Configure the number of courts, open play date, and max minutes from the admin
  settings modal.
- View four-player standby groups and the courts each group can play on.
- Drag a group to a court or use automatic assignments for ready courts.
- Remove an unavailable player from a loaded, not-yet-started court and
  automatically fill the slot with the next compatible standby player.
- Share `?view=player` so players can see queue position, record, rank, and
  expected groupmates on their phones, while assigned/playing players are shown
  only under loaded or playing courts. Use `?view=standings` for a read-only
  standings board (same public lock as the player link).
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
  ranking_score integer not null default 0,
  phone text not null default ''
);
```

Optional unique phone (ignores empty phone):

```sql
create unique index players_phone_unique on players (phone) where phone <> '';
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
  show_public_ranking boolean not null default true,
  updated_at timestamptz not null default now()
);
```

If you already created these tables, add the new columns:

```sql
alter table players add column if not exists phone text not null default '';
alter table open_play_state add column if not exists show_public_ranking boolean not null default true;
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

The browser client lives in `src/utils/supabase.ts` and is used by
`src/storage.ts` for both saved player profiles and live open play state.

The app also accepts `NEXT_PUBLIC_SUPABASE_URL` and
`NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` as aliases, so the values copied from
Supabase's Next.js setup guide can be reused. The `@supabase/ssr` package and
middleware files from that guide are only needed for Next.js apps; OpenQueue is
a Vite app and uses the browser Supabase client.

For GitHub Pages, add these **repository** secrets and variables under **Settings → Secrets and variables → Actions** before deploying, then run the deploy workflow (or push to `main`) so the build inlines the keys:

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_PUBLISHABLE_KEY`

If the live site does not show the same data on every device, the build almost certainly had no env vars: each browser falls back to its own **local storage** only. Fix the secrets and redeploy.

### Realtime (optional, recommended for live updates)

For instant cross-browser updates through Supabase Realtime, add `open_play_state` to the Realtime publication (run in the SQL editor):

```sql
alter publication supabase_realtime add table open_play_state;
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
test