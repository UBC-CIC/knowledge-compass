import type { ComponentProps, ReactNode } from "react";
import { ExternalLink } from "lucide-react";
import ReactMarkdown, { type ExtraProps } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import rehypeSanitize from "rehype-sanitize";
import TypingIndicator from "./TypingIndicator";
import { displayGuideText, isSuggestionPhase } from "@/lib/guideMessage";
import type { MessageSource, SourceItem } from "@/types/Chat";

const isSafeUrl = (url: string) => {
  try {
    const parsed = new URL(url);
    return ["http:", "https:"].includes(parsed.protocol);
  } catch {
    return false;
  }
};

const PREVIEW_MAX_CHARS = 320;

function truncatePreview(text: string) {
  const clean = text.trim();
  if (clean.length <= PREVIEW_MAX_CHARS) return clean;
  return `${clean.slice(0, PREVIEW_MAX_CHARS).trimEnd()}…`;
}

function getVideoTimestamp(source: SourceItem | string) {
  if (typeof source === "string") return null;
  const isVideo = (source.source_type || source.type || "").toLowerCase() === "video";
  const { chunk_start, chunk_end } = source.metadata || {};
  if (!isVideo || !chunk_start || !chunk_end) return null;
  return { start: chunk_start, end: chunk_end };
}

function timestampToSeconds(ts: string): number | null {
  const match = ts.match(/^(\d+):(\d{2}):(\d{2})(?:\.\d+)?$/);
  if (!match) return null;
  const [, h, m, s] = match;
  return Number(h) * 3600 + Number(m) * 60 + Number(s);
}

function withStartTime(url: string, start: string) {
  const seconds = timestampToSeconds(start);
  if (seconds === null) return url;
  try {
    const parsed = new URL(url);
    const isYouTube =
      parsed.hostname.includes("youtube.com") || parsed.hostname.includes("youtu.be");
    if (!isYouTube) return url;
    parsed.searchParams.set("t", `${seconds}s`);
    return parsed.toString();
  } catch {
    return url;
  }
}

type AIChatMessageProps = {
  text: string;
  question?: string;
  sources?: MessageSource[];
  warning?: string | null;
  isTyping?: boolean;
  phase?: "DETECTIVE" | "SUGGESTION" | null;
  /** Rendered inside the message, below its content (e.g. feedback controls). */
  footer?: ReactNode;
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
  a: ({ href, children, ...props }: ComponentProps<"a"> & ExtraProps) =>
    href && isSafeUrl(href) ? (
      <a
        {...props}
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="font-semibold text-primary hover:underline"
      >
        {children}
      </a>
    ) : (
      // Non-web links (e.g. internal upload:// identities in older replies)
      // aren't clickable; the source is listed under "More resources" instead.
      <span className="font-semibold">{children}</span>
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
      preview: "",
    };
  }
  const url = source.url || source.uri || "";
  const title = source.title || url || "Source";
  const type = (source.source_type || source.type || "").toLowerCase();
  const preview = source.content ? truncatePreview(source.content) : "";
  return { title, url, type, preview };
}

function isHttpSource(source: SourceItem | string) {
  const { url } = sourceLabel(source);
  return isSafeUrl(url);
}

// Uploaded documents and CSV row resources still get cards without public
// URLs. Guideline-mode guide sections are never shown: the server already
// drops them, and this is a fallback in case one ever arrives.
function isResourceSource(source: SourceItem | string) {
  const type = sourceLabel(source).type;
  if (type === "guideline") return false;
  return isHttpSource(source) || type === "document" || type === "csv_row";
}

export default function AIChatMessage({
  text,
  question,
  sources = [],
  warning = null,
  isTyping = false,
  phase = null,
  footer = null,
}: AIChatMessageProps) {
  const showFooter = Boolean(footer) && !isTyping;
  const body = displayGuideText(text);
  const suggestion = isSuggestionPhase(phase, sources, body);
  // Cited sources are listed once, as cards under "More resources" below.
  const resourceSources = sources.filter(isResourceSource);

  const sourcesBlock =
    !isTyping && resourceSources.length > 0 ? (
      <div className="mt-5">
        <div className="text-[11px] font-bold uppercase tracking-[0.08em] text-foreground/70">
          More resources
        </div>
        <div className="mt-2.5 flex flex-col gap-2">
          {resourceSources.map((source, index) => {
            const { title, url, type, preview } = sourceLabel(source);
            const timestamp = getVideoTimestamp(source);
            const href = timestamp ? withStartTime(url, timestamp.start) : url;
            const linkable = isSafeUrl(href);
            const cardClass =
              "flex items-start gap-2.5 rounded-[10px] border border-foreground/14 px-4 py-3";
            const cardBody = (
              <>
                <span className="mt-0.5 shrink-0 rounded bg-muted px-1.5 py-px text-[11px] font-bold text-foreground/80">
                  {index + 1}
                </span>
                <span className="min-w-0">
                  {type ? (
                    <span className="block text-[11px] font-bold uppercase tracking-[0.06em] text-foreground/70">
                      {type}
                    </span>
                  ) : null}
                  {linkable ? (
                    <span className="mt-0.5 flex items-start gap-1.5 text-[14.5px] font-semibold leading-snug text-primary">
                      <ExternalLink className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                      <span className="break-words">{title}</span>
                    </span>
                  ) : (
                    <span className="mt-0.5 block break-words text-[14.5px] font-semibold leading-snug text-foreground">
                      {title}
                    </span>
                  )}
                  {timestamp ? (
                    <span className="mt-1 block font-mono text-[12px] font-semibold text-foreground/70">
                      [{timestamp.start} - {timestamp.end}]
                    </span>
                  ) : null}
                  {preview ? (
                    <span className="mt-1 block whitespace-pre-line break-words text-[13px] font-normal leading-snug text-foreground/80">
                      {timestamp ? "Preview: " : ""}
                      {preview}
                    </span>
                  ) : null}
                </span>
              </>
            );
            return linkable ? (
              <a
                key={`${url}-${index}`}
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                className={`${cardClass} hover:border-primary hover:bg-accent`}
              >
                {cardBody}
              </a>
            ) : (
              <div key={`${url}-${index}`} className={cardClass}>
                {cardBody}
              </div>
            );
          })}
        </div>
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
        {showFooter ? (
          <div className="border-t border-foreground/10 px-[22px] py-1.5">
            {footer}
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex justify-start">
      <div className="max-w-[94%] rounded-[12px] rounded-bl-[3px] bg-muted px-[17px] py-3.5 text-base leading-[1.68] text-foreground text-pretty">
        {content}
        {showFooter ? (
          <div className="-mb-1.5 mt-3 border-t border-foreground/10 pt-1.5">
            {footer}
          </div>
        ) : null}
      </div>
    </div>
  );
}
