-- Index auf synced_at fuer die vier Tabellen, die der naechtliche Spellbook-Abgleich aufraeumt.
-- Im Supabase-Dashboard unter "SQL Editor" ausfuehren. Idempotent ("create index if not exists"),
-- gefahrlos mehrfach ausfuehrbar, aendert keine Daten.
--
-- =====================================================================================
-- Warum
--
-- scripts/sync-spellbook-bracket.js schreibt jede Tabelle neu: erst alles mit dem Zeitstempel
-- DIESES Laufs hochladen, danach loeschen, was einen aelteren Zeitstempel traegt - das sind genau
-- die Zeilen, die es in der Quelle nicht mehr gibt (Begruendung fuer diese Reihenfolge steht im
-- Skript bei schreibeTabelle()).
--
-- Dieses Aufraeumen ist ein "delete ... where synced_at < <Laufbeginn>". Ohne Index auf synced_at
-- muss Postgres dafuer die GANZE Tabelle lesen - auch dann, wenn am Ende nur eine Handvoll Zeilen
-- wirklich veraltet ist. Bei spellbook_combos sind das rund 108.500 Zeilen mit dem Ablauftext als
-- Fliesstext, also grob 135 MB. Auf dem Free-Plan dauert dieser eine Scan laenger als das
-- statement_timeout von PostgREST, und der Lauf starb reproduzierbar mit
--
--   Abgleich fehlgeschlagen: Aufraeumen in spellbook_combos fehlgeschlagen:
--   canceling statement due to statement timeout
--
-- (Nachtlaeufe vom 15. und 16.09.2026, jeweils nach ueber einer Stunde Download - die Daten waren
-- da bereits vollstaendig geschrieben, nur der letzte Schritt fiel um.)
--
-- Mit dem Index liest Postgres statt der ganzen Tabelle nur noch die veralteten Zeilen. Die
-- Kosten sind gering: ein Zeitstempel je Zeile, bei den vier Tabellen zusammen rund 12 MB, und
-- geschrieben wird ohnehin nur einmal pro Nacht.
--
-- spellbook_combo_cards ist mit 350.000 Zeilen die laengste Tabelle und lief bisher gerade noch
-- durch - sie ist aber schmal (zwei kurze Texte je Zeile) und deshalb nur wenige Dutzend MB gross.
-- Sie bekommt denselben Index, damit sie nicht die naechste ist, die kippt.
-- =====================================================================================

create index if not exists spellbook_combos_synced_at_idx
  on public.spellbook_combos (synced_at);

create index if not exists spellbook_combo_cards_synced_at_idx
  on public.spellbook_combo_cards (synced_at);

create index if not exists spellbook_two_card_combos_synced_at_idx
  on public.spellbook_two_card_combos (synced_at);

create index if not exists spellbook_card_flags_synced_at_idx
  on public.spellbook_card_flags (synced_at);
