import { createContext, useContext, useState, useEffect, type ReactNode } from 'react';
import { fetchAuthUser, type AuthUser } from '../api';

interface AuthContextType {
  user: AuthUser | null;
  loading: boolean;
  logout: () => void;
}

const AuthContext = createContext<AuthContextType>({
  user: null,
  loading: true,
  logout: () => {},
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchAuthUser()
      .then((u) => {
        setUser(u);
        setLoading(false);
      })
      .catch(() => {
        setLoading(false);
      });
  }, []);

  const logout = () => {
    window.location.href = '/auth/logout';
  };

  return (
    <AuthContext.Provider value={{ user, loading, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
