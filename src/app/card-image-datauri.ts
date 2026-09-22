/**
 * Lädt ein Kartenbild und liefert es als data:-URL zurück.
 *
 * Nötig überall dort, wo ein Bild nicht nur angezeigt, sondern weiterverarbeitet wird - PDF-Export
 * (deck-pdf.service.ts) und Steckbrief-Bild (steckbrief-canvas.ts). Ein data:-URL gilt für
 * <canvas> immer als same-origin; das Canvas bleibt dadurch "sauber" und lässt sich mit
 * toDataURL()/toBlob() auslesen. Ein direkt per <img src="https://…"> geladenes Fremdbild würde
 * das Canvas vergiften und jeden Export mit einem SecurityError beenden.
 *
 * Die Fallunterscheidung ist der eigentliche Inhalt dieser Datei und steht deshalb genau einmal:
 * Der Proxy lässt aus Sicherheitsgründen nur cards.scryfall.io durch (siehe
 * functions/api/proxy-image.ts) - eigene, selbst hochgeladene Artworks liegen in einem
 * Supabase-Bucket und müssen DIREKT geladen werden, sonst kommt vom Proxy ein 403 und das Bild
 * fehlt einfach, ohne dass irgendwo ein Fehler auftaucht.
 *
 * null = Bild nicht ladbar. Jeder Aufrufer muss ohne Bild weiterkommen.
 */
export async function kartenBildAlsDataUrl(url: string): Promise<string | null> {
  try {
    const isScryfallImage = new URL(url, window.location.href).hostname === 'cards.scryfall.io';
    const fetchUrl = isScryfallImage ? `/api/proxy-image?url=${encodeURIComponent(url)}` : url;
    const res = await fetch(fetchUrl);
    if (!res.ok) return null;
    const blob = await res.blob();
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

/** Lädt ein Bild aus einer data:-URL in ein HTMLImageElement. null = nicht dekodierbar. */
export async function bildAusDataUrl(dataUrl: string): Promise<HTMLImageElement | null> {
  try {
    return await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('image load failed'));
      el.src = dataUrl;
    });
  } catch {
    return null;
  }
}
