import { useRef, useEffect, useMemo, type KeyboardEvent } from "react";
import { cn } from "@/lib/utils";

interface AiChatInputProps {
  value: string;
  onChange: (value: string) => void;
  onKeyDown?: (e: KeyboardEvent<HTMLDivElement>) => void;
  placeholder?: string;
  highlightPattern?: RegExp;
  highlightClassName?: string;
  disabled?: boolean;
  className?: string;
  onSend?: () => void;
  maxLength?: number;
}

export function AiChatInput({
  value,
  onChange,
  onKeyDown,
  placeholder = "Type your message...",
  highlightPattern = /\[([^\]]+)\]/g,
  highlightClassName = "text-blue-500 font-medium bg-blue-500/10 px-1 rounded",
  disabled = false,
  className,
  onSend,
  maxLength = 2000,
}: AiChatInputProps) {
  const editableRef = useRef<HTMLDivElement>(null);
  const isComposingRef = useRef(false);
  const isUpdatingRef = useRef(false);

  // Memoize regex to avoid recreating on every render
  const regex = useMemo(
    () => new RegExp(highlightPattern.source, highlightPattern.flags),
    [highlightPattern.source, highlightPattern.flags]
  );

  // Get plain text content from the editable div
  const getTextContent = (): string => {
    return editableRef.current?.textContent || "";
  };

  // Parse and highlight text based on regex pattern
  const highlightText = (text: string): string => {
    if (!text) return "";

    let result = "";
    let lastIndex = 0;
    // Reset regex state
    regex.lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = regex.exec(text)) !== null) {
      // Add text before match
      if (match.index > lastIndex) {
        result += escapeHtml(text.slice(lastIndex, match.index));
      }

      // Add highlighted match
      result += `<span class="${highlightClassName}">${escapeHtml(
        match[0]
      )}</span>`;
      lastIndex = regex.lastIndex;
    }

    // Add remaining text
    if (lastIndex < text.length) {
      result += escapeHtml(text.slice(lastIndex));
    }

    return result;
  };

  // Escape HTML to prevent XSS
  const escapeHtml = (text: string): string => {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
  };

  // Save and restore cursor position
  const saveCursorPosition = (): number => {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return 0;

    const range = selection.getRangeAt(0);
    const preCaretRange = range.cloneRange();
    preCaretRange.selectNodeContents(editableRef.current!);
    preCaretRange.setEnd(range.endContainer, range.endOffset);

    return preCaretRange.toString().length;
  };

  const restoreCursorPosition = (position: number) => {
    const selection = window.getSelection();
    if (!selection || !editableRef.current) return;

    let charCount = 0;

    // Use a tree walker for more efficient traversal
    const walker = document.createTreeWalker(
      editableRef.current,
      NodeFilter.SHOW_TEXT,
      null
    );

    let textNode: Text | null;
    while ((textNode = walker.nextNode() as Text | null)) {
      const nextCharCount = charCount + textNode.length;

      if (position >= charCount && position <= nextCharCount) {
        const range = document.createRange();
        range.setStart(
          textNode,
          Math.min(position - charCount, textNode.length)
        );
        range.collapse(true);
        selection.removeAllRanges();
        selection.addRange(range);
        break;
      }

      charCount = nextCharCount;
    }
  };

  const handleInput = () => {
    if (isComposingRef.current || !editableRef.current || isUpdatingRef.current)
      return;

    const cursorPosition = saveCursorPosition();
    let text = getTextContent();

    if (text.length > maxLength) {
      text = text.slice(0, maxLength);

      isUpdatingRef.current = true;
      const highlighted = highlightText(text);
      editableRef.current.innerHTML = highlighted || "";
      restoreCursorPosition(Math.min(cursorPosition, maxLength));
      isUpdatingRef.current = false;
    }

    // Call parent's onChange with plain text
    onChange(text);

    // Update highlighting immediately to prevent stale blue backgrounds
    const highlighted = highlightText(text);
    if (editableRef.current.innerHTML !== highlighted) {
      isUpdatingRef.current = true;
      editableRef.current.innerHTML = highlighted || "";
      restoreCursorPosition(Math.min(cursorPosition, text.length));
      isUpdatingRef.current = false;
    }
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (disabled) {
      e.preventDefault();
      return;
    }

    onKeyDown?.(e);

    // If parent didn't prevent default and it's Enter without Shift, trigger send
    if (!e.defaultPrevented && e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      onSend?.();
    }
  };

  // Handle composition events for IME input
  const handleCompositionStart = () => {
    isComposingRef.current = true;
  };

  const handleCompositionEnd = () => {
    isComposingRef.current = false;
    handleInput();
  };

  useEffect(() => {
    if (!editableRef.current || isUpdatingRef.current) return;

    const currentText = getTextContent();
    if (currentText !== value) {
      const cursorPosition = saveCursorPosition();
      isUpdatingRef.current = true;

      if (value === "") {
        editableRef.current.innerHTML = "";
      } else {
        editableRef.current.innerHTML = highlightText(value);
      }

      // Only restore cursor if we had focus
      if (document.activeElement === editableRef.current) {
        restoreCursorPosition(Math.min(cursorPosition, value.length));
      }

      isUpdatingRef.current = false;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const warningThreshold = Math.floor(maxLength * 0.85);
  const dangerThreshold = Math.floor(maxLength * 0.95);

  return (
    <div className={cn("relative w-full", className)}>
      <div className="flex items-end gap-2.5 rounded-[11px] border-[1.5px] border-foreground/18 bg-white py-2.5 pr-2.5 pl-[15px]">
        {/* The input and placeholder share one grid cell so a placeholder that
            wraps on narrow screens grows the box instead of spilling out of it. */}
        <div className="grid min-w-0 flex-1">
          <div
            ref={editableRef}
            contentEditable={!disabled}
            onInput={handleInput}
            onKeyDown={handleKeyDown}
            onCompositionStart={handleCompositionStart}
            onCompositionEnd={handleCompositionEnd}
            spellCheck={false}
            className={cn(
              "[grid-area:1/1] min-h-[44px] max-h-[120px] overflow-auto py-2 text-base leading-relaxed",
              "whitespace-pre-wrap break-words outline-none",
              disabled && "cursor-not-allowed opacity-50"
            )}
            data-placeholder={placeholder}
            role="textbox"
            aria-multiline="true"
            aria-label="Chat message input"
            aria-placeholder={placeholder}
          />

          {value === "" && (
            <div
              aria-hidden="true"
              className="pointer-events-none [grid-area:1/1] py-2 text-base leading-relaxed text-foreground/55"
            >
              {placeholder}
            </div>
          )}
        </div>

        <button
          type="button"
          onClick={() => {
            if (!disabled && value.trim()) {
              onSend?.();
            }
          }}
          className="mb-0.5 min-h-11 shrink-0 rounded-lg px-[18px] text-sm font-semibold disabled:bg-foreground/12 disabled:text-foreground/75 enabled:bg-primary enabled:text-white"
          disabled={disabled || !value.trim()}
        >
          Send
        </button>
      </div>

      {value.length >= warningThreshold ? (
      <div
        className={cn(
          "mt-1 text-right text-xs transition-colors",
          value.length >= dangerThreshold
            ? "font-medium text-destructive"
            : "font-medium text-amber-700"
        )}
      >
        {value.length}/{maxLength}
      </div>
      ) : null}
    </div>
  );
}