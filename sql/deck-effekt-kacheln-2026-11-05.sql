-- Eigene Effekt-Kacheln je Deck (Wunsch des Users, 05.11.2026).
-- Im Supabase-Dashboard unter "SQL Editor" ausführen. Idempotent.
--
-- Die Deck-Analyse zeigt standardmäßig 15 Effekt-Kacheln (Entfernung, Rampe, Kartenziehen, …).
-- Der Besitzer kann je Deck stattdessen eine eigene Auswahl aus allen Effekt-Tags festlegen
-- ("Kacheln anpassen"). Gespeichert werden nur die Schlüssel aus src/app/card-effect-filters.ts,
-- null = Standard-Kacheln. Kein Check-Constraint: ein neuer Tag in der App braucht so keine
-- Migration, unbekannte Werte ignoriert die App.
--
-- Nur Anzeige: Deck-Check und Power-Wert rechnen weiter mit den Standard-Kategorien.
--
-- Keine neue RLS-Policy: Lesen folgt der Sichtbarkeit des Decks, Schreiben dem bestehenden
-- Update-Recht (wie bei Primer und Spielweise). Fehlt die Migration, verschwindet der Knopf beim
-- ersten 42703/PGRST204 (siehe deck-effects.service.ts).

alter table public.decks
  add column if not exists effect_tiles text[];

comment on column public.decks.effect_tiles is
  'Eigene Effekt-Kacheln der Deck-Analyse (Schlüssel aus card-effect-filters.ts). null = Standard-Kacheln.';
