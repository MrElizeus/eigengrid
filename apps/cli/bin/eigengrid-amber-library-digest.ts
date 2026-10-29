#!/usr/bin/env bun
import { computeProtectedAmberLibraryTreeDigest } from "../src/services/amber-library-tree";
import { EIGENGRID_VERSION } from "../src/version";

if (process.argv.length === 3 && ["--help", "--version"].includes(process.argv[2]!)) {
  process.stdout.write(
    process.argv[2] === "--version"
      ? `${EIGENGRID_VERSION}\n`
      : "Usage: eigengrid-amber-library-digest ABSOLUTE_LIB_DIRECTORY\nHash a protected AMBER library tree; does not execute an engine.\n",
  );
  process.exit(0);
}

if (process.argv.length !== 3) {
  process.stderr.write("Usage: eigengrid-amber-library-digest ABSOLUTE_LIB_DIRECTORY\n");
  process.exit(64);
}

try {
  process.stdout.write(`${await computeProtectedAmberLibraryTreeDigest(process.argv[2]!)}\n`);
} catch {
  process.stderr.write("Amber library tree is not protected or could not be hashed\n");
  process.exitCode = 74;
}
