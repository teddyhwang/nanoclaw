export function formatCurrency(
  n: number,
  privacyMode: boolean,
  decimals: number,
  currency = 'CAD',
): string {
  n = typeof n === 'string' ? parseFloat(n) : n;
  if (privacyMode) {
    const s = n < 0 ? '-' : '';
    return `${s}$••,•••${decimals ? '.••' : ''}`;
  }
  return new Intl.NumberFormat('en-CA', {
    style: 'currency',
    currency: currency.toUpperCase(),
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(n);
}

export const fmt = (n: number, privacyMode: boolean, cur?: string) =>
  formatCurrency(n, privacyMode, 0, cur);

export const fmtFull = (n: number, privacyMode: boolean, cur?: string) =>
  formatCurrency(n, privacyMode, 2, cur);

export function fmtPct(n: number, privacyMode: boolean): string {
  if (privacyMode) return '•.••%';
  return (n >= 0 ? '+' : '') + n.toFixed(2) + '%';
}

export function fmtDate(dateStr: string): string {
  return new Date(dateStr + 'T00:00:00').toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

export function valClass(n: number): string {
  return n > 0 ? 'pos' : n < 0 ? 'neg' : '';
}

export function relTime(iso: string | undefined): string {
  if (!iso) return '';
  const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return 'now';
  if (m < 60) return m + 'm';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h';
  return Math.floor(h / 24) + 'd';
}
