import { type ReactNode, useRef, useState } from 'react';
import { NavLink } from 'react-router-dom';
import { Wallet, Eye, EyeOff, RefreshCw, Heart, Home, LogOut } from 'lucide-react';
import { usePrivacy } from '../contexts/PrivacyContext';
import { useAuth } from '../contexts/AuthContext';
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
          <UserMenu />
        </div>
      </header>
      {children}
    </div>
  );
}

function UserMenu() {
  const { user, logout } = useAuth();
  const [open, setOpen] = useState(false);

  if (!user) return null;

  return (
    <div className="user-menu" style={{ position: 'relative' }}>
      <button
        className="btn-icon user-avatar-btn"
        title={user.name}
        onClick={() => setOpen(!open)}
      >
        {user.picture ? (
          <img
            src={user.picture}
            alt={user.name}
            style={{ width: 24, height: 24, borderRadius: '50%' }}
            referrerPolicy="no-referrer"
          />
        ) : (
          <span style={{ fontSize: 14, fontWeight: 600 }}>
            {user.name.charAt(0).toUpperCase()}
          </span>
        )}
      </button>
      {open && (
        <>
          <div
            className="user-menu-backdrop"
            onClick={() => setOpen(false)}
          />
          <div className="user-menu-dropdown">
            <div className="user-menu-info">
              <span className="user-menu-name">{user.name}</span>
              <span className="user-menu-email">{user.email}</span>
            </div>
            <button className="user-menu-item" onClick={logout}>
              <LogOut size={14} />
              Sign out
            </button>
          </div>
        </>
      )}
    </div>
  );
}
