import importlib.util
from pathlib import Path
from types import SimpleNamespace

spec = importlib.util.spec_from_file_location('storage_health', Path(__file__).parents[2] / 'scripts/operations/storage_health.py')
health = importlib.util.module_from_spec(spec)
spec.loader.exec_module(health)


def test_capacity_reserves_and_root_fallback(monkeypatch):
    gib = 1024**3
    monkeypatch.setattr(health.shutil, 'disk_usage', lambda _: SimpleNamespace(used=90*gib, free=10*gib))
    monkeypatch.setattr(health.os, 'stat', lambda _: SimpleNamespace(st_dev=1))
    monkeypatch.setattr(health.os.path, 'ismount', lambda _: False)
    result = health.inspect('/data', max_used_percent=85, min_free_gib=30, require_data_mount=True)
    assert set(result['errors']) == {'capacity_threshold_exceeded', 'free_space_below_reserve', 'required_mount_missing', 'data_on_root_filesystem'}


def test_healthy_data_volume(monkeypatch):
    gib = 1024**3
    monkeypatch.setattr(health.shutil, 'disk_usage', lambda _: SimpleNamespace(used=50*gib, free=50*gib))
    monkeypatch.setattr(health.os, 'stat', lambda path: SimpleNamespace(st_dev=1 if path == '/' else 2))
    monkeypatch.setattr(health.os.path, 'ismount', lambda _: True)
    assert health.inspect('/data', max_used_percent=85, min_free_gib=30, require_data_mount=True)['errors'] == []
