import { MemoryCache, normalizeCacheKey } from './cache';

export const DEFAULT_RESEARCH_CACHE_TTL_MS = 30 * 60 * 1000;

export interface ResearchResult {
  report: string;
  sources: Array<{ title?: string; url?: string; name?: string; link?: string }>;
}

export interface ResearchQueryKey {
  team1: string;
  team2: string;
  date?: string | null;
}

function normalizePart(value: string | null | undefined): string {
  return (value ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}

export function buildResearchCacheKey(query: ResearchQueryKey): string {
  return normalizeCacheKey(
    'research',
    normalizePart(query.team1),
    'vs',
    normalizePart(query.team2),
    normalizePart(query.date),
  );
}

const researchCache = new MemoryCache<ResearchResult>(DEFAULT_RESEARCH_CACHE_TTL_MS);
const inFlightResearch = new Map<string, Promise<ResearchResult>>();

export function getCachedResearch(key: string): ResearchResult | null {
  const cached = researchCache.get(key);
  if (cached) console.log(`[ResearchCache] HIT key=${key}`);
  else console.log(`[ResearchCache] MISS key=${key}`);
  return cached;
}

export async function getOrRunResearch(
  key: string,
  operation: () => Promise<ResearchResult>,
): Promise<ResearchResult> {
  const cached = researchCache.get(key);
  if (cached) {
    console.log(`[ResearchCache] HIT key=${key}`);
    return cached;
  }

  const existing = inFlightResearch.get(key);
  if (existing) {
    console.log(`[ResearchCache] IN_FLIGHT_WAIT key=${key}`);
    return existing;
  }

  console.log(`[ResearchCache] MISS key=${key}`);
  const promise = operation()
    .then((result) => {
      if (!result.report.trim()) throw new Error('Research report is empty');
      researchCache.set(key, result, DEFAULT_RESEARCH_CACHE_TTL_MS);
      console.log(`[ResearchCache] SET key=${key}`);
      return result;
    })
    .catch((error) => {
      console.error(`[ResearchCache] ERROR key=${key}`);
      throw error;
    })
    .finally(() => {
      inFlightResearch.delete(key);
    });

  inFlightResearch.set(key, promise);
  return promise;
}

export function clearResearchCacheForTests(): void {
  researchCache.clear();
  inFlightResearch.clear();
}

export function hasInFlightResearchForTests(key: string): boolean {
  return inFlightResearch.has(key);
}
