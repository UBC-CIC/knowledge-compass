type UserChatMessageProps = {
  text: string;
  hasPII?: boolean;
};

export default function UserChatMessage({ text, hasPII }: UserChatMessageProps) {
  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex w-full justify-end">
        <div className="max-w-[74%] rounded-[12px] rounded-br-[3px] bg-primary px-4 py-3 text-[15.5px] leading-relaxed text-white">
          <p className="whitespace-pre-wrap">{text}</p>
        </div>
      </div>
      {hasPII ? (
        <p className="pr-1 text-xs text-amber-700">
          Your message may contain personal information. It will be redacted before saving.
        </p>
      ) : null}
    </div>
  );
}
