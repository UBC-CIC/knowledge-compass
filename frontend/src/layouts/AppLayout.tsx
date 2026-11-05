import { Link, Outlet, useLocation } from "react-router";
import { SidebarProvider } from "@/providers/SidebarContext";
import { isDemoMode } from "@/lib/demo";

export default function AppLayout() {
  const { pathname } = useLocation();
  const isAdminRoute = pathname.startsWith("/admin");

  return (
    <SidebarProvider>
      <div
        className={
          isAdminRoute
            ? "flex min-h-screen flex-col bg-muted font-sans"
            : // dvh, not vh: on phones 100vh includes the area behind the browser
              // toolbar, which pushed the chat input below the visible screen.
              "flex h-dvh flex-col overflow-hidden bg-background font-sans"
        }
      >
        {isDemoMode ? (
          <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-b border-foreground/10 bg-secondary px-4 py-2 text-[12.5px]">
            <span className="font-semibold text-secondary-foreground">
              Local demo
            </span>
            <Link
              className="font-semibold text-primary underline-offset-2 hover:underline"
              to="/"
            >
              Conversation
            </Link>
            <Link
              className="font-semibold text-primary underline-offset-2 hover:underline"
              to="/admin/login"
            >
              Admin login
            </Link>
            <Link
              className="font-semibold text-primary underline-offset-2 hover:underline"
              to="/admin/dashboard"
            >
              Admin dashboard
            </Link>
            <span className="text-foreground/75">
              Typing and page clicks work here. Not connected to the live
              assistant.
            </span>
          </div>
        ) : null}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <Outlet />
        </div>
      </div>
    </SidebarProvider>
  );
}
