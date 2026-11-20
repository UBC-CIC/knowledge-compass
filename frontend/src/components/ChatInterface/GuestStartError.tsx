import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter } from "@/components/ui/card";

/** Shown in place of the chat when the anonymous guest could not be created. */
export default function GuestStartError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex h-full items-center justify-center bg-background px-4">
      <Card role="alert" className="w-full max-w-[480px]">
        <CardContent>
          <p className="text-[15px] leading-normal">{message}</p>
        </CardContent>
        <CardFooter>
          <Button type="button" onClick={onRetry}>
            Try again
          </Button>
        </CardFooter>
      </Card>
    </div>
  );
}
