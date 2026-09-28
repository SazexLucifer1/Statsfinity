-- Ergebnisse der Bracket-Simulation mit Forge (echte 4er-Pods, Bot gegen Bot).
-- Ablauf: scripts/forge/einstufen.js, Workflow .github/workflows/forge-einstufung.yml,
-- Einstufungsregel: src/app/forge-einstufung.ts, Test-Decks: sim/testdecks/README.md
--
-- Im Supabase-Dashboard unter "SQL Editor" ausführen; idempotent ("if not exists",
-- "drop policy if exists" + "create policy").
--
-- EINE ZEILE JE LAUF, NICHT JE PARTIE: Ein Lauf sind 500 Partien. Als Zeilen wären das bei ein paar
-- Dutzend eingestuften Decks schnell zehntausende - genau die Sorte Tabelle, die den 500-MB-Free-Plan
-- schon zweimal fast gesprengt hat (siehe archidekt_deck_pool_cards, spellbook_combo_cards). Was die
-- App anzeigt, ist ohnehin die Zusammenfassung je Stufe; die steht in "stufen" als jsonb (~1 kB).
--
-- MEHRERE LÄUFE JE DECK sind gewollt: Ein Deck ändert sich, Forge wird gehoben, Test-Decks werden
-- getauscht. Jeder Lauf trägt deshalb die Forge-Fassung und den Stand der Test-Decks mit - zwei
-- Ergebnisse sind nur vergleichbar, wenn beide gleich sind. Die App zeigt den neuesten.
--
-- Geschrieben wird ausschließlich von der GitHub Action mit dem Service-Role-Key, deshalb gibt es
-- KEINE Insert-, Update- oder Delete-Policy. Lesen folgt der Sichtbarkeit des Decks, wie bei den
-- Kommentaren (sql/deck-kommentare-2026-09-22.sql).

create table if not exists public.forge_einstufungen (
  id uuid primary key default gen_random_uuid(),
  deck_id uuid not null references public.decks (id) on delete cascade,
  erstellt_at timestamptz not null default now(),

  -- Endgültige Stufe = Simulation, mindestens aber die Kartenregeln (decks.bracket_auto zum Zeitpunkt des Laufs).
  stufe smallint not null check (stufe between 1 and 5),
  sim_stufe smallint not null check (sim_stufe between 1 and 5),
  regel_minimum smallint check (regel_minimum between 1 and 5),
  sicherheit text not null check (sicherheit in ('sicher', 'knapp')),

  -- Je Stufe: { stufe, spiele, siege, remis, siegRundeSchnitt, verlustGruende: {grund: anzahl} }
  stufen jsonb not null,
  -- Karten, die Forge nicht kennt und die deshalb im Spiel fehlten.
  unbekannte_karten text[] not null default '{}',

  forge_commit text not null,
  testdecks_commit text not null
);

comment on table public.forge_einstufungen is
  'Bracket-Einstufung aus der Forge-Simulation, ein Eintrag je Lauf (500 Partien). Geschrieben nur von .github/workflows/forge-einstufung.yml.';

create index if not exists forge_einstufungen_deck_idx
  on public.forge_einstufungen (deck_id, erstellt_at desc);

alter table public.forge_einstufungen enable row level security;

drop policy if exists "Forge-Einstufungen sind lesbar wie ihr Deck" on public.forge_einstufungen;
create policy "Forge-Einstufungen sind lesbar wie ihr Deck"
on public.forge_einstufungen
for select
to public
using (
  exists (
    select 1 from public.decks d
    where d.id = forge_einstufungen.deck_id
      and (not d.is_private or d.user_id = auth.uid())
  )
);
