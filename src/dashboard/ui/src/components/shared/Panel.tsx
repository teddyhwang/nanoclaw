import { type ReactNode } from 'react';
import styles from './Panel.module.css';

interface PanelProps {
  title?: string;
  subtitle?: string;
  titleColor?: string;
  headerRight?: ReactNode;
  className?: string;
  children: ReactNode;
}

export function Panel({ title, subtitle, titleColor, headerRight, className, children }: PanelProps) {
  return (
    <div className={`${styles.panel}${className ? ` ${className}` : ''}`}>
      {title && (
        <div className={styles.header} style={titleColor ? { color: titleColor } : undefined}>
          <div className={styles.headerContent}>
            {title}
            {subtitle && <span className={styles.subtitle}>{subtitle}</span>}
          </div>
          {headerRight && <div className={styles.headerRight}>{headerRight}</div>}
        </div>
      )}
      {children}
    </div>
  );
}
