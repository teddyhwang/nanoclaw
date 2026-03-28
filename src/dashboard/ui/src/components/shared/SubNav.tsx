import { type ReactNode, type MouseEventHandler, useMemo } from 'react';
import { relTime } from '../../utils/format';
import styles from './SubNav.module.css';

interface SubNavProps {
  children: ReactNode;
}

interface TabProps {
  active?: boolean;
  disabled?: boolean;
  onClick?: MouseEventHandler<HTMLButtonElement>;
  className?: string;
  children: ReactNode;
}

interface InfoProps {
  children: ReactNode;
  className?: string;
}

function Tab({ active, disabled, onClick, className, children }: TabProps) {
  const cls = [
    active ? styles.tabActive : styles.tab,
    disabled ? styles.tabDisabled : '',
    className || '',
  ].filter(Boolean).join(' ');

  return (
    <button className={cls} onClick={onClick} disabled={disabled}>
      {children}
    </button>
  );
}

function Separator() {
  return <div className={styles.separator} />;
}

function Info({ children, className }: InfoProps) {
  return (
    <span className={`${styles.info}${className ? ` ${className}` : ''}`}>
      {children}
    </span>
  );
}

export function SubNav({ children }: SubNavProps) {
  return <nav className={styles.nav}>{children}</nav>;
}

interface SyncInfoProps {
  timestamps: Record<string, string | null | undefined>;
}

function SyncInfo({ timestamps }: SyncInfoProps) {
  const label = useMemo(() => {
    const parts = Object.entries(timestamps)
      .filter(([, ts]) => ts)
      .map(([name, ts]) => `${name} ${relTime(ts!)}`);
    return parts.length > 0 ? parts.join(' · ') : null;
  }, [timestamps]);

  if (!label) return null;
  return (
    <>
      <Separator />
      <Info>{label}</Info>
    </>
  );
}

SubNav.Tab = Tab;
SubNav.Separator = Separator;
SubNav.Info = Info;
SubNav.SyncInfo = SyncInfo;
