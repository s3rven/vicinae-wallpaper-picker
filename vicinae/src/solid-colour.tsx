import { Action, ActionPanel, Form, Icon, Toast, closeMainWindow, showToast } from "@vicinae/api";
import { useState } from "react";
import { applyWallpaper, commandOptions, createSolidWallpaper, missingTools, normaliseHex, readSolidColour, rememberSolidColour, type ApplyOptions } from "./lib";

const PRESETS = [
  ["Midnight", "#111827"], ["Charcoal", "#25272c"], ["Black", "#000000"],
  ["Cream", "#f5eedf"], ["Sage", "#91ad94"], ["Teal", "#267d81"],
  ["Blue", "#3966a5"], ["Lavender", "#a592c8"], ["Rose", "#bd7e94"], ["Terracotta", "#b36e53"],
];

export default function SolidColour({ options }: { options?: ApplyOptions }) {
  const [colour, setColour] = useState(readSolidColour);
  const [custom, setCustom] = useState(() => !PRESETS.some(([, value]) => value === colour));
  const [busy, setBusy] = useState(false);
  const hex = normaliseHex(colour);
  async function apply() {
    if (busy || !hex) return;
    const missing = missingTools({ solid: true });
    if (missing.length) {
      await showToast({ style: Toast.Style.Failure, title: "Missing wallpaper tools", message: `Install ${missing.join(", ")}.` }).catch(() => undefined);
      return;
    }
    setBusy(true);
    try {
      const path = await createSolidWallpaper(hex);
      if (!applyWallpaper(path, { ...(options ?? commandOptions().apply), resize: "stretch" })) throw new Error("Could not start the wallpaper backend.");
      rememberSolidColour(hex);
      await closeMainWindow();
    } catch (error) {
      await showToast({ style: Toast.Style.Failure, title: "Could not set colour", message: String(error) }).catch(() => undefined);
    } finally { setBusy(false); }
  }
  return (
    <Form navigationTitle="Solid Colour" isLoading={busy} actions={
      <ActionPanel><Action.SubmitForm title="Set Solid Colour" icon={Icon.Swatch} onSubmit={() => apply()} /></ActionPanel>
    }>
      <Form.Dropdown id="preset" title="Preset" value={custom ? "custom" : colour} onChange={(value) => { setCustom(value === "custom"); if (value !== "custom") setColour(value); }}>
        {PRESETS.map(([title, value]) => <Form.Dropdown.Item key={value} title={title} value={value} icon={{ source: Icon.CircleFilled, tintColor: value }} />)}
        <Form.Dropdown.Item title="Custom" value="custom" icon={Icon.Swatch} />
      </Form.Dropdown>
      <Form.TextField id="colour" title="Hex colour" value={colour} onChange={(value) => { if (value !== colour) { setColour(value); setCustom(true); } }} placeholder="#4488ff" error={hex ? undefined : "Use #RGB or #RRGGBB."} />
      <Form.Description title="Colour" text={hex ? `${hex.toUpperCase()} — Ctrl+Enter to apply` : "Enter a hex colour with or without #."} />
      <Form.Description text="Uses your chosen transition. Previous Wallpaper and login restore work with solid colours too." />
    </Form>
  );
}
