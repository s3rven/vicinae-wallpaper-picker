# Preparing a public release

Run the checks from `vicinae/`:

```sh
npm ci
npm test
npm run lint
npx tsc --noEmit
shellcheck -x -P .. ../*.sh ../examples/matugen/post-apply.sh
npm run bundle
npx vici build --out ../release/extension
```

The explicit build output keeps verification separate from the installed
extension. You can also run `./install.sh --build-only` from the repository
root. Test a fresh source export too:

```sh
cd ..
python3 scripts/prepare-release.py
```

`release/vicinae-wallpaper-picker-source.tar.gz` contains only files listed in
`scripts/release-manifest.json`. It includes the current working files, including
uncommitted fixes. It excludes Git history, dependencies, build output, caches,
settings, logs and wallpaper collections. Archive owner names and timestamps
are normalized. The exporter rejects symlinks, absolute home paths, private
network addresses and several common credential formats. Review the result:
pattern checks cannot identify every possible secret.

Extract the source archive into a new directory and initialize a fresh repository
there if you want to publish without existing commit history. Configure the
public author name and email before the first commit. Making an existing
repository public exposes its reachable commits and their author/committer
emails, even when the current files are clean.

Keep your real `wallpaper-picker/env`, screenshots with personal windows, local
state and wallpapers out of the release. `examples/env.example` is the shareable
settings example. The manifest author and LICENSE attribution are public
project identities; review them deliberately before publication.

When upgrading an older local build, update compositor keybinds to the command
IDs in the README. Post-apply hooks now receive the original wallpaper path,
so hooks that expected a theme-mode argument need updating. Choose a wallpaper
once to populate the standalone picker's current state before using login restore.

Backend bundles also use the manifest's explicit file list, so extra local
shell or Python helpers cannot be picked up by a wildcard. Add new runtime files
to the manifest when needed. Build from the reviewed source export when making
a binary release: Vicinae copies the entire assets directory during a build.
