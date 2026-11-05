import { showHUD } from "@vicinae/api";
import { applyWallpaper, commandOptions, missingTools, readPrevious } from "./lib";

// Running it twice swaps between the last two wallpapers, like `cd -`.
export default async function previousWallpaper() {
  const previous = readPrevious();
  if (previous) {
    const missing = missingTools({ path: previous });
    if (missing.length) return showHUD(`Install ${missing.join(", ")} to change wallpapers`);
  }
  if (!previous || !applyWallpaper(previous, commandOptions().apply)) {
    return showHUD("No previous wallpaper");
  }
}
