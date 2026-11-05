import {
  Action,
  ActionPanel,
  Grid,
  Icon,
  Toast,
  closeMainWindow,
  getPreferenceValues,
  openExtensionPreferences,
  showToast,
} from "@vicinae/api";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  COLOR_GROUPS,
  LIVE_POLICIES,
  type LiveStatus,
  type ApplyOptions,
  type ScanOptions,
  Wallpaper,
  applyWallpaper,
  capitalise,
  colourOrder,
  filterLibrary,
  isArchived,
  isLive,
  liveControl,
  liveStatus,
  libraryDirectory,
  missingTools,
  nameOf,
  prettyName,
  readableName,
  readCachedLibrary,
  readFavourites,
  readView,
  scanWallpapers,
  vividnessOf,
  writeCachedLibrary,
  writeFavourites,
  writeView,
} from "./lib";

// Sorting and grouping are one control here, not two.
//
// Each sort answers a question - what did I add lately, what is it called,
// which ones are blue - and the only section headings worth reading are that
// same question's axis. Deriving the grouping from the sort means the headers
// always explain the order instead of cutting across it, and the view keeps one
// knob rather than an order-by/group-by matrix nobody wants to operate.
//
// Colour is the default: a grid that flows through the families reads as one
// collection, where date order scatters unrelated colours side by side.
type Sort = "recent" | "name" | "hue";
type GroupBy = "date" | "folder" | "colour";
type Transition = "spotlight-wave" | "iris-close" | "wave-sweep" | "diagonal-wipe" | "soft-fade" | "none";
type TransitionDuration = "auto" | "0.3" | "0.5" | "0.65" | "0.8" | "1.0";
type ResizeMode = "crop" | "fit" | "stretch" | "no";
type CropGravity =
  | "top-left"
  | "top"
  | "top-right"
  | "left"
  | "center"
  | "right"
  | "bottom-left"
  | "bottom"
  | "bottom-right";
type SearchMode = "search" | "browse";
type LayoutMode = "sections" | "flat";
type ScanDepth = "1" | "2" | "3" | "4" | "5";
type ColumnCount = "3" | "4" | "5" | "6";

const SORTS: { id: Sort; title: string; icon: Icon; group: GroupBy }[] = [
  { id: "hue", title: "Colour", icon: Icon.Swatch, group: "colour" },
  { id: "recent", title: "Recently Added", icon: Icon.Clock, group: "date" },
  { id: "name", title: "Name", icon: Icon.Text, group: "folder" },
];

const TRANSITIONS: { id: Transition; title: string; description: string }[] = [
  { id: "spotlight-wave", title: "Spotlight wave", description: "A focused reveal from the centre." },
  { id: "iris-close", title: "Iris close", description: "A closing circle - the reverse of Spotlight wave." },
  { id: "wave-sweep", title: "Wave sweep", description: "A calm top-to-bottom sweep." },
  { id: "diagonal-wipe", title: "Diagonal wipe", description: "A quick diagonal change." },
  { id: "soft-fade", title: "Soft fade", description: "A gentle crossfade." },
  { id: "none", title: "None", description: "Apply instantly without animation." },
];

const DURATION_VALUES: readonly TransitionDuration[] = ["auto", "0.3", "0.5", "0.65", "0.8", "1.0"];
const RESIZE_VALUES: readonly ResizeMode[] = ["crop", "fit", "stretch", "no"];
const GRAVITY_VALUES: readonly CropGravity[] = [
  "center",
  "top",
  "bottom",
  "left",
  "right",
  "top-left",
  "top-right",
  "bottom-left",
  "bottom-right",
];
const SEARCH_MODE_VALUES: readonly SearchMode[] = ["search", "browse"];
const LAYOUT_MODE_VALUES: readonly LayoutMode[] = ["sections", "flat"];
const SCAN_DEPTH_VALUES: readonly ScanDepth[] = ["1", "2", "3", "4", "5"];
const COLUMN_VALUES: readonly ColumnCount[] = ["3", "4", "5", "6"];

function preferenceValue<T extends string>(value: unknown, values: readonly T[], fallback: T): T {
  return typeof value === "string" && values.includes(value as T) ? (value as T) : fallback;
}

function transitionOf(value: unknown): Transition {
  return TRANSITIONS.some((transition) => transition.id === value)
    ? (value as Transition)
    : "spotlight-wave";
}

// Coarse buckets rather than dates. Counting days would produce dozens of
// sections of one, when the question a heading has to answer is only "is this
// new".
const DAY = 86_400_000;
const AGES: [string, number][] = [
  ["Today", 1],
  ["This Week", 7],
  ["This Month", 30],
  ["Last Three Months", 90],
];
const EARLIER = "Earlier";

// The library's crop, as the grid can express it.
//
// thumb-lib.sh renders every thumbnail to 800x500 (16:10, a common laptop
// aspect). Grid.AspectRatio has no 16/10, and of what it does offer
// ("1", "3/2", "4/3", "16/9", ...) 3/2 is the nearest: 1.5 against 1.6, where
// 16/9 would be 1.78 and visibly wrong. Paired with Fill, the cell crops the
// thumbnail by that 6% rather than letterboxing it.
const ASPECT: Grid.AspectRatio = "3/2";

// scan-wallpapers.sh files everything directly under the wallpaper directory as
// "Root", which is a path fact, not a name a person would give that pile.
const folderLabel = (folder: string) => folder === "Root" ? "Unsorted" : folder === "old" ? "Archive" : folder;

const folderFilter = (folder: string) => `f:${folder}`;

// Every apply ends the same way: hand the work to the backend, then get out of
// the way. The one case worth interrupting for is a wallpaper that is no longer
// on disk - the grid paints from the cache before the rescan lands, and the
// library is a directory someone prunes by hand, so a file that has gone can
// still be selectable for a moment. The apply is detached with stdio ignored,
// so without this the window closes, the desktop does not change, and nothing
// anywhere says why.
//
// Every onAction in this host is typed () => void: nothing here ever awaits or
// catches what a handler returns, so a rejected promise from inside one is
// unhandled by definition. closeMainWindow() is IPC to the host process, which
// can reject if the window is already tearing down - a race that only some
// closes hit - and an unhandled rejection kills this worker outright (Node's
// default since v15). Swallowing both awaits here is what keeps a lost race
// a no-op instead of a crash the next apply has to pay for as a cold restart.
async function applyAndClose(path: string, options?: ApplyOptions): Promise<void> {
  const missing = missingTools({ path });
  if (missing.length) {
    await showToast({ style: Toast.Style.Failure, title: "Missing wallpaper tools",
      message: `Install ${missing.join(", ")} and try again.` }).catch(() => undefined);
    return;
  }
  if (!applyWallpaper(path, options)) {
    await showToast({
      style: Toast.Style.Failure,
      title: "Could not start wallpaper apply",
      message: "The image or wallpaper-picker backend is missing. Ctrl+R rescans the library.",
    }).catch(() => undefined);
    return;
  }
  await closeMainWindow().catch(() => undefined);
}

type Group = { key: string; title: string; items: Wallpaper[] };

// Partitions the already-sorted list, preserving order inside each bin, so the
// sections only ever label runs the sort has already produced.
function groupWallpapers(items: Wallpaper[], by: GroupBy, now: number, minimum: number): Group[] {
  const bins = new Map<string, Group>();
  const put = (key: string, title: string, w: Wallpaper) => {
    const bin = bins.get(key) ?? { key, title, items: [] };
    bin.items.push(w);
    bins.set(key, bin);
  };

  for (const w of items) {
    if (by === "folder") {
      put(w.folder, folderLabel(w.folder), w);
    } else if (by === "colour") {
      const g = w.group || "neutral";
      put(g, capitalise(g), w);
    } else {
      const age = (now - w.mtime * 1000) / DAY;
      const bucket = AGES.find(([, days]) => age < days)?.[0] ?? EARLIER;
      put(bucket, bucket, w);
    }
  }

  // Section order is the axis's own order - hue order for colours, newest first
  // for dates, alphabetical for folders - not first-seen order, which would
  // change as the library grows.
  const order =
    by === "colour"
      ? [...COLOR_GROUPS]
      : by === "date"
        ? [...AGES.map(([title]) => title), EARLIER]
        : [...bins.keys()].sort((a, b) => folderLabel(a).localeCompare(folderLabel(b)));

  const sections = order.map((key) => bins.get(key)).filter((g): g is Group => g !== undefined);
  return by === "date" ? mergeThinBuckets(sections, minimum) : sections;
}

// A section costs a heading and a whole row of grid whatever it holds, so a
// bucket with two wallpapers in it spends more space on saying "This Week" than
// on the wallpapers. Only the date buckets get this treatment: their boundaries
// are arbitrary, and every bounded label is a max-age window - "This Month" is
// true of anything added this week - so a thin bucket can be folded into the
// next older bounded one and take that one's name. The open-ended "Earlier"
// bucket stays separate so it never claims a recent wallpaper. Colour and
// folder headings name something real, and a two-wallpaper "Purple" is still
// the answer to the question the hue sort asked.
function mergeThinBuckets(sections: Group[], minimum: number): Group[] {
  const out: Group[] = [];
  let carry: Wallpaper[] = [];
  for (const [index, s] of sections.entries()) {
    // "Earlier" is an open-ended bucket. Never pour newer items into it: that
    // makes a valid date label lie. Flush any carried recent buckets under the
    // oldest recent label first, then keep Earlier on its own.
    if (s.key === EARLIER) {
      if (carry.length > 0) {
        const previous = sections[index - 1];
        out.push({
          key: previous?.key ?? EARLIER,
          title: previous?.title ?? EARLIER,
          items: carry,
        });
        carry = [];
      }
      out.push({ ...s });
      continue;
    }
    const items = [...carry, ...s.items];
    carry = [];
    if (items.length < minimum) {
      carry = items;
      continue;
    }
    out.push({ ...s, items });
  }
  // Whatever is left is the oldest recent handful. Keep its oldest source
  // label; it is still a truthful max-age window and never silently becomes
  // "Earlier".
  if (carry.length > 0) {
    const tail = [...sections].reverse().find((section) => section.key !== EARLIER);
    out.push({ key: tail?.key ?? EARLIER, title: tail?.title ?? EARLIER, items: carry });
  }
  return out;
}

type Prefs = {
  columns?: ColumnCount;
  defaultSort?: Sort;
  transition?: Transition;
  transitionDuration?: TransitionDuration;
  resizeMode?: ResizeMode;
  cropGravity?: CropGravity;
  searchMode?: SearchMode;
  layoutMode?: LayoutMode;
  wallpaperDirectory?: string;
  scanDepth?: ScanDepth;
  includeCurrent?: boolean;
};

export default function SetWallpaper() {
  const [wallpapers, setWallpapers] = useState<Wallpaper[]>([]);
  const [loading, setLoading] = useState(true);
  // One dropdown, four rails. "" is everything, "fav" the starred set,
  // "current" the applied image, "c:<name>" a colour family and "f:<name>" a
  // literal folder — prefixes keep a folder called "fav" or "blue" unambiguous.
  // Both the filter and the sort start where the last session left them.
  const [remembered] = useState(readView);
  const [filter, setFilter] = useState(remembered.filter ?? "");
  const prefs = getPreferenceValues<Prefs>();
  const initialSort: Sort =
    prefs.defaultSort === "name" || prefs.defaultSort === "recent" ? prefs.defaultSort : "hue";
  const wallpaperDirectory =
    typeof prefs.wallpaperDirectory === "string" && prefs.wallpaperDirectory.trim().length > 0
      ? prefs.wallpaperDirectory.trim()
      : undefined;
  const scanDepth = preferenceValue(prefs.scanDepth, SCAN_DEPTH_VALUES, "3");
  const includeCurrent = prefs.includeCurrent ?? true;
  const scanOptions: ScanOptions = useMemo(
    () => ({ directory: wallpaperDirectory, depth: scanDepth, includeCurrent }),
    [wallpaperDirectory, scanDepth, includeCurrent],
  );
  const transition = transitionOf(prefs.transition);
  const applyOptions: ApplyOptions = {
    transition,
    duration: preferenceValue(prefs.transitionDuration, DURATION_VALUES, "auto"),
    resize: preferenceValue(prefs.resizeMode, RESIZE_VALUES, "crop"),
    cropGravity: preferenceValue(prefs.cropGravity, GRAVITY_VALUES, "center"),
  };
  // A preference picks which mode the picker opens in, but the two modes are
  // opposites - type to filter, or keep every tile in place for keyboard nav -
  // and there was no way to get the other one without leaving to Extension
  // Preferences and back. Ctrl+Shift+B flips it live for the rest of this session.
  const [browseMode, setBrowseMode] = useState(
    () => preferenceValue(prefs.searchMode, SEARCH_MODE_VALUES, "search") === "browse",
  );
  const layoutMode = preferenceValue(prefs.layoutMode, LAYOUT_MODE_VALUES, "flat");
  const [sort, setSort] = useState<Sort>(
    () => SORTS.find((s) => s.id === remembered.sort)?.id ?? initialSort,
  );
  // "Current" is a one-off lookup: remembered, the next open would show one tile.
  useEffect(() => writeView({ filter: filter === "current" ? "" : filter, sort }), [filter, sort]);
  const [favourites, setFavourites] = useState<Set<string>>(() => readFavourites());
  const [live, setLive] = useState<LiveStatus | null>(null);
  const [selectedPath, setSelectedPath] = useState("");
  const [scanError, setScanError] = useState("");

  const columns = Number(preferenceValue(prefs.columns, COLUMN_VALUES, "4"));
  const mode = SORTS.find((s) => s.id === sort) ?? SORTS[0];

  // Set on the way in as well as cleared on the way out. The ref is only
  // initialised on the first render, so a host that runs effects twice - React
  // StrictMode does exactly this - would leave it false after the first
  // cleanup and never restore it, and every scan result would then be
  // discarded by the guards below: a grid stuck empty behind a spinner that
  // never stops. Vicinae does not do that today; this costs one line and stops
  // it from being a question the next time the host is upgraded.
  const alive = useRef(true);
  const scanRequest = useRef(0);
  const cachePollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (cachePollTimer.current) clearTimeout(cachePollTimer.current);
    };
  }, []);

  // The scanner returns the library immediately, then renders missing thumbs
  // and colour hints in a background worker. Read its cache a few times while
  // it warms so a newly added image gains its small preview and correct colour
  // group in this open picker. Cache-only scans never start another worker.
  const pollCache = useCallback((list: Wallpaper[], request: number, attempt = 0) => {
    const delays = [1000, 2000, 4000, 8000, 16000];
    if (attempt >= delays.length || !list.some((w) => w.thumb === w.path || !w.color)) return;
    cachePollTimer.current = setTimeout(() => {
      cachePollTimer.current = null;
      if (!alive.current || request !== scanRequest.current) return;
      scanWallpapers({ ...scanOptions, cacheOnly: true })
        .then((next) => {
          if (!alive.current || request !== scanRequest.current) return;
          if (JSON.stringify(next) !== JSON.stringify(list)) {
            setWallpapers(next);
            writeCachedLibrary(next, scanOptions);
          }
          pollCache(next, request, attempt + 1);
        })
        .catch(() => {
          if (alive.current && request === scanRequest.current) pollCache(list, request, attempt + 1);
        });
    }, delays[attempt]);
  }, [scanOptions]);

  // The scan is the single source of truth for the library, so refreshing is
  // the same code path whether it runs on open or from cmd+R - the only
  // difference is whether a rescan someone asked for reports back.
  const refresh = useCallback((announce = false) => {
    const request = ++scanRequest.current;
    if (cachePollTimer.current) clearTimeout(cachePollTimer.current);
    cachePollTimer.current = null;
    // Keep the current grid visible during an explicit rescan. The first load
    // already has its own spinner; blanking a populated grid for a short scan
    // looks like the picker flickered or lost the selection.
    scanWallpapers(scanOptions)
      .then((list) => {
        if (!alive.current || request !== scanRequest.current) return;
        setScanError("");
        setWallpapers(list);
        writeCachedLibrary(list, scanOptions);
        pollCache(list, request);
        if (announce) {
          void showToast({ style: Toast.Style.Success, title: `Rescanned ${list.length} wallpapers` }).catch(() => undefined);
        }
      })
      .catch((e: Error) => {
        if (alive.current && request === scanRequest.current) {
          setScanError(e.message);
          void showToast({ style: Toast.Style.Failure, title: "Could not scan wallpapers", message: e.message }).catch(() => undefined);
        }
      })
      .finally(() => {
        if (alive.current && request === scanRequest.current) setLoading(false);
      });
  }, [scanOptions, pollCache]);

  // Paint from the last scan, then refresh in the background.
  //
  // The scan is only ~110ms, but it is 110ms of empty grid on every single open,
  // and the answer is almost always identical to last time. Showing the cached
  // library immediately and quietly replacing it when the real scan lands makes
  // the command feel instant without ever showing stale data for longer than the
  // scan takes. A miss simply falls through to the old behaviour.
  useEffect(() => {
    const missing = missingTools();
    if (missing.length > 0) {
      void showToast({
        style: Toast.Style.Failure,
        title: `Missing ${missing.join(", ")}`,
        message: "Install it to apply wallpapers; see the README.",
      }).catch(() => undefined);
    }
  }, []);

  useEffect(() => {
    const cached = readCachedLibrary(scanOptions);
    if (cached) {
      setWallpapers(cached);
      setLoading(false);
    }
    refresh();
  }, [refresh]);

  const sorted = useMemo(() => {
    const src = [...wallpapers];
    if (sort === "name") return src.sort((a, b) => (a.title || a.name).localeCompare(b.title || b.name));
    if (sort === "hue") return src.sort(colourOrder);
    return src.sort((a, b) => b.mtime - a.mtime || a.name.localeCompare(b.name));
  }, [wallpapers, sort]);

  const folders = useMemo(() => {
    const counts = new Map<string, number>();
    for (const w of wallpapers) if (!isArchived(w)) counts.set(w.folder, (counts.get(w.folder) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => folderLabel(a[0]).localeCompare(folderLabel(b[0])));
  }, [wallpapers]);

  const currentCount = useMemo(() => wallpapers.filter((w) => w.current).length, [wallpapers]);
  const archiveCount = useMemo(() => wallpapers.filter(isArchived).length, [wallpapers]);
  const activeCount = wallpapers.length - archiveCount;
  const favouriteCount = useMemo(
    () => wallpapers.filter((w) => favourites.has(w.path)).length,
    [wallpapers, favourites],
  );

  // Built from what the library actually contains, so the rail never offers an
  // empty bucket - and each entry carries a real swatch from its own bucket
  // rather than a hardcoded idea of what "teal" looks like. The most saturated
  // member is the one that looks like its label; an average of the family comes
  // out mud.
  const colours = useMemo(() => {
    const acc = new Map<string, { count: number; swatch: string; score: number }>();
    for (const w of wallpapers) {
      if (isArchived(w)) continue;
      if (!w.group || !w.color) continue;
      const seen = acc.get(w.group) ?? { count: 0, swatch: w.color, score: -1 };
      seen.count += 1;
      const score = vividnessOf(w.color);
      if (score > seen.score) {
        seen.score = score;
        seen.swatch = w.color;
      }
      acc.set(w.group, seen);
    }
    return COLOR_GROUPS.filter((g) => acc.has(g)).map((g) => ({ name: g, ...acc.get(g)! }));
  }, [wallpapers]);

  const shown = useMemo(() => filterLibrary(sorted, filter, favourites), [sorted, filter, favourites]);

  // A remembered filter can go stale: the folder was emptied, the last star was
  // removed. Fall back to everything rather than open on an empty grid, but only
  // once colours are known, or a cold colour cache would drop "Blue".
  useEffect(() => {
    if (filter && !loading && wallpapers.length > 0 && shown.length === 0 && wallpapers.every((w) => w.color)) {
      setFilter("");
    }
  }, [filter, loading, wallpapers, shown]);

  const randomCandidates = useMemo(() => shown.filter((w) => !w.current && !isLive(w.path)), [shown]);

  const selected = useMemo(
    () => shown.find((wallpaper) => wallpaper.path === selectedPath),
    [shown, selectedPath],
  );

  // Favourites ride at the top of the unfiltered library and are taken out of
  // the sections below it, so the star is worth pressing without any tile ever
  // appearing twice. Under a filter the pinned row is dropped: the dropdown has
  // already answered "which subset", and re-splitting that subset by a second
  // rule would be two questions in one list.
  const groups = useMemo(() => {
    const now = Date.now();
    const pinned = filter === "" ? shown.filter((w) => favourites.has(w.path)) : [];
    const rest = pinned.length > 0 ? shown.filter((w) => !favourites.has(w.path)) : shown;
    const sections = groupWallpapers(rest, mode.group, now, columns);
    return pinned.length > 0
      ? [{ key: "favourites", title: "Favourites", items: pinned }, ...sections]
      : sections;
  }, [shown, mode.group, favourites, filter, columns]);

  const flatItems = useMemo(() => groups.flatMap((group) => group.items), [groups]);

  function toggleFavourite(path: string) {
    const next = new Set(favourites);
    if (!next.delete(path)) next.add(path);
    if (!writeFavourites(next)) {
      void showToast({ style: Toast.Style.Failure, title: "Could not save favourites" }).catch(() => undefined);
      return;
    }
    setFavourites(next);
  }

  // Asked once on open: the player only changes when this picker or a keybind
  // changes it, and both refresh the state they set.
  useEffect(() => {
    void liveStatus().then((s) => alive.current && setLive(s));
  }, []);
  const hasLive = useMemo(() => wallpapers.some((w) => isLive(w.path)), [wallpapers]);
  const liveCount = useMemo(() => wallpapers.filter((w) => !isArchived(w) && isLive(w.path)).length, [wallpapers]);

  async function controlLive(next: Partial<LiveStatus>, args: string[], title: string) {
    if (!(await liveControl(...args))) {
      void showToast({ style: Toast.Style.Failure, title: "Could not change the live wallpaper" }).catch(() => undefined);
      return;
    }
    setLive((s) => (s ? { ...s, ...next } : s));
    void showToast({ style: Toast.Style.Success, title }).catch(() => undefined);
  }

  function toggleBrowseMode() {
    setBrowseMode((current) => !current);
  }

  // Shared by every tile so the sections cannot drift apart from each other.
  //
  // Grouped rather than listed flat: the first section is what enter and
  // cmd+enter already do, the second acts on the file under the cursor and the
  // third changes the view itself. The panel is searchable, so the grouping is
  // for the eye: wallpaper actions stay separate from library controls.
  function tileActions(w: Wallpaper) {
    const starred = favourites.has(w.path);
    const wallpaperAction = (
      <Action title="Set Wallpaper" icon={Icon.Image} onAction={() => void applyAndClose(w.path, applyOptions)} />
    );
    // Draws from what the dropdown is showing, not the whole library, so the
    // filter is the knob: "Colours > Blue" then Ctrl+Shift+R is a random blue
    // wallpaper. The one on the desktop is left out, or a small filter would
    // keep "changing" to the same picture.
    const randomAction = randomCandidates.length > 0 && (
      <Action
        title={filter === "" ? "Apply Random Wallpaper" : `Apply Random from ${filterLabel}`}
        icon={Icon.Shuffle}
        shortcut={{ modifiers: ["cmd", "shift"], key: "r" }}
        onAction={() => {
          const pick = randomCandidates[Math.floor(Math.random() * randomCandidates.length)];
          void applyAndClose(pick.path, applyOptions);
        }}
      />
    );
    return (
      <ActionPanel>
        <ActionPanel.Section>
          {wallpaperAction}
          {randomAction}
        </ActionPanel.Section>
        <ActionPanel.Section title="Wallpaper">
          <Action
            title={starred ? "Remove from Favourites" : "Add to Favourites"}
            icon={starred ? Icon.StarDisabled : Icon.Star}
            shortcut={{ modifiers: ["cmd"], key: "f" }}
            onAction={() => toggleFavourite(w.path)}
          />
          <Action.Open
            title="Open Full Size"
            icon={Icon.Eye}
            target={w.path}
            shortcut={{ modifiers: ["cmd"], key: "o" }}
          />
          {w.source && <Action.Open title="Open Source Page" icon={Icon.Globe01} target={w.source} />}
          <Action.ShowInFinder title="Reveal in File Manager" icon={Icon.Folder} path={w.path} select />
          <Action.CopyToClipboard
            title="Copy Path"
            content={w.path}
            shortcut={{ modifiers: ["cmd", "shift"], key: "c" }}
          />
        </ActionPanel.Section>
        <ActionPanel.Section title="View">
          {/* A submenu rather than the cycle this used to be: cmd+S three times
              to reach the sort you wanted is a guessing game, and the cycle's
              title could only ever name the NEXT order, never the current one.
              Here the three are all visible at once and the active one is
              ticked. */}
          <ActionPanel.Submenu
            title="Sort By"
            icon={Icon.BulletPoints}
            shortcut={{ modifiers: ["cmd"], key: "s" }}
          >
            {SORTS.map((s) => (
              <Action
                key={s.id}
                title={s.title}
                icon={s.id === sort ? Icon.Check : s.icon}
                onAction={() => setSort(s.id)}
              />
            ))}
          </ActionPanel.Submenu>
          <Action
            title={browseMode ? "Switch to Search Mode" : "Switch to Browse Mode"}
            icon={browseMode ? Icon.MagnifyingGlass : Icon.Compass}
            // Not cmd+B: on Linux that is Vicinae's own toggle-action-panel, so
            // the old binding opened the actions menu instead of switching.
            shortcut={{ modifiers: ["cmd", "shift"], key: "b" }}
            onAction={toggleBrowseMode}
          />
          {live?.running && (
            <Action
              title={live.paused ? "Resume Live Wallpaper" : "Pause Live Wallpaper"}
              icon={live.paused ? Icon.Play : Icon.Pause}
              shortcut={{ modifiers: ["cmd", "shift"], key: "p" }}
              onAction={() =>
                void controlLive({ paused: !live.paused }, [live.paused ? "resume" : "pause"],
                  live.paused ? "Live wallpaper resumed" : "Live wallpaper paused")}
            />
          )}
          {live && (hasLive || live.running) && (
            <ActionPanel.Submenu title="Pause Live Wallpaper When" icon={Icon.Video}>
              {LIVE_POLICIES.map((p) => (
                <Action
                  key={p.id}
                  title={p.title}
                  icon={p.id === live.policy ? Icon.Check : Icon.Circle}
                  onAction={() => void controlLive({ policy: p.id }, ["policy", p.id], `Pause when: ${p.title}`)}
                />
              ))}
            </ActionPanel.Submenu>
          )}
          <Action
            title="Refresh Library"
            icon={Icon.ArrowClockwise}
            shortcut={{ modifiers: ["cmd"], key: "r" }}
            onAction={() => refresh(true)}
          />
          <Action
            title="Open Wallpaper Picker Preferences"
            icon={Icon.Cog}
            onAction={() => void openExtensionPreferences().catch(() => undefined)}
          />
        </ActionPanel.Section>
      </ActionPanel>
    );
  }

  function tile(w: Wallpaper) {
    // Pictures, not a file list. Every tile used to print its filename and a
    // detail line, and almost none of those names are words - see readableName.
    // Vicinae only reserves a text strip on rows that have text, so a text-free
    // tile gives the whole row back to the image: nearly a full extra row of
    // previews fits in the launcher.
    //
    // What still earns a line is state you cannot see in the picture: the
    // wallpaper on the desktop now, and the starred ones. Favourites lead the
    // flat grid, so their labels sit together in the top rows instead of
    // scattering uneven row heights through the library. Under the favourites
    // filter every tile is one, so the star would say nothing there.
    //
    // Text only, no accessory icon. Once the server drew accessories (0.29) the
    // tile carried the same fact twice, as a badge and as its label. Names stay
    // searchable through the keywords and readable in the tooltip and hint.
    const starred = favourites.has(w.path) && filter !== "fav";
    const subtitle = w.current ? (starred ? "★ Current" : "Current") : starred ? "★ Favourite" : undefined;
    const name = w.title || readableName(w.name);

    return (
      <Grid.Item
        key={w.path}
        id={w.path}
        content={{ value: isLive(w.thumb) ? Icon.Video : w.thumb, tooltip: [name || prettyName(w.name), isLive(w.path) ? "Live" : "", w.folder !== "Root" ? folderLabel(w.folder) : "", w.resolution].filter(Boolean).join(" · ") }}
        title={subtitle ? "" : undefined}
        subtitle={subtitle}
        keywords={[w.name, name, w.folder, ...w.tags, w.group, w.color ? nameOf(w.color) : undefined, isLive(w.path) ? "live" : undefined].filter(
          (k): k is string => Boolean(k),
        )}
        actions={tileActions(w)}
      />
    );
  }

  // What the search hint calls the selected tile. A real name when the file has
  // one; otherwise the picture described by what the grid knows about it, since
  // "Enter to choose wallhaven-qro17q" names nothing a person can see.
  function describe(w: Wallpaper): string {
    const name = w.title || readableName(w.name);
    if (name) return name;
    const colour = w.color ? nameOf(w.color).toLowerCase() : "";
    return `this ${colour ? `${colour} ` : ""}wallpaper`;
  }

  const filterLabel =
    filter === ""
      ? "All"
      : filter === "fav"
        ? "Favourites"
        : filter === "current"
          ? "Current"
          : filter === "archive" ? "Archive"
          : filter === "live" ? "Live Wallpapers"
          : filter === "stills" ? "Still Wallpapers"
          : filter.startsWith("c:")
            ? capitalise(filter.slice(2))
            : filter.startsWith("f:")
              ? folderLabel(filter.slice(2))
              : folderLabel(filter);

  return (
    <Grid
      isLoading={loading}
      columns={columns}
      aspectRatio={ASPECT}
      fit={Grid.Fit.Fill}
      inset={Grid.Inset.Small}
      filtering={!browseMode}
      searchText={browseMode ? "" : undefined}
      onSearchTextChange={browseMode ? () => undefined : undefined}
      navigationTitle="Wallpapers"
      onSelectionChange={(id) => setSelectedPath(id || "")}
      searchBarPlaceholder={
        browseMode
          ? selected
            ? `Enter to set ${describe(selected)}… (Ctrl+Shift+B to search)`
            : "Browse mode — arrow keys to move, Ctrl+Shift+B to search…"
          : "Search wallpapers, scenes or artists…"
      }
      searchBarAccessory={
        <Grid.Dropdown tooltip="Narrow the library" value={filter} onChange={setFilter}>
          <Grid.Dropdown.Section title="Library">
            <Grid.Dropdown.Item title={`All (${activeCount})`} value="" icon={Icon.Layers} />
            {liveCount > 0 && <Grid.Dropdown.Item title={`Live (${liveCount})`} value="live" icon={Icon.Video} />}
            {liveCount > 0 && <Grid.Dropdown.Item title={`Stills (${activeCount - liveCount})`} value="stills" icon={Icon.Image} />}
            {favouriteCount > 0 && (
              <Grid.Dropdown.Item title={`Favourites (${favouriteCount})`} value="fav" icon={Icon.Star} />
            )}
            {currentCount > 0 && (
              <Grid.Dropdown.Item title={`Current (${currentCount})`} value="current" icon={Icon.CheckCircle} />
            )}
            {archiveCount > 0 && <Grid.Dropdown.Item title={`Archive (${archiveCount})`} value="archive" icon={Icon.Box} />}
          </Grid.Dropdown.Section>
          <Grid.Dropdown.Section title="Collections">
            {folders.map(([name, count]) => (
              <Grid.Dropdown.Item
                key={name}
                title={`${folderLabel(name)} (${count})`}
                value={folderFilter(name)}
                icon={Icon.Folder}
              />
            ))}
          </Grid.Dropdown.Section>
          <Grid.Dropdown.Section title="Colours">
            {colours.map((c) => (
              <Grid.Dropdown.Item
                key={c.name}
                title={`${capitalise(c.name)} (${c.count})`}
                value={`c:${c.name}`}
                icon={{ source: Icon.CircleFilled, tintColor: c.swatch }}
              />
            ))}
          </Grid.Dropdown.Section>
        </Grid.Dropdown>
      }
    >
      {!loading && wallpapers.length === 0 && scanError && (
        <Grid.EmptyView
          icon={Icon.Folder}
          title="Could not load the wallpaper library"
          description={scanError}
          actions={
            <ActionPanel>
              <Action
                title="Open Wallpaper Picker Preferences"
                icon={Icon.Cog}
                onAction={() => void openExtensionPreferences().catch(() => undefined)}
              />
              <Action title="Refresh Library" icon={Icon.ArrowClockwise} onAction={() => refresh(true)} />
            </ActionPanel>
          }
        />
      )}
      {!loading && shown.length === 0 && !(wallpapers.length === 0 && scanError) && (
        <Grid.EmptyView
          icon={filter === "fav" ? Icon.Star : filter === "current" ? Icon.CheckCircle : Icon.Image}
          title={filter === "fav" ? "No favourites yet" : filter === "current" ? "No current wallpaper" : `Nothing in ${filterLabel}`}
          description={
            filter === "fav"
              ? "Press Ctrl+F on any wallpaper to keep it at the top of the library."
              : filter === "current"
                ? "Set a wallpaper from the picker to see it here."
                : `Pick another collection or colour, or add images to ${libraryDirectory(wallpaperDirectory)}.`
          }
          actions={
            <ActionPanel>
              <Action title="Show All Wallpapers" icon={Icon.Layers} onAction={() => setFilter("")} />
              <Action title="Open Wallpaper Picker Preferences" icon={Icon.Cog}
                onAction={() => void openExtensionPreferences().catch(() => undefined)} />
              <Action title="Refresh Library" icon={Icon.ArrowClockwise} onAction={() => refresh(true)} />
            </ActionPanel>
          }
        />
      )}

      {layoutMode === "flat"
        ? flatItems.map(tile)
        : groups.length > 1
          ? groups.map((g) => (
              <Grid.Section key={g.key} title={`${g.title} (${g.items.length})`}>
                {g.items.map(tile)}
              </Grid.Section>
            ))
          : (groups[0]?.items ?? []).map(tile)}
    </Grid>
  );
}
