import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { getCurrentUser } from "aws-amplify/auth";
import { AuthService } from "@/functions/authService";
import BrandMark from "@/components/BrandMark";
import AdminSidebar, { type AdminView } from "@/components/Admin/AdminSidebar";
import DataSourceManagement from "@/components/Admin/DataSourceManagement";
import Analytics from "@/components/Admin/Analytics";
import PromptManagement from "@/components/Admin/Prompts/PromptManagement";
import SystemSettings from "@/components/Admin/SystemSettings";
import GuidelineMode from "@/components/Admin/Guideline/GuidelineMode";
import { DEMO_ADMIN_EMAIL, isDemoMode } from "@/lib/demo";

export default function AdminDashboard() {
  const navigate = useNavigate();
  const [activeView, setActiveView] = useState<AdminView>("dashboard");
  const [adminEmail, setAdminEmail] = useState("Administrator");
  const [isLoggingOut, setIsLoggingOut] = useState(false);

  useEffect(() => {
    const loadEmail = async () => {
      if (isDemoMode) {
        setAdminEmail(DEMO_ADMIN_EMAIL);
        return;
      }
      try {
        const user = await getCurrentUser();
        setAdminEmail(user?.signInDetails?.loginId || "Administrator");
      } catch {
        setAdminEmail("Administrator");
      }
    };

    loadEmail();
  }, []);

  const handleLogout = async () => {
    try {
      setIsLoggingOut(true);
      if (!isDemoMode) {
        await AuthService.signOut();
      }
    } catch (error) {
      console.error("Logout error:", error);
    } finally {
      navigate("/admin/login");
      setIsLoggingOut(false);
    }
  };

  return (
    <div className="flex min-h-screen flex-col bg-muted">
      <header className="flex shrink-0 items-center justify-between gap-4 border-b border-foreground/10 bg-white px-7 py-4">
        <BrandMark subtitle="Admin console" to="/" />
        <div className="flex items-center gap-3.5">
          <div className="text-right">
            <div className="text-[13px] font-semibold">{adminEmail}</div>
            <div className="text-[11.5px] text-foreground/75">
              Signed in as administrator
            </div>
          </div>
          <button
            type="button"
            onClick={handleLogout}
            disabled={isLoggingOut}
            className="min-h-[38px] rounded-[9px] border-[1.5px] border-foreground/18 bg-white px-3.5 text-[13.5px] font-semibold text-destructive"
          >
            {isLoggingOut ? "Signing out…" : "Sign out"}
          </button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 items-stretch">
        <AdminSidebar activeView={activeView} onViewChange={setActiveView} />
        <main className="min-w-0 flex-1 overflow-y-auto px-4 py-7 pb-11 md:px-[30px]">
          <div className="mb-5 grid grid-cols-2 gap-2 md:hidden">
            {(
              [
                ["dashboard", "Overview"],
                ["analytics", "Analytics"],
                ["prompts", "Prompts"],
                ["system-settings", "Settings"],
                ["guideline", "Guides"],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => setActiveView(key)}
                aria-current={activeView === key ? "page" : undefined}
                className={`min-h-11 rounded-[10px] border px-3 text-sm font-semibold ${
                  activeView === key
                    ? "border-primary bg-[oklch(0.96_0.02_268)] text-primary"
                    : "border-foreground/12 bg-white"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          {activeView === "dashboard" && <DataSourceManagement />}
          {activeView === "analytics" && <Analytics />}
          {activeView === "prompts" && <PromptManagement />}
          {activeView === "system-settings" && <SystemSettings />}
          {activeView === "guideline" && <GuidelineMode />}
        </main>
      </div>
    </div>
  );
}
