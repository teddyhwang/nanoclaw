import type { DashboardData, InvestmentData, HealthData } from './types';

export async function fetchDashboard(
  forceRefresh = false,
): Promise<DashboardData> {
  const url = forceRefresh ? '/api/dashboard?refresh=true' : '/api/dashboard';
  const r = await fetch(url);
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function fetchInvestments(
  forceRefresh = false,
): Promise<InvestmentData> {
  const url = forceRefresh
    ? '/api/investments?refresh=true'
    : '/api/investments';
  const r = await fetch(url);
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function fetchHealth(params?: {
  days?: number;
  since?: string;
  until?: string;
}): Promise<HealthData> {
  const parts: string[] = [];
  if (params?.since) parts.push(`since=${params.since}`);
  else parts.push(`days=${params?.days ?? 90}`);
  if (params?.until) parts.push(`until=${params.until}`);
  const r = await fetch(`/api/health?${parts.join('&')}`);
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function saveProperties(properties: unknown[]): Promise<void> {
  await fetch('/api/properties/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(properties),
  });
}

export async function updateInvestmentField(
  year: string,
  path: string[],
  value: number,
): Promise<void> {
  await fetch('/api/investments/update', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ year, path, value }),
  });
}

export interface AmazonMatch {
  products: string[];
  order_id?: string;
  match_type: 'item' | 'order' | 'pair' | 'triple' | 'refund';
}

export async function fetchAmazonMatches(): Promise<
  Record<string, AmazonMatch>
> {
  const r = await fetch('/api/amazon-matches');
  if (!r.ok) return {};
  return r.json();
}

export async function saveInvestmentData(data: InvestmentData): Promise<void> {
  await fetch('/api/investments/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
}
