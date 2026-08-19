/**
 * Date-range helpers, kept separate from the DateRangePicker component so that
 * component file only exports a component (required by React Fast Refresh).
 */

export interface DateRange {
  from: string; // ISO yyyy-mm-dd, or '' for no lower bound
  to: string;   // ISO yyyy-mm-dd, or '' for no upper bound
}

/** Returns true if an ISO date falls within the range (inclusive). Empty bounds
 *  mean "no limit on that side". An empty date never matches a bounded range. */
export function inRange(dateISO: string | undefined, r: DateRange): boolean {
  if (!r.from && !r.to) return true;     // "All"
  if (!dateISO) return false;
  if (r.from && dateISO < r.from) return false;
  if (r.to && dateISO > r.to) return false;
  return true;
}
