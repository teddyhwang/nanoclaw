import { COLORS } from '../../constants';
import type { ChartDataset } from 'chart.js';

/** Shared tooltip styling for all charts */
export const tooltipStyle = {
  backgroundColor: 'rgba(19,23,33,0.95)',
  borderColor: 'rgba(62,75,89,0.5)',
  borderWidth: 1,
  titleColor: COLORS.text,
  bodyColor: COLORS.hi,
} as const;

/** Shared axis defaults */
export const axisStyle = {
  x: {
    grid: { display: false },
    ticks: { color: COLORS.muted },
  },
  y: {
    grid: { color: 'rgba(62,75,89,0.2)' },
    ticks: { color: COLORS.muted },
  },
} as const;

/** Create a line dataset with standard styling */
export function createLineDataset(
  label: string,
  data: number[],
  color: string,
  options?: Partial<ChartDataset<'line'>>,
): ChartDataset<'line'> {
  return {
    label,
    data,
    borderColor: color,
    backgroundColor: color.replace(')', ',0.1)').replace('rgb(', 'rgba('),
    fill: true,
    tension: 0.3,
    pointRadius: 0,
    pointHoverRadius: 4,
    borderWidth: 2,
    ...options,
  };
}

/** Create a bar dataset with standard styling */
export function createBarDataset(
  label: string,
  data: number[],
  colors: string | string[],
  options?: Partial<ChartDataset<'bar'>>,
): ChartDataset<'bar'> {
  return {
    label,
    data,
    backgroundColor: colors,
    borderRadius: 2,
    borderSkipped: false as const,
    ...options,
  };
}

/** Strip year from date string for x-axis display (YYYY-MM-DD → MM-DD) */
export function formatDateTick(date: string): string {
  return date.slice(5);
}
