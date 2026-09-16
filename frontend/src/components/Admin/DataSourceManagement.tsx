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
  Copy,
  Download,
  Film,
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

type AnalyticsTotals = {
  users: number;
  chat_sessions: number;
  messages: number;
  questions?: number;
};

type DataSourceType = "csv" | "markdown" | "json" | "website" | "video";

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
  return t;
}

function statusBadge(status: IngestionRunStatus | "no_runs") {
  switch (status) {
    case "pending":
      return <Badge className="rounded-full border-0 bg-foreground/8 px-2.5 py-1 text-xs font-bold text-foreground/80">Pending</Badge>;
    case "queued":
      return <Badge className="rounded-full border-0 bg-[oklch(0.95_0.05_85)] px-2.5 py-1 text-xs font-bold text-[oklch(0.36_0.10_75)]">Queued</Badge>;
    case "completed":
      return <Badge className="rounded-full border-0 bg-[oklch(0.95_0.04_160)] px-2.5 py-1 text-xs font-bold text-[oklch(0.32_0.09_160)]">Completed</Badge>;
    case "failed":
      return <Badge className="rounded-full border-0 bg-[oklch(0.96_0.03_25)] px-2.5 py-1 text-xs font-bold text-[oklch(0.38_0.13_25)]">Failed</Badge>;
    case "running":
      return <Badge className="rounded-full border-0 bg-[oklch(0.95_0.03_268)] px-2.5 py-1 text-xs font-bold text-[oklch(0.36_0.11_268)]">Running</Badge>;
    case "transcribing":
      return <Badge className="rounded-full border-0 bg-[oklch(0.95_0.03_268)] px-2.5 py-1 text-xs font-bold text-[oklch(0.36_0.11_268)]">Transcribing</Badge>;
    default:
      return <Badge className="rounded-full border-0 bg-foreground/8 px-2.5 py-1 text-xs font-bold text-foreground/80">Not synced</Badge>;
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
  return lower.endsWith(".md") || lower.endsWith(".markdown") || file.type === "text/markdown";
}

function isCsvFile(file: File) {
  return file.name.toLowerCase().endsWith(".csv") || file.type === "text/csv";
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

function sanitizeUploadFileName(fileName: string): string {
  const base = fileName.replace(/^.*[/\\]/, "").trim() || "upload";
  const lastDot = base.lastIndexOf(".");
  const ext = lastDot >= 0 ? base.slice(lastDot).toLowerCase() : "";
  const stem = lastDot >= 0 ? base.slice(0, lastDot) : base;
  const cleanedStem =
    stem.replace(/[^\w.\-]+/g, "_").replace(/_+/g, "_").replace(/^[_.]+|[_.]+$/g, "") ||
    "upload";
  const cleanedExt = ext.replace(/[^\w.]/g, "");
  return `${cleanedStem}${cleanedExt}`.slice(0, 180);
}

function displayedStatus(
  ds: DataSourceRow,
  run?: IngestionRunRow | null
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
  if (file.size > 50 * 1024 * 1024) return "Metadata JSON file size must be less than 50MB.";
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
    2
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
  const [metadataFile, setMetadataFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadStatus, setUploadStatus] = useState<{
    type: "success" | "error" | null;
    message: string;
  }>({ type: null, message: "" });

  // Upload tab: "single" | "zip"
  const [uploadTab, setUploadTab] = useState<"single" | "zip" | "video">("single");
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [videoUrl, setVideoUrl] = useState("");
  const [videoTitle, setVideoTitle] = useState("");

  // Zip upload state
  const [zipFile, setZipFile] = useState<File | null>(null);
  const [zipPairs, setZipPairs] = useState<ZipFilePair[]>([]);
  const [zipValidating, setZipValidating] = useState(false);
  const [zipUploading, setZipUploading] = useState(false);
  const [copiedMetadata, setCopiedMetadata] = useState(false);
  const [zipStatus, setZipStatus] = useState<{
    type: "success" | "error" | null;
    message: string;
  }>({ type: null, message: "" });

  const [syncStatus, setSyncStatus] = useState<{
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
      const res = await fetch(`${import.meta.env.VITE_API_ENDPOINT}/admin/analytics`, {
        headers: {
          Authorization: token,
          "Content-Type": "application/json",
        },
      });

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
        `${import.meta.env.VITE_API_ENDPOINT}/admin/data_sources`,
        {
          headers: {
            Authorization: token,
            "Content-Type": "application/json",
          },
        }
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
        `${import.meta.env.VITE_API_ENDPOINT}/admin/data_sources/sync`,
        {
          method: "POST",
          headers: {
            Authorization: token,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            created_by: adminEmail,
          }),
        }
      );

      const responseJson = await res.json().catch(() => ({}));

      if (!res.ok) {
        throw new Error(
          responseJson?.error ||
            responseJson?.message ||
            "Failed to start sync."
        );
      }

      setSyncStatus({
        type: "success",
        message:
          responseJson?.message ||
          "Sync started successfully.",
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

  const handleAddWebUrl = async () => {
    setAddingUrl(true);
    try {
      setWebUrlStatus({ type: null, message: "" });

      if (!webUrl || !/^https?:\/\//.test(webUrl.trim())) {
        setWebUrlStatus({
          type: "error",
          message: "Please enter a valid URL (must start with http:// or https://).",
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
        `${import.meta.env.VITE_API_ENDPOINT}/admin/data_sources`,
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
        }
      );

      const responseJson = await res.json().catch(() => ({}));

      if (!res.ok) {
        throw new Error(responseJson?.error || responseJson?.message || "Failed to stage URL");
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
    setCopiedMetadata(false);
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

  const handleCopyExampleMetadata = async () => {
    if (!primaryFile) return;
    try {
      await navigator.clipboard.writeText(exampleMetadataContents(primaryFile.name));
      setCopiedMetadata(true);
      window.setTimeout(() => setCopiedMetadata(false), 2000);
    } catch {
      setUploadStatus({
        type: "error",
        message: "Could not copy the metadata example.",
      });
    }
  };

  const handleDownloadExampleMetadata = () => {
    if (!primaryFile) return;
    const blob = new Blob([exampleMetadataContents(primaryFile.name)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = expectedMetadataFileName(primaryFile.name);
    link.click();
    URL.revokeObjectURL(url);
  };

  const getPresignedUpload = async (
    token: string,
    file: File,
    uploadType: "csv" | "markdown" | "json" | "video"
  ): Promise<PresignedUploadResponse> => {
    const fallbackContentType =
      uploadType === "csv"
        ? "text/csv"
        : uploadType === "markdown"
        ? "text/markdown"
        : uploadType === "video"
        ? "video/mp4"
        : "application/json";

    const contentType =
      uploadType === "video"
        ? videoContentType(file)
        : file.type || fallbackContentType;
    const fileName =
      uploadType === "video" ? sanitizeUploadFileName(file.name) : file.name;

    const res = await fetch(
      `${import.meta.env.VITE_API_ENDPOINT}/admin/generate-presigned-url?file_name=${encodeURIComponent(
        fileName
      )}&content_type=${encodeURIComponent(contentType)}`,
      {
        headers: {
          Authorization: token,
        },
      }
    );

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(
        (typeof err?.error === "string" && err.error) ||
          (typeof err?.message === "string" && err.message) ||
          `Failed to generate upload URL for ${file.name} (HTTP ${res.status})`
      );
    }

    return (await res.json()) as PresignedUploadResponse;
  };

  const uploadFileToS3 = async (
    presignedUrl: string,
    file: File,
    fallbackContentType: string
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
    setMetadataFile(null);
    setUploadStatus({ type: null, message: "" });
    setUploadTab("single");
    setZipFile(null);
    setZipPairs([]);
    setZipStatus({ type: null, message: "" });
    setVideoFile(null);
    setVideoUrl("");
    setVideoTitle("");
  };

  const handleZipSelect = async (file: File) => {
    setZipStatus({ type: null, message: "" });
    setZipPairs([]);

    if (!file.name.toLowerCase().endsWith(".zip")) {
      setZipStatus({ type: "error", message: "Only .zip files are allowed." });
      return;
    }
    if (file.size > 200 * 1024 * 1024) {
      setZipStatus({ type: "error", message: "Zip file must be less than 200MB." });
      return;
    }

    setZipFile(file);
    setZipValidating(true);

    try {
      const zip = await JSZip.loadAsync(file);
      const allNames = Object.keys(zip.files).filter((n) => !zip.files[n].dir);

      // Build a map of name -> JSZip file entry (basename only, ignore subdirs)
      const fileMap = new Map<string, JSZip.JSZipObject>();
      for (const name of allNames) {
        const base = name.split("/").pop()!;
        fileMap.set(base, zip.files[name]);
      }

      const pairs: ZipFilePair[] = [];
      const seen = new Set<string>();

      for (const [baseName, entry] of fileMap) {
        // Skip metadata files — they'll be matched from the primary side
        if (baseName.endsWith(".metadata.json")) continue;

        const isCsv = baseName.toLowerCase().endsWith(".csv");
        const isMd = baseName.toLowerCase().endsWith(".md") || baseName.toLowerCase().endsWith(".markdown");
        if (!isCsv && !isMd) continue;
        if (seen.has(baseName)) continue;
        seen.add(baseName);

        const expectedMeta = `${baseName}.metadata.json`;
        const metaEntry = fileMap.get(expectedMeta);

        const primaryBlob = await entry.async("blob");
        const primaryFileObj = new File(
          [primaryBlob],
          baseName,
          { type: isCsv ? "text/csv" : "text/markdown" }
        );

        if (!metaEntry) {
          pairs.push({
            primaryFile: primaryFileObj,
            metadataFile: null as unknown as File,
            type: isCsv ? "csv" : "markdown",
            error: `Missing metadata file: ${expectedMeta}`,
          });
          continue;
        }

        const metaBlob = await metaEntry.async("blob");
        const metaFileObj = new File([metaBlob], expectedMeta, { type: "application/json" });

        pairs.push({
          primaryFile: primaryFileObj,
          metadataFile: metaFileObj,
          type: isCsv ? "csv" : "markdown",
        });
      }

      if (pairs.length === 0) {
        setZipStatus({ type: "error", message: "No valid CSV or Markdown files found in the zip." });
        setZipFile(null);
      } else {
        setZipPairs(pairs);
      }
    } catch (e) {
      console.error(e);
      setZipStatus({ type: "error", message: "Failed to read zip file. Make sure it's a valid zip." });
      setZipFile(null);
    } finally {
      setZipValidating(false);
    }
  };

  const handleZipUpload = async () => {
    const validPairs = zipPairs.filter((p) => !p.error);
    if (validPairs.length === 0) {
      setZipStatus({ type: "error", message: "No valid file pairs to upload." });
      return;
    }
    if (!adminEmail) {
      setZipStatus({ type: "error", message: "Unable to determine the current admin email." });
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
        `${import.meta.env.VITE_API_ENDPOINT}/admin/generate-presigned-urls/batch`,
        {
          method: "POST",
          headers: { Authorization: token, "Content-Type": "application/json" },
          body: JSON.stringify({ files: filesPayload }),
        }
      );

      if (!batchUrlRes.ok) {
        const err = await batchUrlRes.json().catch(() => ({}));
        throw new Error(err?.error || "Failed to generate presigned URLs");
      }

      const { presigned_urls } = (await batchUrlRes.json()) as {
        presigned_urls: BatchPresignedUrlEntry[];
      };

      // Build a lookup map by file_name
      const urlMap = new Map<string, BatchPresignedUrlEntry>();
      for (const entry of presigned_urls) {
        urlMap.set(entry.file_name, entry);
      }

      // Step 2: Upload all files to S3 in parallel
      await Promise.all(
        validPairs.flatMap((p) => {
          const primaryEntry = urlMap.get(p.primaryFile.name)!;
          const metaEntry = urlMap.get(p.metadataFile.name)!;
          return [
            fetch(primaryEntry.presigned_url, {
              method: "PUT",
              headers: { "Content-Type": p.type === "csv" ? "text/csv" : "text/markdown" },
              body: p.primaryFile,
            }),
            fetch(metaEntry.presigned_url, {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: p.metadataFile,
            }),
          ];
        })
      );

      // Step 3: Stage all pairs in one batch request
      const stageItems = validPairs.map((p) => {
        const primaryEntry = urlMap.get(p.primaryFile.name)!;
        const metaEntry = urlMap.get(p.metadataFile.name)!;
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
        `${import.meta.env.VITE_API_ENDPOINT}/admin/data_sources/batch`,
        {
          method: "POST",
          headers: { Authorization: token, "Content-Type": "application/json" },
          body: JSON.stringify({ created_by: adminEmail, items: stageItems }),
        }
      );

      const stageJson = await stageRes.json().catch(() => ({}));
      if (!stageRes.ok) {
        throw new Error(stageJson?.error || "Batch staging failed");
      }

      const { staged_count, skipped_count, error_count } = stageJson;
      setZipStatus({
        type: error_count > 0 && staged_count === 0 ? "error" : "success",
        message: `Done. ${staged_count} staged, ${skipped_count} skipped (duplicates), ${error_count} failed.`,
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
    if (!primaryFile || !metadataFile) {
      setUploadStatus({
        type: "error",
        message: "Please select both the primary file and the metadata JSON file.",
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
    if (metadataFile.name !== expectedMetadata) {
      setUploadStatus({
        type: "error",
        message: `Metadata file name must be exactly ${expectedMetadata}`,
      });
      return;
    }

    try {
      setUploading(true);
      setUploadStatus({ type: null, message: "" });

      const token = await AuthService.getAdminIdToken();

      const primaryType = getPrimaryFileType(primaryFile);

      const primaryUpload = await getPresignedUpload(token, primaryFile, primaryType);
      await uploadFileToS3(
        primaryUpload.presignedUrl,
        primaryFile,
        primaryType === "csv" ? "text/csv" : "text/markdown"
      );

      const metadataUpload = await getPresignedUpload(token, metadataFile, "json");
      await uploadFileToS3(metadataUpload.presignedUrl, metadataFile, "application/json");

      const body =
        primaryType === "csv"
          ? {
              type: "csv",
              csv_file_name: primaryFile.name,
              csv_s3_bucket: primaryUpload.bucket,
              csv_s3_key: primaryUpload.key,
              metadata_file_name: metadataFile.name,
              metadata_s3_bucket: metadataUpload.bucket,
              metadata_s3_key: metadataUpload.key,
              created_by: adminEmail,
            }
          : {
              type: "markdown",
              markdown_file_name: primaryFile.name,
              markdown_s3_bucket: primaryUpload.bucket,
              markdown_s3_key: primaryUpload.key,
              metadata_file_name: metadataFile.name,
              metadata_s3_bucket: metadataUpload.bucket,
              metadata_s3_key: metadataUpload.key,
              created_by: adminEmail,
            };

      const stageResponse = await fetch(
        `${import.meta.env.VITE_API_ENDPOINT}/admin/data_sources`,
        {
          method: "POST",
          headers: {
            Authorization: token,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        }
      );

      const responseJson = await stageResponse.json().catch(() => ({}));

      if (!stageResponse.ok) {
        throw new Error(
          responseJson?.error ||
            responseJson?.message ||
            "Upload succeeded but staging could not be completed."
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
        message: "Demo: the video would be transcribed and embedded automatically.",
      });
      return;
    }
    if (!videoFile) {
      setUploadStatus({ type: "error", message: "Choose a video or audio file." });
      return;
    }
    if (!videoUrl.trim() || !/^https?:\/\//i.test(videoUrl.trim())) {
      setUploadStatus({
        type: "error",
        message: "Enter the public http(s) URL for this video (YouTube or similar).",
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
      await uploadFileToS3(upload.presignedUrl, videoFile, videoContentType(videoFile));

      const stageResponse = await fetch(
        `${import.meta.env.VITE_API_ENDPOINT}/admin/data_sources`,
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
        }
      );

      const responseJson = await stageResponse.json().catch(() => ({}));
      if (!stageResponse.ok) {
        const detail =
          typeof responseJson?.detail === "string" ? responseJson.detail : "";
        throw new Error(
          [responseJson?.error || responseJson?.message, detail]
            .filter(Boolean)
            .join(" — ") ||
            "Video uploaded but transcription could not be started."
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

  const latestRunBySourceId = (() => {
    const map = new Map<string, IngestionRunRow>();
    for (const r of ingestionRuns) {
      const existing = map.get(r.data_source_id);
      const a = existing?.created_at ? new Date(existing.created_at).getTime() : 0;
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
    return !(ds?.type === "video" && ds.metadata?.transcribe_status === "IN_PROGRESS");
  });

  const totalPages = Math.max(1, Math.ceil(filteredDataSources.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const startIdx = (currentPage - 1) * PAGE_SIZE;
  const pagedDataSources = filteredDataSources.slice(startIdx, startIdx + PAGE_SIZE);

  return (
    <div className="mx-auto max-w-[1080px] space-y-[26px]">
      <div>
        <h1 className="font-serif text-[30px] font-semibold leading-tight tracking-[-0.015em]">
          Overview
        </h1>
        <p className="mt-2 text-[15.5px] leading-relaxed text-foreground/80">
          How users are using the assistant, and what the knowledge base is drawing on.
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
              Everything the assistant is allowed to answer from. Staged items only go live after a sync.
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
                  <Button variant="outline" className="min-h-[42px] rounded-[9px] border-[1.5px] border-foreground/18 bg-white text-sm font-semibold text-foreground">
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
                      <div className="text-sm font-medium text-gray-900">Web URL</div>
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
                      <div className="text-sm font-medium text-gray-900">Include patterns</div>
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
                      <div className="text-sm font-medium text-gray-900">Exclude patterns</div>
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
                    <Button onClick={handleAddWebUrl} disabled={!webUrl || addingUrl}>
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
                  <Button variant="outline" className="min-h-[42px] rounded-[9px] border-[1.5px] border-foreground/18 bg-white text-sm font-semibold text-foreground">
                    <Upload className="mr-2 h-4 w-4" />
                    Upload files or video
                  </Button>
                </DialogTrigger>
                <DialogContent className="sm:max-w-2xl">
                  <DialogHeader>
                    <DialogTitle>Upload guidance files</DialogTitle>
                    <DialogDescription>
                      Add CSV, Markdown, or video resources to the Knowledge Compass knowledge base.
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
                  </div>

                  {/* Single file tab */}
                  {uploadTab === "single" && (
                  <div className="grid gap-4 py-4">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div className="space-y-2">
                        <div className="text-sm font-medium text-gray-900">CSV or Markdown file</div>

                        {!primaryFile ? (
                          <div
                            className="border-2 border-dashed border-gray-300 rounded-lg p-6 text-center hover:bg-gray-50 transition-colors cursor-pointer"
                            onDragOver={(e) => e.preventDefault()}
                            onDrop={(e) => {
                              e.preventDefault();
                              const droppedFile = e.dataTransfer.files?.[0];
                              if (droppedFile) handlePrimaryFileSelect(droppedFile);
                            }}
                            onClick={() => document.getElementById("csv-upload")?.click()}
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
                                if (selectedFile) handlePrimaryFileSelect(selectedFile);
                              }}
                            />
                          </div>
                        ) : (
                          <div className="border rounded-lg p-4 bg-gray-50">
                            <div className="flex items-center justify-between mb-2">
                              <div className="flex items-center gap-2 overflow-hidden">
                                <FileText className="h-5 w-5 text-primary flex-shrink-0" />
                                <span className="text-sm font-medium truncate">{primaryFile.name}</span>
                              </div>
                            </div>
                            <div className="text-xs text-gray-500">{formatSizeMb(primaryFile)}</div>
                          </div>
                        )}
                      </div>

                      <div className="space-y-2">
                        <div className="text-sm font-medium text-gray-900">Metadata JSON file</div>

                        {!metadataFile ? (
                          <div
                            className="border-2 border-dashed border-gray-300 rounded-lg p-6 text-center hover:bg-gray-50 transition-colors cursor-pointer"
                            onDragOver={(e) => e.preventDefault()}
                            onDrop={(e) => {
                              e.preventDefault();
                              const droppedFile = e.dataTransfer.files?.[0];
                              if (droppedFile) handleMetadataFileSelect(droppedFile);
                            }}
                            onClick={() => document.getElementById("metadata-upload")?.click()}
                          >
                            <div className="flex flex-col items-center gap-2">
                              <Upload className="h-8 w-8 text-gray-400" />
                              <span className="text-sm font-medium text-gray-600">
                                Drag and drop metadata JSON
                              </span>
                              <span className="text-xs text-gray-400">
                                or click to browse
                              </span>
                            </div>
                            <Input
                              id="metadata-upload"
                              type="file"
                              className="hidden"
                              accept=".json,application/json,text/json"
                              onChange={(e) => {
                                const selectedFile = e.target.files?.[0];
                                if (selectedFile) handleMetadataFileSelect(selectedFile);
                              }}
                            />
                          </div>
                        ) : (
                          <div className="border rounded-lg p-4 bg-gray-50">
                            <div className="flex items-center justify-between mb-2">
                              <div className="flex items-center gap-2 overflow-hidden">
                                <FileText className="h-5 w-5 text-primary flex-shrink-0" />
                                <span className="text-sm font-medium truncate">{metadataFile.name}</span>
                              </div>
                            </div>
                            <div className="text-xs text-gray-500">{formatSizeMb(metadataFile)}</div>
                          </div>
                        )}
                      </div>
                    </div>

                    {primaryFile && (
                      <div className="text-xs text-gray-600">
                        Expected metadata filename:{" "}
                        <code className="bg-gray-100 px-1 py-0.5 rounded">
                          {expectedMetadataFileName(primaryFile.name)}
                        </code>
                      </div>
                    )}

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

                    <div className="space-y-3 text-xs">
                      <div className="rounded-lg border border-amber-200 bg-amber-50 p-3">
                        <div className="flex items-start gap-2">
                          <AlertTriangle className="h-4 w-4 text-amber-700 mt-0.5" />
                          <div className="text-amber-800">
                            <div className="font-semibold">Two files are required</div>
                            <div className="mt-1 text-amber-700">
                              1) A <span className="font-medium">CSV</span> or <span className="font-medium">Markdown</span> guidance file (header row for CSVs; any columns are fine)
                              <br />
                              2) A matching <span className="font-medium">metadata JSON</span> file
                              named{" "}
                              <code className="bg-white/70 px-1 py-0.5 rounded border border-amber-200">
                                {primaryFile
                                  ? expectedMetadataFileName(primaryFile.name)
                                  : "<filename>.metadata.json"}
                              </code>
                            </div>
                          </div>
                        </div>
                      </div>

                      <div className="rounded-lg border border-foreground/12 bg-muted/40 p-3 text-foreground/80">
                        <p className="font-medium mb-1 text-foreground">
                          Metadata JSON example
                        </p>
                        <p className="mb-2">
                          Create this file yourself — Knowledge Compass does not generate it from the CSV. Copy or download the example, then upload it next to your file.
                        </p>
                        <pre className="overflow-x-auto rounded-md border border-foreground/10 bg-white p-2 font-mono text-[11px] leading-relaxed text-foreground">
                          {exampleMetadataContents(
                            primaryFile?.name || "guidance-resources.csv"
                          )}
                        </pre>
                        {primaryFile ? (
                          <div className="mt-2 flex flex-wrap gap-2">
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              className="h-8"
                              onClick={handleCopyExampleMetadata}
                            >
                              <Copy className="mr-1.5 h-3.5 w-3.5" />
                              {copiedMetadata ? "Copied" : "Copy JSON"}
                            </Button>
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              className="h-8"
                              onClick={handleDownloadExampleMetadata}
                            >
                              <Download className="mr-1.5 h-3.5 w-3.5" />
                              Download {expectedMetadataFileName(primaryFile.name)}
                            </Button>
                          </div>
                        ) : null}
                      </div>
                    </div>
                  </div>
                  )}

                  {/* Zip upload tab */}
                  {uploadTab === "zip" && (
                  <div className="grid gap-4 py-4">
                    <div className="text-sm text-gray-600">
                      Zip CSV or Markdown guidance files together with a matching{" "}
                      <code className="bg-gray-100 px-1 rounded">{"<filename>.metadata.json"}</code>{" "}
                      sidecar for each one. Duplicates are skipped automatically.
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
                        onClick={() => document.getElementById("zip-upload")?.click()}
                      >
                        <div className="flex flex-col items-center gap-2">
                          {zipValidating ? (
                            <Loader2 className="h-8 w-8 text-gray-400 animate-spin" />
                          ) : (
                            <Archive className="h-8 w-8 text-gray-400" />
                          )}
                          <span className="text-sm font-medium text-gray-600">
                            {zipValidating ? "Validating zip..." : "Drag and drop a .zip file"}
                          </span>
                          <span className="text-xs text-gray-400">or click to browse (max 200MB)</span>
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
                            <span className="text-sm font-medium">{zipFile.name}</span>
                            <span className="text-xs text-gray-500">{formatSizeMb(zipFile)}</span>
                          </div>
                          <button
                            type="button"
                            className="text-xs text-gray-400 hover:text-gray-600"
                            onClick={() => { setZipFile(null); setZipPairs([]); setZipStatus({ type: null, message: "" }); }}
                          >
                            Remove
                          </button>
                        </div>

                        {zipPairs.length > 0 && (
                          <div className="border rounded-lg overflow-hidden">
                            <div className="bg-gray-50 px-3 py-2 text-xs font-semibold text-gray-600 border-b">
                              {zipPairs.filter(p => !p.error).length} valid pair(s) · {zipPairs.filter(p => p.error).length} with errors
                            </div>
                            <div className="max-h-48 overflow-y-auto divide-y divide-gray-100">
                              {zipPairs.map((pair, i) => (
                                <div key={i} className={`flex items-center justify-between px-3 py-2 text-xs ${pair.error ? "bg-red-50" : ""}`}>
                                  <div className="flex items-center gap-2 min-w-0">
                                    <FileText className={`h-3.5 w-3.5 flex-shrink-0 ${pair.error ? "text-red-400" : "text-primary"}`} />
                                    <span className="truncate font-mono">{pair.primaryFile.name}</span>
                                  </div>
                                  {pair.error ? (
                                    <span className="text-red-600 ml-2 flex-shrink-0">{pair.error}</span>
                                  ) : (
                                    <span className="text-green-600 ml-2 flex-shrink-0">✓ paired</span>
                                  )}
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    )}

                    {zipStatus.message && (
                      <div className={`text-sm p-2 rounded ${zipStatus.type === "success" ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"}`}>
                        {zipStatus.message}
                      </div>
                    )}
                  </div>
                  )}

                  {uploadTab === "video" && (
                  <div className="grid gap-4 py-4">
                    <div className="text-sm text-gray-600">
                      Upload a video or audio file. Amazon Transcribe processes it automatically; when that finishes, Knowledge Compass embeds the transcript. Provide the public URL users should be sent to (usually YouTube).
                    </div>
                    <div className="space-y-2">
                      <div className="text-sm font-medium text-gray-900">Video or audio file</div>
                      {!videoFile ? (
                        <div
                          className="border-2 border-dashed border-gray-300 rounded-lg p-6 text-center hover:bg-gray-50 transition-colors cursor-pointer"
                          onDragOver={(e) => e.preventDefault()}
                          onDrop={(e) => {
                            e.preventDefault();
                            const droppedFile = e.dataTransfer.files?.[0];
                            if (droppedFile) handleVideoFileSelect(droppedFile);
                          }}
                          onClick={() => document.getElementById("video-upload")?.click()}
                        >
                          <div className="flex flex-col items-center gap-2">
                            <Film className="h-8 w-8 text-gray-400" />
                            <span className="text-sm font-medium text-gray-600">
                              Drag and drop mp4, webm, mp3, wav, or m4a
                            </span>
                            <span className="text-xs text-gray-400">or click to browse (max 1 GB)</span>
                          </div>
                          <Input
                            id="video-upload"
                            type="file"
                            className="hidden"
                            accept=".mp4,.webm,.mp3,.wav,.flac,.ogg,.m4a,.m4v,.amr,video/mp4,video/webm,audio/*"
                            onChange={(e) => {
                              const selectedFile = e.target.files?.[0];
                              if (selectedFile) handleVideoFileSelect(selectedFile);
                            }}
                          />
                        </div>
                      ) : (
                        <div className="border rounded-lg p-4 bg-gray-50">
                          <div className="flex items-center justify-between mb-2">
                            <div className="flex items-center gap-2 overflow-hidden">
                              <Film className="h-5 w-5 text-primary flex-shrink-0" />
                              <span className="text-sm font-medium truncate">{videoFile.name}</span>
                            </div>
                            <button
                              type="button"
                              className="text-xs text-gray-400 hover:text-gray-600"
                              onClick={() => setVideoFile(null)}
                            >
                              Remove
                            </button>
                          </div>
                          <div className="text-xs text-gray-500">{formatSizeMb(videoFile)}</div>
                        </div>
                      )}
                    </div>
                    <div className="space-y-2">
                      <label className="text-sm font-medium text-gray-900" htmlFor="video-title">
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
                      <label className="text-sm font-medium text-gray-900" htmlFor="video-url">
                        Public video URL
                      </label>
                      <Input
                        id="video-url"
                        value={videoUrl}
                        onChange={(e) => setVideoUrl(e.target.value)}
                        placeholder="https://www.youtube.com/watch?v=..."
                      />
                      <p className="text-xs text-gray-500">
                        Used in citations and timestamp deep-links. Transcription starts as soon as you upload.
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

                  <DialogFooter>
                    <Button variant="outline" onClick={resetUploadDialog} disabled={uploading || zipUploading}>
                      Cancel
                    </Button>
                    {uploadTab === "single" ? (
                      <Button
                        className="bg-primary hover:bg-primary/90"
                        onClick={handleUpload}
                        disabled={!primaryFile || !metadataFile || uploading}
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
                    ) : (
                      <Button
                        className="bg-primary hover:bg-primary/90"
                        onClick={handleZipUpload}
                        disabled={!zipFile || zipPairs.filter(p => !p.error).length === 0 || zipUploading || zipValidating}
                      >
                        {zipUploading ? (
                          <>
                            <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
                            Uploading...
                          </>
                        ) : (
                          `Upload & Stage ${zipPairs.filter(p => !p.error).length} pair(s)`
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
                  <TableHead className="w-[45%]">Name</TableHead>
                  <TableHead className="w-[10%]">Type</TableHead>
                  <TableHead className="w-[12%]">Status</TableHead>
                  <TableHead className="w-[16%]">Uploaded</TableHead>
                  <TableHead className="w-[16%]">Completed</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading ? (
                  <TableRow>
                    <TableCell colSpan={5} className="py-10">
                      <div className="flex items-center justify-center gap-2 text-gray-500">
                        <Loader2 className="h-4 w-4 animate-spin" />
                        <span>Loading data sources...</span>
                      </div>
                    </TableCell>
                  </TableRow>
                ) : pagedDataSources.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={5} className="text-center py-10 text-gray-500">
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
                      ((ds.type === "csv" || ds.type === "markdown") && !!jsonByCsvName.get(ds.name));
                    const isOpen = !!expanded[ds.id];

                    return (
                      <>
                        <TableRow key={ds.id} className={isOpen ? "bg-gray-50/50" : ""}>
                          <TableCell className="align-top">
                            <div className="flex items-start gap-2">
                              {isExpandable ? (
                                <button
                                  type="button"
                                  className="mt-0.5 text-xs rounded border border-gray-200 px-2 py-1 text-gray-600 hover:bg-gray-50"
                                  onClick={() =>
                                    setExpanded((prev) => ({ ...prev, [ds.id]: !prev[ds.id] }))
                                  }
                                  title={isOpen ? "Hide details" : "Show details"}
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
                            <Badge variant="secondary">{typeLabel(ds.type)}</Badge>
                          </TableCell>

                          <TableCell className="align-top">{statusBadge(status)}</TableCell>

                          <TableCell className="align-top text-sm text-gray-700">
                            {formatDateTime(ds.created_at)}
                          </TableCell>

                          <TableCell className="align-top text-sm text-gray-700">
                            {formatDateTime(run?.completed_at ?? null)}
                          </TableCell>
                        </TableRow>

                        {isOpen ? (
                          <TableRow key={`${ds.id}-sub`}>
                            <TableCell colSpan={5} className="bg-gray-50/70">
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
                                        {(ds.include_patterns ?? []).map((p, i) => (
                                          <div key={i} className="break-all">
                                            {p}
                                          </div>
                                        ))}
                                      </div>
                                    </div>
                                  ) : (
                                    <div className="text-xs text-gray-500">No include patterns.</div>
                                  )}

                                  {(ds.exclude_patterns?.length ?? 0) > 0 ? (
                                    <div>
                                      <div className="text-xs font-semibold text-gray-600 mb-1">
                                        Exclude patterns
                                      </div>
                                      <div className="text-xs font-mono bg-white border border-gray-200 rounded p-3 overflow-auto">
                                        {(ds.exclude_patterns ?? []).map((p, i) => (
                                          <div key={i} className="break-all">
                                            {p}
                                          </div>
                                        ))}
                                      </div>
                                    </div>
                                  ) : (
                                    <div className="text-xs text-gray-500">No exclude patterns.</div>
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
                                    <div className="text-xs font-semibold text-gray-600 mb-1">Public URL</div>
                                    <a
                                      href={String(ds.metadata?.video_url || "")}
                                      target="_blank"
                                      rel="noreferrer"
                                      className="text-primary break-all underline underline-offset-2"
                                    >
                                      {String(ds.metadata?.video_url || "—")}
                                    </a>
                                  </div>
                                  <div className="text-xs text-gray-600">
                                    Transcription: {String(ds.metadata?.transcribe_status || "not started")}
                                  </div>
                                  {run?.error_message ? (
                                    <div className="text-xs text-red-600 bg-red-50 border border-red-200 rounded p-3">
                                      {run.error_message}
                                    </div>
                                  ) : null}
                                </div>
                              ) : ds.type === "csv" || ds.type === "markdown" ? (
                                (() => {
                                  const json = jsonByCsvName.get(ds.name);
                                  const jsonRun = json ? latestRunBySourceId.get(json.id) : undefined;
                                  const jsonStatus = jsonRun?.status ?? "no_runs";

                                  return (
                                    <div className="space-y-5">
                                      <div className="space-y-2">
                                        <div className="text-sm font-medium text-gray-800">
                                          Metadata JSON file
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
                                                <Badge variant="secondary">{typeLabel(json.type)}</Badge>
                                              </div>

                                              <div className="px-3 py-3 border-r border-gray-100">
                                                {statusBadge(jsonStatus)}
                                              </div>

                                              <div className="px-3 py-3 border-r border-gray-100 text-xs text-gray-700">
                                                {formatDateTime(json.created_at)}
                                              </div>

                                              <div className="px-3 py-3 border-r border-gray-100 text-xs text-gray-700">
                                                {formatDateTime(jsonRun?.completed_at ?? null)}
                                              </div>
                                            </div>
                                          </div>
                                        ) : (
                                          <div className="text-xs text-gray-500">
                                            No metadata JSON found for this CSV or Markdown.
                                          </div>
                                        )}
                                      </div>
                                    </div>
                                  );
                                })()
                              ) : (
                                <div className="text-xs text-gray-500">No details.</div>
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
                Showing <span className="font-medium">{Math.min(startIdx + 1, filteredDataSources.length)}</span> to{" "}
                <span className="font-medium">{Math.min(startIdx + PAGE_SIZE, filteredDataSources.length)}</span> of{" "}
                <span className="font-medium">{filteredDataSources.length}</span>
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