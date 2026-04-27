-- =============================================================================
-- Harry Potter + Fantastic Beasts seed for public.players (id uuid, phone 09…)
-- Run in Supabase SQL Editor. Requires: create extension if not exists pgcrypto;
-- =============================================================================

-- 1) Existing rows: set PH-style mobile (11 digits, starts with 09) — unique per id
UPDATE public.players AS p
SET phone = sub.new_phone
FROM (
  SELECT
    id,
    '09' || lpad(
      ((100000000 + (row_number() OVER (ORDER BY id) * 10007) % 900000000))::text,
      9,
      '0'
    ) AS new_phone
  FROM public.players
) AS sub
WHERE p.id = sub.id;

-- Optional: only fill empty phones (uncomment and comment out the WHERE above on UPDATE):
--   AND (coalesce(p.phone, '') = '' OR btrim(p.phone) = '')


-- 2) Seed 60+ named players (skip names already in table). Paddle = one random draw per row.
WITH base_names(name) AS (
  VALUES
    ('Harry Potter'), ('Hermione Granger'), ('Ron Weasley'), ('Ginny Weasley'),
    ('Neville Longbottom'), ('Luna Lovegood'), ('Draco Malfoy'), ('Cho Chang'),
    ('Cedric Diggory'), ('Seamus Finnigan'), ('Dean Thomas'), ('Parvati Patil'),
    ('Padma Patil'), ('Lavender Brown'), ('Oliver Wood'), ('Angelina Johnson'),
    ('Katie Bell'), ('Alicia Spinnet'), ('Fred Weasley'), ('George Weasley'),
    ('Percy Weasley'), ('Bill Weasley'), ('Charlie Weasley'), ('Molly Weasley'),
    ('Arthur Weasley'), ('Albus Dumbledore'), ('Minerva McGonagall'),
    ('Severus Snape'), ('Rubeus Hagrid'), ('Sirius Black'), ('Remus Lupin'),
    ('Peter Pettigrew'), ('James Potter'), ('Lily Potter'), ('Nymphadora Tonks'),
    ('Kingsley Shacklebolt'), ('Alastor Moody'), ('Dolores Umbridge'),
    ('Filius Flitwick'), ('Pomona Sprout'), ('Gilderoy Lockhart'),
    ('Lucius Malfoy'), ('Narcissa Malfoy'), ('Bellatrix Lestrange'),
    ('Tom Riddle'), ('Dobby'), ('Kreacher'), ('Fleur Delacour'),
    ('Viktor Krum'), ('Rita Skeeter'), ('Argus Filch'),
    ('Newt Scamander'), ('Tina Goldstein'), ('Queenie Goldstein'),
    ('Jacob Kowalski'), ('Credence Barebone'), ('Gellert Grindelwald'),
    ('Leta Lestrange'), ('Theseus Scamander'), ('Nagini'),
    ('Yusuf Kama'), ('Abernathy'), ('Seraphina Picquery'),
    ('Mary Lou Barebone'), ('Percival Graves')
),
paddles(paddle) AS (
  VALUES
    ('Selkirk Vanguard'), ('JOOLA Hyperion'), ('Paddletek Bantam'),
    ('CRBN 1'), ('Engage Pursuit'), ('Gearbox CX14'),
    ('Onix Z5'), ('Diadem Warrior'), ('Gamma Mirage'), ('ProKennex Black Ace')
),
-- One random paddle per character row (LATERAL re-evaluates ORDER BY random() per row)
picked AS (
  SELECT
    gen_random_uuid() AS id,
    b.name AS name,
    p.paddle AS paddle,
    (1 + floor(random() * 4))::int AS level
  FROM base_names AS b
  CROSS JOIN LATERAL (SELECT paddle FROM paddles ORDER BY random() LIMIT 1) AS p
),
with_phone AS (
  SELECT
    picked.id,
    picked.name,
    picked.level,
    picked.paddle,
    -- 11 digits: 09 + 9 digits; unique per new uuid (unlikely to match existing updated rows)
    '09' || lpad(
      (abs(hashtext(picked.id::text)) % 1000000000)::text,
      9,
      '0'
    ) AS phone
  FROM picked
),
final_rows AS (
  SELECT
    wp.id,
    wp.name,
    wp.level,
    GREATEST(1, wp.level - (CASE WHEN random() < 0.7 THEN 1 ELSE 0 END))::int AS min_level,
    LEAST(4, wp.level + (CASE WHEN random() < 0.7 THEN 1 ELSE 0 END))::int AS max_level,
    wp.paddle,
    ''::text AS grip_color,
    ''::text AS preferred_partner_name,
    wp.phone,
    0::int AS wins,
    0::int AS losses,
    0::int AS games_played,
    0::numeric AS ranking_score
  FROM with_phone AS wp
)
INSERT INTO public.players (
  id,
  name,
  level,
  min_level,
  max_level,
  paddle,
  grip_color,
  preferred_partner_name,
  phone,
  wins,
  losses,
  games_played,
  ranking_score
)
SELECT
  id,
  name,
  level,
  min_level,
  max_level,
  paddle,
  grip_color,
  preferred_partner_name,
  phone,
  wins,
  losses,
  games_played,
  ranking_score
FROM final_rows
WHERE NOT EXISTS (
  SELECT 1
  FROM public.players AS p
  WHERE lower(trim(p.name)) = lower(trim(final_rows.name))
);
