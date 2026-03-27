import { type ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import { Wallet, Eye, EyeOff, RefreshCw } from 'lucide-react';
import { usePrivacy } from '../contexts/PrivacyContext';

interface LayoutProps {
  children: ReactNode;
  headerRight?: ReactNode;
  refreshing?: boolean;
  onRefresh?: () => void;
}

export function Layout({ children, headerRight, refreshing, onRefresh }: LayoutProps) {
  const { privacyMode, togglePrivacy } = usePrivacy();

  return (
    <div id="app">
      <header>
        <div className="header-left">
          <Wallet className="logo-icon" size={20} />
          <nav className="top-nav">
            <NavLink to="/" end className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>
              Finance
            </NavLink>
            <NavLink to="/investments" className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>
              Investments
            </NavLink>
          </nav>
        </div>
        <div className="header-right">
          {headerRight}
          <button
            className={`btn-privacy${privacyMode ? ' active' : ''}`}
            title="Toggle privacy mode"
            onClick={togglePrivacy}
          >
            {privacyMode ? <EyeOff size={16} /> : <Eye size={16} />}
          </button>
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
