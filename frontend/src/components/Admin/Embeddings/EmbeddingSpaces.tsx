import { useCallback, useEffect, useId, useState, type ReactNode } from "react";
import { Plus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useEmbeddingJob, useEmbeddingSpaces } from "@/hooks/useEmbeddingSpaces";
import {
  PROVIDERS,
  PURGE_RETENTION_DAYS,
  STATUS_TEXT,
  canActivate,
  canBuild,
  canPurge,
  canRollback,
  canStartRebuild,
  canValidate,
  coverageText,
  formatDate,
  jobProgressText,
  purgeEligibilityText,
  type EmbeddingJob,
  type EmbeddingModelOption,
  type EmbeddingSpace,
  type RegisterPayload,
  type SpaceStatus,
} from "@/lib/embeddingSpaces";
import ConfirmDialog from "@/components/Admin/Embeddings/ConfirmDialog";
import RegisterSpaceForm from "@/components/Admin/Embeddings/RegisterSpaceForm";
import SpaceJobPanel from "@/components/Admin/Embeddings/SpaceJobPanel";

const STATUS_CLASS: Record<SpaceStatus, string> = {
  building: "border-amber-300 bg-amber-50 text-amber-900",
  validated: "border-sky-300 bg-sky-50 text-sky-900",
  active: "border-emerald-300 bg-emerald-50 text-emerald-900",
  retired: "border-foreground/20 bg-muted text-foreground/80",
  purged: "border-red-300 bg-red-50 text-red-800",
};

type Confirm = { kind: "activate" | "rollback" | "purge"; space: EmbeddingSpace } | null;

function Section({ title, description, children }: { title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <Card className="rounded-[13px] border-foreground/12 shadow-sm">
      <CardHeader>
        <CardTitle className="text-[18.5px] font-bold tracking-[-0.01em]">{title}</CardTitle>
        {description ? <CardDescription className="text-[13.5px] leading-relaxed">{description}</CardDescription> : null}
      </CardHeader>
      <CardContent className="space-y-4">{children}</CardContent>
    </Card>
  );
}

function Detail({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="contents">
      <dt className="text-foreground/70">{label}</dt>
      <dd className="min-w-0 break-all font-semibold">{value}</dd>
    </div>
  );
}

const errorText = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);

export default function EmbeddingSpaces() {
  const { state, loading, error, reload, loadModels, register, startJob, validate, cutover, purge } = useEmbeddingSpaces();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tracked, setTracked] = useState<{ spaceId: string; jobId: string } | null>(null);
  const [registerOpen, setRegisterOpen] = useState(false);
  const [registerBusy, setRegisterBusy] = useState(false);
  const [registerError, setRegisterError] = useState<string | null>(null);
  const [models, setModels] = useState<EmbeddingModelOption[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [modelAttempt, setModelAttempt] = useState(0);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [typedName, setTypedName] = useState("");
  // Skip the golden-set comparison with the live index. Only for when the live model no
  // longer works and cannot answer the test questions; coverage is always checked.
  const [skipQuality, setSkipQuality] = useState(false);
  const [confirmSkipQuality, setConfirmSkipQuality] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [now, setNow] = useState(() => new Date());
  const typedId = useId();

  // The model list is loaded when the register dialog opens, and again on Try again.
  useEffect(() => {
    if (!registerOpen) return;
    let cancelled = false;
    setModelsLoading(true);
    setModelsError(null);
    loadModels()
      .then((next) => {
        if (!cancelled) setModels(next);
      })
      .catch((e) => {
        console.error(e);
        if (!cancelled) {
          setModels([]);
          setModelsError(errorText(e, "Couldn't load embedding models from Amazon Bedrock."));
        }
      })
      .finally(() => {
        if (!cancelled) setModelsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [registerOpen, modelAttempt, loadModels]);

  // Keep "can be purged from ..." current without a reload.
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const spaces = state?.spaces ?? [];
  const locked = state?.cutover_locked ?? false;
  const defaultId =
    spaces.find((s) => s.status === "building" || s.status === "validated")?.id ??
    state?.active_space_id ??
    spaces[0]?.id ??
    null;
  const selected = spaces.find((s) => s.id === (selectedId ?? defaultId)) ?? null;

  // Follow the job the administrator just started, else the selected space's latest job.
  const shownJobId = selected ? (tracked?.spaceId === selected.id ? tracked.jobId : selected.latest_job?.id ?? null) : null;
  const onFinished = useCallback(
    (finished: EmbeddingJob) => {
      setNotice(jobProgressText(finished));
      reload(true);
    },
    [reload]
  );
  const { job: fetchedJob, error: jobError } = useEmbeddingJob(shownJobId, onFinished);
  const job = fetchedJob && fetchedJob.id === shownJobId ? fetchedJob : null;

  const run = async (action: () => Promise<void>, failure: string) => {
    setBusy(true);
    setActionError(null);
    setNotice(null);
    try {
      await action();
    } catch (e) {
      console.error(e);
      setActionError(errorText(e, failure));
    } finally {
      setBusy(false);
    }
  };

  const startJobFor = (space: EmbeddingSpace, mode: "dry_run" | "rebuild") =>
    run(async () => {
      const jobId = await startJob(space.id, mode);
      setTracked({ spaceId: space.id, jobId });
      setNotice(mode === "dry_run" ? "Dry run started. It only counts and estimates; nothing is written." : "Rebuild started. Chat and syncing keep working.");
    }, mode === "dry_run" ? "Couldn't start the dry run." : "Couldn't start the rebuild.");

  const validateSpace = (space: EmbeddingSpace) =>
    run(async () => {
      const jobId = await validate(space.id, { skipQuality });
      setTracked({ spaceId: space.id, jobId });
      setNotice(
        skipQuality
          ? "Validation started. Only coverage is checked; search quality is not compared with the live index."
          : "Validation started."
      );
    }, "Couldn't start the validation.");

  const submitRegister = async (payload: RegisterPayload) => {
    setRegisterBusy(true);
    setRegisterError(null);
    try {
      await register(payload);
      setRegisterOpen(false);
      setSelectedId(null);
      setNotice(`"${payload.name}" was registered as Building. It does not change what families get until you activate it.`);
    } catch (e) {
      console.error(e);
      setRegisterError(errorText(e, "Couldn't register the search index."));
    } finally {
      setRegisterBusy(false);
    }
  };

  const openConfirm = (kind: "activate" | "rollback" | "purge", space: EmbeddingSpace) => {
    setConfirm({ kind, space });
    setConfirmError(null);
    setTypedName("");
    setConfirmSkipQuality(false);
  };
  const closeConfirm = () => {
    if (!confirmBusy) setConfirm(null);
  };

  const runConfirm = async () => {
    if (!confirm) return;
    const { kind, space } = confirm;
    setConfirmBusy(true);
    setConfirmError(null);
    try {
      if (kind === "purge") {
        await purge(space, typedName);
        setNotice(`"${space.name}" was purged. Its vectors and index were deleted.`);
      } else {
        const jobId = await cutover(space.id, kind, { skipQuality: kind === "activate" && confirmSkipQuality });
        setTracked({ spaceId: space.id, jobId });
        setSelectedId(space.id);
        setNotice(
          kind === "activate"
            ? `Switching to "${space.name}". Syncing pauses for a few minutes; chat keeps working.`
            : `Rolling back to "${space.name}". Syncing pauses for a few minutes; chat keeps working.`
        );
      }
      setConfirm(null);
    } catch (e) {
      console.error(e);
      setConfirmError(errorText(e, "That didn't work. Nothing was changed."));
    } finally {
      setConfirmBusy(false);
    }
  };

  const confirmCopy = (c: NonNullable<Confirm>) => {
    const name = c.space.name;
    if (c.kind === "activate") {
      return {
        title: `Switch to "${name}"?`,
        confirmLabel: "Switch to this index",
        destructive: false,
        body: (
          <>
            <p>
              The assistant will start searching with this index. Chat keeps working during the switch. Syncing (adding or
              updating content) pauses for a few minutes while the new index catches up and is checked.
            </p>
            <p>
              The current index is kept for {PURGE_RETENTION_DAYS} days, so you can switch back with Roll back. If a check
              after the switch fails, nothing switches back automatically; you decide.
            </p>
          </>
        ),
      };
    }
    if (c.kind === "rollback") {
      return {
        title: `Roll back to "${name}"?`,
        confirmLabel: "Roll back to this index",
        destructive: false,
        body: (
          <>
            <p>
              The assistant will go back to searching with this older index after it has been brought up to date. Chat keeps
              working during the switch. Syncing pauses for a few minutes.
            </p>
            <p>The index that is live now will be kept as a retired index.</p>
          </>
        ),
      };
    }
    return {
      title: `Delete the "${name}" index?`,
      confirmLabel: "Delete this index permanently",
      destructive: true,
      body: (
        <>
          <p>
            This permanently deletes every vector and the search index of "{name}". It cannot be undone, and you will not be
            able to roll back to it. Chunks and sources are not touched.
          </p>
          <p>Type the name of the index below to confirm.</p>
        </>
      ),
    };
  };

  const copy = confirm ? confirmCopy(confirm) : null;

  const rebuildReady = selected ? canStartRebuild(selected, job) : false;

  return (
    <div className="mx-auto max-w-[1100px] space-y-6">
      <div>
        <h1 className="font-serif text-[30px] font-semibold leading-tight tracking-[-0.015em]">Search index</h1>
        <p className="mt-2 text-[15.5px] leading-relaxed text-foreground/80">
          The assistant finds the right passages in your content with a search index built by an embedding model. To change
          the model, build a new index next to the live one, check it, then switch. Chat keeps working while the new index
          is built. Only syncing pauses, for a few minutes, during the switch.
        </p>
      </div>

      {error || actionError ? (
        <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {actionError ?? error}
        </div>
      ) : null}
      <div aria-live="polite" className="sr-only">
        {notice ?? ""}
      </div>
      {notice ? (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">{notice}</div>
      ) : null}
      {locked ? (
        <div role="status" className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          A search index switch is in progress. Syncing is paused for a few minutes and other index actions are unavailable.
          Chat keeps working.
        </div>
      ) : null}

      {loading ? (
        <div className="flex items-center justify-center py-12" role="status" aria-label="Loading the search index">
          <div className="h-8 w-8 animate-spin rounded-full border-b-2 border-primary" />
        </div>
      ) : (
        <>
          <Section
            title="Search indexes"
            description="Each row is one embedding model and size. Only one is live. A retired index is kept for 30 days in case you need to go back."
          >
            <div className="flex justify-end">
              <Button
                type="button"
                onClick={() => {
                  setRegisterError(null);
                  setModelsError(null);
                  setModelsLoading(true);
                  setRegisterOpen(true);
                }}
              >
                <Plus className="mr-2 h-4 w-4" aria-hidden="true" />
                Register a new index
              </Button>
            </div>
            {spaces.length === 0 ? (
              <p className="text-sm text-foreground/75">No search indexes yet.</p>
            ) : (
              <Table>
                <TableCaption className="sr-only">Search indexes. Use Manage to open one.</TableCaption>
                <TableHeader>
                  <TableRow>
                    <TableHead scope="col">Name</TableHead>
                    <TableHead scope="col">Status</TableHead>
                    <TableHead scope="col">Model</TableHead>
                    <TableHead scope="col">Dimensions</TableHead>
                    <TableHead scope="col">Coverage</TableHead>
                    <TableHead scope="col">Minimum score</TableHead>
                    <TableHead scope="col">Activated</TableHead>
                    <TableHead scope="col">Retired</TableHead>
                    <TableHead scope="col">
                      <span className="sr-only">Actions</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {spaces.map((s) => (
                    <TableRow key={s.id} data-state={selected?.id === s.id ? "selected" : undefined}>
                      <TableCell className="font-semibold">{s.name}</TableCell>
                      <TableCell>
                        <Badge variant="outline" className={STATUS_CLASS[s.status]}>
                          {s.is_active ? "Active (live)" : STATUS_TEXT[s.status]}
                        </Badge>
                      </TableCell>
                      <TableCell>{PROVIDERS[s.provider]?.label ?? s.provider}</TableCell>
                      <TableCell>{s.dimensions}</TableCell>
                      <TableCell>{s.status === "purged" ? "Deleted" : coverageText(s.coverage)}</TableCell>
                      <TableCell>{s.min_score ?? "default"}</TableCell>
                      <TableCell>{formatDate(s.activated_at)}</TableCell>
                      <TableCell>{formatDate(s.retired_at)}</TableCell>
                      <TableCell>
                        <Button
                          type="button"
                          size="sm"
                          variant={selected?.id === s.id ? "default" : "outline"}
                          aria-pressed={selected?.id === s.id}
                          aria-label={`Manage ${s.name}`}
                          onClick={() => {
                            if (s.id !== selected?.id) setSkipQuality(false);
                            setSelectedId(s.id);
                          }}
                        >
                          Manage
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </Section>

          {selected ? (
            <Section
              title={`Manage "${selected.name}"`}
              description={
                selected.is_active
                  ? "This is the live index. It is used for every answer."
                  : "Build, check and switch to this index. Nothing here changes what families get until you activate it."
              }
            >
              <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-[13.5px] sm:grid-cols-[max-content_1fr]">
                <Detail label="Status" value={selected.is_active ? "Active (live)" : STATUS_TEXT[selected.status]} />
                <Detail label="Model id" value={selected.model_id} />
                <Detail label="Called as" value={selected.invoke_target} />
                <Detail label="Version" value={selected.version} />
                <Detail label="Coverage" value={selected.status === "purged" ? "Deleted" : coverageText(selected.coverage)} />
                <Detail
                  label="Price per 1 million tokens"
                  value={selected.price_per_1m_tokens == null ? "not configured" : `$${selected.price_per_1m_tokens}`}
                />
                <Detail label="End-of-life date" value={selected.eol_date ? formatDate(selected.eol_date) : "not set"} />
              </dl>

              {selected.status === "building" || selected.status === "validated" ? (
                <div className="space-y-3 rounded-[11px] border border-foreground/12 bg-muted/40 p-4">
                  <h3 className="text-[15px] font-bold">1. Build and check</h3>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      disabled={busy || locked || !canBuild(selected)}
                      onClick={() => startJobFor(selected, "dry_run")}
                    >
                      Dry run (estimate only)
                    </Button>
                    <Button
                      type="button"
                      disabled={busy || locked || !rebuildReady}
                      aria-describedby={`${typedId}-rebuild-hint`}
                      onClick={() => startJobFor(selected, "rebuild")}
                    >
                      Start rebuild
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      disabled={busy || locked || !canValidate(selected)}
                      onClick={() => validateSpace(selected)}
                    >
                      Check quality
                    </Button>
                  </div>
                  <p id={`${typedId}-rebuild-hint`} className="text-xs text-foreground/70">
                    {rebuildReady
                      ? "You have seen the estimate below. Rebuilding embeds only what this index is missing, and can be started again to resume."
                      : "Run a dry run first. Start rebuild turns on once the estimate has finished and you have read it."}
                  </p>
                  <div className="space-y-1">
                    <label className="flex min-h-11 cursor-pointer items-center gap-2 text-[13.5px] text-foreground/85">
                      <input
                        type="checkbox"
                        checked={skipQuality}
                        onChange={(e) => setSkipQuality(e.target.checked)}
                        aria-describedby={`${typedId}-skip-hint`}
                        className="size-[17px] accent-primary"
                      />
                      Skip the search quality comparison with the live index
                    </label>
                    <p id={`${typedId}-skip-hint`} className="text-xs text-foreground/70">
                      Only use this if the live model has stopped working and cannot answer the test questions. Coverage is
                      still checked, but nothing confirms the new index finds the right passages as well as the old one.
                    </p>
                  </div>
                </div>
              ) : null}

              {selected.status === "validated" || selected.status === "retired" ? (
                <div className="space-y-3 rounded-[11px] border border-foreground/12 bg-muted/40 p-4">
                  <h3 className="text-[15px] font-bold">{selected.status === "validated" ? "2. Switch" : "Switch back"}</h3>
                  <div className="flex flex-wrap items-center gap-2">
                    {selected.status === "validated" ? (
                      <Button
                        type="button"
                        disabled={busy || !canActivate(selected, { locked })}
                        onClick={() => openConfirm("activate", selected)}
                      >
                        Activate
                      </Button>
                    ) : (
                      <Button
                        type="button"
                        disabled={busy || !canRollback(selected, { locked })}
                        onClick={() => openConfirm("rollback", selected)}
                      >
                        Roll back to this index
                      </Button>
                    )}
                  </div>
                  <p className="text-xs text-foreground/70">
                    {selected.status === "validated"
                      ? "Only an index that passed the quality check can be activated."
                      : "Goes back to this older index after bringing it up to date."}
                  </p>
                </div>
              ) : null}

              {selected.status === "retired" ? (
                <div className="space-y-3 rounded-[11px] border border-red-200 bg-red-50/40 p-4">
                  <h3 className="text-[15px] font-bold">Delete this index</h3>
                  <p className="text-[13.5px] text-foreground/80">
                    A retired index is kept for {PURGE_RETENTION_DAYS} days. After that you can delete its vectors and index
                    for good. This is never done automatically.
                  </p>
                  <div className="flex flex-wrap items-center gap-3">
                    <Button
                      type="button"
                      variant="destructive"
                      disabled={busy || !canPurge(selected, now, { locked })}
                      aria-describedby={`${typedId}-purge-hint`}
                      onClick={() => openConfirm("purge", selected)}
                    >
                      Purge…
                    </Button>
                    <span id={`${typedId}-purge-hint`} className="text-xs text-foreground/75">
                      {locked ? "Unavailable while an index switch is in progress." : purgeEligibilityText(selected, now)}
                    </span>
                  </div>
                </div>
              ) : null}

              <SpaceJobPanel job={job} error={jobError} />
            </Section>
          ) : null}
        </>
      )}

      <Dialog open={registerOpen} onOpenChange={(next) => (!next && !registerBusy ? setRegisterOpen(false) : undefined)}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Register a new search index</DialogTitle>
            <DialogDescription>
              The index starts as Building. It does not change what families get until you build, check and activate it.
            </DialogDescription>
          </DialogHeader>
          {registerOpen ? (
            <RegisterSpaceForm
              busy={registerBusy}
              serverError={registerError}
              models={models}
              modelsLoading={modelsLoading}
              modelsError={modelsError}
              onReloadModels={() => setModelAttempt((attempt) => attempt + 1)}
              onSubmit={submitRegister}
              onCancel={() => setRegisterOpen(false)}
            />
          ) : null}
        </DialogContent>
      </Dialog>

      {confirm && copy ? (
        <ConfirmDialog
          open
          title={copy.title}
          description={copy.body}
          confirmLabel={copy.confirmLabel}
          destructive={copy.destructive}
          busy={confirmBusy}
          confirmDisabled={confirm.kind === "purge" && typedName !== confirm.space.name}
          error={confirmError}
          onConfirm={runConfirm}
          onCancel={closeConfirm}
        >
          {confirm.kind === "activate" ? (
            <div className="space-y-1">
              <label className="flex min-h-11 cursor-pointer items-center gap-2 text-sm text-foreground/85">
                <input
                  type="checkbox"
                  checked={confirmSkipQuality}
                  onChange={(e) => setConfirmSkipQuality(e.target.checked)}
                  aria-describedby={`${typedId}-activate-skip-hint`}
                  className="size-[17px] accent-primary"
                />
                Skip the search quality checks during the switch
              </label>
              <p id={`${typedId}-activate-skip-hint`} className="text-xs text-foreground/70">
                Only if the live model has stopped working. Coverage is still checked, and after the switch the check only
                confirms the new index finds something.
              </p>
            </div>
          ) : null}
          {confirm.kind === "purge" ? (
            <div className="space-y-1.5">
              <Label htmlFor={typedId}>Type {confirm.space.name} to confirm</Label>
              <Input
                id={typedId}
                value={typedName}
                onChange={(e) => setTypedName(e.target.value)}
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
              />
            </div>
          ) : null}
        </ConfirmDialog>
      ) : null}
    </div>
  );
}
