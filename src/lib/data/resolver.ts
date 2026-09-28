// Source Router / Resolver: выбор источников с учётом tier/enabled/cache → DataPack.
// STEP 10: async; KeyDealer /v1/web/fetch используется ТОЛЬКО при явном URL из конфигурации.
// Нет URL → нет вызовов (ни fetch, ни search), честный partial/empty DataPack.

import { MemoryCache, normalizeCacheKey } from './cache';
import { extractFixtureFromText } from './fixture-extractor';
import { extractTeamFormFromText } from './form-extractor';
import { extractH2HFromText } from './h2h-extractor';
import { extractHistoricalContextFromText } from './historical-context-extractor';
import type {
  DataFetcher,
  DataPack,
  MatchQuery,
  ResolverUrlConfig,
  SearchHealthSnapshot,
  SourceUrlConfig,
} from './types';

const FIXTURE_TTL_MS = 24 * 60 * 60_000; // 24 часа

// Чистый health gate для будущего KeyDealer Search. Без HTTP: снапшот подаётся аргументом.
// Search разрешён только при availability === 'available' И status === 'operational'.
export function isSearchOperational(snapshot: SearchHealthSnapshot | null | undefined): boolean {
  if (!snapshot) return false;
  return snapshot.availability === 'available' && snapshot.status === 'operational';
}

export interface ResolverOptions extends ResolverUrlConfig {
  cache?: MemoryCache<DataPack>;
  fetchers?: DataFetcher<unknown>[];
  now?: () => number;
}

export interface ResolveOutcome {
  dataPack: DataPack;
  cacheHit: boolean;
  attemptedSourceIds: string[];
}

export function buildMatchCacheKey(query: MatchQuery): string {
  return normalizeCacheKey(query.sport ?? '', query.team1, 'vs', query.team2, query.date ?? '');
}

// Разбор свободной строки матча («Belgium vs France») в MatchQuery.
// Без разделителя «vs/—/–/-» team2 остаётся пустой строкой (нерезолвленный соперник).
export function matchQueryFromFreeForm(match: string): MatchQuery {
  const cleaned = match.trim().replace(/\s+/g, ' ');
  const split = cleaned.match(/^(.{1,80}?)\s+(?:vs\.?|—|–|-)\s+(.{1,80})$/i);
  if (split) {
    return { team1: split[1].trim(), team2: split[2].trim(), sport: 'football' };
  }
  return { team1: cleaned, team2: '', sport: 'football' };
}

// Единый in-memory кэш DataPack (STEP 9/10). TTL по умолчанию 5 минут;
// fixture-данные из KeyDealer Fetch кэшируются с явным TTL 24ч.
const sharedDataPackCache = new MemoryCache<DataPack>(5 * 60_000);

export function getSharedDataPackCache(): MemoryCache<DataPack> {
  return sharedDataPackCache;
}

export function buildEmptyDataPack(): DataPack {
  return {
    fixture: null,
    form: [],
    h2h: [],
    squads: [],
    injuries: [],
    sources: [],
    freshness: {},
    conflicts: [],
    status: 'empty',
  };
}

// URL-конфиг матч→URL: точное совпадение нормализованного ключа матча.
function findConfiguredUrl(query: MatchQuery, sourceUrls: SourceUrlConfig[]): string | null {
  const matchKey = buildMatchCacheKey(query);
  for (const cfg of sourceUrls) {
    if (normalizeCacheKey(cfg.matchKey) === matchKey) {
      return cfg.url;
    }
  }
  return null;
}

export async function resolveDataPack(
  query: MatchQuery,
  options: ResolverOptions = {}
): Promise<ResolveOutcome> {
  const cache = options.cache ?? new MemoryCache<DataPack>();
  const fetchers = options.fetchers ?? [];
  const attemptedSourceIds: string[] = [];

  const cacheKey = buildMatchCacheKey(query);

  const cached = cache.get(cacheKey);
  if (cached) {
    return { dataPack: cached, cacheHit: true, attemptedSourceIds: [] };
  }

  const activeFetchers = fetchers
    .filter((f) => f.source.enabled)
    .sort((a, b) => a.source.tier - b.source.tier);
  for (const fetcher of activeFetchers) {
    attemptedSourceIds.push(fetcher.source.id);
  }

  const dataPack = buildEmptyDataPack();

  // STEP 10: fixture из KeyDealer /v1/web/fetch — только при явном URL из конфигурации.
  const kdFetcher = options.keyDealerWebFetcher;
  if (kdFetcher && kdFetcher.source.enabled) {
    const url = findConfiguredUrl(query, options.sourceUrls ?? []);
    if (url) {
      attemptedSourceIds.push(kdFetcher.source.id);
      const result = await kdFetcher.fetch({ kind: 'fixture', url });
      dataPack.sources.push(result.source);
      if (!result.error && result.data) {
        // STEP 15: тот же cleaned text → form entries (ProvenancedEntry).
        // Только подтверждённые данные; пустой результат → DataPack.form остаётся [].
        const requestedTeam = query.team1;
         const formSnapshots = extractHistoricalContextFromText(result.data, requestedTeam);
        if (formSnapshots.length > 0) {
          dataPack.form = formSnapshots.map((snapshot) => ({
            data: snapshot,
            confirmed: true,
            confidence: result.confidence,
            sourceId: result.source.id,
            fetchedAt: result.fetchedAt,
          }));
          if (dataPack.freshness.form === undefined) {
            dataPack.freshness.form = {
              updatedAt: result.fetchedAt,
              expiresAt: new Date(
                Date.now() + (options.keyDealerFetchTtlMs ?? FIXTURE_TTL_MS)
              ).toISOString(),
            };
          }
        }
        const h2hSnapshots = extractH2HFromText(result.data, query.team1, query.team2);
        if (h2hSnapshots.length > 0) {
          dataPack.h2h = h2hSnapshots.map((snapshot) => ({
            data: snapshot,
            confirmed: true,
            confidence: result.confidence,
            sourceId: result.source.id,
            fetchedAt: result.fetchedAt,
          }));
          dataPack.freshness.h2h = {
            updatedAt: result.fetchedAt,
            expiresAt: new Date(
              Date.now() + (options.keyDealerFetchTtlMs ?? FIXTURE_TTL_MS)
            ).toISOString(),
          };
          dataPack.status = 'partial';
        }
        const fixture = extractFixtureFromText(result.data, {
          team1: query.team1,
          team2: query.team2,
          sourceUrl: url,
        });
        const confirmedFields = [
          fixture.team1,
          fixture.team2,
          fixture.competition,
          fixture.venue,
          fixture.city,
          fixture.date,
        ].filter((v) => v !== null).length;
        if (confirmedFields > 0) {
          fixture.confidence = result.confidence;
          dataPack.fixture = fixture;
          dataPack.freshness.fixture = {
            updatedAt: result.fetchedAt,
            expiresAt: new Date(
              Date.now() + (options.keyDealerFetchTtlMs ?? FIXTURE_TTL_MS)
            ).toISOString(),
          };
          dataPack.status = 'partial';
        }
        // STEP 15: Form без fixture не ломает существующую семантику статуса:
        // только подтверждённые form-записи при отсутствии fixture → 'partial'.
        if (dataPack.status === 'empty' && dataPack.form.length > 0) {
          dataPack.status = 'partial';
        }
      }
    }
  }

  cache.set(cacheKey, dataPack);
  return { dataPack, cacheHit: false, attemptedSourceIds };
}
