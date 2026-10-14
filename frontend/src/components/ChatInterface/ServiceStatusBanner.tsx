import { serviceNotice, type ServiceState } from "@/lib/serviceStatus";

/**
 * Maintenance banner above the chat. A plain banner is a polite status message;
 * read-only is an alert because families cannot send until it is lifted. The text is
 * written by an administrator and rendered as plain text. Colours pair a dark text
 * with a light background for readable contrast.
 */
export default function ServiceStatusBanner({ state }: { state: ServiceState }) {
  const text = serviceNotice(state);
  if (!text) return null;
  const readOnly = state.status === "read_only";
  return (
    <div className="shrink-0 px-4 pt-3 md:px-[34px]">
      <div
        role={readOnly ? "alert" : "status"}
        className={`mx-auto w-full max-w-[680px] rounded-[10px] border px-4 py-3 text-[14.5px] leading-normal ${
          readOnly ? "border-red-300 bg-red-50 text-red-900" : "border-amber-300 bg-amber-50 text-amber-950"
        }`}
      >
        {readOnly ? <span className="font-semibold">Messages are paused. </span> : null}
        {text}
      </div>
    </div>
  );
}
