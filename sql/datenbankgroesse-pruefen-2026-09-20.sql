-- Wo die 432 von 500 MB liegen - und ob es mehr wird.
-- Im Supabase-SQL-Editor ausführen. Reine Abfragen, ändert nichts (Abschnitt 5 legt auf Wunsch
-- eine kleine Messtabelle an, Abschnitt 6 ist auskommentiert).
--
-- ANLASS: Die Datenbank stand am 15.09. bei 494 MB, kurz vor dem Umschalten auf read-only. Die
-- Umstellung der Kartenlisten auf Arrays (sql/archidekt-pool-card-arrays-2026-09-15.sql) hat rund
-- 154 MB zurückgegeben. Jetzt sind es wieder 432 MB. Die Frage ist also nicht nur "was ist groß",
-- sondern "was wächst".
--
-- WAS OHNE DATENBANKZUGANG SCHON FESTSTEHT (gemessen über die REST-API, Stand 20.09.2026):
--
--   spellbook_combos            105.025 Zeilen, ~790 B je Zeile   ~83 MB nur an Daten
--   spellbook_combo_cards       372.994 Zeilen, ~142 B je Zeile   ~53 MB plus Zeilenköpfe/Index
--   scryfall_cards               35.572 Zeilen, ~836 B je Zeile   ~30 MB
--   scryfall_card_effects        26.122 Zeilen,  ~69 B je Zeile    ~2 MB
--   spellbook_two_card_combos     3.996 Zeilen, ~259 B je Zeile    ~1 MB
--
-- Der Spellbook-Cache ist damit der mit Abstand größte Posten - er allein liegt bei rund 140 MB
-- roher Daten, vor Indizes. Was von hier aus NICHT messbar ist, steht in den Developer-Tabellen
-- (archidekt_deck_pool*, deck_sim_results) und in der Aufblähung. Genau dafür ist diese Datei da.
--
-- ZWEI VERDACHTSMOMENTE, die die Abfragen unten bestätigen oder entkräften sollen:
--
--   A) Aufblähung durch die nächtlichen Abgleiche. scripts/sync-scryfall-bulk.js und
--      scripts/sync-spellbook-bracket.js schreiben JEDE Nacht JEDE Zeile neu (upsert über den
--      kompletten Bestand). In Postgres ist ein update kein Überschreiben: Die alte Zeilenfassung
--      bleibt als tote Zeile liegen, bis autovacuum sie freigibt - und der freigegebene Platz
--      bleibt danach in der Datei, er geht nicht an die Festplatte zurück. Das sind rund 540.000
--      neu geschriebene Zeilen pro Nacht (35.572 + 26.122 + 105.025 + 372.994). Eine Datenbank,
--      in die niemand etwas Neues einträgt, kann davon trotzdem wachsen. Abschnitt 2 misst das.
--
--   B) deck_sim_results sammelt Fassungen. Der Primärschlüssel ist (deck_id, sim_version), und
--      das ist Absicht - zwei Läufe verschiedener Simulator-Fassungen sind nicht vergleichbar.
--      Die Folge ist aber, dass nichts je gelöscht wird: Bei 48.638 Decks kostet jede Fassung
--      einen vollen Satz Zeilen, und der Simulator steht inzwischen bei Fassung 8. Abschnitt 3
--      zeigt, welche Fassungen noch liegen und was sie kosten.
--
-- Der Deckvorrat selbst ist nach dem Array-Umbau NICHT mehr der Hauptverdächtige: 48.638 Decks
-- kosten dort nach der Messung in der Umbau-Migration rund 45 MB.

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
--       zeigt. Die aktuelle Fassung steht als SIM_VERSION in scripts/simulate-deck-pool.js.
--
-- delete from public.deck_sim_results where sim_version <> '8';
--
--    b) Aufblähung zurückgeben. "vacuum full" ist das Einzige, was die Datei wirklich
--       schrumpfen lässt - es schreibt die Tabelle neu. Zwei Warnungen, beide ernst:
--       Die Tabelle ist währenddessen GESPERRT (die App sieht sie nicht), und Postgres braucht
--       kurzzeitig Platz für die alte UND die neue Fassung. Deshalb einzeln und mit der
--       größten Tabelle beginnen, nicht alles auf einmal.
--
-- vacuum full public.spellbook_combo_cards;
-- vacuum full public.spellbook_combos;
-- vacuum full public.scryfall_cards;
--
--    c) Die Messtabelle aus Abschnitt 5 wieder los werden, wenn die Frage beantwortet ist.
--
-- drop table if exists public.groessen_verlauf;
