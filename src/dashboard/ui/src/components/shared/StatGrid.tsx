import { type ReactNode } from 'react';
import styles from './StatGrid.module.css';

interface StatGridProps {
  children: ReactNode;
  className?: string;
}

export function StatGrid({ children, className }: StatGridProps) {
  return (
    <div className={`${styles.grid}${className ? ` ${className}` : ''}`}>
      {children}
    </div>
  );
}
