-- Zwei Sieg-Definitionen statt einer. Im Supabase-SQL-Editor ausführen. Idempotent.
--
-- DER ANLASS, an einem gemessenen Fall: Ein Urza-cEDH-Deck aus der Praxis enthält 22 vollständige
-- Combos von Commander Spellbook. Nach der bisherigen Definition ist davon KEINE EINZIGE ein Sieg.
-- Die Ergebnisse dieser Combos heißen "Infinite storm count", "Infinite colorless mana", "Cast all
-- spells in your library" - und das Muster suchte nach "win the game", "infinite damage",
-- "infinite turns", "infinite mill". Der Simulator hielt das Deck deshalb für ein Kreaturendeck
-- ohne Plan und meldete in 1000 Spielen keinen einzigen Sieg.
--
-- WARUM ES TROTZDEM ZWEI DEFINITIONEN BRAUCHT und nicht einfach eine weitere:
--
--   eng    "Beendet dieses Ergebnis das Spiel unmittelbar?" Das ist die Frage, an der Urteil F der
--          Bracket-Einstufung hängt - und dessen Schwellen wurden an GENAU dieser Liste gemessen
--          (0,7 % der Bracket-2-Decks, 21,2 % der Bracket-4-Decks). Die Liste zu erweitern hieße,
--          eine geeichte Regel ohne neue Eichung zu verschieben. Sie bleibt deshalb unverändert,
--          und winning_combos_in_deck() filtert weiter genau darauf.
--   weit   "Ist dieses Ergebnis der Endpunkt eines Decks?" Das ist die Frage, die der SIMULATOR
--          stellt, wenn er entscheidet, worauf ein Deck hinspielt.
--
-- DIE AUSNAHMEN sind kein Beiwerk. Das Vokabular kennt 1.320 Ergebnisse, und darunter sind
-- Formulierungen, die auf das weite Muster passen und trotzdem keinen Sieg bedeuten: "Infinite
-- damage to all creatures" ist ein Boardwipe, "Near-infinite damage to you" trifft einen selbst,
-- "Infinite self-mill" ist ohne Laborschwester das Gegenteil eines Sieges.
--
-- GEPRÜFT wurde das gegen die vollständige Merkmalsliste, nicht gegen ausgedachte Beispiele:
-- 43 der 1.320 Ergebnisse zählen weit (vorher 28 eng), neun werden durch die Ausnahmen
-- ausgeschlossen, und die fünf Schutzeffekte der Bauart "You can't lose the game" fallen von
-- selbst durch.
--
-- ALLE DREI ZEICHENKETTEN müssen wörtlich denen in src/app/goldfish-sim.ts entsprechen
-- (SIEG_MUSTER, SOFORT_SIEG_MUSTER, SIEG_AUSNAHME); scripts/simulate-deck-pool.js vergleicht sie
-- vor jedem Lauf und bricht bei Abweichung ab. Kein \b in den Ausdrücken - in Postgres ist das ein
-- Rückschritt-Zeichen, keine Wortgrenze.

-- =====================================================================================
-- 1. Die drei Muster.
-- =====================================================================================
create or replace function public.spellbook_winning_combo_muster()
returns text
language sql
immutable
security invoker
set search_path = public
as $$
  select 'win the game|(opponent|player)[^,]{0,40}loses? the game|(near-)?infinite[^,]{0,30}(damage|mill|turns|combat phases|storm count|loss of life|poison)|cast all spells in your library'::text;
$$;

create or replace function public.spellbook_sofort_sieg_muster()
returns text
language sql
immutable
security invoker
set search_path = public
as $$
  select 'win the game|infinite damage|infinite turns|infinite mill|infinite loss of life|opponent loses the game|opponents lose the game'::text;
$$;

create or replace function public.spellbook_sieg_ausnahme()
returns text
language sql
immutable
security invoker
set search_path = public
as $$
  select 'damage to [^,]{0,25}creatures|damage to you|mill for you|self-mill'::text;
$$;

comment on function public.spellbook_winning_combo_muster() is
  'WEITE Sieg-Definition: Ist dieses Ergebnis der Endpunkt eines Decks? Grundlage der Simulation. Muss SIEG_MUSTER in src/app/goldfish-sim.ts entsprechen.';
comment on function public.spellbook_sofort_sieg_muster() is
  'ENGE Sieg-Definition: Beendet dieses Ergebnis das Spiel unmittelbar? Grundlage von Urteil F - unveraendert, weil dessen Schwellen daran gemessen wurden.';
comment on function public.spellbook_sieg_ausnahme() is
  'Was trotz Treffer KEIN Sieg ist: Schaden auf Kreaturen, Schaden auf einen selbst, Selbst-Mill.';

grant execute on function public.spellbook_winning_combo_muster() to anon, authenticated, service_role;
grant execute on function public.spellbook_sofort_sieg_muster() to anon, authenticated, service_role;
grant execute on function public.spellbook_sieg_ausnahme() to anon, authenticated, service_role;

-- =====================================================================================
-- 2. Die Ansicht neu bauen - jetzt nach der WEITEN Definition, mit einer Spalte für die enge.
--
--    Die Funktion winning_combos_in_deck() hängt daran und muss zuerst weichen; sie wird unten
--    wieder angelegt und filtert dann auf beendet_sofort - für die App ändert sich dadurch nichts.
-- =====================================================================================
drop function if exists public.winning_combos_in_deck(text[], text[]);

-- Erst die Form nachschlagen, dann das passende Kommando: "drop view if exists" bricht ab, wenn
-- dort eine materialisierte Ansicht liegt, und umgekehrt genauso.
do $ausraeumen$
declare
  art "char";
begin
  select relkind into art from pg_class where oid = to_regclass('public.spellbook_winning_combos');
  if art = 'm' then
    execute 'drop materialized view public.spellbook_winning_combos';
  elsif art = 'v' then
    execute 'drop view public.spellbook_winning_combos';
  end if;
end
$ausraeumen$;

create materialized view public.spellbook_winning_combos as
with gewinner as materialized (
  select
    c.id,
    c.card_count,
    coalesce(c.mana_value_needed, 0) as mana_value_needed,
    c.produces,
    exists (
      select 1 from unnest(c.produces) as p
      where p ~* public.spellbook_sofort_sieg_muster()
        and p !~* public.spellbook_sieg_ausnahme()
    ) as beendet_sofort
  from public.spellbook_combos c
  where exists (
    select 1 from unnest(c.produces) as p
    where p ~* public.spellbook_winning_combo_muster()
      and p !~* public.spellbook_sieg_ausnahme()
  )
)
select
  g.id as combo_id,
  g.card_count,
  g.mana_value_needed,
  g.produces,
  g.beendet_sofort,
  array_agg(cc.name_normalized order by cc.name_normalized) as card_names,
  coalesce(
    array_agg(cc.name_normalized) filter (where cc.must_be_commander),
    array[]::text[]
  ) as commander_required
from gewinner g
join public.spellbook_combo_cards cc on cc.combo_id = g.id
group by g.id, g.card_count, g.mana_value_needed, g.produces, g.beendet_sofort;

comment on materialized view public.spellbook_winning_combos is
  'Combos, deren Ergebnis der Endpunkt eines Decks ist (weite Definition). beendet_sofort = true heisst zusaetzlich: beendet das Spiel unmittelbar (enge Definition, Grundlage von Urteil F).';

create unique index if not exists spellbook_winning_combos_id_idx
  on public.spellbook_winning_combos (combo_id);

create index if not exists spellbook_winning_combos_cards_idx
  on public.spellbook_winning_combos using gin (card_names);

-- Eigener Index auf die enge Teilmenge: Urteil F fragt bei jedem Deck-Oeffnen genau danach.
create index if not exists spellbook_winning_combos_sofort_idx
  on public.spellbook_winning_combos (beendet_sofort)
  where beendet_sofort;

grant select on public.spellbook_winning_combos to anon, authenticated;

-- =====================================================================================
-- 3. Urteil F bleibt, wie es war - nur die Filterzeile ist neu.
-- =====================================================================================
create or replace function public.winning_combos_in_deck(
  deck_names text[],
  commander_names text[] default '{}'::text[]
)
returns integer
language sql
stable
security invoker
set search_path = public
as $$
  select count(*)::integer
  from public.spellbook_winning_combos c
  where c.beendet_sofort
    and c.card_names <@ deck_names
    and c.commander_required <@ commander_names;
$$;

comment on function public.winning_combos_in_deck(text[], text[]) is
  'Zahl der Combos, die das Spiel UNMITTELBAR beenden und vollstaendig in dieser Deckliste stecken. Grundlage von Urteil F in src/app/bracket.ts - die Zahl ist dieselbe wie vor der Erweiterung der Ansicht.';

grant execute on function public.winning_combos_in_deck(text[], text[]) to anon, authenticated;

-- =====================================================================================
-- 4. Die neue Spalte des Stapellaufs: Combos nach der WEITEN Definition.
--
--    Beide Zahlen nebeneinander, damit sich messen lässt, welche die Bracket-Stufen besser trennt -
--    statt die Definition auf Verdacht auszutauschen. gewinn_combos zaehlt weiter eng.
-- =====================================================================================
alter table public.deck_sim_results
  add column if not exists sieg_combos smallint not null default 0;

comment on column public.deck_sim_results.sieg_combos is
  'Vollstaendig im Deck liegende Combos nach der WEITEN Sieg-Definition (Endpunkt eines Decks). gewinn_combos daneben zaehlt weiter eng (beendet das Spiel unmittelbar) - so laesst sich vergleichen, welche der beiden die Stufen besser trennt.';
