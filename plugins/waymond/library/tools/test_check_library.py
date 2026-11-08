import sys
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import build_zip  # noqa: E402
import check_library as cl  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent


def make_lib(tmp: Path) -> Path:
    for m in cl.MODES:
        p = tmp / "lessons" / f"{m}.md"
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(cl.LESSONS_HEADER + "2026-11-08 | trigger | went wrong | rule now\n")
    (tmp / "core").mkdir()
    (tmp / "core" / "code.md").write_text("# Code\n- Run the tests before replying.\n")
    (tmp / "ref").mkdir()
    (tmp / "ref" / "bun.md").write_text(
        "Use this when writing Bun code.\nCovers bun test.\nSkip for Node.\n\nuntested\n```sh\nbun test\n```\n"
    )
    files = ["core/code.md", "ref/bun.md"] + [f"lessons/{m}.md" for m in cl.MODES]
    (tmp / "INDEX.md").write_text("".join(f"- {f} — when needed\n" for f in files))
    return tmp


def test_skeleton_passes():
    assert cl.check(ROOT) == []
    assert cl.main(["x", str(ROOT)]) == 0


def test_valid_fixture_passes(tmp_path):
    assert cl.check(make_lib(tmp_path)) == []


def test_failing_fixture(tmp_path):
    lib = make_lib(tmp_path)
    (lib / "core" / "code.md").write_text("- Write clean code.\nprose line\n" + "- word\n" * 800)
    (lib / "ref" / "bun.md").write_text("No header\n```sh\nbun test\n```\n")
    (lib / "lessons" / "cad.md").write_text("free text\n")
    (lib / "ref" / "extra.md").write_text("Use this when a.\nb\nc\n")
    (lib / "lessons" / "3d.md").unlink()
    errs = "\n".join(cl.check(lib))
    for needle in ("tokens", "generic rule", "one-liners", "Use this when", "tested/untested",
                   "lessons format header", "missing ref/extra.md", "lessons/3d.md missing",
                   "nonexistent lessons/3d.md"):
        assert needle in errs, needle
    assert cl.main(["x", str(lib)]) == 1


def test_lessons_cap(tmp_path):
    lib = make_lib(tmp_path)
    line = "2026-11-08 | t | w | r\n"
    (lib / "lessons" / "code.md").write_text(cl.LESSONS_HEADER + line * 41)
    assert any("entries" in e for e in cl.check(lib))


def test_build_zip(tmp_path):
    out = build_zip.build(make_lib(tmp_path), tmp_path / "library.zip")
    names = zipfile.ZipFile(out).namelist()
    assert "INDEX.md" in names and "lessons/answer.md" in names
