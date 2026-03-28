import { type ReactNode, type CSSProperties } from 'react';
import styles from './PageContent.module.css';

interface PageContentProps {
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
  /** Fill mode: children fill available height, no scroll on this container (desktop). Used by finance grid. */
  fill?: boolean;
}

export function PageContent({ children, className, style, fill }: PageContentProps) {
  const base = fill ? styles.fill : styles.content;
  return (
    <div className={`${base}${className ? ` ${className}` : ''}`} style={style}>
      {children}
    </div>
  );
}
