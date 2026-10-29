"""EigenGrid Chemistry CLI entry point.

Usage:
    python -m eigengrid_chem parse gaussian <path> [--json]
    python -m eigengrid_chem parse orca <path> [--json]
    python -m eigengrid_chem parse xtb <path> [--json]
    python -m eigengrid_chem amber-inspect <kind> <path> [--json]
    python -m eigengrid_chem amber-parse-minimization <mdout> [--json]
    python -m eigengrid_chem generate <recipe> --params '{}' [--json]
    python -m eigengrid_chem conformers <smiles> <n> [--json]
    python -m eigengrid_chem --version
"""

import argparse
import json

from . import __version__
from .amber.inspection import inspect_amber_artifact, parse_amber_minimization_mdout
from .parsers import get_parser, list_parsers


def main() -> None:
    parser = argparse.ArgumentParser(
        prog="eigengrid_chem",
        description="EigenGrid computational chemistry toolchain",
    )
    parser.add_argument("--version", action="store_true", help="Show version")

    sub = parser.add_subparsers(dest="command")

    # -- parse ----------------------------------------------
    parse_p = sub.add_parser("parse", help="Parse a computational chemistry output file")
    parse_p.add_argument("software", choices=list_parsers() + ["cp2k"], help="Software engine")
    parse_p.add_argument("output_path", type=str, help="Path to the output file")
    parse_p.add_argument("--json", action="store_true", help="Output raw JSON (pipeline mode)")

    # -- list-parsers ---------------------------------------
    list_p = sub.add_parser("list-parsers", help="List available parsers")
    list_p.add_argument("--json", action="store_true", help="Output JSON array")

    # These commands are explicit protocol endpoints even while the
    # optional scientific implementations remain deferred. Returning a
    # structured error keeps the TypeScript bridge honest and machine-safe.
    generate_p = sub.add_parser("generate", help="Generate an input file (optional feature)")
    generate_p.add_argument("recipe", type=str, help="Generator recipe identifier")
    generate_p.add_argument(
        "--params", required=True, type=str, help="Generator parameters as JSON"
    )
    generate_p.add_argument("--json", action="store_true", help="Output raw JSON")

    conformers_p = sub.add_parser(
        "conformers", help="Generate molecular conformers (optional feature)"
    )
    conformers_p.add_argument("smiles", type=str, help="Input molecule as SMILES")
    conformers_p.add_argument("n", type=int, help="Requested conformer count")
    conformers_p.add_argument("--json", action="store_true", help="Output raw JSON")

    amber_inspect_p = sub.add_parser(
        "amber-inspect",
        help="Decode a bounded AMBER artifact from its actual bytes",
    )
    amber_inspect_p.add_argument("artifact_kind", choices=["prmtop", "restart", "trajectory"])
    amber_inspect_p.add_argument("artifact_path", type=str)
    amber_inspect_p.add_argument(
        "--metadata-only",
        action="store_true",
        help="Observe digest/size only; do not claim a decoded result",
    )
    amber_inspect_p.add_argument("--json", action="store_true", help="Output raw JSON")

    amber_minimize_p = sub.add_parser(
        "amber-parse-minimization",
        help="Parse AMBER minimization ENERGY/RMS/GMAX tables",
    )
    amber_minimize_p.add_argument("mdout_path", type=str)
    amber_minimize_p.add_argument("--json", action="store_true", help="Output raw JSON")

    args = parser.parse_args()

    if args.version:
        print(f"eigengrid-chem {__version__}")
        return

    if args.command == "list-parsers":
        available = list_parsers()
        if args.json:
            print(json.dumps(available))
        else:
            for name in available:
                print(f"  {name}")
        return

    if args.command == "parse":
        parser_func = get_parser(args.software)

        if parser_func is None:
            result = {
                "ok": False,
                "parser": args.software,
                "status": "unknown",
                "error": {
                    "code": "PARSER_NOT_FOUND",
                    "message": f"No parser registered for '{args.software}'",
                    "hint": f"Available parsers: {', '.join(list_parsers())}",
                },
            }
        else:
            try:
                result = parser_func(args.output_path)
            except Exception as exc:
                result = {
                    "ok": False,
                    "parser": args.software,
                    "status": "failed",
                    "error": {
                        "code": "PARSER_CRASHED",
                        "message": str(exc),
                        "hint": "Check the parser implementation or file format.",
                    },
                }

        if args.json:
            print(json.dumps(result))
        else:
            print(json.dumps(result, indent=2))
        return

    if args.command == "generate":
        try:
            json.loads(args.params)
        except json.JSONDecodeError as exc:
            result = {
                "ok": False,
                "error": {
                    "code": "INVALID_PARAMS",
                    "message": f"Generator parameters are not valid JSON: {exc}",
                    "hint": "Pass an object through --params, for example --params '{}'",
                },
            }
        else:
            result = {
                "ok": False,
                "error": {
                    "code": "FEATURE_UNAVAILABLE",
                    "message": (
                        f"Input generator '{args.recipe}' is not implemented in this release"
                    ),
                    "hint": (
                        "Use a registered recipe command; chemistry input generators are deferred."
                    ),
                },
            }
        print(json.dumps(result) if args.json else json.dumps(result, indent=2))
        return

    if args.command == "conformers":
        if args.n <= 0:
            result = {
                "ok": False,
                "error": {
                    "code": "INVALID_COUNT",
                    "message": "Conformer count must be greater than zero",
                },
            }
        else:
            result = {
                "ok": False,
                "error": {
                    "code": "FEATURE_UNAVAILABLE",
                    "message": "Conformer generation is not implemented in this release",
                    "hint": (
                        "Install the optional chemistry toolchain when this feature is enabled."
                    ),
                },
            }
        print(json.dumps(result) if args.json else json.dumps(result, indent=2))
        return

    if args.command == "amber-inspect":
        result = inspect_amber_artifact(
            args.artifact_path,
            args.artifact_kind,
            metadata_only=args.metadata_only,
        )
        print(json.dumps(result) if args.json else json.dumps(result, indent=2))
        return

    if args.command == "amber-parse-minimization":
        result = parse_amber_minimization_mdout(args.mdout_path)
        print(json.dumps(result) if args.json else json.dumps(result, indent=2))
        return

    parser.print_help()


if __name__ == "__main__":
    main()
