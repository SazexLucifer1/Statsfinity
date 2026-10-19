-- Cube-Builder: Booster-Einstellungen und die Aufteilung des Cubes in Packs (Wunsch des Users,
-- 19.10.2026). Im Supabase-Dashboard unter "SQL Editor" ausführen; idempotent. Setzt
-- sql/cubes-2026-10-17.sql voraus.
--
-- Zwei Spalten an cube_lists statt eigener Tabellen - wie Primer und Steckbrief an decks: Lesen und
-- Schreiben folgen den Policies des Cubes, es braucht keine neue.
--   pack_settings: {"size": 15, "rules": [{"kind": "column"|"type"|"legendary", "key": "W", "min": 3}]}
--   pack_split:    {"at": "<Zeitpunkt>", "packs": [["Kartenname", ...], ...], "leftover": [...]}
--                  Nur Namen - ein 540er-Cube in 36 Packs sind rund 15 kB.
alter table public.cube_lists add column if not exists pack_settings jsonb;
alter table public.cube_lists add column if not exists pack_split jsonb;

comment on column public.cube_lists.pack_settings is
  'Booster-Einstellungen: Packgröße und Mindestanteile je Pack (src/app/cube-packs.ts).';
comment on column public.cube_lists.pack_split is
  'Zuletzt gespeicherte Aufteilung des Cubes in Packs: Kartennamen je Pack plus Reste.';
