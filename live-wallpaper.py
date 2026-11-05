#!/usr/bin/env python3
"""Play a live (video) wallpaper and pause it when nobody can see it.

    live-wallpaper.py run VIDEO OUTPUT[,OUTPUT...]
    live-wallpaper.py pause | resume | toggle | status
    live-wallpaper.py policy never|covered|windows
    live-wallpaper.py idle | active

`run` is what awww-lib.sh starts as the wallpaper-live user unit: one mpvpaper
per output, each with an mpv IPC socket. mpvpaper's own -p/-a cannot do this
job on Hyprland: frame callbacks keep arriving for a covered background, and
the toplevel states it watches carry no workspace, so a maximized window on
another workspace would freeze the wallpaper on this one. Instead this listens
to Hyprland's event socket (no polling) and re-checks only the visible
workspaces when windows or workspaces change.

The other commands edit the picker's state files and SIGHUP the unit, so the
picker, a keybind and a login restore all share one source of truth. `idle` and
`active` are for an idle daemon (hypridle's on-timeout/on-resume): nothing in
Hyprland's events changes when the screen dims, locks or goes dark, so without
them a wallpaper would play for hours behind a lock screen. That flag lives in
the runtime dir and never outlives the session, unlike a manual pause.
"""

import json
import hashlib
import os
import select
import signal
import socket
import subprocess
import sys
import time

STATE = os.path.join(os.environ.get("XDG_STATE_HOME") or os.path.expanduser("~/.local/state"), "wallpaper-picker")
POLICY_FILE = os.path.join(STATE, "live-pause-when")
PAUSED_FILE = os.path.join(STATE, "live-paused")
RUNTIME = os.environ.get("XDG_RUNTIME_DIR")
CACHE = os.environ.get("XDG_CACHE_HOME") or os.path.expanduser("~/.cache")
PLAYER_RUNTIME = os.path.join(RUNTIME or CACHE, "wallpaper-picker", "runtime")
IDLE_FILE = os.path.join(PLAYER_RUNTIME, "live-idle")
UNIT = "wallpaper-live.service"
POLICIES = ("never", "covered", "windows")
DEFAULT_POLICY = "covered"
MPV_OPTIONS = os.environ.get("WALLPAPER_LIVE_MPV_OPTIONS") or "no-audio loop hwdec=auto-safe panscan=1.0"

# Hyprland events that can change what is visible on an output.
EVENTS = {
    "workspace", "workspacev2", "focusedmon", "focusedmonv2", "openwindow", "closewindow",
    "movewindow", "movewindowv2", "fullscreen", "changefloatingmode", "activespecial",
    "activespecialv2", "moveworkspace", "moveworkspacev2", "monitoradded", "monitoraddedv2",
    "monitorremoved", "monitorremovedv2",
}


def read_policy():
    try:
        with open(POLICY_FILE) as f:
            policy = f.read().strip()
    except OSError:
        return DEFAULT_POLICY
    return policy if policy in POLICIES else DEFAULT_POLICY


def manually_paused():
    return os.path.exists(PAUSED_FILE)


def covered_outputs(policy, monitors, workspaces):
    """Names of outputs whose visible workspace hides the wallpaper under `policy`."""
    if policy == "never":
        return set()
    by_id = {w.get("id"): w for w in workspaces}
    hidden = set()
    for m in monitors:
        # An open special workspace (scratchpad) sits above the regular one.
        shown = [by_id.get((m.get("activeWorkspace") or {}).get("id"))]
        special = (m.get("specialWorkspace") or {}).get("id")
        if special:
            shown.append(by_id.get(special))
        for w in filter(None, shown):
            # hasfullscreen is true for maximized windows too (fullscreen mode 1).
            if w.get("hasfullscreen") or (policy == "windows" and w.get("windows", 0) > 0):
                hidden.add(m.get("name"))
    return hidden


def hypr_socket(name):
    sig = os.environ.get("HYPRLAND_INSTANCE_SIGNATURE")
    return os.path.join(RUNTIME, "hypr", sig, name) if RUNTIME and sig else None


def hypr_query(what):
    s = socket.socket(socket.AF_UNIX)
    s.settimeout(1)
    try:
        s.connect(hypr_socket(".socket.sock"))
        s.sendall(b"j/" + what.encode())
        data = b""
        while chunk := s.recv(65536):
            data += chunk
        return json.loads(data)
    finally:
        s.close()


def mpv_set_pause(sock_path, paused):
    s = socket.socket(socket.AF_UNIX)
    s.settimeout(0.5)
    try:
        s.connect(sock_path)
        s.sendall(json.dumps({"command": ["set_property", "pause", paused]}).encode() + b"\n")
        return True
    except OSError:
        return False
    finally:
        s.close()


def run(video, outputs):
    os.makedirs(PLAYER_RUNTIME, mode=0o700, exist_ok=True)
    outputs = [o for o in outputs.split(",") if o]
    events = None
    path = hypr_socket(".socket2.sock")
    if path and os.path.exists(path):
        events = socket.socket(socket.AF_UNIX)
        try:
            events.connect(path)
        except OSError:
            events.close()
            events = None

    def wanted():
        policy = read_policy()
        hidden = set()
        if events and policy != "never":
            try:
                hidden = covered_outputs(policy, hypr_query("monitors"), hypr_query("workspaces"))
            except (OSError, ValueError, TypeError, AttributeError):
                pass
        held = manually_paused() or os.path.exists(IDLE_FILE)
        return {o: held or o in hidden for o in outputs}

    players, sockets = {}, {}

    wake_r, wake_w = os.pipe()
    os.set_blocking(wake_w, False)
    signal.set_wakeup_fd(wake_w)
    stop = []
    signal.signal(signal.SIGTERM, lambda *_: stop.append(0))
    signal.signal(signal.SIGINT, lambda *_: stop.append(0))
    signal.signal(signal.SIGHUP, lambda *_: None)
    signal.signal(signal.SIGCHLD, lambda *_: None)

    buf = b""
    retry_at = None
    code = 1
    try:
        want = wanted()
        for out in outputs:
            # Output names are external input; never interpret one as a path.
            key = hashlib.sha256(out.encode()).hexdigest()[:12]
            sockets[out] = os.path.join(PLAYER_RUNTIME, f"mpv-{key}.sock")
            # Start paused when hidden, so a covered wallpaper never decodes a frame.
            opts = f"{MPV_OPTIONS} really-quiet input-ipc-server={json.dumps(sockets[out], ensure_ascii=False)}" + (" pause" if want[out] else "")
            players[out] = subprocess.Popen(["mpvpaper", "-o", opts, out, video],
                                            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                            stderr=subprocess.DEVNULL)
        applied = dict(want)

        while not stop:
            timeout = None if retry_at is None else max(0, retry_at - time.monotonic())
            readable, _, _ = select.select([wake_r] + ([events] if events else []), [], [], timeout)
            dirty = retry_at is not None and time.monotonic() >= retry_at
            if wake_r in readable:
                os.read(wake_r, 512)  # SIGHUP (state changed) or SIGCHLD
                dirty = True
                # An unplugged output takes only its own player with it; the
                # unit ends, as failed, once nothing is left to play.
                for out in [o for o, p in players.items() if p.poll() is not None]:
                    code = players.pop(out).returncode
                    want.pop(out, None)
                if not players:
                    return code or 1
            if events in readable:
                chunk = events.recv(65536)
                if not chunk:  # compositor gone
                    return 0
                buf += chunk
                *lines, buf = buf.split(b"\n")
                dirty |= any(line.split(b">>", 1)[0].decode(errors="replace") in EVENTS for line in lines)
            if not dirty:
                continue
            retry_at = None
            want = {o: v for o, v in wanted().items() if o in players}
            for out, paused in want.items():
                if applied.get(out) == paused:
                    continue
                if mpv_set_pause(sockets[out], paused):
                    applied[out] = paused
                else:  # mpv still starting up
                    retry_at = time.monotonic() + 0.25
        return 0
    finally:
        for p in players.values():
            p.terminate()
        for p in players.values():
            try:
                p.wait(timeout=2)
            except subprocess.TimeoutExpired:
                p.kill()
                p.wait()
        signal.set_wakeup_fd(-1)
        os.close(wake_r)
        os.close(wake_w)
        if events:
            events.close()
        for s in sockets.values():
            try:
                os.unlink(s)
            except OSError:
                pass


def notify_unit():
    try:
        subprocess.run(["systemctl", "--user", "kill", "--signal=HUP", "--kill-whom=main", UNIT],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=3)
    except (OSError, subprocess.TimeoutExpired):
        pass  # Control settings still persist without a running player or systemd.


def running():
    try:
        return subprocess.run(["systemctl", "--user", "is-active", "--quiet", UNIT],
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=3).returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        return False


def set_paused(on):
    os.makedirs(STATE, exist_ok=True)
    if on:
        open(PAUSED_FILE, "w").close()
    elif os.path.exists(PAUSED_FILE):
        os.unlink(PAUSED_FILE)
    notify_unit()


def main(argv):
    os.umask(0o077)
    cmd = argv[1] if len(argv) > 1 else ""
    if cmd == "run" and len(argv) == 4:
        return run(argv[2], argv[3])
    if cmd in ("pause", "resume", "toggle") and len(argv) == 2:
        set_paused(cmd == "pause" or (cmd == "toggle" and not manually_paused()))
        return 0
    if cmd in ("idle", "active") and len(argv) == 2:
        os.makedirs(PLAYER_RUNTIME, mode=0o700, exist_ok=True)
        if cmd == "idle":
            open(IDLE_FILE, "w").close()
        elif os.path.exists(IDLE_FILE):
            os.unlink(IDLE_FILE)
        notify_unit()
        return 0
    if cmd == "policy" and len(argv) == 3 and argv[2] in POLICIES:
        os.makedirs(STATE, exist_ok=True)
        tmp = f"{POLICY_FILE}.{os.getpid()}.tmp"
        with open(tmp, "w") as f:
            f.write(argv[2] + "\n")
        os.replace(tmp, POLICY_FILE)
        notify_unit()
        return 0
    if cmd == "status" and len(argv) == 2:
        print(json.dumps({"running": running(), "paused": manually_paused(), "policy": read_policy()}))
        return 0
    print(__doc__.strip().split("\n\n")[1], file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
