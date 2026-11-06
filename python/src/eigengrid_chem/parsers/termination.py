"""Ordered terminal evidence for output files that may contain multiple runs."""

from __future__ import annotations

import re
from typing import Literal


def latest_run(text: str, start_pattern: str) -> str:
    """Keep a restarted/concatenated run from inheriting an earlier run's evidence."""
    starts = list(re.finditer(start_pattern, text, re.MULTILINE))
    return text[starts[-1].start() :] if starts else text


def termination_status(
    text: str, normal_pattern: str, error_pattern: str
) -> Literal["completed", "failed", "partial"]:
    """An energy is data, not proof that the engine finished its work."""
    events = list(
        re.finditer(
            rf"(?P<normal>{normal_pattern})|(?P<error>{error_pattern})",
            text,
            re.MULTILINE,
        )
    )
    if not events:
        return "partial"
    return "completed" if events[-1].lastgroup == "normal" else "failed"
