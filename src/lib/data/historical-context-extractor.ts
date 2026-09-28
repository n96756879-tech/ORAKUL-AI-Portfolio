import { extractTeamFormFromText } from './form-extractor';
import type { TeamFormSnapshot } from './types';

type Strength = NonNullable<TeamFormSnapshot['opponentStrength']>;
type Venue = NonNullable<TeamFormSnapshot['venue']>;

const SCORE_LINE = /^(.+?)\s+(\d{1,2})\s*[-–—]\s*(\d{1,2})\s+(.+)$/;

function parseStrength(value: string): Strength {
  const normalized = value.trim().toUpperCase();
  return normalized === 'STRONG' || normalized === 'MEDIUM' || normalized === 'WEAK'
    ? normalized
    : 'UNKNOWN';
}

function parseVenue(value: string): Venue {
  const normalized = value.trim().toUpperCase();
  if (normalized === 'HOME' || normalized === 'H') return 'HOME';
  if (normalized === 'AWAY' || normalized === 'A') return 'AWAY';
  if (normalized === 'NEUTRAL' || normalized === 'N') return 'NEUTRAL';
  return 'UNKNOWN';
}

function metadataForMatches(text: string, requestedTeam?: string): Array<{ venue: Venue; opponentStrength: Strength }> {
  const lines = text.split(/\r?\n/).map((line) => line.replace(/<[^>]*>/g, '').trim()).filter(Boolean);
  const contexts: Array<{ venue: Venue; opponentStrength: Strength }> = [];
  let venue: Venue = 'UNKNOWN';
  let opponentStrength: Strength = 'UNKNOWN';

  for (const line of lines) {
    const venueField = line.match(/(?:HOME\/AWAY|VENUE)\s*[:*]+\s*([^*]+?)(?:\*|$)/i);
    if (venueField) {
      venue = parseVenue(venueField[1]);
      continue;
    }
    const strengthField = line.match(/OPPONENT[_ ]STRENGTH\s*[:*]+\s*([^*]+?)(?:\*|$)/i);
    if (strengthField) {
      opponentStrength = parseStrength(strengthField[1]);
      continue;
    }
    const scoreField = line.match(/SCORE\s*[:*]+\s*(\d{1,2})\s*[-–—]\s*(\d{1,2})/i);
    if (scoreField) {
      contexts.push({ venue, opponentStrength });
      venue = 'UNKNOWN';
      opponentStrength = 'UNKNOWN';
      continue;
    }
    const score = line.match(SCORE_LINE);
    if (!score) continue;

    if (venue === 'UNKNOWN' && requestedTeam) {
      const home = score[1].trim().toLowerCase();
      const subject = requestedTeam.trim().toLowerCase();
      venue = home === subject ? 'HOME' : score[4].trim().toLowerCase() === subject ? 'AWAY' : 'UNKNOWN';
    }
    contexts.push({ venue, opponentStrength });
    venue = 'UNKNOWN';
    opponentStrength = 'UNKNOWN';
  }
  return contexts;
}

function extractLabeledMatches(text: string, requestedTeam: string): TeamFormSnapshot[] {
  const blocks = text.split(/^\s*#{2,}\s*MATCH\b[^\r\n]*$/im).slice(1);
  const entries: TeamFormSnapshot[] = [];
  for (const block of blocks) {
    const field = (name: string) =>
      block.match(new RegExp(`${name}\\s*\\**\\s*:\\s*\\**\\s*([^\\r\\n*]+)`, 'i'))?.[1]?.trim() ?? null;
    const opponent = field('OPPONENT');
    const score = field('SCORE')?.match(/^(\d{1,2})\s*[-–—]\s*(\d{1,2})$/);
    if (!opponent || !score) continue;
    const goalsFor = Number(score[1]);
    const goalsAgainst = Number(score[2]);
    const resultValue = field('RESULT')?.toUpperCase();
    const result = resultValue === 'W' || resultValue === 'D' || resultValue === 'L' ? resultValue :
      goalsFor > goalsAgainst ? 'W' : goalsFor < goalsAgainst ? 'L' : 'D';
    const venueValue = field('HOME/AWAY') ?? field('VENUE');
    const strengthValue = field('OPPONENT_STRENGTH');
    entries.push({
      team: requestedTeam,
      summary: `${result} ${goalsFor}-${goalsAgainst} vs ${opponent}`,
      date: field('DATE'),
      opponent,
      result,
      goalsFor,
      goalsAgainst,
      venue: venueValue ? parseVenue(venueValue) : 'UNKNOWN',
      opponentStrength: strengthValue ? parseStrength(strengthValue) : 'UNKNOWN',
    });
  }
  return entries;
}

export function extractHistoricalContextFromText(text: string, requestedTeam?: string): TeamFormSnapshot[] {
  if (requestedTeam) {
    const labeled = extractLabeledMatches(text, requestedTeam);
    if (labeled.length > 0) return labeled;
  }
  const snapshots = extractTeamFormFromText(text, requestedTeam);
  const contexts = metadataForMatches(text, requestedTeam);
  return snapshots.map((snapshot, index) => ({
    ...snapshot,
    venue: contexts[index]?.venue ?? 'UNKNOWN',
    opponentStrength: contexts[index]?.opponentStrength ?? 'UNKNOWN',
  }));
}
