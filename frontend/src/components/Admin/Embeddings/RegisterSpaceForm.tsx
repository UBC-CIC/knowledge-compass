import { useEffect, useId, useState, type ChangeEvent, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  EMPTY_REGISTER_FORM,
  PROVIDERS,
  parseRegisterForm,
  type EmbeddingModelOption,
  type ProviderId,
  type RegisterErrors,
  type RegisterFormValues,
  type RegisterPayload,
} from "@/lib/embeddingSpaces";

/** One labelled field: the label, a help line and an error line are all tied to the control. */
function Field({
  label,
  help,
  error,
  required,
  children,
}: {
  label: string;
  help?: string;
  error?: string;
  required?: boolean;
  children: (ids: { id: string; describedBy: string | undefined; invalid: true | undefined }) => ReactNode;
}) {
  const id = useId();
  const describedBy = [help ? `${id}-help` : null, error ? `${id}-error` : null].filter(Boolean).join(" ") || undefined;
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>
        {label}
        {required ? <span className="font-normal text-foreground/70"> (required)</span> : null}
      </Label>
      {children({ id, describedBy, invalid: error ? true : undefined })}
      {help ? (
        <p id={`${id}-help`} className="text-xs leading-normal text-foreground/70">
          {help}
        </p>
      ) : null}
      {error ? (
        <p id={`${id}-error`} className="text-xs text-red-700">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Form for POST /admin/embedding-spaces. A new space starts in "building" and does not
 * change what families get until it is activated. The model id and the Bedrock call
 * target come from Amazon Bedrock for the model you select. Prices and end-of-life
 * dates are whatever the administrator enters.
 */
export default function RegisterSpaceForm({
  busy,
  serverError,
  models,
  modelsLoading,
  modelsError,
  onReloadModels,
  onSubmit,
  onCancel,
}: {
  busy: boolean;
  serverError: string | null;
  models: EmbeddingModelOption[];
  modelsLoading: boolean;
  modelsError: string | null;
  onReloadModels: () => void;
  onSubmit: (payload: RegisterPayload) => void;
  onCancel: () => void;
}) {
  const [values, setValues] = useState<RegisterFormValues>(EMPTY_REGISTER_FORM);
  const [submitted, setSubmitted] = useState(false);
  const result = parseRegisterForm(values);
  const errors: RegisterErrors = submitted && !result.ok ? result.errors : {};
  const selected = models.find((model) => model.provider === values.provider) ?? null;
  const dimensionChoices = selected?.dimensions.length ? selected.dimensions : PROVIDERS[values.provider].dimensions;
  const canRegister = !modelsLoading && !modelsError && selected?.available === true;

  const set = <K extends keyof RegisterFormValues>(key: K, value: RegisterFormValues[K]) =>
    setValues((v) => ({ ...v, [key]: value }));

  const dimensionsFor = (provider: ProviderId) => {
    const model = models.find((item) => item.provider === provider);
    return model?.dimensions.length ? model.dimensions : PROVIDERS[provider].dimensions;
  };

  const setProvider = (provider: ProviderId) =>
    setValues((v) => {
      const dims = dimensionsFor(provider);
      return { ...v, provider, dimensions: dims.includes(v.dimensions) ? v.dimensions : dims.includes(1024) ? 1024 : dims[0] };
    });

  // Keep the selection on a model Amazon Bedrock can actually call.
  useEffect(() => {
    const available = models.filter((model) => model.available);
    if (available.length === 0) return;
    setValues((v) => {
      const current = available.find((model) => model.provider === v.provider);
      const next = current ?? available[0];
      const dims = next.dimensions.length ? next.dimensions : PROVIDERS[next.provider].dimensions;
      const dimensions = dims.includes(v.dimensions) ? v.dimensions : dims.includes(1024) ? 1024 : dims[0];
      if (next.provider === v.provider && dimensions === v.dimensions) return v;
      return { ...v, provider: next.provider, dimensions };
    });
  }, [models]);

  const text =
    (key: keyof RegisterFormValues) =>
    (e: ChangeEvent<HTMLInputElement>) =>
      set(key, e.target.value as never);

  return (
    <form
      className="space-y-4"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        setSubmitted(true);
        if (result.ok && canRegister) onSubmit(result.payload);
      }}
    >
      <Field label="Name" required help="Lowercase letters, digits, '-' or '_'. For example titan-v2-1024." error={errors.name}>
        {({ id, describedBy, invalid }) => (
          <Input id={id} value={values.name} onChange={text("name")} aria-describedby={describedBy} aria-invalid={invalid} autoComplete="off" />
        )}
      </Field>

      {modelsLoading ? (
        <p role="status" className="text-sm text-foreground/75">
          Loading models from Amazon Bedrock…
        </p>
      ) : modelsError ? (
        <div className="space-y-2">
          <p role="alert" className="text-sm text-red-700">
            {modelsError}
          </p>
          <Button type="button" variant="outline" onClick={onReloadModels}>
            Try again
          </Button>
        </div>
      ) : models.length === 0 ? (
        <p role="status" className="text-sm text-foreground/75">
          Amazon Bedrock did not return any embedding models this app can call.
        </p>
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field
              label="Model"
              required
              help="Amazon Bedrock supplies the model id and the call target for the model you choose."
              error={errors.provider}
            >
              {({ id, describedBy, invalid }) => (
                <Select value={values.provider} onValueChange={(v) => setProvider(v as ProviderId)}>
                  <SelectTrigger id={id} className="w-full" aria-describedby={describedBy} aria-invalid={invalid}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {models.map((model) => (
                      <SelectItem key={model.provider} value={model.provider} disabled={!model.available}>
                        {model.available ? model.label : `${model.label} (not available)`}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </Field>
            <Field label="Dimensions" required help="The choices depend on the model." error={errors.dimensions}>
              {({ id, describedBy, invalid }) => (
                <Select value={String(values.dimensions)} onValueChange={(v) => set("dimensions", Number(v))}>
                  <SelectTrigger id={id} className="w-full" aria-describedby={describedBy} aria-invalid={invalid}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {dimensionChoices.map((d) => (
                      <SelectItem key={d} value={String(d)}>
                        {d}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </Field>
          </div>

          {models
            .filter((model) => !model.available)
            .map((model) => (
              <p key={model.provider} className="text-xs leading-normal text-foreground/70">
                {model.label}: {model.unavailable_reason ?? "Not available in Amazon Bedrock."}
              </p>
            ))}

          {selected?.available ? (
            <div className="space-y-2 rounded-lg border border-foreground/12 bg-muted/40 px-3 py-2 text-sm">
              <dl className="grid grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-[max-content_1fr]">
                <dt className="text-foreground/70">Model id</dt>
                <dd className="min-w-0 break-all font-semibold">{selected.model_id}</dd>
                <dt className="text-foreground/70">Called as</dt>
                <dd className="min-w-0 break-all font-semibold">{selected.invoke_target}</dd>
              </dl>
              {selected.cross_region ? (
                <p className="text-xs leading-normal text-foreground/75">
                  This model is called through a cross-region inference profile. The text of your content and of families'
                  questions may be processed outside this region.
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Version" help="Short label. Defaults to 1." error={errors.version}>
          {({ id, describedBy, invalid }) => (
            <Input id={id} value={values.version} onChange={text("version")} aria-describedby={describedBy} aria-invalid={invalid} autoComplete="off" />
          )}
        </Field>
        <Field label="Price per 1 million tokens (USD)" help="Optional. Without it, cost estimates say “price not configured”." error={errors.price_per_1m_tokens}>
          {({ id, describedBy, invalid }) => (
            <Input id={id} inputMode="decimal" value={values.price_per_1m_tokens} onChange={text("price_per_1m_tokens")} aria-describedby={describedBy} aria-invalid={invalid} autoComplete="off" />
          )}
        </Field>
        <Field label="End-of-life date" help="Optional. Written YYYY-MM-DD. The weekly lifecycle check uses it." error={errors.eol_date}>
          {({ id, describedBy, invalid }) => (
            <Input id={id} placeholder="YYYY-MM-DD" value={values.eol_date} onChange={text("eol_date")} aria-describedby={describedBy} aria-invalid={invalid} autoComplete="off" />
          )}
        </Field>
        <Field label="Minimum match score" help="Optional, 0 to 1. Leave empty to use the app default." error={errors.min_score}>
          {({ id, describedBy, invalid }) => (
            <Input id={id} inputMode="decimal" value={values.min_score} onChange={text("min_score")} aria-describedby={describedBy} aria-invalid={invalid} autoComplete="off" />
          )}
        </Field>
        <Field label="Split threshold" help="Optional, 0 to 1. Used when splitting new content." error={errors.split_threshold}>
          {({ id, describedBy, invalid }) => (
            <Input id={id} inputMode="decimal" value={values.split_threshold} onChange={text("split_threshold")} aria-describedby={describedBy} aria-invalid={invalid} autoComplete="off" />
          )}
        </Field>
      </div>

      <details className="rounded-lg border border-foreground/12 px-3 py-2">
        <summary className="cursor-pointer text-sm font-semibold">Advanced embedding settings (optional)</summary>
        <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Field label="Batch size" help="1 to 256." error={errors.batch_size}>
            {({ id, describedBy, invalid }) => (
              <Input id={id} inputMode="numeric" value={values.batch_size} onChange={text("batch_size")} aria-describedby={describedBy} aria-invalid={invalid} autoComplete="off" />
            )}
          </Field>
          <Field label="Longest text (characters)" help="100 to 50,000." error={errors.max_chars}>
            {({ id, describedBy, invalid }) => (
              <Input id={id} inputMode="numeric" value={values.max_chars} onChange={text("max_chars")} aria-describedby={describedBy} aria-invalid={invalid} autoComplete="off" />
            )}
          </Field>
          <Field label="Parallel requests" help="1 to 32." error={errors.concurrency}>
            {({ id, describedBy, invalid }) => (
              <Input id={id} inputMode="numeric" value={values.concurrency} onChange={text("concurrency")} aria-describedby={describedBy} aria-invalid={invalid} autoComplete="off" />
            )}
          </Field>
        </div>
      </details>

      {submitted && !result.ok ? (
        <p role="alert" className="text-sm text-red-700">
          Fix the highlighted fields to continue.
        </p>
      ) : null}
      {serverError ? (
        <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {serverError}
        </p>
      ) : null}

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button type="button" variant="outline" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button type="submit" disabled={busy || !canRegister}>
          {busy ? "Registering…" : "Register search index"}
        </Button>
      </div>
    </form>
  );
}
