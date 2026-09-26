// P0-тестовые фикстуры: компактный синтетический VDP, формат совпадает с тем,
// что генерирует промпт route.ts (### MATCH n + `- **FIELD:** value`).
// Только для тестов; production-код не используется.

export function matchBlock(
  n: number,
  date: string,
  opponent: string,
  venue: string,
  score: string,
  result: string
): string {
  return `### MATCH ${n}
- **DATE:** ${date}
- **COMPETITION:** League
- **OPPONENT:** ${opponent}
- **HOME/AWAY:** ${venue}
- **SCORE:** ${score}
- **RESULT:** ${result}`;
}

export const TEAM1_MATCHES: string[] = [
  matchBlock(1, '2026-09-20', 'Team X', 'HOME', '2-1', 'W'),
  matchBlock(2, '2026-09-13', 'Team Y', 'AWAY', '1-1', 'D'),
  matchBlock(3, '2026-09-06', 'Team Z', 'HOME', '3-0', 'W'),
  matchBlock(4, '2026-08-30', 'Team W', 'AWAY', '0-2', 'L'),
  matchBlock(5, '2026-08-23', 'Team V', 'HOME', '2-0', 'W'),
];

export const TEAM2_MATCHES: string[] = [
  matchBlock(1, '2026-09-19', 'Team S', 'HOME', '1-3', 'L'),
  matchBlock(2, '2026-09-12', 'Team T', 'AWAY', '2-2', 'D'),
  matchBlock(3, '2026-09-05', 'Team U', 'HOME', '0-1', 'L'),
  matchBlock(4, '2026-08-29', 'Team R', 'AWAY', '4-1', 'W'),
  matchBlock(5, '2026-08-22', 'Team Q', 'HOME', '1-0', 'W'),
];

export function h2hBulletBlock(date: string, factScore: string, winner: string): string {
  return `- **FACT:** Team A ${factScore} Team B.
- **DATE:** ${date}.
- **SCORE:** ${factScore}.
- **WINNER:** ${winner}.
- **STATUS:** CONFIRMED.`;
}

export function buildFullVdp(): string {
  return `## MATCH

- **FACT:** Team A vs Team B

## TEAM 1 FORM

${TEAM1_MATCHES.join('\n\n')}

## TEAM 2 FORM

${TEAM2_MATCHES.join('\n\n')}

## H2H

${h2hBulletBlock('14.11.2024', '2-1', 'Team A')}
`;
}

export function buildFactOnlyVdp(): string {
  return `- **FACT:** Team Alpha vs Team Beta

## TEAM 1 FORM

${TEAM1_MATCHES.join('\n\n')}

## TEAM 2 FORM

${TEAM2_MATCHES.join('\n\n')}
`;
}

export function vdpWithH2HBullet(): string {
  return `## MATCH

- **FACT:** Team A vs Team B

## TEAM 1 FORM

${TEAM1_MATCHES.join('\n\n')}

## TEAM 2 FORM

${TEAM2_MATCHES.join('\n\n')}

## H2H

${h2hBulletBlock('14.11.2024', '2-1', 'Team A')}

${h2hBulletBlock('10.10.2024', '0-3', 'Team B')}
`;
}

export function vdpWithH2HMatchBlocks(): string {
  return `## MATCH

- **FACT:** Team A vs Team B

## TEAM 1 FORM

${TEAM1_MATCHES.join('\n\n')}

## TEAM 2 FORM

${TEAM2_MATCHES.join('\n\n')}

## HEAD-TO-HEAD

### H2H 1

- **DATE:** 14.11.2024.
- **TOURNAMENT:** Cup.
- **SCORE:** Team A 2-1 Team B.
- **WINNER:** Team A.
- **STATUS:** CONFIRMED.

### H2H 2

- **DATE:** 10.10.2024.
- **TOURNAMENT:** League.
- **SCORE:** Team A 0-3 Team B.
- **WINNER:** Team B.
- **STATUS:** CONFIRMED.
`;
}

export function buildMissingFieldsVdp(): string {
  return `## MATCH

- **FACT:** Team A vs Team B

## TEAM 1 FORM

### MATCH 1
- **DATE:** 2026-09-20
- **COMPETITION:** League
- **OPPONENT:** Team X
- **HOME/AWAY:** HOME
- **SCORE:** 2-1
- **RESULT:** W

### MATCH 2
- **DATE:** 2026-09-13
- **COMPETITION:** League
- **OPPONENT:** Team Y
- **HOME/AWAY:** AWAY
- **SCORE:** 1-1

### MATCH 3
- **DATE:** 2026-09-06
- **COMPETITION:** League
- **OPPONENT:** Team Z
- **HOME/AWAY:** HOME
- **SCORE:** 3-0
- **RESULT:** W

### MATCH 4
- **DATE:** 2026-08-30
- **COMPETITION:** League
- **OPPONENT:** Team W
- **HOME/AWAY:** AWAY
- **RESULT:** L

### MATCH 5
- **DATE:** 2026-08-23
- **COMPETITION:** League
- **OPPONENT:** Team V
- **HOME/AWAY:** HOME
- **SCORE:** 2-0
- **RESULT:** MAYBE
`;
}

export function buildEmptyFormsVdp(): string {
  return `## MATCH

- **FACT:** Team A vs Team B

## TEAM 1 FORM

## TEAM 2 FORM
`;
}

export function buildIncompleteVdp(team1Count: number, team2Count: number): string {
  return `## MATCH

- **FACT:** Team A vs Team B

## TEAM 1 FORM

${TEAM1_MATCHES.slice(0, team1Count).join('\n\n')}

## TEAM 2 FORM

${TEAM2_MATCHES.slice(0, team2Count).join('\n\n')}
`;
}

export function buildResearchReportWithVdp(vdp: string): string {
  return `# RESEARCH REPORT — Team A vs Team B

Some preamble text from You.com research.

# VERIFIED DATA PACK

${vdp}

## SQUADS

- **PLAYER:** Player One.
- **STATUS:** confirmed available.
`;
}

export function buildLlmContractResponse(probabilities: { team1: number; draw: number; team2: number }): string {
  return JSON.stringify({
    status: 'success',
    match: 'Team A vs Team B',
    probabilities,
    usedSources: [{ title: 'UEFA', url: 'https://www.uefa.com/example' }],
    explanation: {
      overview: 'Overview text',
      team1Form: 'Team A form text',
      team2Form: 'Team B form text',
      h2h: 'H2H text',
      squadAndInjuries: 'Squad text',
      factors: ['Factor one', 'Factor two'],
    },
  });
}
