-- Cube-Builder: selbst gesetzte Spalte je Karte, wie CubeCobras "Color Category" (Wunsch des
-- Users, 19.10.2026: ein aus CubeCobra importierter Cube soll so sortiert sein wie das Original).
-- Im Supabase-Dashboard unter "SQL Editor" ausführen; idempotent. Setzt sql/cubes-2026-10-17.sql
-- voraus.
--
-- Werte: 'W','U','B','R','G','H' (Hybrid),'M' (mehrfarbig),'C' (farblos),'L' (Länder);
-- NULL = aus Typ und Farbidentität gerechnet (src/app/cube-layout.ts, colorCategory()).
alter table public.cube_list_cards add column if not exists color_category text
  check (color_category in ('W', 'U', 'B', 'R', 'G', 'H', 'M', 'C', 'L'));

comment on column public.cube_list_cards.color_category is
  'Spalte in der Cube-Tabelle (W/U/B/R/G/H/M/C/L), z. B. aus dem CubeCobra-CSV-Export; NULL = gerechnet.';
