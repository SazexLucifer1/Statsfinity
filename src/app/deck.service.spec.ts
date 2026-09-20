import { TestBed } from '@angular/core/testing';
import { DeckService } from './deck.service';

/** Gekürzter, aber formattreuer Ausschnitt eines deckstats.net-Exports (Kategorie-Kommentare, Set-Kürzel, Maybeboard am Ende). */
const DECKSTATS_EXPORT = `//Commander
1 Kwain, Itinerant Meddler (BLC) 254

//Main

//Ramp
1 Arcane Signet (SOC) 127
1 Heliod, the Radiant Dawn // Heliod, the Warped Eclipse (MOM) 17

//Landbase
6 Island (SOS) 274
1 Command Tower (SOC) 129

//Maybeboard
1 Brainstone (DSC) 242
1 Mana Drain (2X2) 57
`;

describe('DeckService.parseDecklistText', () => {
  let service: DeckService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(DeckService);
  });

  it('erkennt Commander, Maybeboard und Druckvariante im deckstats.net-Format', () => {
    const parsed = service.parseDecklistText(DECKSTATS_EXPORT);
    const byName = new Map(parsed.map((p) => [p.name, p]));

    expect(byName.get('Kwain, Itinerant Meddler')?.isCommander).toBe(true);
    expect(byName.get('Kwain, Itinerant Meddler')?.isMaybeboard).toBe(false);

    // Die Kategorie-Kommentare (//Ramp, //Landbase) sind KEINE Abschnitts-Überschriften und
    // dürfen weder Commander- noch Maybeboard-Markierung verändern.
    expect(byName.get('Arcane Signet')?.isCommander).toBe(false);
    expect(byName.get('Arcane Signet')?.isMaybeboard).toBe(false);
    expect(byName.get('Island')?.quantity).toBe(6);

    // Genau darum geht es: die engere Auswahl gehört nicht ins Deck.
    expect(byName.get('Brainstone')?.isMaybeboard).toBe(true);
    expect(byName.get('Mana Drain')?.isMaybeboard).toBe(true);

    expect(byName.get('Arcane Signet')?.setCode).toBe('SOC');
    expect(byName.get('Arcane Signet')?.collectorNumber).toBe('127');
    // Doppelseitige Karte: der volle "A // B"-Name bleibt erhalten, nur der Druck wird abgetrennt.
    expect(
      byName.get('Heliod, the Radiant Dawn // Heliod, the Warped Eclipse')?.collectorNumber,
    ).toBe('17');
  });

  it('lässt eine Karte, die im Deck UND im Maybeboard steht, im Deck (ohne die Anzahl zu erhöhen)', () => {
    const parsed = service.parseDecklistText('Deck:\n1 Sol Ring\n\nMaybeboard:\n1 Sol Ring');

    expect(parsed).toHaveLength(1);
    expect(parsed[0].quantity).toBe(1);
    expect(parsed[0].isMaybeboard).toBe(false);
  });

  it('markiert ohne Maybeboard-Überschrift weiterhin nichts als engere Auswahl', () => {
    const parsed = service.parseDecklistText(
      'Commander:\n1 Kwain, Itinerant Meddler\n\n1 Sol Ring\n1 Arcane Signet',
    );

    expect(parsed.filter((p) => p.isMaybeboard)).toHaveLength(0);
    expect(parsed.filter((p) => p.isCommander).map((p) => p.name)).toEqual([
      'Kwain, Itinerant Meddler',
    ]);
  });
});
