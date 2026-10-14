export function trimTrailingSlashes(url: string): string {
  return url.replace(/\/+$/, "");
}

// CDK's RestApi.url ends in "/", and callers append "/path", so trim it once here.
export const API_ENDPOINT = trimTrailingSlashes(import.meta.env.VITE_API_ENDPOINT ?? "");
