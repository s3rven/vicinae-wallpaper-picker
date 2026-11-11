import { showHUD } from "@vicinae/api";
import { existsSync } from "node:fs";
import { applyWallpaper, commandOptions, missingTools, readPrevious } from "./lib";

// Running it twice swaps between the last two wallpapers, like `cd -`.
export default async function previousWallpaper() {
  const previous = readPrevious();
  if (!previous) return showHUD("No previous wallpaper");
  // The library is pruned by hand; say so rather than claim there was none.
  if (!existsSync(previous)) return showHUD("The previous wallpaper is no longer on disk");
  const missing = missingTools({ path: previous });
  if (missing.length) return showHUD(`Install ${missing.join(", ")} to change wallpapers`);
  if (!applyWallpaper(previous, commandOptions().apply)) return showHUD("Could not change the wallpaper");
}
