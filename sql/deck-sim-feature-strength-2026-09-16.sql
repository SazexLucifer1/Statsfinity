-- Wie gut trennt jedes einzelne Merkmal die Bracket-Stufen? Eine Ansicht, die genau das misst.
-- Im Supabase-SQL-Editor ausfuehren. Idempotent.
--
-- WOZU, und das ist unbequem: Wir haben eine Menge Kennzahlen gebaut - simulierte Siegzuege,
-- Siegquoten, einen Tuning-Grad, einen Power-Wert - und bei den wenigsten je geprueft, ob sie
-- ueberhaupt etwas unterscheiden. Ein Mittelwert, der von Stufe zu Stufe steigt, sieht nach
-- Erkenntnis aus und kann trotzdem wertlos sein, wenn die Verteilungen sich fast vollstaendig
-- ueberlappen. Genau das ist bei der Rampe passiert: Mittelwerte 12,6 gegen 14,5 zwischen Bracket
-- 2 und 4 - und ein 90.-Perzentil von 20 bei Bracket 2 gegen einen Median von 14 bei Bracket 4.
--
-- Diese Ansicht beantwortet die Frage sauber, mit einer Zahl je Merkmal und Stufenpaar.
--
-- WIE SIE ZU LESEN IST: Die Zahl ist die Flaeche unter der ROC-Kurve (AUC) und beantwortet
-- woertlich: "Wenn ich ein zufaelliges Deck aus der hoeheren und eines aus der niedrigeren Stufe
-- ziehe - wie oft hat das hoehere den groesseren Wert?"
--
--   0,50   das Merkmal trennt GAR NICHT. Muenzwurf.
--   0,65   schwach, aber vorhanden
--   0,80   deutlich
--   unter 0,50   das Merkmal trennt andersherum (kleiner = staerker, etwa beim Manabetrag)
--
-- Der Abstand zu 0,50 ist die Trennschaerfe, die Richtung sagt nur, welches Vorzeichen sie hat.
-- Anders als ein Mittelwertvergleich ist die AUC unempfindlich gegen Ausreisser und gegen die
-- Frage, auf welcher Skala ein Merkmal gemessen wird - Combos (0 bis 5) und Rampe (0 bis 30)
-- sind damit direkt vergleichbar.
--
-- GERECHNET wird sie als Mann-Whitney-U ueber Raengen, nicht ueber Schwellen: Es gibt keine
-- Schwelle, die vorher gesetzt werden muesste, und damit auch keine, die man sich passend
-- zurechtlegen kann.
--
-- LAUFZEIT: Die Ansicht rechnet 51 Raenge-Sortierungen ueber je rund 20.000 Zeilen, zusammen etwa
-- fuenf bis zehn Sekunden. Im SQL-Editor ist das kein Problem; ueber die REST-Schnittstelle liefe
-- sie in die Zeitueberschreitung. Sie ist als Werkzeug zum Nachsehen gedacht, nicht fuer die App.

-- =====================================================================================
-- 1. Die Rechnung fuer EIN Merkmal und EIN Stufenpaar.
--
--    Als Funktion mit dynamischem Spaltennamen, damit nicht fuer jedes der siebzehn Merkmale
--    dieselbe zwanzigzeilige Abfrage abgeschrieben werden muss - siebzehnmal dasselbe von Hand
--    ist siebzehnmal die Gelegenheit, sich zu vertippen. %I quotiert den Spaltennamen als
--    Bezeichner; ein Wert, der keine Spalte ist, faellt damit als Fehler auf und nicht als
--    eingeschleuste Abfrage.
-- =====================================================================================
create or replace function public.deck_sim_auc(
  merkmal text,
  stufe_niedrig integer,
  stufe_hoch integer,
  fassung text default '5'
)
returns numeric
language plpgsql
stable
security invoker
set search_path = public
as $$
declare
  ergebnis numeric;
begin
  execute format(
    $f$
    with daten as (
      select d.creator_bracket as stufe, (r.%I)::numeric as wert
      from public.deck_sim_results r
      join public.archidekt_deck_pool d on d.id = r.deck_id
      where r.sim_version = $1 and d.creator_bracket in ($2, $3)
    ),
    -- Durchschnittsrang statt Minimalrang: Bei vielen gleichen Werten (Combos sind meistens 0)
    -- wuerde rank() allein die Rechnung verzerren. Der Zuschlag mittelt die Bindungsgruppe.
    raenge as (
      select
        stufe,
        rank() over (order by wert) + (count(*) over (partition by wert) - 1) / 2.0 as rang
      from daten
    ),
    groessen as (
      select
        count(*) filter (where stufe = $2) as n_niedrig,
        count(*) filter (where stufe = $3) as n_hoch,
        sum(rang) filter (where stufe = $3) as rangsumme_hoch
      from raenge
    )
    select case
             when n_niedrig = 0 or n_hoch = 0 then null
             else round(
               (rangsumme_hoch - n_hoch * (n_hoch + 1) / 2.0) / (n_niedrig::numeric * n_hoch),
               3
             )
           end
    from groessen
    $f$,
    merkmal
  )
  into ergebnis
  using fassung, stufe_niedrig, stufe_hoch;

  return ergebnis;
end;
$$;

comment on function public.deck_sim_auc(text, integer, integer, text) is
  'Trennschaerfe eines Merkmals zwischen zwei Bracket-Stufen als AUC (0,5 = trennt gar nicht). Gerechnet als Mann-Whitney-U ueber Durchschnittsraengen, also ohne vorher gesetzte Schwelle.';

-- =====================================================================================
-- 2. Alle Merkmale nebeneinander.
--
--    Die Spalte "2 gegen 4" ist die wichtigste: Das ist die Grenze, an der sich die Frage dieses
--    ganzen Projekts entscheidet - ein Deck, das die Regeln von Bracket 2 einhaelt und trotzdem
--    wie Bracket 4 spielt. "1 gegen 5" zeigt, was ein Merkmal im besten Fall kann, "3 gegen 4"
--    die schwerste Grenze.
--
--    Sortiert nach Trennschaerfe an der 2-gegen-4-Grenze, damit oben steht, was taugt - und
--    unten, was wir umsonst gebaut haben.
-- =====================================================================================
create or replace view public.deck_sim_feature_strength
with (security_invoker = true) as
select
  m.merkmal,
  w.auc_2_gegen_4,
  w.auc_1_gegen_5,
  w.auc_3_gegen_4,
  abs(w.auc_2_gegen_4 - 0.5) as staerke_2_gegen_4
from unnest(array[
  -- gezaehlt
  'gewinn_combos',
  'tutoren',
  'rampe',
  'interaktion',
  'kartenziehen',
  'game_changer',
  'laender',
  'avg_cmc',
  -- simuliert
  'median_siegzug',
  'schnellste10',
  'kumulativ_median',
  'siegquote',
  'combo_anteil',
  'mana_zug3',
  'mana_zug5',
  'mana_zug7',
  -- Eigenkontrolle
  'karten_erkannt'
]) as m(merkmal)
-- Die drei Werte EINMAL rechnen und dann wiederverwenden: Jeder Aufruf sortiert rund 20.000
-- Zeilen, und die Staerkespalte ist nur ein Abstand zu 0,5 - sie ein zweites Mal auszurechnen
-- waere ein Drittel mehr Laufzeit fuer null Erkenntnis.
cross join lateral (
  select
    public.deck_sim_auc(m.merkmal, 2, 4) as auc_2_gegen_4,
    public.deck_sim_auc(m.merkmal, 1, 5) as auc_1_gegen_5,
    public.deck_sim_auc(m.merkmal, 3, 4) as auc_3_gegen_4
) as w
-- nulls last, damit ein Merkmal ohne Daten nicht oben steht, als waere es das beste.
order by 5 desc nulls last;

comment on view public.deck_sim_feature_strength is
  'Trennschaerfe jedes Merkmals zwischen den Bracket-Stufen. 0,5 heisst "trennt gar nicht"; der Abstand zu 0,5 ist die Staerke, die Richtung nur ihr Vorzeichen. Oben steht, was taugt.';
