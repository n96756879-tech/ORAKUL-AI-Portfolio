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

async function testSingleMatch() {
  const apiKey = process.env.KEYDEALER_API_KEY;
  console.log('KEYDEALER_API_KEY configured:', !!apiKey);

  if (!apiKey) {
    console.error('API key not found');
    return;
  }

  const endpoint = 'https://api.keydealer.ru/v1/responses';
  const model = 'grok-4-20-multi-agent';
  const match = 'Россия — Португалия';

  console.log(`\n========================================`);
  console.log(`ТЕСТ МАТЧА: ${match}`);
  console.log(`Endpoint: ${endpoint}`);
  console.log(`Model: ${model}`);
  console.log(`========================================\n`);

  const promptText = `Ты — спортивный аналитик ORAKUL AI. Проанализируй матч "${match}" с поиском в интернете. Верни JSON.`;

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + apiKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model,
        input: promptText
      })
    });

    console.log(`HTTP Status: ${res.status}`);
    const text = await res.text();
    console.log(`Response Payload:\n${text.slice(0, 1000)}\n`);
  } catch (err: any) {
    console.error('Fetch error:', err.message);
  }
}

testSingleMatch();
