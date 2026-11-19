// Pure helpers of the Incidents view. Month boundaries are the plant's (format.js dayOf/dayStart).
import { dayOf, dayStart } from '../format.js';

const monthOf = (ts) => dayOf(ts).slice(0, 7);
const nextMonth = (m) => {
  const [y, mo] = m.split('-').map(Number);
  return `${mo === 12 ? y + 1 : y}-${String(mo === 12 ? 1 : mo + 1).padStart(2, '0')}`;
};

// kinds: array of kind names; empty or null keeps everything. Filter before grouping, so a day's internet
// losses stay together.
export const filterKinds = (events, kinds) => (kinds?.length ? events.filter((e) => kinds.includes(e.kind)) : events);

// [{ month: 'YYYY-MM', hours: { kind: h } }] ascending, empty months between the first and last filled in.
// An event crossing the start of a month counts in each month for its own part.
export function hoursPerMonth(events, kinds) {
  const by = new Map();
  for (const e of filterKinds(events, kinds)) {
    for (let cur = e.start; cur < e.end;) {
      const m = monthOf(cur);
      const next = Math.min(e.end, dayStart(`${nextMonth(m)}-01`));
      const hours = by.get(m) ?? {};
      hours[e.kind] = (hours[e.kind] ?? 0) + (next - cur) / 3600e3;
      by.set(m, hours);
      cur = next;
    }
  }
  const months = [...by.keys()].sort();
  const out = [];
  for (let m = months[0]; m && m <= months.at(-1); m = nextMonth(m)) out.push({ month: m, hours: by.get(m) ?? {} });
  return out;
}
