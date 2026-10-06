/**
 * Public chat-history sanitizing.
 *
 * Messages saved before the textGeneration Lambda trimmed its sources can hold
 * internal storage identities (legacy `s3://bucket/key`, `upload://...`,
 * `csvlink://...`), full chunk bodies, scores, and internal chunk metadata.
 * Mirrors helpers/retrieval.py `to_public_source` so history returned to
 * anonymous users matches what new replies send over the WebSocket.
 *
 * Guideline-mode guide citations are never public. New replies no longer save
 * them, and filtering here also hides the "Family guide: ..." cards stored in
 * rows saved before that change, so no data migration is needed.
 */

const PUBLIC_PREVIEW_CHARS = 400;
const PUBLIC_METADATA_KEYS = ["chunk_start", "chunk_end"];

/** Returns `value` if it is an absolute http(s) URL, otherwise "". */
function publicHttpUrl(value) {
  if (typeof value !== "string") return "";
  const candidate = value.trim();
  try {
    const parsed = new URL(candidate);
    return (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      parsed.host
      ? candidate
      : "";
  } catch {
    return "";
  }
}

/** Project one stored source onto the fields the chat UI renders. */
function toPublicSource(source) {
  if (!source || typeof source !== "object" || Array.isArray(source))
    return null;
  const url = publicHttpUrl(source.url || source.uri);
  let content = typeof source.content === "string" ? source.content : "";
  if (content.length > PUBLIC_PREVIEW_CHARS) {
    content = `${content.slice(0, PUBLIC_PREVIEW_CHARS).trimEnd()}…`;
  }
  const metadata =
    source.metadata && typeof source.metadata === "object"
      ? source.metadata
      : {};
  const publicMetadata = {};
  for (const key of PUBLIC_METADATA_KEYS) {
    if (typeof metadata[key] === "string") publicMetadata[key] = metadata[key];
  }
  const title =
    typeof source.title === "string" && source.title ? source.title : "";
  const result = {
    type: typeof source.type === "string" ? source.type : "",
    source_type:
      typeof source.source_type === "string" ? source.source_type : "",
    // Older rows fell back to the URL as the title; never surface an internal one.
    title:
      (title &&
      (publicHttpUrl(title) || !/^[a-z][a-z0-9+.-]*:\/\//i.test(title))
        ? title
        : url) || "Untitled resource",
    url,
    uri: url,
    content,
  };
  if (Object.keys(publicMetadata).length > 0) result.metadata = publicMetadata;
  return result;
}

/** Sanitize a chat_messages.sources jsonb value (array, JSON string, or null). */
function toPublicSources(sources) {
  let list = sources;
  if (typeof list === "string") {
    try {
      list = JSON.parse(list);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(list)) return [];
  return list.filter((source) => !isGuidelineSource(source)).map(toPublicSource).filter(Boolean);
}

/** True for guideline-mode guide citations, which must never reach public users. */
function isGuidelineSource(source) {
  if (!source || typeof source !== "object") return false;
  return [source.source_type, source.type].some(
    (value) => typeof value === "string" && value.trim().toLowerCase() === "guideline"
  );
}

// Markdown links whose target is not http(s), e.g. [Handbook](s3://bucket/key).
const NON_HTTP_MARKDOWN_LINK =
  /\[([^\]]*)\]\(\s*<?(?!https?:\/\/)[a-z][a-z0-9+.-]*:\/\/[^)\s>]*>?(?:\s+"[^"]*")?\s*\)/gi;

/** Replace markdown links to internal identities with their link text. */
function stripInternalLinks(text) {
  if (typeof text !== "string") return text;
  return text.replace(NON_HTTP_MARKDOWN_LINK, "$1");
}

/** Sanitize one chat_messages row for a public history response. */
function toPublicMessage(message) {
  if (message.sender !== "AI") return message;
  return {
    ...message,
    content: stripInternalLinks(message.content),
    sources: toPublicSources(message.sources),
  };
}

module.exports = {
  publicHttpUrl,
  toPublicSource,
  toPublicSources,
  stripInternalLinks,
  toPublicMessage,
};
