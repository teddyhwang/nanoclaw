import { type ReactNode } from 'react';
import styles from './DataTable.module.css';

export interface Column<T> {
  key: string;
  label: string;
  render?: (row: T, index: number) => ReactNode;
  sortable?: boolean;
  align?: 'left' | 'center' | 'right';
}

interface DataTableProps<T> {
  columns: Column<T>[];
  data: T[];
  sortCol?: string;
  sortDir?: 1 | -1;
  onSort?: (col: string) => void;
  maxHeight?: number;
  emptyMessage?: string;
  className?: string;
}

export function DataTable<T>({
  columns,
  data,
  sortCol,
  sortDir,
  onSort,
  maxHeight,
  emptyMessage = 'No data',
  className,
}: DataTableProps<T>) {
  return (
    <div
      className={`${styles.wrapper}${className ? ` ${className}` : ''}`}
      style={maxHeight ? { maxHeight } : undefined}
    >
      <table className={styles.table}>
        <thead>
          <tr>
            {columns.map((col) => {
              const isSortable = col.sortable && onSort;
              const isActive = sortCol === col.key;
              const thClasses = [
                isSortable ? styles.sortable : '',
                isActive ? styles.sortActive : '',
                col.align === 'right' ? styles.alignRight : '',
                col.align === 'center' ? styles.alignCenter : '',
              ].filter(Boolean).join(' ');

              return (
                <th
                  key={col.key}
                  className={thClasses || undefined}
                  onClick={isSortable ? () => onSort(col.key) : undefined}
                >
                  {col.label}
                  {isSortable && isActive && (
                    <span className={`${styles.sortArrow} ${styles.sortArrowActive}`}>
                      {sortDir === 1 ? ' ▲' : ' ▼'}
                    </span>
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {data.length === 0 ? (
            <tr>
              <td colSpan={columns.length} className={styles.emptyRow}>
                {emptyMessage}
              </td>
            </tr>
          ) : (
            data.map((row, i) => (
              <tr key={i}>
                {columns.map((col) => (
                  <td
                    key={col.key}
                    className={
                      col.align === 'right' ? styles.alignRight :
                      col.align === 'center' ? styles.alignCenter :
                      undefined
                    }
                  >
                    {col.render
                      ? col.render(row, i)
                      : String((row as Record<string, unknown>)[col.key] ?? '')}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
