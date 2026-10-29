"""Parser registry and base parser interface."""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any, Callable

from .cp2k import parse_cp2k
from .gaussian import parse_gaussian
from .orca import parse_orca
from .xtb import parse_xtb


class BaseParser(ABC):
    """Abstract base for all quantum chemistry parsers."""

    @abstractmethod
    def parse(self, path: str) -> dict[str, Any]: ...


# -- Parser Registry ------------------------------------------

ParserFunc = Callable[[str], dict[str, Any]]

PARSER_REGISTRY: dict[str, ParserFunc] = {}


def register_parser(name: str, func: ParserFunc) -> None:
    """Register a parser function by software name."""
    PARSER_REGISTRY[name] = func


def get_parser(name: str) -> ParserFunc | None:
    """Look up a parser function by software name."""
    return PARSER_REGISTRY.get(name)


def list_parsers() -> list[str]:
    """Return sorted list of registered parser names."""
    return sorted(PARSER_REGISTRY.keys())


# -- Auto-register built-in parsers ---------------------------
register_parser("cp2k", parse_cp2k)
register_parser("gaussian", parse_gaussian)
register_parser("orca", parse_orca)
register_parser("xtb", parse_xtb)
