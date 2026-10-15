import { Switch } from "chromium-runtime";

const cell = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  fontSize: 14,
};
const row = {
  display: "flex",
  flexWrap: "wrap",
  gap: 24,
  alignItems: "center",
  padding: 16,
};

export const States = () => (
  <div style={row}>
    <label style={cell}>
      <Switch aria-label="Off" /> Off
    </label>
    <label style={cell}>
      <Switch defaultChecked aria-label="On" /> On
    </label>
    <label style={{ ...cell, opacity: 0.6 }}>
      <Switch defaultChecked disabled aria-label="On, disabled" /> Disabled
    </label>
  </div>
);
