import type { HistoricalCalibrationRecord } from './calibration-types';

export function validateHistoricalCalibrationRecord(record: HistoricalCalibrationRecord): boolean {
  if (!record.match || !record.match.matchId || !record.match.predictionCutoff) {
    return false;
  }
  if (!record.target || !record.target.regulation || !record.target.final) {
    return false;
  }
  return true;
}
