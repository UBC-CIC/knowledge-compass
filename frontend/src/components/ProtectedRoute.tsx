import { useEffect, useState } from "react";
import { Navigate, useLocation } from "react-router";
import { AuthService } from "@/functions/authService";
import { isDemoMode } from "@/lib/demo";

interface ProtectedRouteProps {
  children: React.ReactNode;
}

export default function ProtectedRoute({ children }: ProtectedRouteProps) {
  const [isAuthenticated, setIsAuthenticated] = useState<boolean | null>(
    isDemoMode ? true : null
  );
  const location = useLocation();

  useEffect(() => {
    if (isDemoMode) return;

    const checkAuth = async () => {
      try {
        const session = await AuthService.getAuthSession(true);
        setIsAuthenticated(!!session?.tokens?.accessToken);
      } catch {
        setIsAuthenticated(false);
      }
    };

    checkAuth();
  }, []);

  if (isDemoMode || isAuthenticated) {
    return <>{children}</>;
  }

  if (isAuthenticated === null) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-muted">
        <div className="text-sm text-foreground/75">Loading...</div>
      </div>
    );
  }

  return <Navigate to="/admin/login" replace state={{ from: location }} />;
}
