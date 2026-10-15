import { createContext, useContext, type ReactNode } from "react";

/**
 * The transcript lines behind each tool call in the message, as `call-1=9:12 call-2=15:20`.
 * A context because `useAssistantState` throws outside a provider; a standalone card
 * simply has no range.
 */
const ToolLineRangeContext = createContext<string>("");

export function ToolLineRangeProvider({
  ranges,
  children,
}: {
  ranges: string | undefined;
  children: ReactNode;
}) {
  return (
    <ToolLineRangeContext.Provider value={ranges ?? ""}>
      {children}
    </ToolLineRangeContext.Provider>
  );
}

/** Encoded ranges for the current message; `""` when there are none. */
export function useToolLineRanges(): string {
  return useContext(ToolLineRangeContext);
}
