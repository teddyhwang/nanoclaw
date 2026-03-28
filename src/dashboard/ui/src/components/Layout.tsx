import { type ReactNode, useRef } from 'react';
import { NavLink } from 'react-router-dom';
import { Wallet, Eye, EyeOff, RefreshCw, Heart, Home } from 'lucide-react';
import { usePrivacy } from '../contexts/PrivacyContext';
import { useLocation } from 'react-router-dom';
import { usePullToRefresh } from '../hooks/usePullToRefresh';

interface LayoutProps {
  children: ReactNode;
  headerRight?: ReactNode;
  refreshing?: boolean;
  onRefresh?: () => void;
}

export function Layout({ children, headerRight, refreshing, onRefresh }: LayoutProps) {
  const { privacyMode, togglePrivacy } = usePrivacy();
  const location = useLocation();
  const isHome = location.pathname === '/';
  const isHealth = location.pathname.startsWith('/health');
  const LogoIcon = isHome ? Home : isHealth ? Heart : Wallet;
  const appRef = useRef<HTMLDivElement>(null);
  usePullToRefresh(appRef);

  return (
    <div id="app" ref={appRef}>
      <header>
        <div className="header-left">
          <LogoIcon className="logo-icon" size={20} />
          <nav className="top-nav">
            <NavLink to="/" end className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>
              Home
            </NavLink>
            <NavLink to="/finance" className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>
              Finance
            </NavLink>
            <NavLink to="/investments" className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>
              Investments
            </NavLink>
            <NavLink to="/health" className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>
              Health
            </NavLink>
          </nav>
        </div>
        <div className="header-right">
          {headerRight}
          {!isHealth && !isHome && (
            <button
              className={`btn-privacy${privacyMode ? ' active' : ''}`}
              title="Toggle privacy mode"
              onClick={togglePrivacy}
            >
              {privacyMode ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          )}
          {onRefresh && (
            <button
              className={`btn-icon${refreshing ? ' spinning' : ''}`}
              title="Refresh data"
              onClick={onRefresh}
            >
              <RefreshCw size={16} />
            </button>
          )}
        </div>
      </header>
      {children}
    </div>
  );
}
