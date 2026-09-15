import type { Message } from "@/types/Chat";
import type { ChatSession } from "@/providers/view";

export const isDemoMode = import.meta.env.VITE_DEMO_MODE === "true";

export const DEMO_USER_ID = "demo-user";
export const DEMO_ADMIN_EMAIL = "demo@inclusioncanada.ca";

export type DemoFacts = {
  situation?: string;
  duration?: string;
  reason?: string;
  tried?: string;
  need?: string;
};

export type DemoSessionState = {
  messages: Message[];
  facts: DemoFacts;
  asked: number;
  showGuidance: boolean;
};

export const DETECTIVE_SCRIPT = [
  {
    key: "duration" as const,
    label: "How long",
    ack: "I'm sorry you're dealing with this — being sent home early is really disruptive for your family, and it sounds like the school hasn't given you a clear explanation of what's happening.",
    question:
      "Has this been happening since the start of the school year, or did it just begin recently?",
    chips: ["Since September", "It started a few weeks ago", "It comes and goes"],
  },
  {
    key: "reason" as const,
    label: "School's reason",
    ack: "Thank you for telling me that. That's long enough that it needs to change — and you can absolutely take steps here.",
    question:
      "When the school says they can't support him all day, have they explained what specifically is difficult, or has it been vague?",
    chips: ["They said staffing", "They said behaviour", "It's been vague"],
  },
  {
    key: "tried" as const,
    label: "What you've tried",
    ack: "That's important to know — and it matters that none of it is in writing yet, because a clear record is what moves things forward.",
    question:
      "Have you been able to raise this with the school yet — a call, an email, or a meeting?",
    chips: ["Nothing yet", "I emailed the principal", "We've had one meeting"],
  },
  {
    key: "need" as const,
    label: "What you need most",
    ack: "Thank you — that gives me a clear picture of where things stand.",
    question: "What would help you most right now?",
    chips: [
      "Understanding what's happening",
      "Getting it in writing",
      "Preparing for a meeting",
      "Knowing how to escalate",
    ],
  },
];

export const DEMO_CHECKLIST = [
  { key: "situation" as const, label: "What's happening" },
  { key: "duration" as const, label: "How long" },
  { key: "reason" as const, label: "School's reason" },
  { key: "tried" as const, label: "What you've tried" },
];

const demoSessionStore = new Map<string, DemoSessionState>();

export function getDemoSessionState(id: string): DemoSessionState | undefined {
  return demoSessionStore.get(id);
}

export function setDemoSessionState(id: string, state: DemoSessionState) {
  demoSessionStore.set(id, state);
}

export function deleteDemoSessionState(id: string) {
  demoSessionStore.delete(id);
}

export function applyDemoFact(
  facts: DemoFacts,
  asked: number,
  text: string
): DemoFacts {
  const next = { ...facts };
  if (asked === 0) {
    next.situation = text;
    return next;
  }
  const step = DETECTIVE_SCRIPT[asked - 1];
  if (step) {
    next[step.key] = text;
  }
  return next;
}

export function nextDemoReply(asked: number): {
  text: string;
  question?: string;
  chips: string[];
  asked: number;
  showGuidance: boolean;
  phase: "DETECTIVE" | "SUGGESTION";
} {
  const step = DETECTIVE_SCRIPT[asked];
  if (step) {
    return {
      text: step.ack,
      question: step.question,
      chips: step.chips,
      asked: asked + 1,
      showGuidance: false,
      phase: "DETECTIVE" as const,
    };
  }
  return {
    text: "Thank you — I have enough to help. Here's where I think things stand and what I'd do next.",
    question: undefined,
    chips: [],
    asked: asked + 1,
    showGuidance: true,
    phase: "SUGGESTION" as const,
  };
}

function demoMessage(
  sender: Message["sender"],
  text: string,
  extra: Partial<Message> = {}
): Message {
  return {
    id: `demo-msg-${Math.random().toString(36).slice(2, 9)}`,
    sender,
    text,
    time: Date.now(),
    ...extra,
  };
}

export const DEMO_HISTORY: Array<{
  session: ChatSession;
  state: DemoSessionState;
}> = [
  {
    session: {
      id: "demo-history-sent-home",
      name: "Sent home before lunch most days",
      user_id: DEMO_USER_ID,
      created_at: "2026-09-02T14:00:00.000Z",
    },
    state: {
      asked: 5,
      showGuidance: true,
      facts: {
        situation: "Sent home before lunch most days",
        duration: "Since September",
        reason: "They said staffing",
        tried: "I emailed the principal",
        need: "Getting it in writing",
      },
      messages: [
        demoMessage("user", "My son keeps getting sent home before lunch"),
        demoMessage(
          "bot",
          "Welcome back. We'd got as far as your follow-up email to the principal — here's the plan again.",
          { showGuidance: true }
        ),
      ],
    },
  },
  {
    session: {
      id: "demo-history-field-trip",
      name: "Left out of the grade 6 field trip",
      user_id: DEMO_USER_ID,
      created_at: "2026-08-14T14:00:00.000Z",
    },
    state: {
      asked: 5,
      showGuidance: true,
      facts: {
        situation: "Left out of the grade 6 field trip",
        duration: "It comes and goes",
        reason: "It's been vague",
        tried: "We've had one meeting",
        need: "Preparing for a meeting",
      },
      messages: [
        demoMessage("user", "My child was left out of the grade 6 field trip"),
        demoMessage(
          "bot",
          "Picking up where we left off — you had a meeting booked and wanted wording to use.",
          { showGuidance: true }
        ),
      ],
    },
  },
];

export function seedDemoHistory() {
  for (const item of DEMO_HISTORY) {
    if (!demoSessionStore.has(item.session.id)) {
      demoSessionStore.set(item.session.id, item.state);
    }
  }
  return DEMO_HISTORY.map((item) => item.session);
}

export const DEMO_ANALYTICS_SERIES = [
  { date: "Jul 6", users: 4, chat_sessions: 6, questions: 18 },
  { date: "Jul 20", users: 7, chat_sessions: 11, questions: 29 },
  { date: "Aug 3", users: 11, chat_sessions: 16, questions: 41 },
  { date: "Aug 17", users: 14, chat_sessions: 21, questions: 54 },
  { date: "Aug 31", users: 19, chat_sessions: 28, questions: 71 },
  { date: "Sep 14", users: 24, chat_sessions: 36, questions: 88 },
];

export const DEMO_OVERVIEW_TOTALS = {
  users: 86,
  chat_sessions: 124,
  messages: 612,
  questions: 398,
};

export const DEMO_DATA_SOURCES = [
  {
    id: "demo-ds-1",
    name: "When your Child is Excluded",
    type: "website" as const,
    created_at: "2026-08-12T00:00:00.000Z",
    metadata: {},
  },
  {
    id: "demo-ds-2",
    name: "Inclusive Education Policy: Parents Called to Support",
    type: "markdown" as const,
    created_at: "2026-07-22T00:00:00.000Z",
    metadata: {},
  },
];

export const DEMO_INGESTION_RUNS = [
  {
    id: "demo-run-1",
    data_source_id: "demo-ds-1",
    status: "completed" as const,
    created_at: "2026-09-10T00:00:00.000Z",
    completed_at: "2026-09-10T00:12:00.000Z",
  },
  {
    id: "demo-run-2",
    data_source_id: "demo-ds-2",
    status: "completed" as const,
    created_at: "2026-09-08T00:00:00.000Z",
    completed_at: "2026-09-08T00:08:00.000Z",
  },
];

export const DEMO_ADMIN_USERS = [
  {
    id: "demo-family-1",
    email: "anonymous family",
    role: "student",
    last_seen_at: "2026-09-12T16:00:00.000Z",
  },
  {
    id: "demo-family-2",
    email: "anonymous family",
    role: "student",
    last_seen_at: "2026-08-14T16:00:00.000Z",
  },
];

export const DEMO_ADMIN_SESSIONS: Record<
  string,
  Array<{
    id: string;
    user_id: string;
    title: string;
    created_at: string;
    last_active_at: string;
  }>
> = {
  "demo-family-1": [
    {
      id: "demo-history-sent-home",
      user_id: "demo-family-1",
      title: "Sent home before lunch most days",
      created_at: "2026-09-02T14:00:00.000Z",
      last_active_at: "2026-09-12T16:00:00.000Z",
    },
  ],
  "demo-family-2": [
    {
      id: "demo-history-field-trip",
      user_id: "demo-family-2",
      title: "Left out of the grade 6 field trip",
      created_at: "2026-08-14T14:00:00.000Z",
      last_active_at: "2026-08-14T16:00:00.000Z",
    },
  ],
};

export const DEMO_ADMIN_MESSAGES: Record<
  string,
  Array<{
    id: string;
    chat_session_id: string;
    sender: "user" | "AI";
    content: string;
    created_at: string;
  }>
> = {
  "demo-history-sent-home": [
    {
      id: "m1",
      chat_session_id: "demo-history-sent-home",
      sender: "user",
      content: "My son keeps getting sent home before lunch",
      created_at: "2026-09-02T14:01:00.000Z",
    },
    {
      id: "m2",
      chat_session_id: "demo-history-sent-home",
      sender: "AI",
      content:
        "I'm sorry you're dealing with this. Has this been happening since the start of the school year?",
      created_at: "2026-09-02T14:01:20.000Z",
    },
  ],
  "demo-history-field-trip": [
    {
      id: "m3",
      chat_session_id: "demo-history-field-trip",
      sender: "user",
      content: "My child was left out of the grade 6 field trip",
      created_at: "2026-08-14T14:01:00.000Z",
    },
    {
      id: "m4",
      chat_session_id: "demo-history-field-trip",
      sender: "AI",
      content:
        "Picking up where we left off — you had a meeting booked and wanted wording to use.",
      created_at: "2026-08-14T14:01:20.000Z",
    },
  ],
};
