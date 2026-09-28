// Generic HTTP fetcher для публичных URL на встроенном fetch.
// Без API-ключей, без cookies, без учета (credentials), с таймаутом и статус-проверкой.
// STEP 8: никаких внешних вызовов из тестов и из DAL по умолчанию.

import type { DataFetchError, DataFetchResult, DataFetcher, DataRequest, DataSource } from './types';

export const PUBLIC_HTTP_SOURCE: DataSource = {
  id: 'public-http',
  tier: 3,
  name: 'Public HTTP fetcher',
  reliability: 'medium',
  enabled: true,
};

const DEFAULT_TIMEOUT_MS = 15_000;

function classifyError(err: unknown, status?: number): DataFetchError {
  if (status !== undefined) {
    return { kind: 'http', message: `HTTP ${status}`, status };
  }
  const name = err instanceof Error ? err.name : '';
  if (name === 'AbortError') {
    return { kind: 'timeout', message: 'Request timed out' };
  }
  if (err instanceof TypeError) {
    return { kind: 'invalid-url', message: err.message };
  }
  return { kind: 'network', message: err instanceof Error ? err.message : String(err) };
}

export function createHttpFetcher(
  source: DataSource = PUBLIC_HTTP_SOURCE,
  options: { timeoutMs?: number; fetchImpl?: typeof fetch } = {}
): DataFetcher<string> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? fetch;

  return {
    source,
    supports(request: DataRequest): boolean {
      return typeof request.url === 'string' && /^https?:\/\//i.test(request.url);
    },

    async fetch(request: DataRequest): Promise<DataFetchResult<string>> {
      const fetchedAt = new Date().toISOString();
      const fail = (error: DataFetchError): DataFetchResult<string> => ({
        data: null,
        source,
        fetchedAt,
        expiresAt: null,
        confidence: 0,
        error,
      });

      if (!this.supports(request)) {
        return fail({ kind: 'invalid-url', message: 'Only http(s) URLs are supported' });
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), request.timeoutMs ?? timeoutMs);

      try {
        const response = await fetchImpl(request.url, {
          method: 'GET',
          redirect: 'follow',
          credentials: 'omit',
          signal: controller.signal,
          // Никаких заголовков авторизации, cookies и API-ключей.
          headers: { Accept: 'text/html,text/plain;q=0.9,*/*;q=0.8' },
        });
        if (!response.ok) {
          clearTimeout(timer);
          return fail(classifyError(null, response.status));
        }
        const text = await response.text();
        return {
          data: text,
          source,
          fetchedAt,
          expiresAt: new Date(Date.now() + timeoutMs).toISOString(),
          confidence: source.reliability === 'official' ? 0.9 : 0.6,
          error: null,
        };
      } catch (err: unknown) {
        return fail(classifyError(err));
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

// ─────────────────── KeyDealer /v1/web/fetch (STEP 10) ───────────────────

export const KEYDEALER_WEB_FETCH_ENDPOINT = 'https://api.keydealer.ru/v1/web/fetch';

export const KEYDEALER_WEB_FETCH_SOURCE: DataSource = {
  id: 'keydealer-web-fetch',
  tier: 1,
  name: 'KeyDealer Web Fetch',
  reliability: 'official',
  enabled: true,
};

export interface KeyDealerWebResponse {
  url?: unknown;
  status?: unknown;
  content_type?: unknown;
  title?: unknown;
  content?: unknown;
  truncated?: unknown;
  keydealer_billing?: unknown;
}

const KD_AUTH_HEADER = 'Authorization';

// Извлечь cleaned text из ответа KeyDealer; без throw при неожиданной форме.
function extractKdContent(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const content = (payload as KeyDealerWebResponse).content;
  return typeof content === 'string' && content.trim().length > 0 ? content : null;
}

export function createKeyDealerWebFetcher(
  options: { apiKey?: string; timeoutMs?: number; fetchImpl?: typeof fetch } = {}
): DataFetcher<string> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? fetch;

  const getApiKey = (): string =>
    options.apiKey ?? process.env.KEYDEALER_API_KEY ?? '';

  return {
    source: KEYDEALER_WEB_FETCH_SOURCE,
    supports(request: DataRequest): boolean {
      return typeof request.url === 'string' && /^https?:\/\//i.test(request.url);
    },

    async fetch(request: DataRequest): Promise<DataFetchResult<string>> {
      const fetchedAt = new Date().toISOString();
      const fail = (error: DataFetchError): DataFetchResult<string> => ({
        data: null,
        source: KEYDEALER_WEB_FETCH_SOURCE,
        fetchedAt,
        expiresAt: fetchedAt,
        confidence: 0,
        error,
      });

      if (!getApiKey()) {
        return fail({ kind: 'network', message: 'KEYDEALER_API_KEY is not configured' });
      }

      if (!this.supports(request)) {
        return fail({ kind: 'invalid-url', message: 'Only http(s) URLs are supported' });
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), request.timeoutMs ?? timeoutMs);

      try {
        // Authorization header собирается локально и НИКОГДА не логируется.
        const headers: Record<string, string> = {
          [KD_AUTH_HEADER]: `Bearer ${getApiKey()}`,
          'Content-Type': 'application/json',
        };
        const response = await fetchImpl(KEYDEALER_WEB_FETCH_ENDPOINT, {
          method: 'POST',
          credentials: 'omit',
          signal: controller.signal,
          headers,
          body: JSON.stringify({ url: request.url }),
        });
        if (!response.ok) {
          clearTimeout(timer);
          return fail(classifyError(null, response.status));
        }
        // Malformed JSON → контролируемая ошибка kind='parse', без crash.
        let payload: unknown;
        try {
          payload = await response.json();
        } catch {
          return fail({ kind: 'parse', message: 'KeyDealer response is not valid JSON' });
        }
        const content = extractKdContent(payload);
        if (content === null) {
          return fail({ kind: 'parse', message: 'KeyDealer response has no content field' });
        }
        return {
          data: content,
          source: KEYDEALER_WEB_FETCH_SOURCE,
          fetchedAt,
          expiresAt: new Date(Date.now() + timeoutMs).toISOString(),
          confidence: 0.95,
          error: null,
        };
      } catch (err: unknown) {
        return fail(classifyError(err));
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
