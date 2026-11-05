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

  assert.equal(lib.rgbString("#4488ff"), "68, 136, 255");
  assert.equal(lib.rgbString("not-a-colour"), "");

  assert.equal(lib.groupOf("#3670D1"), "blue");
  assert.equal(lib.groupOf("#181824"), "neutral");
  assert.equal(lib.groupOf("#ff0000junk"), "");
  assert.equal(lib.hueOf("#181824"), 1e6);
  assert.equal(lib.hueOf("#not-a-hex"), 1e6);
  assert.equal(lib.displayName("wallpaper.PNG", false), "wallpaper");
  assert.equal(lib.displayName("wallpaper.PNG", true), "wallpaper.PNG");



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

  const archive = { ...wallpaper, path: "/wallpapers/Archive/two.jpg", folder: "Archive/dark", current: true };
  const library = [wallpaper, archive];
  assert.deepEqual(lib.filterLibrary(library, "", new Set()), [wallpaper]);
  assert.deepEqual(lib.filterLibrary(library, "c:blue", new Set()), [wallpaper]);
  assert.deepEqual(lib.filterLibrary(library, "archive", new Set()), [archive]);
  assert.deepEqual(lib.filterLibrary(library, "current", new Set()), [archive]);
  assert.deepEqual(lib.filterLibrary(library, "fav", new Set([archive.path])), [archive]);
  assert.deepEqual(lib.filterLibrary([{ ...wallpaper, folder: "fav" }], "f:fav", new Set()), [{ ...wallpaper, folder: "fav" }]);
  const video = { ...wallpaper, path: "/wallpapers/clip.mp4" };
  assert.deepEqual(lib.filterLibrary([wallpaper, video, archive], "live", new Set()), [video]);
  assert.deepEqual(lib.filterLibrary([wallpaper, video, archive], "stills", new Set()), [wallpaper]);
  const red = { ...wallpaper, name: "red-forest.jpg", title: "Red Forest", group: "red", tags: ["forest"], color: "#ff4400" };
  assert.deepEqual(lib.searchLibrary([wallpaper, red, video], "BLUE city"), [wallpaper, video]);
  assert.deepEqual(lib.searchLibrary([wallpaper, red, video], "bl ct still"), [wallpaper]);
  assert.deepEqual(lib.searchLibrary([wallpaper, red, video], "live"), [video]);
  assert.deepEqual(lib.searchLibrary([wallpaper, red], "no-matching-wallpaper"), []);
  assert.deepEqual(lib.searchLibrary([{ ...wallpaper, title: "Café at Dusk" }], "cafe"), [{ ...wallpaper, title: "Café at Dusk" }]);
  assert.equal(lib.searchLibrary(library, "   "), library);
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

  // The detached launcher forwards fit and transition without shell evaluation.
  writeFileSync(applyScript, '#!/bin/sh\nprintf "%s\\n" "$WALLPAPER_RESIZE_MODE" "$1" "$2" > "$TEST_APPLY_CAPTURE"\n');
  const capture = join(tempDir, "apply.txt");
  process.env.TEST_APPLY_CAPTURE = capture;
  assert.equal(lib.applyWallpaper(join(libraryDir, "one.jpg"), { resize: "fit", transition: "soft-fade" }), true);
  let received = "";
  for (let attempt = 0; attempt < 100 && !received; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    try { received = readFileSync(capture, "utf8"); } catch { /* child is starting */ }
  }
  assert.equal(received, `fit\n${join(libraryDir, "one.jpg")}\nsoft-fade\n`);
  console.log("lib helpers: ok");
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
