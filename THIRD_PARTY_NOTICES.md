# Third-party components

EigenGrid source is MIT licensed; dependency licenses remain their respective licenses.
`bun.lock` fixes JavaScript dependencies. `python/requirements-linux-x64-py313.lock`
fixes Python build/test/runtime dependencies with archive hashes. The component inventory
and copied license texts are generated into `notices/` from those installed packages.
Bun embeds JavaScriptCore and other upstream components; its distribution terms apply to
compiled executables. The pinned upstream license and linked-library notice is retained in
`notices/bun@1.3.14`, including its source identity. Its JavaScriptCore/WebKit and
other library terms remain applicable to native distributions. EigenGrid source and
locked build instructions are supplied so the application can be rebuilt with the
corresponding runtime; the MIT license on EigenGrid does not relicense that runtime.

AMBER/AmberTools, pmemd.cuda, Gaussian, ORCA, CP2K, xTB, Slurm and model providers are
external integrations. No license to those programs, model weights or services is granted
by EigenGrid. No proprietary engine binary or force-field library is bundled.
The public catalog is explicitly allowlisted in `publication.json`. Study-specific
protocol definitions and private research implementations are excluded.

`tests/fixtures/amber` contains seven minimal, author-generated three-atom water outputs
for independent byte-decoder regressions. Its README documents the sanitized headers.
Other parser fixtures are compact test data; contract fixtures are synthetic and do not
establish engine or scientific qualification. Scientific knowledge references identify
external publications and manuals without redistributing their full text.

## Optional scientific retrieval runtime

The CPU embedding worker can be provisioned separately using
`python/requirements-retrieval-linux-x64-py313.lock`. Those optional dependencies and
model weights are not included in the native release. The example configuration pins
the [Xenova ONNX conversion](https://huggingface.co/Xenova/multilingual-e5-small) of
[multilingual E5 small](https://huggingface.co/intfloat/multilingual-e5-small), whose
upstream model card declares the MIT license. Preserve upstream notices when distributing
separately downloaded artifacts. See [retrieval setup](docs/scientific-retrieval.md).
