import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as ts from "typescript";

// lib.ts also imports the Vicinae runtime, so compile it into a temporary file
// and provide the one host value Cache needs. This keeps the tests dependency
// free while still exercising the actual helpers used by the UI.
const sourcePath = new URL("../src/lib.ts", import.meta.url);
const compiled = ts.transpileModule(readFileSync(sourcePath, "utf8"), {
  compilerOptions: {
    esModuleInterop: true,
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText;

const tempDir = mkdtempSync(join(dirname(fileURLToPath(import.meta.url)), ".test-lib-"));
const compiledPath = join(tempDir, "lib.cjs");
writeFileSync(compiledPath, compiled);
globalThis.vicinae = { environ: { supportPath: tempDir }, preferences: {} };
for (const key of Object.keys(process.env)) {
  if (key.startsWith("WALLPAPER_") || key.startsWith("AWWW_")) delete process.env[key];
}
process.env.XDG_STATE_HOME = tempDir;
process.env.WALLPAPER_PICKER_DIR = tempDir;
process.env.XDG_CACHE_HOME = join(tempDir, "cache");

try {
  const lib = await import(pathToFileURL(compiledPath).href);

  assert.equal(lib.normaliseHex("48f"), "#4488ff");
  assert.equal(lib.normaliseHex("#AABBCC"), "#aabbcc");
  assert.equal(lib.normaliseHex("not-a-colour"), null);
  assert.equal(lib.normaliseHex("#ff0000junk"), null);

  const palettes = lib.parsePalettes("0 #AABBCC #112233 #000000\n1 #aabbcc #112233 #101010\n2 #ddeeffAA #445566 #000000\n4 #111111 #222222 #333333\n3 #12 #445566 #000000\njunk\n");
  assert.deepEqual(palettes, [
    { index: 0, primary: "#aabbcc", tertiary: "#112233", surface: "#000000" },
    { index: 2, primary: "#ddeeff", tertiary: "#445566", surface: "#000000" },
  ]);
  assert.deepEqual(lib.namePalettes(["#2255aa", "#ee3333", "#99bbff"]), ["Deep Blue", "Red", "Light Blue"]);
  // Matugen's light accents: a lavender and an orchid are colours, its greys are not.
  assert.deepEqual(lib.namePalettes(["#c1c1ff", "#eab5ee", "#e3b7f3", "#c7c6c6"]), ["Blue", "Pink", "Purple", "Neutral"]);
  assert.equal(lib.groupOf("#c1c1ff"), "neutral");
  assert.ok(lib.ACCENTS.every((a) => lib.normaliseHex(a.hex) === a.hex));
  assert.equal(lib.readPaletteIndex(), 0);
  assert.equal(lib.readAccent(), null);
  mkdirSync(join(tempDir, "wallpaper-picker"));
  writeFileSync(join(tempDir, "wallpaper-picker", "custom-accent"), "#AABBCC\n");
  assert.equal(lib.readAccent(), "#aabbcc");
  writeFileSync(join(tempDir, "wallpaper-picker", "source-index"), "2\n");
  assert.equal(lib.readPaletteIndex(), 2);
  assert.equal(lib.readLiveStatus(), null);
  lib.rememberLiveStatus({ running: true, paused: false, policy: "covered" });
  assert.deepEqual(lib.readLiveStatus(), { running: true, paused: false, policy: "covered" });
  assert.equal(lib.readRememberedPalette("/w/a.png"), null);
  writeFileSync(join(tempDir, "wallpaper-picker", "palettes"), "3\t/w/a b\\c.png\n9\t/w/b.png\n1\t/w/a.png\n");
  assert.equal(lib.readRememberedPalette("/w/a b\\c.png"), 3);
  assert.equal(lib.readRememberedPalette("/w/a.png"), 1);
  assert.equal(lib.readRememberedPalette("/w/b.png"), null);
  assert.equal(lib.readRememberedPalette("/w/a"), null);


  assert.equal(lib.groupOf("#3670D1"), "blue");
  assert.equal(lib.groupOf("#181824"), "neutral");
  assert.equal(lib.groupOf("#ff0000junk"), "");



  const wallpaper = {
    path: "/wallpapers/one.jpg",
    name: "one.jpg",
    thumb: "/cache/one.jpg",
    current: false,
    color: "#4488ff",
    folder: "Root",
    mtime: 123,
    group: "blue",
    brightness: 40,
    title: "Rainy alley",
    tags: ["rain", "city"],
    source: "https://wallhaven.cc/w/abc123",
    resolution: "3840x2160",
  };
  const scope = { directory: "/wallpapers", depth: "2", includeCurrent: true };
  lib.writeCachedLibrary([wallpaper], scope);
  assert.deepEqual(lib.readCachedLibrary(scope), [wallpaper]);
  assert.equal(lib.readCachedLibrary({ ...scope, directory: "/other" }), null);
  // The cache predates the last apply, so `current` follows the state file.
  const other = { ...wallpaper, path: "/wallpapers/two.jpg", name: "two.jpg", current: true };
  const currentFile = join(tempDir, "wallpaper-picker", "current");
  lib.writeCachedLibrary([wallpaper, other], scope);
  writeFileSync(currentFile, wallpaper.path + "\n");
  assert.deepEqual(lib.readCachedLibrary(scope).map((w) => w.current), [true, false]);
  // A current file the cache never saw is a miss, so the scan paints first...
  const outside = join(tempDir, "outside.png");
  writeFileSync(outside, "");
  writeFileSync(currentFile, outside + "\n");
  assert.equal(lib.readCachedLibrary(scope), null);
  // ...unless the scan would leave it out anyway.
  const noCurrent = { ...scope, includeCurrent: false };
  lib.writeCachedLibrary([wallpaper, other], noCurrent);
  assert.deepEqual(lib.readCachedLibrary(noCurrent).map((w) => w.current), [false, false]);
  rmSync(currentFile);

  const archive = { ...wallpaper, path: "/wallpapers/Archive/two.jpg", folder: "Archive/dark", current: true };
  const library = [wallpaper, archive];
  assert.deepEqual(lib.filterLibrary(library, "", new Set()), [wallpaper]);
  assert.deepEqual(lib.filterLibrary(library, "c:blue", new Set()), [wallpaper]);
  assert.deepEqual(lib.filterLibrary(library, "archive", new Set()), [archive]);
  assert.deepEqual(lib.filterLibrary(library, "fav", new Set([archive.path])), [archive]);
  assert.deepEqual(lib.filterLibrary([{ ...wallpaper, folder: "fav" }], "f:fav", new Set()), [{ ...wallpaper, folder: "fav" }]);
  const video = { ...wallpaper, path: "/wallpapers/clip.mp4" };
  assert.equal(lib.previewWorkPending([{ ...wallpaper, thumb: wallpaper.path }], false), false);
  assert.equal(lib.previewWorkPending([{ ...wallpaper, thumb: wallpaper.path }], true), true);
  assert.equal(lib.previewWorkPending([{ ...video, thumb: video.path }], false), true);
  assert.equal(lib.previewWorkPending([{ ...video, thumb: "/cache/poster.png", color: "" }], false), false);
  assert.equal(lib.previewWorkPending([{ ...wallpaper, color: "" }], true), true);
  assert.equal(lib.previewWorkPending([wallpaper], true), false);
  assert.equal(lib.wallpaperPreview({ ...wallpaper, thumb: wallpaper.path }, true), null);
  assert.equal(lib.wallpaperPreview({ ...wallpaper, thumb: wallpaper.path }, false), wallpaper.path);
  assert.equal(lib.wallpaperPreview(wallpaper, true), wallpaper.thumb);
  assert.equal(lib.wallpaperPreview({ ...video, thumb: video.path }, false), null);
  assert.equal(lib.wallpaperPreview({ ...video, thumb: "/cache/poster.png" }, true), "/cache/poster.png");
  assert.deepEqual(lib.filterLibrary([wallpaper, video, archive], "live", new Set()), [video]);
  assert.deepEqual(lib.filterLibrary([wallpaper, video, archive], "stills", new Set()), [wallpaper]);
  const red = { ...wallpaper, name: "red-forest.jpg", title: "Red Forest", group: "red", tags: ["forest"], color: "#ff4400" };
  assert.deepEqual(lib.filterLibrary([wallpaper, red], "f:Root", new Set(), "blue"), [wallpaper]);
  assert.deepEqual(lib.filterLibrary([wallpaper, red], "fav", new Set([red.path]), "red"), [red]);
  assert.deepEqual(lib.filterLibrary([{ ...wallpaper, color: "", group: "neutral" }], "", new Set(), "neutral"), []);
  assert.deepEqual(lib.filterLibrary([wallpaper, archive], "archive", new Set(), "blue"), [archive]);
  // Recently Used keeps history order, skips files that left the library and honours the colour.
  const older = { ...red, path: "/wallpapers/older.jpg" };
  assert.deepEqual(lib.filterLibrary([wallpaper, older, archive], "recent", new Set(), "", [archive.path, "/gone.jpg", wallpaper.path]), [archive, wallpaper]);
  assert.deepEqual(lib.filterLibrary([wallpaper, older], "recent", new Set(), "red", [wallpaper.path, older.path]), [older]);
  assert.deepEqual(lib.filterLibrary([wallpaper], "recent", new Set()), []);
  assert.deepEqual(lib.searchLibrary([wallpaper, red, video], "BLUE city"), [wallpaper, video]);
  assert.deepEqual(lib.searchLibrary([wallpaper, red, video], "bl ct still"), [wallpaper]);
  assert.deepEqual(lib.searchLibrary([wallpaper, red, video], "live"), [video]);
  assert.deepEqual(lib.searchLibrary([wallpaper, red], "no-matching-wallpaper"), []);
  assert.deepEqual(lib.searchLibrary([{ ...wallpaper, title: "Café at Dusk" }], "cafe"), [{ ...wallpaper, title: "Café at Dusk" }]);
  assert.equal(lib.searchLibrary(library, "   "), library);

  // A literal title wins over folder matches and pinned ordering; loose subsequences only stand in for no literal match.
  const fuzzyForest = { ...wallpaper, path: "/fuzzy.jpg", name: "first-objects-rest.jpg", title: "First Objects Rest", tags: [] };
  const forestTitle = { ...wallpaper, path: "/forest.jpg", name: "forest.jpg", title: "Forest", tags: [] };
  const forestFolder = { ...wallpaper, path: "/folder.jpg", folder: "Forest", name: "trees.jpg", title: "Trees", tags: [] };
  const forestWord = { ...wallpaper, path: "/word.jpg", name: "forest-at-dawn.jpg", title: "Forest at Dawn", tags: [] };
  const searchItems = [fuzzyForest, forestFolder, forestWord, forestTitle];
  const index = lib.createSearchIndex(searchItems);
  assert.deepEqual(lib.searchLibrary(searchItems, "forest", index), [forestTitle, forestWord, forestFolder]);
  assert.deepEqual(lib.searchLibrary([fuzzyForest], "forest"), [fuzzyForest]);
  assert.deepEqual(lib.searchLibrary(searchItems, "FOREST   dawn", index), [forestWord]);
  assert.deepEqual(lib.searchLibrary([forestTitle, { ...forestTitle, path: "/another-forest.jpg" }], "forest").map((w) => w.path), ["/forest.jpg", "/another-forest.jpg"]);
  const replacement = { ...forestTitle, name: "sea.jpg", title: "Calm Sea" };
  assert.deepEqual(lib.searchLibrary([replacement], "calm sea", index), [replacement]);
  assert.deepEqual(lib.searchLibrary([{ ...wallpaper, title: "Café at Dusk" }], "cafe dusk").map((w) => w.title), ["Café at Dusk"]);

  const numbered = [10, 2, 1].map((n) => ({ ...wallpaper, path: `/night-${n}.jpg`, name: `night-${n}.jpg`, title: `Night ${n}` }));
  assert.deepEqual(numbered.sort(lib.compareWallpaperNames).map((w) => w.title), ["Night 1", "Night 2", "Night 10"]);
  assert.deepEqual(lib.pinnedFirst(numbered, new Set([numbered[1].path])).map((w) => w.title), ["Night 2", "Night 1", "Night 10"]);
  assert.equal(lib.pinnedFirst(numbered, new Set()), numbered);
  const withCurrent = numbered.map((w, i) => ({ ...w, current: i === 2 }));
  assert.deepEqual(lib.pinnedFirst(withCurrent, new Set([numbered[1].path])).map((w) => w.title), ["Night 10", "Night 2", "Night 1"]);
  assert.deepEqual(lib.pinnedFirst(withCurrent, new Set()).map((w) => w.title), ["Night 10", "Night 1", "Night 2"]);
  globalThis.vicinae.preferences = { includeCurrent: false, scanDepth: "1" };
  assert.equal(lib.commandOptions().scan.includeCurrent, false);
  assert.equal(lib.commandOptions().scan.depth, "1");

  // Colour order: families in rainbow order, light to dark inside one, greys last.
  const tone = (name, group, brightness) => ({ ...wallpaper, name, group, brightness });
  assert.deepEqual([tone("g", "neutral", 90), tone("b-dark", "blue", 10), tone("r", "red", 5), tone("b-light", "blue", 80)]
    .sort(lib.colourOrder).map((w) => w.name), ["r", "b-light", "b-dark", "g"]);

  assert.equal(lib.readView().filter, undefined);
  lib.writeView({ filter: "f:Live", sort: "hue" });
  assert.deepEqual(lib.readView(), { filter: "f:Live", sort: "hue" });
  lib.writeView({ filter: "fav", sort: "name", colour: "teal", transition: "wave-sweep", duration: "0.4" });
  assert.deepEqual(lib.readView(), { filter: "fav", sort: "name", colour: "teal", transition: "wave-sweep", duration: "0.4" });
  assert.equal(lib.commandOptions().apply.transition, "wave-sweep");
  assert.equal(lib.commandOptions().apply.duration, "0.4");
  assert.equal(lib.transitionOf("doom"), "soft-fade");
  lib.writeView({ filter: "fav", sort: "hue", transition: "doom", duration: "1.5" });
  assert.deepEqual(lib.readView(), { filter: "fav", sort: "hue", transition: "soft-fade", duration: "auto" });
  assert.equal(lib.transitionOf("not-an-effect"), "soft-fade");
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(manifest.preferences.find((p) => p.name === "defaultAction").default, "palette");
  assert.deepEqual(manifest.preferences.find((p) => p.name === "transition").data.map((p) => p.value).sort(),
    lib.TRANSITIONS.map((p) => p.id).sort());
  assert.deepEqual(manifest.preferences.find((p) => p.name === "transitionDuration").data.map((p) => p.value).sort(),
    [...lib.TRANSITION_DURATIONS].sort());
  lib.writeView({ filter: "c:blue", sort: "hue" });
  assert.deepEqual(lib.readView(), { filter: "", sort: "hue", colour: "blue" });
  lib.writeView({ filter: "", sort: "hue" });

  assert.deepEqual(lib.parseLibraryMetadata("not json"), {});
  assert.deepEqual(lib.parseLibraryMetadata(JSON.stringify({ version: 2, wallpapers: {} })), {});
  const metadata = lib.parseLibraryMetadata(JSON.stringify({ version: 1, wallpapers: {
    "Scenes/a.jpg": { title: "  Rain  ", tags: ["city", 7], source: "https://wallhaven.cc/w/abc123", resolution: "3840x2160" },
    "Other/a.jpg": { title: "Different image", source: "javascript:alert(1)" },
    invalid: null,
  } }));
  assert.equal(metadata["Scenes/a.jpg"].title, "Rain");
  assert.deepEqual(metadata["Scenes/a.jpg"].tags, ["city"]);
  assert.equal(metadata["Other/a.jpg"].title, "Different image");
  assert.equal(metadata["Other/a.jpg"].source, "");

  assert.equal(lib.writeFavourites(new Set([wallpaper.path])), true);
  assert.deepEqual(lib.readFavourites(), new Set([wallpaper.path]));
  const spacedPath = "/wallpapers/scene.jpg ";
  assert.equal(lib.writeFavourites(new Set([spacedPath])), true);
  assert.deepEqual(lib.readFavourites(), new Set([spacedPath]));
  assert.deepEqual(lib.readHistory(), []);
  writeFileSync(join(tempDir, "wallpaper-picker", "history"), "t1\t/a.jpg\nt2\t/b c.jpg\njunk\nt3\t/a.jpg\n\t/no-time.jpg\nt4\t\n");
  assert.deepEqual(lib.readHistory(), ["/a.jpg", "/b c.jpg"]);
  assert.deepEqual(lib.readHistory(1), ["/a.jpg"]);

  // Directory preferences resolve consistently with the scanner, including
  // aliases and trailing slashes, so metadata is looked up by the right key.
  const libraryDir = join(tempDir, "library");
  mkdirSync(libraryDir);
  writeFileSync(join(libraryDir, "one.jpg"), "fixture");
  writeFileSync(join(libraryDir, ".wallpaper-library.json"), JSON.stringify({ version: 1,
    wallpapers: { "one.jpg": { title: "Rainy alley", tags: ["rain"] } },
  }));
  const aliasDir = join(tempDir, "library-alias");
  symlinkSync(libraryDir, aliasDir, "dir");
  const scanScript = join(tempDir, "scan-wallpapers.sh");
  writeFileSync(scanScript, '#!/bin/sh\nprintf "%s/one.jpg\\tone.jpg\\t\\t0\\t#4488ff\\tRoot\\t123\\t57\\n" "$WALLPAPER_DIR"\n');
  chmodSync(scanScript, 0o755);
  const scanned = await lib.scanWallpapers({ directory: aliasDir + "/" });
  assert.equal(scanned.length, 1);
  assert.equal(scanned[0].path, join(libraryDir, "one.jpg"));
  assert.equal(scanned[0].title, "Rainy alley");
  assert.deepEqual(scanned[0].tags, ["rain"]);
  assert.equal(scanned[0].brightness, 57);

  // Folder spelling is part of the filter key, including deliberate surrounding spaces.
  const spacedFolder = " Collection ";
  mkdirSync(join(libraryDir, spacedFolder));
  writeFileSync(join(libraryDir, spacedFolder, "two.jpg"), "fixture");
  writeFileSync(scanScript, '#!/bin/sh\nprintf "%s/ Collection /two.jpg\\ttwo.jpg\\t\\t0\\t#4488ff\\t Collection \\t123\\t57\\n" "$WALLPAPER_DIR"\n');
  const spaced = await lib.scanWallpapers({ directory: libraryDir });
  assert.equal(spaced[0].folder, spacedFolder);
  assert.deepEqual(lib.filterLibrary(spaced, `f:${spacedFolder}`, new Set()), spaced);

  if (process.getuid?.() !== 0) {
    chmodSync(libraryDir, 0o111);
    try { await assert.rejects(lib.scanWallpapers({ directory: libraryDir }), /not readable/); }
    finally { chmodSync(libraryDir, 0o700); }
  }

  assert.equal(lib.libraryDirectory("~/Pictures"), join(homedir(), "Pictures"));
  await assert.rejects(lib.scanWallpapers({ directory: join(libraryDir, "one.jpg") }), /Choose a wallpaper folder/);
  const applyScript = join(tempDir, "apply-wallpaper.sh");
  writeFileSync(applyScript, "#!/bin/sh\nexit 0\n");
  assert.equal(lib.applyWallpaper(libraryDir), false);
  assert.equal(lib.applyWallpaper(join(libraryDir, "missing.jpg")), false);
  assert.equal(lib.applyWallpaper(join(libraryDir, "one.jpg"), { accent: "not a colour" }), false);

  // Solid colours use a durable real image, so the existing history and restore scripts work.
  await assert.rejects(lib.createSolidWallpaper("#ff0000; touch nope"));
  const solid = await lib.createSolidWallpaper("#48f");
  assert.equal(solid, join(tempDir, "wallpaper-picker", "colours", "colour-4488ff.png"));
  assert.equal(readFileSync(solid).subarray(1, 4).toString(), "PNG");
  assert.equal(await lib.createSolidWallpaper("4488ff"), solid);
  assert.equal(lib.readSolidColour(), "#111827");
  lib.rememberSolidColour("48f");
  assert.equal(lib.readSolidColour(), "#4488ff");
  lib.rememberSolidColour("invalid");
  assert.equal(lib.readSolidColour(), "#4488ff");

  // The detached launcher forwards fit and transition without shell evaluation.
  writeFileSync(applyScript, '#!/bin/sh\nprintf "%s\\n" "$WALLPAPER_RESIZE_MODE" "$1" "$2" "$WALLPAPER_PICKER_ACCENT" > "$TEST_APPLY_CAPTURE"\n');
  const capture = join(tempDir, "apply.txt");
  process.env.TEST_APPLY_CAPTURE = capture;
  assert.equal(lib.applyWallpaper(join(libraryDir, "one.jpg"), { resize: "fit", transition: "soft-fade", accent: "48f" }), true);
  let received = "";
  for (let attempt = 0; attempt < 100 && !received; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    try { received = readFileSync(capture, "utf8"); } catch { /* child is starting */ }
  }
  assert.equal(received, `fit\n${join(libraryDir, "one.jpg")}\nsoft-fade\n#4488ff\n`);
  console.log("lib helpers: ok");
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
