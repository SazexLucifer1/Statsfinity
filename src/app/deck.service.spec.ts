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

/**
 * Moxfield: kein einziger Abschnitts-Header. Der Commander steht als eigener Block ganz vorn, die
 * Karten aus "The List" tragen eine Sammelnummer mit Bindestrich ("(PLST) ORI-221"), und geteilte
 * Karten kommen mit einfachem statt doppeltem Schrägstrich.
 */
const MOXFIELD_EXPORT = `1 Bilbo, Birthday Celebrant (LTC) 48

1 Aetherflux Reservoir (KLD) 192
1 Alhammarret's Archive (PLST) ORI-221
1 Serra Ascendant (PLST) M11-28
1 Revival / Revenge (RNA) 228
1 Archdruid's Charm (PMKM) 151p
5 Forest (J25) 95
`;

/** Archidekt: hinter jeder Zeile die Kategorie und - wenn die Karte in der Sammlung liegt - deren Markierung. */
const ARCHIDEKT_EXPORT = `1x Abrade (soc) 234 [Removal] ^Have,#37d67a^
1x Electro, Assaulting Battery (spm) 76 [Commander{top}]
1x Invoke Calamity (neo) 147 [Maybeboard{noDeck}{noPrice},Recursion]
1x Fire Servant (plst) PD2-15 [Burn]
1x Blazing Firesinger // Seething Song (sos) 109 [Creature]
34x Mountain (lci) 290 [Land]
`;

/** MTGGoldfish: nackte Namen, das Sideboard nur durch eine Leerzeile abgetrennt. */
const MTGGOLDFISH_EXPORT = `2 Bitter Triumph
4 Dream Beavers
4 Enduring Curiosity
4 Floodpits Drowner
4 Gloomlake Verge
3 Hidden Lair
5 Island
4 Kaito, Bane of Nightmares
3 Requiting Hex
2 Restless Reef
2 Shoot the Sheriff
2 Soulstone Sanctuary
4 Spyglass Siren
4 Swamp
2 Tishana's Tidebinder
1 Wan Shi Tong, Librarian
4 Watery Grave
2 We Say Thee Nay!
4 Anoint with Affliction

1 Annul
2 Day of Black Sun
3 Duress
2 Flashfreeze
1 Requiting Hex
3 Strategic Betrayal
1 Wan Shi Tong, Librarian
2 Disdainful Stroke
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

  it('liest einen Moxfield-Export: Sammelnummer mit Bindestrich, geteilte Karte, Commander vorn', () => {
    const parsed = service.parseDecklistText(MOXFIELD_EXPORT);
    const byName = new Map(parsed.map((p) => [p.name, p]));

    // Genau das ging vorher verloren: der komplette Zusatz blieb im Kartennamen stehen.
    expect(byName.get("Alhammarret's Archive")?.setCode).toBe('PLST');
    expect(byName.get("Alhammarret's Archive")?.collectorNumber).toBe('ORI-221');
    expect(byName.get('Serra Ascendant')?.collectorNumber).toBe('M11-28');
    // Sammelnummern ohne Bindestrich dürfen dabei nicht kaputtgehen.
    expect(byName.get("Archdruid's Charm")?.collectorNumber).toBe('151p');
    expect(byName.get('Aetherflux Reservoir')?.setCode).toBe('KLD');
    expect(byName.get('Forest')?.quantity).toBe(5);

    // Scryfall kennt geteilte Karten nur mit doppeltem Schrägstrich.
    expect(byName.has('Revival // Revenge')).toBe(true);

    // Moxfield beschriftet nichts - der vorangestellte Block bleibt deshalb eine Vermutung,
    // bestätigt wird sie erst in saveDeck() anhand der Kartendaten.
    expect(byName.get('Bilbo, Birthday Celebrant')?.isCommanderCandidate).toBe(true);
    expect(byName.get('Bilbo, Birthday Celebrant')?.isCommander).toBe(false);
    expect(parsed.filter((p) => p.isCommanderCandidate)).toHaveLength(1);
    expect(parsed.filter((p) => p.isMaybeboard)).toHaveLength(0);
  });

  it('liest einen Archidekt-Export samt Kategorien, Sammlungs-Markierung und Commander', () => {
    const parsed = service.parseDecklistText(ARCHIDEKT_EXPORT);
    const byName = new Map(parsed.map((p) => [p.name, p]));

    // Ohne das Abtrennen der Kategorie hieß die Karte "Abrade (soc) 234 [Removal] ^Have,#37d67a^".
    expect(byName.get('Abrade')?.setCode).toBe('soc');
    expect(byName.get('Abrade')?.collectorNumber).toBe('234');
    expect(byName.get('Fire Servant')?.collectorNumber).toBe('PD2-15');
    expect(byName.get('Mountain')?.quantity).toBe(34);
    expect(byName.has('Blazing Firesinger // Seething Song')).toBe(true);

    // Archidekt benennt den Commander ausdrücklich - hier wird nicht geraten.
    expect(byName.get('Electro, Assaulting Battery')?.isCommander).toBe(true);
    expect(byName.get('Invoke Calamity')?.isMaybeboard).toBe(true);
    expect(byName.get('Abrade')?.isMaybeboard).toBe(false);
  });

  it('legt das unbeschriftete MTGGoldfish-Sideboard in die engere Auswahl statt ins Deck', () => {
    const parsed = service.parseDecklistText(MTGGOLDFISH_EXPORT);
    const byName = new Map(parsed.map((p) => [p.name, p]));

    expect(byName.get('Annul')?.isMaybeboard).toBe(true);
    expect(byName.get('Duress')?.quantity).toBe(3);
    expect(byName.get('Bitter Triumph')?.isMaybeboard).toBe(false);

    // Steht eine Karte in beidem, gilt die Anzahl aus dem Deck - das Sideboard zählt nicht dazu.
    expect(byName.get('Requiting Hex')?.quantity).toBe(3);
    expect(byName.get('Requiting Hex')?.isMaybeboard).toBe(false);
    expect(byName.get('Wan Shi Tong, Librarian')?.quantity).toBe(1);

    // Der vordere Block ist ein ganzes Deck, kein Commander.
    expect(parsed.filter((p) => p.isCommanderCandidate)).toHaveLength(0);
  });

  it('nimmt Sideboard und Companion als engere Auswahl, nicht als Deckkarten', () => {
    const parsed = service.parseDecklistText(
      'Deck:\n1 Sol Ring\n\nSideboard:\n2 Duress\n\nCompanion:\n1 Lurrus of the Dream-Den',
    );
    const byName = new Map(parsed.map((p) => [p.name, p]));

    expect(byName.get('Sol Ring')?.isMaybeboard).toBe(false);
    expect(byName.get('Duress')?.isMaybeboard).toBe(true);
    expect(byName.get('Lurrus of the Dream-Den')?.isMaybeboard).toBe(true);
  });

  it('versteht die TappedOut-Markierung *CMDR* und die SB:-Zeilen von Cockatrice', () => {
    const parsed = service.parseDecklistText(
      "1x Atraxa, Praetors' Voice (CMR) 3 *CMDR*\n1x Sol Ring (C21) 263 *F*\nSB: 2 Duress",
    );
    const byName = new Map(parsed.map((p) => [p.name, p]));

    expect(byName.get("Atraxa, Praetors' Voice")?.isCommander).toBe(true);
    expect(byName.get('Sol Ring')?.collectorNumber).toBe('263');
    expect(byName.get('Duress')?.isMaybeboard).toBe(true);
  });
});
