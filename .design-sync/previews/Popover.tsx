import {
  Popover,
  PopoverTrigger,
  PopoverContent,
  Button,
} from "chromium-runtime";

// Rendered open so the floating panel shows in the card.
export const Open = () => (
  <div style={{ padding: 24, display: "flex", justifyContent: "center" }}>
    <Popover open>
      <PopoverTrigger asChild>
        <Button variant="outline">Display</Button>
      </PopoverTrigger>
      <PopoverContent>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={{ fontSize: 14, fontWeight: 600 }}>Display</div>
          <div style={{ fontSize: 13, color: "var(--muted-foreground)" }}>
            Adjust width, theme, and density for this workspace.
          </div>
        </div>
      </PopoverContent>
    </Popover>
  </div>
);
