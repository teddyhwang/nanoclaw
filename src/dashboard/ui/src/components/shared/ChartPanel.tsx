import { type ReactNode } from 'react';
import { Panel } from './Panel';
import styles from './ChartPanel.module.css';

interface ChartPanelProps {
  title: string;
  subtitle?: string;
  titleColor?: string;
  headerRight?: ReactNode;
  height?: number;
  className?: string;
  children: ReactNode;
}

export function ChartPanel({ title, subtitle, titleColor, headerRight, height = 220, className, children }: ChartPanelProps) {
  return (
    <Panel title={title} subtitle={subtitle} titleColor={titleColor} headerRight={headerRight} className={className}>
      <div className={styles.chartWrap} style={{ height, flex: 'none' }}>
        {children}
      </div>
    </Panel>
  );
}
