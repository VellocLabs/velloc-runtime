#!/usr/bin/env python3
"""Mirror the UI <-> Runtime protocol client into the Chromium WebUI tree.

Why a mirror at all
-------------------
The outer WebUI pages (`chrome://` Lit) and the nexus_web guest are two
different builds: the guest is Vite, the WebUI is Chromium's `build_webui`,
which compiles a GN-listed set of files from the source tree and cannot import
anything outside it. So the panel host cannot `import` the protocol — for years
it carried a HAND-WRITTEN copy of the wire envelope (`nexus_webui_bridge.ts`),
which is exactly the drift the protocol exists to prevent.

This copies the protocol client from nexus_web into the WebUI tree so there is
one source of truth and a check that says when the copy has rotted. The copy is
generated, never edited: `--check` fails when it differs from what this script
would write, which is what the unit test (`protocol-mirror.test.ts`) runs on
every suite. Without a sibling `src/custom_browser` (an open-source checkout of
the runtime alone) there is nothing to mirror into and the test skips: a client
of the protocol never needs this script to develop against it.

The transform
-------------
Exactly two things happen to each file:

1. A header is prepended saying it is generated and where the source is.
2. Relative import/export specifiers get an extension: `./errors` ->
   `./errors.js`, `../runtimeProtocol` -> `../runtimeProtocol/index.js`.
   Chromium's WebUI TypeScript resolves real paths (`moduleResolution` for the
   browser), while Vite resolves extensionless ones.

Nothing else is rewritten. A file that needs more than that to compile in the
WebUI build does not belong in the mirror.
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

# This script lives in the repo that OWNS the protocol, so its source is always
# the checkout it sits in — a worktree mirrors its own branch, not main.
NEXUS_WEB = Path(__file__).resolve().parents[1]
DEFAULT_SOURCE_ROOT = NEXUS_WEB / "src" / "browser"


def _workspace_root() -> Path:
    """The directory holding the Chromium tree this mirror is written into.

    A nexus_web worktree sits at `nexus_web/.velloc/worktrees/<branch>`, so the
    root is not a fixed number of levels up — walk until `src/custom_browser`
    appears.
    """
    for candidate in Path(__file__).resolve().parents:
        if (candidate / "src" / "custom_browser" / "resources").is_dir():
            return candidate
    raise SystemExit(
        "[mirror] no src/custom_browser above this script — nothing to mirror into"
    )


ROOT = _workspace_root()
MIRROR_ROOT = (
    ROOT
    / "src"
    / "custom_browser"
    / "resources"
    / "browser_webui"
    / "pages"
    / "nexus"
    / "protocol"
)

# Relative to the source / mirror roots. The set is closed: every relative
# import in these files resolves to another file in the set (the script checks).
# Only the wire codec: the panel host's own client (`nexus_runtime_client.ts`)
# drives the handshake, so connection, transports and payload types stay out.
FILES = [
    "runtimeProtocol/errors.ts",
    "runtimeProtocol/route.ts",
    "runtimeProtocol/topics.ts",
    "runtimeProtocol/frames.ts",
    "runtimeProtocol/codec.ts",
]

HEADER = """// GENERATED — DO NOT EDIT.
//
// Mirror of nexus_web/src/browser/{rel}, copied by
// nexus_web/scripts/sync_runtime_protocol_mirror.py so the outer WebUI page can
// speak the UI <-> Runtime protocol without a hand-written envelope. Edit the
// nexus_web source and re-run the script; `--check` fails when this file and
// its source disagree (nexus_web `protocol-mirror.test.ts`).

"""

SPECIFIER = re.compile(r"""(from\s+|import\s*\(\s*)(['"])(\.[^'"]*)\2""")


def _resolve(source_root: Path, spec: str, from_file: str) -> str:
    """`./errors` -> `./errors.js`; a directory -> `<dir>/index.js`."""
    base = (source_root / from_file).parent
    target = (base / spec).resolve()
    if target.with_suffix(".ts").is_file():
        return f"{spec}.js"
    if (target / "index.ts").is_file():
        return f"{spec}/index.js"
    raise SystemExit(
        f"[mirror] {from_file}: cannot resolve '{spec}'. The mirror set is "
        f"closed — add the file it points at to FILES, or stop importing it."
    )


def render(source_root: Path, rel: str) -> bytes:
    source = (source_root / rel).read_text(encoding="utf-8")
    rewritten = SPECIFIER.sub(
        lambda m: f"{m.group(1)}{m.group(2)}{_resolve(source_root, m.group(3), rel)}{m.group(2)}",
        source,
    )
    return (HEADER.format(rel=rel) + rewritten).encode("utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--check",
        action="store_true",
        help="exit non-zero when the mirror differs, writing nothing",
    )
    parser.add_argument(
        "--source",
        type=Path,
        default=DEFAULT_SOURCE_ROOT,
        help=(
            "the nexus_web `src/browser` to mirror FROM (default: the "
            "workspace checkout). A worktree passes its own, so the guard "
            "checks the tree under test rather than main."
        ),
    )
    args = parser.parse_args()
    source_root: Path = args.source.resolve()
    if not (source_root / "runtimeProtocol").is_dir():
        raise SystemExit(f"[mirror] not a nexus_web src/browser: {source_root}")

    stale: list[str] = []
    for rel in FILES:
        want = render(source_root, rel)
        out = MIRROR_ROOT / rel
        have = out.read_bytes() if out.is_file() else None
        if have == want:
            continue
        if args.check:
            stale.append(rel if have is not None else f"{rel} (missing)")
            continue
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_bytes(want)
        print(f"  wrote {out.relative_to(ROOT)}")

    if args.check:
        if stale:
            print("[mirror] out of date:", ", ".join(stale))
            print("  run: python nexus_web/scripts/sync_runtime_protocol_mirror.py")
            return 1
        print(f"[mirror] {len(FILES)} files match their nexus_web sources")
        return 0

    # A file in the mirror that the set no longer names is left behind by a
    # rename; say so rather than leaving dead code in the Chromium build.
    if MIRROR_ROOT.is_dir():
        known = {MIRROR_ROOT / rel for rel in FILES}
        for path in MIRROR_ROOT.rglob("*.ts"):
            if path not in known:
                print(f"  ORPHAN (delete it and its BUILD.gn row): {path.relative_to(ROOT)}")
    print(f"[mirror] {len(FILES)} files synced")
    return 0


if __name__ == "__main__":
    sys.exit(main())
