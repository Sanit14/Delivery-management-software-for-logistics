
const LABELS: Record<string, string> = {
  open:      'Open',
  saved:     'Saved',
  cancelled: 'Cancelled',
  pending:   'Pending',
  collected: 'Collected',
  printed:   'Printed',
  delivered: 'Delivered',
  active:    'Active',
};

export default function StatusBadge({ status }: { status: string }) {
  // Printed/Delivered are routine, expected DR states, not something that needs
  // flagging — only Pending (needs action) and Cancelled (needs attention) show a badge.
  if (status === 'printed' || status === 'delivered') return null;
  return <span className={`pill pill-${status}`}>{LABELS[status] || status}</span>;
}
