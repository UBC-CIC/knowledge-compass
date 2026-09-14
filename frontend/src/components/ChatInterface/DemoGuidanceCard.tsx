type DemoGuidanceCardProps = {
  onKeepGoing: () => void;
};

export default function DemoGuidanceCard({ onKeepGoing }: DemoGuidanceCardProps) {
  return (
    <div className="overflow-hidden rounded-[12px] border border-foreground/14">
      <div className="bg-primary px-[22px] py-3.5 text-[13.5px] font-semibold tracking-[0.01em] text-white">
        Where you are, and what to do next
      </div>
      <div className="px-[22px] py-[22px]">
        <p className="text-[16.5px] leading-[1.65] text-pretty">
          You're at the stage where the school isn't responding to your first
          request. That's frustrating — and it's common. Your goal right now is
          to get the school to respond in writing, and to schedule a meeting
          about what would allow your son to return to full-time attendance.
        </p>

        <div className="mt-5 text-[11px] font-bold uppercase tracking-[0.08em] text-foreground/70">
          Here's what to do
        </div>
        <div className="mt-3 flex flex-col gap-3.5">
          <div className="flex items-start gap-3">
            <div className="mt-0.5 flex size-[22px] shrink-0 items-center justify-center rounded-md bg-secondary text-xs font-bold text-secondary-foreground">
              1
            </div>
            <div className="text-[15.5px] leading-[1.62]">
              <strong>Send a follow-up email to the principal.</strong> Keep it
              brief and professional:
              <div className="mt-2 rounded-[9px] bg-muted px-3.5 py-3 font-serif text-[15.5px] leading-relaxed">
                "I'm following up on my email from [date]. I would appreciate an
                update. I would also like to schedule a meeting to discuss my
                son's school attendance and the support he needs to attend
                school full-time. Please let me know your availability."
              </div>
            </div>
          </div>
          <div className="flex items-start gap-3">
            <div className="mt-0.5 flex size-[22px] shrink-0 items-center justify-center rounded-md bg-secondary text-xs font-bold text-secondary-foreground">
              2
            </div>
            <div className="text-[15.5px] leading-[1.62]">
              <strong>Ask for the reason in writing.</strong> In the same email:
              "Could you please provide in writing the reason my son is being
              sent home early, how long this will continue, and what supports
              have been tried so far?" This creates a record and forces clarity.
            </div>
          </div>
          <div className="flex items-start gap-3">
            <div className="mt-0.5 flex size-[22px] shrink-0 items-center justify-center rounded-md bg-secondary text-xs font-bold text-secondary-foreground">
              3
            </div>
            <div className="text-[15.5px] leading-[1.62]">
              <strong>Give them 5–7 business days</strong>, then follow up
              again. Keep copies of everything you send and receive.
            </div>
          </div>
        </div>

        <div className="mt-5 rounded-[10px] bg-[oklch(0.97_0.015_268)] px-4 py-3.5">
          <div className="text-[11px] font-bold uppercase tracking-[0.08em] text-secondary-foreground">
            Your next immediate step
          </div>
          <div className="mt-1.5 text-base font-semibold leading-snug">
            Send that follow-up email today or tomorrow.
          </div>
        </div>

        <div className="mt-5 flex flex-wrap gap-2.5">
          <button
            type="button"
            className="min-h-11 rounded-[9px] bg-primary px-[18px] text-[14.5px] font-semibold text-white"
          >
            Save this plan
          </button>
          <button
            type="button"
            onClick={onKeepGoing}
            className="min-h-11 rounded-[9px] border border-foreground/20 bg-transparent px-[18px] text-[14.5px] font-semibold hover:bg-foreground/4"
          >
            I have another question
          </button>
        </div>
      </div>
    </div>
  );
}
