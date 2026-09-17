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
-- ==============================================================================================
-- DAS ERGEBNIS DER ERSTEN MESSUNG (17.09.2026, Fassung 7, 48.638 Decks, 35.829 davon mit
-- Erkennungsquote >= 0,6). Hier festgehalten, damit die Vermutungen in dieser Datei und in
-- deck-sim-results nicht weiter herumstehen, als waeren sie offen.
--
--   Merkmal            2 gegen 4   Staerke   Einordnung
--   game_changer          0,898     0,398    mit Abstand das staerkste - steht laengst in bracket.ts
--   tutoren               0,771     0,271    zweitstaerkstes - steht ebenfalls schon drin (Urteil F)
--   mana_zug3             0,660     0,160    DAS EINZIGE SIMULIERTE MERKMAL, DAS ETWAS TAUGT
--   combo_anteil          0,634     0,134
--   laender               0,366     0,134    umgekehrt: weniger Laender = hoehere Stufe
--   gewinn_combos         0,633     0,133
--   rampe                 0,622     0,122    schwach, aber vorhanden - siehe unten
--   ----------------------------------------- Rauschgrenze, siehe karten_erkannt ---------------
--   karten_erkannt        0,404     0,096
--   mana_zug5             0,592     0,092
--   schnellste10          0,415     0,085
--   schaden_zug10         0,420     0,080
--   leerlauf              0,423     0,077
--   streuung              0,561     0,061
--   median_siegzug        0,465     0,035
--   siegquote             0,529     0,029
--   interaktion           0,509     0,009    trennt GAR NICHT
--
-- DREI BEFUNDE, DIE UNBEQUEM SIND:
--
-- 1. ALLES, WAS MIT GEWINNEN ZU TUN HAT, IST WERTLOS. Median-Siegzug 0,035, Siegquote 0,029,
--    kumulativer Siegzug 0,032. Die Frage, fuer die dieser Simulator gebaut wurde - "in welchem
--    Zug koennte dieses Deck gewinnen" - trennt die Bracket-Stufen nicht. Der Schaden bis Zug 10,
--    von dem sich diese Datei am meisten versprochen hat, liegt bei 0,080 und zeigt in die
--    FALSCHE Richtung: Hoehere Stufen machen weniger Kampfschaden, weil sie ueber Combos gewinnen.
--
-- 2. DIE RAUSCHGRENZE HEISST karten_erkannt UND LIEGT BEI 0,096. Die Ehrlichkeitsspalte - wie viel
--    von einem Deck die Kartenauswertung ueberhaupt versteht - trennt die Stufen BESSER als jede
--    einzelne Zahl aus der Simulation ausser mana_zug3. Hoehere Stufen spielen Karten, die der
--    Steckbrief schlechter liest (69 % bei Bracket 1, 62 % bei Bracket 5). Bei jedem Merkmal
--    unterhalb dieser Marke laesst sich Signal und eigene blinde Stelle nicht mehr trennen.
--
-- 3. DIE INTERAKTION IST TOT. Der Kommentar in deck-sim-results nannte sie "womoeglich die, die
--    die Stufen wirklich trennt". Sie ist mit 0,009 das schwaechste Merkmal der ganzen Tabelle -
--    schwaecher als der Zufall es im Mittel waere.
--
-- WAS DAFUER TAUGT: mana_zug3 (0,660), und die Reihenfolge mana_zug3 > mana_zug5 (0,092) >
-- mana_zug7 (0,070) sagt, warum: Der Unterschied zwischen den Stufen liegt in den ERSTEN DREI
-- ZUEGEN, nicht im spaeteren Spiel. Und die Rampe, die nach dem Mittelwertvergleich als erledigt
-- galt, ist mit 0,622 schwach, aber vorhanden - der Mittelwert hat sie unterschaetzt, nicht
-- ueberschaetzt.
--
-- ZUR VORSICHT BEI DEN BEIDEN STAERKSTEN: game_changer und tutoren sind teilweise ZIRKULAER. Die
-- Bracket-Stufen im Vorrat sind Selbstauskuenfte, und wer sein Deck einstuft, liest dieselbe
-- Game-Changer-Liste, die hier gezaehlt wird. Ein Teil der 0,898 misst also, wie gut Deckbauer das
-- Regelwerk anwenden, nicht wie stark ihr Deck ist.
-- ==============================================================================================

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
