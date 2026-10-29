import { z } from "zod";
import { sha256Canonical } from "./canonical";
import { AmberExecutableSchema, Sha256Schema, type AmberExecutable } from "./contracts";

const probeOrder = AmberExecutableSchema.options;

export const ProbeObservationSchema = z
  .object({
    executable: AmberExecutableSchema,
    available: z.boolean(),
    version: z.string().min(1).max(512).optional(),
    build: z.string().min(1).max(512).optional(),
    binarySha256: Sha256Schema.optional(),
    gpu: z.boolean().optional(),
    diagnostic: z.string().min(1).max(1024).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.available) {
      for (const field of ["version", "binarySha256"] as const) {
        if (value[field] === undefined) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: [field],
            message: `available executables require observed ${field}`,
          });
        }
      }
    }
    if (value.executable === "pmemd.cuda" && value.available && value.gpu === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["gpu"],
        message: "available pmemd.cuda requires an explicit GPU usability observation",
      });
    }
    if (value.executable !== "pmemd.cuda" && value.gpu !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["gpu"],
        message: "GPU usability is defined only for pmemd.cuda",
      });
    }
    if (
      !value.available &&
      [value.version, value.build, value.binarySha256, value.gpu].some(
        (field) => field !== undefined,
      )
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["available"],
        message: "Unavailable executables may not retain unobserved binary or GPU identity",
      });
    }
  });
export type ProbeObservation = z.infer<typeof ProbeObservationSchema>;

/**
 * The adapter never probes the host itself. A caller supplies this narrow
 * capability and remains responsible for recording any external operation.
 */
export interface CommandProbe {
  probe(executable: AmberExecutable): Promise<ProbeObservation>;
}

const AmberCapabilitiesSchema = z
  .object({
    amberToolsPreparation: z.boolean(),
    referenceMd: z.boolean(),
    optimizedCpuMd: z.boolean(),
    gpuMd: z.boolean(),
    trajectoryAnalysis: z.boolean(),
  })
  .strict();

function deriveCapabilities(observations: readonly ProbeObservation[]) {
  const available = new Set(
    observations.filter((item) => item.available).map((item) => item.executable),
  );
  const cuda = observations.find((item) => item.executable === "pmemd.cuda");
  return {
    amberToolsPreparation:
      available.has("antechamber") && available.has("parmchk2") && available.has("tleap"),
    referenceMd: available.has("sander"),
    optimizedCpuMd: available.has("pmemd"),
    gpuMd: available.has("pmemd.cuda") && cuda?.gpu === true,
    trajectoryAnalysis: available.has("cpptraj"),
  };
}

export const AmberEnvironmentManifestSchema = z
  .object({
    schemaVersion: z.literal("amber-environment/v1"),
    environmentDigest: Sha256Schema,
    observations: z.array(ProbeObservationSchema).length(probeOrder.length),
    capabilities: AmberCapabilitiesSchema,
  })
  .strict()
  .superRefine((manifest, context) => {
    for (const [index, executable] of probeOrder.entries()) {
      if (manifest.observations[index]?.executable !== executable) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["observations", index, "executable"],
          message: "Environment observations must use the canonical closed executable order",
        });
      }
    }
    if (manifest.environmentDigest !== sha256Canonical(manifest.observations)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["environmentDigest"],
        message: "Environment manifest digest does not match its exact observations",
      });
    }
    const expected = deriveCapabilities(manifest.observations);
    for (const capability of Object.keys(expected) as (keyof typeof expected)[]) {
      if (manifest.capabilities[capability] !== expected[capability]) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["capabilities", capability],
          message: "Environment capability is inconsistent with executable observations",
        });
      }
    }
  });
export type AmberEnvironmentManifest = z.infer<typeof AmberEnvironmentManifestSchema>;

export function assertAmberEnvironmentManifest(value: unknown): AmberEnvironmentManifest {
  return AmberEnvironmentManifestSchema.parse(value);
}

export async function discoverAmberEnvironment(
  probe: CommandProbe,
): Promise<AmberEnvironmentManifest> {
  const observations: ProbeObservation[] = [];
  for (const executable of probeOrder) {
    const observation = ProbeObservationSchema.parse(await probe.probe(executable));
    if (observation.executable !== executable) {
      throw new Error(
        `Probe identity mismatch: requested ${executable}, observed ${observation.executable}`,
      );
    }
    observations.push(observation);
  }

  return assertAmberEnvironmentManifest({
    schemaVersion: "amber-environment/v1",
    environmentDigest: sha256Canonical(observations),
    observations,
    capabilities: deriveCapabilities(observations),
  });
}

export function selectAmberMdEngine(
  manifestValue: AmberEnvironmentManifest,
  preference: "reference" | "cpu" | "gpu" | "best-available",
): "sander" | "pmemd" | "pmemd.cuda" {
  const manifest = assertAmberEnvironmentManifest(manifestValue);
  const capabilities = manifest.capabilities;
  if (preference === "gpu") {
    if (!capabilities.gpuMd) throw new Error("pmemd.cuda was requested but was not observed");
    return "pmemd.cuda";
  }
  if (preference === "cpu") {
    if (!capabilities.optimizedCpuMd) throw new Error("pmemd was requested but was not observed");
    return "pmemd";
  }
  if (preference === "reference") {
    if (!capabilities.referenceMd) throw new Error("sander was requested but was not observed");
    return "sander";
  }
  if (capabilities.gpuMd) return "pmemd.cuda";
  if (capabilities.optimizedCpuMd) return "pmemd";
  if (capabilities.referenceMd) return "sander";
  throw new Error("No supported AMBER MD engine was observed");
}
