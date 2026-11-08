"""Build library.zip (the whole library tree) next to the library dir: plugins/waymond/library.zip.

Deterministic: sorted entries, fixed timestamps, so rebuilding unchanged files gives the same bytes.
"""
import os
import sys
import zipfile

SKIP = {"__pycache__", ".pytest_cache"}


def build(root, out):
    base = os.path.basename(os.path.normpath(root))
    entries = []
    for d, dirs, names in os.walk(root):
        dirs[:] = sorted(x for x in dirs if x not in SKIP)
        for n in names:
            if not n.endswith(".pyc"):
                full = os.path.join(d, n)
                entries.append((os.path.join(base, os.path.relpath(full, root)).replace(os.sep, "/"), full))
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for arc, full in sorted(entries):
            info = zipfile.ZipInfo(arc, date_time=(2026, 1, 1, 0, 0, 0))
            info.external_attr = 0o644 << 16
            with open(full, "rb") as f:
                z.writestr(info, f.read(), zipfile.ZIP_DEFLATED)
    return [a for a, _ in sorted(entries)]


if __name__ == "__main__":
    root = sys.argv[1] if len(sys.argv) > 1 else os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    out = sys.argv[2] if len(sys.argv) > 2 else os.path.join(os.path.dirname(os.path.normpath(root)), "library.zip")
    names = build(root, out)
    print(f"{out}: {len(names)} files")
