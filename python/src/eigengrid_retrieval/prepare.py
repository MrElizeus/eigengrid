"""Explicit provisioning of the example embedding model; never called by retrieval."""

import argparse
import json
import os
import tempfile
import urllib.request
from pathlib import Path

from .__main__ import artifact

MODEL = "Xenova/multilingual-e5-small"
REVISION = "761b726dd34fb83930e26aab4e9ac3899aa1fa78"
REMOTE_FILES = {"model": "onnx/model_quantized.onnx", "tokenizer": "tokenizer.json"}


def prepare(path: Path, download: bool) -> None:
    manifest = json.loads(path.read_text(encoding="utf-8"))
    if manifest["model"] != MODEL or manifest["revision"] != REVISION:
        raise ValueError("This provisioner only supports the pinned example model")
    base = path.resolve().parent
    for key, remote in REMOTE_FILES.items():
        specification = manifest["files"][key]
        destination = (base / specification["path"]).resolve()
        if not destination.is_relative_to(base):
            raise ValueError("Artifact path escapes the manifest directory")
        if destination.exists() or not download:
            artifact(base, specification)
            continue
        destination.parent.mkdir(parents=True, exist_ok=True)
        fd, temporary = tempfile.mkstemp(prefix=".embedding-", dir=destination.parent)
        temporary = Path(temporary)
        try:
            with os.fdopen(fd, "wb") as output:
                with urllib.request.urlopen(
                    f"https://huggingface.co/{MODEL}/resolve/{REVISION}/{remote}", timeout=60
                ) as response:
                    size = 0
                    while block := response.read(1024 * 1024):
                        size += len(block)
                        if size > 300 * 1024 * 1024:
                            raise ValueError("Model download exceeds limits")
                        output.write(block)
            artifact(temporary.parent, {"path": temporary.name, "sha256": specification["sha256"]})
            temporary.replace(destination)
        finally:
            temporary.unlink(missing_ok=True)
    print("Pinned local embedding artifacts verified")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest", type=Path)
    parser.add_argument("--download", action="store_true", help="Explicitly allow model downloads")
    args = parser.parse_args()
    prepare(args.manifest, args.download)


if __name__ == "__main__":
    main()
