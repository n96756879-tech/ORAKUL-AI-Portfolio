import fs from 'fs';
import path from 'path';

function loadEnv() {
  const envPath = path.resolve(process.cwd(), '.env');
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf8');
    for (const line of envContent.split('\n')) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
        const [key, ...valParts] = trimmed.split('=');
        process.env[key.trim()] = valParts.join('=').trim();
      }
    }
  }
}

loadEnv();

async function testMatch(matchName: string) {
  console.log(`\n========================================`);
  console.log(`ТЕСТИРОВАНИЕ МАТЧА: ${matchName}`);
  console.log(`========================================`);

  const apiKey = process.env.KEYDEALER_API_KEY;
  if (!apiKey) {
    console.error('KEYDEALER_API_KEY не установлен!');
    return;
  }

  // 1. Динамический поисковый запрос (Web Search)
  const cleanedMatchWords = matchName
    .replace(/[—–\-vs\.]/gi, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .join(' ');
  const currentYear = new Date().getFullYear();
  const searchQuery = `${cleanedMatchWords} матч последние результаты форма очные встречи состав травмы статистика ${currentYear}`;

  console.log(`[Web Search Endpoint]: POST https://api.keydealer.ru/v1/search`);
  console.log(`[Query]: "${searchQuery}"`);

  let searchItems: any[] = [];
  try {
    const searchRes = await fetch('https://api.keydealer.ru/v1/search', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query: searchQuery,
        max_results: 8,
      }),
    });

    const searchData: any = await searchRes.json();
    console.log(`[Search HTTP Status]: ${searchRes.status}`);

    if (searchRes.ok) {
      const rawItems = searchData.results || searchData.items || searchData.data || (Array.isArray(searchData) ? searchData : []);
      searchItems = rawItems.map((item: any) => ({
        title: item.title || item.name || 'Спортивный источник',
        url: item.url || item.link || '',
        snippet: item.snippet || item.content || item.description || '',
      }));
      console.log(`[Search Results Count]: ${searchItems.length}`);
    } else {
      console.warn(`[Search Response]:`, JSON.stringify(searchData));
    }
  } catch (e: any) {
    console.error(`[Search Error]:`, e.message);
  }

  const searchContext = searchItems.length > 0
    ? searchItems.map((it, idx) => `[Источник ${idx + 1}]: ${it.title}\nURL: ${it.url}\nИнформация: ${it.snippet}\n`).join('\n---\n')
    : 'Результаты веб-поиска: Внешний веб-поиск временно не вернул данных из-за ограничения провайдера.';

  // 2. Gemini 3 Flash LLM Request
  console.log(`\n[LLM Endpoint]: POST https://api.keydealer.ru/v1/chat/completions`);
  console.log(`[Model]: gemini-3-flash`);

  const systemPrompt = `Ты — BetLens AI, объективный аналитик спортивных матчей.
Твоя задача — на основе актуальных данных, найденных в переданных веб-источниках, провести объективный статистический анализ указанного матча.

Используй только информацию, присутствующую в предоставленных источниках и контексте. Не выдумывай статистику!
Если актуальные данные не найдены или противоречат друг другу — прямо укажи это.
Сумма вероятностей взаимоисключающих исходов ОБЯЗАНА быть логичной и равняться 100%.
Никогда не используй букмекерские коэффициенты и не предлагай делать ставки.

Формат ответа JSON:
{
  "status": "success",
  "match": { "title": "${matchName}", "meta": "Вид спорта / Турнир" },
  "probabilities": {
    "outcomes": [{ "label": "Победа 1", "value": "XX%" }, { "label": "Ничья", "value": "XX%" }, { "label": "Победа 2", "value": "XX%" }],
    "totals": [{ "label": "ТБ 2.5", "value": "XX%" }, { "label": "ТМ 2.5", "value": "XX%" }],
    "btts": [{ "label": "Да", "value": "XX%" }, { "label": "Нет", "value": "XX%" }]
  },
  "explanation": {
    "overview": "Краткое человеческое объяснение прогноза",
    "factors": "Разбор формы, составов, травм и H2H"
  },
  "usedSources": [{ "title": "...", "url": "..." }]
}`;

  const userPrompt = `Матч: "${matchName}"\n\nДанные поиска:\n${searchContext}`;

  try {
    const chatRes = await fetch('https://api.keydealer.ru/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gemini-3-flash',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.2,
      }),
    });

    const chatData: any = await chatRes.json();
    console.log(`[LLM HTTP Status]: ${chatRes.status}`);
    const content = chatData.choices?.[0]?.message?.content || '';
    console.log(`[Gemini 3 Flash Output Preview]:\n${content.slice(0, 500)}...\n`);
  } catch (e: any) {
    console.error(`[LLM Error]:`, e.message);
  }
}

async function run() {
  await testMatch('Россия — Португалия');
  await testMatch('СКА — ЦСКА');
  await testMatch('Новак Джокович — Карлос Алькарас');
}

run();
