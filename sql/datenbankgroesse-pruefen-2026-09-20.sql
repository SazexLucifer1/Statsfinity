-- Wo die 398 von 500 MB liegen - und ob es mehr wird. MIT ERGEBNIS, siehe unten.
-- Im Supabase-SQL-Editor ausführen. Reine Abfragen, ändert nichts (Abschnitt 5 legt auf Wunsch
-- eine kleine Messtabelle an, Abschnitt 6 ist auskommentiert).
--
-- ACHTUNG BEIM KOPIEREN: Der Supabase-SQL-Editor zeigt nur das Ergebnis der LETZTEN Abfrage.
-- Die Abschnitte einzeln ausführen, sonst sieht man von fünf Auswertungen genau eine.
--
-- ANLASS: Die Datenbank stand am 15.09. bei 494 MB, kurz vor dem Umschalten auf read-only. Die
-- Umstellung der Kartenlisten auf Arrays (sql/archidekt-pool-card-arrays-2026-09-15.sql) hat rund
-- 154 MB zurückgegeben, danach war sie wieder bei 432 MB laut Dashboard.
--
-- =====================================================================================
-- DAS ERGEBNIS DER ERSTEN MESSUNG (20.09.2026, pg_database_size meldet 398 MB; das Dashboard
-- zählt mit 432 MB zusätzlich WAL und Systemkataloge)
-- =====================================================================================
--
--   Spellbook-Cache (combos, combo_cards, winning_combos, ...)   ~193 MB   48 %
--   Archidekt-Deckvorrat (pool, cardlists, names)                ~110 MB   28 %
--   Scryfall-Cache (cards, effects)                               ~48 MB   12 %
--   deck_sim_results                                               25 MB    6 %
--   ALLE echten App-Daten (decks, matches, players, Turniere)      ~7 MB    2 %
--
-- DIE ZAHL, AUF DIE ES ANKOMMT: Die Nutzerdaten dieser App sind SIEBEN MEGABYTE. Alles andere
-- sind eingekaufte Fremddaten. Wer hier Platz sucht, sucht ihn nicht bei den Matches.
--
-- WAS SICH GEGENÜBER DER VERMUTUNG GEÄNDERT HAT - zwei Irrtümer, beide lehrreich:
--
--   1) "Die nächtlichen Abgleiche blähen die Datenbank auf." Stimmt so NICHT. Das Neuschreiben
--      findet statt und ist messbar (spellbook_combos hat 1.377.393 updates bei 105.025 Zeilen,
--      also exakt 13 volle Durchläufe), aber autovacuum kommt hinterher: 5,2 % bzw. 1,4 % tote
--      Zeilen, letzter Lauf jeweils am Messtag. Das Wachstum kam nicht aus den Nächten, sondern
--      aus dem Import - 51.000 Decks statt der 48.638 aus der Auswertung.
--
--   2) "Die Indizes sind aufgebläht." Auch nicht. spellbook_combo_cards_pkey ist 33 MB groß und
--      damit fast so groß wie die Tabelle selbst (35 MB) - aber rechnerisch korrekt: Der
--      Primärschlüssel ist (combo_id text, name_normalized text), bei 383.229 Zeilen sind das
--      ~29 MB an reinen Schlüsseldaten. Der Index ist nicht kaputt, er ist teuer ENTWORFEN.
--
-- DAMIT IST ES DERSELBE FEHLER WIE BEI archidekt_deck_pool_cards, wo der Primärschlüssel allein
-- 72 MB gekostet hat: eine Zeile je Karte, Textschlüssel in jeder davon. Die Lösung war dort ein
-- Zahlen-Array je Deck; dieselbe Umstellung auf spellbook_combo_cards (ein Array je Combo statt
-- 3,6 Zeilen je Combo) würde die 82 MB dieser Tabelle auf etwa 15 MB drücken. Das ist der
-- größte strukturelle Hebel, der hier noch liegt - und er ist schon einmal gebaut worden.
--
-- WAS SOFORT GEHT, ohne irgendetwas umzubauen (Abschnitt 6):
--   deck_sim_results hält die Fassungen 3, 5 und 7. Fassung 8 hat nie einen Lauf gesehen. Die
--   Fassungen 3 und 5 sind 98.637 Zeilen (~17 MB) und durch Fassung 7 ersetzt.
--
-- WAS OHNE DATENBANKZUGANG MESSBAR WAR (REST-API, zum Vergleich der Schätzgüte): die
-- Zeilenzahlen stimmten, die Größen lagen 10-25 % zu niedrig, weil Zeilenköpfe, Ausrichtung und
-- freier Platz in den Seiten von außen unsichtbar sind.
-- =====================================================================================
-- 1. Der Überblick: Gesamtgröße und die größten Tabellen.
--
--    pg_total_relation_size ist die Zahl, auf die es ankommt - sie enthält die Tabelle, ihre
--    Indizes UND den TOAST-Bereich, in dem Postgres lange Texte auslagert. Wer nur
--    pg_table_size ansieht, übersieht bei spellbook_combos genau die description-Spalte, die
--    den Platz kostet.
-- =====================================================================================
select pg_size_pretty(pg_database_size(current_database())) as datenbank_gesamt;

select
  c.relname                                            as tabelle,
  case c.relkind when 'm' then 'materialisiert' else 'tabelle' end as art,
  pg_size_pretty(pg_total_relation_size(c.oid))        as gesamt,
  pg_size_pretty(pg_relation_size(c.oid))              as nur_zeilen,
  pg_size_pretty(pg_indexes_size(c.oid))               as indizes,
  pg_size_pretty(
    pg_total_relation_size(c.oid) - pg_relation_size(c.oid) - pg_indexes_size(c.oid)
  )                                                    as lange_texte_toast,
  round(
    100.0 * pg_total_relation_size(c.oid) / nullif(pg_database_size(current_database()), 0), 1
  )                                                    as prozent_der_datenbank
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relkind in ('r', 'm')
order by pg_total_relation_size(c.oid) desc
limit 25;

-- Und dieselbe Frage eine Ebene tiefer: WELCHER Index kostet das.
--
-- Diese Abfrage hat den eigentlichen Befund geliefert und gehört deshalb dazu. Wenn eine Tabelle
-- mehr Index als Inhalt hat, ist das fast nie Aufblähung, sondern ein teurer Schlüssel - und ein
-- Schlüssel lässt sich ändern, Aufblähung nicht. Gemessen am 20.09.:
--
--   spellbook_combo_cards_pkey      33 MB   btree (combo_id text, name_normalized text)
--   archidekt_deck_pool_search_idx  14 MB   gin (search_text gin_trgm_ops)
--   spellbook_combo_cards_synced_at 8,3 MB  braucht der nächtliche Abgleich zum Aufräumen
--
-- Der erste ist der Fall: 383.229 Zeilen mal zwei Textspalten sind rechnerisch ~29 MB, der Index
-- ist also gesund und trotzdem das Problem.
select
  t.relname                                as tabelle,
  i.relname                                as index_name,
  pg_size_pretty(pg_relation_size(i.oid))  as groesse,
  pg_get_indexdef(i.oid)                   as definition
from pg_class t
join pg_index x on x.indrelid = t.oid
join pg_class i on i.oid = x.indexrelid
join pg_namespace n on n.oid = t.relnamespace
where n.nspname = 'public'
order by pg_relation_size(i.oid) desc
limit 20;

-- =====================================================================================
-- 2. Verdacht A: Aufblähung durch die nächtlichen Abgleiche.
--
--    SO IST DAS ZU LESEN: n_dead_tup sind tote Zeilen, die autovacuum noch nicht freigegeben
--    hat. Eine hohe Zahl direkt nach dem nächtlichen Lauf ist normal. Ein Alarmzeichen ist
--    etwas anderes: last_autovacuum liegt Tage zurück, ODER n_dead_tup ist dauerhaft in der
--    Größenordnung von n_live_tup. Dann kommt autovacuum dem nächtlichen Neuschreiben nicht
--    hinterher, und die Datei wächst Nacht für Nacht weiter.
--
--    WICHTIG: Auch ein sauber arbeitendes autovacuum gibt den Platz nur INNERHALB der Datei
--    frei. Die Datei selbst schrumpft nie von allein. "Freier Platz in einer 200-MB-Datei"
--    zählt für den Free-Plan trotzdem als 200 MB.
-- =====================================================================================
select
  relname                                                              as tabelle,
  n_live_tup                                                           as zeilen_lebend,
  n_dead_tup                                                           as zeilen_tot,
  round(100.0 * n_dead_tup / nullif(n_live_tup + n_dead_tup, 0), 1)    as prozent_tot,
  n_tup_upd                                                            as updates_gesamt,
  n_tup_del                                                            as deletes_gesamt,
  last_autovacuum,
  last_autoanalyze
from pg_stat_user_tables
where schemaname = 'public'
order by n_dead_tup desc
limit 20;

-- =====================================================================================
-- 3. Verdacht B: Wie viele Simulator-Fassungen liegen noch in deck_sim_results?
--
--    Die letzte Spalte ist die eigentliche Antwort: Was kostet alles, was NICHT die aktuelle
--    Fassung 8 ist? Genau das ist der Platz, den ein delete zurückgeben würde - ohne dass ein
--    aktuelles Ergebnis verloren geht.
-- =====================================================================================
select
  sim_version                                                          as fassung,
  count(*)                                                             as zeilen,
  min(berechnet_at)::date                                              as erster_lauf,
  max(berechnet_at)::date                                              as letzter_lauf,
  pg_size_pretty(
    (count(*) * (pg_total_relation_size('public.deck_sim_results')
                 / nullif((select count(*) from public.deck_sim_results), 0)))::bigint
  )                                                                    as anteil_geschaetzt
from public.deck_sim_results
group by sim_version
order by sim_version;

-- =====================================================================================
-- 4. Der Deckvorrat: ist er noch der Posten, für den ihn die Umbau-Migration gehalten hat?
-- =====================================================================================
select
  (select count(*) from public.archidekt_deck_pool)           as decks,
  (select count(*) from public.archidekt_deck_pool_cardlists) as kartenlisten,
  (select count(*) from public.archidekt_pool_card_names)     as kartennamen,
  pg_size_pretty(
    pg_total_relation_size('public.archidekt_deck_pool')
    + pg_total_relation_size('public.archidekt_deck_pool_cardlists')
    + pg_total_relation_size('public.archidekt_pool_card_names')
  )                                                           as vorrat_gesamt;

-- =====================================================================================
-- 5. "Wird es gerade mehr?" - die Frage, die eine einzelne Messung nicht beantworten kann.
--
--    Eine Momentaufnahme sagt, wie groß es IST. Ob es WÄCHST, sagt erst die zweite Messung.
--    Deshalb hier eine winzige Tabelle (ein paar hundert Byte je Lauf), die jeden Aufruf
--    festhält. Diese Datei ein zweites Mal ausführen - am besten nach dem nächsten nächtlichen
--    Abgleich, also an einem Folgetag nach ca. 11:00 deutscher Zeit - und die letzte Abfrage
--    zeigt den Zuwachs je Tabelle.
-- =====================================================================================
create table if not exists public.groessen_verlauf (
  gemessen_at timestamptz not null default now(),
  tabelle     text        not null,
  bytes       bigint      not null,
  primary key (gemessen_at, tabelle)
);

comment on table public.groessen_verlauf is
  'Messpunkte der Tabellengroessen. Gefuellt von sql/datenbankgroesse-pruefen-2026-09-20.sql, damit sich Wachstum von Groesse unterscheiden laesst.';

alter table public.groessen_verlauf enable row level security;

drop policy if exists "Developers can read the size history" on public.groessen_verlauf;
create policy "Developers can read the size history"
on public.groessen_verlauf
for select
to authenticated
using (is_developer(auth.uid()));

-- Diesen Lauf festhalten.
insert into public.groessen_verlauf (tabelle, bytes)
select c.relname, pg_total_relation_size(c.oid)
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relkind in ('r', 'm');

-- Der Zuwachs zwischen der ersten und der letzten Messung. Beim allerersten Lauf ist das
-- erwartungsgemäß leer - dann ist es eben der Startpunkt.
with grenzen as (
  select min(gemessen_at) as von, max(gemessen_at) as bis
  from public.groessen_verlauf
),
paar as (
  select
    v.tabelle,
    max(v.bytes) filter (where v.gemessen_at = g.von)  as zuerst,
    max(v.bytes) filter (where v.gemessen_at = g.bis)  as zuletzt,
    g.von,
    g.bis
  from public.groessen_verlauf v
  cross join grenzen g
  group by v.tabelle, g.von, g.bis
)
select
  tabelle,
  pg_size_pretty(zuerst)                               as vorher,
  pg_size_pretty(zuletzt)                              as jetzt,
  pg_size_pretty(zuletzt - zuerst)                     as zuwachs,
  round(extract(epoch from (bis - von)) / 86400.0, 1)  as tage,
  -- Bei zwei Messungen kurz hintereinander ergäbe die Hochrechnung Unsinn (aus 15 MB in
  -- zehn Sekunden würden "136 GB pro Tag"). Unter einer Stunde Abstand bleibt sie deshalb leer.
  case
    when bis - von < interval '1 hour' then null
    else pg_size_pretty(
      ((zuletzt - zuerst) / (extract(epoch from (bis - von)) / 86400.0))::bigint
    )
  end                                                  as zuwachs_pro_tag
from paar
where bis > von
  and zuerst is not null
  and zuletzt is not null
  and zuletzt <> zuerst
order by zuletzt - zuerst desc;

-- =====================================================================================
-- 6. Was danach zu tun wäre - BEWUSST AUSKOMMENTIERT.
--
--    Erst messen, dann löschen. Die Zahlen aus den Abschnitten oben entscheiden, welcher dieser
--    Schritte überhaupt etwas bringt; blind ausgeführt geben sie im schlechtesten Fall nichts
--    frei und kosten im Fall von "vacuum full" die Erreichbarkeit der Tabelle.
--
--    a) Alte Simulator-Fassungen. Gibt echten Platz frei, wenn Abschnitt 3 mehrere Fassungen
--       zeigt - gemessen am 20.09. waren das 3, 5 und 7, zusammen 25 MB.
--
--       NICHT "where sim_version <> '<aktuelle>'" schreiben. SIM_VERSION steht in
--       scripts/simulate-deck-pool.js inzwischen auf '8', aber ein Lauf dieser Fassung hat nie
--       stattgefunden - ein delete auf alles außer '8' hätte die Tabelle GELEERT, samt der
--       Fassung 7, auf der die Trennschärfe-Messung vom 17.09. beruht (Game Changer 0,898,
--       Tutoren 0,771, dokumentiert in CLAUDE.md und im Kopf von
--       sql/deck-sim-feature-strength-2026-09-16.sql). Die zu löschenden Fassungen deshalb
--       IMMER aus Abschnitt 3 ablesen und einzeln aufzählen, statt sie auszurechnen.
--
-- delete from public.deck_sim_results where sim_version in ('3', '5');
-- vacuum full public.deck_sim_results;
--
--    b) Aufblähung zurückgeben. "vacuum full" ist das Einzige, was die Datei wirklich
--       schrumpfen lässt - es schreibt die Tabelle neu. Zwei Warnungen, beide ernst:
--       Die Tabelle ist währenddessen GESPERRT (die App sieht sie nicht), und Postgres braucht
--       kurzzeitig Platz für die alte UND die neue Fassung.
--
--       DESHALB MIT DER KLEINSTEN BEGINNEN, nicht mit der größten: spellbook_combos ist 102 MB,
--       ein "vacuum full" darauf stünde bei 398 MB Bestand kurzzeitig bei rund 500 MB - genau
--       die Grenze, ab der Supabase auf read-only schaltet. Erst a) ausführen, damit Luft da
--       ist, dann nach jedem Schritt Abschnitt 1 wiederholen.
--
--       Ob sich das überhaupt lohnt, sagt pgstattuple (free_percent ist der Anteil, den ein
--       "vacuum full" zurückgäbe) - messen statt vermuten:
--
-- create extension if not exists pgstattuple with schema extensions;
-- select * from extensions.pgstattuple('public.spellbook_combos');
--
-- vacuum full public.scryfall_cards;
-- vacuum full public.spellbook_combos;
--
--    c) Die Messtabelle aus Abschnitt 5 wieder los werden, wenn die Frage beantwortet ist.
--
-- drop table if exists public.groessen_verlauf;
