// STEP 14: offline-тесты TeamFormSnapshot extractor (form-extractor.ts).
// Полностью offline: никаких HTTP/API, только строки → TeamFormSnapshot.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { extractTeamFormFromText } from '../src/lib/data/form-extractor';

describe('STEP 14 T1: полная история (Формат A/C)', () => {
  test('3 матча, W/D/W, счёт и соперники корректны', () => {
    const form = extractTeamFormFromText(
      'England 2-1 Germany\nSpain 1-1 England\nEngland 3-0 Italy',
      'England'
    );
    assert.equal(form.length, 3);
    assert.deepEqual(form.map((e) => e.result), ['W', 'D', 'W']);
    assert.deepEqual(form.map((e) => e.goalsFor), [2, 1, 3]);
    assert.deepEqual(form.map((e) => e.goalsAgainst), [1, 1, 0]);
    assert.deepEqual(form.map((e) => e.opponent), ['Germany', 'Spain', 'Italy']);
    assert.equal(form[0].team, 'England');
  });
});

describe('STEP 14 T2: home/away (Формат C)', () => {
  test('W/D/L относительно requestedTeam', () => {
    const form = extractTeamFormFromText(
      'Germany 0-2 England\nEngland 1-1 Spain\nItaly 3-0 England',
      'England'
    );
    assert.equal(form.length, 3);
    assert.deepEqual(form.map((e) => e.result), ['W', 'D', 'L']);
    assert.deepEqual(form.map((e) => e.goalsFor), [2, 1, 0]);
    assert.deepEqual(form.map((e) => e.goalsAgainst), [0, 1, 3]);
  });
});

describe('STEP 14 T3: компактная форма (Формат B)', () => {
  test('Form: W W D L W → последовательность без выдуманных полей', () => {
    const form = extractTeamFormFromText('Form: W W D L W', 'England');
    assert.equal(form.length, 1);
    assert.equal(form[0].team, 'England');
    assert.equal(form[0].summary, 'W W D L W');
    assert.equal(form[0].date, null);
    assert.equal(form[0].opponent, null);
    assert.equal(form[0].goalsFor, null);
    assert.equal(form[0].goalsAgainst, null);
  });
});

describe('STEP 14 T4: навигационный шум', () => {
  test('извлечён только реальный матч', () => {
    const form = extractTeamFormFromText(
      'Updates\nTimeline\nStats\nLine-ups\nEngland 2-1 Germany\nSquad',
      'England'
    );
    assert.equal(form.length, 1);
    assert.equal(form[0].opponent, 'Germany');
    assert.equal(form[0].result, 'W');
  });
});

describe('STEP 14 T5: неверные/неполные строки', () => {
  test('vs-строка и «Stats 2 1» не становятся матчем', () => {
    const form = extractTeamFormFromText('England vs Germany\nStats 2 1', 'England');
    assert.equal(form.length, 0);
  });
});

describe('STEP 14 T6: даты и сортировка newest → oldest', () => {
  test('матчи с датами возвращаются от свежих к старым', () => {
    const form = extractTeamFormFromText(
      '20 Sep 2026\nEngland 2-1 Germany\n14 Sep 2026\nSpain 1-1 England\n07 Sep 2026\nEngland 3-0 Italy',
      'England'
    );
    assert.equal(form.length, 3);
    assert.deepEqual(form.map((e) => e.date), ['20 Sep 2026', '14 Sep 2026', '07 Sep 2026']);
    assert.deepEqual(form.map((e) => e.result), ['W', 'D', 'W']);
  });

  test('ISO-даты тоже распознаются', () => {
    const form = extractTeamFormFromText(
      '2026-09-20\nEngland 2-1 Germany\n2026-09-14\nSpain 1-1 England',
      'England'
    );
    assert.equal(form.length, 2);
    assert.deepEqual(form.map((e) => e.date), ['2026-09-20', '2026-09-14']);
  });
});

describe('STEP 14 T7: лимит 10 матчей', () => {
  test('11 валидных матчей → максимум 10 (новейшие)', () => {
    const lines: string[] = [];
    for (let i = 1; i <= 11; i += 1) {
      const day = String(i).padStart(2, '0');
      lines.push(`2026-09-${day}`);
      lines.push(`England ${i}-0 Italy`);
    }
    const form = extractTeamFormFromText(lines.join('\n'), 'England');
    assert.equal(form.length, 10);
    // newest → oldest: первый матч — самый свежий (11-е число)
    assert.equal(form[0].goalsFor, 11);
    assert.equal(form[9].goalsFor, 2);
  });
});

describe('STEP 14 T8: requestedTeam определяет перспективу', () => {
  test('результат считается для requestedTeam, а не по позиции', () => {
    const line = 'Germany 0-2 England';
    const england = extractTeamFormFromText(line, 'England')[0];
    assert.equal(england.result, 'W');
    assert.equal(england.goalsFor, 2);
    assert.equal(england.opponent, 'Germany');

    const germany = extractTeamFormFromText(line, 'Germany')[0];
    assert.equal(germany.result, 'L');
    assert.equal(germany.goalsFor, 0);
    assert.equal(germany.goalsAgainst, 2);
    assert.equal(germany.opponent, 'England');
  });

  test('суффиксы FC / national team распознаются', () => {
    const form = extractTeamFormFromText('England FC 2-1 Germany', 'England national team');
    assert.equal(form.length, 1);
    assert.equal(form[0].result, 'W');
    assert.equal(form[0].opponent, 'Germany');
  });

  test('чужие матчи (requestedTeam не участвует) пропускаются', () => {
    const form = extractTeamFormFromText('Spain 1-1 France', 'England');
    assert.equal(form.length, 0);
  });
});

describe('STEP 14 T9: пустой/garbage input', () => {
  test('не бросает исключений', () => {
    assert.doesNotThrow(() => extractTeamFormFromText('', 'England'));
    assert.doesNotThrow(() => extractTeamFormFromText('', undefined));
    assert.doesNotThrow(() => extractTeamFormFromText('   \n\t \n', 'England'));
    assert.doesNotThrow(() => extractTeamFormFromText('<html><body>garbage</body></html>', 'England'));
    assert.doesNotThrow(() => extractTeamFormFromText('England 99-99 Germany', 'England'));
    assert.equal(extractTeamFormFromText('', 'England').length, 0);
    assert.equal(extractTeamFormFromText('<html><body>garbage</body></html>', 'England').length, 0);
  });
});
