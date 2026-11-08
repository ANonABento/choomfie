#!/usr/bin/env python3
"""Check the agent library against plan requirements 2, 3, 5, 6 and 7.

Usage: python tools/check_library.py [library_dir]   (exit 0 = ok)
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

MODES = ("answer", "code", "debug", "cad", "3d")
CORE_TOKEN_CAP = 1500
LESSONS_MAX_ENTRIES = 40
LESSONS_MAX_BYTES = 2048
LESSONS_HEADER = """<!-- lessons format v1
One line per entry: YYYY-MM-DD | trigger | what went wrong | rule now
Cap: 40 entries / 2 KB of entries per mode.
Over cap: merge duplicates into a rule promoted to core/<mode>.md; drop entries > 90 days not hit again.
Read before task, append after.
-->
"""
GENERIC_RULES = (
    "write clean code",
    "follow best practices",
    "be careful",
    "write good code",
    "use common sense",
)
LESSON_RE = re.compile(r"^\d{4}-\d{2}-\d{2} \| [^|]+ \| [^|]+ \| [^|]+$")
INDEX_RE = re.compile(r"^- `?([\w./-]+\.md)`? — \S.*$")
TAG_RE = re.compile(r"\b(un)?tested\b")
SECTIONS = ("core", "ref", "checklists", "lessons")


def count_tokens(text: str) -> int:
    import tiktoken

    return len(tiktoken.get_encoding("cl100k_base").encode(text))


def check_core(path: Path, text: str) -> list[str]:
    errs = []
    n = count_tokens(text)
    if n >= CORE_TOKEN_CAP:
        errs.append(f"{path}: {n} tokens (cap < {CORE_TOKEN_CAP})")
    in_fence = False
    for i, line in enumerate(text.splitlines(), 1):
        s = line.strip()
        if s.startswith("```"):
            in_fence = not in_fence
            continue
        if in_fence or not s or s.startswith("#") or s.startswith("<!--"):
            continue
        if not s.startswith("- "):
            errs.append(f"{path}:{i}: core lines must be '- ' one-liners")
        low = s.lower()
        for g in GENERIC_RULES:
            if g in low:
                errs.append(f"{path}:{i}: generic rule '{g}'")
    return errs


def check_ref(path: Path, text: str) -> list[str]:
    lines = text.splitlines()[:3]
    if len(lines) < 3 or not lines[0].lstrip("#> ").startswith("Use this when"):
        return [f"{path}: must start with a 3-line 'Use this when…' header"]
    if any(not l.strip() for l in lines):
        return [f"{path}: 'Use this when…' header must be 3 non-empty lines"]
    return []


def check_fences(path: Path, text: str) -> list[str]:
    errs = []
    lines = text.splitlines()
    in_fence = False
    for i, line in enumerate(lines):
        if not line.strip().startswith("```"):
            continue
        if not in_fence:
            prev = lines[i - 1] if i else ""
            if not (TAG_RE.search(line) or TAG_RE.search(prev)):
                errs.append(f"{path}:{i + 1}: fenced block not marked tested/untested")
        in_fence = not in_fence
    if in_fence:
        errs.append(f"{path}: unclosed fenced block")
    return errs


def check_lessons(path: Path, text: str) -> list[str]:
    if not text.startswith(LESSONS_HEADER):
        return [f"{path}: missing lessons format header"]
    body = text[len(LESSONS_HEADER):]
    entries = [l for l in body.splitlines() if l.strip()]
    errs = [f"{path}: bad lesson line '{l}'" for l in entries if not LESSON_RE.match(l)]
    if len(entries) > LESSONS_MAX_ENTRIES:
        errs.append(f"{path}: {len(entries)} entries (cap {LESSONS_MAX_ENTRIES})")
    if len(body.encode()) > LESSONS_MAX_BYTES:
        errs.append(f"{path}: entries exceed {LESSONS_MAX_BYTES} bytes")
    return errs


def check_index(root: Path, files: list[Path]) -> list[str]:
    index = root / "INDEX.md"
    if not index.is_file():
        return ["INDEX.md missing"]
    listed = []
    for i, line in enumerate(index.read_text().splitlines(), 1):
        if line.startswith("- "):
            m = INDEX_RE.match(line)
            if not m:
                return [f"INDEX.md:{i}: expected '- path — when to read it'"]
            listed.append(m.group(1))
    errs = [f"INDEX.md: '{p}' listed twice" for p in set(listed) if listed.count(p) > 1]
    actual = {f.relative_to(root).as_posix() for f in files}
    errs += [f"INDEX.md: missing {p}" for p in sorted(actual - set(listed))]
    errs += [f"INDEX.md: lists nonexistent {p}" for p in sorted(set(listed) - actual)]
    return errs


def check(root: Path) -> list[str]:
    errs = []
    files = sorted(f for s in SECTIONS for f in (root / s).glob("*.md"))
    for m in MODES:
        if not (root / "lessons" / f"{m}.md").is_file():
            errs.append(f"lessons/{m}.md missing")
    for f in files:
        rel = f.relative_to(root)
        text = f.read_text()
        section = rel.parts[0]
        if section == "core":
            errs += check_core(rel, text)
        elif section == "ref":
            errs += check_ref(rel, text)
        elif section == "lessons":
            errs += check_lessons(rel, text)
        errs += check_fences(rel, text)
    errs += check_index(root, files)
    return errs


def main(argv: list[str]) -> int:
    root = Path(argv[1]) if len(argv) > 1 else Path(__file__).resolve().parent.parent
    errs = check(root)
    for e in errs:
        print(f"FAIL {e}")
    if not errs:
        print("OK library checks passed")
    return 1 if errs else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
