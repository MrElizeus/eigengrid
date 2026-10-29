import {
  MdStageOperationRequestSchema,
  MdStageOperationRequestSchemaVersion,
  type MdStageOperationRequest,
} from "@eigengrid/scientific-schema";
import { sha256Canonical } from "./canonical";
import {
  assertRenderedCanonicalAmberStageDigest,
  mapAmberStageCommandOutputRoles,
  type RenderedCanonicalAmberStage,
} from "./canonical-stage-mapper";
import { commandRequestDigest } from "./contracts";
import { assertAmberEnvironmentBinding, type AmberEnvironmentBinding } from "./environment-binding";

export interface AmberMdStageWorkUnitAuthority {
  workUnitId: string;
  bindingDigest: string;
  outputContractDigest: string;
}

function exactEngineIdentity(binding: AmberEnvironmentBinding) {
  const observation = binding.adapterEnvironment.observations.find(
    (candidate) => candidate.executable === binding.executable,
  );
  if (
    observation?.available !== true ||
    observation.version === undefined ||
    observation.binarySha256 === undefined
  ) {
    throw new Error("Authorized AMBER stage executable lacks an exact observed binary identity");
  }
  const engine = binding.canonicalSnapshot.engine;
  if (
    engine.executable !== binding.executable ||
    engine.version !== observation.version ||
    engine.buildDigest !== observation.binarySha256 ||
    engine.environmentDigest !== binding.adapterEnvironment.environmentDigest
  ) {
    throw new Error("Authorized AMBER stage engine identity drifted from its environment binding");
  }
  return { engine, binaryDigest: observation.binarySha256 };
}

function exactOutputBindings(rendered: RenderedCanonicalAmberStage) {
  const derivedMapping = mapAmberStageCommandOutputRoles(rendered.commandRequest);
  if (sha256Canonical(derivedMapping) !== sha256Canonical(rendered.outputRoleMapping)) {
    throw new Error("Rendered AMBER output-role mapping is not derived from its exact command");
  }
  return rendered.outputRoleMapping.bindings.map((binding) => {
    const output = rendered.commandRequest.outputs.find(
      (candidate) => candidate.role === binding.engineRole,
    );
    if (output === undefined) {
      throw new Error(`Rendered AMBER command lacks output role ${binding.engineRole}`);
    }
    const canonicalOutput = rendered.runtimeBindings.outputs.find(
      (candidate) => candidate.role === binding.canonicalRole,
    );
    if (canonicalOutput !== undefined && canonicalOutput.mediaType !== output.mediaType) {
      throw new Error(
        `Rendered AMBER output ${binding.canonicalRole} differs from its canonical media type`,
      );
    }
    return {
      engineRole: binding.engineRole,
      canonicalRole: binding.canonicalRole,
      mediaType: output.mediaType,
      required: canonicalOutput?.required ?? false,
    };
  });
}

/**
 * Derives the only operation request that may authorize this exact render. The
 * command is validated by the render assertion and is represented here solely by
 * its digest; argv and logical paths never enter the operation schema.
 */
export function createAmberMdStageOperationRequest(
  renderedValue: unknown,
  environmentBindingValue: unknown,
  authority: AmberMdStageWorkUnitAuthority,
): MdStageOperationRequest {
  const rendered = assertRenderedCanonicalAmberStageDigest(renderedValue);
  const environmentBinding = assertAmberEnvironmentBinding(environmentBindingValue);
  if (rendered.executionBindingDigest !== authority.bindingDigest) {
    throw new Error("Rendered AMBER stage does not bind the exact WorkUnit execution parameters");
  }
  if (rendered.environmentBindingDigest !== environmentBinding.bindingDigest) {
    throw new Error("Rendered AMBER stage belongs to another environment binding");
  }
  if (rendered.commandRequest.executable !== environmentBinding.executable) {
    throw new Error("Rendered AMBER command executable differs from its environment binding");
  }
  const mdinInput = rendered.commandRequest.inputs.find(
    (candidate) => candidate.role === "stage.mdin",
  );
  if (
    mdinInput === undefined ||
    mdinInput.sha256 !== rendered.renderedMdin.sha256 ||
    mdinInput.logicalPath !== rendered.renderedMdin.logicalPath
  ) {
    throw new Error("Rendered AMBER mdin is not the exact validated command input");
  }
  const { engine, binaryDigest } = exactEngineIdentity(environmentBinding);
  return MdStageOperationRequestSchema.parse({
    schemaVersion: MdStageOperationRequestSchemaVersion,
    workUnitId: authority.workUnitId,
    bindingDigest: authority.bindingDigest,
    outputContractDigest: authority.outputContractDigest,
    stage: {
      id: rendered.canonicalStage.id,
      revision: rendered.canonicalStage.revision,
      digest: rendered.canonicalStage.stageDigest,
      kind: rendered.canonicalStage.kind,
    },
    environment: {
      canonicalSnapshotId: environmentBinding.canonicalSnapshot.id,
      canonicalSnapshotDigest: environmentBinding.canonicalSnapshot.environmentDigest,
      engineEnvironmentDigest: environmentBinding.adapterEnvironment.environmentDigest,
      bindingVersion: environmentBinding.bindingVersion,
      bindingDigest: environmentBinding.bindingDigest,
      engine,
      binaryDigest,
    },
    render: {
      schemaVersion: rendered.schemaVersion,
      renderedStageDigest: rendered.renderDigest,
      mapperVersion: rendered.mapping.version,
      mapperDigest: rendered.mapping.digest,
      mdinDigest: rendered.renderedMdin.sha256,
      commandRequestDigest: commandRequestDigest(rendered.commandRequest),
    },
    outputs: {
      mappingVersion: rendered.outputRoleMapping.version,
      mappingDigest: rendered.outputRoleMapping.digest,
      bindings: exactOutputBindings(rendered),
    },
  });
}

/** Verifies a supplied request by deriving the expected request again from trusted inputs. */
export function assertAmberMdStageOperationRequest(
  requestValue: unknown,
  renderedValue: unknown,
  environmentBindingValue: unknown,
  authority: AmberMdStageWorkUnitAuthority,
): MdStageOperationRequest {
  const request = MdStageOperationRequestSchema.parse(requestValue);
  const expected = createAmberMdStageOperationRequest(
    renderedValue,
    environmentBindingValue,
    authority,
  );
  if (sha256Canonical(request) !== sha256Canonical(expected)) {
    throw new Error("AMBER stage operation request does not match its exact verified render");
  }
  return request;
}
