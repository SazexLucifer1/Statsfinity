/**
 * Gespeicherte Druck-Angaben der Sammlung (Preis, Seltenheit, Setname, Legalitäten) auf dem Gerät,
 * in IndexedDB statt localStorage: Bei ein paar tausend Drucken mit Legalitäten wären das mehrere
 * MB, localStorage hat meist nur 5 MB für die ganze App (Wunsch des Users, 15.11.2026: beim Öffnen
 * der Sammlung dauerte es zu lange, bis die Preise standen). Ein einziger Datensatz mit allen
 * Drucken und dem Zeitpunkt des letzten vollständigen Ladens. Jeder Fehler (privates Fenster,
 * gesperrter Speicher) heißt nur: nichts gespeichert, dann wird wie früher geladen.
 */
const DB = 'statsfinity';
const STORE = 'print-info';
const KEY = 'collection';

export interface StoredPrintInfo<T> {
  savedAt: number;
  entries: [string, T][];
}

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export async function readStoredPrintInfo<T>(): Promise<StoredPrintInfo<T> | null> {
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(KEY);
      req.onsuccess = () => resolve((req.result as StoredPrintInfo<T>) ?? null);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export async function writeStoredPrintInfo<T>(value: StoredPrintInfo<T>): Promise<void> {
  const db = await openDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(value, KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
}
