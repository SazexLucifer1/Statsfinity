-- Mehr Siegarten im Sieger-Dialog (Wunsch des Users, 21.10.2026: fast jede Partie landete unter
-- "Anderes"). Im Supabase-Dashboard unter "SQL Editor" ausführen; idempotent. Setzt
-- sql/partie-ergebnis-deck-version-2026-10-06.sql voraus.
--
-- Neu: effect_damage (Direktschaden und Drain, z. B. Fireball, Blood Artist), poison (Gift/Infect),
-- alt_win (alternative Siegbedingung, z. B. Thassa's Oracle), control (Kontrolle/Lock),
-- concede (Gegner haben aufgegeben). Die Liste steht im Client in WIN_CONDITIONS (models.ts).
--
-- Fehlt diese Migration, speichert die App eine neue Siegart als 'other', statt die Partie zu
-- verlieren (MtgService.addMatch, Fehler 23514).

alter table public.matches drop constraint if exists matches_win_condition_check;
alter table public.matches
  add constraint matches_win_condition_check
  check (
    win_condition is null
    or win_condition in (
      'combat', 'commander_damage', 'effect_damage', 'poison', 'combo',
      'alt_win', 'mill', 'control', 'concede', 'other'
    )
  );

comment on column public.matches.win_condition is
  'Siegart (combat, commander_damage, effect_damage, poison, combo, alt_win, mill, control, concede, other); null = unbekannt.';
