import { chmodSync, copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

// Never glob the checkout: a local helper can contain private paths or hooks.
const root = fileURLToPath(new URL("../../", import.meta.url));
const { backend } = JSON.parse(readFileSync(join(root, "scripts/release-manifest.json"), "utf8"));
const assets = join(root, "vicinae/assets");
mkdirSync(assets, { recursive: true });
const stage = mkdtempSync(join(assets, ".backend-"));
try {
  for (const name of backend) {
    if (!/^[a-z0-9-]+\.(sh|py)$/.test(name) || !lstatSync(join(root, name)).isFile()) {
      throw new Error(`Backend entry must be a regular source file: ${name}`);
    }
    copyFileSync(join(root, name), join(stage, name));
    chmodSync(join(stage, name), 0o755);
  }
  rmSync(join(assets, "backend"), { recursive: true, force: true });
  renameSync(stage, join(assets, "backend"));
  console.log(`Bundled ${backend.length} backend files.`);
} finally {
  rmSync(stage, { recursive: true, force: true });
}
