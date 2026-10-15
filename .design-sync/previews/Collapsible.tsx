import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
  Button,
} from "chromium-runtime";

export const Open = () => (
  <div style={{ padding: 16, width: 380 }}>
    <Collapsible defaultOpen>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <span style={{ fontSize: 14, fontWeight: 600 }}>Advanced settings</span>
        <CollapsibleTrigger asChild>
          <Button variant="ghost" size="sm">
            Toggle
          </Button>
        </CollapsibleTrigger>
      </div>
      <CollapsibleContent>
        <div
          style={{
            paddingTop: 8,
            display: "flex",
            flexDirection: "column",
            gap: 6,
            fontSize: 13,
            color: "var(--muted-foreground)",
          }}
        >
          <div>Max turns: 24</div>
          <div>Step timeout: 120s</div>
          <div>Trace: enabled</div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  </div>
);
