/** Engine adapter implementing the protocol compiler's neutral renderer port. This module never invokes a motor. */
import {
  MdAdapterDescriptorVersion,
  assertMdAdapterDescriptor,
  assertMdRenderRequest,
  computeMdAdapterDescriptorDigest,
  type MdAdapterDescriptor,
  type MdControlTuple,
  type MdRenderRequest,
  type MdStageRendererPort,
} from "@eigengrid/protocol-core";
import {
  MdExecutionBindingParametersSchema,
  MdProtocolSchemaVersion,
  MdStageSchemaVersion,
  digestCanonical,
} from "@eigengrid/scientific-schema";
import { z } from "zod";
import {
  AMBER_CANONICAL_STAGE_MAPPING_VERSION,
  assertAmberCanonicalStageMappingDigest,
  renderCanonicalAmberStage,
  RenderedCanonicalAmberStageSchema,
  type RenderedCanonicalAmberStage,
} from "./canonical-stage-mapper";
import { assertAmberEnvironmentBinding } from "./environment-binding";
import { PMEMD26_CUDA_PROFILE, SANDER26_CPU_PROFILE } from "./sander26-profile";

export const Amber26PortVersion = "eigengrid.amber26-protocol-render/v1" as const;
export const Amber26PortImplementationVersion = "1.0.0" as const;

/** Closed rendering scope. Runtime qualification is a different, external evidence claim. */
export function createAmber26RendererDescriptor(environmentValue: unknown): MdAdapterDescriptor {
  const environment = assertAmberEnvironmentBinding(environmentValue);
  const engine = environment.canonicalSnapshot.engine;
  const profile = engine.executable === "sander" ? SANDER26_CPU_PROFILE : PMEMD26_CUDA_PROFILE;
  if (
    engine.engine !== "amber" ||
    engine.executable !== profile.executable ||
    engine.version !== profile.version ||
    engine.buildDigest !== profile.binarySha256 ||
    engine.compatibilityVersion !== AMBER_CANONICAL_STAGE_MAPPING_VERSION
  ) {
    throw new Error(
      "AMBER26 port requires an exact registered sander/pmemd.cuda build, not a guessed executable",
    );
  }
  const controlTuples: MdControlTuple[] = [];
  for (const systemClass of ["soluble", "membrane"] as const) {
    for (const restraints of [[], ["positional"]] as MdControlTuple["restraints"][]) {
      controlTuples.push({
        stageKind: "minimization",
        systemClass,
        ensemble: "none",
        timeStepPs: null,
        thermostat: "none",
        barostat: "none",
        pressureCoupling: "none",
        bondsToHydrogen: false,
        restraints,
        electrostatics: "pme",
        seedPolicy: null,
      });
      for (const stageKind of ["heating", "equilibration", "production"] as const) {
        for (const timeStepPs of [0.001, 0.002]) {
          for (const bondsToHydrogen of [false, true]) {
            if (timeStepPs > 0.001 && !bondsToHydrogen) continue;
            const seedPolicies =
              stageKind === "production"
                ? (["replica_segment"] as const)
                : (["fixed", "derived"] as const);
            for (const seedPolicy of seedPolicies) {
              const common = {
                stageKind,
                systemClass,
                timeStepPs,
                bondsToHydrogen,
                restraints,
                electrostatics: "pme" as const,
                seedPolicy,
              };
              controlTuples.push({
                ...common,
                ensemble: "nvt",
                thermostat: "langevin",
                barostat: "none",
                pressureCoupling: "none",
              });
              if (stageKind !== "heating") {
                controlTuples.push({
                  ...common,
                  ensemble: "nve",
                  thermostat: "none",
                  barostat: "none",
                  pressureCoupling: "none",
                });
                controlTuples.push({
                  ...common,
                  ensemble: "npt",
                  thermostat: "langevin",
                  barostat: systemClass === "membrane" ? "berendsen" : "monte_carlo",
                  pressureCoupling: systemClass === "membrane" ? "semiisotropic" : "isotropic",
                });
              }
            }
          }
        }
      }
    }
  }
  const unsigned = {
    schemaVersion: MdAdapterDescriptorVersion,
    adapterId: "amber26.canonical-md",
    adapterVersion: Amber26PortImplementationVersion,
    engine,
    protocolSchemaVersion: MdProtocolSchemaVersion,
    stageSchemaVersion: MdStageSchemaVersion,
    rendererCompatibilityVersions: [AMBER_CANONICAL_STAGE_MAPPING_VERSION],
    controlTuples,
    maximumAtomCount: 1_000_000,
  };
  return assertMdAdapterDescriptor({
    ...unsigned,
    descriptorDigest: computeMdAdapterDescriptorDigest(unsigned),
  });
}

const PortOutputSchema = z
  .object({
    schemaVersion: z.literal(Amber26PortVersion),
    qualification: z.literal("render_only_not_authorized"),
    renderRequest: z.unknown(),
    rendered: RenderedCanonicalAmberStageSchema,
    outputDigest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export interface Amber26PortOutput {
  schemaVersion: typeof Amber26PortVersion;
  qualification: "render_only_not_authorized";
  renderRequest: MdRenderRequest;
  rendered: RenderedCanonicalAmberStage;
  outputDigest: string;
}

/**
 * A renderer instance binds ONE reviewed stage mapping and WorkUnit parameters.
 * No runtime re-selection, paths, credentials or engine arguments can be injected by the native agent.
 * mission runtime must independently validate authority freshness, byte provenance and site capacity.
 */
export function createAmber26ProtocolRenderer(
  mappingValue: unknown,
  bindingValue: unknown,
): MdStageRendererPort<Amber26PortOutput> {
  const mapping = assertAmberCanonicalStageMappingDigest(mappingValue);
  const binding = MdExecutionBindingParametersSchema.parse(bindingValue);
  const descriptor = createAmber26RendererDescriptor(mapping.environment);
  const render = (input: Readonly<MdRenderRequest>): Amber26PortOutput => {
    const request = assertMdRenderRequest(input, descriptor);
    const { stage, system } = request;
    if (
      stage.resourceProfile.gpuCount !== (descriptor.engine.executable === "pmemd.cuda" ? 1 : 0)
    ) {
      throw new Error("AMBER26 port admits exactly one GPU or the registered CPU profile");
    }
    if (Math.min(...system.box.lengthsAngstrom) <= 2 * stage.nonbonded.cutoffAngstrom) {
      throw new Error("Periodic cell must exceed twice the nonbonded cutoff");
    }
    if (
      system.membrane !== null &&
      (system.box.shape !== "orthorhombic" ||
        system.box.anglesDegrees.some((a) => Math.abs(a - 90) > 1e-6) ||
        system.membrane.normalVector.some((v, i) => Math.abs(v - (i === 2 ? 1 : 0)) > 1e-6))
    ) {
      throw new Error("AMBER26 membrane requires an orthorhombic cell with the declared +Z normal");
    }
    if (
      mapping.membranePressure &&
      (mapping.membranePressure.surfaceTensionDynCm !== 0 ||
        mapping.membranePressure.targetPressureBar !== 1 ||
        mapping.membranePressure.pressureRelaxationPs !== 1)
    ) {
      throw new Error(
        "This AMBER26 membrane profile requires the reviewed zero-tension 1 bar/taup 1 ps tuple",
      );
    }
    const rendered = renderCanonicalAmberStage(stage, mapping, binding, request.atomMap);
    const material = {
      schemaVersion: Amber26PortVersion,
      qualification: "render_only_not_authorized" as const,
      renderRequest: request,
      rendered,
    };
    return { ...material, outputDigest: digestCanonical(material) };
  };
  return {
    // Return a copy: a consumer cannot expand this instance's private capability set.
    get descriptor() {
      return structuredClone(descriptor);
    },
    render,
    parseOutput(value: unknown): Amber26PortOutput {
      const output = PortOutputSchema.parse(value);
      const rebuilt = render(assertMdRenderRequest(output.renderRequest, descriptor));
      if (
        output.outputDigest !== rebuilt.outputDigest ||
        digestCanonical(output) !== digestCanonical(rebuilt)
      ) {
        throw new Error("AMBER26 output differs from the independently rebuilt stage render");
      }
      return rebuilt;
    },
  };
}

/** Capability claims are deliberately separated; rendering is not a build/install/E2E test. */
export function amber26CodeCapabilityMatrix(environmentValue: unknown) {
  const descriptor = createAmber26RendererDescriptor(environmentValue);
  return {
    schemaVersion: "eigengrid.amber26-code-capability-matrix/v1" as const,
    descriptor,
    implementationVersion: Amber26PortImplementationVersion,
    renderable: true,
    commandContractImplemented: true,
    executable: false, // dispatch remains a mission runtime host capability, not an adapter effect
    installed: "not_observed_by_this_library" as const,
    siteQualified: false,
    scientificallyValidated: false,
    limitations: [
      "No HMR/4 fs",
      "No unsupported engine build or pressure tuple",
      "NVE fixed-cell continuation only",
      "Berendsen is not an exact NPT fluctuation ensemble",
      "No automatic scientific approval or dispatch",
    ],
  };
}
