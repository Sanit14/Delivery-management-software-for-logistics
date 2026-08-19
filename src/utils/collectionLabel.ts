import type { MemoPrintRow } from '../components/MemoPrint';

export const collectionLabel = (r: MemoPrintRow) => {
  if (!r.dr) return '—';
  if (!r.wasuli) return 'Settled';
  if (r.wasuli.status === 'collected') return 'Collected';
  if (r.wasuli.operatorId !== 0) return 'Assigned';
  return 'Pending';
};
