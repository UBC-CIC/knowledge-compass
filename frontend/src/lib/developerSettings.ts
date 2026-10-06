import { useCallback, useState } from "react";

/**
 * "Show developer settings" switch shared by the admin Prompts and Assistant
 * settings pages. Remembered per browser.
 */
const KEY = "kc.prompts.showDeveloper";

function read(): boolean {
  try {
    return window.localStorage.getItem(KEY) === "true";
  } catch {
    return false;
  }
}

export function useDeveloperSettings() {
  const [on, setOn] = useState(read);
  const set = useCallback((next: boolean) => {
    setOn(next);
    try {
      window.localStorage.setItem(KEY, next ? "true" : "false");
    } catch {
      // Storage unavailable (private mode): the switch still works for this visit.
    }
  }, []);
  return [on, set] as const;
}
