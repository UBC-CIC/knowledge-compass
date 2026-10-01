/** The fields every versioned prompt shares (system messages and journey prompts). */
export type PromptVersion = {
  id: string;
  content: string;
  character_limit: number;
  version: number;
  is_active: boolean;
  created_by_email?: string | null;
  created_at?: string;
};

export function formatDate(iso?: string) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

export function sortVersions<V extends PromptVersion>(versions: V[]): V[] {
  // Active first, then version desc, then created_at desc
  return [...versions].sort((a, b) => {
    if (a.is_active !== b.is_active) return a.is_active ? -1 : 1;
    if ((b.version ?? 0) !== (a.version ?? 0)) return (b.version ?? 0) - (a.version ?? 0);
    const ad = a.created_at ? new Date(a.created_at).getTime() : 0;
    const bd = b.created_at ? new Date(b.created_at).getTime() : 0;
    return bd - ad;
  });
}
