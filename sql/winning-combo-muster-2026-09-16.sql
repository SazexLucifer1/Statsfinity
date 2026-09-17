-- Die Sieg-Definition des Simulators, einmal statt zweimal. Im Supabase-SQL-Editor ausfuehren.
-- Idempotent.
--
-- WAS KAPUTT WAR: Die Liste der spielbeendenden Combo-Ergebnisse stand doppelt - einmal als
-- Ausdruck in src/app/goldfish-sim.ts, einmal woertlich abgeschrieben in der materialisierten
-- Ansicht - mit einem Kommentar in beiden Dateien, sie muessten dieselbe Auswahl treffen. Sie
-- taten es nicht:
--
--   TypeScript:  ... | each opponent loses the game | lose the game
--   SQL:         ... | loses the game
--
-- Die TypeScript-Fassung zaehlte durch das nackte "lose the game" auch "You lose the game" als
-- Siegbedingung - eine Combo, bei der man selbst verliert. Die SQL-Fassung verpasste umgekehrt
-- jedes "All opponents lose the game", weil sie nur die Einzahl kannte. Beides fiel nie auf, weil
-- nichts die beiden Listen verglichen hat.
--
-- Jetzt gibt es eine Zeichenkette (SIEG_MUSTER in goldfish-sim.ts), die Funktion unten gibt sie
-- zurueck, und scripts/simulate-deck-pool.js bricht ab, wenn die beiden auseinanderlaufen.

-- =====================================================================================
-- 1. Die eine Sieg-Definition.
--
--    Kein \b im Ausdruck: In Postgres ist \b das Rückschritt-Zeichen, nicht die Wortgrenze. Wer
--    hier eines einbaut, bekommt in der Datenbank stillschweigend etwas anderes als im Browser -
--    genau die Sorte Unterschied, wegen der diese Funktion existiert.
-- =====================================================================================
create or replace function public.spellbook_winning_combo_muster()
returns text
language sql
immutable
security invoker
set search_path = public
as $$
  select 'win the game|infinite damage|infinite turns|infinite mill|infinite loss of life|opponent loses the game|opponents lose the game'::text;
$$;

comment on function public.spellbook_winning_combo_muster() is
  'Der Ausdruck, der ein spielbeendendes Combo-Ergebnis erkennt. Muss woertlich SIEG_MUSTER in src/app/goldfish-sim.ts entsprechen; scripts/simulate-deck-pool.js prueft das vor jedem Lauf.';

grant execute on function public.spellbook_winning_combo_muster() to anon, authenticated, service_role;

-- =====================================================================================
-- 2. Die materialisierte Ansicht mit genau diesem Ausdruck neu bauen.
--
--    Die Funktion winning_combos_in_deck() hängt an der Ansicht und muss deshalb zuerst weichen -
--    sie wird unten unverändert wieder angelegt. Ohne das scheitert der drop mit einer
--    Abhängigkeitsmeldung, und wer dann "cascade" anhängt, verliert die Funktion still.
-- =====================================================================================
drop function if exists public.winning_combos_in_deck(text[], text[]);
-- Die Ansicht weg - EGAL IN WELCHER FORM sie gerade existiert.
--
-- "drop view if exists" reicht dafuer nicht: Das "if exists" unterdrueckt nur den Fall "gibt es
-- gar nicht". Liegt das Objekt als MATERIALISIERTE Ansicht vor, bricht Postgres ab:
--
--   ERROR: 42809: "spellbook_winning_combos" is not a view
--
-- Und andersherum genauso ("drop materialized view" auf eine gewoehnliche Ansicht). Weil diese
-- Datei auf beiden Staenden laufen koennen muss - auf einer frischen Datenbank ist es eine
-- gewoehnliche Ansicht, auf der produktiven laengst eine materialisierte -, wird erst die Form
-- nachgeschlagen und dann das passende Kommando ausgefuehrt.
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
    c.produces
  from public.spellbook_combos c
  where exists (
    select 1 from unnest(c.produces) as p
    where p ~* public.spellbook_winning_combo_muster()
  )
)
select
  g.id as combo_id,
  g.card_count,
  g.mana_value_needed,
  g.produces,
  array_agg(cc.name_normalized order by cc.name_normalized) as card_names,
  coalesce(
    array_agg(cc.name_normalized) filter (where cc.must_be_commander),
    array[]::text[]
  ) as commander_required
from gewinner g
join public.spellbook_combo_cards cc on cc.combo_id = g.id
group by g.id, g.card_count, g.mana_value_needed, g.produces;

comment on materialized view public.spellbook_winning_combos is
  'Combos, deren Ergebnis ein Spiel beendet, samt Kartenliste. Die Auswahl trifft spellbook_winning_combo_muster() - dieselbe Zeichenkette wie SIEG_MUSTER in src/app/goldfish-sim.ts.';

create unique index if not exists spellbook_winning_combos_id_idx
  on public.spellbook_winning_combos (combo_id);

-- Neu: ein GIN-Index auf die Kartenliste. Die Frage "welche Combos stecken vollstaendig in dieser
-- Deckliste" ist ein <@ auf card_names, und ohne Index liest Postgres dafuer alle rund 19.000
-- Zeilen. Die Funktion darunter laeuft bei jedem Oeffnen eines Decks in der App.
create index if not exists spellbook_winning_combos_cards_idx
  on public.spellbook_winning_combos using gin (card_names);

grant select on public.spellbook_winning_combos to anon, authenticated;

-- =====================================================================================
-- 3. Die Funktion an der Ansicht wieder anlegen - unverändert gegenüber
--    sql/winning-combos-in-deck-2026-09-16.sql, nur eben nach dem Neubau.
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
  where c.card_names <@ deck_names
    and c.commander_required <@ commander_names;
$$;

comment on function public.winning_combos_in_deck(text[], text[]) is
  'Zahl der Combos aus spellbook_winning_combos, die vollstaendig in dieser Deckliste stecken. Grundlage von Urteil F in src/app/bracket.ts.';

grant execute on function public.winning_combos_in_deck(text[], text[]) to anon, authenticated;
