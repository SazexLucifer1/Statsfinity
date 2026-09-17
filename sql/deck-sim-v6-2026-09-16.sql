-- Fassung 6 des Goldfish-Stapellaufs: neue Messgrößen, und drei Reparaturen an der Auswertung.
-- Im Supabase-SQL-Editor ausführen. Idempotent.
--
-- WAS NEU GEMESSEN WIRD und warum jede Spalte ihren Platz verdient:
--
--   schaden_zug10  Der aufaddierte Schaden bis Zug 10 - die UNZENSIERTE Uhr. Der Siegzug steht bei
--                  der Mehrzahl aller Decks auf 21 ("nie gewonnen"). Eine Spalte, in der zwei
--                  Drittel aller Zeilen denselben Wert tragen, kann nichts mehr trennen, egal wie
--                  gut die Simulation darunter ist. Der Schaden bis Zug 10 unterscheidet auch
--                  zwischen zwei Decks, die beide nie gewinnen, aber 12 und 34 Schaden aufbauen.
--                  Wenn irgendeine der neuen Spalten Trennschärfe zeigt, dann vermutlich diese.
--   streuung       p75 - p25 der Siegzüge, also die VERLÄSSLICHKEIT. Zwei Decks können beide im
--                  Median in Zug 8 gewinnen - das eine immer, das andere in der Hälfte der Spiele
--                  in Zug 5 und sonst gar nicht. Am Tisch sind das zwei verschiedene Decks, und in
--                  keiner bisherigen Spalte stand der Unterschied.
--   leerlauf       Züge ohne einen einzigen gewirkten Zauber - das Maß für "das Deck stolpert".
--   mulligans      Wie oft die Starthand nicht zu gebrauchen war.
--   abbruch_anteil Wie oft die Schleifensicherung der Hauptphase gegriffen hat. Eine
--                  Ehrlichkeitszahl: Sie stand vorher nirgends und hat still Ergebnisse verkürzt.
--
-- DIE DREI REPARATUREN:
--
--   a) deck_sim_auc() hatte die Fassung als Literal ('5') in der Signatur, während SIM_VERSION im
--      JavaScript steht. Beim ersten Simulator-Update wäre die Trennschärfe-Ansicht stillschweigend
--      blind geworden: lauter null, brav mit "nulls last" nach unten sortiert, also aussehend wie
--      "keine Daten" statt wie "falsche Fassung". Jetzt ist die Voreinstellung "die neueste
--      vorhandene Fassung".
--   b) karten_erkannt hat nie gefiltert. Die Spalte existiert, damit auffällt, wenn die
--      Kartenauswertung ein Deck kaum verstanden hat - und dann stand so eine Zeile gleichberechtigt
--      neben einer mit 95 % im Stufenvergleich. Jetzt filtern beide Auswertungen darauf.
--   c) deck_sim_by_bracket verglich Mittelwerte über ALLE Zeilen einer Stufe, ohne zu zeigen, wie
--      breit die Verteilungen dahinter liegen. Die Quartile stehen jetzt daneben - der Vergleich
--      der Rampe ist genau daran gescheitert (Mittelwerte 12,6 gegen 14,5, Verteilungen fast
--      deckungsgleich).

-- =====================================================================================
-- 1. Die neuen Spalten.
--
--    "add column if not exists" statt einer neuen Tabelle: Die alten Zeilen (Fassung 5) bleiben
--    stehen und bekommen in den neuen Spalten ihre Vorgabewerte. Vergleichbar sind sie mit den
--    neuen ohnehin nicht - dafür steht sim_version im Primärschlüssel.
-- =====================================================================================
alter table public.deck_sim_results
  add column if not exists schaden_zug10 smallint not null default 0,
  add column if not exists streuung smallint not null default 0,
  add column if not exists p25_siegzug smallint not null default 0,
  add column if not exists p75_siegzug smallint not null default 0,
  add column if not exists mulligans real not null default 0,
  add column if not exists leerlauf real not null default 0,
  add column if not exists abbruch_anteil real not null default 0;

comment on column public.deck_sim_results.schaden_zug10 is
  'Median des bis Zug 10 aufaddierten Schadens. Die unzensierte Uhr: anders als median_siegzug steht sie nicht bei zwei Dritteln aller Decks am Anschlag.';
comment on column public.deck_sim_results.streuung is
  'p75 - p25 der Siegzuege. Verlaesslichkeit als eigene Achse - ein Deck, das mal in Zug 5 und mal gar nicht gewinnt, ist ein anderes als eines, das immer in Zug 8 gewinnt.';
comment on column public.deck_sim_results.leerlauf is
  'Zuege ohne einen einzigen gewirkten Zauber, je Spiel. Das Mass fuer "das Deck stolpert".';
comment on column public.deck_sim_results.abbruch_anteil is
  'Anteil der Spiele, in denen die Schleifensicherung der Hauptphase griff (40 Zauber in einem Zug). Ehrlichkeitszahl - vorher wurde das still verschluckt.';

-- =====================================================================================
-- 2. Welche Fassung ist die aktuelle? Einmal beantwortet, statt in jeder Signatur abgeschrieben.
-- =====================================================================================
create or replace function public.deck_sim_neueste_fassung()
returns text
language sql
stable
security invoker
set search_path = public
as $$
  select max(sim_version) from public.deck_sim_results;
$$;

comment on function public.deck_sim_neueste_fassung() is
  'Die hoechste in deck_sim_results vorhandene Simulator-Fassung. Ersetzt das fruehere Literal in der Signatur von deck_sim_auc().';

grant execute on function public.deck_sim_neueste_fassung() to authenticated, service_role;

-- =====================================================================================
-- 3. Der Stufenvergleich - mit Erkennungsfilter und mit Quartilen.
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
  -- Die unzensierte Uhr, mit Quartilen: Ein Median allein verschweigt, wie stark sich zwei Stufen
  -- ueberlappen - und genau diese Ueberlappung hat die Rampe als Kennzahl erledigt.
  percentile_cont(0.25) within group (order by r.schaden_zug10) as schaden10_p25,
  percentile_cont(0.5) within group (order by r.schaden_zug10) as schaden10_median,
  percentile_cont(0.75) within group (order by r.schaden_zug10) as schaden10_p75,
  percentile_cont(0.5) within group (order by r.streuung) as streuung,
  round(avg(r.leerlauf)::numeric, 2) as leerlauf,
  round(avg(r.mulligans)::numeric, 2) as mulligans,
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
  round(avg(r.karten_erkannt)::numeric, 3) as karten_erkannt,
  round(avg(r.abbruch_anteil)::numeric, 3) as abbruch_anteil
from public.deck_sim_results r
join public.archidekt_deck_pool d on d.id = r.deck_id
-- Zeilen, bei denen die Kartenauswertung das Deck kaum verstanden hat, sagen mehr ueber die
-- Auswertung als ueber das Deck. Sie bleiben gespeichert, gehen aber nicht in den Vergleich ein.
where r.karten_erkannt >= 0.6
group by d.creator_bracket, r.sim_version
order by r.sim_version, d.creator_bracket;

comment on view public.deck_sim_by_bracket is
  'Eine Zeile je Bracket-Stufe und Simulator-Fassung. Nur Zeilen mit karten_erkannt >= 0,6. Eine Spalte, deren Werte von Stufe 2 zu Stufe 4 nicht monoton laufen, trennt die Stufen nicht.';

-- =====================================================================================
-- 4. Die Trennschärfe - ohne fest eingebaute Fassung, mit Erkennungsfilter.
-- =====================================================================================
drop view if exists public.deck_sim_feature_strength;
drop function if exists public.deck_sim_auc(text, integer, integer, text);

create or replace function public.deck_sim_auc(
  merkmal text,
  stufe_niedrig integer,
  stufe_hoch integer,
  fassung text default null,
  mindest_erkannt real default 0.6
)
returns numeric
language plpgsql
stable
security invoker
set search_path = public
as $$
declare
  ergebnis numeric;
  gewaehlte_fassung text;
begin
  -- Fruehere Fassung: "fassung text default '5'". Das Literal stand im SQL, SIM_VERSION im
  -- JavaScript - beim ersten Simulator-Update haette diese Funktion lauter null geliefert und
  -- ausgesehen wie "keine Daten" statt wie "falsche Fassung".
  gewaehlte_fassung := coalesce(fassung, public.deck_sim_neueste_fassung());

  execute format(
    $f$
    with daten as (
      select d.creator_bracket as stufe, (r.%I)::numeric as wert
      from public.deck_sim_results r
      join public.archidekt_deck_pool d on d.id = r.deck_id
      where r.sim_version = $1
        and r.karten_erkannt >= $4
        and d.creator_bracket in ($2, $3)
    ),
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
  using gewaehlte_fassung, stufe_niedrig, stufe_hoch, mindest_erkannt;

  return ergebnis;
end;
$$;

comment on function public.deck_sim_auc(text, integer, integer, text, real) is
  'Trennschaerfe eines Merkmals zwischen zwei Bracket-Stufen als AUC (0,5 = trennt gar nicht). Ohne Angabe wird die neueste Fassung genommen, nicht eine fest eingebaute.';

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
  -- simuliert, Fassung 5
  'median_siegzug',
  'schnellste10',
  'kumulativ_median',
  'siegquote',
  'combo_anteil',
  'mana_zug3',
  'mana_zug5',
  'mana_zug7',
  -- simuliert, neu in Fassung 6
  'schaden_zug10',
  'streuung',
  'leerlauf',
  'mulligans',
  -- Eigenkontrolle
  'karten_erkannt'
]) as m(merkmal)
cross join lateral (
  select
    public.deck_sim_auc(m.merkmal, 2, 4) as auc_2_gegen_4,
    public.deck_sim_auc(m.merkmal, 1, 5) as auc_1_gegen_5,
    public.deck_sim_auc(m.merkmal, 3, 4) as auc_3_gegen_4
) as w
order by 5 desc nulls last;

comment on view public.deck_sim_feature_strength is
  'Trennschaerfe jedes Merkmals zwischen den Bracket-Stufen, ueber die neueste Simulator-Fassung. 0,5 heisst "trennt gar nicht". Oben steht, was taugt.';
