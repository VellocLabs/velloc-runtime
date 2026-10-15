import { Select } from "chromium-runtime";

const noop = () => {};
const models = [
  { value: "opus", label: "Claude Opus 4.8" },
  { value: "sonnet", label: "Claude Sonnet 4.6" },
  { value: "haiku", label: "Claude Haiku 4.5" },
];

const wrap = {
  display: "flex",
  flexWrap: "wrap",
  gap: 12,
  alignItems: "center",
  padding: 16,
};

export const Variants = () => (
  <div style={wrap}>
    <Select value="opus" onValueChange={noop} options={models} variant="outline" />
    <Select value="sonnet" onValueChange={noop} options={models} variant="ghost" />
    <Select value="haiku" onValueChange={noop} options={models} variant="muted" />
  </div>
);

export const Sizes = () => (
  <div style={wrap}>
    <Select value="opus" onValueChange={noop} options={models} size="sm" />
    <Select value="opus" onValueChange={noop} options={models} size="default" />
    <Select value="opus" onValueChange={noop} options={models} size="lg" />
  </div>
);

export const Placeholder = () => (
  <div style={wrap}>
    <Select
      value=""
      onValueChange={noop}
      options={models}
      placeholder="Select a model…"
    />
  </div>
);
