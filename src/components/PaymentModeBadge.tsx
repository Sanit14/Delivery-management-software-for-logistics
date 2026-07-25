
const LABELS: Record<string, string> = {
  topay:   'ToPay',
  paid:    'Paid',
  charges: 'Charges',
  none:    '—',
};

export default function PaymentModeBadge({ mode }: { mode: string }) {
  return <span className={`pill pill-${mode}`}>{LABELS[mode] || mode}</span>;
}
