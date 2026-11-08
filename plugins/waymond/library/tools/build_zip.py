#!/usr/bin/env python3
"""Write library.zip containing every library file except tools and the zip itself."""
from __future__ import annotations

import sys
import zipfile
from pathlib import Path


def build(root: Path, out: Path) -> Path:
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for f in sorted(root.rglob("*")):
            rel = f.relative_to(root)
            if f.is_file() and rel.parts[0] != "tools" and f.suffix == ".md":
                z.write(f, rel.as_posix())
    return out


if __name__ == "__main__":
    root = Path(__file__).resolve().parent.parent
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else root / "library.zip"
    print(build(root, out))
