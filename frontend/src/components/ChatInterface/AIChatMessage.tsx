import { useState } from "react";
import { ChevronDown, ChevronUp, BookOpen, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import rehypeSanitize from "rehype-sanitize";
import TypingIndicator from "./TypingIndicator";
import { displayGuideText, isSuggestionPhase } from "@/lib/guideMessage";

const isSafeUrl = (url: string) => {
  try {
    const parsed = new URL(url);
    return ["http:", "https:"].includes(parsed.protocol);
  } catch {
    return false;
  }
};

type SourceItem = {
  uri?: string;
  url?: string;
  title?: string;
  content?: string;
  type?: string;
  source_type?: string;
  score?: number;
  metadata?: Record<string, unknown>;
};

type AIChatMessageProps = {
  text: string;
  question?: string;
  sources?: SourceItem[] | string[];
  warning?: string | null;
  isTyping?: boolean;
  phase?: "DETECTIVE" | "SUGGESTION" | null;
};

const markdownComponents = {
  h1: ({ ...props }) => (
    <h1 className="mb-3 mt-5 text-lg font-bold first:mt-0" {...props} />
  ),
  h2: ({ ...props }) => (
    <h2 className="mb-2.5 mt-5 text-base font-bold first:mt-0" {...props} />
  ),
  h3: ({ ...props }) => (
    <h3 className="mb-2 mt-4 text-[15.5px] font-bold first:mt-0" {...props} />
  ),
  p: ({ ...props }) => <p className="mb-3.5 last:mb-0" {...props} />,
  ul: ({ ...props }) => (
    <ul className="mb-3.5 list-disc space-y-1.5 pl-5 last:mb-0" {...props} />
  ),
  ol: ({ ...props }) => (
    <ol className="mb-3.5 list-decimal space-y-1.5 pl-5 last:mb-0" {...props} />
  ),
  li: ({ ...props }) => <li className="leading-snug" {...props} />,
  strong: ({ ...props }) => (
    <strong className="font-semibold text-foreground" {...props} />
  ),
  em: ({ ...props }) => <em className="font-serif italic" {...props} />,
  a: ({ ...props }) => (
    <a
      {...props}
      href={props.href && isSafeUrl(props.href) ? props.href : "#"}
      target="_blank"
      rel="noopener noreferrer"
      className="font-semibold text-primary hover:underline"
    />
  ),
  blockquote: ({ ...props }) => (
    <blockquote
      className="my-3 rounded-[9px] bg-muted px-3.5 py-3 font-serif text-[15.5px] leading-relaxed"
      {...props}
    />
  ),
};

function GuideMarkdown({ text }: { text: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[rehypeSanitize, rehypeHighlight]}
      components={markdownComponents}
    >
      {text}
    </ReactMarkdown>
  );
}

function sourceLabel(source: SourceItem | string) {
  if (typeof source === "string") {
    const urlMatch = source.match(/(https?:\/\/[^\s]+)/);
    return {
      title: source.replace(urlMatch?.[0] ?? "", "").trim() || source,
      url: urlMatch?.[0] ?? "",
      type: "",
    };
  }
  const url = source.url || source.uri || "";
  const title = source.title || url || "Source";
  const type = (source.source_type || source.type || "").toLowerCase();
  return { title, url, type };
}

function isRenderableSource(source: SourceItem | string) {
  if (typeof source === "string") {
    return !source.includes("https://s3") && !source.includes("s3://");
  }
  const url = source.url || source.uri || "";
  return !url.includes("https://s3") && !url.includes("s3://");
}

export default function AIChatMessage({
  text,
  question,
  sources = [],
  warning = null,
  isTyping = false,
  phase = null,
}: AIChatMessageProps) {
  const [showSources, setShowSources] = useState(false);
  const body = displayGuideText(text);
  const suggestion = isSuggestionPhase(phase, sources, body);
  const renderableSources = sources.filter(isRenderableSource);

  const sourcesBlock =
    !isTyping && renderableSources.length > 0 ? (
      <div className={suggestion ? "mt-5" : "mt-5"}>
        <div className="text-[11px] font-bold uppercase tracking-[0.08em] text-foreground/70">
          Where this comes from
        </div>
        <div className="mt-2.5 flex flex-col gap-2">
          {showSources
            ? renderableSources.map((source, index) => {
                const { title, url, type } = sourceLabel(source);
                return (
                  <div
                    key={`${title}-${index}`}
                    className="rounded-[10px] border border-foreground/14 px-4 py-3"
                  >
                    <div className="flex items-start gap-2.5">
                      <span className="mt-0.5 shrink-0 rounded bg-muted px-1.5 py-px text-[11px] font-bold text-foreground/80">
                        {index + 1}
                      </span>
                      <div className="min-w-0">
                        {type ? (
                          <div className="text-[11px] font-bold uppercase tracking-[0.06em] text-foreground/70">
                            {type}
                          </div>
                        ) : null}
                        {url && isSafeUrl(url) ? (
                          <a
                            href={url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="mt-0.5 flex items-start gap-1.5 text-[14.5px] font-semibold leading-snug text-primary hover:underline"
                          >
                            <ExternalLink className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                            <span className="break-words">{title}</span>
                          </a>
                        ) : (
                          <div className="mt-0.5 flex items-start gap-1.5 text-[14.5px] font-semibold leading-snug">
                            <BookOpen className="mt-0.5 h-3.5 w-3.5 shrink-0 text-foreground/70" />
                            <span className="break-words">{title}</span>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })
            : null}
        </div>
        <Button
          variant="link"
          size="sm"
          className="mt-1 h-auto px-0 text-[13px] font-semibold text-primary"
          onClick={() => setShowSources(!showSources)}
        >
          <BookOpen className="h-3 w-3" />
          {showSources ? "Hide sources" : "Show sources"} (
          {renderableSources.length})
          {showSources ? (
            <ChevronUp className="h-3 w-3" />
          ) : (
            <ChevronDown className="h-3 w-3" />
          )}
        </Button>
      </div>
    ) : null;

  const warningBlock =
    !isTyping && warning ? (
      <div className="mt-4 rounded-[10px] bg-[oklch(0.97_0.015_268)] px-4 py-3.5 text-sm text-secondary-foreground">
        {warning}
      </div>
    ) : null;

  if (isTyping && !body) {
    return (
      <div className="flex justify-start">
        <div className="max-w-[94%] rounded-[12px] rounded-bl-[3px] bg-muted px-[17px] py-3.5">
          <TypingIndicator />
        </div>
      </div>
    );
  }

  const content = (
    <>
      {isTyping && !body ? (
        <TypingIndicator />
      ) : (
        <>
          <GuideMarkdown text={body} />
          {!isTyping && question ? (
            <p className="mt-3 font-semibold leading-relaxed">{question}</p>
          ) : null}
        </>
      )}
      {sourcesBlock}
      {warningBlock}
    </>
  );

  if (suggestion && !isTyping) {
    return (
      <div className="overflow-hidden rounded-[12px] border border-foreground/14">
        <div className="bg-primary px-[22px] py-3.5 text-[13.5px] font-semibold tracking-[0.01em] text-white">
          Where you are, and what to do next
        </div>
        <div className="px-[22px] py-[22px] text-[16.5px] leading-[1.65] text-pretty">
          {content}
        </div>
      </div>
    );
  }

  return (
    <div className="flex justify-start">
      <div className="max-w-[94%] rounded-[12px] rounded-bl-[3px] bg-muted px-[17px] py-3.5 text-base leading-[1.68] text-foreground text-pretty">
        {content}
      </div>
    </div>
  );
}
