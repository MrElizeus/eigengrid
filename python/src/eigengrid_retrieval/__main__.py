"""Bounded JSONL worker. It reads pinned local artifacts and never downloads a model."""

from __future__ import annotations

import hashlib
import importlib.metadata
import json
import sys
from pathlib import Path

MAX_LINE_BYTES = 1024 * 1024


def artifact(base: Path, specification: dict) -> Path:
    path = (base / specification["path"]).resolve()
    if not path.is_relative_to(base.resolve()) or not path.is_file():
        raise ValueError("Model artifacts must be regular files within the manifest directory")
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    if digest.hexdigest() != specification["sha256"]:
        raise ValueError("Model artifact integrity check failed")
    return path


def load_manifest(path: Path, expected_digest: str) -> dict:
    if path.stat().st_size > 65536:
        raise ValueError("Embedding manifest exceeds limits")
    manifest = json.loads(path.read_text(encoding="utf-8"))
    canonical = json.dumps(manifest, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    if hashlib.sha256(canonical.encode()).hexdigest() != expected_digest:
        raise ValueError("Embedding configuration changed")
    if manifest["schema"] != "eigengrid.local-embedding/v1":
        raise ValueError("Unsupported embedding manifest")
    if manifest["pooling"] != "attention_mean_l2" or not 16 <= manifest["maxTokens"] <= 512:
        raise ValueError("Unsupported pooling or token limit")
    for package in ("onnxruntime", "tokenizers", "numpy"):
        if importlib.metadata.version(package) != manifest["runtime"][package]:
            raise ValueError("Embedding runtime does not match the pinned configuration")
    return manifest


def validate_request(value: object) -> dict:
    if not isinstance(value, dict) or set(value) != {"id", "purpose", "texts"}:
        raise ValueError("Invalid embedding request")
    if type(value["id"]) is not int or value["purpose"] not in ("query", "passage"):
        raise ValueError("Invalid embedding request identity or purpose")
    texts = value["texts"]
    if not isinstance(texts, list) or not 1 <= len(texts) <= 64:
        raise ValueError("Embedding batch exceeds limits")
    if any(not isinstance(text, str) or len(text) > 8000 for text in texts):
        raise ValueError("Embedding text exceeds limits")
    return value


class LocalEmbedder:
    def __init__(self, path: Path, manifest: dict):
        # Optional dependencies are imported only when this worker is explicitly launched.
        import numpy as np
        import onnxruntime as ort
        from tokenizers import Tokenizer

        self.np = np
        self.manifest = manifest
        model = artifact(path.parent, manifest["files"]["model"])
        tokenizer_path = artifact(path.parent, manifest["files"]["tokenizer"])
        self.tokenizer = Tokenizer.from_file(str(tokenizer_path))
        self.tokenizer.enable_truncation(max_length=manifest["maxTokens"])
        self.tokenizer.enable_padding(pad_id=self.tokenizer.token_to_id("<pad>") or 0)
        options = ort.SessionOptions()
        options.intra_op_num_threads = manifest["runtime"]["threads"]
        options.inter_op_num_threads = 1
        self.session = ort.InferenceSession(
            str(model), sess_options=options, providers=["CPUExecutionProvider"]
        )
        self.inputs = {item.name for item in self.session.get_inputs()}
        if not self.inputs.issubset({"input_ids", "attention_mask", "token_type_ids"}):
            raise ValueError("Unsupported model inputs")

    def embed(self, texts: list[str], purpose: str) -> list[list[float]]:
        np = self.np
        prefix = self.manifest["queryPrefix" if purpose == "query" else "passagePrefix"]
        encoded = self.tokenizer.encode_batch([prefix + text for text in texts])
        ids = np.asarray([entry.ids for entry in encoded], dtype=np.int64)
        mask = np.asarray([entry.attention_mask for entry in encoded], dtype=np.int64)
        available = {"input_ids": ids, "attention_mask": mask, "token_type_ids": np.zeros_like(ids)}
        output = self.session.run(None, {name: available[name] for name in self.inputs})[0]
        if output.ndim != 3 or output.shape[:2] != ids.shape:
            raise ValueError("Expected token-level hidden states")
        vectors = (output * mask[:, :, None]).sum(axis=1) / mask.sum(axis=1)[:, None]
        norms = np.linalg.norm(vectors, axis=1, keepdims=True)
        if vectors.shape[1] != self.manifest["dimensions"] or not np.isfinite(vectors).all():
            raise ValueError("Invalid model output")
        if (norms < 1e-12).any():
            raise ValueError("Zero model output")
        return (vectors / norms).tolist()


def main() -> None:
    path = Path(sys.argv[1]).resolve()
    manifest = load_manifest(path, sys.argv[2])
    embedder = LocalEmbedder(path, manifest)
    while True:
        line = sys.stdin.buffer.readline(MAX_LINE_BYTES + 1)
        if not line:
            return
        if len(line) > MAX_LINE_BYTES or not line.endswith(b"\n"):
            raise ValueError("Embedding request exceeds limits")
        request = validate_request(json.loads(line))
        vectors = embedder.embed(request["texts"], request["purpose"])
        print(json.dumps({"id": request["id"], "vectors": vectors}, allow_nan=False), flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # Do not echo scientific text, paths or local environment into the response channel.
        print("Local embedding worker failed", file=sys.stderr)
        sys.exit(1)
