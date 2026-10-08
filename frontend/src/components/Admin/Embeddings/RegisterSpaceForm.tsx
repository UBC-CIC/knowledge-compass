import { useId, useState, type ChangeEvent, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  EMPTY_REGISTER_FORM,
  PROVIDERS,
  PROVIDER_IDS,
  parseRegisterForm,
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
 * change what families get until it is activated. Prices, end-of-life dates and model ids
 * are whatever the administrator enters: nothing here claims a model is available.
 */
export default function RegisterSpaceForm({
  busy,
  serverError,
  onSubmit,
  onCancel,
}: {
  busy: boolean;
  serverError: string | null;
  onSubmit: (payload: RegisterPayload) => void;
  onCancel: () => void;
}) {
  const [values, setValues] = useState<RegisterFormValues>(EMPTY_REGISTER_FORM);
  const [submitted, setSubmitted] = useState(false);
  const result = parseRegisterForm(values);
  const errors: RegisterErrors = submitted && !result.ok ? result.errors : {};

  const set = <K extends keyof RegisterFormValues>(key: K, value: RegisterFormValues[K]) =>
    setValues((v) => ({ ...v, [key]: value }));

  const setProvider = (provider: ProviderId) =>
    setValues((v) => {
      const dims = PROVIDERS[provider].dimensions;
      return { ...v, provider, dimensions: dims.includes(v.dimensions) ? v.dimensions : dims.includes(1024) ? 1024 : dims[0] };
    });

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
        if (result.ok) onSubmit(result.payload);
      }}
    >
      <Field label="Name" required help="Lowercase letters, digits, '-' or '_'. For example titan-v2-1024." error={errors.name}>
        {({ id, describedBy, invalid }) => (
          <Input id={id} value={values.name} onChange={text("name")} aria-describedby={describedBy} aria-invalid={invalid} autoComplete="off" />
        )}
      </Field>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Provider" required error={errors.provider}>
          {({ id, describedBy, invalid }) => (
            <Select value={values.provider} onValueChange={(v) => setProvider(v as ProviderId)}>
              <SelectTrigger id={id} className="w-full" aria-describedby={describedBy} aria-invalid={invalid}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PROVIDER_IDS.map((p) => (
                  <SelectItem key={p} value={p}>
                    {PROVIDERS[p].label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </Field>
        <Field label="Dimensions" required help="The choices depend on the provider." error={errors.dimensions}>
          {({ id, describedBy, invalid }) => (
            <Select value={String(values.dimensions)} onValueChange={(v) => set("dimensions", Number(v))}>
              <SelectTrigger id={id} className="w-full" aria-describedby={describedBy} aria-invalid={invalid}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PROVIDERS[values.provider].dimensions.map((d) => (
                  <SelectItem key={d} value={String(d)}>
                    {d}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </Field>
      </div>

      <Field label="Model id" required help="For your records, for example amazon.titan-embed-text-v2:0." error={errors.model_id}>
        {({ id, describedBy, invalid }) => (
          <Input id={id} value={values.model_id} onChange={text("model_id")} aria-describedby={describedBy} aria-invalid={invalid} autoComplete="off" />
        )}
      </Field>

      <Field
        label="Model id or inference profile ARN to call"
        required
        help="What the app sends to Amazon Bedrock. Check that it is available in your region and allowed by your data-residency policy before using it."
        error={errors.invoke_target}
      >
        {({ id, describedBy, invalid }) => (
          <Input id={id} value={values.invoke_target} onChange={text("invoke_target")} aria-describedby={describedBy} aria-invalid={invalid} autoComplete="off" />
        )}
      </Field>

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
        <Button type="submit" disabled={busy}>
          {busy ? "Registering…" : "Register search index"}
        </Button>
      </div>
    </form>
  );
}
