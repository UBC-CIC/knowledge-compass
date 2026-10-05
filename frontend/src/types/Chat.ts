/** One retrieved source attached to an assistant message (citation). */
export type SourceItem = {
  uri?: string;
  url?: string;
  title?: string;
  content?: string;
  type?: string;
  source_type?: string;
  score?: number;
  metadata?: {
    chunk_start?: string;
    chunk_end?: string;
    [key: string]: unknown;
  };
};

/** Sources may arrive as structured objects or bare URL strings (legacy rows). */
export type MessageSource = SourceItem | string;

export interface Message {
  id: string;
  sender: 'user' | 'bot';
  text: string;
  sources_used?: MessageSource[];
  time: number;
  isTyping?: boolean;
  isGuidedQuestion?: boolean;
  guidedData?: {
    templateId: string;
    questionIndex: number;
    totalQuestions: number;
  };
  warning?: string | null;
  hasPII?: boolean;
  question?: string;
  chips?: string[];
  showGuidance?: boolean;
  phase?: "DETECTIVE" | "SUGGESTION" | null;
}
