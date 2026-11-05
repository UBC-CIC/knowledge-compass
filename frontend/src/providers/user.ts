import { createContext, useContext } from "react";
import type { GuestStartError } from "@/lib/guestCreation";

interface UserContextType {
  userId: string | null;
  isLoading: boolean;
  error: GuestStartError | null;
  /** Try creating the anonymous guest again after a failure. */
  retry: () => void;
}

export const UserContext = createContext<UserContextType | undefined>(
  undefined
);


export function useUser() {
  const context = useContext(UserContext);
  if (context === undefined) {
    throw new Error("useUser must be used within a UserProvider");
  }
  return context;
}
