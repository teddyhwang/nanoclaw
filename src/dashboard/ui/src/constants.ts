export const COLORS = {
  bg: '#0b0e14',
  panel: '#131721',
  card: '#202229',
  border: '#3e4b59',
  muted: '#6c7a8a',
  accent: '#59c2ff',
  text: '#bfbdb6',
  hi: '#e6e1cf',
  max: '#f2f0e7',
  red: '#f07178',
  orange: '#ff8f40',
  yellow: '#ffb454',
  green: '#aad94c',
  cyan: '#95e6cb',
  blue: '#59c2ff',
  purple: '#d2a6ff',
  brown: '#e6b450',
} as const;

export const CHART_COLORS = [
  COLORS.blue,
  COLORS.green,
  COLORS.yellow,
  COLORS.purple,
  COLORS.cyan,
  COLORS.orange,
  COLORS.red,
  COLORS.brown,
  COLORS.accent,
];

export const TX_PER_PAGE = 100;

export const EXCLUDED_CATS = [
  'payment, transfer',
  'transfer',
  'payment',
  'investment',
];

export const DATE_RANGE_OPTIONS = [
  { value: 'thisWeek', label: 'This Week' },
  { value: 'lastWeek', label: 'Last Week' },
  { value: '30days', label: 'Last 30 Days' },
  { value: 'thisMonth', label: 'This Month' },
  { value: 'lastMonth', label: 'Last Month' },
  { value: 'ytd', label: 'Year to Date' },
  { value: '6months', label: 'Last 6 Months' },
  { value: '90days', label: 'Last 90 Days' },
  { value: 'lastYear', label: 'Last Year' },
  { value: 'all', label: 'All Time' },
] as const;

export const FINANCE_UI_STATE_KEY = 'finance-ui-state';
