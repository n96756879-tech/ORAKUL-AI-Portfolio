// Минимальные типы Data Acquisition Layer (DAL).
// Только архитектура: никаких футбольных моделей и внешних API-зависимостей.

export type DataSourceTier = 1 | 2 | 3 | 4 | 5;

export type DataSourceReliability = 'official' | 'high' | 'medium' | 'low';

export interface DataSource {
  id: string;
  tier: DataSourceTier;
  name: string;
  reliability: DataSourceReliability;
  enabled: boolean;
}

export interface DataFetchError {
  kind: 'http' | 'timeout' | 'network' | 'invalid-url' | 'parse';
  message: string;
  status?: number;
}

export interface DataFetchResult<T> {
  data: T | null;
  source: DataSource;
  fetchedAt: string;
  expiresAt: string | null;
  confidence: number;
  error: DataFetchError | null;
}

export interface DataRequest {
  kind: string;
  url: string;
  timeoutMs?: number;
}

export interface DataFetcher<T = unknown> {
  source: DataSource;
  supports(request: DataRequest): boolean;
  fetch(request: DataRequest): Promise<DataFetchResult<T>>;
}

export interface Fixture {
  sport: string | null;
  team1: string | null;
  team2: string | null;
  date: string | null;
  competition: string | null;
  venue: string | null;
  city: string | null;
  // Провенанс: откуда и с какой уверенностью получены поля fixture.
  sourceUrl: string | null;
  sourceId: string | null;
  confidence: number | null;
}

export type DataSection = 'fixture' | 'form' | 'h2h' | 'squads' | 'injuries';

// Универсальная обёртка «данные + провенанс». Подтверждённость задается явно
// флагом confirmed: assembler проводит дальше только подтвержденные записи.
export interface ProvenancedEntry<T> {
  data: T;
  confirmed: boolean;
  confidence: number;
  sourceId: string | null;
  fetchedAt: string | null;
}

export interface TeamFormSnapshot {
  team: string;
  summary: string | null;
  // STEP 14 (аддитивно, form-extractor): подтверждённые данные последнего матча.
  // Отсутствующее в тексте поле = null; ничего не выдумываем.
  date?: string | null;
  opponent?: string | null;
  result?: 'W' | 'D' | 'L' | null;
  goalsFor?: number | null;
  goalsAgainst?: number | null;
  opponentStrength?: 'STRONG' | 'MEDIUM' | 'WEAK' | 'UNKNOWN';
  venue?: 'HOME' | 'AWAY' | 'NEUTRAL' | 'UNKNOWN';
}

export interface H2HSnapshot {
  date: string | null;
  competition: string | null;
  score: string | null;
  winner: string | null;
}

export interface SquadSnapshot {
  team: string;
  players: string[];
}

export interface InjurySnapshot {
  player: string;
  status: string | null;
  asOf: string | null;
}

export interface DataFreshness {
  updatedAt: string | null;
  expiresAt: string | null;
}

export interface DataConflict {
  section: DataSection;
  field: string | null;
  message: string;
  sourceIds: string[];
}

export type DataPackStatus = 'empty' | 'partial' | 'complete';

// Минимальный расширяемый контейнер нормализованных данных.
// Секции — массивы ProvenancedEntry: пустой массив = данных нет (не выдумываем).
export interface DataPack {
  fixture: Fixture | null;
  form: ProvenancedEntry<TeamFormSnapshot>[];
  h2h: ProvenancedEntry<H2HSnapshot>[];
  squads: ProvenancedEntry<SquadSnapshot>[];
  injuries: ProvenancedEntry<InjurySnapshot>[];
  sources: DataSource[];
  freshness: Partial<Record<DataSection, DataFreshness>>;
  conflicts: DataConflict[];
  status: DataPackStatus;
}

export interface MatchQuery {
  team1: string;
  team2: string;
  sport?: string | null;
  date?: string | null;
  competition?: string | null;
}

// Явная конфигурация источника URL для конкретного матча (STEP 10).
// URL НЕ угадывается из названия матча — подаётся только извне.
export interface SourceUrlConfig {
  matchKey: string;
  url: string;
}

// Конфигурация resolver-а: URL-источники + включённые fetcher-ы.
export interface ResolverUrlConfig {
  sourceUrls?: SourceUrlConfig[];
  keyDealerWebFetcher?: DataFetcher<string>;
  keyDealerFetchTtlMs?: number;
}

// Минимальный срез health snapshot KeyDealer Search (структурно совместим
// с model_health из /v1/models). Чистые данные, без HTTP.
export interface SearchHealthSnapshot {
  availability: string;
  status: string;
}
