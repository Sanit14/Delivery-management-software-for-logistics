import type { FirmLedger } from '../db/database';
import { formatINR, formatDate } from '../utils/reportUtils';

interface LedgerTableProps {
  entries: FirmLedger[];
}

const CAT_LABELS: Record<string, string> = {
  freight:          'Freight (ToPay+Paid)',
  delivery_charges: 'Delivery Charges (our commission)',
  truck_hire:       'Truck Hire',
  adjustment:       'Adjustment',
  settlement:       'Settlement',
};

export default function LedgerTable({ entries }: LedgerTableProps) {
  return (
    <div className="table-wrap" style={{ overflowX: 'auto' }}>
      <table className="data-table">
        <thead>
          <tr>
            <th>Date</th>
            <th>Challan No.</th>
            <th>Category</th>
            <th>Description</th>
            <th>+ Owe Firm</th>
            <th>− Less</th>
            <th>Balance</th>
          </tr>
        </thead>
        <tbody>
          {entries.map(e => (
            <tr key={e.id} className={e.type === 'debit' ? 'ledger-debit' : 'ledger-credit'}>
              <td>{formatDate(e.entryDate)}</td>
              <td className="td-bold">{e.challanNumber}</td>
              <td>{CAT_LABELS[e.category] || e.category}</td>
              <td style={{ fontSize: 12 }}>{e.description}</td>
              <td className="ledger-amt-debit">{e.type === 'debit' ? formatINR(e.amount) : ''}</td>
              <td className="ledger-amt-credit">{e.type === 'credit' ? formatINR(e.amount) : ''}</td>
              <td className={e.runningBalance > 0 ? 'bal-positive' : e.runningBalance < 0 ? 'bal-negative' : 'bal-zero'}>
                {formatINR(Math.abs(e.runningBalance))} {e.runningBalance > 0 ? '(owe firm)' : e.runningBalance < 0 ? '(firm owes)' : ''}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
