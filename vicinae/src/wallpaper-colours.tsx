import { Action, ActionPanel, Icon, List } from "@vicinae/api";
import { pathToFileURL } from "node:url";
import { useEffect, useState } from "react";
import { ACCENTS, namePalettes, normaliseHex, prettyName, readAccent, readPaletteIndex, readRememberedPalette, wallpaperPalettes, wallpaperPreview, type Palette, type Wallpaper } from "./lib";

export type ColourChoice = { accent: string } | { palette: number };
type Props = { wallpaper: Wallpaper; onApply: (choice: ColourChoice) => Promise<void> };
type Row = { id: string; title: string; colour?: string; choice: ColourChoice; palette?: Palette; current: boolean; lastUsed?: boolean; keywords: string[]; note?: string };

export default function WallpaperColours({ wallpaper, onApply }: Props) {
  const [palettes, setPalettes] = useState<Palette[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const [query, setQuery] = useState("");
  const [pin] = useState(readAccent);
  const [index] = useState(readPaletteIndex);
  // Another wallpaper's own last choice leads its list, so Enter, Enter brings back the same look.
  const [remembered] = useState(() => wallpaper.current ? null : readRememberedPalette(wallpaper.path));

  useEffect(() => {
    let active = true;
    setLoading(true);
    wallpaperPalettes(wallpaper.path)
      .then((next) => { if (active) { setPalettes(next); setError(""); } })
      .catch((e: { stderr?: string; message?: string }) => {
        if (active) setError(String(e.stderr || e.message || "").trim().split("\n")[0] || "Could not read this image's colours.");
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [wallpaper.path, revision]);

  const names = namePalettes(palettes.map((p) => p.primary));
  const paletteRows: Row[] = palettes.map((p, i) => ({
    id: `palette:${p.index}`, title: names[i], colour: p.primary, choice: { palette: p.index }, palette: p,
    current: wallpaper.current && !pin && p.index === index, lastUsed: p.index === remembered,
    keywords: [p.primary, "wallpaper", "palette"],
  })).sort((a, b) => Number(b.current || b.lastUsed) - Number(a.current || a.lastUsed));
  // Without matugen there is nothing to preview, but automatic colours still clear a pin.
  if (!loading && paletteRows.length === 0) {
    paletteRows.push({ id: "palette:0", title: "Automatic", colour: wallpaper.color || undefined, choice: { palette: 0 },
      current: wallpaper.current && !pin, keywords: ["automatic", "wallpaper"], note: error });
  }

  const typed = normaliseHex(query);
  const accentRows: Row[] = [
    ...(typed ? [{ id: `custom:${typed}`, title: `Custom ${typed.toUpperCase()}`, colour: typed, choice: { accent: typed }, current: typed === pin, keywords: [query] }] : []),
    ...(pin && pin !== typed && !ACCENTS.some((a) => a.hex === pin)
      ? [{ id: `pin:${pin}`, title: "Current Accent", colour: pin, choice: { accent: pin }, current: true, keywords: ["current", "pinned"] }] : []),
    ...ACCENTS.map((a) => ({ id: `accent:${a.name}`, title: a.name, colour: a.hex, choice: { accent: a.hex }, current: a.hex === pin, keywords: a.keywords })),
  ];

  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const matches = (row: Row) => {
    const text = [row.title, row.colour ?? "", ...row.keywords].join(" ").toLowerCase();
    return terms.every((term) => text.includes(term.replace(/^#/, "")));
  };
  const preview = wallpaperPreview(wallpaper, true);
  // Encoded so spaces, # and brackets in filenames survive Markdown. Empty alt: Vicinae draws it as a caption.
  const markdown = preview ? `![](${pathToFileURL(preview).href.replace(/\(/g, "%28").replace(/\)/g, "%29")})` : "";
  const retry = <Action title="Reload Wallpaper Palettes" icon={Icon.ArrowClockwise} shortcut={{ modifiers: ["cmd"], key: "r" }}
    onAction={() => { if (!loading) setRevision((value) => value + 1); }} />;

  const item = (row: Row) => (
    <List.Item key={row.id} id={row.id} title={row.title}
      icon={row.colour ? { source: Icon.CircleFilled, tintColor: row.colour } : Icon.Image}
      accessories={row.current ? [{ text: "Current" }] : row.lastUsed ? [{ text: "Last Used" }] : undefined}
      detail={<List.Item.Detail markdown={markdown} metadata={
        <List.Item.Detail.Metadata>
          {row.colour && <List.Item.Detail.Metadata.Label title="Accent" text={row.colour.toUpperCase()} icon={{ source: Icon.CircleFilled, tintColor: row.colour }} />}
          {row.palette && <List.Item.Detail.Metadata.Label title="Complement" text={row.palette.tertiary.toUpperCase()} icon={{ source: Icon.CircleFilled, tintColor: row.palette.tertiary }} />}
          {row.palette && <List.Item.Detail.Metadata.Label title="Surface" text={row.palette.surface.toUpperCase()} icon={{ source: Icon.CircleFilled, tintColor: row.palette.surface }} />}
          {row.note && <List.Item.Detail.Metadata.Label title="Palettes" text={row.note} />}
        </List.Item.Detail.Metadata>} />}
      actions={<ActionPanel>
        <Action title={`Set Wallpaper with ${row.title}`} icon={Icon.Swatch} onAction={() => void onApply(row.choice)} />
        {row.colour && <Action.CopyToClipboard title="Copy Accent Hex" content={row.colour.toUpperCase()} shortcut={{ modifiers: ["cmd", "shift"], key: "c" }} />}
        {retry}
      </ActionPanel>} />
  );

  return (
    <List navigationTitle={wallpaper.title || prettyName(wallpaper.name)} isShowingDetail isLoading={loading}
      filtering={false} searchText={query} onSearchTextChange={setQuery} searchBarPlaceholder="Colour name or hex…">
      {/* Nothing until palettes land: the list keeps its first selection, and an accent there would make Enter pin it. */}
      {!loading && <>
        <List.Section title="From This Wallpaper">{paletteRows.filter(matches).map(item)}</List.Section>
        <List.Section title="Accents · Kept for Later Wallpapers">{accentRows.filter(matches).map(item)}</List.Section>
        <List.EmptyView icon={Icon.Swatch} title="No matching colours" description="Try a colour name, or type a hex like #88aacc." />
      </>}
    </List>
  );
}
