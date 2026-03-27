export function toISO(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function monthStart(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

export function weekRange(dateStr: string): { start: string; end: string } {
  const d = new Date(dateStr + 'T00:00:00');
  const day = d.getDay();
  const mon = new Date(d);
  mon.setDate(d.getDate() - day + (day === 0 ? -6 : 1));
  const sun = new Date(mon);
  sun.setDate(mon.getDate() + 6);
  return { start: toISO(mon), end: toISO(sun) };
}

export function getDateRange(dateRange: string): { from: string; to: string } {
  const now = new Date();
  const day = now.getDay();
  const mondayOffset = day === 0 ? -6 : 1 - day;

  switch (dateRange) {
    case 'thisWeek': {
      const start = new Date(now);
      start.setDate(now.getDate() + mondayOffset);
      return { from: toISO(start), to: toISO(now) };
    }
    case 'lastWeek': {
      const thisWeekStart = new Date(now);
      thisWeekStart.setDate(now.getDate() + mondayOffset);
      const start = new Date(thisWeekStart);
      start.setDate(thisWeekStart.getDate() - 7);
      const end = new Date(thisWeekStart);
      end.setDate(thisWeekStart.getDate() - 1);
      return { from: toISO(start), to: toISO(end) };
    }
    case '30days': {
      const d = new Date(now);
      d.setDate(d.getDate() - 30);
      return { from: toISO(d), to: toISO(now) };
    }
    case 'thisMonth':
      return { from: toISO(monthStart(now)), to: toISO(now) };
    case 'lastMonth': {
      const lm = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const lme = new Date(now.getFullYear(), now.getMonth(), 0);
      return { from: toISO(lm), to: toISO(lme) };
    }
    case 'ytd': {
      const start = new Date(now.getFullYear(), 0, 1);
      return { from: toISO(start), to: toISO(now) };
    }
    case '6months': {
      const d = new Date(now);
      d.setMonth(d.getMonth() - 6);
      return { from: toISO(d), to: toISO(now) };
    }
    case '90days': {
      const d = new Date(now);
      d.setDate(d.getDate() - 90);
      return { from: toISO(d), to: toISO(now) };
    }
    case 'lastYear': {
      const y = now.getFullYear() - 1;
      return { from: `${y}-01-01`, to: `${y}-12-31` };
    }
    default:
      return { from: '2000-01-01', to: '2099-12-31' };
  }
}
