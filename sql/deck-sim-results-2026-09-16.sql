-- Die Ergebnisse des Goldfish-Stapellaufs: je Deck aus dem Archidekt-Vorrat eine Zeile mit den
-- Zahlen, aus denen sich später die Bracket-Kennzahlen ableiten lassen. Gefüllt von
-- scripts/simulate-deck-pool.js (Workflow .github/workflows/deck-sim.yml, von Hand auslösbar).
-- Im Supabase-Dashboard unter "SQL Editor" ausführen. Idempotent.
--
-- DIE FRAGE, DIE DAS BEANTWORTEN SOLL: Man kann die Regeln von Bracket 2 einhalten und trotzdem
-- ein Deck bauen, das mit Bracket-4-Decks mithält. Die offiziellen Kriterien (src/app/bracket.ts)
-- sehen das nicht, weil sie Karten zählen und kein Tempo messen. Hier entsteht die Gegenprobe:
-- 10.000 Decks je Stufe, jedes ein paar hundert Mal ausgespielt, und danach die Frage "worin
-- unterscheiden sich die Stufen MESSBAR?" an echten Zahlen statt an Vermutungen.
--
-- Deshalb stehen hier zwei Sorten Spalten nebeneinander:
--
--   Aus der Simulation   in welchem Zug gewinnt das Deck, wie oft, womit, wie viel Mana wann.
--   Gezählt              Rampe, Kartenziehen, Interaktion, Tutoren, Manakosten, Länder.
--
-- Die gezählten Spalten kosten fast nichts (die Daten liegen schon in scryfall_cards und
-- scryfall_card_effects) und sind trotzdem der halbe Erkenntnisgewinn: Womöglich trennt am Ende
-- "wie viel Interaktion" die Stufen besser als jeder Siegzug. Beides nebeneinander zu haben ist
-- der einzige Weg, das herauszufinden.
--
-- NACHTRAG 17.09.2026, erste vollstaendige Messung: Die gezaehlten Spalten haben gewonnen, aber
-- anders als vermutet. Game Changer (AUC 0,898) und Tutoren (0,771) trennen mit Abstand am besten,
-- die Interaktion ueberhaupt nicht (0,509). Von allem, was die SIMULATION liefert, taugt genau
-- eine Zahl etwas: das verfuegbare Mana in Zug 3 (0,660). Jede Zahl ueber das Gewinnen - Siegzug,
-- Siegquote, Schaden - liegt im Rauschen. Siehe sql/deck-sim-feature-strength-2026-09-16.sql.
--
-- Diese Tabelle enthält keine Nutzerdaten - nur Rechenergebnisse über fremde, öffentliche
-- Decklisten. Sichtbarkeit wie der Vorrat selbst: ausschließlich Developer.

-- =====================================================================================
-- 1. Die Ergebnisse, eine Zeile je Deck und Simulator-Fassung.
--
--    sim_version gehört in den Primärschlüssel und ist kein Beiwerk: Der Simulator wird sich
--    ändern, und zwei Läufe verschiedener Fassungen sind NICHT vergleichbar. Ohne diese Spalte
--    würde ein neuer Lauf die alten Zahlen still überschreiben, und niemand könnte hinterher
--    sagen, ob sich ein Ergebnis wegen des Decks oder wegen des Simulators verschoben hat.
-- =====================================================================================
create table if not exists public.deck_sim_results (
  deck_id uuid not null references public.archidekt_deck_pool (id) on delete cascade,
  sim_version text not null,
  spiele smallint not null,

  -- Aus der Simulation
  median_siegzug smallint not null,
  schnellste10 smallint not null,
  kumulativ_median smallint not null,
  siegquote real not null,
  combo_anteil real not null,
  mana_zug3 real not null,
  mana_zug5 real not null,
  mana_zug7 real not null,

  -- Gezählt
  gewinn_combos smallint not null default 0,
  karten_erkannt real not null default 0,
  rampe smallint not null default 0,
  kartenziehen smallint not null default 0,
  interaktion smallint not null default 0,
  tutoren smallint not null default 0,
  game_changer smallint not null default 0,
  laender smallint not null default 0,
  avg_cmc real not null default 0,

  berechnet_at timestamptz not null default now(),
  primary key (deck_id, sim_version)
);

comment on table public.deck_sim_results is
  'Ergebnisse des Goldfish-Stapellaufs je Deck aus archidekt_deck_pool. Grundlage, um die Bracket-Kennzahlen aus gemessenen Zahlen statt aus Vermutungen abzuleiten.';
comment on column public.deck_sim_results.sim_version is
  'Fassung des Simulators (SIM_VERSION in scripts/simulate-deck-pool.js). Teil des Primaerschluessels, weil zwei Laeufe verschiedener Fassungen nicht vergleichbar sind.';
comment on column public.deck_sim_results.median_siegzug is
  'Median ueber alle Spiele; Spiele ohne Sieg gehen als KEIN_SIEG (21) ein. Sieg heisst: gewinnende Combo steht ODER 40 Schaden in EINEM Zug.';
comment on column public.deck_sim_results.schnellste10 is
  'Das schnellste Zehntel der Spiele - die Zahl fuer "wie schnell KANN dieses Deck", waehrend der Median sagt, wie schnell es ueblicherweise ist.';
comment on column public.deck_sim_results.kumulativ_median is
  'Wie median_siegzug, aber mit ueber mehrere Zuege AUFADDIERTEM Schaden. Fuer Kreaturendecks der realistischere Wert: Im Probelauf lag mit der Ein-Zug-Regel ein precon-artiges Deck VOR einem durchgebauten, weil die Regel angesammelte Bretter belohnt.';
comment on column public.deck_sim_results.karten_erkannt is
  'Anteil der Nicht-Laender, bei denen die Kartenauswertung ueberhaupt etwas erkannt hat (0-1). Die Ehrlichkeitszahl zu jeder Zeile: Bei 0,4 sagt ein spaeter Siegzug womoeglich mehr ueber die Grenzen dieser Auswertung als ueber das Deck.';
comment on column public.deck_sim_results.gewinn_combos is
  'Wie viele Commander-Spellbook-Combos vollstaendig im Deck liegen UND ein spielbeendendes Ergebnis haben. Unendlich Mana zaehlt nicht mit - davon stirbt niemand.';
comment on column public.deck_sim_results.interaktion is
  'Removal + Konterzauber + Boardwipes aus scryfall_card_effects. Die Achse, fuer die ein Goldfish per Definition blind ist. Die Vermutung, sie koennte die Stufen trennen, ist am 17.09.2026 widerlegt worden: AUC 0,509 zwischen Stufe 2 und 4 - das schwaechste Merkmal der ganzen Auswertung.';

create index if not exists deck_sim_results_version_idx on public.deck_sim_results (sim_version);

-- =====================================================================================
-- 2. Welche Combos beenden ein Spiel? Als Ansicht, nicht im Skript.
--
--    Das Skript braucht "alle Combos, die gewinnen, samt ihrer Karten". Ohne diese Ansicht
--    müsste es spellbook_combo_cards komplett herunterladen - rund 350.000 Zeilen in Paketen zu
--    1.000, also 350 Anfragen für eine Frage, die die Datenbank in einem Rutsch beantwortet.
--
--    Der Unterschied zwischen den Ergebnissen ist der springende Punkt und deshalb hier
--    festgehalten: Unendlich MANA gewinnt gar nichts, solange nichts da ist, wofür man es
--    ausgibt. Unendlich SCHADEN schon. Die Liste ist bewusst eng.
-- =====================================================================================
create or replace view public.spellbook_winning_combos
with (security_invoker = true) as
select
  c.id as combo_id,
  c.card_count,
  coalesce(c.mana_value_needed, 0) as mana_value_needed,
  c.produces,
  array_agg(cc.name_normalized order by cc.name_normalized) as card_names,
  -- Rund vierzig Combos verlangen, dass eine bestimmte Karte der COMMANDER ist (sie brauchen die
  -- Kommandozone). Ohne diese Spalte bekaeme ein Deck eine Combo angerechnet, die es gar nicht
  -- ausfuehren kann - dieselbe Pruefung macht presentCombos() in src/app/bracket.ts.
  coalesce(
    array_agg(cc.name_normalized) filter (where cc.must_be_commander),
    array[]::text[]
  ) as commander_required
from public.spellbook_combos c
join public.spellbook_combo_cards cc on cc.combo_id = c.id
where exists (
  select 1 from unnest(c.produces) as p
  where p ~* 'win the game|infinite damage|infinite turns|infinite mill|infinite loss of life|loses the game'
)
group by c.id, c.card_count, c.mana_value_needed, c.produces;

comment on view public.spellbook_winning_combos is
  'Combos, deren Ergebnis ein Spiel beendet, samt Kartenliste. Gegenstueck zu istSiegCombo() in src/app/goldfish-sim.ts - beide Listen muessen dieselbe Auswahl treffen.';

-- =====================================================================================
-- 3. Die Auswertung: was unterscheidet die Stufen?
--
--    Genau die Tabelle, um die es bei dem ganzen Aufwand geht - eine Zeile je Bracket, und in
--    jeder Spalte die Frage "geht dieser Wert von Stufe 2 zu Stufe 4 monoton hoch oder runter?".
--    Eine Spalte, die das nicht tut, trennt die Stufen nicht und taugt nicht als Kennzahl.
--
--    Mediane statt Mittelwerte bei den Siegzuegen: Ein einzelnes Deck, das nie gewinnt, zieht
--    einen Mittelwert weit nach oben, den Median nicht.
-- =====================================================================================
create or replace view public.deck_sim_by_bracket
with (security_invoker = true) as
select
  d.creator_bracket,
  r.sim_version,
  count(*) as decks,
  percentile_cont(0.5) within group (order by r.median_siegzug) as median_siegzug,
  percentile_cont(0.5) within group (order by r.schnellste10) as schnellste10,
  percentile_cont(0.5) within group (order by r.kumulativ_median) as kumulativ_median,
  round(avg(r.siegquote)::numeric, 3) as siegquote,
  round(avg(r.combo_anteil)::numeric, 3) as combo_anteil,
  round(avg(r.gewinn_combos)::numeric, 2) as gewinn_combos,
  round(avg(r.mana_zug3)::numeric, 2) as mana_zug3,
  round(avg(r.mana_zug5)::numeric, 2) as mana_zug5,
  round(avg(r.rampe)::numeric, 1) as rampe,
  round(avg(r.kartenziehen)::numeric, 1) as kartenziehen,
  round(avg(r.interaktion)::numeric, 1) as interaktion,
  round(avg(r.tutoren)::numeric, 1) as tutoren,
  round(avg(r.game_changer)::numeric, 2) as game_changer,
  round(avg(r.laender)::numeric, 1) as laender,
  round(avg(r.avg_cmc)::numeric, 2) as avg_cmc,
  round(avg(r.karten_erkannt)::numeric, 3) as karten_erkannt
from public.deck_sim_results r
join public.archidekt_deck_pool d on d.id = r.deck_id
group by d.creator_bracket, r.sim_version
order by r.sim_version, d.creator_bracket;

comment on view public.deck_sim_by_bracket is
  'Eine Zeile je Bracket-Stufe: der Vergleich, um dessentwillen der Stapellauf laeuft. Eine Spalte, deren Werte von Stufe 2 zu Stufe 4 nicht monoton laufen, trennt die Stufen nicht.';

-- =====================================================================================
-- 4. Sichtbarkeit: ausschließlich Developer, wie der Vorrat selbst.
-- =====================================================================================
alter table public.deck_sim_results enable row level security;

drop policy if exists "Developers can read the deck sim results" on public.deck_sim_results;
create policy "Developers can read the deck sim results"
on public.deck_sim_results
for select
to authenticated
using (is_developer(auth.uid()));

drop policy if exists "Developers can write the deck sim results" on public.deck_sim_results;
create policy "Developers can write the deck sim results"
on public.deck_sim_results
for all
to authenticated
using (is_developer(auth.uid()))
with check (is_developer(auth.uid()));
