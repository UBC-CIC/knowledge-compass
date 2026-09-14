import { useEffect, useState } from "react";

interface TypingIndicatorProps {
  className?: string;
}

export default function TypingIndicator({
  className = "",
}: TypingIndicatorProps) {
  const [dots, setDots] = useState("");

  useEffect(() => {
    const interval = setInterval(() => {
      setDots((prev) => {
        if (prev === "...") return "";
        return prev + ".";
      });
    }, 600);

    return () => clearInterval(interval);
  }, []);

  return (
    <div className={`text-[14.5px] text-foreground/70 ${className}`}>
      Thinking about what you've told me{dots}
    </div>
  );
}
