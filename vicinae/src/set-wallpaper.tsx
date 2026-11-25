import {
  Action,
  ActionPanel,
  Grid,
  Icon,
  type LaunchProps,
  Toast,
  closeMainWindow,
  getPreferenceValues,
  openExtensionPreferences,
  showToast,
  useNavigation,
} from "@vicinae/api";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  COLOR_GROUPS,
  COLOUR_SWATCHES,
  LIVE_POLICIES,
  TRANSITIONS,
  TRANSITION_DURATIONS,
  type Transition,
  type TransitionDuration,
  type LiveStatus,
  type ApplyOptions,
  type ScanOptions,
  Wallpaper,
  applyWallpaper,
  capitalise,
  compareWallpaperNames,
  colourOrder,
  createSearchIndex,
  filterLibrary,
  imageToolsAvailable,
  isArchived,
  isLive,
  liveControl,
  liveStatus,
  libraryDirectory,
  missingTools,
  nameOf,
  prettyName,
  pinnedFirst,
  previewWorkPending,
  readableName,
  readCachedLibrary,
  readLiveStatus,
  rememberLiveStatus,
  readFavourites,
  readHistory,
  readView,
  scanWallpapers,
  searchLibrary,
  transitionOf,
  wallpaperPreview,
  writeCachedLibrary,
  writeFavourites,
  writeView,
} from "./lib";
import SolidColour from "./solid-colour";
import WallpaperColours from "./wallpaper-colours";

// One control: each sort brings its own section headings (date, folder or colour
// family), so headers always explain the order. Colour is the default, because
// date order scatters unrelated colours side by side.
type Sort = "recent" | "name" | "hue";
type GroupBy = "date" | "folder" | "colour";
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
  { id: "recent", title: "Recently Modified", icon: Icon.Clock, group: "date" },
  { id: "name", title: "Name", icon: Icon.Text, group: "folder" },
];

const DURATION_VALUES = TRANSITION_DURATIONS;
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

// Thumbnails are 800x500 (16:10). Grid.AspectRatio has no 16/10 and 3/2 is the
// nearest it offers; with Fill the cell crops 6% instead of letterboxing.
const ASPECT: Grid.AspectRatio = "3/2";

// scan-wallpapers.sh files everything directly under the wallpaper directory as
// "Root", which is a path fact, not a name a person would give that pile.
const folderLabel = (folder: string) => folder === "Root" ? "Unsorted" : folder === "old" ? "Archive" : folder;

const folderFilter = (folder: string) => `f:${folder}`;

// The apply is detached, so a file pruned since the cached paint must be caught
// here, or the window closes and nothing changes. Both awaits swallow errors: an
// unhandled rejection in an onAction kills the worker, and closeMainWindow()
// can lose a race with the window's own teardown.
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

// A section costs a heading and a row, so a thin date bucket folds into the next
// older bounded one ("This Month" is still true of this week). "Earlier" stays
// separate so it never claims a recent wallpaper. Colour and folder sections
// name something real and are never merged.
function mergeThinBuckets(sections: Group[], minimum: number): Group[] {
  const out: Group[] = [];
  let carry: Wallpaper[] = [];
  for (const [index, s] of sections.entries()) {
    // Carried recent items go under the oldest recent label, never under Earlier.
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
  // The oldest recent handful keeps its own label rather than becoming Earlier.
  if (carry.length > 0) {
    const tail = [...sections].reverse().find((section) => section.key !== EARLIER);
    out.push({ key: tail?.key ?? EARLIER, title: tail?.title ?? EARLIER, items: carry });
  }
  return out;
}

type Prefs = {
  defaultAction?: "palette" | "apply";
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

export default function SetWallpaper({ fallbackText = "" }: Partial<LaunchProps> = {}) {
  const prefs = getPreferenceValues<Prefs>();
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
  // The cached library goes into the very first render. Read in an effect, it
  // cost an empty first commit and a second full one, and Vicinae drew nothing
  // until both had arrived: the window grew as an empty card (filmed 2026-11-11).
  const [wallpapers, setWallpapers] = useState<Wallpaper[]>(() => readCachedLibrary(scanOptions) ?? []);
  const [loading, setLoading] = useState(() => wallpapers.length === 0);
  // What the grid shows now, so an identical scan result can skip the re-render.
  const library = useRef(wallpapers);
  library.current = wallpapers;
  const [query, setQuery] = useState(fallbackText);
  // One dropdown, four rails. "" is everything, "fav" the starred set,
  // "live"/"stills"/"archive" by kind, "c:<name>" a colour family and "f:<name>" a
  // literal folder — prefixes keep a folder called "fav" or "blue" unambiguous.
  // Both the filter and the sort start where the last session left them.
  const [remembered] = useState(readView);
  const [filter, setFilter] = useState(remembered.filter ?? "");
  const [colour, setColour] = useState(remembered.colour ?? "");
  const initialSort: Sort =
    prefs.defaultSort === "name" || prefs.defaultSort === "recent" ? prefs.defaultSort : "hue";
  const [transitionOverride, setTransitionOverride] = useState<Transition | undefined>(remembered.transition);
  const [durationOverride, setDurationOverride] = useState<TransitionDuration | undefined>(() => remembered.duration ? preferenceValue(remembered.duration, DURATION_VALUES, "auto") : undefined);
  const transition = transitionOf(transitionOverride ?? prefs.transition);
  const duration = durationOverride ?? preferenceValue(prefs.transitionDuration, DURATION_VALUES, "auto");
  const applyOptions: ApplyOptions = {
    transition,
    duration,
    resize: preferenceValue(prefs.resizeMode, RESIZE_VALUES, "crop"),
    cropGravity: preferenceValue(prefs.cropGravity, GRAVITY_VALUES, "center"),
  };
  // The preference picks the opening mode; Ctrl+Shift+B flips it for this session.
  const [browseMode, setBrowseMode] = useState(
    () => preferenceValue(prefs.searchMode, SEARCH_MODE_VALUES, "search") === "browse",
  );
  const layoutMode = preferenceValue(prefs.layoutMode, LAYOUT_MODE_VALUES, "flat");
  const [sort, setSort] = useState<Sort>(
    () => SORTS.find((s) => s.id === remembered.sort)?.id ?? initialSort,
  );
  useEffect(() => writeView({ filter, sort, colour, transition: transitionOverride, duration: durationOverride }), [filter, sort, colour, transitionOverride, durationOverride]);
  const [favourites, setFavourites] = useState<Set<string>>(() => readFavourites());
  // The picker closes on apply, so the log read at open stays current.
  const [recent] = useState(() => readHistory());
  const [live, setLive] = useState<LiveStatus | null>(readLiveStatus);
  const [selectedPath, setSelectedPath] = useState("");
  // The panel below is rebuilt only after Vicinae receives the next render (throttled
  // to ~16 ms), so Enter right after an arrow key runs the previous tile's panel.
  // Its handlers act on the tile Vicinae last reported instead.
  const reported = useRef("");
  const { push } = useNavigation();
  const [scanError, setScanError] = useState("");
  const [canCreatePreviews] = useState(imageToolsAvailable);

  const columns = Number(preferenceValue(prefs.columns, COLUMN_VALUES, "4"));
  const mode = SORTS.find((s) => s.id === sort) ?? SORTS[0];

  // Also set on mount: a host that runs effects twice (StrictMode) would
  // otherwise leave it false and drop every scan result.
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
    const delays = [500, 1000, 2000, 4000, 8000, 8000, 8000, 8000, 8000, 8000, 8000, 8000];
    if (attempt >= delays.length || !previewWorkPending(list, canCreatePreviews)) return;
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
  }, [scanOptions, canCreatePreviews]);

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
        // Usually the scan finds what the cache already painted; sending the
        // same grid again would only make Vicinae rebuild it mid-open.
        if (JSON.stringify(list) !== JSON.stringify(library.current)) {
          setWallpapers(list);
          writeCachedLibrary(list, scanOptions);
        }
        // Only a removed folder expires. An empty favourite/live filter remains selected.
        setFilter((current) => current.startsWith("f:") && !list.some((w) => w.folder === current.slice(2)) ? "" : current);
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

  // Said once on open, so a missing tool is known before the first apply fails.
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

  // The grid painted from the cache above; this scan replaces it only if something changed.
  useEffect(() => refresh(), [refresh]);

  const sorted = useMemo(() => {
    const src = [...wallpapers];
    if (sort === "name") return src.sort(compareWallpaperNames);
    if (sort === "hue") return src.sort(colourOrder);
    return src.sort((a, b) => b.mtime - a.mtime || a.name.localeCompare(b.name));
  }, [wallpapers, sort]);

  const colourScope = useMemo(() => colour ? wallpapers.filter((w) => w.color && w.group === colour) : wallpapers, [wallpapers, colour]);
  const folders = useMemo(() => {
    const counts = new Map<string, number>();
    for (const w of wallpapers) if (!isArchived(w)) counts.set(w.folder, 0);
    for (const w of colourScope) if (!isArchived(w)) counts.set(w.folder, (counts.get(w.folder) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => folderLabel(a[0]).localeCompare(folderLabel(b[0])));
  }, [wallpapers, colourScope]);

  const archiveCount = useMemo(() => colourScope.filter(isArchived).length, [colourScope]);
  const activeCount = colourScope.length - archiveCount;
  const favouriteCount = useMemo(
    () => colourScope.filter((w) => favourites.has(w.path)).length,
    [colourScope, favourites],
  );
  const recentCount = useMemo(() => filterLibrary(colourScope, "recent", favourites, "", recent).length, [colourScope, favourites, recent]);

  const baseFiltered = useMemo(() => filterLibrary(sorted, filter, favourites, "", recent), [sorted, filter, favourites, recent]);
  // Counted within the chosen collection. A family with nothing in it only
  // leads to an empty grid, so it is listed only while colours are still being
  // detected or while it is the chosen one. Each family keeps its own swatch:
  // a library's most vivid "yellow" was a near-black brown, unreadable in the menu.
  const colourDetectionPending = useMemo(() => canCreatePreviews && wallpapers.some((w) => !w.color), [wallpapers, canCreatePreviews]);
  const colours = useMemo(() => {
    const counts = new Map<string, number>();
    for (const w of baseFiltered) if (w.group && w.color) counts.set(w.group, (counts.get(w.group) ?? 0) + 1);
    return COLOR_GROUPS.map((g) => ({ name: g, count: counts.get(g) ?? 0, swatch: COLOUR_SWATCHES[g] }))
      .filter((c) => c.count > 0 || c.name === colour || colourDetectionPending);
  }, [baseFiltered, colour, colourDetectionPending]);

  const filtered = useMemo(() => filterLibrary(sorted, filter, favourites, colour, recent), [sorted, filter, favourites, colour, recent]);
  const searchIndex = useMemo(() => createSearchIndex(wallpapers), [wallpapers]);
  const shown = useMemo(() => searchLibrary(filtered, browseMode ? "" : query, searchIndex), [filtered, browseMode, query, searchIndex]);
  const searching = !browseMode && query.trim().length > 0;

  const randomCandidates = useMemo(() => shown.filter((w) => !w.current && !isLive(w.path)), [shown]);

  // The whole-library views (All, Stills, Live) lead with the current wallpaper
  // and the favourites, so the picker opens on what is on the desktop. A folder,
  // the favourites or a search already chose a subset and keeps its own order.
  const pinTop = !searching && (filter === "" || filter === "stills" || filter === "live");
  const isPinned = useCallback((w: Wallpaper) => w.current || favourites.has(w.path), [favourites]);
  const groups = useMemo(() => {
    if (searching) return [{ key: "results", title: "Search Results", items: shown }];
    const now = Date.now();
    const pinned = pinTop ? pinnedFirst(shown.filter(isPinned), favourites) : [];
    const rest = pinned.length > 0 ? shown.filter((w) => !isPinned(w)) : shown;
    const sections = groupWallpapers(rest, mode.group, now, columns);
    const title = pinned.some((w) => favourites.has(w.path)) ? (pinned.some((w) => w.current) ? "Current and Favourites" : "Favourites") : "Current";
    return pinned.length > 0 ? [{ key: "pinned", title, items: pinned }, ...sections] : sections;
  }, [shown, mode.group, favourites, pinTop, columns, searching, isPinned]);

  const flatItems = useMemo(() => pinTop ? pinnedFirst(shown, favourites) : shown, [shown, favourites, pinTop]);
  // When the tiles reorder, Vicinae keeps its highlight on the same index and
  // reports nothing, so an id reported for the old order must not steer Enter.
  useEffect(() => { if (!selectedPath) reported.current = ""; }, [flatItems, groups]);
  const selected = useMemo(() => shown.find((w) => w.path === selectedPath) ??
    (layoutMode === "flat" ? flatItems[0] : groups[0]?.items[0]), [shown, selectedPath, flatItems, groups, layoutMode]);

  function showAllWallpapers() {
    setFilter("");
    setColour("");
    setQuery("");
  }

  function clearFiltersAction() {
    return <Action title="Clear Search and Filters" icon={Icon.XMarkCircle} onAction={showAllWallpapers} />;
  }

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
  // Starts from the last answer, so the usual unchanged status costs no render.
  useEffect(() => {
    void liveStatus().then((s) => {
      if (!alive.current || !s) return;
      rememberLiveStatus(s);
      setLive((current) => JSON.stringify(current) === JSON.stringify(s) ? current : s);
    });
  }, []);
  const hasLive = useMemo(() => wallpapers.some((w) => isLive(w.path)), [wallpapers]);
  const liveCount = useMemo(() => colourScope.filter((w) => !isArchived(w) && isLive(w.path)).length, [colourScope]);

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

  function colourActions() {
    return (
      <ActionPanel.Submenu title={colour ? `Colour: ${capitalise(colour)}` : "Filter by Colour"} icon={Icon.Swatch} shortcut={{ modifiers: ["cmd", "shift"], key: "f" }}>
        <Action title="All Colours" icon={colour ? Icon.Layers : Icon.Check} onAction={() => setColour("")} />
        {colours.map((c) => <Action key={c.name} title={`${capitalise(c.name)} (${c.count})`}
          icon={colour === c.name ? Icon.Check : { source: Icon.CircleFilled, tintColor: c.swatch }} onAction={() => setColour(c.name)} />)}
      </ActionPanel.Submenu>
    );
  }

  function transitionActions() {
    return (
      <ActionPanel.Submenu title={`Transition: ${TRANSITIONS.find((t) => t.id === transition)?.title}`} icon={Icon.Play}>
        {TRANSITIONS.map((t) => <Action key={t.id} title={t.title} icon={t.id === transition ? Icon.Check : Icon.Play} onAction={() => setTransitionOverride(t.id)} />)}
        <ActionPanel.Submenu title={`Duration: ${duration === "auto" ? "Auto" : `${duration} s`}`} icon={Icon.Clock}>
          {DURATION_VALUES.map((value) => <Action key={value} title={value === "auto" ? "Auto" : `${value} s`} icon={value === duration ? Icon.Check : Icon.Clock} onAction={() => setDurationOverride(value)} />)}
        </ActionPanel.Submenu>
        {(transitionOverride || durationOverride) && <Action title="Use Extension Defaults" icon={Icon.ArrowClockwise} onAction={() => { setTransitionOverride(undefined); setDurationOverride(undefined); }} />}
      </ActionPanel.Submenu>
    );
  }

  // One panel for the whole grid: applying first, then the selected file, then the view.
  function tileActions(w: Wallpaper) {
    const target = () => shown.find((x) => x.path === reported.current) ?? w;
    const starred = favourites.has(w.path);
    const chooseColour = prefs.defaultAction !== "apply";
    // No shortcut props: Vicinae binds the first two actions to Enter and
    // Shift+Enter itself, and ignored the Ctrl+Enter these used to ask for.
    const colourAction = (
      <Action title="Choose Wallpaper Colour" icon={Icon.Swatch}
        onAction={() => {
          const t = target();
          push(<WallpaperColours key={t.path} wallpaper={t} onApply={(choice) => applyAndClose(t.path, { ...applyOptions, ...choice })} />);
        }} />
    );
    const wallpaperAction = (
      <Action title="Set Wallpaper" icon={Icon.Image}
        onAction={() => void applyAndClose(target().path, applyOptions)} />
    );
    // Draws from what the dropdown is showing, not the whole library, so the
    // filter is the knob: "Colours > Blue" then Ctrl+Shift+R is a random blue
    // wallpaper. The one on the desktop is left out, or a small filter would
    // keep "changing" to the same picture.
    const randomAction = randomCandidates.length > 0 && (
      <Action
        title={searching ? "Set Random from Search Results" : colour ? `Set Random ${capitalise(colour)} Wallpaper` : filter === "" ? "Set Random Wallpaper" : `Set Random from ${filterLabel}`}
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
          {chooseColour ? colourAction : wallpaperAction}
          {chooseColour ? wallpaperAction : colourAction}
          {randomAction}
          <Action.Push title="Set Solid Colour" icon={Icon.Swatch} target={<SolidColour options={applyOptions} />} />
          {transitionActions()}
        </ActionPanel.Section>
        <ActionPanel.Section title="Wallpaper">
          <Action
            title={starred ? "Remove from Favourites" : "Add to Favourites"}
            icon={starred ? Icon.StarDisabled : Icon.Star}
            shortcut={{ modifiers: ["cmd"], key: "f" }}
            onAction={() => toggleFavourite(target().path)}
          />
          <Action.Open
            title="Open Full Size"
            icon={Icon.Eye}
            target={w.path}
            shortcut={{ modifiers: ["cmd"], key: "o" }}
          />
          {w.source && <Action.Open title="Open Source Page" icon={Icon.Globe01} target={w.source} />}
          {w.color && <Action title={`More ${capitalise(w.group)} Wallpapers`} icon={{ source: Icon.CircleFilled, tintColor: w.color }} onAction={() => setColour(w.group)} />}
          {w.color && <Action.CopyToClipboard title="Copy Wallpaper Colour" icon={Icon.Swatch} content={w.color} />}
          <Action.ShowInFinder title="Reveal in File Manager" icon={Icon.Folder} path={w.path} select />
          <Action.CopyToClipboard
            title="Copy Path"
            content={w.path}
            shortcut={{ modifiers: ["cmd", "shift"], key: "c" }}
          />
        </ActionPanel.Section>
        <ActionPanel.Section title="View">
          {(filter || colour || searching) && clearFiltersAction()}
          {colourActions()}
          {colour && <Action title="Clear Colour Filter" icon={Icon.Swatch} onAction={() => setColour("")} />}
          {/* A submenu, so the current sort is ticked instead of guessed. */}
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
    // No title, subtitle or accessory: any text adds a strip to the row and costs
    // most of a row of previews. Names and state live in the tooltip and footer.
    // Under the favourites filter every tile is one, so the star says nothing.
    const starred = favourites.has(w.path) && filter !== "fav";
    const name = w.title || readableName(w.name);
    const preview = wallpaperPreview(w, canCreatePreviews);

    return (
      <Grid.Item
        key={w.path}
        id={w.path}
        content={{ value: preview ?? (isLive(w.path) ? Icon.Video : Icon.Image), tooltip: [name || prettyName(w.name), w.current ? "Current" : "", starred ? "Favourite" : "", isLive(w.path) ? "Live" : "", w.folder !== "Root" ? folderLabel(w.folder) : "", w.resolution, !preview ? "Preview pending · Ctrl+R to retry" : ""].filter(Boolean).join(" · ") }}
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

  // Tiles carry no names, so the footer names the selected one; the catalogue
  // gives most files a real title.
  const caption = selected
    ? [selected.title || readableName(selected.name) || prettyName(selected.name),
      isLive(selected.path) ? "Live" : "", selected.current ? "Current" : "", favourites.has(selected.path) ? "Favourite" : ""].filter(Boolean).join(" · ")
    : `Wallpapers${colour ? ` · ${capitalise(colour)}` : ""} · ${shown.length}`;

  const filterLabel =
    filter === ""
      ? "All"
      : filter === "fav"
        ? "Favourites"
        : filter === "recent" ? "Recently Used"
        : filter === "archive" ? "Archive"
          : filter === "live" ? "Live Wallpapers"
          : filter === "stills" ? "Still Wallpapers"
          : filter.startsWith("c:")
            ? capitalise(filter.slice(2))
            : filter.startsWith("f:")
              ? folderLabel(filter.slice(2))
              : folderLabel(filter);

  function emptyActions() {
    if (wallpapers.length === 0 && scanError) return (
      <ActionPanel>
        <Action title="Open Wallpaper Picker Preferences" icon={Icon.Cog}
          onAction={() => void openExtensionPreferences().catch(() => undefined)} />
        <Action title="Refresh Library" icon={Icon.ArrowClockwise} shortcut={{ modifiers: ["cmd"], key: "r" }} onAction={() => refresh(true)} />
        <Action.Push title="Set Solid Colour" icon={Icon.Swatch} target={<SolidColour options={applyOptions} />} />
      </ActionPanel>
    );
    return (
      <ActionPanel>
        {searching && <Action title="Clear Search" icon={Icon.MagnifyingGlass} onAction={() => setQuery("")} />}
        {(filter || colour || searching) && clearFiltersAction()}
        <Action.Push title="Set Solid Colour" icon={Icon.Swatch} target={<SolidColour options={applyOptions} />} />
        {colourActions()}
        {transitionActions()}
        <Action title="Open Wallpaper Picker Preferences" icon={Icon.Cog}
          onAction={() => void openExtensionPreferences().catch(() => undefined)} />
        <Action title="Refresh Library" icon={Icon.ArrowClockwise} shortcut={{ modifiers: ["cmd"], key: "r" }} onAction={() => refresh(true)} />
      </ActionPanel>
    );
  }

  return (
    <Grid
      actions={selected ? tileActions(selected) : emptyActions()}
      isLoading={loading}
      columns={columns}
      aspectRatio={ASPECT}
      fit={Grid.Fit.Fill}
      inset={Grid.Inset.Small}
      filtering={false}
      searchText={browseMode ? "" : query}
      onSearchTextChange={browseMode ? () => undefined : setQuery}
      navigationTitle={caption}
      onSelectionChange={(id) => {
        reported.current = id || "";
        // Vicinae reports the first tile on open; it is already the one shown as selected.
        if (!selectedPath && id === selected?.path) return;
        setSelectedPath(id || "");
      }}
      searchBarPlaceholder={
        browseMode
          ? selected
            ? `Enter to ${prefs.defaultAction === "apply" ? "set" : "choose a colour for"} ${describe(selected)}… (Ctrl+Shift+B to search)`
            : "Browse mode — arrow keys to move, Ctrl+Shift+B to search…"
          : colour ? `Search ${colour} wallpapers… Ctrl+Shift+F for colours` : "Search wallpapers… Ctrl+Shift+F for colours"
      }
      searchBarAccessory={
        <Grid.Dropdown tooltip={colour ? `Collections · ${capitalise(colour)} wallpapers` : "Narrow the library"} value={filter} onChange={setFilter}>
          <Grid.Dropdown.Section title="Library">
            <Grid.Dropdown.Item title={`All${colour && filter === "" ? ` · ${capitalise(colour)}` : ""} (${activeCount})`} value="" icon={Icon.Layers} />
            {(hasLive || filter === "live") && <Grid.Dropdown.Item title={`Live (${liveCount})`} value="live" icon={Icon.Video} />}
            <Grid.Dropdown.Item title={`Stills (${activeCount - liveCount})`} value="stills" icon={Icon.Image} />
            <Grid.Dropdown.Item title={`Favourites (${favouriteCount})`} value="fav" icon={Icon.Star} />
            {(recentCount > 0 || filter === "recent") && <Grid.Dropdown.Item title={`Recently Used (${recentCount})`} value="recent" icon={Icon.ArrowCounterClockwise} />}
            {(archiveCount > 0 || filter === "archive") && <Grid.Dropdown.Item title={`Archive (${archiveCount})`} value="archive" icon={Icon.Box} />}
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
        </Grid.Dropdown>
      }
    >
      {!loading && wallpapers.length === 0 && scanError && (
        <Grid.EmptyView
          icon={Icon.Folder}
          title="Could not load the wallpaper library"
          description={scanError}
        />
      )}
      {!loading && shown.length === 0 && !(wallpapers.length === 0 && scanError) && (
        <Grid.EmptyView
          icon={filter === "fav" ? Icon.Star : Icon.Image}
          title={searching ? "No matching wallpapers" : colour ? `No ${capitalise(colour)} Wallpapers in ${filterLabel}` : filter === "fav" ? "No favourites yet" : `Nothing in ${filterLabel}`}
          description={
            searching
              ? "Try another search or clear it to see this collection."
              : filter === "fav"
                ? "Press Ctrl+F on any wallpaper to keep it at the top of the library."
                : filter === "recent"
                  ? "Wallpapers you set show up here, newest first."
                : colour && !canCreatePreviews
                    ? "Install ImageMagick, then refresh the library to detect wallpaper colours."
                  : colour && wallpapers.some((w) => !w.color)
                    ? "Wallpaper colours are still being detected. Previews update as they finish; Ctrl+R retries detection."
                    : `Pick another collection or colour, or add images to ${libraryDirectory(wallpaperDirectory)}.`
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
