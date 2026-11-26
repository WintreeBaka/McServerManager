#!/usr/bin/env python3
"""End to end check for the experimental "host JDK" runtime.

    python tools/host-runtime-check.py [server-id]

It exercises scan -> status -> RCON -> stop through the CLI exactly like the
desktop app does (pipes, no shell), which PowerShell redirection breaks.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import sys
import time

EXE = os.path.join("build", "bin", "mcsm-cli.exe")


def runtime_dirs() -> list[str]:
    """Find Qt and MinGW without baking the developer machine's drive into PATH."""
    candidates: list[str] = []
    explicit = [os.environ.get("MCSM_QT_BIN", ""), os.environ.get("MCSM_MINGW_BIN", "")]
    candidates.extend(path for path in explicit if path)

    cache = Path("build") / "CMakeCache.txt"
    if cache.is_file():
        text = cache.read_text(encoding="utf-8", errors="replace")
        for line in text.splitlines():
            if line.startswith("Qt6_DIR:PATH="):
                candidates.append(str(Path(line.split("=", 1)[1]).parents[2] / "bin"))
            elif line.startswith("CMAKE_CXX_COMPILER:FILEPATH="):
                candidates.append(str(Path(line.split("=", 1)[1]).parent))

    qt_root = os.environ.get("QT_ROOT", "")
    if qt_root:
        root = Path(qt_root)
        if (root / "bin" / "Qt6Core.dll").is_file():
            candidates.append(str(root / "bin"))
        tools = root / "Tools"
        if tools.is_dir():
            for mingw in sorted(tools.glob("mingw*"), reverse=True):
                candidates.append(str(mingw / "bin"))
    return list(dict.fromkeys(path for path in candidates if Path(path).is_dir()))


def environment() -> dict:
    env = dict(os.environ)
    parts = runtime_dirs() + [env.get("PATH", "")]
    env["PATH"] = os.pathsep.join(parts)
    return env


def call(args: list[str]) -> dict:
    """Runs the CLI and returns the JSON envelope (stdout is a pipe)."""
    process = subprocess.Popen([EXE] + args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=environment())
    out, err = process.communicate(timeout=300)
    text = out.decode("utf-8", "replace")
    envelope = None
    for line in text.splitlines():
        line = line.strip()
        if line.startswith("{"):
            envelope = json.loads(line)
    if envelope is None:
        raise RuntimeError(f"no JSON from {' '.join(args)}: stdout={text[:200]} stderr={err.decode('utf-8','replace')[:200]}")
    return envelope


def main() -> int:
    server_id = sys.argv[1] if len(sys.argv) > 1 else "hostjdk"
    failures = 0

    scan = call(["java", "--action", "scan"])
    jdks = scan["data"]["jdks"]
    print(f"[scan] found {len(jdks)} JDK(s)")
    for jdk in jdks[:5]:
        print(f"        {jdk['major']:>3}  {jdk['vendor']:<20} {jdk['sizeText']:>9}  {jdk['home']}")
    if not jdks:
        failures += 1

    status = call(["server", "status", "--id", server_id])["data"]
    print(f"[status] runtime={status['runtime']} status={status['status']} jdk={status.get('jdkHome')}")
    running = status["status"] == "running"

    if not running:
        print("[start] launching …")
        started = call(["server", "start", "--id", server_id, "--wait", "120"])
        print(f"[start] ok={started['ok']} status={started['data'].get('status')} "
              f"elapsed={started['data'].get('elapsedMs')}ms")
        if not started["ok"]:
            print("        message:", started["error"]["message"])
            failures += 1
        else:
            running = True

    if running:
        command = call(["server", "command", "--id", server_id, "--command", "list"])
        print(f"[rcon] ok={command['ok']} response={command['data'].get('response', '').strip()!r}")
        if not command["ok"]:
            failures += 1

        logs = call(["server", "logs", "--id", server_id, "--tail", "5"])["data"]
        print("[logs] last lines:")
        for line in logs["lines"]:
            print("        ", line)
        if not any("Done (" in line for line in logs["lines"]):
            print("        (no readiness banner in the last 5 lines - fine if the tail is short)")

        time.sleep(1)
        stopped = call(["server", "stop", "--id", server_id])
        print(f"[stop] ok={stopped['ok']} note={stopped['data'].get('note')!r}")
        time.sleep(2)
        after = call(["server", "status", "--id", server_id])["data"]["status"]
        print(f"[status] after stop = {after}")
        if after != "stopped":
            failures += 1
    else:
        print("[skip] server is not running")

    print()
    print("FAILED" if failures else "OK")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
