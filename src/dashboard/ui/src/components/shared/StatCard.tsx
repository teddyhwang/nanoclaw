import type { LucideIcon } from 'lucide-react';
import styles from './StatCard.module.css';

interface StatCardProps {
  label: string;
  value: string;
  icon: LucideIcon;
  color: string;
  className?: string;
}

export function StatCard({ label, value, icon: Icon, color, className }: StatCardProps) {
  return (
    <div className={`${styles.statCard}${className ? ` ${className}` : ''}`}>
      <div className={styles.icon} style={{ color }}>
        <Icon size={16} />
      </div>
      <span className={styles.label}>{label}</span>
      <span className={styles.value} style={{ color }}>{value}</span>
    </div>
  );
}
