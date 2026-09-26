export function extractVDP(report: string): string {
  if (!report) return '';
  const marker = 'VERIFIED DATA PACK';
  const idx = report.indexOf(marker);
  if (idx === -1) return '';
  return report.slice(idx);
}
