// VDP Assembler: DataPack → нормализованное представление для будущего VDP.
// Пропускает только подтверждённые (confirmed) записи, сохраняет провенанс,
// не изобретает отсутствующие данные, фиксирует конфликты.

import type { DataConflict, DataPack, ProvenancedEntry } from './types';

export interface AssembledVdp {
  fixture: DataPack['fixture'];
  form: ProvenancedEntry<DataPack['form'][number]['data']>[];
  h2h: ProvenancedEntry<DataPack['h2h'][number]['data']>[];
  squads: ProvenancedEntry<DataPack['squads'][number]['data']>[];
  injuries: ProvenancedEntry<DataPack['injuries'][number]['data']>[];
  provenance: Array<{
    section: keyof Pick<DataPack, 'form' | 'h2h' | 'squads' | 'injuries'>;
    sourceId: string | null;
    confidence: number;
    fetchedAt: string | null;
  }>;
  conflicts: DataConflict[];
  stats: {
    confirmed: number;
    skippedUnconfirmed: number;
    status: DataPack['status'];
  };
}

export function assembleVdp(pack: DataPack): AssembledVdp {
  let confirmed = 0;
  let skippedUnconfirmed = 0;
  const provenance: AssembledVdp['provenance'] = [];

  function filterSection<T>(
    section: keyof Pick<DataPack, 'form' | 'h2h' | 'squads' | 'injuries'>,
    entries: ProvenancedEntry<T>[],
  ): ProvenancedEntry<T>[] {
    const kept: ProvenancedEntry<T>[] = [];
    for (const entry of entries) {
      if (!entry.confirmed) {
        skippedUnconfirmed += 1;
        continue;
      }
      confirmed += 1;
      kept.push(entry);
      provenance.push({
        section,
        sourceId: entry.sourceId,
        confidence: entry.confidence,
        fetchedAt: entry.fetchedAt,
      });
    }
    return kept;
  }

  const form = filterSection('form', pack.form);
  const h2h = filterSection('h2h', pack.h2h);
  const squads = filterSection('squads', pack.squads);
  const injuries = filterSection('injuries', pack.injuries);

  const status: DataPack['status'] =
    pack.fixture || confirmed > 0 ? (pack.fixture && confirmed > 0 ? 'complete' : 'partial') : 'empty';

  return {
    fixture: pack.fixture,
    form,
    h2h,
    squads,
    injuries,
    provenance,
    conflicts: [...pack.conflicts],
    stats: { confirmed, skippedUnconfirmed, status },
  };
}
