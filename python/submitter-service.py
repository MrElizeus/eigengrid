"""Install with sibling src/eigengrid_submitter in a root-owned immutable release.

Invoke /usr/bin/python3 -I -S -B <release>/submitter-service.py. Isolated Python
plus -S ignores PYTHONPATH, sitecustomize and the user's home/site packages.
The only added import root is this protected release, never the working directory.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "src"))

from eigengrid_submitter.service import main  # noqa: E402

raise SystemExit(main())
