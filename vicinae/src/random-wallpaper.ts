import { showHUD } from "@vicinae/api";
import { applyWallpaper, commandOptions, filterLibrary, isLive, missingTools, scanWallpapers } from "./lib";

// No view, so it can sit on a keybind. Stills only: a shuffle should not start a
// video decoder on battery. Picking a clip stays a choice made in the picker.
export default async function randomWallpaper() {
  const { scan, apply } = commandOptions();
  const missing = missingTools();
  if (missing.length) return showHUD(`Install ${missing.join(", ")} to change wallpapers`);
  let library;
  try { library = await scanWallpapers(scan); }
  catch { return showHUD("Could not read the wallpaper folder. Check extension preferences."); }
  const pool = filterLibrary(library, "", new Set()).filter((w) => !w.current && !isLive(w.path));
  const pick = pool[Math.floor(Math.random() * pool.length)];
  if (!pick) return showHUD("No other still wallpapers in the library");
  if (!applyWallpaper(pick.path, apply)) {
    return showHUD("Could not change the wallpaper");
  }
}
