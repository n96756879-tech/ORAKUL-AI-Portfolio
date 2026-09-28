// In-memory generic cache на Map. Без зависимостей, без привязки к конкретному API.
// Ключи нормализуются: регистр/пробелы/разделители «vs/—/–» не влияют на попадание.

const KEY_SEPARATOR = '|';

export function normalizeCacheKey(...parts: Array<string | null | undefined>): string {
  return parts
    .map((part) => {
      const s = (part ?? '').toLowerCase().trim();
      // «Belgium vs France» и «belgium VS france» и «Belgium — France» дают один ключ.
      return s.replace(/\s+(?:vs\.?|—|–|-)\s+/g, ' vs ');
    })
    .filter((s) => s.length > 0)
    .join(KEY_SEPARATOR);
}

export interface CacheEntry<T> {
  key: string;
  value: T;
  createdAt: number;
  expiresAt: number;
  ttlMs: number;
}

export class MemoryCache<T> {
  private store = new Map<string, CacheEntry<T>>();

  constructor(private defaultTtlMs = 60_000) {}

  set(key: string, value: T, ttlMs?: number): CacheEntry<T> {
    const normalized = normalizeCacheKey(key);
    const now = Date.now();
    const ttl = typeof ttlMs === 'number' && ttlMs >= 0 ? ttlMs : this.defaultTtlMs;
    const entry: CacheEntry<T> = {
      key: normalized,
      value,
      createdAt: now,
      expiresAt: now + ttl,
      ttlMs: ttl,
    };
    this.store.set(normalized, entry);
    return entry;
  }

  get(key: string): T | null {
    const normalized = normalizeCacheKey(key);
    const entry = this.store.get(normalized);
    if (!entry) return null;
    if (Date.now() >= entry.expiresAt) {
      this.store.delete(normalized);
      return null;
    }
    return entry.value;
  }

  delete(key: string): boolean {
    return this.store.delete(normalizeCacheKey(key));
  }

  clear(): void {
    this.store.clear();
  }

  has(key: string): boolean {
    return this.get(key) !== null;
  }
}
