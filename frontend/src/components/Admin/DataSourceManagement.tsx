import { useState, useEffect } from "react";
import JSZip from "jszip";
import {
  Search,
  Upload,
  RefreshCw,
  FileText,
  Users,
  HelpCircle,
  Loader2,
  AlertTriangle,
  MessageCircleMore,
  Archive,
  Film,
  Trash2,
} from "lucide-react";
import { AuthService } from "@/functions/authService";
import { fetchUserAttributes, getCurrentUser } from "aws-amplify/auth";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import MetricCard from "./MetricCard.tsx";
import {
  DEMO_ADMIN_EMAIL,
  DEMO_DATA_SOURCES,
  DEMO_INGESTION_RUNS,
  DEMO_OVERVIEW_TOTALS,
  isDemoMode,
} from "@/lib/demo";
import { API_ENDPOINT } from "@/lib/api";

type AnalyticsTotals = {
  users: number;
  chat_sessions: number;
  messages: number;
  questions?: number;
};

type DataSourceType =
  | "csv"
  | "markdown"
  | "json"
  | "website"
  | "video"
  | "document";

type DataSourceRow = {
  id: string;
  name: string;
  type: DataSourceType;
  created_at: string;
  metadata: Record<string, unknown>;
  include_patterns?: string[];
  exclude_patterns?: string[];
};

type IngestionRunStatus =
  | "pending"
  | "queued"
  | "running"
  | "failed"
  | "completed"
  | "transcribing";

type IngestionRunRow = {
  id: string;
  data_source_id: string;
  status: IngestionRunStatus;
  error_message?: string | null;
  created_at: string;
  completed_at?: string | null;
};

type AdminDataSourcesResponse = {
  items: Array<{
    data_source: DataSourceRow;
    latest_ingestion_run: IngestionRunRow | null;
  }>;
};

type PresignedUploadResponse = {
  presignedUrl: string;
  bucket: string;
  key: string;
};

type BatchPresignedUrlEntry = {
  file_name: string;
  presigned_url: string;
  key: string;
  bucket: string;
};

type ZipFilePair = {
  primaryFile: File;
  metadataFile: File;
  type: "csv" | "markdown";
  error?: string;
};

function formatDateTime(iso?: string | null) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

function typeLabel(t: DataSourceType) {
  if (t === "website") return "Website";
  if (t === "csv") return "CSV";
  if (t === "markdown") return "Markdown";
  if (t === "json") return "JSON";
  if (t === "video") return "Video";
  if (t === "document") return "Document";
  return t;
}

function statusBadge(status: IngestionRunStatus | "no_runs") {
  switch (status) {
    case "pending":
      return (
        <Badge className="rounded-full border-0 bg-foreground/8 px-2.5 py-1 text-xs font-bold text-foreground/80">
          Pending
        </Badge>
      );
    case "queued":
      return (
        <Badge className="rounded-full border-0 bg-[oklch(0.95_0.05_85)] px-2.5 py-1 text-xs font-bold text-[oklch(0.36_0.10_75)]">
          Queued
        </Badge>
      );
    case "completed":
      return (
        <Badge className="rounded-full border-0 bg-[oklch(0.95_0.04_160)] px-2.5 py-1 text-xs font-bold text-[oklch(0.32_0.09_160)]">
          Completed
        </Badge>
      );
    case "failed":
      return (
        <Badge className="rounded-full border-0 bg-[oklch(0.96_0.03_25)] px-2.5 py-1 text-xs font-bold text-[oklch(0.38_0.13_25)]">
          Failed
        </Badge>
      );
    case "running":
      return (
        <Badge className="rounded-full border-0 bg-[oklch(0.95_0.03_268)] px-2.5 py-1 text-xs font-bold text-[oklch(0.36_0.11_268)]">
          Running
        </Badge>
      );
    case "transcribing":
      return (
        <Badge className="rounded-full border-0 bg-[oklch(0.95_0.03_268)] px-2.5 py-1 text-xs font-bold text-[oklch(0.36_0.11_268)]">
          Transcribing
        </Badge>
      );
    default:
      return (
        <Badge className="rounded-full border-0 bg-foreground/8 px-2.5 py-1 text-xs font-bold text-foreground/80">
          Not synced
        </Badge>
      );
  }
}

function parsePatterns(text: string): string[] {
  return text
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function formatSizeMb(file: File | null) {
  if (!file) return "";
  return `${(file.size / (1024 * 1024)).toFixed(2)} MB`;
}

function isMarkdownFile(file: File) {
  const lower = file.name.toLowerCase();
  return (
    lower.endsWith(".md") ||
    lower.endsWith(".markdown") ||
    file.type === "text/markdown"
  );
}

function isCsvFile(file: File) {
  return file.name.toLowerCase().endsWith(".csv") || file.type === "text/csv";
}

// Minimal RFC 4180 parser for the first rows of a CSV (quoted fields, "" escapes).
function parseCsvSample(text: string, maxRows: number): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length && rows.length < maxRows; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += ch;
    }
  }
  if (rows.length < maxRows && (field || row.length))
    rows.push([...row, field]);
  return rows;
}

function isHttpUrl(value: string) {
  try {
    const url = new URL(value.trim());
    return (
      (url.protocol === "http:" || url.protocol === "https:") && !!url.hostname
    );
  } catch {
    return false;
  }
}

// Header of a CSV plus the column (if any) where >80% of sampled values are
// http(s) URLs — the same rule the backend uses for suggested_url_column.
async function inspectCsvColumns(
  file: File,
): Promise<{ columns: string[]; suggested: string | null }> {
  const text = (await file.slice(0, 256 * 1024).text()).replace(/^\uFEFF/, "");
  const [header = [], ...rows] = parseCsvSample(text, 201);
  const columns = header.map((c) => c.trim()).filter(Boolean);
  let suggested: string | null = null;
  let best = 0.8;
  header.forEach((name, idx) => {
    const values = rows.map((r) => (r[idx] ?? "").trim()).filter(Boolean);
    if (!name.trim() || values.length === 0) return;
    const ratio = values.filter(isHttpUrl).length / values.length;
    if (ratio > best) {
      best = ratio;
      suggested = name.trim();
    }
  });
  return { columns, suggested };
}

function isVideoFile(file: File) {
  const lower = file.name.toLowerCase();
  return (
    lower.endsWith(".mp4") ||
    lower.endsWith(".webm") ||
    lower.endsWith(".mp3") ||
    lower.endsWith(".wav") ||
    lower.endsWith(".flac") ||
    lower.endsWith(".ogg") ||
    lower.endsWith(".m4a") ||
    lower.endsWith(".m4v") ||
    lower.endsWith(".amr")
  );
}

function validateVideoFile(file: File): string | null {
  if (!isVideoFile(file)) {
    return "Use mp4, webm, mp3, wav, flac, ogg, m4a, or amr. MOV files are not supported.";
  }
  if (file.size > 1024 * 1024 * 1024) {
    return "Video must be smaller than 1 GB.";
  }
  return null;
}

const VIDEO_CONTENT_TYPE_BY_EXT: Record<string, string> = {
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".flac": "audio/flac",
  ".ogg": "audio/ogg",
  ".amr": "audio/amr",
};

function videoContentType(file: File): string {
  // Always map from the extension. Browser `file.type` is unreliable on Windows
  // (application/mp4, video/mpeg, codecs=... parameters) and is not always in
  // the API allowlist, which makes presign fail before the file is uploaded.
  const lower = file.name.toLowerCase();
  for (const [ext, contentType] of Object.entries(VIDEO_CONTENT_TYPE_BY_EXT)) {
    if (lower.endsWith(ext)) return contentType;
  }
  return "video/mp4";
}

function isDocumentFile(file: File) {
  const lower = file.name.toLowerCase();
  return (
    lower.endsWith(".pdf") || lower.endsWith(".docx") || lower.endsWith(".txt")
  );
}

function validateDocumentFile(file: File): string | null {
  if (!isDocumentFile(file)) {
    return "Use pdf, docx, or txt.";
  }
  if (file.size > 50 * 1024 * 1024) {
    return "Document must be smaller than 50MB.";
  }
  return null;
}

const DOCUMENT_CONTENT_TYPE_BY_EXT: Record<string, string> = {
  ".pdf": "application/pdf",
  ".docx":
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".txt": "text/plain",
};

function documentContentType(file: File): string {
  const lower = file.name.toLowerCase();
  for (const [ext, contentType] of Object.entries(
    DOCUMENT_CONTENT_TYPE_BY_EXT,
  )) {
    if (lower.endsWith(ext)) return contentType;
  }
  return "application/pdf";
}

function sanitizeUploadFileName(fileName: string): string {
  const base = fileName.replace(/^.*[/\\]/, "").trim() || "upload";
  const lastDot = base.lastIndexOf(".");
  const ext = lastDot >= 0 ? base.slice(lastDot).toLowerCase() : "";
  const stem = lastDot >= 0 ? base.slice(0, lastDot) : base;
  const cleanedStem =
    // \p{L}\p{N}_ = Python's Unicode \w, so non-ASCII names match the backend.
    stem
      .replace(/[^\p{L}\p{N}_.-]+/gu, "_")
      .replace(/_+/g, "_")
      .replace(/^[_.]+|[_.]+$/g, "") || "upload";
  const cleanedExt = ext.replace(/[^\p{L}\p{N}_.]/gu, "");
  return `${cleanedStem}${cleanedExt}`.slice(0, 180);
}

type UploadSourceType = "csv" | "markdown" | "document" | "video";

// Mirrors the backend's upload_identity.find_existing_upload: a file uploaded
// again under the same name replaces that source instead of adding a new one.
function findReplacedSource(
  dataSources: DataSourceRow[],
  type: UploadSourceType,
  fileName: string,
): DataSourceRow | undefined {
  const sourceKey = `upload://${type}/${sanitizeUploadFileName(fileName).toLowerCase()}`;
  const lowerName = fileName.toLowerCase();
  const legacyFileName = (ds: DataSourceRow) => {
    const value =
      type === "document"
        ? ds.metadata?.document_file_name
        : type === "video"
          ? ds.metadata?.video_file_name
          : ds.name;
    return typeof value === "string" ? value.toLowerCase() : "";
  };
  return dataSources.find(
    (ds) =>
      ds.type === type &&
      (ds.metadata?.source_key === sourceKey ||
        (!ds.metadata?.source_key && legacyFileName(ds) === lowerName)),
  );
}

function ReplaceNotice({ existing }: { existing?: DataSourceRow }) {
  if (!existing) return null;
  return (
    <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
      <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-700" />
      <div>
        This will replace the existing source{" "}
        <span className="font-medium">{existing.name}</span>. Only changed
        content is re-processed, and an identical file is skipped entirely.
        Rename the file if it is a different resource.
      </div>
    </div>
  );
}

function displayedStatus(
  ds: DataSourceRow,
  run?: IngestionRunRow | null,
): IngestionRunStatus | "no_runs" {
  if (
    run?.status === "pending" &&
    ds.type === "video" &&
    ds.metadata?.transcribe_status === "IN_PROGRESS"
  ) {
    return "transcribing";
  }
  return run?.status ?? "no_runs";
}

function validatePrimaryFile(file: File): string | null {
  const valid = isCsvFile(file) || isMarkdownFile(file);

  if (!valid) return "Only CSV or Markdown files are allowed.";
  if (file.size > 50 * 1024 * 1024) return "File size must be less than 50MB.";
  return null;
}

function getPrimaryFileType(file: File): "csv" | "markdown" {
  return isMarkdownFile(file) ? "markdown" : "csv";
}

function validateMetadataFile(file: File): string | null {
  const lower = file.name.toLowerCase();
  const isJson =
    lower.endsWith(".json") ||
    file.type === "application/json" ||
    file.type === "text/json";

  if (!isJson) return "Only JSON metadata files are allowed.";
  if (file.size > 50 * 1024 * 1024)
    return "Metadata JSON file size must be less than 50MB.";
  return null;
}

function expectedMetadataFileName(primaryFileName: string) {
  return `${primaryFileName}.metadata.json`;
}

function exampleMetadataContents(primaryFileName: string) {
  const lower = primaryFileName.toLowerCase();
  const type =
    lower.endsWith(".md") || lower.endsWith(".markdown") ? "markdown" : "csv";
  const title = primaryFileName.replace(/\.(csv|md|markdown)$/i, "");

  return JSON.stringify(
    {
      source: primaryFileName,
      type,
      title,
      schema_version: "1.0",
    },
    null,
    2,
  );
}

// The backend still expects a "<file>.metadata.json" sidecar next to every
// CSV/Markdown upload (a Bedrock KB-era convention). Its contents are only
// stored, so when the admin does not supply one we generate it here.
function generatedMetadataFile(primaryFileName: string) {
  return new File(
    [exampleMetadataContents(primaryFileName)],
    expectedMetadataFileName(primaryFileName),
    { type: "application/json" },
  );
}

type CsvLinkStatus = "pending" | "success" | "failed" | "skipped";

type CsvLinkRow = {
  row_key: string;
  row_number: number;
  url: string;
  normalized_url: string | null;
  raw_citation_url: string | null;
  citation_url: string | null;
  citation_warning: string | null;
  title: string | null;
  description: string | null;
  status: CsvLinkStatus;
  reason: string | null;
  http_status: number | null;
  content_type: string | null;
  fetched_at: string | null;
  row_indexed: boolean;
  fetched_content_indexed: boolean;
  indexing_reason: string | null;
  indexed_at: string | null;
  row_metadata: Record<string, unknown>;
};

type CsvLinksResponse = {
  data_source_id: string;
  url_column: string | null;
  row_id_column: string | null;
  title_column: string | null;
  description_column: string | null;
  citation_column: string | null;
  summary: Record<CsvLinkStatus, number>;
  total: number;
  limit: number;
  offset: number;
  links: CsvLinkRow[];
};

const LINK_STATUS_STYLES: Record<CsvLinkStatus, string> = {
  success: "bg-green-50 text-green-700 border-green-200",
  pending: "bg-amber-50 text-amber-700 border-amber-200",
  failed: "bg-red-50 text-red-700 border-red-200",
  skipped: "bg-gray-100 text-gray-600 border-gray-200",
};

function linkStatusBadge(status: CsvLinkStatus) {
  return (
    <span
      className={`inline-block rounded-full border px-2 py-0.5 text-[11px] font-medium capitalize ${LINK_STATUS_STYLES[status]}`}
    >
      {status}
    </span>
  );
}

// Per-row crawl status of a CSV's url_column links (GET /admin/data_sources/{id}/links).
// Rendered inside the CSV data source's expanded row when it was staged with a url_column.
function CsvLinkStatusPanel({
  dataSourceId,
  urlColumn,
  rowIdColumn,
}: {
  dataSourceId: string;
  urlColumn: string;
  rowIdColumn?: string | null;
}) {
  const LINK_PAGE_SIZE = 50;
  const [data, setData] = useState<CsvLinksResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<"" | CsvLinkStatus>("");
  const [offset, setOffset] = useState(0);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    setOffset(0);
  }, [statusFilter]);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        if (isDemoMode) {
          if (!cancelled) setData(null);
          return;
        }
        const token = await AuthService.getAdminIdToken();
        const params = new URLSearchParams({
          limit: String(LINK_PAGE_SIZE),
          offset: String(offset),
        });
        if (statusFilter) params.set("status", statusFilter);

        const res = await fetch(
          `${API_ENDPOINT}/admin/data_sources/${dataSourceId}/links?${params.toString()}`,
          {
            headers: { Authorization: token, "Content-Type": "application/json" },
          }
        );
        if (!res.ok) throw new Error(`Request failed (HTTP ${res.status})`);
        const json = (await res.json()) as CsvLinksResponse;
        if (!cancelled) setData(json);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Could not load link status");
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    load();
    return () => {
      cancelled = true;
    };
  }, [dataSourceId, statusFilter, offset, reloadKey]);

  const summary = data?.summary ?? { pending: 0, success: 0, failed: 0, skipped: 0 };
  const total = data?.total ?? 0;
  const filteredTotal = statusFilter ? summary[statusFilter] : total;
  const rangeStart = filteredTotal === 0 ? 0 : offset + 1;
  const rangeEnd = Math.min(offset + LINK_PAGE_SIZE, filteredTotal);

  if (isDemoMode) {
    return (
      <div className="text-xs text-gray-500">
        Link crawl status is not available in demo mode.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-sm font-medium text-gray-800">
          CSV row resources
          <span className="ml-2 font-normal text-gray-500">
            from column <span className="font-mono">{urlColumn}</span>
            {rowIdColumn ? (
              <>
                {" "}
                · id <span className="font-mono">{rowIdColumn}</span>
              </>
            ) : null}
            {data?.title_column ? (
              <> · title <span className="font-mono">{data.title_column}</span></>
            ) : null}
            {data?.description_column ? (
              <> · description <span className="font-mono">{data.description_column}</span></>
            ) : null}
            {data?.citation_column ? (
              <> · citation <span className="font-mono">{data.citation_column}</span></>
            ) : null}
          </span>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 rounded-full px-2.5 text-[11px]"
          onClick={() => setReloadKey((k) => k + 1)}
          disabled={loading}
          title="Refresh link status"
        >
          {loading ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <RefreshCw className="h-3 w-3" />
          )}
          <span className="ml-1">Refresh</span>
        </Button>
      </div>

      <div className="flex flex-wrap gap-2">
        {(["success", "pending", "failed", "skipped"] as CsvLinkStatus[]).map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setStatusFilter((prev) => (prev === s ? "" : s))}
            className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium capitalize transition-colors ${
              statusFilter === s ? LINK_STATUS_STYLES[s] : "border-gray-200 bg-white text-gray-600 hover:bg-gray-50"
            }`}
            title={statusFilter === s ? "Clear filter" : `Show only ${s}`}
          >
            {s}
            <span className="tabular-nums">{summary[s] ?? 0}</span>
          </button>
        ))}
        <span className="inline-flex items-center rounded-full border border-gray-200 bg-white px-2.5 py-1 text-[11px] text-gray-500">
          total <span className="ml-1 tabular-nums">{total}</span>
        </span>
      </div>

      {error ? (
        <div className="text-xs text-red-600 bg-red-50 border border-red-200 rounded p-3">
          {error}
        </div>
      ) : loading && !data ? (
        <div className="flex items-center gap-2 text-xs text-gray-500 py-4">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading link status…
        </div>
      ) : filteredTotal === 0 ? (
        <div className="text-xs text-gray-500">
          {statusFilter ? `No ${statusFilter} rows.` : "No row resources have been recorded for this CSV yet."}
        </div>
      ) : (
        <>
          <div className="rounded-lg border border-gray-200 bg-white overflow-x-auto">
            {/* Fixed layout keeps long URLs inside their column; they truncate with an ellipsis.
                whitespace-normal undoes the nowrap inherited from the enclosing TableCell so
                titles and details wrap. */}
            <table className="w-full min-w-[56rem] table-fixed whitespace-normal text-sm">
              <colgroup>
                <col className="w-[18%]" />
                <col className="w-[24%]" />
                <col className="w-[24%]" />
                <col className="w-[14%]" />
                <col className="w-[20%]" />
              </colgroup>
              <thead className="bg-gray-50 text-left text-xs text-gray-600">
                <tr>
                  <th className="px-3 py-2 font-semibold">Row / resource</th>
                  <th className="px-3 py-2 font-semibold">Fetched URL</th>
                  <th className="px-3 py-2 font-semibold">Resolved citation</th>
                  <th className="px-3 py-2 font-semibold">State</th>
                  <th className="px-3 py-2 font-semibold">Detail</th>
                </tr>
              </thead>
              <tbody>
                {(data?.links ?? []).map((link) => {
                  const fetchHref = link.normalized_url && isHttpUrl(link.normalized_url)
                    ? link.normalized_url
                    : null;
                  const citationHref = link.citation_url && isHttpUrl(link.citation_url)
                    ? link.citation_url
                    : null;
                  return (
                    <tr key={link.row_key} className="border-t border-gray-100 align-top">
                      <td className="px-3 py-2">
                        <div className="font-medium text-gray-800 break-words">
                          {link.title || `Row ${link.row_number}`}
                        </div>
                        <div className="text-[11px] text-gray-400 tabular-nums">Row {link.row_number}</div>
                      </td>
                      <td className="px-3 py-2">
                        {fetchHref ? (
                          <a
                            href={fetchHref}
                            target="_blank"
                            rel="noreferrer"
                            title={link.url || fetchHref}
                            className="block truncate text-primary underline underline-offset-2"
                          >
                            {link.url || fetchHref}
                          </a>
                        ) : (
                          <span className="block truncate text-gray-500" title={link.url || undefined}>
                            {link.url || "No fetch URL"}
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        {citationHref ? (
                          <a
                            href={citationHref}
                            target="_blank"
                            rel="noreferrer"
                            title={citationHref}
                            className="block truncate text-primary underline underline-offset-2"
                          >
                            {citationHref}
                          </a>
                        ) : (
                          <span className="text-gray-500">Non-clickable resource</span>
                        )}
                        {link.citation_warning ? (
                          <div className="mt-1 text-[11px] text-amber-700">{link.citation_warning}</div>
                        ) : null}
                      </td>
                      <td className="px-3 py-2 space-y-1">
                        <div>{linkStatusBadge(link.status)}</div>
                        <span className={`inline-block rounded-full border px-2 py-0.5 text-[11px] font-medium ${
                          link.row_indexed
                            ? "border-green-200 bg-green-50 text-green-700"
                            : "border-gray-200 bg-gray-100 text-gray-600"
                        }`}>
                          {link.row_indexed ? "Resource indexed" : "Not indexed"}
                        </span>
                        {link.fetched_content_indexed ? (
                          <div className="text-[11px] text-gray-500">Fetched text attached</div>
                        ) : null}
                      </td>
                      <td className="px-3 py-2 text-xs text-gray-600 break-words">
                        {link.reason ? <div>{link.reason}</div> : null}
                        {link.indexing_reason ? <div>{link.indexing_reason}</div> : null}
                        <div className="text-gray-400">
                          {link.http_status ? `HTTP ${link.http_status}` : null}
                          {link.http_status && link.fetched_at ? " · " : ""}
                          {link.fetched_at ? formatDateTime(link.fetched_at) : null}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="flex items-center justify-between text-xs text-gray-600">
            <span>
              Showing {rangeStart}–{rangeEnd} of {filteredTotal}
            </span>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 px-2 text-[11px]"
                onClick={() => setOffset((o) => Math.max(0, o - LINK_PAGE_SIZE))}
                disabled={offset === 0 || loading}
              >
                Previous
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 px-2 text-[11px]"
                onClick={() => setOffset((o) => o + LINK_PAGE_SIZE)}
                disabled={offset + LINK_PAGE_SIZE >= filteredTotal || loading}
              >
                Next
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

export default function DataSourceManagement() {
  const [adminEmail, setAdminEmail] = useState<string | null>(null);

  const [isUrlDialogOpen, setIsUrlDialogOpen] = useState(false);
  const [webUrl, setWebUrl] = useState("");
  const [webUrlStatus, setWebUrlStatus] = useState<{
    type: "success" | "error" | null;
    message: string;
  }>({ type: null, message: "" });
  const [addingUrl, setAddingUrl] = useState(false);

  const [searchQuery, setSearchQuery] = useState("");
  const [isUploadOpen, setIsUploadOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [primaryFile, setPrimaryFile] = useState<File | null>(null);
  const [csvColumns, setCsvColumns] = useState<string[]>([]);
  const [suggestedUrlColumn, setSuggestedUrlColumn] = useState<string | null>(
    null,
  );
  const [urlColumn, setUrlColumn] = useState("");
  const [rowIdColumn, setRowIdColumn] = useState("");
  const [titleColumn, setTitleColumn] = useState("");
  const [descriptionColumn, setDescriptionColumn] = useState("");
  const [citationColumn, setCitationColumn] = useState("");
  const [metadataFile, setMetadataFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadStatus, setUploadStatus] = useState<{
    type: "success" | "error" | null;
    message: string;
  }>({ type: null, message: "" });

  // Upload tab: "single" | "zip"
  const [uploadTab, setUploadTab] = useState<
    "single" | "zip" | "video" | "document"
  >("single");
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [videoUrl, setVideoUrl] = useState("");
  const [videoTitle, setVideoTitle] = useState("");
  const [documentFile, setDocumentFile] = useState<File | null>(null);
  const [documentTitle, setDocumentTitle] = useState("");
  const [documentUrl, setDocumentUrl] = useState("");

  // Zip upload state
  const [zipFile, setZipFile] = useState<File | null>(null);
  const [zipPairs, setZipPairs] = useState<ZipFilePair[]>([]);
  const [zipValidating, setZipValidating] = useState(false);
  const [zipUploading, setZipUploading] = useState(false);
  const [zipStatus, setZipStatus] = useState<{
    type: "success" | "error" | "warning" | null;
    message: string;
  }>({ type: null, message: "" });

  const [syncStatus, setSyncStatus] = useState<{
    type: "success" | "error" | null;
    message: string;
  }>({ type: null, message: "" });

  const [retryingId, setRetryingId] = useState<string | null>(null);
  const [retryStatus, setRetryStatus] = useState<{
    type: "success" | "error" | null;
    message: string;
  }>({ type: null, message: "" });

  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteStatus, setDeleteStatus] = useState<{
    type: "success" | "error" | null;
    message: string;
  }>({ type: null, message: "" });

  const [totals, setTotals] = useState<AnalyticsTotals>({
    users: 0,
    chat_sessions: 0,
    messages: 0,
    questions: 0,
  });

  const [dataSources, setDataSources] = useState<DataSourceRow[]>([]);
  const [ingestionRuns, setIngestionRuns] = useState<IngestionRunRow[]>([]);

  // shows subrow
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [includePatternsText, setIncludePatternsText] = useState("");
  const [excludePatternsText, setExcludePatternsText] = useState("");

  const PAGE_SIZE = 5;
  const [page, setPage] = useState(1);

  const fetchAdminCredentials = async () => {
    if (isDemoMode) {
      setAdminEmail(DEMO_ADMIN_EMAIL);
      return;
    }
    try {
      const attrs = await fetchUserAttributes();
      if (attrs.email) {
        setAdminEmail(attrs.email);
        return;
      }
    } catch {
      // Fall back to the Cognito sign-in id when attributes are unavailable.
    }
    const user = await getCurrentUser();
    const email = user?.signInDetails?.loginId ?? null;
    setAdminEmail(email);
  };

  const fetchAnalyticsTotals = async () => {
    if (isDemoMode) {
      setTotals(DEMO_OVERVIEW_TOTALS);
      setLoading(false);
      return;
    }
    try {
      setLoading(true);
      setError(null);

      const token = await AuthService.getAdminIdToken();

      // no timeRange so backend returns ALL-TIME totals
      const res = await fetch(
        `${API_ENDPOINT}/admin/analytics`,
        {
          headers: {
            Authorization: token,
            "Content-Type": "application/json",
          },
        },
      );

      if (!res.ok) throw new Error("Failed to fetch analytics");

      const data = (await res.json()) as { totals: AnalyticsTotals };

      setTotals({
        users: data.totals?.users ?? 0,
        chat_sessions: data.totals?.chat_sessions ?? 0,
        messages: data.totals?.messages ?? 0,
        questions: data.totals?.questions ?? 0,
      });
    } catch (e) {
      console.error(e);
      setError("Failed to load analytics");
    } finally {
      setLoading(false);
    }
  };

  const fetchAdminDataSources = async () => {
    if (isDemoMode) {
      setDataSources(DEMO_DATA_SOURCES);
      setIngestionRuns(DEMO_INGESTION_RUNS);
      setLoading(false);
      return;
    }
    try {
      setLoading(true);
      setError(null);

      const token = await AuthService.getAdminIdToken();

      const res = await fetch(
        `${API_ENDPOINT}/admin/data_sources`,
        {
          headers: {
            Authorization: token,
            "Content-Type": "application/json",
          },
        },
      );

      if (!res.ok) throw new Error("Failed to fetch data sources");

      const data = (await res.json()) as AdminDataSourcesResponse;

      const ds = data.items.map((x) => x.data_source);
      const runs = data.items
        .map((x) => x.latest_ingestion_run)
        .filter((r): r is IngestionRunRow => !!r);

      setDataSources(ds);
      setIngestionRuns(runs);
    } catch (e) {
      console.error(e);
      setError("Failed to load data sources");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchAdminCredentials();
    fetchAnalyticsTotals();
    fetchAdminDataSources();
  }, []);

  useEffect(() => {
    setPage(1);
  }, [searchQuery]);

  useEffect(() => {
    setPage(1);
  }, [dataSources.length]);

  const handleStartSync = async () => {
    if (!adminEmail) {
      setSyncStatus({
        type: "error",
        message: "Unable to determine the current admin email.",
      });
      return;
    }

    try {
      setSyncing(true);
      setSyncStatus({ type: null, message: "" });

      const token = await AuthService.getAdminIdToken();

      const res = await fetch(
        `${API_ENDPOINT}/admin/data_sources/sync`,
        {
          method: "POST",
          headers: {
            Authorization: token,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            created_by: adminEmail,
          }),
        },
      );

      const responseJson = await res.json().catch(() => ({}));

      if (!res.ok) {
        throw new Error(
          responseJson?.error ||
            responseJson?.message ||
            "Failed to start sync.",
        );
      }

      setSyncStatus({
        type: "success",
        message: responseJson?.message || "Sync started successfully.",
      });

      await fetchAdminDataSources();
    } catch (e) {
      console.error(e);
      setSyncStatus({
        type: "error",
        message: e instanceof Error ? e.message : "Failed to start sync",
      });
    } finally {
      setSyncing(false);
    }
  };

  const handleRetry = async (dataSourceId: string) => {
    if (isDemoMode) {
      setRetryStatus({
        type: "success",
        message: "Demo: this would re-queue the resource for the next sync.",
      });
      return;
    }

    try {
      setRetryingId(dataSourceId);
      setRetryStatus({ type: null, message: "" });

      const token = await AuthService.getAdminIdToken();

      const res = await fetch(
        `${API_ENDPOINT}/admin/data_sources/${dataSourceId}/retry`,
        {
          method: "POST",
          headers: {
            Authorization: token,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ created_by: adminEmail }),
        },
      );

      const responseJson = await res.json().catch(() => ({}));

      if (!res.ok) {
        throw new Error(
          responseJson?.error ||
            responseJson?.message ||
            "Failed to retry resource",
        );
      }

      setRetryStatus({
        type: "success",
        message:
          responseJson?.message ||
          "Resource re-queued. Click Sync now to run it.",
      });

      await fetchAdminDataSources();
    } catch (e) {
      console.error(e);
      setRetryStatus({
        type: "error",
        message: e instanceof Error ? e.message : "Failed to retry resource",
      });
    } finally {
      setRetryingId(null);
    }
  };

  const handleDelete = async (dataSourceId: string, name: string) => {
    if (
      !confirm(
        `Delete "${name}"? This permanently removes it (and any paired metadata file) from the knowledge base. This cannot be undone.`,
      )
    ) {
      return;
    }

    if (isDemoMode) {
      setDeleteStatus({
        type: "success",
        message: "Demo: this would permanently delete the resource.",
      });
      return;
    }

    try {
      setDeletingId(dataSourceId);
      setDeleteStatus({ type: null, message: "" });

      const token = await AuthService.getAdminIdToken();

      const res = await fetch(
        `${API_ENDPOINT}/admin/data_sources/${dataSourceId}`,
        {
          method: "DELETE",
          headers: {
            Authorization: token,
            "Content-Type": "application/json",
          },
        },
      );

      const responseJson = await res.json().catch(() => ({}));

      if (!res.ok) {
        throw new Error(
          responseJson?.error ||
            responseJson?.message ||
            "Failed to delete resource",
        );
      }

      setDeleteStatus({
        type: "success",
        message: responseJson?.message || "Resource deleted.",
      });

      await fetchAdminDataSources();
    } catch (e) {
      console.error(e);
      setDeleteStatus({
        type: "error",
        message: e instanceof Error ? e.message : "Failed to delete resource",
      });
    } finally {
      setDeletingId(null);
    }
  };

  const handleAddWebUrl = async () => {
    setAddingUrl(true);
    try {
      setWebUrlStatus({ type: null, message: "" });

      if (!webUrl || !/^https?:\/\//.test(webUrl.trim())) {
        setWebUrlStatus({
          type: "error",
          message:
            "Please enter a valid URL (must start with http:// or https://).",
        });
        return;
      }

      if (!adminEmail) {
        setWebUrlStatus({
          type: "error",
          message: "Unable to determine the current admin email.",
        });
        return;
      }

      const include_patterns = parsePatterns(includePatternsText);
      const exclude_patterns = parsePatterns(excludePatternsText);

      const token = await AuthService.getAdminIdToken();

      const res = await fetch(
        `${API_ENDPOINT}/admin/data_sources`,
        {
          method: "POST",
          headers: {
            Authorization: token,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            type: "website",
            name: webUrl.trim(),
            include_patterns,
            exclude_patterns,
            created_by: adminEmail,
          }),
        },
      );

      const responseJson = await res.json().catch(() => ({}));

      if (!res.ok) {
        throw new Error(
          responseJson?.error || responseJson?.message || "Failed to stage URL",
        );
      }

      setWebUrlStatus({
        type: "success",
        message: responseJson?.message || "URL staged successfully.",
      });

      await fetchAdminDataSources();

      setTimeout(() => {
        setIsUrlDialogOpen(false);
        setWebUrl("");
        setIncludePatternsText("");
        setExcludePatternsText("");
        setWebUrlStatus({ type: null, message: "" });
      }, 800);
    } catch (e) {
      console.error(e);
      setWebUrlStatus({
        type: "error",
        message: e instanceof Error ? e.message : "Failed to stage URL",
      });
    } finally {
      setAddingUrl(false);
    }
  };

  const handlePrimaryFileSelect = (selectedFile: File) => {
    setUploadStatus({ type: null, message: "" });
    const validationError = validatePrimaryFile(selectedFile);
    if (validationError) {
      setUploadStatus({ type: "error", message: validationError });
      return;
    }
    setPrimaryFile(selectedFile);
    setCsvColumns([]);
    setSuggestedUrlColumn(null);
    setUrlColumn("");
    setRowIdColumn("");
    setTitleColumn("");
    setDescriptionColumn("");
    setCitationColumn("");
    if (isCsvFile(selectedFile)) {
      inspectCsvColumns(selectedFile)
        .then(({ columns, suggested }) => {
          setCsvColumns(columns);
          setSuggestedUrlColumn(suggested);
        })
        .catch((e) => console.warn("Could not read CSV header", e));
    }
  };

  const handleMetadataFileSelect = (selectedFile: File) => {
    setUploadStatus({ type: null, message: "" });
    const validationError = validateMetadataFile(selectedFile);
    if (validationError) {
      setUploadStatus({ type: "error", message: validationError });
      return;
    }
    setMetadataFile(selectedFile);
  };


  const getPresignedUpload = async (
    token: string,
    file: File,
    uploadType: "csv" | "markdown" | "json" | "video" | "document",
  ): Promise<PresignedUploadResponse> => {
    const fallbackContentType =
      uploadType === "csv"
        ? "text/csv"
        : uploadType === "markdown"
          ? "text/markdown"
          : uploadType === "video"
            ? "video/mp4"
            : uploadType === "document"
              ? "application/pdf"
              : "application/json";

    const contentType =
      uploadType === "video"
        ? videoContentType(file)
        : uploadType === "document"
          ? documentContentType(file)
          : file.type || fallbackContentType;
    const fileName =
      uploadType === "video" || uploadType === "document"
        ? sanitizeUploadFileName(file.name)
        : file.name;

    const res = await fetch(
      `${API_ENDPOINT}/admin/generate-presigned-url?file_name=${encodeURIComponent(
        fileName,
      )}&content_type=${encodeURIComponent(contentType)}`,
      {
        headers: {
          Authorization: token,
        },
      },
    );

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(
        (typeof err?.error === "string" && err.error) ||
          (typeof err?.message === "string" && err.message) ||
          `Failed to generate upload URL for ${file.name} (HTTP ${res.status})`,
      );
    }

    return (await res.json()) as PresignedUploadResponse;
  };

  const uploadFileToS3 = async (
    presignedUrl: string,
    file: File,
    fallbackContentType: string,
  ) => {
    const uploadResponse = await fetch(presignedUrl, {
      method: "PUT",
      headers: {
        "Content-Type": fallbackContentType,
      },
      body: file,
    });

    if (!uploadResponse.ok) {
      throw new Error(`Failed to upload ${file.name} to S3`);
    }
  };

  const resetUploadDialog = () => {
    setIsUploadOpen(false);
    setPrimaryFile(null);
    setCsvColumns([]);
    setSuggestedUrlColumn(null);
    setUrlColumn("");
    setRowIdColumn("");
    setTitleColumn("");
    setDescriptionColumn("");
    setCitationColumn("");
    setMetadataFile(null);
    setUploadStatus({ type: null, message: "" });
    setUploadTab("single");
    setZipFile(null);
    setZipPairs([]);
    setZipStatus({ type: null, message: "" });
    setVideoFile(null);
    setVideoUrl("");
    setVideoTitle("");
    setDocumentFile(null);
    setDocumentTitle("");
    setDocumentUrl("");
  };

  const handleZipSelect = async (file: File) => {
    setZipStatus({ type: null, message: "" });
    setZipPairs([]);

    if (!file.name.toLowerCase().endsWith(".zip")) {
      setZipStatus({ type: "error", message: "Only .zip files are allowed." });
      return;
    }
    if (file.size > 200 * 1024 * 1024) {
      setZipStatus({
        type: "error",
        message: "Zip file must be less than 200MB.",
      });
      return;
    }

    setZipFile(file);
    setZipValidating(true);

    try {
      const zip = await JSZip.loadAsync(file);
      const allNames = Object.keys(zip.files).filter((n) => !zip.files[n].dir);

      // Build a map of name -> JSZip file entry (basename only, ignore subdirs).
      // Files are matched to their metadata sidecar by basename, so folder
      // structure inside the zip is ignored — track collisions so a later
      // duplicate silently overwriting an earlier one doesn't go unnoticed.
      const fileMap = new Map<string, JSZip.JSZipObject>();
      const duplicateBaseNames = new Set<string>();
      for (const name of allNames) {
        const base = name.split("/").pop()!;
        if (fileMap.has(base)) {
          duplicateBaseNames.add(base);
        }
        fileMap.set(base, zip.files[name]);
      }

      const pairs: ZipFilePair[] = [];
      const seen = new Set<string>();
      // Source identity (same rule as the backend's upload_source_key):
      // "Data.csv" and "data.csv" are one source, so only one may be staged.
      const claimedSourceKeys = new Map<string, string>();

      for (const [baseName, entry] of fileMap) {
        // Skip metadata files — they'll be matched from the primary side
        if (baseName.endsWith(".metadata.json")) continue;

        const isCsv = baseName.toLowerCase().endsWith(".csv");
        const isMd =
          baseName.toLowerCase().endsWith(".md") ||
          baseName.toLowerCase().endsWith(".markdown");
        if (!isCsv && !isMd) continue;
        if (seen.has(baseName)) continue;
        seen.add(baseName);

        const expectedMeta = `${baseName}.metadata.json`;
        const metaEntry = fileMap.get(expectedMeta);

        const primaryBlob = await entry.async("blob");
        const primaryFileObj = new File([primaryBlob], baseName, {
          type: isCsv ? "text/csv" : "text/markdown",
        });

        // A metadata sidecar is optional; generate one when it is absent.
        const metaFileObj = metaEntry
          ? new File([await metaEntry.async("blob")], expectedMeta, {
              type: "application/json",
            })
          : generatedMetadataFile(baseName);

        const type = isCsv ? "csv" : "markdown";
        const sourceKey = `${type}/${sanitizeUploadFileName(baseName).toLowerCase()}`;
        const claimedBy = claimedSourceKeys.get(sourceKey);
        if (!claimedBy) claimedSourceKeys.set(sourceKey, baseName);

        pairs.push({
          primaryFile: primaryFileObj,
          metadataFile: metaFileObj,
          type,
          ...(claimedBy && {
            error: `Same source as ${claimedBy} (names are matched ignoring case and punctuation) — rename one`,
          }),
        });
      }

      if (pairs.length === 0) {
        setZipStatus({
          type: "error",
          message: "No valid CSV or Markdown files found in the zip.",
        });
        setZipFile(null);
      } else if (duplicateBaseNames.size > 0) {
        const names = Array.from(duplicateBaseNames).sort().join(", ");
        setZipStatus({
          type: "warning",
          message: `Multiple files share the same name in different folders — only one of each was kept, the rest were dropped (folder structure is ignored when matching files): ${names}. Rename the others and re-upload if you need all of them.`,
        });
        setZipPairs(pairs);
      } else {
        setZipPairs(pairs);
      }
    } catch (e) {
      console.error(e);
      setZipStatus({
        type: "error",
        message: "Failed to read zip file. Make sure it's a valid zip.",
      });
      setZipFile(null);
    } finally {
      setZipValidating(false);
    }
  };

  const handleZipUpload = async () => {
    const validPairs = zipPairs.filter((p) => !p.error);
    if (validPairs.length === 0) {
      setZipStatus({
        type: "error",
        message: "No valid file pairs to upload.",
      });
      return;
    }
    if (!adminEmail) {
      setZipStatus({
        type: "error",
        message: "Unable to determine the current admin email.",
      });
      return;
    }

    try {
      setZipUploading(true);
      setZipStatus({ type: null, message: "" });

      const token = await AuthService.getAdminIdToken();

      // Step 1: Get all presigned URLs in one request
      const filesPayload = validPairs.flatMap((p) => [
        {
          file_name: p.primaryFile.name,
          content_type: p.type === "csv" ? "text/csv" : "text/markdown",
        },
        {
          file_name: p.metadataFile.name,
          content_type: "application/json",
        },
      ]);

      const batchUrlRes = await fetch(
        `${API_ENDPOINT}/admin/generate-presigned-urls/batch`,
        {
          method: "POST",
          headers: { Authorization: token, "Content-Type": "application/json" },
          body: JSON.stringify({ files: filesPayload }),
        },
      );

      if (!batchUrlRes.ok) {
        const err = await batchUrlRes.json().catch(() => ({}));
        throw new Error(err?.error || "Failed to generate presigned URLs");
      }

      const { presigned_urls } = (await batchUrlRes.json()) as {
        presigned_urls: BatchPresignedUrlEntry[];
      };

      // URLs come back in request order: [primary, metadata] per pair.
      if (presigned_urls.length !== filesPayload.length) {
        throw new Error(
          "Presigned URL response did not match the files requested",
        );
      }
      const urlsFor = (pairIndex: number) => ({
        primaryEntry: presigned_urls[pairIndex * 2],
        metaEntry: presigned_urls[pairIndex * 2 + 1],
      });

      // Step 2: Upload all files to S3 in parallel
      const putFile = async (url: string, contentType: string, file: File) => {
        const res = await fetch(url, {
          method: "PUT",
          headers: { "Content-Type": contentType },
          body: file,
        });
        if (!res.ok)
          throw new Error(`Failed to upload ${file.name} (HTTP ${res.status})`);
      };
      await Promise.all(
        validPairs.flatMap((p, i) => {
          const { primaryEntry, metaEntry } = urlsFor(i);
          return [
            putFile(
              primaryEntry.presigned_url,
              p.type === "csv" ? "text/csv" : "text/markdown",
              p.primaryFile,
            ),
            putFile(
              metaEntry.presigned_url,
              "application/json",
              p.metadataFile,
            ),
          ];
        }),
      );

      // Step 3: Stage all pairs in one batch request
      const stageItems = validPairs.map((p, i) => {
        const { primaryEntry, metaEntry } = urlsFor(i);
        return {
          type: p.type,
          primary_file_name: p.primaryFile.name,
          primary_s3_bucket: primaryEntry.bucket,
          primary_s3_key: primaryEntry.key,
          metadata_file_name: p.metadataFile.name,
          metadata_s3_bucket: metaEntry.bucket,
          metadata_s3_key: metaEntry.key,
        };
      });

      const stageRes = await fetch(
        `${API_ENDPOINT}/admin/data_sources/batch`,
        {
          method: "POST",
          headers: { Authorization: token, "Content-Type": "application/json" },
          body: JSON.stringify({ created_by: adminEmail, items: stageItems }),
        },
      );

      const stageJson = await stageRes.json().catch(() => ({}));
      if (!stageRes.ok) {
        throw new Error(stageJson?.error || "Batch staging failed");
      }

      const {
        staged_count,
        replaced_count = 0,
        unchanged_count = 0,
        skipped_count,
        error_count,
      } = stageJson;
      setZipStatus({
        type:
          error_count > 0 &&
          staged_count + replaced_count + unchanged_count === 0
            ? "error"
            : "success",
        message:
          `Done. ${staged_count} new, ${replaced_count} replaced, ${unchanged_count} unchanged (skipped), ` +
          `${skipped_count} skipped (already staged or ingesting), ${error_count} failed.`,
      });

      await fetchAdminDataSources();

      if (error_count === 0) {
        setTimeout(() => resetUploadDialog(), 1500);
      }
    } catch (e) {
      console.error(e);
      setZipStatus({
        type: "error",
        message: e instanceof Error ? e.message : "Zip upload failed",
      });
    } finally {
      setZipUploading(false);
    }
  };

  const handleUpload = async () => {
    if (!primaryFile) {
      setUploadStatus({
        type: "error",
        message: "Please select a CSV or Markdown file.",
      });
      return;
    }

    if (!adminEmail) {
      setUploadStatus({
        type: "error",
        message: "Unable to determine the current admin email.",
      });
      return;
    }

    const expectedMetadata = expectedMetadataFileName(primaryFile.name);
    if (metadataFile && metadataFile.name !== expectedMetadata) {
      setUploadStatus({
        type: "error",
        message: `Metadata file name must be exactly ${expectedMetadata}`,
      });
      return;
    }
    const metadataToUpload =
      metadataFile ?? generatedMetadataFile(primaryFile.name);

    try {
      setUploading(true);
      setUploadStatus({ type: null, message: "" });

      const token = await AuthService.getAdminIdToken();

      const primaryType = getPrimaryFileType(primaryFile);

      const primaryUpload = await getPresignedUpload(
        token,
        primaryFile,
        primaryType,
      );
      await uploadFileToS3(
        primaryUpload.presignedUrl,
        primaryFile,
        primaryType === "csv" ? "text/csv" : "text/markdown",
      );

      const metadataUpload = await getPresignedUpload(
        token,
        metadataToUpload,
        "json",
      );
      await uploadFileToS3(
        metadataUpload.presignedUrl,
        metadataToUpload,
        "application/json",
      );

      const body =
        primaryType === "csv"
          ? {
              type: "csv",
              csv_file_name: primaryFile.name,
              csv_s3_bucket: primaryUpload.bucket,
              csv_s3_key: primaryUpload.key,
              metadata_file_name: metadataToUpload.name,
              metadata_s3_bucket: metadataUpload.bucket,
              metadata_s3_key: metadataUpload.key,
              created_by: adminEmail,
              ...(urlColumn ? { url_column: urlColumn } : {}),
              ...(urlColumn && rowIdColumn ? { row_id_column: rowIdColumn } : {}),
              ...(urlColumn && titleColumn ? { title_column: titleColumn } : {}),
              ...(urlColumn && descriptionColumn
                ? { description_column: descriptionColumn }
                : {}),
              ...(urlColumn && citationColumn ? { citation_column: citationColumn } : {}),
            }
          : {
              type: "markdown",
              markdown_file_name: primaryFile.name,
              markdown_s3_bucket: primaryUpload.bucket,
              markdown_s3_key: primaryUpload.key,
              metadata_file_name: metadataToUpload.name,
              metadata_s3_bucket: metadataUpload.bucket,
              metadata_s3_key: metadataUpload.key,
              created_by: adminEmail,
            };

      const stageResponse = await fetch(
        `${API_ENDPOINT}/admin/data_sources`,
        {
          method: "POST",
          headers: {
            Authorization: token,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        },
      );

      const responseJson = await stageResponse.json().catch(() => ({}));

      if (!stageResponse.ok) {
        throw new Error(
          responseJson?.error ||
            responseJson?.message ||
            "Upload succeeded but staging could not be completed.",
        );
      }

      setUploadStatus({
        type: "success",
        message:
          responseJson?.message ||
          `${primaryType === "csv" ? "CSV" : "Markdown"} and metadata uploaded and staged successfully.`,
      });

      await fetchAdminDataSources();

      setTimeout(() => {
        resetUploadDialog();
      }, 1200);
    } catch (err) {
      console.error("Upload error:", err);
      setUploadStatus({
        type: "error",
        message: err instanceof Error ? err.message : "Upload failed",
      });
    } finally {
      setUploading(false);
    }
  };

  const handleVideoFileSelect = (selectedFile: File) => {
    setUploadStatus({ type: null, message: "" });
    const validationError = validateVideoFile(selectedFile);
    if (validationError) {
      setUploadStatus({ type: "error", message: validationError });
      return;
    }
    setVideoFile(selectedFile);
    if (!videoTitle.trim()) {
      setVideoTitle(selectedFile.name.replace(/\.[^.]+$/, ""));
    }
  };

  const handleVideoUpload = async () => {
    if (isDemoMode) {
      setUploadStatus({
        type: "success",
        message:
          "Demo: the video would be transcribed and embedded automatically.",
      });
      return;
    }
    if (!videoFile) {
      setUploadStatus({
        type: "error",
        message: "Choose a video or audio file.",
      });
      return;
    }
    if (!videoUrl.trim() || !/^https?:\/\//i.test(videoUrl.trim())) {
      setUploadStatus({
        type: "error",
        message:
          "Enter the public http(s) URL for this video (YouTube or similar).",
      });
      return;
    }
    if (!adminEmail) {
      setUploadStatus({
        type: "error",
        message: "Unable to determine the current admin email.",
      });
      return;
    }

    try {
      setUploading(true);
      setUploadStatus({ type: null, message: "" });

      const token = await AuthService.getAdminIdToken();
      const upload = await getPresignedUpload(token, videoFile, "video");
      await uploadFileToS3(
        upload.presignedUrl,
        videoFile,
        videoContentType(videoFile),
      );

      const stageResponse = await fetch(
        `${API_ENDPOINT}/admin/data_sources`,
        {
          method: "POST",
          headers: {
            Authorization: token,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            type: "video",
            video_file_name: videoFile.name,
            video_s3_bucket: upload.bucket,
            video_s3_key: upload.key,
            video_url: videoUrl.trim(),
            name: videoTitle.trim() || videoFile.name,
            created_by: adminEmail,
          }),
        },
      );

      const responseJson = await stageResponse.json().catch(() => ({}));
      if (!stageResponse.ok) {
        const detail =
          typeof responseJson?.detail === "string" ? responseJson.detail : "";
        throw new Error(
          [responseJson?.error || responseJson?.message, detail]
            .filter(Boolean)
            .join(" — ") ||
            "Video uploaded but transcription could not be started.",
        );
      }

      setUploadStatus({
        type: "success",
        message:
          responseJson?.message ||
          "Video staged. Transcription has started and embedding will run when it finishes.",
      });
      await fetchAdminDataSources();
      setTimeout(() => resetUploadDialog(), 1500);
    } catch (err) {
      console.error("Video upload error:", err);
      setUploadStatus({
        type: "error",
        message: err instanceof Error ? err.message : "Video upload failed",
      });
    } finally {
      setUploading(false);
    }
  };

  const handleDocumentFileSelect = (selectedFile: File) => {
    setUploadStatus({ type: null, message: "" });
    const validationError = validateDocumentFile(selectedFile);
    if (validationError) {
      setUploadStatus({ type: "error", message: validationError });
      return;
    }
    setDocumentFile(selectedFile);
    if (!documentTitle.trim()) {
      setDocumentTitle(selectedFile.name.replace(/\.[^.]+$/, ""));
    }
  };

  const handleDocumentUpload = async () => {
    if (isDemoMode) {
      setUploadStatus({
        type: "success",
        message:
          "Demo: the document would be chunked and embedded automatically.",
      });
      return;
    }
    if (!documentFile) {
      setUploadStatus({
        type: "error",
        message: "Choose a PDF, DOCX, or TXT file.",
      });
      return;
    }
    if (!documentUrl.trim()) {
      setUploadStatus({
        type: "error",
        message:
          "Add a public link to this document so families can open it from citations.",
      });
      return;
    }
    if (!/^https?:\/\//i.test(documentUrl.trim())) {
      setUploadStatus({
        type: "error",
        message: "Document link must start with http:// or https://.",
      });
      return;
    }
    if (!adminEmail) {
      setUploadStatus({
        type: "error",
        message: "Unable to determine the current admin email.",
      });
      return;
    }

    try {
      setUploading(true);
      setUploadStatus({ type: null, message: "" });

      const token = await AuthService.getAdminIdToken();
      const upload = await getPresignedUpload(token, documentFile, "document");
      await uploadFileToS3(
        upload.presignedUrl,
        documentFile,
        documentContentType(documentFile),
      );

      const stageResponse = await fetch(
        `${API_ENDPOINT}/admin/data_sources`,
        {
          method: "POST",
          headers: {
            Authorization: token,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            type: "document",
            document_file_name: documentFile.name,
            document_s3_bucket: upload.bucket,
            document_s3_key: upload.key,
            document_url: documentUrl.trim(),
            name: documentTitle.trim() || documentFile.name,
            created_by: adminEmail,
          }),
        },
      );

      const responseJson = await stageResponse.json().catch(() => ({}));
      if (!stageResponse.ok) {
        const detail =
          typeof responseJson?.detail === "string" ? responseJson.detail : "";
        throw new Error(
          [responseJson?.error || responseJson?.message, detail]
            .filter(Boolean)
            .join(" — ") ||
            "Document uploaded but embedding could not be started.",
        );
      }

      setUploadStatus({
        type: "success",
        message:
          responseJson?.message || "Document staged. Embedding has started.",
      });
      await fetchAdminDataSources();
      setTimeout(() => resetUploadDialog(), 1500);
    } catch (err) {
      console.error("Document upload error:", err);
      setUploadStatus({
        type: "error",
        message: err instanceof Error ? err.message : "Document upload failed",
      });
    } finally {
      setUploading(false);
    }
  };

  const latestRunBySourceId = (() => {
    const map = new Map<string, IngestionRunRow>();
    for (const r of ingestionRuns) {
      const existing = map.get(r.data_source_id);
      const a = existing?.created_at
        ? new Date(existing.created_at).getTime()
        : 0;
      const b = r.created_at ? new Date(r.created_at).getTime() : 0;
      if (!existing || b > a) map.set(r.data_source_id, r);
    }
    return map;
  })();

  // Pair CSV/Markdown files with "<filename>.metadata.json" sidecars.
  const jsonByCsvName = (() => {
    const map = new Map<string, DataSourceRow>();
    for (const ds of dataSources) {
      if (ds.type === "json" && ds.name.endsWith(".metadata.json")) {
        const base = ds.name.replace(".metadata.json", "");
        map.set(base, ds);
      }
    }
    return map;
  })();

  const singleReplaces = primaryFile
    ? findReplacedSource(
        dataSources,
        getPrimaryFileType(primaryFile),
        primaryFile.name,
      )
    : undefined;
  const videoReplaces = videoFile
    ? findReplacedSource(dataSources, "video", videoFile.name)
    : undefined;
  const documentReplaces = documentFile
    ? findReplacedSource(dataSources, "document", documentFile.name)
    : undefined;
  const zipReplaceCount = zipPairs.filter(
    (p) =>
      !p.error && findReplacedSource(dataSources, p.type, p.primaryFile.name),
  ).length;

  // hide JSON rows from main table (they appear as subrow under CSV/markdown)
  const filteredDataSources = dataSources
    .filter((ds) => ds.type !== "json")
    .filter((ds) => {
      if (!searchQuery.trim()) return true;
      const q = searchQuery.trim().toLowerCase();
      return (
        ds.name.toLowerCase().includes(q) || ds.type.toLowerCase().includes(q)
      );
    });

  const hasPendingLikeItems = ingestionRuns.some((r) => {
    if (r.status === "queued") return true;
    if (r.status !== "pending") return false;
    const ds = dataSources.find((d) => d.id === r.data_source_id);
    return !(
      ds?.type === "video" && ds.metadata?.transcribe_status === "IN_PROGRESS"
    );
  });

  const totalPages = Math.max(
    1,
    Math.ceil(filteredDataSources.length / PAGE_SIZE),
  );
  const currentPage = Math.min(page, totalPages);
  const startIdx = (currentPage - 1) * PAGE_SIZE;
  const pagedDataSources = filteredDataSources.slice(
    startIdx,
    startIdx + PAGE_SIZE,
  );

  return (
    <div className="mx-auto max-w-[1080px] space-y-[26px]">
      <div>
        <h1 className="font-serif text-[30px] font-semibold leading-tight tracking-[-0.015em]">
          Overview
        </h1>
        <p className="mt-2 text-[15.5px] leading-relaxed text-foreground/80">
          How users are using the assistant, and what the knowledge base is
          drawing on.
        </p>
      </div>

      {/* Error Message */}
      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg">
          <p className="font-medium">Error loading data</p>
          <p className="text-sm">{error}</p>
        </div>
      )}

      {/* Metrics Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <MetricCard
          title="Users reached"
          value={loading ? "..." : totals.users.toLocaleString()}
          icon={<Users className="h-5 w-5 text-primary" />}
          trend="Distinct people who started at least one conversation"
          tooltip="Calculated by counting distinct users with chat sessions."
        />

        <MetricCard
          title="Conversations"
          value={loading ? "..." : totals.chat_sessions.toLocaleString()}
          icon={<MessageCircleMore className="h-5 w-5 text-primary" />}
          trend="All time, across every user"
          tooltip="Total chat sessions across all users."
        />

        <MetricCard
          title="Messages exchanged"
          value={loading ? "..." : totals.messages.toLocaleString()}
          icon={<HelpCircle className="h-5 w-5 text-primary" />}
          trend="User and assistant messages combined"
          tooltip="Total chat messages exchanged across all sessions."
        />
      </div>

      {/* Data Source Management Section */}
      <div className="space-y-4">
        <div className="flex flex-col gap-3">
          <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
            <div className="flex flex-col gap-1">
              <h3 className="text-[18.5px] font-bold tracking-[-0.01em] text-foreground">
                Data sources
              </h3>
              <p className="max-w-2xl text-[13.5px] leading-normal text-foreground/80">
                Everything the assistant is allowed to answer from. Staged items
                only go live after a sync.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                className="min-h-[42px] rounded-[9px] bg-primary px-4 text-sm font-semibold text-white"
                onClick={handleStartSync}
                disabled={syncing || !hasPendingLikeItems}
              >
                {syncing ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Syncing…
                  </>
                ) : (
                  "Sync now"
                )}
              </Button>

              <Dialog open={isUrlDialogOpen} onOpenChange={setIsUrlDialogOpen}>
                <DialogTrigger asChild>
                  <Button
                    variant="outline"
                    className="min-h-[42px] rounded-[9px] border-[1.5px] border-foreground/18 bg-white text-sm font-semibold text-foreground"
                  >
                    Add web URL
                  </Button>
                </DialogTrigger>
                <DialogContent className="sm:max-w-md">
                  <DialogHeader>
                    <DialogTitle>Add Web URL</DialogTitle>
                    <DialogDescription>
                      Stage a website URL for the next sync.
                    </DialogDescription>
                  </DialogHeader>
                  <div className="grid gap-4 py-4">
                    <div className="space-y-2">
                      <div className="text-sm font-medium text-gray-900">
                        Web URL
                      </div>
                      <Input
                        type="url"
                        placeholder="https://example.com/resource"
                        value={webUrl}
                        onChange={(e) => {
                          setWebUrl(e.target.value);
                          setWebUrlStatus({ type: null, message: "" });
                        }}
                      />
                    </div>

                    <div className="space-y-2">
                      <div className="text-sm font-medium text-gray-900">
                        Include patterns
                      </div>
                      <div className="text-xs text-gray-500">
                        Optional. One regex per line.
                      </div>
                      <textarea
                        value={includePatternsText}
                        onChange={(e) => setIncludePatternsText(e.target.value)}
                        placeholder="^https:\/\/example\.com\/science\/.*"
                        className="min-h-[96px] w-full rounded-md border border-gray-200 bg-white px-3 py-2 text-sm font-mono"
                      />
                    </div>

                    <div className="space-y-2">
                      <div className="text-sm font-medium text-gray-900">
                        Exclude patterns
                      </div>
                      <div className="text-xs text-gray-500">
                        Optional. One regex per line.
                      </div>
                      <textarea
                        value={excludePatternsText}
                        onChange={(e) => setExcludePatternsText(e.target.value)}
                        placeholder="^https:\/\/example\.com\/science\/private\/.*"
                        className="min-h-[96px] w-full rounded-md border border-gray-200 bg-white px-3 py-2 text-sm font-mono"
                      />
                    </div>

                    {webUrlStatus.message && (
                      <div
                        className={`text-sm p-2 rounded ${
                          webUrlStatus.type === "success"
                            ? "bg-green-100 text-green-700"
                            : "bg-red-100 text-red-700"
                        }`}
                      >
                        {webUrlStatus.message}
                      </div>
                    )}
                  </div>
                  <DialogFooter>
                    <Button
                      variant="outline"
                      onClick={() => {
                        setIsUrlDialogOpen(false);
                        setWebUrl("");
                        setIncludePatternsText("");
                        setExcludePatternsText("");
                        setWebUrlStatus({ type: null, message: "" });
                      }}
                    >
                      Cancel
                    </Button>
                    <Button
                      onClick={handleAddWebUrl}
                      disabled={!webUrl || addingUrl}
                    >
                      {addingUrl ? (
                        <>
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                          Adding...
                        </>
                      ) : (
                        "Stage URL"
                      )}
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>

              <Dialog open={isUploadOpen} onOpenChange={setIsUploadOpen}>
                <DialogTrigger asChild>
                  <Button
                    variant="outline"
                    className="min-h-[42px] rounded-[9px] border-[1.5px] border-foreground/18 bg-white text-sm font-semibold text-foreground"
                  >
                    <Upload className="mr-2 h-4 w-4" />
                    Upload files, video, or documents
                  </Button>
                </DialogTrigger>
                <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
                  <DialogHeader>
                    <DialogTitle>Upload guidance files</DialogTitle>
                    <DialogDescription>
                      Add CSV, Markdown, video, or document (PDF/DOCX/TXT)
                      resources to the Knowledge Compass knowledge base.
                    </DialogDescription>
                  </DialogHeader>

                  {/* Tab switcher */}
                  <div className="flex gap-1 border-b border-gray-200 mb-2">
                    <button
                      type="button"
                      onClick={() => setUploadTab("single")}
                      className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                        uploadTab === "single"
                          ? "border-primary text-primary"
                          : "border-transparent text-gray-500 hover:text-gray-700"
                      }`}
                    >
                      <Upload className="inline h-3.5 w-3.5 mr-1.5" />
                      Single File
                    </button>
                    <button
                      type="button"
                      onClick={() => setUploadTab("zip")}
                      className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                        uploadTab === "zip"
                          ? "border-primary text-primary"
                          : "border-transparent text-gray-500 hover:text-gray-700"
                      }`}
                    >
                      <Archive className="inline h-3.5 w-3.5 mr-1.5" />
                      Zip Upload
                    </button>
                    <button
                      type="button"
                      onClick={() => setUploadTab("video")}
                      className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                        uploadTab === "video"
                          ? "border-primary text-primary"
                          : "border-transparent text-gray-500 hover:text-gray-700"
                      }`}
                    >
                      <Film className="inline h-3.5 w-3.5 mr-1.5" />
                      Video
                    </button>
                    <button
                      type="button"
                      onClick={() => setUploadTab("document")}
                      className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                        uploadTab === "document"
                          ? "border-primary text-primary"
                          : "border-transparent text-gray-500 hover:text-gray-700"
                      }`}
                    >
                      <FileText className="inline h-3.5 w-3.5 mr-1.5" />
                      Document
                    </button>
                  </div>

                  {/* Single file tab */}
                  {uploadTab === "single" && (
                    <div className="grid gap-4 py-4">
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div className="space-y-2">
                          <div className="text-sm font-medium text-gray-900">
                            CSV or Markdown file
                          </div>

                          {!primaryFile ? (
                            <div
                              className="border-2 border-dashed border-gray-300 rounded-lg p-6 text-center hover:bg-gray-50 transition-colors cursor-pointer"
                              onDragOver={(e) => e.preventDefault()}
                              onDrop={(e) => {
                                e.preventDefault();
                                const droppedFile = e.dataTransfer.files?.[0];
                                if (droppedFile)
                                  handlePrimaryFileSelect(droppedFile);
                              }}
                              onClick={() =>
                                document.getElementById("csv-upload")?.click()
                              }
                            >
                              <div className="flex flex-col items-center gap-2">
                                <Upload className="h-8 w-8 text-gray-400" />
                                <span className="text-sm font-medium text-gray-600">
                                  Drag and drop CSV or Markdown
                                </span>
                                <span className="text-xs text-gray-400">
                                  or click to browse
                                </span>
                              </div>
                              <Input
                                id="csv-upload"
                                type="file"
                                className="hidden"
                                accept=".csv,text/csv,.md,.markdown,text/markdown"
                                onChange={(e) => {
                                  const selectedFile = e.target.files?.[0];
                                  if (selectedFile)
                                    handlePrimaryFileSelect(selectedFile);
                                }}
                              />
                            </div>
                          ) : (
                            <div className="border rounded-lg p-4 bg-gray-50">
                              <div className="flex items-center justify-between mb-2">
                                <div className="flex items-center gap-2 overflow-hidden">
                                  <FileText className="h-5 w-5 text-primary flex-shrink-0" />
                                  <span className="text-sm font-medium truncate">
                                    {primaryFile.name}
                                  </span>
                                </div>
                              </div>
                              <div className="text-xs text-gray-500">
                                {formatSizeMb(primaryFile)}
                              </div>
                            </div>
                          )}
                        </div>

                        <div className="space-y-2">
                          <div className="text-sm font-medium text-gray-900">
                            What to include
                          </div>
                          <div className="rounded-lg border border-gray-200 bg-gray-50 p-4 text-xs text-gray-700 space-y-3">
                            <div className="space-y-1">
                              <div className="font-medium text-gray-900">
                                CSV
                              </div>
                              <ul className="list-disc pl-4 space-y-1">
                                <li>
                                  The first row must be a header that names
                                  every column (for example{" "}
                                  <span className="font-medium">
                                    Title, Description, Link
                                  </span>
                                  ).
                                </li>
                                <li>
                                  Put one resource or topic on each row. Rows
                                  are read as "Column: value" lines, so clear
                                  column names give better answers. Empty
                                  cells are skipped.
                                </li>
                                <li>
                                  Save as UTF-8 (in Excel, choose "CSV UTF-8").
                                </li>
                                <li>
                                  Optional: a column of web page or PDF links.
                                  After you pick the file you can choose it,
                                  and those links are fetched on Sync.
                                </li>
                              </ul>
                            </div>
                            <div className="space-y-1">
                              <div className="font-medium text-gray-900">
                                Markdown
                              </div>
                              <ul className="list-disc pl-4 space-y-1">
                                <li>
                                  Use headings (#, ##, ###) to split the
                                  content into sections.
                                </li>
                              </ul>
                            </div>
                            <div className="text-gray-600">
                              Files must be under 50 MB. Uploading a file with
                              the same name as an existing source replaces it.
                            </div>
                          </div>

                          <div className="rounded-lg border border-dashed border-gray-300 p-3 text-xs text-gray-600 space-y-2">
                            <div className="flex items-center justify-between gap-2">
                              <span className="font-medium text-gray-900">
                                Metadata JSON
                              </span>
                              <Badge variant="secondary">Optional</Badge>
                            </div>
                            {!metadataFile ? (
                              <>
                                <div>
                                  Not required. One is created for you
                                  automatically.
                                </div>
                                <button
                                  type="button"
                                  className="text-primary underline"
                                  onClick={() =>
                                    document
                                      .getElementById("metadata-upload")
                                      ?.click()
                                  }
                                >
                                  Attach your own metadata JSON
                                </button>
                              </>
                            ) : (
                              <div className="flex items-center justify-between gap-2">
                                <div className="flex items-center gap-2 overflow-hidden">
                                  <FileText className="h-4 w-4 text-primary flex-shrink-0" />
                                  <span className="truncate">
                                    {metadataFile.name} (
                                    {formatSizeMb(metadataFile)})
                                  </span>
                                </div>
                                <button
                                  type="button"
                                  className="text-primary underline flex-shrink-0"
                                  onClick={() => setMetadataFile(null)}
                                >
                                  Remove
                                </button>
                              </div>
                            )}
                            {primaryFile && (
                              <div className="text-gray-500">
                                If you attach one, it must be named{" "}
                                <code className="bg-gray-100 px-1 py-0.5 rounded">
                                  {expectedMetadataFileName(primaryFile.name)}
                                </code>
                              </div>
                            )}
                            <Input
                              id="metadata-upload"
                              type="file"
                              className="hidden"
                              accept=".json,application/json,text/json"
                              onChange={(e) => {
                                const selectedFile = e.target.files?.[0];
                                if (selectedFile)
                                  handleMetadataFileSelect(selectedFile);
                                e.target.value = "";
                              }}
                            />
                          </div>
                        </div>
                      </div>

                      {primaryFile &&
                        isCsvFile(primaryFile) &&
                        csvColumns.length > 0 && (
                          <div className="space-y-1">
                            <label
                              htmlFor="csv-url-column"
                              className="text-sm font-medium text-gray-900"
                            >
                              Crawl links from column (optional)
                            </label>
                            <select
                              id="csv-url-column"
                              value={urlColumn}
                              onChange={(e) => {
                                const nextUrlColumn = e.target.value;
                                if (nextUrlColumn !== urlColumn) {
                                  setRowIdColumn("");
                                  setTitleColumn("");
                                  setDescriptionColumn("");
                                  setCitationColumn("");
                                }
                                setUrlColumn(nextUrlColumn);
                              }}
                              className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
                            >
                              <option value="">Don't crawl links</option>
                              {csvColumns.map((column) => (
                                <option key={column} value={column}>
                                  {column}
                                </option>
                              ))}
                            </select>
                            <div className="text-xs text-gray-500">
                              Web pages and PDFs linked in this column are
                              fetched on Sync and indexed with the row's other
                              columns.
                              {suggestedUrlColumn &&
                                urlColumn !== suggestedUrlColumn && (
                                  <>
                                    {" "}
                                    <span className="text-gray-700">
                                      <span className="font-medium">
                                        {suggestedUrlColumn}
                                      </span>{" "}
                                      looks like a URL column.
                                    </span>{" "}
                                    <button
                                      type="button"
                                      className="text-primary underline"
                                      onClick={() => {
                                        setRowIdColumn("");
                                        setTitleColumn("");
                                        setDescriptionColumn("");
                                        setCitationColumn("");
                                        setUrlColumn(suggestedUrlColumn);
                                      }}
                                    >
                                      Use it
                                    </button>
                                  </>
                                )}
                            </div>
                          </div>
                        )}

                      {primaryFile && isCsvFile(primaryFile) && csvColumns.length > 0 && urlColumn && (
                        <div className="space-y-1">
                          <label htmlFor="csv-row-id-column" className="text-sm font-medium text-gray-900">
                            Row identity column (optional)
                          </label>
                          <select
                            id="csv-row-id-column"
                            value={rowIdColumn}
                            onChange={(e) => {
                              const nextRowIdColumn = e.target.value;
                              setRowIdColumn(nextRowIdColumn);
                              if (titleColumn === nextRowIdColumn) setTitleColumn("");
                              if (descriptionColumn === nextRowIdColumn) setDescriptionColumn("");
                              if (citationColumn === nextRowIdColumn) setCitationColumn("");
                            }}
                            className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
                          >
                            <option value="">Match rows by their full contents</option>
                            {csvColumns
                              .filter((column) => column !== urlColumn)
                              .map((column) => (
                                <option key={column} value={column}>
                                  {column}
                                </option>
                              ))}
                          </select>
                          <div className="text-xs text-gray-500">
                            A column that identifies each row across re-uploads (e.g. an id), so editing a
                            row updates its crawled link instead of adding a new one. Leave unset to match
                            rows by their full contents.
                          </div>
                        </div>
                      )}

                      {primaryFile && isCsvFile(primaryFile) && csvColumns.length > 0 && urlColumn && (
                        <div className="grid gap-3 md:grid-cols-3">
                          <div className="space-y-1">
                            <label htmlFor="csv-title-column" className="text-sm font-medium text-gray-900">
                              Resource title column (optional)
                            </label>
                            <select
                              id="csv-title-column"
                              value={titleColumn}
                              onChange={(e) => setTitleColumn(e.target.value)}
                              className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
                            >
                              <option value="">Use the fetched page title</option>
                              {csvColumns
                                .filter((column) => column !== urlColumn && column !== rowIdColumn)
                                .map((column) => (
                                  <option key={column} value={column}>{column}</option>
                                ))}
                            </select>
                          </div>

                          <div className="space-y-1">
                            <label htmlFor="csv-description-column" className="text-sm font-medium text-gray-900">
                              Description column (optional)
                            </label>
                            <select
                              id="csv-description-column"
                              value={descriptionColumn}
                              onChange={(e) => setDescriptionColumn(e.target.value)}
                              className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
                            >
                              <option value="">No mapped description</option>
                              {csvColumns
                                .filter((column) => column !== urlColumn && column !== rowIdColumn)
                                .map((column) => (
                                  <option key={column} value={column}>{column}</option>
                                ))}
                            </select>
                          </div>

                          <div className="space-y-1">
                            <label htmlFor="csv-citation-column" className="text-sm font-medium text-gray-900">
                              Citation link column (optional)
                            </label>
                            <select
                              id="csv-citation-column"
                              value={citationColumn}
                              onChange={(e) => setCitationColumn(e.target.value)}
                              className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
                            >
                              <option value="">Use the fetched URL</option>
                              {csvColumns
                                .filter((column) => column !== rowIdColumn)
                                .map((column) => (
                                  <option key={column} value={column}>{column}</option>
                                ))}
                            </select>
                          </div>
                          <p className="text-xs text-gray-500 md:col-span-3">
                            Each row is indexed as its own resource. Its title and description enrich fetched
                            content, while the citation link controls what users open. Invalid citation links
                            safely fall back to the fetched URL.
                          </p>
                        </div>
                      )}

                      <ReplaceNotice existing={singleReplaces} />

                      {uploadStatus.message && (
                        <div
                          className={`text-sm p-2 rounded ${
                            uploadStatus.type === "success"
                              ? "bg-green-100 text-green-700"
                              : "bg-red-100 text-red-700"
                          }`}
                        >
                          {uploadStatus.message}
                        </div>
                      )}
                    </div>
                  )}

                  {/* Zip upload tab */}
                  {uploadTab === "zip" && (
                    <div className="grid gap-4 py-4">
                      <div className="text-sm text-gray-600">
                        Zip CSV or Markdown guidance files together. A
                        matching{" "}
                        <code className="bg-gray-100 px-1 rounded">
                          {"<filename>.metadata.json"}
                        </code>{" "}
                        file is optional; one is generated for any file
                        without it. Files with the same name as an
                        existing source replace it; identical files are skipped.
                      </div>

                      {!zipFile ? (
                        <div
                          className="border-2 border-dashed border-gray-300 rounded-lg p-10 text-center hover:bg-gray-50 transition-colors cursor-pointer"
                          onDragOver={(e) => e.preventDefault()}
                          onDrop={(e) => {
                            e.preventDefault();
                            const f = e.dataTransfer.files?.[0];
                            if (f) handleZipSelect(f);
                          }}
                          onClick={() =>
                            document.getElementById("zip-upload")?.click()
                          }
                        >
                          <div className="flex flex-col items-center gap-2">
                            {zipValidating ? (
                              <Loader2 className="h-8 w-8 text-gray-400 animate-spin" />
                            ) : (
                              <Archive className="h-8 w-8 text-gray-400" />
                            )}
                            <span className="text-sm font-medium text-gray-600">
                              {zipValidating
                                ? "Validating zip..."
                                : "Drag and drop a .zip file"}
                            </span>
                            <span className="text-xs text-gray-400">
                              or click to browse (max 200MB)
                            </span>
                          </div>
                          <Input
                            id="zip-upload"
                            type="file"
                            className="hidden"
                            accept=".zip,application/zip"
                            onChange={(e) => {
                              const f = e.target.files?.[0];
                              if (f) handleZipSelect(f);
                            }}
                          />
                        </div>
                      ) : (
                        <div className="space-y-3">
                          <div className="flex items-center justify-between border rounded-lg p-3 bg-gray-50">
                            <div className="flex items-center gap-2">
                              <Archive className="h-5 w-5 text-primary" />
                              <span className="text-sm font-medium">
                                {zipFile.name}
                              </span>
                              <span className="text-xs text-gray-500">
                                {formatSizeMb(zipFile)}
                              </span>
                            </div>
                            <button
                              type="button"
                              className="text-xs text-gray-400 hover:text-gray-600"
                              onClick={() => {
                                setZipFile(null);
                                setZipPairs([]);
                                setZipStatus({ type: null, message: "" });
                              }}
                            >
                              Remove
                            </button>
                          </div>

                          {zipPairs.length > 0 && (
                            <div className="border rounded-lg overflow-hidden">
                              <div className="bg-gray-50 px-3 py-2 text-xs font-semibold text-gray-600 border-b">
                                {zipPairs.filter((p) => !p.error).length} valid
                                pair(s) ·{" "}
                                {zipPairs.filter((p) => p.error).length} with
                                errors
                                {zipReplaceCount > 0 &&
                                  ` · ${zipReplaceCount} will replace existing sources`}
                              </div>
                              <div className="max-h-48 overflow-y-auto divide-y divide-gray-100">
                                {zipPairs.map((pair, i) => (
                                  <div
                                    key={i}
                                    className={`flex items-center justify-between px-3 py-2 text-xs ${pair.error ? "bg-red-50" : ""}`}
                                  >
                                    <div className="flex items-center gap-2 min-w-0">
                                      <FileText
                                        className={`h-3.5 w-3.5 flex-shrink-0 ${pair.error ? "text-red-400" : "text-primary"}`}
                                      />
                                      <span className="truncate font-mono">
                                        {pair.primaryFile.name}
                                      </span>
                                    </div>
                                    {pair.error ? (
                                      <span className="text-red-600 ml-2 flex-shrink-0">
                                        {pair.error}
                                      </span>
                                    ) : findReplacedSource(
                                        dataSources,
                                        pair.type,
                                        pair.primaryFile.name,
                                      ) ? (
                                      <span className="text-amber-700 ml-2 flex-shrink-0">
                                        ↻ replaces existing
                                      </span>
                                    ) : (
                                      <span className="text-green-600 ml-2 flex-shrink-0">
                                        ✓ paired
                                      </span>
                                    )}
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}
                        </div>
                      )}

                      {zipStatus.message && (
                        <div
                          className={`text-sm p-2 rounded ${
                            zipStatus.type === "success"
                              ? "bg-green-100 text-green-700"
                              : zipStatus.type === "warning"
                                ? "bg-amber-100 text-amber-800"
                                : "bg-red-100 text-red-700"
                          }`}
                        >
                          {zipStatus.message}
                        </div>
                      )}
                    </div>
                  )}

                  {uploadTab === "video" && (
                    <div className="grid gap-4 py-4">
                      <div className="text-sm text-gray-600">
                        Upload a video or audio file. Amazon Transcribe
                        processes it automatically; when that finishes,
                        Knowledge Compass embeds the transcript. Provide the
                        public URL users should be sent to (usually YouTube).
                      </div>
                      <div className="space-y-2">
                        <div className="text-sm font-medium text-gray-900">
                          Video or audio file
                        </div>
                        {!videoFile ? (
                          <div
                            className="border-2 border-dashed border-gray-300 rounded-lg p-6 text-center hover:bg-gray-50 transition-colors cursor-pointer"
                            onDragOver={(e) => e.preventDefault()}
                            onDrop={(e) => {
                              e.preventDefault();
                              const droppedFile = e.dataTransfer.files?.[0];
                              if (droppedFile)
                                handleVideoFileSelect(droppedFile);
                            }}
                            onClick={() =>
                              document.getElementById("video-upload")?.click()
                            }
                          >
                            <div className="flex flex-col items-center gap-2">
                              <Film className="h-8 w-8 text-gray-400" />
                              <span className="text-sm font-medium text-gray-600">
                                Drag and drop mp4, webm, mp3, wav, or m4a
                              </span>
                              <span className="text-xs text-gray-400">
                                or click to browse (max 1 GB)
                              </span>
                            </div>
                            <Input
                              id="video-upload"
                              type="file"
                              className="hidden"
                              accept=".mp4,.webm,.mp3,.wav,.flac,.ogg,.m4a,.m4v,.amr,video/mp4,video/webm,audio/*"
                              onChange={(e) => {
                                const selectedFile = e.target.files?.[0];
                                if (selectedFile)
                                  handleVideoFileSelect(selectedFile);
                              }}
                            />
                          </div>
                        ) : (
                          <div className="border rounded-lg p-4 bg-gray-50">
                            <div className="flex items-center justify-between mb-2">
                              <div className="flex items-center gap-2 overflow-hidden">
                                <Film className="h-5 w-5 text-primary flex-shrink-0" />
                                <span className="text-sm font-medium truncate">
                                  {videoFile.name}
                                </span>
                              </div>
                              <button
                                type="button"
                                className="text-xs text-gray-400 hover:text-gray-600"
                                onClick={() => setVideoFile(null)}
                              >
                                Remove
                              </button>
                            </div>
                            <div className="text-xs text-gray-500">
                              {formatSizeMb(videoFile)}
                            </div>
                          </div>
                        )}
                      </div>
                      <ReplaceNotice existing={videoReplaces} />
                      <div className="space-y-2">
                        <label
                          className="text-sm font-medium text-gray-900"
                          htmlFor="video-title"
                        >
                          Title
                        </label>
                        <Input
                          id="video-title"
                          value={videoTitle}
                          onChange={(e) => setVideoTitle(e.target.value)}
                          placeholder="Inclusive education webinar"
                        />
                      </div>
                      <div className="space-y-2">
                        <label
                          className="text-sm font-medium text-gray-900"
                          htmlFor="video-url"
                        >
                          Public video URL
                        </label>
                        <Input
                          id="video-url"
                          value={videoUrl}
                          onChange={(e) => setVideoUrl(e.target.value)}
                          placeholder="https://www.youtube.com/watch?v=..."
                        />
                        <p className="text-xs text-gray-500">
                          Used in citations and timestamp deep-links.
                          Transcription starts as soon as you upload.
                        </p>
                      </div>
                      {uploadStatus.message && uploadTab === "video" ? (
                        <div
                          className={`text-sm p-2 rounded ${
                            uploadStatus.type === "success"
                              ? "bg-green-100 text-green-700"
                              : "bg-red-100 text-red-700"
                          }`}
                        >
                          {uploadStatus.message}
                        </div>
                      ) : null}
                    </div>
                  )}

                  {uploadTab === "document" && (
                    <div className="grid gap-4 py-4">
                      <div className="text-sm text-gray-600">
                        Upload a single PDF, DOCX, or TXT file. Knowledge
                        Compass extracts the text and embeds it automatically —
                        no metadata JSON file required.
                      </div>
                      <div className="space-y-2">
                        <div className="text-sm font-medium text-gray-900">
                          Document file
                        </div>
                        {!documentFile ? (
                          <div
                            className="border-2 border-dashed border-gray-300 rounded-lg p-6 text-center hover:bg-gray-50 transition-colors cursor-pointer"
                            onDragOver={(e) => e.preventDefault()}
                            onDrop={(e) => {
                              e.preventDefault();
                              const droppedFile = e.dataTransfer.files?.[0];
                              if (droppedFile)
                                handleDocumentFileSelect(droppedFile);
                            }}
                            onClick={() =>
                              document
                                .getElementById("document-upload")
                                ?.click()
                            }
                          >
                            <div className="flex flex-col items-center gap-2">
                              <FileText className="h-8 w-8 text-gray-400" />
                              <span className="text-sm font-medium text-gray-600">
                                Drag and drop pdf, docx, or txt
                              </span>
                              <span className="text-xs text-gray-400">
                                or click to browse (max 50MB)
                              </span>
                            </div>
                            <Input
                              id="document-upload"
                              type="file"
                              className="hidden"
                              accept=".pdf,.docx,.txt,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain"
                              onChange={(e) => {
                                const selectedFile = e.target.files?.[0];
                                if (selectedFile)
                                  handleDocumentFileSelect(selectedFile);
                              }}
                            />
                          </div>
                        ) : (
                          <div className="border rounded-lg p-4 bg-gray-50">
                            <div className="flex items-center justify-between mb-2">
                              <div className="flex items-center gap-2 overflow-hidden">
                                <FileText className="h-5 w-5 text-primary flex-shrink-0" />
                                <span className="text-sm font-medium truncate">
                                  {documentFile.name}
                                </span>
                              </div>
                              <button
                                type="button"
                                className="text-xs text-gray-400 hover:text-gray-600"
                                onClick={() => setDocumentFile(null)}
                              >
                                Remove
                              </button>
                            </div>
                            <div className="text-xs text-gray-500">
                              {formatSizeMb(documentFile)}
                            </div>
                          </div>
                        )}
                      </div>
                      <ReplaceNotice existing={documentReplaces} />
                      <div className="space-y-2">
                        <label
                          className="text-sm font-medium text-gray-900"
                          htmlFor="document-title"
                        >
                          Title
                        </label>
                        <Input
                          id="document-title"
                          value={documentTitle}
                          onChange={(e) => setDocumentTitle(e.target.value)}
                          placeholder="Family rights handbook"
                        />
                      </div>
                      <div className="space-y-2">
                        <label
                          className="text-sm font-medium text-gray-900"
                          htmlFor="document-url"
                        >
                          Public link (required)
                        </label>
                        <Input
                          id="document-url"
                          type="url"
                          required
                          aria-required="true"
                          aria-describedby="document-url-help"
                          value={documentUrl}
                          onChange={(e) => setDocumentUrl(e.target.value)}
                          placeholder="https://example.com/handbook.pdf"
                        />
                        <p id="document-url-help" className="text-xs text-gray-500">
                          A public http(s) link where families can open this
                          document. It's used as the citation link in chat
                          answers. Re-uploads are matched by file name, so the
                          link can be changed or shared with other documents at
                          any time.
                        </p>
                      </div>
                      {uploadStatus.message && uploadTab === "document" ? (
                        <div
                          className={`text-sm p-2 rounded ${
                            uploadStatus.type === "success"
                              ? "bg-green-100 text-green-700"
                              : "bg-red-100 text-red-700"
                          }`}
                        >
                          {uploadStatus.message}
                        </div>
                      ) : null}
                    </div>
                  )}

                  <DialogFooter>
                    <Button
                      variant="outline"
                      onClick={resetUploadDialog}
                      disabled={uploading || zipUploading}
                    >
                      Cancel
                    </Button>
                    {uploadTab === "single" ? (
                      <Button
                        className="bg-primary hover:bg-primary/90"
                        onClick={handleUpload}
                        disabled={!primaryFile || uploading}
                      >
                        {uploading ? (
                          <>
                            <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
                            Uploading...
                          </>
                        ) : (
                          "Upload & Stage"
                        )}
                      </Button>
                    ) : uploadTab === "video" ? (
                      <Button
                        className="bg-primary hover:bg-primary/90"
                        onClick={handleVideoUpload}
                        disabled={!videoFile || !videoUrl.trim() || uploading}
                      >
                        {uploading ? (
                          <>
                            <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
                            Uploading...
                          </>
                        ) : (
                          "Upload & transcribe"
                        )}
                      </Button>
                    ) : uploadTab === "document" ? (
                      <Button
                        className="bg-primary hover:bg-primary/90"
                        onClick={handleDocumentUpload}
                        disabled={!documentFile || !documentUrl.trim() || uploading}
                      >
                        {uploading ? (
                          <>
                            <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
                            Uploading...
                          </>
                        ) : (
                          "Upload & embed"
                        )}
                      </Button>
                    ) : (
                      <Button
                        className="bg-primary hover:bg-primary/90"
                        onClick={handleZipUpload}
                        disabled={
                          !zipFile ||
                          zipPairs.filter((p) => !p.error).length === 0 ||
                          zipUploading ||
                          zipValidating
                        }
                      >
                        {zipUploading ? (
                          <>
                            <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
                            Uploading...
                          </>
                        ) : (
                          `Upload & Stage ${zipPairs.filter((p) => !p.error).length} pair(s)`
                        )}
                      </Button>
                    )}
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            </div>
          </div>

          {syncStatus.message && (
            <div
              className={`text-sm p-3 rounded ${
                syncStatus.type === "success"
                  ? "bg-green-100 text-green-700"
                  : "bg-red-100 text-red-700"
              }`}
            >
              {syncStatus.message}
            </div>
          )}

          {retryStatus.message && (
            <div
              className={`text-sm p-3 rounded ${
                retryStatus.type === "success"
                  ? "bg-green-100 text-green-700"
                  : "bg-red-100 text-red-700"
              }`}
            >
              {retryStatus.message}
            </div>
          )}

          {deleteStatus.message && (
            <div
              className={`text-sm p-3 rounded ${
                deleteStatus.type === "success"
                  ? "bg-green-100 text-green-700"
                  : "bg-red-100 text-red-700"
              }`}
            >
              {deleteStatus.message}
            </div>
          )}
        </div>

        <Card className="overflow-hidden rounded-[13px] border-foreground/12 shadow-sm">
          <CardHeader className="pb-3">
            <div className="relative">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-gray-500" />
              <Input
                placeholder="Search by name or type"
                className="pl-9 max-w-md bg-gray-50 border-gray-200"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
            </div>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader className="bg-gray-50">
                <TableRow>
                  <TableHead className="w-[40%]">Name</TableHead>
                  <TableHead className="w-[10%]">Type</TableHead>
                  <TableHead className="w-[12%]">Status</TableHead>
                  <TableHead className="w-[15%]">Uploaded</TableHead>
                  <TableHead className="w-[15%]">Completed</TableHead>
                  <TableHead className="w-[8%] text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading ? (
                  <TableRow>
                    <TableCell colSpan={6} className="py-10">
                      <div className="flex items-center justify-center gap-2 text-gray-500">
                        <Loader2 className="h-4 w-4 animate-spin" />
                        <span>Loading data sources...</span>
                      </div>
                    </TableCell>
                  </TableRow>
                ) : pagedDataSources.length === 0 ? (
                  <TableRow>
                    <TableCell
                      colSpan={6}
                      className="text-center py-10 text-gray-500"
                    >
                      No data sources found.
                    </TableCell>
                  </TableRow>
                ) : (
                  pagedDataSources.map((ds) => {
                    const run = latestRunBySourceId.get(ds.id);
                    const status = displayedStatus(ds, run);
                    const isExpandable =
                      ds.type === "website" ||
                      ds.type === "video" ||
                      ds.type === "document" ||
                      ((ds.type === "csv" || ds.type === "markdown") &&
                        !!jsonByCsvName.get(ds.name));
                    const isOpen = !!expanded[ds.id];

                    return (
                      <>
                        <TableRow
                          key={ds.id}
                          className={isOpen ? "bg-gray-50/50" : ""}
                        >
                          <TableCell className="align-top">
                            <div className="flex items-start gap-2">
                              {isExpandable ? (
                                <button
                                  type="button"
                                  className="mt-0.5 text-xs rounded border border-gray-200 px-2 py-1 text-gray-600 hover:bg-gray-50"
                                  onClick={() =>
                                    setExpanded((prev) => ({
                                      ...prev,
                                      [ds.id]: !prev[ds.id],
                                    }))
                                  }
                                  title={
                                    isOpen ? "Hide details" : "Show details"
                                  }
                                >
                                  {isOpen ? "Hide" : "Details"}
                                </button>
                              ) : (
                                <span className="mt-0.5 text-xs rounded border border-gray-200 px-2 py-1 text-gray-400">
                                  —
                                </span>
                              )}

                              <div className="min-w-0">
                                <div className="font-medium text-gray-900 break-all">
                                  {ds.name}
                                </div>
                              </div>
                            </div>
                          </TableCell>

                          <TableCell className="align-top">
                            <Badge variant="secondary">
                              {typeLabel(ds.type)}
                            </Badge>
                          </TableCell>

                          <TableCell className="align-top">
                            <div className="flex items-center gap-1.5">
                              {statusBadge(status)}
                              {status === "failed" && (
                                <Button
                                  type="button"
                                  variant="outline"
                                  size="sm"
                                  className="h-6 rounded-full px-2 text-[11px]"
                                  title="Re-queue this resource for the next sync"
                                  onClick={() => handleRetry(ds.id)}
                                  disabled={retryingId === ds.id}
                                >
                                  {retryingId === ds.id ? (
                                    <Loader2 className="h-3 w-3 animate-spin" />
                                  ) : (
                                    <RefreshCw className="h-3 w-3" />
                                  )}
                                </Button>
                              )}
                              {status === "completed" &&
                                ds.type === "website" && (
                                  <Button
                                    type="button"
                                    variant="outline"
                                    size="sm"
                                    className="h-6 rounded-full px-2 text-[11px]"
                                    title="Crawl this website again on the next sync to pick up changes. Only changed sections are re-embedded."
                                    onClick={() => handleRetry(ds.id)}
                                    disabled={retryingId === ds.id}
                                  >
                                    {retryingId === ds.id ? (
                                      <Loader2 className="h-3 w-3 animate-spin" />
                                    ) : (
                                      <RefreshCw className="h-3 w-3" />
                                    )}
                                    <span className="ml-1">Re-crawl</span>
                                  </Button>
                                )}
                            </div>
                          </TableCell>

                          <TableCell className="align-top text-sm text-gray-700">
                            {formatDateTime(ds.created_at)}
                          </TableCell>

                          <TableCell className="align-top text-sm text-gray-700">
                            {formatDateTime(run?.completed_at ?? null)}
                          </TableCell>

                          <TableCell className="align-top text-right">
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7 text-gray-500 hover:text-red-600 hover:bg-red-50"
                              title="Delete this resource"
                              onClick={() => handleDelete(ds.id, ds.name)}
                              disabled={deletingId === ds.id}
                            >
                              {deletingId === ds.id ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              ) : (
                                <Trash2 className="h-3.5 w-3.5" />
                              )}
                            </Button>
                          </TableCell>
                        </TableRow>

                        {isOpen ? (
                          <TableRow key={`${ds.id}-sub`}>
                            <TableCell colSpan={6} className="bg-gray-50/70">
                              {ds.type === "website" ? (
                                <div className="space-y-3">
                                  <div className="text-sm font-medium text-gray-800">
                                    Crawl rules
                                  </div>

                                  {(ds.include_patterns?.length ?? 0) > 0 ? (
                                    <div>
                                      <div className="text-xs font-semibold text-gray-600 mb-1">
                                        Include patterns
                                      </div>
                                      <div className="text-xs font-mono bg-white border border-gray-200 rounded p-3 overflow-auto">
                                        {(ds.include_patterns ?? []).map(
                                          (p, i) => (
                                            <div key={i} className="break-all">
                                              {p}
                                            </div>
                                          ),
                                        )}
                                      </div>
                                    </div>
                                  ) : (
                                    <div className="text-xs text-gray-500">
                                      No include patterns.
                                    </div>
                                  )}

                                  {(ds.exclude_patterns?.length ?? 0) > 0 ? (
                                    <div>
                                      <div className="text-xs font-semibold text-gray-600 mb-1">
                                        Exclude patterns
                                      </div>
                                      <div className="text-xs font-mono bg-white border border-gray-200 rounded p-3 overflow-auto">
                                        {(ds.exclude_patterns ?? []).map(
                                          (p, i) => (
                                            <div key={i} className="break-all">
                                              {p}
                                            </div>
                                          ),
                                        )}
                                      </div>
                                    </div>
                                  ) : (
                                    <div className="text-xs text-gray-500">
                                      No exclude patterns.
                                    </div>
                                  )}

                                  {run?.error_message ? (
                                    <div className="text-xs text-red-600 bg-red-50 border border-red-200 rounded p-3">
                                      {run.error_message}
                                    </div>
                                  ) : null}
                                </div>
                              ) : ds.type === "video" ? (
                                <div className="space-y-3 text-sm">
                                  <div>
                                    <div className="text-xs font-semibold text-gray-600 mb-1">
                                      Public URL
                                    </div>
                                    <a
                                      href={String(
                                        ds.metadata?.video_url || "",
                                      )}
                                      target="_blank"
                                      rel="noreferrer"
                                      className="text-primary break-all underline underline-offset-2"
                                    >
                                      {String(ds.metadata?.video_url || "—")}
                                    </a>
                                  </div>
                                  <div className="text-xs text-gray-600">
                                    Transcription:{" "}
                                    {String(
                                      ds.metadata?.transcribe_status ||
                                        "not started",
                                    )}
                                  </div>
                                  {run?.error_message ? (
                                    <div className="text-xs text-red-600 bg-red-50 border border-red-200 rounded p-3">
                                      {run.error_message}
                                    </div>
                                  ) : null}
                                </div>
                              ) : ds.type === "document" ? (
                                <div className="space-y-3 text-sm">
                                  <div className="text-xs text-gray-600">
                                    File:{" "}
                                    {String(
                                      ds.metadata?.document_file_name ||
                                        ds.name,
                                    )}
                                  </div>
                                  {run?.error_message ? (
                                    <div className="text-xs text-red-600 bg-red-50 border border-red-200 rounded p-3">
                                      {run.error_message}
                                    </div>
                                  ) : null}
                                </div>
                              ) : ds.type === "csv" ||
                                ds.type === "markdown" ? (
                                (() => {
                                  const json = jsonByCsvName.get(ds.name);
                                  const jsonRun = json
                                    ? latestRunBySourceId.get(json.id)
                                    : undefined;
                                  const jsonStatus =
                                    jsonRun?.status ?? "no_runs";

                                  return (
                                    <div className="space-y-5">
                                      <div className="space-y-2">
                                        <div className="text-sm font-medium text-gray-800">
                                          Metadata JSON file (optional)
                                        </div>

                                        {json ? (
                                          <div className="rounded-lg border border-gray-200 bg-white overflow-hidden">
                                            <div className="grid grid-cols-[45%_10%_12%_16%_17%] gap-0 text-sm items-start">
                                              <div className="px-3 py-3 border-r border-gray-100 min-w-0">
                                                <div className="font-medium text-gray-900 break-all">
                                                  {json.name}
                                                </div>
                                              </div>

                                              <div className="px-3 py-3 border-r border-gray-100">
                                                <Badge variant="secondary">
                                                  {typeLabel(json.type)}
                                                </Badge>
                                              </div>

                                              <div className="px-3 py-3 border-r border-gray-100">
                                                <div className="flex items-center gap-1.5">
                                                  {statusBadge(jsonStatus)}
                                                  {jsonStatus === "failed" && (
                                                    <Button
                                                      type="button"
                                                      variant="outline"
                                                      size="sm"
                                                      className="h-6 rounded-full px-2 text-[11px]"
                                                      title="Re-queue this resource for the next sync"
                                                      onClick={() =>
                                                        handleRetry(json.id)
                                                      }
                                                      disabled={
                                                        retryingId === json.id
                                                      }
                                                    >
                                                      {retryingId ===
                                                      json.id ? (
                                                        <Loader2 className="h-3 w-3 animate-spin" />
                                                      ) : (
                                                        <RefreshCw className="h-3 w-3" />
                                                      )}
                                                    </Button>
                                                  )}
                                                </div>
                                              </div>

                                              <div className="px-3 py-3 border-r border-gray-100 text-xs text-gray-700">
                                                {formatDateTime(
                                                  json.created_at,
                                                )}
                                              </div>

                                              <div className="px-3 py-3 border-r border-gray-100 text-xs text-gray-700">
                                                {formatDateTime(
                                                  jsonRun?.completed_at ?? null,
                                                )}
                                              </div>
                                            </div>
                                          </div>
                                        ) : (
                                          <div className="text-xs text-gray-500">
                                            No metadata JSON attached. This is
                                            optional.
                                          </div>
                                        )}
                                      </div>

                                      {ds.type === "csv" &&
                                      typeof ds.metadata?.url_column === "string" &&
                                      ds.metadata.url_column ? (
                                        <CsvLinkStatusPanel
                                          dataSourceId={ds.id}
                                          urlColumn={ds.metadata.url_column}
                                          rowIdColumn={
                                            typeof ds.metadata?.row_id_column === "string"
                                              ? ds.metadata.row_id_column
                                              : null
                                          }
                                        />
                                      ) : null}
                                    </div>
                                  );
                                })()
                              ) : (
                                <div className="text-xs text-gray-500">
                                  No details.
                                </div>
                              )}
                            </TableCell>
                          </TableRow>
                        ) : null}
                      </>
                    );
                  })
                )}
              </TableBody>
            </Table>
          </CardContent>

          {!loading && filteredDataSources.length > 0 && (
            <div className="flex items-center justify-between px-4 py-3 border-t border-gray-200">
              <div className="text-sm text-gray-600">
                Showing{" "}
                <span className="font-medium">
                  {Math.min(startIdx + 1, filteredDataSources.length)}
                </span>{" "}
                to{" "}
                <span className="font-medium">
                  {Math.min(startIdx + PAGE_SIZE, filteredDataSources.length)}
                </span>{" "}
                of{" "}
                <span className="font-medium">
                  {filteredDataSources.length}
                </span>
              </div>

              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={currentPage === 1}
                >
                  Prev
                </Button>

                <div className="text-sm text-gray-700">
                  Page <span className="font-medium">{currentPage}</span> of{" "}
                  <span className="font-medium">{totalPages}</span>
                </div>

                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  disabled={currentPage === totalPages}
                >
                  Next
                </Button>
              </div>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
