-- Partie-Verlauf: Startspieler, Zugreihenfolge, Spieldauer und Lebenspunkte-Verlauf je Partie.
-- Im Supabase-Dashboard unter "SQL Editor" ausführen. Idempotent.
--
-- Grundlage für die Auswertungen, die Mythic Tools anbietet und Statsfinity bisher nicht konnte
-- ("Winrate als Erster gegenüber Zweiter", Spieldauer je Deck, Lebenspunkte-Kurve nach dem
-- Spiel). Der Tracker kannte Startspieler und Lebenspunkte schon immer, er hat sie nur beim
-- Speichern weggeworfen. Je früher diese Spalten existieren, desto mehr Partien tragen die Daten.
--
--   * matches.started_at      - Start der Partie im Tracker. Dauer = played_at - started_at
--                               (played_at ist der Zeitpunkt des Speicherns). null bei Partien
--                               von vor dieser Migration, bei Turnier-Nachträgen und bei
--                               nachträglich eingetragenen Partien.
--   * matches.life_log        - Lebenspunkte- und Giftänderungen der Partie, kompakt:
--                               {"v":1,"start":40,"units":["Anna","Ben"],
--                                "events":[[sekunde, einheit, delta], [sekunde, einheit, delta, 1], ...]}
--                               einheit = Index in units (Spielername bzw. 2HG-Team), eine 1 an
--                               vierter Stelle = Gift statt Leben. Rund 10 Byte je Änderung, eine
--                               lange Commander-Partie bleibt damit unter ~4 kB. Bewusst NICHT im
--                               Match-Verlauf mitgeladen (siehe MATCH_HISTORY_SELECT), sondern
--                               später nur für die eine Partie, deren Kurve man ansieht.
--   * match_players.turn_order - Platz in der Zugreihenfolge, 1 = hat angefangen. Gerechnet aus
--                               dem Startspieler und der Sitzordnung im Tracker (im Uhrzeigersinn).
--                               null, wenn niemand als Startspieler angegeben wurde.
--
-- Keine neue RLS-Policy: Lesen und Schreiben folgen den bestehenden Regeln von matches und
-- match_players.
--
-- Fehlt die Migration, speichert und lädt die App wie bisher ohne diese Felder
-- (42703/PGRST204, siehe partieVerlaufVerfuegbar in mtg.service.ts).

alter table public.matches
  add column if not exists started_at timestamptz;

comment on column public.matches.started_at is
  'Start der Partie im Tracker; Dauer = played_at - started_at. null = unbekannt.';

alter table public.matches
  add column if not exists life_log jsonb;

comment on column public.matches.life_log is
  'Lebenspunkte-/Giftverlauf: {"v":1,"start":40,"units":[...],"events":[[sek, einheit, delta(, 1 = Gift)]]}.';

alter table public.match_players
  add column if not exists turn_order smallint;

comment on column public.match_players.turn_order is
  'Platz in der Zugreihenfolge, 1 = hat angefangen. null = unbekannt.';
