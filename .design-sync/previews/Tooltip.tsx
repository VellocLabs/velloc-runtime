import {
  Tooltip,
  TooltipProvider,
  TooltipTrigger,
  TooltipContent,
  Button,
} from "chromium-runtime";

// TooltipProvider is required context; render the tooltip open so its content
// shows in the card without hover.
export const Open = () => (
  <TooltipProvider>
    <div style={{ padding: 56, display: "flex", justifyContent: "center" }}>
      <Tooltip open>
        <TooltipTrigger asChild>
          <Button variant="outline">Language</Button>
        </TooltipTrigger>
        <TooltipContent>Open Chrome's language settings</TooltipContent>
      </Tooltip>
    </div>
  </TooltipProvider>
);
