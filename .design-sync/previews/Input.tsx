import { Input } from "chromium-runtime";

const col = {
  display: "flex",
  flexDirection: "column",
  gap: 12,
  padding: 16,
  width: 320,
};

export const Default = () => (
  <div style={col}>
    <Input placeholder="Search models…" />
    <Input defaultValue="anthropic/claude-opus-4" />
  </div>
);

export const Types = () => (
  <div style={col}>
    <Input type="email" placeholder="you@example.com" />
    <Input type="password" defaultValue="sk-ant-api03-xxxx" />
  </div>
);

export const States = () => (
  <div style={col}>
    <Input placeholder="Disabled" disabled />
    <Input defaultValue="invalid-key" aria-invalid />
  </div>
);
