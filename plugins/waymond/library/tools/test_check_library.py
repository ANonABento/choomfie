import os
import shutil
import sys
import zipfile

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
LIB = os.path.dirname(HERE)
sys.path.insert(0, HERE)

import build_zip  # noqa: E402
import check_library as cl  # noqa: E402


@pytest.fixture
def lib(tmp_path):
    dst = tmp_path / "library"
    shutil.copytree(LIB, dst, ignore=shutil.ignore_patterns("tools", "__pycache__"))
    return dst


def test_real_library_is_clean():
    assert cl.check(LIB) == []


def test_research_mode_required(lib):
    assert "research" in cl.MODES
    os.remove(lib / "core" / "research.md")
    errs = cl.check(str(lib))
    assert "missing: core/research.md" in errs
    assert any("lists missing file core/research.md" in e for e in errs)


def test_research_lessons_need_header(lib):
    (lib / "lessons" / "research.md").write_text("# Lessons\n", encoding="utf-8")
    assert any("lessons/research.md: missing" in e for e in cl.check(str(lib)))


def test_lesson_row_regex(lib):
    p = lib / "lessons" / "research.md"
    good = "2026-11-08 | research: no source | guessed a version | cite the release page | src:#102 | hits:1"
    p.write_text(p.read_text(encoding="utf-8") + good + "\n", encoding="utf-8")
    assert cl.check(str(lib)) == []
    p.write_text(p.read_text(encoding="utf-8") + "free text\n", encoding="utf-8")
    assert any("bad row" in e for e in cl.check(str(lib)))


def test_ref_header(lib):
    (lib / "ref" / "research.md").write_text("# no header\n", encoding="utf-8")
    assert any("ref/research.md: needs" in e for e in cl.check(str(lib)))


def test_untagged_snippet(lib):
    p = lib / "ref" / "research.md"
    p.write_text(p.read_text(encoding="utf-8") + "\n\n\n\n\n\n\n```\nls\n```\n", encoding="utf-8")
    assert any("snippet not tagged" in e for e in cl.check(str(lib)))


def test_index_duplicate_line(lib):
    p = lib / "INDEX.md"
    p.write_text(p.read_text(encoding="utf-8") + "core/research.md — again\n", encoding="utf-8")
    assert any("core/research.md listed 2 times" in e for e in cl.check(str(lib)))


def test_duplicate_core_rule(lib):
    p = lib / "core" / "research.md"
    rule = [x for x in (lib / "core" / "shared.md").read_text(encoding="utf-8").splitlines() if x.startswith("- ")][0]
    p.write_text(p.read_text(encoding="utf-8") + rule + "\n", encoding="utf-8")
    assert any("duplicate" in e for e in cl.check(str(lib)))


def test_core_token_cap(lib):
    p = lib / "core" / "research.md"
    p.write_text(p.read_text(encoding="utf-8") + "- word\n" * 2000, encoding="utf-8")
    assert any("tokens" in e for e in cl.check(str(lib)))


def test_zip_has_full_tree(tmp_path):
    out = tmp_path / "library.zip"
    build_zip.build(LIB, str(out))
    names = set(zipfile.ZipFile(out).namelist())
    for p in cl.library_files(LIB):
        assert "library/" + p in names
    assert "library/tools/check_library.py" in names
