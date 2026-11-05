import { showHUD } from "@vicinae/api";
import { liveControl, liveStatus } from "./lib";

// No view, so it can sit on a keybind.
export default async function toggleLiveWallpaper() {
  if (!(await liveControl("toggle"))) return showHUD("Could not change the live wallpaper");
  const s = await liveStatus();
  if (!s?.running) return showHUD(s?.paused ? "Live wallpapers paused" : "Live wallpapers resumed");
  return showHUD(s.paused ? "Live wallpaper paused" : "Live wallpaper playing");
}
