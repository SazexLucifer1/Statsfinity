-- Spielweise eines Decks für den Deck-Check (Aggro, Control, Combo, Landfall, …).
-- Im Supabase-Dashboard unter "SQL Editor" ausführen. Idempotent.
--
-- Der Deck-Check richtet seine Zielwerte nach der Deckbau-Tabelle des Users (public/richtwerte/):
-- je Kategorie eine Spanne, und je Spielweise rückt das Ziel Richtung "weniger" oder "mehr".
-- Welche Spielweisen ein Deck hat, legt der Besitzer fest - mehrere sind möglich. Die Kurve
-- (niedrig/hoch) steht bewusst NICHT hier, sie wird aus dem Ø Manawert abgelesen.
--
-- Erlaubte Werte: siehe PLAY_STYLES in src/app/deck-check.ts. Kein Check-Constraint, damit eine
-- neue Spielweise in der App nicht erst eine Migration braucht; unbekannte Werte ignoriert die App.
--
-- Keine neue RLS-Policy: Lesen folgt der Sichtbarkeit des Decks, Schreiben dem bestehenden
-- Update-Recht (wie beim Primer). Fehlt die Migration, gilt die Auswahl nur bis zum Neuladen
-- (42703/PGRST204, siehe deck-play-style.service.ts).

alter table public.decks
  add column if not exists play_styles text[];

comment on column public.decks.play_styles is
  'Spielweisen für den Deck-Check (aggro, control, combo, landfall, creatures, fastMana (früher cedh), commanderDraws, commanderRemoves, weakness). null = nicht festgelegt.';
