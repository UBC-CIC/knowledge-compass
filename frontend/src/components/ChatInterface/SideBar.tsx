import { useNavigate } from "react-router";
import { useSidebar } from "@/providers/sidebar";
import { useView } from "@/providers/view";
import { useUser } from "@/providers/user";
import BrandMark from "@/components/BrandMark";
import ChatSessionActionsMenu from "./ChatSessionActionsMenu";
import { cn } from "@/lib/utils";
import { useEffect, useState } from "react";
import { isDemoMode } from "@/lib/demo";
import { getPublicToken } from "@/lib/publicToken";
import { API_ENDPOINT } from "@/lib/api";

type UserProfile = {
  id: string;
  role?: string;
};

type SidebarContentProps = {
  setMobileOpen: (open: boolean) => void;
};

function formatSessionMeta(createdAt?: string) {
  if (!createdAt) return "Saved on this device";
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) return "Saved on this device";
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

function SidebarContent({ setMobileOpen }: SidebarContentProps) {
  const navigate = useNavigate();
  const { userId, isLoading: isLoadingUser } = useUser();
  const {
    chatSessions,
    activeChatSessionId,
    setActiveChatSessionId,
    removeChatSession,
    setCurrentMessages,
    setActiveChatName,
    setConversationFacts,
  } = useView();
  const [isAdmin, setIsAdmin] = useState(false);

  useEffect(() => {
    const loadRole = async () => {
      if (isDemoMode) {
        setIsAdmin(true);
        return;
      }
      if (isLoadingUser || !userId) {
        setIsAdmin(false);
        return;
      }

      try {
        const token = await getPublicToken();
        const response = await fetch(
          `${API_ENDPOINT}/user/${userId}`,
          {
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
            },
          }
        );
        if (!response.ok) return;
        const profile = (await response.json()) as UserProfile;
        setIsAdmin(profile.role === "admin");
      } catch {
        setIsAdmin(false);
      }
    };

    loadRole();
  }, [userId, isLoadingUser]);

  const handleNewChat = () => {
    setActiveChatSessionId(null);
    setCurrentMessages([]);
    setActiveChatName(null);
    setConversationFacts({});
    navigate("/");
    setMobileOpen(false);
  };

  const handleSelectSession = (sessionId: string) => {
    setActiveChatSessionId(sessionId);
    navigate(`/chat`);
    setMobileOpen(false);
  };

  return (
    <div className="flex h-full flex-col">
      <div className="px-[22px] pb-4 pt-5">
        <BrandMark to="/" />
      </div>

      <div className="px-[18px] pb-3.5">
        <button
          type="button"
          onClick={handleNewChat}
          className="flex min-h-11 w-full items-center justify-center rounded-[9px] border border-foreground/16 bg-white text-[13.5px] font-semibold text-foreground hover:border-primary"
        >
          Start a new conversation
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex items-baseline justify-between gap-2.5 px-[22px] pt-4">
          <div className="text-[11px] font-bold uppercase tracking-[0.08em] text-foreground/70">
            Earlier conversations
          </div>
        </div>
        <div className="flex flex-col gap-0.5 px-4 pb-1">
          {chatSessions.length === 0 ? (
            <p className="px-3 py-3 text-[12.5px] leading-relaxed text-foreground/70">
              No earlier conversations yet.
            </p>
          ) : (
            chatSessions.map((session, index) => {
              const title =
                session.name || `Chat ${chatSessions.length - index}`;
              const isActive = activeChatSessionId === session.id;
              return (
                <div
                  key={session.id}
                  className={cn(
                    "flex items-start gap-1 rounded-[9px]",
                    isActive ? "bg-white" : "hover:bg-white"
                  )}
                >
                  <button
                    type="button"
                    onClick={() => handleSelectSession(session.id)}
                    className="min-h-11 min-w-0 flex-1 rounded-[9px] px-3 py-2.5 text-left"
                  >
                    <div className="truncate text-[13.5px] font-semibold leading-snug text-foreground">
                      {title}
                    </div>
                    <div className="mt-0.5 text-xs text-foreground/75">
                      {formatSessionMeta(session.created_at)}
                    </div>
                  </button>
                  <div className="pr-1 pt-2">
                    <ChatSessionActionsMenu
                      chatSessionId={session.id}
                      chatSessionName={session.name || ""}
                      displayName={title}
                      userId={session.user_id}
                      isActive={isActive}
                      onDeleted={async () => {
                        removeChatSession(session.id);
                      }}
                    />
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      <div className="shrink-0 border-t border-foreground/10 px-[22px] py-4 text-[12.5px] leading-snug text-foreground/80">
        Nothing is sent to your school or school board.
        {isAdmin || isDemoMode ? (
          <button
            type="button"
            onClick={() => {
              navigate("/admin/dashboard");
              setMobileOpen(false);
            }}
            className="mt-3 block text-[12.5px] font-semibold text-primary"
          >
            Admin console
          </button>
        ) : null}
      </div>
    </div>
  );
}

export default function SideBar() {
  const { mobileOpen, setMobileOpen } = useSidebar();

  return (
    <>
      <aside className="hidden h-full w-[316px] shrink-0 flex-col border-r border-foreground/10 bg-muted md:flex">
        <SidebarContent setMobileOpen={setMobileOpen} />
      </aside>

      <div
        className={cn(
          "fixed inset-0 z-40 md:hidden",
          mobileOpen ? "visible" : "pointer-events-none invisible"
        )}
        inert={!mobileOpen ? true : undefined}
      >
        <div
          className={cn(
            "absolute inset-0 bg-black/40 transition-opacity",
            mobileOpen ? "opacity-100" : "opacity-0"
          )}
          onClick={() => setMobileOpen(false)}
        />
        <div
          className={cn(
            "absolute left-0 h-full w-[316px] transform bg-muted transition-transform",
            mobileOpen ? "translate-x-0" : "-translate-x-full"
          )}
        >
          <SidebarContent setMobileOpen={setMobileOpen} />
        </div>
      </div>
    </>
  );
}
