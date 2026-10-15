import { Badge } from "chromium-runtime";

const wrap = {
  display: "flex",
  flexWrap: "wrap",
  gap: 8,
  alignItems: "center",
  padding: 16,
};

export const Variants = () => (
  <div style={wrap}>
    <Badge variant="outline">Outline</Badge>
    <Badge variant="secondary">Secondary</Badge>
    <Badge variant="muted">Muted</Badge>
    <Badge variant="info">Info</Badge>
    <Badge variant="success">Connected</Badge>
    <Badge variant="warning">Verifying</Badge>
    <Badge variant="destructive">Error</Badge>
  </div>
);

export const Sizes = () => (
  <div style={wrap}>
    <Badge size="sm" variant="secondary">
      Small
    </Badge>
    <Badge size="default" variant="secondary">
      Default
    </Badge>
    <Badge size="lg" variant="secondary">
      Large
    </Badge>
  </div>
);
