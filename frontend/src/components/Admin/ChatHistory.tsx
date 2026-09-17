import { useState, useEffect, useRef } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import rehypeSanitize from "rehype-sanitize";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { MessageSquare, ChevronDown, ChevronRight, Clock, RefreshCw } from "lucide-react";
import { AuthService } from "@/functions/authService";
import { cn } from "@/lib/utils";
import {
  DEMO_ADMIN_MESSAGES,
  DEMO_ADMIN_SESSIONS,
  DEMO_ADMIN_USERS,
  isDemoMode,
} from "@/lib/demo";

const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

const clearAdminCache = () => {
    Object.keys(localStorage).forEach(key => {
        if (key.startsWith('admin_chat_')) {
            localStorage.removeItem(key);
        }
    });
};

const getCachedItem = (key: string) => {
    try {
        const item = localStorage.getItem(key);
        if (!item) return null;
        const parsed = JSON.parse(item);
        if (Date.now() - parsed.timestamp > CACHE_TTL) {
            localStorage.removeItem(key);
            return null;
        }
        return parsed.data;
    } catch (e) {
        return null;
    }
};

const setCachedItem = (key: string, data: any) => {
    try {
        localStorage.setItem(key, JSON.stringify({
            timestamp: Date.now(),
            data
        }));
    } catch (e) {
        // Handle quota exceeded
        console.warn('Local storage full, clearing admin cache');
        clearAdminCache();
        try {
            localStorage.setItem(key, JSON.stringify({
                timestamp: Date.now(),
                data
            }));
        } catch (e2) {
            console.error('Failed to cache item after clearing:', e2);
        }
    }
};
// --- Types ---
type UserData = {
    id: string;
    email: string;
    role: string;
    last_seen_at?: string;
};

type ChatSession = {
    id: string;
    user_id: string;
    title: string;
    created_at: string;
    last_active_at: string;
};

type ChatMessage = {
    id: string;
    chat_session_id: string;
    sender: "user" | "AI" | "system";
    content: string;
    created_at: string;
    sources?: any[];
};

export default function ChatHistory() {
    const [users, setUsers] = useState<UserData[]>([]);
    const [loadingUsers, setLoadingUsers] = useState(false);

    const [expandedUserIds, setExpandedUserIds] = useState<Set<string>>(new Set());
    const [userSessions, setUserSessions] = useState<Record<string, ChatSession[]>>({});
    const [loadingSessions, setLoadingSessions] = useState<Record<string, boolean>>({});

    const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
    const [messages, setMessages] = useState<ChatMessage[]>([]);
    const [loadingMessages, setLoadingMessages] = useState(false);
    // Tracks the most recently requested session so a slower, earlier fetch
    // (e.g. from a session the admin has since clicked away from) can't
    // overwrite what's currently displayed.
    const latestSessionIdRef = useRef<string | null>(null);

    // Initial load
    useEffect(() => {
        fetchUsers();
    }, []);

    const getAuthHeaders = async () => AuthService.getAdminAuthHeaders();

    const fetchUsers = async (forceRefresh = false) => {
        if (isDemoMode) {
            setUsers(DEMO_ADMIN_USERS);
            setLoadingUsers(false);
            return;
        }
        if (!forceRefresh) {
            const cached = getCachedItem('admin_chat_users');
            if (cached) {
                setUsers(cached);
                return;
            }
        }

        try {
            setLoadingUsers(true);
            const headers = await getAuthHeaders();

            const res = await fetch(
                `${import.meta.env.VITE_API_ENDPOINT}/admin/users?limit=100&offset=0`,
                { headers }
            );
            if (!res.ok) throw new Error("Failed to fetch users");

            const data = await res.json();
            const usersData = Array.isArray(data) ? data : [];
            setUsers(usersData);
            setCachedItem('admin_chat_users', usersData);
        } catch (e) {
            console.error(e);
        } finally {
            setLoadingUsers(false);
        }
    };

    const fetchSessionsForUser = async (userId: string, forceRefresh = false) => {
        if (isDemoMode) {
            setUserSessions((prev) => ({
                ...prev,
                [userId]: DEMO_ADMIN_SESSIONS[userId] ?? [],
            }));
            return;
        }
        const cacheKey = `admin_chat_sessions_${userId}`;
        if (!forceRefresh) {
            const cached = getCachedItem(cacheKey);
            if (cached) {
                setUserSessions(prev => ({ ...prev, [userId]: cached }));
                return;
            }
        }

        try {
            setLoadingSessions(prev => ({ ...prev, [userId]: true }));
            const headers = await getAuthHeaders();

            const res = await fetch(
                `${import.meta.env.VITE_API_ENDPOINT}/admin/users/${userId}/chat_sessions?limit=50&offset=0`,
                { headers }
            );
            if (!res.ok) throw new Error("Failed to fetch sessions");

            const data = await res.json();
            const sessionsData = Array.isArray(data) ? data : [];
            setUserSessions(prev => ({ ...prev, [userId]: sessionsData }));
            setCachedItem(cacheKey, sessionsData);
        } catch (e) {
            console.error(e);
        } finally {
            setLoadingSessions(prev => ({ ...prev, [userId]: false }));
        }
    };

    const fetchMessagesForSession = async (sessionId: string, forceRefresh = false) => {
        if (isDemoMode) {
            setMessages(DEMO_ADMIN_MESSAGES[sessionId] ?? []);
            setLoadingMessages(false);
            return;
        }
        const cacheKey = `admin_chat_messages_${sessionId}`;
        if (!forceRefresh) {
            const cached = getCachedItem(cacheKey);
            if (cached) {
                if (latestSessionIdRef.current === sessionId) setMessages(cached);
                return;
            }
        }

        try {
            setLoadingMessages(true);
            const headers = await getAuthHeaders();

            const res = await fetch(
                `${import.meta.env.VITE_API_ENDPOINT}/admin/chat_sessions/${sessionId}/messages?limit=200&offset=0`,
                { headers }
            );
            if (!res.ok) throw new Error("Failed to fetch messages");

            const data = await res.json();
            const messagesData = Array.isArray(data) ? data : [];
            setCachedItem(cacheKey, messagesData);
            if (latestSessionIdRef.current !== sessionId) return;
            setMessages(messagesData);
        } catch (e) {
            console.error(e);
        } finally {
            if (latestSessionIdRef.current === sessionId) setLoadingMessages(false);
        }
    };

    const toggleUserExpanded = (userId: string) => {
        setExpandedUserIds(prev => {
            const next = new Set(prev);
            if (next.has(userId)) {
                next.delete(userId);
            } else {
                next.add(userId);
                fetchSessionsForUser(userId);
            }
            return next;
        });
    };

    const handleSessionSelect = (sessionId: string) => {
        latestSessionIdRef.current = sessionId;
        setSelectedSessionId(sessionId);
        setMessages([]); // prevent old messages from showing
        fetchMessagesForSession(sessionId);
    };

    const formatDate = (dateString?: string) => {
        if (!dateString) return "";
        return new Date(dateString).toLocaleString([], {
            month: 'short', day: 'numeric',
            hour: '2-digit', minute: '2-digit'
        });
    };

    const formatSource = (source: any) => {
        const uri = source?.uri || source?.url || source;
        const type = source?.type || (uri.includes('s3') ? 'S3' : 'WEB');
        const content = source?.content || "No content extracted";

        return (
            <div className="flex flex-col gap-1 w-full text-left">
                <div className="flex items-center gap-1.5 break-all text-[11px] font-medium text-primary">
                    <span className="bg-gray-200 text-gray-700 px-1 py-0.5 rounded text-[9px] font-bold">{type}</span>
                    <a href={uri} target="_blank" rel="noopener noreferrer" className="hover:underline" title={uri}>{uri}</a>
                </div>
                <div className="text-[11px] text-gray-500 italic pl-2 border-l-2 border-gray-200">
                    "{content}"
                </div>
            </div>
        );
    };

    const handleRefresh = () => {
        clearAdminCache();
        latestSessionIdRef.current = null;
        setExpandedUserIds(new Set());
        setSelectedSessionId(null);
        setUserSessions({});
        setMessages([]);
        fetchUsers(true);
    };

    return (
        <div className="mx-auto flex h-[calc(100vh-8rem)] max-w-[1160px] flex-col space-y-[22px] animate-in fade-in duration-500">
            <div className="flex-shrink-0 flex items-center justify-between gap-4">
                <div>
                    <h1 className="font-serif text-[30px] font-semibold leading-tight tracking-[-0.015em]">
                        Conversation review
                    </h1>
                    <p className="mt-2 text-[15.5px] leading-relaxed text-foreground/80">
                        Read transcripts to check the assistant's answers. Access is logged.
                    </p>
                </div>
                <button
                    onClick={handleRefresh}
                    className="flex items-center gap-2 px-4 py-2 bg-white border border-gray-200 rounded-lg text-sm font-medium text-gray-600 hover:bg-gray-50 hover:text-gray-900 transition-colors shadow-sm"
                >
                    <RefreshCw size={16} className={loadingUsers ? "animate-spin text-primary" : ""} />
                    Refresh Data
                </button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-6 flex-1 min-h-0">

                {/* Left Column: Users & Chat Sessions */}
                <Card className="md:col-span-1 flex h-full flex-col overflow-hidden rounded-[13px] border-foreground/12 shadow-sm">
                    <CardHeader className="flex-shrink-0 border-b border-foreground/10 pb-4">
                        <CardTitle className="text-base font-bold">
                            Users
                        </CardTitle>
                        <CardDescription className="text-[12.5px]">
                            Open a user to see their conversations.
                        </CardDescription>
                    </CardHeader>
                    <CardContent className="flex-1 overflow-y-auto p-0">
                        {loadingUsers ? (
                            <div className="text-center text-gray-500 py-10">Loading users...</div>
                        ) : users.length === 0 ? (
                            <div className="text-center text-gray-500 py-10">No users found.</div>
                        ) : (
                            <div className="p-3 space-y-2">
                                {users.map((user, index) => (
                                    <div key={user.id} className="w-full bg-white border border-gray-100 rounded-xl overflow-hidden shadow-sm transition-all hover:shadow-md">
                                        {/* User Header */}
                                        <button
                                            onClick={() => toggleUserExpanded(user.id)}
                                            className="w-full flex items-center justify-between p-5 hover:bg-gray-50 transition-colors text-left"
                                        >
                                            <div>
                                                <div className="font-semibold text-base text-gray-900">
                                                    {user.email || `User ${index + 1}`}
                                                </div>
                                            </div>
                                            <div className="text-gray-400">
                                                {expandedUserIds.has(user.id) ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
                                            </div>
                                        </button>

                                        {/* Sessions List */}
                                        {expandedUserIds.has(user.id) && (
                                            <div className="bg-gray-50/70 border-t border-gray-100 p-3 space-y-2">
                                                {loadingSessions[user.id] ? (
                                                    <div className="text-xs text-center text-gray-500 py-2">Loading sessions...</div>
                                                ) : !userSessions[user.id] || userSessions[user.id].length === 0 ? (
                                                    <div className="text-xs text-center text-gray-400 py-2">No sessions found.</div>
                                                ) : (
                                                    userSessions[user.id].map((session, sessionIndex) => (
                                                        <button
                                                            key={session.id}
                                                            onClick={() => handleSessionSelect(session.id)}
                                                            className={cn(
                                                                "w-full text-left p-4 rounded-xl transition-all border",
                                                                selectedSessionId === session.id
                                                                    ? "bg-white border-primary shadow-md ring-1 ring-primary/20"
                                                                    : "bg-white border-gray-200 shadow-sm hover:border-primary/50 hover:shadow-md"
                                                            )}
                                                        >
                                                            <div className="flex items-center gap-3 mb-1.5">
                                                                <MessageSquare size={16} className={selectedSessionId === session.id ? "text-primary" : "text-gray-400"} />
                                                                <span className={cn(
                                                                    "text-sm font-semibold truncate",
                                                                    selectedSessionId === session.id ? "text-primary" : "text-gray-700"
                                                                )}>
                                                                    {session.title || `Chat ${sessionIndex + 1}`}
                                                                </span>
                                                            </div>
                                                            <div className="flex items-center gap-1 text-[10px] text-gray-500 pl-5">
                                                                <Clock size={10} />
                                                                {formatDate(session.created_at)}
                                                            </div>
                                                        </button>
                                                    ))
                                                )}
                                            </div>
                                        )}
                                    </div>
                                ))}
                            </div>
                        )}
                    </CardContent>
                </Card>

                {/* Right Column: Conversation Viewer */}
                <Card className="md:col-span-2 flex h-full flex-col overflow-hidden rounded-[13px] border-foreground/12 shadow-sm">
                    <CardHeader className="flex-shrink-0 border-b border-foreground/10 pb-4">
                        <CardTitle className="text-base font-bold">
                            Conversation
                        </CardTitle>
                        <CardDescription className="text-[12.5px]">
                            {selectedSessionId ? "Transcript of selected session." : "Pick a user on the left, then one of their conversations."}
                        </CardDescription>
                    </CardHeader>

                    <CardContent className="flex-1 overflow-y-auto p-6 md:p-8 bg-white relative">
                        {!selectedSessionId ? (
                            <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
                                <div className="text-base font-semibold text-foreground">No conversation selected</div>
                                <p className="max-w-[340px] text-[13.5px] leading-relaxed text-foreground/80">
                                    Pick a user on the left, then one of their conversations.
                                </p>
                            </div>
                        ) : loadingMessages ? (
                            <div className="flex h-full items-center justify-center">
                                <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-primary" />
                            </div>
                        ) : messages.length === 0 ? (
                            <div className="flex h-full items-center justify-center text-gray-400">
                                <p className="text-lg">This session has no messages yet.</p>
                            </div>
                        ) : (
                            <div className="space-y-6">
                                {messages.map((msg, idx) => {
                                    const isUser = msg.sender.toLowerCase() === "user";
                                    return (
                                        <div
                                            key={msg.id || idx}
                                            className={cn("flex flex-col max-w-[85%]", isUser ? "ml-auto" : "mr-auto")}
                                        >
                                            <div className={cn(
                                                "flex items-center gap-2 mb-1 text-xs",
                                                isUser ? "justify-end text-gray-500" : "text-gray-500"
                                            )}>
                                                <span className="font-semibold">{isUser ? "User" : "Assistant"}</span>
                                                <span className="text-xs opacity-75">{formatDate(msg.created_at)}</span>
                                            </div>

                                            <div className={cn(
                                                "p-5 rounded-[13px] text-[14.5px] leading-relaxed",
                                                isUser
                                                    ? "bg-primary text-primary-foreground rounded-tr-[4px]"
                                                    : "bg-muted border border-foreground/10 text-foreground rounded-tl-[4px]"
                                            )}>
                                                {isUser ? (
                                                    <span className="whitespace-pre-wrap">{msg.content}</span>
                                                ) : (
                                                    <ReactMarkdown
                                                        remarkPlugins={[remarkGfm]}
                                                        rehypePlugins={[rehypeSanitize, rehypeHighlight]}
                                                        components={{
                                                            h1: ({ ...props }) => <h1 className="text-xl font-bold mb-4 mt-6" {...props} />,
                                                            h2: ({ ...props }) => <h2 className="text-lg font-bold mb-3 mt-5" {...props} />,
                                                            h3: ({ ...props }) => <h3 className="text-base font-bold mb-2 mt-4" {...props} />,
                                                            p: ({ ...props }) => <p className="mb-4 last:mb-0" {...props} />,
                                                            ul: ({ ...props }) => <ul className="list-disc pl-5 mb-4" {...props} />,
                                                            ol: ({ ...props }) => <ol className="list-decimal pl-5 mb-4" {...props} />,
                                                            li: ({ ...props }) => <li className="mb-1" {...props} />,
                                                            a: ({ ...props }) => (
                                                                <a {...props} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline" />
                                                            ),
                                                            code: ({ className, children, ...props }: any) => {
                                                                const isInline = !(/language-(\w+)/.exec(className || "")) && props.inline;
                                                                return isInline ? (
                                                                    <code className="px-1 py-0.5 bg-muted rounded text-xs" {...props}>{children}</code>
                                                                ) : (
                                                                    <code className="block p-2 bg-muted rounded-md text-xs overflow-auto" {...props}>{children}</code>
                                                                );
                                                            },
                                                            pre: ({ ...props }) => <pre className="bg-muted p-2 rounded-md overflow-auto text-xs my-2" {...props} />,
                                                            blockquote: ({ ...props }) => <blockquote className="pl-4 border-l-4 border-muted italic my-4" {...props} />,
                                                            table: ({ ...props }) => (
                                                                <div className="overflow-x-auto">
                                                                    <table className="border-collapse border border-muted text-xs w-full my-4" {...props} />
                                                                </div>
                                                            ),
                                                            th: ({ ...props }) => <th className="border border-muted px-2 py-1 bg-muted" {...props} />,
                                                            td: ({ ...props }) => <td className="border border-muted px-2 py-1" {...props} />,
                                                        }}
                                                    >
                                                        {msg.content}
                                                    </ReactMarkdown>
                                                )}
                                            </div>

                                            {/* Display Sources (if AI and sources exist) */}
                                            {msg.sender === "AI" && msg.sources && msg.sources.length > 0 && (
                                                <div className="mt-2 w-full">
                                                    <details className="w-full group">
                                                        <summary className="cursor-pointer text-xs text-blue-600 hover:text-blue-800 font-medium select-none flex items-center gap-1">
                                                            <ChevronRight size={14} className="group-open:rotate-90 transition-transform" />
                                                            View Sources ({msg.sources.length})
                                                        </summary>
                                                        <div className="mt-2 space-y-2 pl-4 border-l-2 border-blue-100">
                                                            {msg.sources.map((source, sIdx) => (
                                                                <div key={sIdx} className="bg-gray-50 p-2 rounded border border-gray-100">
                                                                    {formatSource(source)}
                                                                </div>
                                                            ))}
                                                        </div>
                                                    </details>
                                                </div>
                                            )}
                                        </div>
                                    );
                                })}
                            </div>
                        )}
                    </CardContent>
                </Card>
            </div>
        </div>
    );
}