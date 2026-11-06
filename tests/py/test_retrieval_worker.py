"""Contract tests use synthetic text only, without optional inference dependencies."""

import hashlib
import json

import pytest
from eigengrid_retrieval.__main__ import artifact, load_manifest, validate_request


def test_artifact_hash_and_directory_boundary(tmp_path):
    path = tmp_path / "weights.bin"
    path.write_bytes(b"synthetic fixture, not model weights")
    specification = {
        "path": path.name,
        "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
    }
    assert artifact(tmp_path, specification) == path
    path.write_bytes(b"changed")
    with pytest.raises(ValueError, match="integrity"):
        artifact(tmp_path, specification)
    with pytest.raises(ValueError, match="within"):
        artifact(tmp_path, {"path": "../not-authorized", "sha256": "0" * 64})


@pytest.mark.parametrize(
    "value",
    [
        None,
        {},
        {"id": True, "purpose": "query", "texts": ["example"]},
        {"id": 1, "purpose": "shell", "texts": ["example"]},
        {"id": 1, "purpose": "query", "texts": []},
        {"id": 1, "purpose": "query", "texts": ["x" * 8001]},
        {"id": 1, "purpose": "query", "texts": ["example"] * 65},
        {"id": 1, "purpose": "query", "texts": [1]},
    ],
)
def test_rejects_invalid_embedding_requests(value):
    with pytest.raises(ValueError):
        validate_request(value)


def test_accepts_a_bounded_scientific_query():
    request = {
        "id": 7,
        "purpose": "query",
        "texts": ["¿Cómo verifico una corriente anular?"],
    }
    assert validate_request(request) == request


def test_manifest_identity_and_runtime_are_pinned(tmp_path, monkeypatch):
    monkeypatch.setattr("importlib.metadata.version", lambda package: "1.0.0")
    manifest = {
        "schema": "eigengrid.local-embedding/v1",
        "pooling": "attention_mean_l2",
        "maxTokens": 512,
        "runtime": {
            package: "1.0.0" for package in ("onnxruntime", "tokenizers", "numpy")
        },
    }
    path = tmp_path / "manifest.json"
    path.write_text(json.dumps(manifest))
    digest = hashlib.sha256(
        json.dumps(
            manifest, sort_keys=True, ensure_ascii=False, separators=(",", ":")
        ).encode()
    ).hexdigest()
    assert load_manifest(path, digest) == manifest
    with pytest.raises(ValueError, match="changed"):
        load_manifest(path, "0" * 64)
    monkeypatch.setattr("importlib.metadata.version", lambda package: "2.0.0")
    with pytest.raises(ValueError, match="runtime"):
        load_manifest(path, digest)
