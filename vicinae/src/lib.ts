import { Cache, environment, getPreferenceValues } from "@vicinae/api";
import { execFile, spawn } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

// Installed scripts are bundled; this override is useful for local development.
const script = (name: string) =>
  join(process.env.WALLPAPER_PICKER_DIR || join(environment.assetsPath, "backend"), name);

// Run through bash rather than exec'ing the file, so a bundler that drops the
// executable bit cannot break the extension.
const runScript = (name: string, args: string[], maxBuffer: number, env?: NodeJS.ProcessEnv) =>
  run("bash", [script(name), ...args], { maxBuffer, env, timeout: 45_000 });

const onPath = (cmd: string) =>
  (process.env.PATH ?? "").split(":").some((dir) => {
    try {
      accessSync(join(dir, cmd), constants.X_OK);
      return statSync(join(dir, cmd)).isFile();
    } catch {
      return false;
    }
  });

// ImageMagick improves thumbnails/colour filters; it is optional for stills.
export function missingTools(options: { path?: string; solid?: boolean } = {}): string[] {
  const need = [["bash"], ["awww"], ["flock"]];
  if (options.solid) need.push(["magick", "convert"]);
  if (options.path && isLive(options.path)) need.push(["ffmpeg"], ["mpvpaper"], ["python3"], ["systemctl"], ["systemd-run"]);
  return need.filter((alternatives) => !alternatives.some(onPath)).map((alternatives) => alternatives.join(" or "));
}

export function imageToolsAvailable(): boolean {
  return onPath("magick") || onPath("convert");
}

export function previewWorkPending(items: Wallpaper[], images = imageToolsAvailable()): boolean {
  return items.some((w) => images ? w.thumb === w.path || !w.color : isLive(w.path) && w.thumb === w.path);
}

export function wallpaperPreview(wallpaper: Wallpaper, images: boolean): string | null {
  if (isLive(wallpaper.thumb) || (images && wallpaper.thumb === wallpaper.path)) return null;
  return wallpaper.thumb;
}

export function libraryDirectory(directory?: string): string {
  const wanted = directory || process.env.WALLPAPER_DIR || join(homedir(), "Pictures", "wallpaper");
  return resolve(wanted === "~" ? homedir() : wanted.startsWith("~/") ? join(homedir(), wanted.slice(2)) : wanted);
}

export type Wallpaper = {
  path: string;
  name: string;
  thumb: string;
  current: boolean;
  color: string;
  folder: string;
  mtime: number;
  // Derived once, at scan time, not in the filters.
  //
  // The group used to be recomputed inside render: groupOf ran in the colour-rail
  // memo, again in the visible-list memo on every filter change, and again per
  // tile to build its search keywords — roughly 350 hex parses per keystroke on
  // a 115-wallpaper library, to answer a question whose input never changes.
  // Parsing each colour once here makes the filters plain field comparisons.
  group: string;
  // Mean lightness 0-100 from the scanner, -1 while its colour pass is pending.
  brightness: number;
  title: string;
  tags: string[];
  source: string;
  resolution: string;
};

export type WallpaperMetadata = { title: string; tags: string[]; source: string; resolution: string };

export function parseLibraryMetadata(raw: string): Record<string, WallpaperMetadata> {
  try {
    const parsed = JSON.parse(raw);
    if (parsed?.version !== 1 || !parsed.wallpapers || typeof parsed.wallpapers !== "object") return {};
    const out: Record<string, WallpaperMetadata> = {};
    for (const [path, value] of Object.entries(parsed.wallpapers)) {
      if (!value || typeof value !== "object") continue;
      const item = value as Record<string, unknown>;
      out[path] = {
        title: typeof item.title === "string" ? item.title.trim() : "",
        tags: Array.isArray(item.tags) ? item.tags.filter((tag): tag is string => typeof tag === "string") : [],
        source: typeof item.source === "string" && /^https?:\/\//.test(item.source) ? item.source : "",
        resolution: typeof item.resolution === "string" ? item.resolution : "",
      };
    }
    return out;
  } catch { return {}; }
}

export function isArchived(wallpaper: Pick<Wallpaper, "folder">): boolean {
  return /^(?:archive|old)(?:\/|$)/i.test(wallpaper.folder);
}

export function filterLibrary(items: Wallpaper[], filter: string, favourites: Set<string>, colour = ""): Wallpaper[] {
  if (colour) items = items.filter((w) => w.group === colour && Boolean(w.color));
  if (filter === "fav") return items.filter((w) => favourites.has(w.path));
  if (filter === "archive") return items.filter(isArchived);
  if (filter.startsWith("f:")) return items.filter((w) => w.folder === filter.slice(2));
  const active = items.filter((w) => !isArchived(w));
  if (filter === "live") return active.filter((w) => isLive(w.path));
  if (filter === "stills") return active.filter((w) => !isLive(w.path));
  return filter.startsWith("c:") ? active.filter((w) => w.group === filter.slice(2)) : active;
}

const normaliseSearch = (value: string) => value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
type SearchField = { text: string; words: string[]; weight: number };
type SearchEntry = { title: string; fields: SearchField[] };
export type SearchIndex = WeakMap<Wallpaper, SearchEntry>;

function searchEntry(w: Wallpaper): SearchEntry {
  const field = (text: string, weight: number): SearchField => {
    text = normaliseSearch(text);
    return { text, words: text.split(/[^\p{L}\p{N}#]+/u).filter(Boolean), weight };
  };
  return { title: normaliseSearch(w.title || prettyName(w.name)), fields: [
    field(w.name, 0), field(prettyName(w.name), 0), field(w.title, 0), ...w.tags.map((tag) => field(tag, 0.25)),
    field(w.folder, 2), field(w.group, 0.5), field(w.color, 0.5), field(w.resolution, 1),
    field(isLive(w.path) ? "live video" : "still image", 1),
  ] };
}

// Build once per scan, so typing only compares already-normalised fields.
export function createSearchIndex(items: Wallpaper[]): SearchIndex {
  return new WeakMap(items.map((w) => [w, searchEntry(w)]));
}

function searchScore(field: SearchField, term: string): number {
  const { text, words, weight } = field;
  if (text === term) return weight;
  if (words.includes(term)) return 1 + weight;
  if (text.startsWith(term)) return 2 + weight;
  if (words.some((word) => word.startsWith(term))) return 3 + weight;
  const substring = text.indexOf(term);
  if (substring >= 0) return 4 + weight + substring / 1000;
  let position = 0, skipped = 0;
  for (const character of term) {
    const at = text.indexOf(character, position);
    if (at < 0) return Infinity;
    skipped += at - position;
    position = at + character.length;
  }
  return 12 + weight + skipped / Math.max(1, term.length);
}

// Search relevance comes first; the selected sort still breaks equal scores.
export function searchLibrary(items: Wallpaper[], query: string, index?: SearchIndex): Wallpaper[] {
  const normalised = normaliseSearch(query).trim().replace(/\s+/g, " ");
  const terms = normalised.split(" ").filter(Boolean);
  if (!terms.length) return items;
  const scored = items.map((wallpaper, order) => {
    const entry = index?.get(wallpaper) ?? searchEntry(wallpaper);
    let score = entry.title === normalised ? -3 : 0;
    for (const term of terms) {
      let best = Infinity;
      for (const field of entry.fields) {
        best = Math.min(best, searchScore(field, term));
        if (best === 0) break;
      }
      score += best;
      if (!Number.isFinite(score)) break;
    }
    return { wallpaper, order, score };
  }).filter(({ score }) => Number.isFinite(score));
  // Loose letter-order matches only stand in when nothing matches literally:
  // otherwise "car" also brought back "ascii-art" and "camera".
  const literal = scored.filter(({ score }) => score < 12);
  return (literal.length ? literal : scored)
    .sort((a, b) => a.score - b.score || a.order - b.order).map(({ wallpaper }) => wallpaper);
}

const nameCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
export function compareWallpaperNames(a: Wallpaper, b: Wallpaper): number {
  return nameCollator.compare(a.title || a.name, b.title || b.name);
}

// The unfiltered grid leads with the wallpaper on the desktop now, then the
// favourites. Vicinae always opens a grid on its first tile (a Grid ignores
// selectedItemId), so this is what makes the picker open on the current
// wallpaper: Enter goes straight to its colours, and arrows start from it.
export function pinnedFirst(items: Wallpaper[], favourites: Set<string>): Wallpaper[] {
  const rank = (w: Wallpaper) => (w.current ? 0 : favourites.has(w.path) ? 1 : 2);
  return items.some((w) => rank(w) < 2) ? [...items].sort((a, b) => rank(a) - rank(b)) : items;
}

// scan-wallpapers.sh emits one tab-separated record per wallpaper:
//   path \t name \t thumb \t current \t color \t folder \t mtime \t brightness
// Fields past the second are optional in older output, so every read past
// parts[1] is defensive rather than assumed.
export type ScanOptions = {
  directory?: string;
  depth?: string;
  includeCurrent?: boolean;
  // Read the cache without starting another thumbnail worker. Used while the
  // first scan's background worker is filling thumbnails and colour hints.
  cacheOnly?: boolean;
};

export async function scanWallpapers(options: ScanOptions = {}): Promise<Wallpaper[]> {
  const env = { ...process.env };
  const wanted = libraryDirectory(options.directory);
  if (!existsSync(wanted)) throw new Error(`Wallpaper folder not found: ${wanted}`);
  if (!statSync(wanted).isDirectory()) throw new Error(`Choose a wallpaper folder, not a file: ${wanted}`);
  const directory = realpathSync(wanted);
  try { accessSync(directory, constants.R_OK | constants.X_OK); }
  catch { throw new Error(`Wallpaper folder is not readable: ${wanted}`); }
  env.WALLPAPER_DIR = directory;
  if (options.depth) env.WALLPAPER_SCAN_DEPTH = options.depth;
  if (typeof options.includeCurrent === "boolean") {
    env.WALLPAPER_INCLUDE_CURRENT = options.includeCurrent ? "1" : "0";
  }
  if (options.cacheOnly) env.WALLPAPER_PICKER_CACHE_ONLY = "1";
  const { stdout } = await runScript("scan-wallpapers.sh", [directory], 32 * 1024 * 1024, env);
  let metadata: Record<string, WallpaperMetadata> = {};
  try { metadata = parseLibraryMetadata(readFileSync(join(directory, ".wallpaper-library.json"), "utf8")); } catch { /* optional catalogue */ }
  const out: Wallpaper[] = [];
  for (const line of stdout.split("\n")) {
    if (!line) continue;
    const p = line.split("\t");
    if (p.length < 2 || !p[0]) continue;
    const color = normaliseHex(p[4] ?? "") ?? "";
    const details = metadata[relative(directory, p[0])];
    out.push({
      path: p[0],
      name: p[1],
      thumb: p[2] && p[2].length > 0 ? p[2] : p[0],
      current: p[3] === "1",
      color,
      folder: p[5]?.length ? p[5] : "Root",
      mtime: Number.parseInt(p[6] ?? "0", 10) || 0,
      // A missing or malformed cache hint is still a neutral-looking item. Use
      // the same fallback the colour sections use so the dropdown, sections and
      // search keywords never disagree about where that wallpaper belongs.
      group: groupOf(color) || "neutral",
      brightness: /^\d{1,3}$/.test(p[7]?.trim() ?? "") ? Number(p[7]) : -1,
      title: details?.title || readableName(p[1]) || "",
      tags: details?.tags ?? [],
      source: details?.source || (/^wallhaven-[a-z0-9]{6}\./i.test(basename(p[0]))
        ? `https://wallhaven.cc/w/${basename(p[0]).slice(10, 16)}` : ""),
      resolution: details?.resolution ?? "",
    });
  }
  return out;
}

export type ApplyOptions = {
  // Undefined keeps the current accent; an empty string restores automatic image colours.
  accent?: string;
  // A matugen source colour (0-3) of this image; also clears a pinned accent.
  palette?: number;
  transition?: string;
  duration?: string;
  fps?: string;
  position?: string;
  angle?: string;
  bezier?: string;
  wave?: string;
  resize?: string;
  filter?: string;
  cropGravity?: string;
};

export const TRANSITIONS = [
  { id: "soft-fade", title: "Fade", description: "A short, smooth crossfade." },
  { id: "diagonal-wipe", title: "Diagonal wipe", description: "A quick diagonal sweep." },
  { id: "spotlight-wave", title: "Spotlight", description: "A circle opens from the centre." },
  { id: "iris-close", title: "Iris", description: "A circle closes towards the centre." },
  { id: "wave-sweep", title: "Wave", description: "A wavy sweep from top to bottom." },
  { id: "left", title: "From left", description: "A reveal from left to right." },
  { id: "right", title: "From right", description: "A reveal from right to left." },
  { id: "top", title: "From top", description: "A reveal from top to bottom." },
  { id: "bottom", title: "From bottom", description: "A reveal from bottom to top." },
  { id: "any", title: "Random origin", description: "A circle opens from a different point each time." },
  { id: "random", title: "Random effect", description: "awww chooses an effect for each change." },
  { id: "none", title: "None", description: "Apply instantly." },
] as const;
export type Transition = (typeof TRANSITIONS)[number]["id"];
export function transitionOf(value: unknown): Transition {
  return TRANSITIONS.some((transition) => transition.id === value) ? value as Transition : "soft-fade";
}
export const TRANSITION_DURATIONS = ["auto", "0.2", "0.3", "0.4", "0.5", "0.65", "0.8", "1.0", "1.5", "2.0"] as const;
export type TransitionDuration = (typeof TRANSITION_DURATIONS)[number];

export const COLOUR_SWATCHES: Record<string, string> = {
  red: "#e66571", orange: "#e69959", yellow: "#e1ca68", green: "#80b97d",
  teal: "#57b9ad", blue: "#6b9ddd", purple: "#a68bda", pink: "#d990bc", neutral: "#92969f",
};

// Files live with picker state, so Previous Wallpaper and login restore use the same apply pipeline.
export async function createSolidWallpaper(raw: string): Promise<string> {
  const colour = normaliseHex(raw);
  if (!colour) throw new Error("Enter three or six hex digits, for example #4488ff.");
  const directory = join(STATE_DIR, "wallpaper-picker", "colours");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `colour-${colour.slice(1)}.png`);
  if (existsSync(path)) return path;
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    await run(onPath("magick") ? "magick" : "convert",
      ["-size", "16x16", `xc:${colour}`, `png:${temporary}`], { timeout: 10_000 });
    renameSync(temporary, path);
    return path;
  } finally { rmSync(temporary, { force: true }); }
}

export function applyWallpaper(
  path: string,
  options: ApplyOptions = {},
): boolean {
  const applyScript = script("apply-wallpaper.sh");
  if (!existsSync(path) || !existsSync(applyScript)) return false;
  try {
    if (!statSync(path).isFile() || !statSync(applyScript).isFile()) return false;
    accessSync(path, constants.R_OK);
    accessSync(applyScript, constants.R_OK);
  } catch {
    return false;
  }
  const args = [
    path,
    process.env.WALLPAPER_PICKER_TRANSITION ?? options.transition ?? "soft-fade",
  ];
  const env = { ...process.env };
  env.WALLPAPER_PICKER_LOG = "1";
  if (options.accent !== undefined) {
    const accent = options.accent === "" ? "" : normaliseHex(options.accent);
    if (accent === null) return false;
    env.WALLPAPER_PICKER_ACCENT = accent;
  }
  if (options.palette !== undefined) env.WALLPAPER_PICKER_PALETTE = String(options.palette);
  const setPreference = (name: string, value?: string) => {
    // Explicit environment variables stay a power-user override for scripts
    // and machine-wide defaults. "auto" means leave the backend's detection
    // in charge rather than sending a literal value.
    if (value && value !== "auto" && !process.env[name]) env[name] = value;
  };
  setPreference("WALLPAPER_TRANSITION_DURATION", options.duration);
  setPreference("WALLPAPER_TRANSITION_FPS", options.fps);
  setPreference("WALLPAPER_TRANSITION_POS", options.position);
  setPreference("WALLPAPER_TRANSITION_ANGLE", options.angle);
  setPreference("WALLPAPER_TRANSITION_BEZIER", options.bezier);
  setPreference("WALLPAPER_TRANSITION_WAVE", options.wave);
  setPreference("WALLPAPER_RESIZE_MODE", options.resize);
  setPreference("WALLPAPER_SCALING_FILTER", options.filter);
  setPreference("WALLPAPER_CROP_GRAVITY", options.cropGravity);
  try {
    const child = spawn("bash", [applyScript, ...args], {
      detached: true,
      stdio: "ignore",
      env,
    });
    // spawn reports failures such as a non-executable/missing interpreter on
    // the child rather than throwing synchronously. Without a listener that is
    // an unhandled EventEmitter error and takes the extension process down.
    child.once("error", () => undefined);
    child.unref();
    return true;
  } catch {
    return false;
  }
}

// What the no-view commands need from the extension preferences. The dropdowns
// only offer valid values and the backend validates them again.
export function commandOptions(): { scan: ScanOptions; apply: ApplyOptions } {
  const p = getPreferenceValues<Record<string, string | boolean | undefined>>();
  const view = readView();
  const text = (key: string) => typeof p[key] === "string" ? p[key] as string : undefined;
  return {
    scan: { directory: text("wallpaperDirectory")?.trim() || undefined, depth: text("scanDepth"), includeCurrent: p.includeCurrent !== false },
    apply: { transition: view.transition ?? text("transition"), duration: view.duration ?? text("transitionDuration"), resize: text("resizeMode"), cropGravity: text("cropGravity") },
  };
}

export function normaliseHex(raw: string): string | null {
  const t = raw.trim().replace(/^#/, "");
  if (/^[0-9a-fA-F]{6}$/.test(t)) return `#${t.toLowerCase()}`;
  if (/^[0-9a-fA-F]{3}$/.test(t)) {
    return `#${t.toLowerCase().split("").map((c) => c + c).join("")}`;
  }
  return null;
}

// What a theme hook gets from one matugen source colour of the image (dark scheme).
export type Palette = { index: number; primary: string; tertiary: string; surface: string };

export function parsePalettes(output: string): Palette[] {
  const seen = new Set<string>();
  return output.split("\n").flatMap((line) => {
    const m = /^([0-3])((?: #[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?){3})$/.exec(line.trim());
    if (!m) return [];
    const [primary, tertiary, surface] = m[2].trim().split(" ").map((hex) => hex.slice(0, 7).toLowerCase());
    // Two source colours can land on the same scheme; offer it once.
    if (seen.has(primary + tertiary)) return [];
    seen.add(primary + tertiary);
    return [{ index: Number(m[1]), primary, tertiary, surface }];
  });
}

export async function wallpaperPalettes(path: string): Promise<Palette[]> {
  const { stdout } = await runScript("wallpaper-colours.sh", [path], 16 * 1024);
  return parsePalettes(stdout);
}

function hslHex(h: number, s: number, l: number): string {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    return Math.round((l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))) * 255).toString(16).padStart(2, "0");
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

// Accents are pinned as-is, so they are muted and light enough to read on a dark
// surface. One saturation and lightness keeps every hue equally strong.
export const ACCENTS: { name: string; hex: string; keywords: string[] }[] = [
  ...([["Red", 0, ""], ["Orange", 28, "amber"], ["Yellow", 52, "gold"], ["Green", 120, "sage"],
    ["Teal", 172, "cyan"], ["Sky", 202, "light blue"], ["Blue", 218, ""], ["Violet", 256, "purple lavender"],
    ["Pink", 324, "rose"]] as const).map(([name, h, keywords]) => ({ name, hex: hslHex(h, 0.42, 0.66), keywords: keywords.split(" ") })),
  { name: "Silver", hex: hslHex(220, 0.06, 0.8), keywords: ["grey", "gray", "neutral"] },
  { name: "Stone", hex: hslHex(32, 0.1, 0.62), keywords: ["grey", "gray", "neutral", "warm"] },
  { name: "Slate", hex: hslHex(214, 0.16, 0.55), keywords: ["grey", "gray", "neutral", "cool"] },
];

// "Deep Blue" / "Light Blue" when one image yields two blues.
export function namePalettes(hexes: string[]): string[] {
  const words: Record<number, string[]> = { 2: ["Deep", "Light"], 3: ["Deep", "Mid", "Light"], 4: ["Deepest", "Deep", "Light", "Lightest"] };
  const names = hexes.map((hex) => capitalise(accentFamilyOf(hex)) || "Colour");
  const out = [...names];
  for (const name of new Set(names)) {
    const same = names.flatMap((n, i) => (n === name ? [i] : []));
    if (same.length < 2) continue;
    same.sort((a, b) => lightnessOf(hexes[a]) - lightnessOf(hexes[b]))
      .forEach((i, rank) => { out[i] = `${words[same.length][rank]} ${name}`; });
  }
  return out;
}

export function readPaletteIndex(): number {
  try {
    const value = readFileSync(process.env.WALLPAPER_PICKER_SOURCE_INDEX || join(STATE_DIR, "wallpaper-picker", "source-index"), "utf8").trim();
    return /^[0-3]$/.test(value) ? Number(value) : 0;
  } catch { return 0; }
}

// The palette last chosen for this wallpaper, which apply-wallpaper.sh restores
// whenever it comes back; null when that is simply the first one.
export function readRememberedPalette(path: string): number | null {
  try {
    const file = process.env.WALLPAPER_PICKER_PALETTES || join(STATE_DIR, "wallpaper-picker", "palettes");
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const tab = line.indexOf("\t");
      if (tab > 0 && line.slice(tab + 1) === path && /^[0-3]$/.test(line.slice(0, tab))) return Number(line.slice(0, tab));
    }
  } catch { /* nothing remembered yet */ }
  return null;
}

export function readAccent(): string | null {
  try {
    return normaliseHex(readFileSync(process.env.WALLPAPER_PICKER_CUSTOM_ACCENT || join(STATE_DIR, "wallpaper-picker", "custom-accent"), "utf8"));
  } catch { return null; }
}

function rgbOf(hex: string): [number, number, number] | null {
  const value = normaliseHex(hex);
  if (!value) return null;
  return [
    Number.parseInt(value.slice(1, 3), 16) / 255,
    Number.parseInt(value.slice(3, 5), 16) / 255,
    Number.parseInt(value.slice(5, 7), 16) / 255,
  ];
}

export function capitalise(word: string): string {
  return word ? word[0].toUpperCase() + word.slice(1) : word;
}

// "Blue", "Teal", "Neutral": a wallpaper's library family, capitalised, so the
// search hint names a picture the way the colour filter does. Palette accents
// are named by accentFamilyOf instead.
export function nameOf(hex: string): string {
  const g = groupOf(hex);
  return g ? capitalise(g) : "Colour";
}

// HSL lightness. Only used to rank one hue's shades against each other, so the
// midpoint of the extremes is enough and there is no reason to weight channels.
export function lightnessOf(hex: string): number {
  const rgb = rgbOf(hex);
  if (!rgb) return 0;
  const [r, g, b] = rgb;
  return (Math.max(r, g, b) + Math.min(r, g, b)) / 2;
}

// The extension is the one part of a filename nobody reads: every entry is an
// image, so ".jpg" is four characters of noise on names - "wallhaven-k8d8xq", "139396752_p0" -
// that are already hard enough to scan. The full filename stays in the tile's
// tooltip and in its search keywords, so nothing becomes unfindable.
export function prettyName(name: string): string {
  return name.replace(/\.(jpe?g|png|webp|mp4|webm|mkv)$/i, "");
}

// Most wallpaper collections are named by where a file came from, not by what
// it shows: "wallhaven-xxxxxx", reddit ids ("mybe1jyraahg1"), bare numbers
// ("043"), "wp12895982" or an export stamp ("ChatGPT Image Sep 24, ...").
// This tells the few real names ("night-snow") apart, so the UI can use a name
// where there is one and describe the picture where there is not.
export function readableName(name: string): string | null {
  const base = prettyName(name).replace(/[-_]?[0-9a-f]{16,}$/i, "");
  if (/^wallhaven-[a-z0-9]{6}$/i.test(base)) return null;
  if (/^(ChatGPT Image|Screenshot)\b/i.test(base)) return null;
  if (/^(IMG|DSC|PXL|wp)[\s_-]?\d/i.test(base)) return null;
  // One run of letters and digits with no separator, and digits in it, is an
  // id: "fyfx4t95fn9h1", "139396752_p0". A real word ("road") has no digits.
  if (/^[a-z0-9]+$/i.test(base.replace(/_p\d+$/, "")) && /\d/.test(base)) return null;
  // Fewer than three letters once digits and separators go ("b-476", "e") is a
  // label, not a name.
  if (base.replace(/[^a-z]/gi, "").length < 3) return null;
  return base.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}


// ---- persisted state -------------------------------------------------------
//
// Favourites are stored locally under XDG_STATE_HOME.


const STATE_DIR =
  process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");

const solidCache = new Cache({ namespace: "solid-colour" });
export function readSolidColour(): string {
  try { return normaliseHex(solidCache.get("last") ?? "") ?? "#111827"; }
  catch { return "#111827"; }
}
export function rememberSolidColour(value: string): void {
  const hex = normaliseHex(value);
  if (!hex) return;
  try { solidCache.set("last", hex); } catch { /* colour history is optional */ }
}

export const FAVOURITES_FILE =
  process.env.WALLPAPER_PICKER_FAVOURITES || join(STATE_DIR, "wallpaper-picker", "favourites");

export function readFavourites(): Set<string> {
  try {
    return new Set(
      readFileSync(FAVOURITES_FILE, "utf8")
        .split("\n")
        .filter(Boolean),
    );
  } catch {
    return new Set();
  }
}

export function writeFavourites(paths: Set<string>): boolean {
  // Temp file then rename: the launcher can be killed
  // outright, and a half-written list drops stars silently rather than loudly.
  const tmp = `${FAVOURITES_FILE}.${process.pid}`;
  try {
    mkdirSync(dirname(FAVOURITES_FILE), { recursive: true, mode: 0o700 });
    writeFileSync(tmp, [...paths].join("\n") + (paths.size ? "\n" : ""), { mode: 0o600 });
    renameSync(tmp, FAVOURITES_FILE);
    return true;
  } catch {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* preserve the original write failure */
    }
    return false;
  }
}

// The previous command swaps between the last two successfully applied images.
export function readPrevious(): string | null {
  try {
    return readFileSync(process.env.WALLPAPER_PICKER_PREVIOUS || join(STATE_DIR, "wallpaper-picker", "previous"), "utf8").split("\n")[0] || null;
  } catch { return null; }
}

// --- live wallpapers ----------------------------------------------------------
//
// live-wallpaper.py owns the player and its state files; the extension only
// asks it, so a keybind, the picker and a login restore can never disagree.
export type LivePolicy = "never" | "covered" | "windows";
export type LiveStatus = { running: boolean; paused: boolean; policy: LivePolicy };

export const LIVE_POLICIES: { id: LivePolicy; title: string }[] = [
  { id: "never", title: "Never" },
  { id: "covered", title: "A Window Is Fullscreen or Maximized" },
  { id: "windows", title: "Any Window Is Open" },
];

export function isLive(path: string): boolean {
  return /\.(mp4|webm|mkv)$/i.test(path);
}

const runLive = (args: string[]) => run("python3", [script("live-wallpaper.py"), ...args], { maxBuffer: 64 * 1024 });

const liveCache = new Cache({ namespace: "live" });
export function readLiveStatus(): LiveStatus | null {
  try {
    const s = JSON.parse(liveCache.get("status") ?? "null") as Partial<LiveStatus> | null;
    return s && typeof s.running === "boolean" && typeof s.paused === "boolean" && LIVE_POLICIES.some((p) => p.id === s.policy)
      ? { running: s.running, paused: s.paused, policy: s.policy as LivePolicy } : null;
  } catch { return null; }
}
export function rememberLiveStatus(status: LiveStatus): void {
  try { liveCache.set("status", JSON.stringify(status)); } catch { /* only a first-paint hint */ }
}

export async function liveStatus(): Promise<LiveStatus | null> {
  try {
    return JSON.parse((await runLive(["status"])).stdout) as LiveStatus;
  } catch {
    return null;
  }
}

// pause | resume | toggle, or ["policy", id]. Takes effect immediately on a
// running player and on the next one otherwise.
export async function liveControl(...args: string[]): Promise<boolean> {
  try {
    await runLive(args);
    return true;
  } catch {
    return false;
  }
}

// Buckets a dominant colour into a named family, so the library can be narrowed
// to "the blue ones". Ported from the picker's ColorGroups singleton, including
// the two-threshold neutral test: absolute chroma alone calls every dim navy
// grey, relative saturation alone promotes near-black noise to a confident hue,
// and requiring both is what puts a dark blue wallpaper in blue while a charcoal
// one still lands in neutral.
export const COLOR_GROUPS = [
  "red", "orange", "yellow", "green", "teal", "blue", "purple", "pink", "neutral",
] as const;

const BANDS: [string, number, number][] = [
  ["orange", 15, 45], ["yellow", 45, 70], ["green", 70, 160], ["teal", 160, 200],
  ["blue", 200, 250], ["purple", 250, 292], ["pink", 292, 345],
];

export function groupOf(hex: string): string {
  const rgb = rgbOf(hex);
  if (!rgb) return "";
  const max = Math.max(...rgb);
  const chroma = max - Math.min(...rgb);
  if (chroma < 0.05 || max === 0 || chroma / max < 0.25) return "neutral";
  return hueBandOf(rgb, max, chroma);
}

// The family of a theme accent rather than of a photo. Matugen's dark-scheme
// accents are light tones, and a clear lavender like #c1c1ff has a saturation
// ratio of only 0.24, so groupOf's photo rule calls it grey: 25 of the 38
// "Neutral" palettes in a 169-image library were lavenders and orchids. Its
// true greys stay under 0.02 of chroma and its coloured accents above 0.2.
export function accentFamilyOf(hex: string): string {
  const rgb = rgbOf(hex);
  if (!rgb) return "";
  const max = Math.max(...rgb);
  const chroma = max - Math.min(...rgb);
  return chroma < 0.06 ? "neutral" : hueBandOf(rgb, max, chroma);
}

function hueBandOf([r, g, b]: [number, number, number], max: number, chroma: number): string {
  let h = max === r ? ((g - b) / chroma) % 6 : max === g ? (b - r) / chroma + 2 : (r - g) / chroma + 4;
  h *= 60;
  if (h < 0) h += 360;
  return BANDS.find(([, from, to]) => h >= from && h < to)?.[0] ?? "red";
}

// The colour sort. A plain hue sort reads as a shuffle on a dark library: one
// hue holds a pale sky next to a near-black night, and the greys came out in
// filename order. Instead, colour families in rainbow order (the same families
// as the dropdown and the sections), each one light to dark, greys last.
export function colourOrder(a: Wallpaper, b: Wallpaper): number {
  const rank = (w: Wallpaper) => COLOR_GROUPS.indexOf(w.group as (typeof COLOR_GROUPS)[number]);
  return rank(a) - rank(b) || b.brightness - a.brightness || a.name.localeCompare(b.name);
}

// Where the picker was left: the dropdown filter and the sort. Restored on the
// next open, so "Live" or "Blue" stays picked until it is changed.
const viewCache = new Cache({ namespace: "view" });
export type View = { filter: string; sort: string; colour?: string; transition?: Transition; duration?: string };

export function readView(): Partial<View> {
  try {
    const parsed: unknown = JSON.parse(viewCache.get("v1") ?? "{}");
    const view = parsed as Record<string, unknown>;
    const filter = typeof view?.filter === "string" ? view.filter : undefined;
    const colour = typeof view?.colour === "string" ? view.colour : filter?.startsWith("c:") ? filter.slice(2) : undefined;
    return {
      filter: filter?.startsWith("c:") ? "" : filter,
      sort: typeof view?.sort === "string" ? view.sort : undefined,
      ...(typeof colour === "string" && COLOR_GROUPS.includes(colour as typeof COLOR_GROUPS[number]) ? { colour } : {}),
      ...(view?.transition === "doom" ? { transition: "soft-fade" as Transition, duration: "auto" }
        : {
          ...(TRANSITIONS.some((t) => t.id === view?.transition) ? { transition: view.transition as Transition } : {}),
          ...(typeof view?.duration === "string" && TRANSITION_DURATIONS.includes(view.duration as TransitionDuration) ? { duration: view.duration } : {}),
        }),
    };
  } catch {
    return {};
  }
}

export function writeView(view: View): void {
  try {
    viewCache.set("v1", JSON.stringify(view));
  } catch {
    /* losing the remembered view is not an error */
  }
}

// ---- library cache ---------------------------------------------------------


// No expiry. This exists to skip the empty grid on open, not to avoid scanning:
// the real scan always runs and replaces the first paint about 0.1 s later. The
// five-minute TTL this had only bounded that tenth of a second of staleness, and
// most opens come further apart, so they still opened empty: 164 ms to the grid
// against 84 ms from the cache (2026-11-10, 178 wallpapers).
const cache = new Cache({ namespace: "library" });

// The version is in the key because the read below promises that a
// version-skewed entry is a cache miss, and the shape check alone cannot
// deliver that: a list written before `group` and `hue` were derived at scan
// time still parses as an array of objects, so it comes back accepted with
// those fields undefined. That is not a crash - the real scan overwrites it a
// tenth of a second later - but until it lands the colour rail is empty and
// the colour filter matches nothing, which reads as the feature being broken.
// Bump this whenever a field is added to Wallpaper.
const KEY = "wallpapers.v4";

type CachedLibrary = {
  scope: Required<Pick<ScanOptions, "depth" | "includeCurrent">> & Pick<ScanOptions, "directory">;
  wallpapers: Wallpaper[];
};

function scanScope(options: ScanOptions) {
  return {
    directory: libraryDirectory(options.directory),
    depth: options.depth ?? "3",
    includeCurrent: options.includeCurrent ?? true,
  };
}

function isWallpaper(value: unknown): value is Wallpaper {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.path === "string" &&
    item.path.length > 0 &&
    typeof item.name === "string" &&
    typeof item.thumb === "string" &&
    typeof item.current === "boolean" &&
    typeof item.color === "string" &&
    typeof item.folder === "string" &&
    typeof item.group === "string" &&
    typeof item.title === "string" &&
    Array.isArray(item.tags) && item.tags.every((tag) => typeof tag === "string") &&
    typeof item.source === "string" &&
    typeof item.resolution === "string" &&
    typeof item.mtime === "number" &&
    Number.isFinite(item.mtime) &&
    typeof item.brightness === "number" &&
    Number.isFinite(item.brightness)
  );
}

export function readCachedLibrary(options: ScanOptions = {}): Wallpaper[] | null {
  try {
    const raw = cache.get(KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const entry = parsed as Partial<CachedLibrary>;
    if (JSON.stringify(entry.scope) !== JSON.stringify(scanScope(options))) return null;
    return Array.isArray(entry.wallpapers) && entry.wallpapers.length > 0 && entry.wallpapers.every(isWallpaper)
      ? entry.wallpapers
      : null;
  } catch {
    // A corrupt or version-skewed entry is a cache miss, never a crash.
    return null;
  }
}

export function writeCachedLibrary(list: Wallpaper[], options: ScanOptions = {}): void {
  try {
    cache.set(KEY, JSON.stringify({ scope: scanScope(options), wallpapers: list } satisfies CachedLibrary));
  } catch {
    /* the cache is an optimisation; failing to write one is not an error */
  }
}
