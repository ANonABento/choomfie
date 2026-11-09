import os
import sys

import pytest

trimesh = pytest.importorskip("trimesh")
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import mesh_check  # noqa: E402


def test_good_stl(tmp_path):
    f = tmp_path / "good.stl"
    trimesh.creation.box((10, 10, 10)).export(f)
    assert mesh_check.main([str(f)]) == 0


def test_broken_stl(tmp_path, capsys):
    box = trimesh.creation.box((10, 10, 10))
    box.update_faces(list(range(len(box.faces) - 2)))  # open: drop one side
    floater = trimesh.creation.box((2, 2, 2))
    floater.apply_translation((20, 0, 5))
    f = tmp_path / "broken.stl"
    trimesh.util.concatenate([box, floater]).export(f)
    assert mesh_check.main([str(f)]) == 1
    out = capsys.readouterr().out
    assert "not watertight" in out and "separate bodies" in out


def test_thin_wall_threshold(tmp_path):
    f = tmp_path / "plate.stl"
    trimesh.creation.box((10, 10, 0.5)).export(f)
    assert mesh_check.main([str(f)]) == 1
    assert mesh_check.main([str(f), "--min-wall", "0.4"]) == 0
