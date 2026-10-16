import { Cache, environment } from "@vicinae/api";
import { execFile, spawn } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const run = promisify(execFile);

// The shell pipeline is the part worth keeping. scan-wallpapers.sh already walks
// the library, maintains the 800x500 thumbnail cache and the dominant-colour
// cache, and apply-wallpaper-theme.sh already owns the matugen run, the awww
// transition and the neutral-mode switch. Reimplementing any of that in
// TypeScript would be a second source of truth for behaviour that is already
// correct — the extension is a new *front end*, not a new backend.
//
// `npm run build` bundles the scripts into the extension's assets, so an
// installed extension is self-contained. WALLPAPER_PICKER_DIR points it at a
// checkout instead. Resolved per call: `environment` only exists in the host.
const script = (name: string) =>
  join(process.env.WALLPAPER_PICKER_DIR ?? join(environment.assetsPath, "backend"), name);

// Run through bash rather than exec'ing the file, so a bundler that drops the
// executable bit cannot break the extension.
const runScript = (name: string, args: string[], maxBuffer: number, env?: NodeJS.ProcessEnv) =>
  run("bash", [script(name), ...args], { maxBuffer, env });

const onPath = (cmd: string) =>
  (process.env.PATH ?? "").split(":").some((dir) => {
    try {
      accessSync(join(dir, cmd), constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });

// Hard requirements of the shell backend; anything else (jq, kitty, hyprctl,
// notify-send) is optional and skipped when absent. Checked up front because an
// apply runs detached and its failures would otherwise be silent.
export function missingTools(): string[] {
  const need = [["awww"], ["matugen"], ["magick", "convert"], ["flock"]];
  return need.filter((alternatives) => !alternatives.some(onPath)).map((alternatives) => alternatives.join(" or "));
}

export function libraryDirectory(directory?: string): string {
  return directory || process.env.WALLPAPER_DIR || join(homedir(), "Pictures", "wallpaper");
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
  // Both of these were recomputed inside render: groupOf ran in the colour-rail
  // memo, again in the visible-list memo on every filter change, and again per
  // tile to build its search keywords — roughly 350 hex parses per keystroke on
  // a 115-wallpaper library, to answer a question whose input never changes.
  // Parsing each colour once here makes the filters plain field comparisons.
  group: string;
  hue: number;
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

export function filterLibrary(items: Wallpaper[], filter: string, favourites: Set<string>): Wallpaper[] {
  if (filter === "fav") return items.filter((w) => favourites.has(w.path));
  if (filter === "current") return items.filter((w) => w.current);
  if (filter === "archive") return items.filter(isArchived);
  if (filter.startsWith("f:")) return items.filter((w) => w.folder === filter.slice(2));
  const active = items.filter((w) => !isArchived(w));
  return filter.startsWith("c:") ? active.filter((w) => w.group === filter.slice(2)) : active;
}

export type Scheme = {
  index: number;
  source: string;
  primary: string;
  tertiary: string;
  surface: string;
};

// scan-wallpapers.sh emits one tab-separated record per wallpaper:
//   path \t name \t thumb \t current \t color \t folder \t mtime
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
  const directory = realpathSync(wanted);
  env.WALLPAPER_DIR = directory;
  if (options.depth) env.WALLPAPER_SCAN_DEPTH = options.depth;
  if (typeof options.includeCurrent === "boolean") {
    env.WALLPAPER_INCLUDE_CURRENT = options.includeCurrent ? "1" : "0";
  }
  if (options.cacheOnly) env.WALLPAPER_PICKER_CACHE_ONLY = "1";
  const { stdout } = await runScript("scan-wallpapers.sh", [], 32 * 1024 * 1024, env);
  let metadata: Record<string, WallpaperMetadata> = {};
  try { metadata = parseLibraryMetadata(readFileSync(join(directory, ".wallpaper-library.json"), "utf8")); } catch { /* optional catalogue */ }
  const out: Wallpaper[] = [];
  for (const line of stdout.split("\n")) {
    if (!line) continue;
    const p = line.split("\t");
    if (p.length < 2 || !p[0]) continue;
    const color = p[4]?.trim() ?? "";
    const details = metadata[relative(directory, p[0])];
    out.push({
      path: p[0],
      name: p[1],
      thumb: p[2] && p[2].length > 0 ? p[2] : p[0],
      current: p[3] === "1",
      color,
      folder: p[5]?.trim() || "Root",
      mtime: Number.parseInt(p[6] ?? "0", 10) || 0,
      // A missing or malformed cache hint is still a neutral-looking item. Use
      // the same fallback the colour sections use so the dropdown, sections and
      // search keywords never disagree about where that wallpaper belongs.
      group: groupOf(color) || "neutral",
      hue: hueOf(color),
      title: details?.title || readableName(p[1]) || "",
      tags: details?.tags ?? [],
      source: details?.source || (/^wallhaven-[a-z0-9]{6}\./i.test(basename(p[0]))
        ? `https://wallhaven.cc/w/${basename(p[0]).slice(10, 16)}` : ""),
      resolution: details?.resolution ?? "",
    });
  }
  return out;
}

// scan-colors.sh prints: index source primary tertiary surface
export async function scanSchemes(wallpaper: string): Promise<Scheme[]> {
  const { stdout } = await runScript("scan-colors.sh", [wallpaper], 4 * 1024 * 1024);
  const out = new Map<number, Scheme>();
  for (const line of stdout.split("\n")) {
    const p = line.trim().split(/\s+/);
    if (p.length < 5) continue;
    const index = Number.parseInt(p[0], 10);
    const source = matugenHex(p[1]);
    const primary = matugenHex(p[2]);
    const tertiary = matugenHex(p[3]);
    const surface = matugenHex(p[4]);
    if (!Number.isInteger(index) || index < 0 || index > 3 || !source || !primary || !tertiary || !surface) {
      continue;
    }
    out.set(index, {
      index,
      source,
      primary,
      tertiary,
      surface,
    });
  }
  // Hue order, so a wallpaper's palettes appear in a stable, predictable order
  // rather than in extraction order.
  const distinct = new Map<string, Scheme>();
  for (const scheme of out.values()) {
    const key = `${scheme.primary}:${scheme.tertiary}:${scheme.surface}`;
    if (!distinct.has(key) || scheme.index === 0) distinct.set(key, scheme);
  }
  return [...distinct.values()].sort((a, b) => hueOf(a.primary) - hueOf(b.primary));
}

export function hueOf(hex: string): number {
  // 1e6 rather than -1 for the unparseable case: the sort uses this directly, and
  // uncoloured wallpapers should sink to the end rather than clump at red.
  const rgb = rgbOf(hex);
  if (!rgb) return 1e6;
  const [r, g, b] = rgb;
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  // Keep the sort in step with groupOf: low-chroma charcoal should land in the
  // final Neutral section instead of borrowing a random hue from tiny channel
  // noise (for example #181824 otherwise sorts as blue).
  if (d < 0.05 || max === 0 || d / max < 0.25) return 1e6;
  let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h *= 60;
  return h < 0 ? h + 360 : h;
}

// Detached on purpose. The apply takes seconds (matugen, then the awww
// transition) and holds a lock; keeping the extension process attached to it
// would block the launcher on work whose result it never reads.
//
// The shell's fourth argument is CUSTOM_ACCENT, and it is positional, so the
// transition occupies the third argument even when no accent is supplied.
// Passing an accent switches
// apply-wallpaper-theme.sh from `matugen image --source-color-index` to
// `matugen color hex`, and makes the script pin the accent in its own state
// file; omitting it makes the script CLEAR that pin. That is why this signature
// takes the accent rather than the extension writing the state file itself:
// set and clear are the same code path on the backend and must stay that way.
// Returns false when there is nothing to apply, so the caller can say so.
//
// Detaching with stdio ignored is what makes the apply asynchronous, and it is
// also what makes every one of its failures invisible: the script's "Wallpaper
// not found" goes to a closed descriptor, the window has already been asked to
// close, and the desktop simply does not change. The grid can genuinely offer a
// file that is gone - it paints from the cache above before the rescan lands,
// and the library is a directory someone prunes by hand - so check the one
// failure the extension can actually predict, and leave the rest detached.
export type ApplyOptions = {
  wallpaperOnly?: boolean;
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

export function applyWallpaper(
  path: string,
  schemeIndex: number,
  customAccent?: string,
  options: ApplyOptions = {},
): boolean {
  const applyScript = script("apply-wallpaper-theme.sh");
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
    String(schemeIndex),
    process.env.WALLPAPER_PICKER_TRANSITION ?? options.transition ?? "spotlight-wave",
  ];
  if (customAccent) args.push(customAccent);
  const env = { ...process.env };
  env.WALLPAPER_PICKER_LOG = "1";
  if (options.wallpaperOnly !== undefined) {
    env.WALLPAPER_PICKER_WALLPAPER_ONLY = options.wallpaperOnly ? "1" : "0";
  }
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

export function wallpaperPreviewMarkdown(wallpaper: Pick<Wallpaper, "thumb">): string {
  // URL encoding preserves spaces, # and non-ASCII filenames in Markdown.
  const url = pathToFileURL(wallpaper.thumb).href.replace(/\(/g, "%28").replace(/\)/g, "%29");
  return `![Wallpaper preview](${url})`;
}

// One hand-picked colour, run through the same extractor the wallpaper palettes
// come from, so the preview cell and the eventual apply cannot disagree.
//
// scan-colors.sh --color reports index -1, which is how a custom scheme is told
// apart from the 0-3 the image yields.
export const CUSTOM_INDEX = -1;

export async function scanCustomScheme(hex: string): Promise<Scheme | null> {
  const { stdout } = await runScript("scan-colors.sh", ["--color", hex], 1024 * 1024);
  const p = stdout.trim().split(/\s+/);
  if (p.length < 5) return null;
  const source = matugenHex(p[1]);
  const primary = matugenHex(p[2]);
  const tertiary = matugenHex(p[3]);
  const surface = matugenHex(p[4]);
  if (!source || !primary || !tertiary || !surface) return null;
  return {
    index: CUSTOM_INDEX,
    source,
    primary,
    tertiary,
    surface,
  };
}

// Matugen may emit an alpha suffix. The picker only uses opaque theme roles,
// so trim valid #RRGGBBAA output to the same canonical #rrggbb shape as typed
// accents and reject anything else at the process boundary.
function matugenHex(raw: string): string | null {
  const value = raw.trim();
  if (!/^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/.test(value)) return null;
  return value.slice(0, 7).toLowerCase();
}

// Accepts what a person actually types: with or without the hash, three digits
// or six, any case. Returns the canonical form the shell scripts validate
// against, or null - which is also the "not a colour, do nothing" signal for
// the palette step's search bar.
export function normaliseHex(raw: string): string | null {
  const t = raw.trim().replace(/^#/, "");
  if (/^[0-9a-fA-F]{6}$/.test(t)) return `#${t.toLowerCase()}`;
  if (/^[0-9a-fA-F]{3}$/.test(t)) {
    return `#${t.toLowerCase().split("").map((c) => c + c).join("")}`;
  }
  return null;
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

// Hex is what the swatch is stored and matched as, but it is not what every
// workflow wants pasted elsewhere - a config file or a design tool more often
// takes decimal channels. "" rather than throwing: this sits next to a
// clipboard action, where a bad hex should copy nothing rather than crash it.
export function rgbString(hex: string): string {
  const rgb = rgbOf(hex);
  if (!rgb) return "";
  return rgb.map((c) => Math.round(c * 255)).join(", ");
}

export function capitalise(word: string): string {
  return word ? word[0].toUpperCase() + word.slice(1) : word;
}

// "Blue", "Teal", "Neutral". groupOf already buckets a colour for the library
// rail; the palette cells want the same answer with a capital letter, so the
// two lists name a colour identically.
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

const SHADE_WORDS: Record<number, string[]> = {
  2: ["Deep", "Light"],
  3: ["Deep", "Mid", "Light"],
  4: ["Deepest", "Deep", "Light", "Lightest"],
};

// Names a whole set of palettes at once, so that two of them can never arrive
// with the same title.
//
// nameOf buckets by hue, and one image routinely yields several palettes from
// the same family - often two cells reading "Blue", separable only by the hex
// underneath. The swatch does distinguish them, but
// the title is the largest text in the cell and on those wallpapers it is the
// one part carrying no information.
//
// Qualified only where it has to be. A set with no collision keeps its plain
// names, so the common case is still "Blue", "Teal", "Neutral" and the extra
// word shows up exactly when it is telling you something. Ordered by lightness
// because within one hue that is what actually differs - matugen's primaries
// for a dark scheme sit at the same chroma and vary by tone.
export function nameSchemes(hexes: string[]): string[] {
  const names = hexes.map(nameOf);
  const positions = new Map<string, number[]>();
  names.forEach((name, index) => {
    const seen = positions.get(name) ?? [];
    seen.push(index);
    positions.set(name, seen);
  });

  const out = [...names];
  for (const [name, indices] of positions) {
    const words = SHADE_WORDS[indices.length];
    // One of a hue needs no qualifier, and beyond four there is no vocabulary
    // worth inventing - the hex subtitle is a better answer than "Deepester".
    if (!words) continue;
    [...indices]
      .sort((a, b) => lightnessOf(hexes[a]) - lightnessOf(hexes[b]))
      .forEach((position, rank) => {
        out[position] = `${words[rank]} ${name}`;
      });
  }
  return out;
}

// The extension is the one part of a filename nobody reads: every entry is an
// image, so ".jpg" is four characters of noise on names - "wallhaven-k8d8xq", "139396752_p0" -
// that are already hard enough to scan. The full filename stays in the tile's
// tooltip and in its search keywords, so nothing becomes unfindable.
export function prettyName(name: string): string {
  return name.replace(/\.(jpe?g|png|webp)$/i, "");
}

export function displayName(name: string, showExtensions: boolean): string {
  return showExtensions ? name : prettyName(name);
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

// ---- accent picker ---------------------------------------------------------
//
// Pinning your own accent used to mean typing a hex into the palette step's
// search bar, which only works if you already know the number you want. The
// picker offers a wheel of named seeds instead, each shown as the solid primary
// colour matugen actually derives from it, and still takes a typed hex -
// or now a colour name - for anything off the wheel.
//
// Seeds are computed from hue angles rather than listed as hexes: they are only
// matugen inputs, never colours anything is painted with, and one saturation /
// lightness for the whole wheel keeps every step equally strong. The names are
// the ones people reach for, spaced so neighbours still look different once
// matugen has turned them into a dark-theme primary.
export type AccentSeed = { name: string; seed: string; neutral: boolean };

function hslHex(h: number, s: number, l: number): string {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const v = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(v * 255).toString(16).padStart(2, "0");
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

const WHEEL: [string, number][] = [
  ["Red", 0], ["Orange", 28], ["Yellow", 52], ["Green", 120], ["Teal", 172],
  ["Sky", 202], ["Blue", 218], ["Violet", 256], ["Pink", 324],
];

// Low-chroma seeds give the quiet, almost-grey accents a colour wheel cannot:
// a cool silver, a warm stone, a blue-grey slate.
const NEUTRALS: [string, number, number, number][] = [
  ["Silver", 220, 0.06, 0.8],
  ["Stone", 32, 0.1, 0.62],
  ["Slate", 214, 0.16, 0.55],
];

export const ACCENT_SEEDS: AccentSeed[] = [
  // Muted inputs retain distinct hues under scheme-fidelity without turning
  // every accent into a neon colour. Previews still use matugen's output.
  ...WHEEL.map(([name, h]) => ({ name, seed: hslHex(h, 0.32, 0.52), neutral: false })),
  ...NEUTRALS.map(([name, h, sat, l]) => ({ name, seed: hslHex(h, sat, l), neutral: true })),
];

// A hex in any of the forms normaliseHex takes, or one of the seed names above
// ("teal", "Rose"). Returns the seed to hand matugen, or null.
export function parseColour(raw: string): string | null {
  const hex = normaliseHex(raw);
  if (hex) return hex;
  const want = raw.trim().toLowerCase();
  if (want.length < 3) return null;
  const aliases: Record<string, string> = {
    grey: "silver", gray: "silver", rose: "pink", sage: "green",
    amber: "orange", purple: "violet", lavender: "violet", cyan: "teal", "sky blue": "sky",
  };
  return ACCENT_SEEDS.find((a) => a.name.toLowerCase() === (aliases[want] ?? want))?.seed ?? null;
}

// scanCustomScheme, remembered. A seed always derives the same scheme.
const accentCache = new Cache({ namespace: "accents" });

export async function accentScheme(seed: string): Promise<Scheme | null> {
  const key = `v1:${seed.toLowerCase()}`;
  try {
    const hit = accentCache.get(key);
    if (hit) return JSON.parse(hit) as Scheme;
  } catch {
    /* a bad entry is a miss */
  }
  const s = await scanCustomScheme(seed).catch(() => null);
  if (s) {
    try {
      accentCache.set(key, JSON.stringify(s));
    } catch {
      /* the cache is an optimisation */
    }
  }
  return s;
}

// How strongly a colour reads as the hue it is filed under: chroma, weighted by
// how much light there is to carry it. The colour rail uses this to pick one
// swatch to stand for a whole family - its most saturated member looks like
// what the label says, where the family's average would look like mud.
export function vividnessOf(hex: string): number {
  const rgb = rgbOf(hex);
  if (!rgb) return -1;
  const [r, g, b] = rgb;
  const max = Math.max(r, g, b);
  return (max - Math.min(r, g, b)) * max;
}

// ---- persisted state -------------------------------------------------------
//
// Favourites and neutral mode are plain state files under XDG_STATE_HOME. The
// shell pipeline reads the neutral marker too (apply-wallpaper-theme.sh checks
// it), so a second source of truth would silently disagree with the thing that
// actually themes the desktop.


const STATE_DIR =
  process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");

export const FAVOURITES_FILE =
  process.env.WALLPAPER_PICKER_FAVOURITES ?? join(STATE_DIR, "wallpaper-picker", "favourites");
export const NEUTRAL_FILE =
  process.env.WALLPAPER_PICKER_NEUTRAL ?? join(STATE_DIR, "wallpaper-picker", "neutral-mode");

export function readFavourites(): Set<string> {
  try {
    return new Set(
      readFileSync(FAVOURITES_FILE, "utf8")
        .split("\n")
        .map((l) => l.trim())
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
    mkdirSync(dirname(FAVOURITES_FILE), { recursive: true });
    writeFileSync(tmp, [...paths].join("\n") + (paths.size ? "\n" : ""));
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

// What the desktop is wearing right now.
//
// Two separate questions, deliberately kept apart. colors.json is matugen's own
// output - the single file every template renders from - so its `primary` is
// the accent actually on screen no matter how it got there. The custom-accent
// state file only answers whether that accent was PINNED by hand, which is the
// half that decides whether re-applying should keep the pin or drop back to the
// image. Reading the pin from the palette instead would be a guess: a wallpaper
// can legitimately extract to the same colour someone once typed.
export const GENERATED_COLORS =
  process.env.WALLPAPER_PICKER_GENERATED_COLORS ??
  join(STATE_DIR, "theme", "generated", "colors.json");

export const CUSTOM_ACCENT_FILE =
  process.env.WALLPAPER_PICKER_CUSTOM_ACCENT ??
  join(STATE_DIR, "wallpaper-picker", "custom-accent");

const SAVED_ACCENTS_FILE = join(STATE_DIR, "wallpaper-picker", "saved-accents.json");
export type SavedAccent = { seed: string; name: string };

export function readSavedAccents(): SavedAccent[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(SAVED_ACCENTS_FILE, "utf8"));
    if (!Array.isArray(parsed)) return [];
    const accents = new Map<string, SavedAccent>();
    for (const item of parsed) {
      const seed = typeof item?.seed === "string" ? normaliseHex(item.seed) : null;
      if (seed) accents.set(seed, { seed, name: typeof item.name === "string" && item.name.trim() ? item.name.trim() : nameOf(seed) });
    }
    return [...accents.values()];
  } catch { return []; }
}

export function writeSavedAccents(accents: SavedAccent[]): boolean {
  const tmp = `${SAVED_ACCENTS_FILE}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(SAVED_ACCENTS_FILE), { recursive: true });
    writeFileSync(tmp, JSON.stringify(accents));
    renameSync(tmp, SAVED_ACCENTS_FILE);
    return true;
  } catch {
    try { rmSync(tmp, { force: true }); } catch { /* preserve original error */ }
    return false;
  }
}

export function readAppliedPrimary(): string {
  try {
    const parsed: unknown = JSON.parse(readFileSync(GENERATED_COLORS, "utf8"));
    const primary = (parsed as Record<string, unknown>)?.primary;
    return typeof primary === "string" ? (matugenHex(primary) ?? "") : "";
  } catch {
    // No theme generated yet, or a half-written file mid-apply. Nothing gets
    // marked current, which is the correct answer rather than a crash.
    return "";
  }
}

export function readCustomAccent(): string {
  try {
    return normaliseHex(readFileSync(CUSTOM_ACCENT_FILE, "utf8")) ?? "";
  } catch {
    return "";
  }
}

export function clearCustomAccent(): boolean {
  try {
    rmSync(CUSTOM_ACCENT_FILE, { force: true });
    return true;
  } catch {
    return false;
  }
}

// Presence is the flag; there is no file format for a boolean.
export function readNeutral(): boolean {
  return existsSync(NEUTRAL_FILE);
}

export function writeNeutral(on: boolean): boolean {
  try {
    if (on) {
      mkdirSync(dirname(NEUTRAL_FILE), { recursive: true });
      writeFileSync(NEUTRAL_FILE, "");
    } else {
      rmSync(NEUTRAL_FILE, { force: true });
    }
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
  const [r, g, b] = rgb;
  const max = Math.max(r, g, b);
  const chroma = max - Math.min(r, g, b);
  if (chroma < 0.05 || max === 0 || chroma / max < 0.25) return "neutral";
  let h = max === r ? ((g - b) / chroma) % 6 : max === g ? (b - r) / chroma + 2 : (r - g) / chroma + 4;
  h *= 60;
  if (h < 0) h += 360;
  return BANDS.find(([, from, to]) => h >= from && h < to)?.[0] ?? "red";
}

// ---- library cache ---------------------------------------------------------


// Short TTL on purpose. This exists to skip the ~110ms of empty grid on open,
// not to avoid scanning: the real scan always runs and always wins, so the only
// thing the TTL bounds is how stale the *first paint* can be.
const cache = new Cache({ namespace: "library", ttl: 5 * 60 * 1000 });

// The version is in the key because the read below promises that a
// version-skewed entry is a cache miss, and the shape check alone cannot
// deliver that: a list written before `group` and `hue` were derived at scan
// time still parses as an array of objects, so it comes back accepted with
// those fields undefined. That is not a crash - the real scan overwrites it a
// tenth of a second later - but until it lands the colour rail is empty and
// the colour filter matches nothing, which reads as the feature being broken.
// Bump this whenever a field is added to Wallpaper.
const KEY = "wallpapers.v3";

type CachedLibrary = {
  scope: Required<Pick<ScanOptions, "depth" | "includeCurrent">> & Pick<ScanOptions, "directory">;
  wallpapers: Wallpaper[];
};

function scanScope(options: ScanOptions) {
  return {
    directory: options.directory ?? "",
    depth: options.depth ?? "2",
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
    typeof item.hue === "number" &&
    Number.isFinite(item.hue)
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
