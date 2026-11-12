/**
 * Read-only check of the ops break-glass switch, the SSM parameter
 * /<stack id>/PublicChatEnabled, for the admin console.
 *
 * The admin console controls only the service status in the database (read_only). The SSM
 * switch is changed in the AWS console, and the admin API cannot read it (no ssm:GetParameter
 * on the admin Lambda). So this asks the public chat route the way a family's browser does:
 * an anonymous guest token (GET /user/publicToken with no credential), then an empty POST to
 * text_generation for the nil session id. textGeneration checks the switch before it reads the
 * caller, the database or Bedrock, so a pause answers 429 PUBLIC_CHAT_PAUSED. Otherwise the
 * request is refused at once (401, the anonymous token has no user). Nothing is created or stored.
 *
 * It fails open, like the switch: any other answer, or an error, means "not known to be paused".
 * textGeneration caches the parameter for 60 s, so a change shows within about a minute.
 */
import { API_ENDPOINT } from "@/lib/api";

/** Error code textGeneration returns while the switch is "false" (main.py PUBLIC_CHAT_PAUSED_ERROR). */
export const PUBLIC_CHAT_PAUSED_CODE = "PUBLIC_CHAT_PAUSED";
/** No session has this id, and the request never gets far enough to look one up. */
export const PROBE_SESSION_ID = "00000000-0000-0000-0000-000000000000";

export async function isPublicChatPausedBySwitch(): Promise<boolean> {
  try {
    // No Authorization header: an anonymous token, never this browser's guest credential.
    const tokenResponse = await fetch(`${API_ENDPOINT}/user/publicToken`);
    if (!tokenResponse.ok) return false;
    const { token } = (await tokenResponse.json()) as { token?: unknown };
    if (typeof token !== "string" || !token) return false;

    const response = await fetch(`${API_ENDPOINT}/chat_sessions/${PROBE_SESSION_ID}/text_generation`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: "{}",
    });
    if (response.status !== 429) return false;
    const data = (await response.json().catch(() => null)) as { error?: unknown } | null;
    return data?.error === PUBLIC_CHAT_PAUSED_CODE;
  } catch {
    return false;
  }
}
