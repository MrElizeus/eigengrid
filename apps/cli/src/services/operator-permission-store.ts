import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { permissionPreset, type PermissionPresetId } from "@eigengrid/agent/execution-permissions";

export interface OperatorPermissionSettings {
  readonly schema: "eigengrid.operator-permissions/v1";
  readonly workspace: string;
  readonly preset: PermissionPresetId;
  readonly revision: string;
}

export function operatorPermissionPath(workspace = process.cwd()): string {
  const root =
    process.env.EIGENGRID_PERMISSIONS_DIR ??
    join(
      process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"),
      "eigengrid",
      "permissions",
    );
  return join(root, `${createHash("sha256").update(realpathSync(workspace)).digest("hex")}.json`);
}

export function loadOperatorPermissions(workspace = process.cwd()): OperatorPermissionSettings {
  const canonical = realpathSync(workspace);
  const path = operatorPermissionPath(canonical);
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return {
        schema: "eigengrid.operator-permissions/v1",
        workspace: canonical,
        preset: "ask",
        revision: "initial",
      };
    throw new Error("Could not read private operator permissions");
  }
  try {
    const directory = lstatSync(dirname(path));
    if (
      !directory.isDirectory() ||
      (directory.mode & 0o077) !== 0 ||
      (process.getuid && directory.uid !== process.getuid())
    )
      throw new Error("Operator permissions directory must be private and user-owned");
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.size > 4096 ||
      (stat.mode & 0o077) !== 0 ||
      (process.getuid && stat.uid !== process.getuid())
    )
      throw new Error("Operator permissions must be a private user-owned file");
    const value = JSON.parse(readFileSync(fd, "utf8"));
    if (
      Object.keys(value).sort().join(",") !== "preset,revision,schema,workspace" ||
      value.schema !== "eigengrid.operator-permissions/v1" ||
      value.workspace !== canonical ||
      typeof value.revision !== "string" ||
      !/^[a-f0-9-]{36}$/.test(value.revision)
    )
      throw new Error("Invalid operator permissions; open /permissions to select a preset");
    permissionPreset(value.preset);
    return Object.freeze(value);
  } finally {
    closeSync(fd);
  }
}

export function saveOperatorPermissions(
  preset: PermissionPresetId,
  workspace = process.cwd(),
): OperatorPermissionSettings {
  permissionPreset(preset);
  const canonical = realpathSync(workspace);
  const path = operatorPermissionPath(canonical);
  const root = dirname(path);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const stat = lstatSync(root);
  if (
    !stat.isDirectory() ||
    (stat.mode & 0o077) !== 0 ||
    (process.getuid && stat.uid !== process.getuid())
  )
    throw new Error("Operator permissions directory must be private and user-owned");
  const settings: OperatorPermissionSettings = {
    schema: "eigengrid.operator-permissions/v1",
    workspace: canonical,
    preset,
    revision: randomUUID(),
  };
  const temporary = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(fd, JSON.stringify(settings) + "\n");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(temporary, path);
  } finally {
    try {
      unlinkSync(temporary);
    } catch {
      /* rename consumed the temporary */
    }
  }
  return settings;
}
