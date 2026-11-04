import { useState, useEffect } from "react";
import { ViewProvider } from "@/providers/ViewContext";
import SideBar from "@/components/ChatInterface/SideBar";
import type { ChatSession } from "@/providers/view";
import type { Message } from "@/types/Chat";
import { useUser } from "@/providers/user";
import { Menu, X } from "lucide-react";
import { useSidebar } from "@/providers/sidebar";
import AIChatPage from "@/pages/ChatInterface/ChatInterface";
import GuestStartError from "@/components/ChatInterface/GuestStartError";
import {
  DEMO_USER_ID,
  deleteDemoSessionState,
  isDemoMode,
  seedDemoHistory,
  setDemoSessionState,
} from "@/lib/demo";
import { getPublicToken as getUserToken } from "@/lib/publicToken";
import { API_ENDPOINT } from "@/lib/api";
import { SessionLimitError, sessionLimitError } from "@/lib/sessionLimit";

const DEFAULT_WELCOME_MESSAGE = "";
const DEFAULT_DISCLAIMER =
  "Knowledge Compass shares information from Inclusion Canada's reviewed guidance. It isn't legal advice, and it can make mistakes.";

export default function HomePage() {
  const { userId, isLoading: isLoadingUser, error: userError, retry } = useUser();
  const { mobileOpen, toggleMobile } = useSidebar();

  const [chatSessions, setChatSessions] = useState<ChatSession[]>(
    isDemoMode ? seedDemoHistory() : []
  );
  const [activeChatSessionId, setActiveChatSessionId] = useState<string | null>(
    null
  );
  const [currentMessages, setCurrentMessages] = useState<Message[]>([]);
  const [activeChatName, setActiveChatName] = useState<string | null>(null);
  const [isLoadingChatSessions, setIsLoadingChatSessions] = useState(!isDemoMode);
  const [welcomeMessage, setWelcomeMessage] = useState<string>(
    DEFAULT_WELCOME_MESSAGE
  );
  const [isLoadingWelcome, setIsLoadingWelcome] = useState(!isDemoMode);
  const [disclaimer, setDisclaimer] = useState<string>(DEFAULT_DISCLAIMER);
  const [isLoadingDisclaimer, setIsLoadingDisclaimer] = useState(!isDemoMode);
  const [conversationFacts, setConversationFacts] = useState<
    Record<string, string>
  >({});

  // Access token bound to this browser's user (see lib/publicToken).
  const getPublicToken = async () => ({ token: await getUserToken() });

// Shape returned by the chat session endpoints (title is the DB column name).
type ChatSessionRow = Omit<ChatSession, "name"> & {
	name?: unknown;
	title?: unknown;
};

const normalizeChatSession = (session: ChatSessionRow): ChatSession => ({
	id: session.id,
	name:
		typeof session.name === "string"
			? session.name
			: typeof session.title === "string"
				? session.title
				: "",
	user_id: session.user_id,
	context: session.context,
	created_at: session.created_at,
	metadata: session.metadata,
});

  const fetchSystemMessage = async (
    messageType: string,
    fallback: string,
    setter: (val: string) => void
  ) => {
    try {
      const { token } = await getPublicToken();

      const response = await fetch(
        `${API_ENDPOINT}/system_message/${messageType}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
        }
      );

      if (!response.ok) throw new Error(`Failed to fetch ${messageType}`);

      const data: { message?: string } = await response.json();
      setter(data.message?.trim() || fallback);
    } catch (err) {
      console.error(`Error fetching ${messageType}:`, err);
      setter(fallback);
    }
  };

  // Fetch chat sessions for the user
  const fetchChatSessions = async () => {
    if (isDemoMode) {
      setChatSessions(seedDemoHistory());
      setIsLoadingChatSessions(false);
      return;
    }

    if (!userId) {
      setIsLoadingChatSessions(false);
      return;
    }

    setIsLoadingChatSessions(true);
    try {
      const { token } = await getPublicToken();

      const response = await fetch(
        `${API_ENDPOINT}/chat_sessions/user/${userId}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
        }
      );

      if (!response.ok) {
        throw new Error("Failed to fetch chat sessions");
      }

      const sessions: unknown = await response.json();
      setChatSessions(Array.isArray(sessions) ? sessions.map(normalizeChatSession) : []);
    } catch (err) {
      console.error("Error fetching chat sessions:", err);
    } finally {
    		setIsLoadingChatSessions(false);
    }
  };

  useEffect(() => {
    if (isLoadingUser) return;

    if (isDemoMode) {
      setChatSessions(seedDemoHistory());
      setIsLoadingChatSessions(false);
      setIsLoadingWelcome(false);
      setIsLoadingDisclaimer(false);
      return;
    }

    setIsLoadingWelcome(true);
    setIsLoadingDisclaimer(true);

    Promise.all([
      fetchSystemMessage("welcome_message", DEFAULT_WELCOME_MESSAGE, setWelcomeMessage),
      fetchSystemMessage("disclaimer", DEFAULT_DISCLAIMER, setDisclaimer),
    ]).finally(() => {
      setIsLoadingWelcome(false);
      setIsLoadingDisclaimer(false);
    });

    fetchChatSessions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, isLoadingUser]);

  // Create a new chat session
  const createNewChatSession = async (): Promise<ChatSession | null> => {
    if (isDemoMode) {
      const newSession: ChatSession = {
        id: `demo-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        name: "",
        user_id: userId || DEMO_USER_ID,
        created_at: new Date().toISOString(),
      };
      setDemoSessionState(newSession.id, {
        messages: [],
        facts: {},
        asked: 0,
        showGuidance: false,
      });
      setChatSessions((prev) => [newSession, ...prev]);
      setActiveChatSessionId(newSession.id);
      setConversationFacts({});
      return newSession;
    }

    if (!userId) return null;

    try {
      const { token } = await getPublicToken();

      const createResponse = await fetch(
        `${API_ENDPOINT}/chat_sessions`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            user_sessions_session_id: userId,
          }),
        }
      );

      if (!createResponse.ok) {
        const limitError = await sessionLimitError(createResponse);
        if (limitError) throw limitError;
        throw new Error("Failed to create chat session");
      }

      const newSession = normalizeChatSession(await createResponse.json());

      // Add to the list and set as active
      setChatSessions((prev) => [newSession, ...prev]);
      setActiveChatSessionId(newSession.id);

      return newSession;
    } catch (err) {
      // The caller shows the daily session limit to the user.
      if (err instanceof SessionLimitError) throw err;
      console.error("Error creating chat session:", err);
      return null;
    }
  };

  const refreshChatSessions = async () => {
    await fetchChatSessions();
  };

  // Update chat session name locally
  const updateChatSessionName = (sessionId: string, name: string) => {
    setChatSessions((prev) =>
      prev.map((session) =>
        session.id === sessionId ? { ...session, name } : session
      )
    );
  };

  const removeChatSession = (sessionId: string) => {
    if (isDemoMode) {
      deleteDemoSessionState(sessionId);
    }
    setChatSessions((prev) => prev.filter((session) => session.id !== sessionId));
    setActiveChatSessionId((current) => (current === sessionId ? null : current));
  };

  const renameChatSession = async (
    sessionId: string,
    name: string
  ): Promise<ChatSession | null> => {
    const trimmedName = name.trim();
    if (!trimmedName) return null;

    if (isDemoMode) {
      let updated: ChatSession | null = null;
      setChatSessions((prev) =>
        prev.map((session) => {
          if (session.id !== sessionId) return session;
          updated = { ...session, name: trimmedName };
          return updated;
        })
      );
      return updated;
    }

    if (!userId) return null;

    try {
      const { token } = await getPublicToken();

      const url = new URL(`${API_ENDPOINT}/chat_sessions/${sessionId}`);
      url.searchParams.set("user_id", userId);

      const response = await fetch(url.toString(), {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ title: trimmedName }),
      });

      if (!response.ok) {
        throw new Error("Failed to rename chat session");
      }

      const updatedSession = normalizeChatSession(await response.json());
      setChatSessions((prev) =>
        prev.map((session) =>
          session.id === sessionId ? { ...session, ...updatedSession } : session
        )
      );

      return updatedSession;
    } catch (err) {
      console.error("Error renaming chat session:", err);
      return null;
    }
  };

  if (isLoadingUser || isLoadingChatSessions) {
    return (
      <div className="flex h-full items-center justify-center bg-background">
        <div className="text-center">
          <div className="mx-auto mb-4 h-10 w-10 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          <p className="text-sm text-muted-foreground">Loading...</p>
        </div>
      </div>
    );
  }

  if (!isDemoMode && !userId && userError) {
    return <GuestStartError message={userError.message} onRetry={retry} />;
  }

  return (
    <ViewProvider
      value={{
        loading: false,
        error: null,
        chatSessions,
        activeChatSessionId,
        setActiveChatSessionId,
        isLoadingChatSessions,
        createNewChatSession,
        refreshChatSessions,
        updateChatSessionName,
        removeChatSession,
        renameChatSession,
        currentMessages,
        setCurrentMessages,
        activeChatName,
        setActiveChatName,
        conversationFacts,
        setConversationFacts,
      }}
    >
        <div className="flex h-full overflow-hidden bg-white">
          <SideBar />
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <div className="flex shrink-0 items-center gap-4 border-b border-foreground/10 px-4 py-2 md:px-[34px] md:py-4">
              <button
                type="button"
                onClick={toggleMobile}
                aria-label="Toggle menu"
                aria-expanded={mobileOpen}
                className="flex size-11 items-center justify-center rounded-[9px] border border-foreground/16 bg-white md:hidden"
              >
                {mobileOpen ? (
                  <X className="h-5 w-5" />
                ) : (
                  <Menu className="h-5 w-5" />
                )}
              </button>
            </div>

            <main className="flex min-h-0 flex-1 flex-col">
              <AIChatPage
                welcomeMessage={welcomeMessage}
                disclaimer={disclaimer}
                isLoadingWelcome={isLoadingWelcome || isLoadingDisclaimer}
              />
            </main>
          </div>
        </div>
    </ViewProvider>
  );
}
