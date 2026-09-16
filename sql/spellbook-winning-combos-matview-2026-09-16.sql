-- Die Liste der spielbeendenden Combos einmal ausrechnen statt bei jeder Abfrage neu.
-- Im Supabase-SQL-Editor ausführen. Idempotent.
--
-- WAS KAPUTT WAR: sql/deck-sim-results-2026-09-16.sql hat spellbook_winning_combos als gewöhnliche
-- Ansicht angelegt. Eine Ansicht speichert nichts - sie ist ein gespeicherter Abfragetext, und
-- jede Abfrage darauf rechnet alles neu: Verknüpfung von spellbook_combos mit den 369.706 Zeilen
-- in spellbook_combo_cards, Gruppierung, dazu ein Ausdrucksvergleich über jedes einzelne Element
-- der produces-Arrays.
--
-- Der Stapellauf holt die rund 19.000 Zeilen in Paketen zu 1.000 - also ZWANZIGMAL dieselbe
-- Rechnung. Nachgemessen 2,8 Sekunden je Paket. Das lief zweimal gerade so durch und ist beim
-- dritten Lauf in die Zeitüberschreitung gelaufen ("canceling statement due to statement
-- timeout"), ohne dass sich an der Abfrage etwas geändert hätte - die Combo-Tabellen sind über
-- Nacht gewachsen. Eine Abfrage, die nur knapp unter der Grenze liegt, ist keine funktionierende
-- Abfrage, sie ist eine, die noch nicht gescheitert ist.
--
-- Eine MATERIALISIERTE Ansicht speichert das Ergebnis als Tabelle. Die Rechnung läuft einmal beim
-- Anlegen und danach beim Auffrischen; alle Abfragen lesen nur noch 19.000 fertige Zeilen.
--
-- WAS DAS KOSTET: Das Ergebnis ist eine Momentaufnahme. Kommen durch den nächtlichen
-- Spellbook-Abgleich neue Combos dazu, stehen sie erst nach einem Auffrischen hier drin - deshalb
-- ruft scripts/sync-spellbook-bracket.js am Ende seines Laufs die Funktion unten auf. Von Hand
-- geht es auch: "select public.refresh_spellbook_winning_combos();"
--
-- ZUR SICHTBARKEIT: Auf materialisierte Ansichten lässt sich KEIN row level security anwenden.
-- Das ist hier folgenlos, weil die beiden Quelltabellen ohnehin für jeden lesbar sind (siehe
-- sql/spellbook-combos-2026-09-07.sql) - es sind öffentliche Kartendaten von Commander Spellbook,
-- keine Nutzerdaten. Hier steht also nichts, was nicht vorher schon offen lag.

-- =====================================================================================
-- 1. Die alte Ansicht weg. Beide Formen abräumen, damit die Datei auch dann läuft, wenn
--    jemand sie ein zweites Mal ausführt.
-- =====================================================================================
drop view if exists public.spellbook_winning_combos;
drop materialized view if exists public.spellbook_winning_combos;

-- =====================================================================================
-- 2. Dasselbe Ergebnis, einmal gerechnet.
--
--    Die Filterung steht bewusst in einem eigenen, mit "as materialized" festgenagelten Schritt:
--    So sucht Postgres zuerst die rund 19.000 gewinnenden Combos heraus und verknüpft erst danach
--    deren Karten. Ohne das darf der Planer die Reihenfolge umdrehen und die Kartenzeilen aller
--    108.000 Combos anfassen, um hinterher 82 % davon wegzuwerfen.
--
--    Die Unterscheidung in der Ausdrucksliste ist der springende Punkt der ganzen Tabelle:
--    Unendlich MANA gewinnt gar nichts, solange nichts da ist, wofür man es ausgibt. Unendlich
--    SCHADEN schon. Dieselbe Auswahl trifft istSiegCombo() in src/app/goldfish-sim.ts - laufen die
--    beiden Listen auseinander, misst der Simulator etwas anderes, als er lädt.
-- =====================================================================================
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
    where p ~* 'win the game|infinite damage|infinite turns|infinite mill|infinite loss of life|loses the game'
  )
)
select
  g.id as combo_id,
  g.card_count,
  g.mana_value_needed,
  g.produces,
  array_agg(cc.name_normalized order by cc.name_normalized) as card_names,
  -- Rund vierzig Combos verlangen, dass eine bestimmte Karte der COMMANDER ist (sie brauchen die
  -- Kommandozone). Ohne diese Spalte bekaeme ein Deck eine Combo angerechnet, die es gar nicht
  -- ausfuehren kann - dieselbe Pruefung macht presentCombos() in src/app/bracket.ts.
  coalesce(
    array_agg(cc.name_normalized) filter (where cc.must_be_commander),
    array[]::text[]
  ) as commander_required
from gewinner g
join public.spellbook_combo_cards cc on cc.combo_id = g.id
group by g.id, g.card_count, g.mana_value_needed, g.produces;

comment on materialized view public.spellbook_winning_combos is
  'Combos, deren Ergebnis ein Spiel beendet, samt Kartenliste - einmal gerechnet statt bei jeder Abfrage neu. Gegenstueck zu istSiegCombo() in src/app/goldfish-sim.ts. Auffrischen: select public.refresh_spellbook_winning_combos();';

-- Eindeutiger Index: macht das Blättern schnell und ist zugleich die Voraussetzung dafür, später
-- "refresh materialized view concurrently" nutzen zu können (Auffrischen ohne Lesesperre).
create unique index if not exists spellbook_winning_combos_id_idx
  on public.spellbook_winning_combos (combo_id);

grant select on public.spellbook_winning_combos to anon, authenticated;

-- =====================================================================================
-- 3. Auffrischen als Funktion.
--
--    Als Funktion und nicht als nacktes Kommando, weil der nächtliche Abgleich sie über die
--    Supabase-Schnittstelle aufrufen können muss - ein "refresh materialized view" lässt sich von
--    dort nicht abschicken, ein Funktionsaufruf schon.
--
--    security definer, damit sie mit den Rechten ihres Eigentümers läuft; ausführen darf sie
--    ausschliesslich der Service-Role-Key des Abgleichs. Ohne das Entziehen der Standardrechte
--    dürfte sie jeder aufrufen und damit beliebig oft eine teure Rechnung auslösen.
-- =====================================================================================
create or replace function public.refresh_spellbook_winning_combos()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  refresh materialized view public.spellbook_winning_combos;
end;
$$;

comment on function public.refresh_spellbook_winning_combos() is
  'Frischt die materialisierte Ansicht spellbook_winning_combos auf. Wird am Ende von scripts/sync-spellbook-bracket.js aufgerufen, sobald neue Combos eingespielt wurden.';

revoke all on function public.refresh_spellbook_winning_combos() from public;
grant execute on function public.refresh_spellbook_winning_combos() to service_role;
