# AMBER byte-format fixtures

Seven minimal files from a three-atom water smoke calculation with AmberTools 26.
These are parser test inputs, not engine binaries, a force-field distribution,
private study data or proof of a scientifically accepted workflow. The trajectory
has five frames; no receptor, ligand campaign or user topology is included.

NetCDF, coordinates and topology bytes are retained exactly for independent decoder
regression. The working-directory header in `md.mdout` and `min.mdout` is replaced
with `/fixture/amber-water`; numerical results are unchanged. Tests deliberately
create malformed/truncated variants in temporary directories.

The repository author generated these small test outputs. They are distributed
under the repository's MIT license; AMBER/AmberTools themselves are not included.
