import {
  createContext,
  useContext,
  type PropsWithChildren,
  type ReactElement,
} from "react";

/**
 * Tells a nested `ToolFallback` it renders inside a group wrapper (set by `ToolGroup`
 * and `TodoSection`), so it uses the slim borderless variant.
 */
type ToolGroupContextValue = {
  insideGroup: boolean;
};

const ToolGroupContext = createContext<ToolGroupContextValue>({
  insideGroup: false,
});

export function useToolGroupContext(): ToolGroupContextValue {
  return useContext(ToolGroupContext);
}

/**
 * Wraps children with `insideGroup: true` so nested ToolFallbacks render in
 * their slim "nested" variant. Used by `ToolGroup` internally and by
 * `TodoSection` for its body slot.
 */
export function ToolGroupContextProvider({
  children,
}: PropsWithChildren): ReactElement {
  return (
    <ToolGroupContext.Provider value={{ insideGroup: true }}>
      {children}
    </ToolGroupContext.Provider>
  );
}

export { ToolGroupContext };
export type { ToolGroupContextValue };
