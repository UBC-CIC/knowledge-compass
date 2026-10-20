import { useId, useRef, useState, type DragEvent } from "react";
import { FileText, Trash2, Upload } from "lucide-react";
import { GUIDE_ACCEPT, STATUS_TEXT, type GuidelineDocument, type GuidelineStatus } from "@/lib/guideline";
import { Rating } from "@/components/Admin/Prompts/parts";
import type { SectionFeedback } from "@/types/journeys";

const STATUS_CLASS: Record<GuidelineStatus, string> = {
  processing: "border-amber-300 bg-amber-50 text-amber-900",
  ready: "border-emerald-300 bg-emerald-50 text-emerald-900",
  failed: "border-red-300 bg-red-50 text-red-800",
};

/**
 * Documents whose situations this journey answers from. Several files are
 * allowed. The server rejects a file that repeats a situation another ready
 * file already covers.
 */
export default function JourneyGuides({
  journeyId,
  documents,
  sectionFeedback,
  upload,
  remove,
  rename,
}: {
  journeyId: string;
  documents: GuidelineDocument[];
  sectionFeedback?: SectionFeedback[];
  upload: (files: File[], replaceDocumentId?: string, journeyId?: string) => Promise<string[]>;
  remove: (documentId: string) => Promise<void>;
  rename: (sectionId: string, label: string) => Promise<void>;
}) {
  const fileInputId = useId();
  const fileInput = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);
  const [notice, setNotice] = useState<string | null>(null);

  const runUpload = async (files: File[], replaceId?: string) => {
    if (!files.length) return;
    setUploading(true);
    setProblems([]);
    setNotice(null);
    try {
      const failed = await upload(files, replaceId, journeyId);
      setProblems(failed);
      const ok = files.length - failed.length;
      if (ok > 0) setNotice(ok === 1 ? "The assistant is reading that file." : `The assistant is reading ${ok} files.`);
    } finally {
      setUploading(false);
    }
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragging(false);
    void runUpload(Array.from(e.dataTransfer.files));
  };

  return (
    <section className="flex flex-col gap-3" aria-labelledby={`${journeyId}-guides`}>
      <div>
        <h3 id={`${journeyId}-guides`} className="text-[15px] font-bold">
          Documents
        </h3>
        <p className="mt-0.5 max-w-[560px] text-[13px] leading-normal text-foreground/75">
          Upload the guides for this journey. A journey can have several files. Each situation belongs in only one of
          them. Headings mark the situations.
        </p>
      </div>
      {notice ? <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-900">{notice}</p> : null}
      {problems.map((problem) => (
        <p key={problem} role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {problem}
        </p>
      ))}
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={`flex flex-col items-center gap-2 rounded-[12px] border-2 border-dashed px-4 py-6 text-center ${
          dragging ? "border-primary bg-[oklch(0.96_0.02_268)]" : "border-foreground/18 bg-white"
        }`}
      >
        <Upload className="h-5 w-5 text-foreground/60" aria-hidden="true" />
        <p className="text-[13.5px] text-foreground/80">Drop Markdown, Word or PDF files here, or choose them.</p>
        <label htmlFor={fileInputId} className={`${uploading ? "pointer-events-none opacity-60" : ""} cursor-pointer text-sm font-semibold text-primary`}>
          {uploading ? "Uploading…" : "Choose files"}
        </label>
        <input
          id={fileInputId}
          ref={fileInput}
          type="file"
          accept={GUIDE_ACCEPT}
          multiple
          className="sr-only"
          onChange={(e) => {
            void runUpload(Array.from(e.target.files ?? []));
            e.target.value = "";
          }}
        />
      </div>
      {documents.length ? (
        <ul className="flex flex-col gap-2">
          {documents.map((doc) => (
          <DocumentRow
            key={doc.id}
            doc={doc}
            sectionFeedback={sectionFeedback}
              onReplace={(file) => runUpload([file], doc.id)}
              onRemove={async () => {
                await remove(doc.id);
                setNotice(`"${doc.file_name}" was removed.`);
              }}
              onRename={rename}
            />
          ))}
        </ul>
      ) : (
        <p className="text-[13px] text-foreground/70">No documents yet. Until one is ready, the assistant uses the text below.</p>
      )}
    </section>
  );
}

function DocumentRow({
  doc,
  sectionFeedback,
  onReplace,
  onRemove,
  onRename,
}: {
  doc: GuidelineDocument;
  sectionFeedback?: SectionFeedback[];
  onReplace: (file: File) => void;
  onRemove: () => Promise<void>;
  onRename: (sectionId: string, label: string) => Promise<void>;
}) {
  const replaceId = useId();
  return (
    <li className="rounded-[11px] border border-foreground/12 bg-white px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-2 text-sm font-semibold">
          <FileText className="h-4 w-4 flex-none text-foreground/60" aria-hidden="true" />
          <span className="truncate">{doc.file_name}</span>
        </span>
        <span className={`rounded-full border px-2 py-0.5 text-[12px] font-semibold ${STATUS_CLASS[doc.status]}`}>
          {STATUS_TEXT[doc.status]}
        </span>
      </div>
      {doc.error ? <p className="mt-2 text-[13px] text-red-700">{doc.error}</p> : null}
      {doc.sections.length ? (
        <ul className="mt-2 flex flex-col gap-1">
          {doc.sections.map((section) => {
            const rating = (sectionFeedback ?? []).find((item) => item.key === section.section_key);
            return (
            <li key={section.id} className="flex flex-col gap-1 border-t border-foreground/8 py-2 text-[13px] first:border-t-0">
              <span className="flex flex-wrap items-center justify-between gap-2">
                <span>{section.label}</span>
                <button
                type="button"
                className="font-semibold text-primary hover:underline"
                onClick={() => {
                  const next = window.prompt("Situation name", section.label);
                  if (next === null) return;
                  void onRename(section.id, next);
                }}
              >
                  Rename
                </button>
              </span>
              {rating ? (
                <Rating
                  count={{
                    key: section.section_key,
                    name: section.label,
                    is_archived: false,
                    up: rating.up,
                    down: rating.down,
                    sessions: rating.sessions,
                  }}
                />
              ) : null}
            </li>
            );
          })}
        </ul>
      ) : null}
      <div className="mt-2 flex gap-3 text-[13px] font-semibold">
        <label htmlFor={replaceId} className="cursor-pointer text-primary">
          Replace
        </label>
        <input
          id={replaceId}
          type="file"
          accept={GUIDE_ACCEPT}
          className="sr-only"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) onReplace(file);
            e.target.value = "";
          }}
        />
        <button type="button" className="inline-flex items-center gap-1 text-destructive" onClick={() => void onRemove()}>
          <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
          Remove
        </button>
      </div>
    </li>
  );
}
