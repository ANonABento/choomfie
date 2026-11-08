"""Check plugins/waymond/library against plan.md requirements 1-3, 5, 6, 7.

Run from the library dir (`python tools/check_library.py`) or pass the library path.
Exits 0 when clean, 1 with one line per problem otherwise.
"""
import os
import re
import sys

MODES = ["answer", "code", "debug", "cad", "3d", "research"]
CORE_TOKEN_CAP = 1500
LESSON_CHAR_CAP = 2200
LESSON_ROW = re.compile(
    r"^\d{4}-\d{2}-\d{2} \| [a-z0-9]+: [^|]+ \| [^|]+ \| [^|]+ \| src:[^|]+ \| hits:\d+$"
)
LESSON_HEADER = (
    "# Lessons — {mode}  (cap 2,200 chars; consolidate at 80%; one row per line)\n"
    "# date | trigger | what went wrong | rule now | src:<PR/issue/url> | hits:<n>"
)
TAG = re.compile(r"\b(un)?tested\b", re.I)
SKIP_DIRS = {"tools", "__pycache__"}


def count_tokens(text):
    try:
        import tiktoken

        return len(tiktoken.get_encoding("cl100k_base").encode(text))
    except Exception:  # tiktoken missing or offline: conservative estimate
        return (len(text) + 2) // 3


def library_files(root):
    out = []
    for d, dirs, names in os.walk(root):
        dirs[:] = [x for x in dirs if x not in SKIP_DIRS]
        for n in names:
            if n.endswith(".md"):
                out.append(os.path.relpath(os.path.join(d, n), root).replace(os.sep, "/"))
    return sorted(out)


def read(root, rel):
    with open(os.path.join(root, rel), encoding="utf-8") as f:
        return f.read()


def check_layout(root, files):
    need = ["INDEX.md", "core/shared.md"]
    for m in MODES:
        need += [f"core/{m}.md", f"checklists/{m}.md", f"lessons/{m}.md"]
    return [f"missing: {p}" for p in need if p not in files]


def check_core(root, files):
    errs, seen = [], {}
    for p in [f for f in files if f.startswith("core/")]:
        text = read(root, p)
        n = count_tokens(text)
        if n >= CORE_TOKEN_CAP:
            errs.append(f"{p}: {n} tokens >= {CORE_TOKEN_CAP}")
        for line in text.splitlines():
            key = re.sub(r"\W+", " ", line).strip().lower()
            if not line.startswith("- ") or not key:
                continue
            if key in seen and seen[key] != p:
                errs.append(f"{p}: duplicate of rule in {seen[key]}: {line[:60]}")
            seen.setdefault(key, p)
    return errs


def check_ref(root, files):
    errs = []
    for p in [f for f in files if f.startswith("ref/")]:
        lines = read(root, p).splitlines()
        if len(lines) < 4 or not lines[0].startswith("Use this when") \
                or not lines[1].strip() or not lines[2].strip() or lines[3].strip():
            errs.append(f"{p}: needs a 3-line 'Use this when…' header then a blank line")
    return errs


def check_snippets(root, files):
    """Every fenced block needs `tested`/`untested` in the 6 lines above it."""
    errs = []
    for p in files:
        if p.startswith("lessons/"):
            continue
        lines, inside = read(root, p).splitlines(), False
        for i, line in enumerate(lines):
            if not line.startswith("```"):
                continue
            if not inside and not any(TAG.search(x) for x in lines[max(0, i - 6):i]):
                errs.append(f"{p}:{i + 1}: snippet not tagged tested/untested")
            inside = not inside
    return errs


def check_lessons(root, files):
    errs = []
    for m in MODES:
        p = f"lessons/{m}.md"
        if p not in files:
            continue
        text = read(root, p)
        head = LESSON_HEADER.format(mode=m)
        if not text.startswith(head):
            errs.append(f"{p}: missing the front-7 lessons header")
            continue
        rows = [r for r in text[len(head):].splitlines() if r.strip()]
        for r in rows:
            if not LESSON_ROW.match(r):
                errs.append(f"{p}: bad row: {r[:60]}")
        if len("\n".join(rows)) > LESSON_CHAR_CAP:
            errs.append(f"{p}: over {LESSON_CHAR_CAP} chars")
    return errs


def check_index(root, files):
    if "INDEX.md" not in files:
        return []
    errs, counts = [], {}
    for line in read(root, "INDEX.md").splitlines():
        m = re.match(r"^(\S+\.md) — \S", line)
        if m:
            counts[m.group(1)] = counts.get(m.group(1), 0) + 1
    for p in files:
        if p != "INDEX.md" and counts.get(p, 0) != 1:
            errs.append(f"INDEX.md: {p} listed {counts.get(p, 0)} times (want 1)")
    for p in counts:
        if p not in files:
            errs.append(f"INDEX.md: lists missing file {p}")
    return errs


def check(root):
    files = library_files(root)
    errs = []
    for fn in (check_layout, check_core, check_ref, check_snippets, check_lessons, check_index):
        errs += fn(root, files)
    return errs


def main(argv):
    root = argv[1] if len(argv) > 1 else os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    errs = check(root)
    for e in errs:
        print(e)
    print("ok" if not errs else f"{len(errs)} problem(s)")
    return 1 if errs else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
