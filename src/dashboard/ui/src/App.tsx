import { useState, useEffect } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import type { DashboardData, InvestmentData } from './types';
import { fetchDashboard, fetchInvestments } from './api';
import { PrivacyProvider } from './contexts/PrivacyContext';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { Loading } from './components/Loading';
import { FinancePage } from './components/finance/FinancePage';
import { InvestmentsPage } from './components/investments/InvestmentsPage';
import { HealthPage } from './components/health/HealthPage';
import { HomePage } from './components/home/HomePage';
import { NotFound } from './components/NotFound';

function Dashboard() {
  const { user, loading: authLoading } = useAuth();
  const [financeData, setFinanceData] = useState<DashboardData | null>(null);
  const [investmentData, setInvestmentData] = useState<InvestmentData | null>(null);
  const [, setHealthLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (authLoading || !user) return;

    // Load both datasets in parallel
    Promise.all([
      fetchDashboard().catch((e) => { console.error('Finance load error:', e); return null; }),
      fetchInvestments().catch((e) => { console.error('Investments load error:', e); return null; }),
    ]).then(([finance, investments]) => {
      if (!finance && !investments) {
        setError('Failed to load any data. Is the API server running?');
      }
      setFinanceData(finance);
      setInvestmentData(investments);
      setHealthLoaded(true);
      setLoading(false);
    });
  }, [authLoading, user]);

  if (authLoading) return <Loading message="Checking authentication…" />;

  // If not authenticated, the server will have redirected to Google OAuth.
  // This is a fallback in case the API returns 401.
  if (!user) {
    window.location.href = '/auth/google';
    return <Loading message="Redirecting to sign in…" />;
  }

  if (loading) return <Loading message="Loading dashboard data…" />;
  if (error) return <Loading error={error} />;

  return (
    <PrivacyProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route
            path="/finance"
            element={
              financeData ? (
                <FinancePage initialData={financeData} />
              ) : (
                <Loading error="Finance data unavailable" />
              )
            }
          />
          <Route
            path="/investments"
            element={
              investmentData ? (
                <InvestmentsPage initialData={investmentData} />
              ) : (
                <Loading error="Investment data unavailable" />
              )
            }
          />
          <Route
            path="/investments/salaries"
            element={
              investmentData ? (
                <InvestmentsPage initialData={investmentData} />
              ) : (
                <Loading error="Investment data unavailable" />
              )
            }
          />
          <Route path="/health" element={<HealthPage />} />
          <Route
            path="/investments/:year"
            element={
              investmentData ? (
                <InvestmentsPage initialData={investmentData} />
              ) : (
                <Loading error="Investment data unavailable" />
              )
            }
          />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </BrowserRouter>
    </PrivacyProvider>
  );
}

export function App() {
  return (
    <AuthProvider>
      <Dashboard />
    </AuthProvider>
  );
}
