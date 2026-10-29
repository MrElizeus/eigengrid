import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBackup, inspectBackup, restoreBackup, verifyBackup } from "@eigengrid/backup";
import { createDatabase, type DatabaseLike } from "@eigengrid/db";
import { ContentAddressedArtifactStore } from "@eigengrid/mission-runtime";
import { EvidenceReferenceSchema } from "@eigengrid/scientific-schema";
import { Database } from "bun:sqlite";
import * as tar from "tar";

const NOW = "2026-08-23T00:00:00.000Z";
const digest = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");

function insert(
  database: Database,
  table: string,
  row: Readonly<Record<string, string | number | null>>,
): void {
  const columns = Object.keys(row);
  database
    .query(
      `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
    )
    .run(...Object.values(row));
}

async function regularFiles(directory: string): Promise<string[]> {
  return (await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: directory })))
    .filter((path) => statSync(join(directory, path)).isFile())
    .sort();
}

async function repackWithChecksums(
  root: string,
  original: string,
  label: string,
  mutate: (directory: string) => void | Promise<void>,
): Promise<string> {
  const extracted = join(root, `repack-${label}`);
  mkdirSync(extracted);
  await tar.extract({ file: original, cwd: extracted, portable: true });
  await mutate(extracted);
  const paths = (await regularFiles(extracted)).filter((path) => path !== "checksums.sha256");
  writeFileSync(
    join(extracted, "checksums.sha256"),
    paths.map((path) => `${digest(readFileSync(join(extracted, path)))}  ${path}`).join("\n"),
  );
  const archive = join(root, `${label}.tar.gz`);
  await tar.create(
    { file: archive, cwd: extracted, gzip: true, portable: true },
    await regularFiles(extracted),
  );
  return archive;
}

async function seedScientificMdFixture(
  database: ReturnType<typeof createDatabase>,
  store: ContentAddressedArtifactStore,
): Promise<Map<string, Uint8Array>> {
  const raw = (database as unknown as { ensureDb(): Database }).ensureDb();
  const objects = new Map<string, Uint8Array>();
  const evidenceMetadata = new Map<
    string,
    { mediaType: string; kind: string; sourceId?: string }
  >();
  raw.exec("PRAGMA foreign_keys = OFF");
  for (const definition of [
    {
      id: "evidence-ff-source",
      text: "ff-source-bytes",
      kind: "artifact",
      mediaType: "application/octet-stream",
    },
    {
      id: "evidence-ff-stack",
      text: "force-field-stack-manifest",
      kind: "force_field_stack",
      mediaType: "application/vnd.eigengrid.force-field-stack+json",
      sourceId: "receipt-ff",
    },
    {
      id: "evidence-topology",
      text: "amber-prmtop-bytes",
      kind: "topology",
      mediaType: "application/vnd.amber.prmtop",
      sourceId: "receipt-system",
    },
    {
      id: "evidence-coordinates",
      text: "amber-rst7-bytes",
      kind: "coordinates",
      mediaType: "application/vnd.amber.rst7",
      sourceId: "receipt-system",
    },
    {
      id: "evidence-atom-map",
      text: "atom-map-bytes",
      kind: "atom_map",
      mediaType: "application/vnd.eigengrid.atom-map+json",
      sourceId: "receipt-system",
    },
    {
      id: "evidence-restart",
      text: "production-restart-bytes",
      kind: "restart",
      mediaType: "application/vnd.amber.rst7",
      sourceId: "receipt-stage",
    },
    {
      id: "evidence-trajectory",
      text: "production-trajectory-bytes",
      kind: "trajectory",
      mediaType: "application/x-netcdf",
      sourceId: "receipt-stage",
    },
    {
      id: "evidence-mdout",
      text: "production-mdout-bytes",
      kind: "mdout",
      mediaType: "text/plain",
      sourceId: "receipt-stage",
    },
    {
      id: "evidence-analysis",
      text: "normalized-analysis-bytes",
      kind: "analysis_result",
      mediaType: "application/json",
      sourceId: "receipt-analysis",
    },
  ] as const) {
    const evidenceId = definition.id;
    const text = definition.text;
    const bytes = new TextEncoder().encode(text);
    const stored = await store.put(bytes);
    objects.set(evidenceId, bytes);
    evidenceMetadata.set(evidenceId, definition);
    const payload = {
      id: evidenceId,
      missionId: "mission-backup-md",
      kind: definition.kind,
      uri: stored.uri,
      contentDigest: stored.digest,
      sizeBytes: stored.sizeBytes,
      mediaType: definition.mediaType,
      immutable: true,
      ...(definition.sourceId ? { sourceId: definition.sourceId } : {}),
      createdAt: NOW,
    };
    insert(raw, "scientific_evidence", {
      id: evidenceId,
      mission_id: "mission-backup-md",
      work_unit_id: null,
      kind: definition.kind === "analysis_result" ? "parser_output" : "artifact",
      uri: stored.uri,
      content_digest: stored.digest,
      immutable: 1,
      source_id: definition.sourceId ?? null,
      payload_json: JSON.stringify(payload),
      created_at: NOW,
      evidence_kind_id: definition.kind,
    });
  }

  const d = (id: string): string => digest(id);
  insert(raw, "scientific_missions", {
    id: "mission-backup-md",
    revision: 9,
    state: "observing",
    budget_id: "budget-backup-md",
    active_plan_id: "plan-backup-md",
    objective_digest: d("objective"),
    payload_digest: d("mission"),
    payload_json: JSON.stringify({ marker: "mission-v16-round-trip" }),
    created_at: NOW,
    updated_at: NOW,
    terminal_at: null,
  });
  insert(raw, "scientific_mission_budgets", {
    id: "budget-backup-md",
    mission_id: "mission-backup-md",
    revision: 1,
    limits_json: "{}",
    consumed_json: "{}",
    payload_digest: d("budget"),
    payload_json: "{}",
  });
  insert(raw, "scientific_skill_resolutions", {
    id: "skills-backup-md",
    mission_id: "mission-backup-md",
    graph_digest: d("graph"),
    resolver_version: "backup-fixture-v1",
    environment_digest: d("environment"),
    payload_json: "{}",
    resolved_at: NOW,
  });
  insert(raw, "scientific_plans", {
    id: "plan-backup-md",
    mission_id: "mission-backup-md",
    version: 1,
    revision: 1,
    status: "approved",
    skill_resolution_id: "skills-backup-md",
    skill_graph_digest: d("graph"),
    protocol_digest: d("plan-protocol"),
    plan_digest: d("plan"),
    parent_plan_id: null,
    payload_json: "{}",
    created_at: NOW,
    updated_at: NOW,
  });

  for (const [suffix, capability] of [
    ["ff", "amber.force-field-stack"],
    ["system", "amber.tleap-complex-assembly"],
    ["atom-map", "amber.topology-coordinate-validation"],
    ["stage", "amber.production-md"],
    ["analysis", "amber.cpptraj-analysis"],
    ["assessment", "analysis.md-trajectory-qc"],
  ] as const) {
    insert(raw, "scientific_work_units", {
      id: `work-${suffix}`,
      mission_id: "mission-backup-md",
      plan_id: "plan-backup-md",
      plan_version: 1,
      kind: "validation",
      state: suffix === "stage" ? "succeeded" : "observing",
      revision: 1,
      claim_owner: null,
      claim_expires_at: null,
      job_id: null,
      attempt_id: null,
      payload_digest: d(`work-${suffix}`),
      payload_json: JSON.stringify({ suffix }),
      created_at: NOW,
      updated_at: NOW,
      capability_id: capability,
    });
    insert(raw, "scientific_external_operations", {
      id: `operation-${suffix}`,
      mission_id: "mission-backup-md",
      work_unit_id: `work-${suffix}`,
      idempotency_key: `backup-${suffix}`,
      kind: "local_execution",
      state: "confirmed",
      request_digest: d(`request-${suffix}`),
      policy_digest: d("policy"),
      budget_reservation_id: null,
      receipt_id: null,
      revision: 4,
      payload_json: JSON.stringify({ suffix }),
      created_at: NOW,
      updated_at: NOW,
      operation_kind_id: capability,
    });
    insert(raw, "scientific_operation_receipts", {
      id: `receipt-${suffix}`,
      operation_id: `operation-${suffix}`,
      request_digest: d(`request-${suffix}`),
      status: "confirmed",
      detail_digest: d(`receipt-${suffix}`),
      payload_json: JSON.stringify({ suffix }),
      recorded_at: NOW,
    });
    raw
      .query("UPDATE scientific_external_operations SET receipt_id = ? WHERE id = ?")
      .run(`receipt-${suffix}`, `operation-${suffix}`);
  }

  const evidence = (id: string) => {
    const bytes = objects.get(id)!;
    return {
      digest: digest(bytes),
      size: bytes.byteLength,
      mediaType: evidenceMetadata.get(id)!.mediaType,
    };
  };
  const ffStack = evidence("evidence-ff-stack");
  insert(raw, "scientific_force_field_stack_revisions", {
    id: "ff-stack-backup",
    revision: 2,
    mission_id: "mission-backup-md",
    stack_digest: ffStack.digest,
    artifact_evidence_id: "evidence-ff-stack",
    operation_id: "operation-ff",
    operation_receipt_id: "receipt-ff",
    request_digest: d("request-ff"),
    payload_json: JSON.stringify({ marker: "force-field-stack-revision" }),
    created_at: NOW,
  });
  insert(raw, "scientific_force_field_stack_evidence", {
    stack_id: "ff-stack-backup",
    stack_revision: 2,
    evidence_id: "evidence-ff-source",
    evidence_roles_json: JSON.stringify(["protein_parameters"]),
    content_digest: evidence("evidence-ff-source").digest,
    media_type: evidence("evidence-ff-source").mediaType,
    size_bytes: evidence("evidence-ff-source").size,
    payload_json: "{}",
  });

  const topology = evidence("evidence-topology");
  const coordinates = evidence("evidence-coordinates");
  const atomMap = evidence("evidence-atom-map");
  const manifestDigest = d("system-manifest");
  insert(raw, "scientific_biomolecular_system_manifests", {
    id: "system-backup-md",
    revision: 3,
    mission_id: "mission-backup-md",
    operation_id: "operation-system",
    manifest_digest: manifestDigest,
    topology_digest: topology.digest,
    coordinate_digest: coordinates.digest,
    atom_map_digest: atomMap.digest,
    payload_json: JSON.stringify({ marker: "system-manifest-revision" }),
    created_at: NOW,
  });
  insert(raw, "scientific_atom_map_revisions", {
    id: "atom-map-backup",
    revision: 1,
    mission_id: "mission-backup-md",
    system_manifest_id: "system-backup-md",
    system_manifest_revision: 3,
    map_digest: atomMap.digest,
    topology_digest: topology.digest,
    coordinate_digest: coordinates.digest,
    atom_count: 42,
    artifact_evidence_id: "evidence-atom-map",
    operation_id: "operation-atom-map",
    operation_receipt_id: "receipt-atom-map",
    request_digest: d("request-atom-map"),
    payload_json: JSON.stringify({ marker: "atom-map-revision" }),
    created_at: NOW,
  });

  for (const effect of [
    ["force_field_stack", "ff-stack-backup", 2, "ff", ffStack.digest],
    ["system_manifest", "system-backup-md", 3, "system", manifestDigest],
    ["atom_map", "atom-map-backup", 1, "atom-map", atomMap.digest],
  ] as const) {
    insert(raw, "scientific_biomolecular_material_effects", {
      subject_type: effect[0],
      subject_id: effect[1],
      subject_revision: effect[2],
      mission_id: "mission-backup-md",
      operation_id: `operation-${effect[3]}`,
      operation_receipt_id: `receipt-${effect[3]}`,
      request_digest: d(`request-${effect[3]}`),
      content_digest: effect[4],
      payload_json: JSON.stringify({ marker: `material-effect-${effect[0]}` }),
      created_at: NOW,
    });
  }

  insert(raw, "scientific_biomolecular_manifest_effects", {
    manifest_id: "system-backup-md",
    manifest_revision: 3,
    mission_id: "mission-backup-md",
    operation_id: "operation-system",
    operation_receipt_id: "receipt-system",
    request_digest: d("request-system"),
    manifest_digest: manifestDigest,
    payload_json: "{}",
    created_at: NOW,
  });
  for (const [role, evidenceId] of [
    ["topology", "evidence-topology"],
    ["coordinates", "evidence-coordinates"],
    ["atom_map", "evidence-atom-map"],
  ] as const) {
    const artifact = evidence(evidenceId);
    insert(raw, "scientific_biomolecular_manifest_artifacts", {
      manifest_id: "system-backup-md",
      manifest_revision: 3,
      artifact_role: role,
      evidence_id: evidenceId,
      operation_receipt_id: "receipt-system",
      content_digest: artifact.digest,
      media_type: artifact.mediaType,
      size_bytes: artifact.size,
      payload_json: "{}",
    });
    insert(raw, "scientific_biomolecular_material_artifact_claims", {
      evidence_id: evidenceId,
      mission_id: "mission-backup-md",
      subject_type: "system_manifest",
      subject_id: "system-backup-md",
      subject_revision: 3,
      artifact_role: role,
      operation_receipt_id: "receipt-system",
      content_digest: artifact.digest,
      media_type: artifact.mediaType,
      size_bytes: artifact.size,
      payload_json: "{}",
      claimed_at: NOW,
    });
  }
  insert(raw, "scientific_biomolecular_material_artifact_claims", {
    evidence_id: "evidence-ff-stack",
    mission_id: "mission-backup-md",
    subject_type: "force_field_stack",
    subject_id: "ff-stack-backup",
    subject_revision: 2,
    artifact_role: "force_field_stack",
    operation_receipt_id: "receipt-ff",
    content_digest: ffStack.digest,
    media_type: ffStack.mediaType,
    size_bytes: ffStack.size,
    payload_json: "{}",
    claimed_at: NOW,
  });

  const protocolDigest = d("md-protocol");
  const stageDigest = d("production-stage");
  insert(raw, "scientific_md_protocols", {
    id: "protocol-backup-md",
    revision: 4,
    mission_id: "mission-backup-md",
    plan_id: "plan-backup-md",
    system_manifest_id: "system-backup-md",
    system_manifest_revision: 3,
    protocol_digest: protocolDigest,
    payload_json: JSON.stringify({ marker: "md-protocol-revision" }),
    created_at: NOW,
    plan_version: 1,
    material_digest: d("protocol-material"),
    review_status: "approved",
    updated_at: NOW,
  });
  insert(raw, "scientific_md_stage_specs", {
    id: "stage-backup-md",
    revision: 2,
    mission_id: "mission-backup-md",
    protocol_id: "protocol-backup-md",
    protocol_revision: 4,
    sequence: 1,
    stage_kind: "production",
    stage_digest: stageDigest,
    payload_json: JSON.stringify({ marker: "stage-spec-revision" }),
    created_at: NOW,
  });
  insert(raw, "scientific_md_stage_bindings", {
    id: "binding-backup-md",
    mission_id: "mission-backup-md",
    protocol_id: "protocol-backup-md",
    protocol_revision: 4,
    work_unit_id: "work-stage",
    operation_id: "operation-stage",
    stage_id: "stage-backup-md",
    replica_id: "replica-1",
    segment_index: 0,
    request_digest: d("request-stage"),
    payload_json: JSON.stringify({ marker: "stage-binding" }),
    created_at: NOW,
  });
  const stageResultDigest = d("stage-result");
  insert(raw, "scientific_md_stage_results", {
    id: "result-backup-md",
    stage_binding_id: "binding-backup-md",
    operation_receipt_id: "receipt-stage",
    result_digest: stageResultDigest,
    terminal_reason: "completed",
    exit_code: 0,
    payload_json: JSON.stringify({ marker: "stage-result" }),
    recorded_at: NOW,
    revision: 1,
    mission_id: "mission-backup-md",
    stage_id: "stage-backup-md",
    stage_revision: 2,
    stage_digest: stageDigest,
    protocol_id: "protocol-backup-md",
    protocol_revision: 4,
    protocol_digest: protocolDigest,
    replica_set_id: null,
    replica_set_revision: null,
    replica_set_digest: null,
    replica_id: "replica-1",
    segment_index: 0,
    parent_restart_digest: d("parent-restart"),
  });
  for (const [role, evidenceId] of [
    ["restart", "evidence-restart"],
    ["trajectory", "evidence-trajectory"],
    ["mdout", "evidence-mdout"],
  ] as const) {
    const artifact = evidence(evidenceId);
    insert(raw, "scientific_md_stage_result_artifacts", {
      stage_result_id: "result-backup-md",
      artifact_role: role,
      evidence_id: evidenceId,
      operation_receipt_id: "receipt-stage",
      content_digest: artifact.digest,
      media_type: artifact.mediaType,
      size_bytes: artifact.size,
      payload_json: "{}",
    });
  }
  insert(raw, "scientific_md_trajectory_segments", {
    id: "segment-backup-md",
    mission_id: "mission-backup-md",
    stage_binding_id: "binding-backup-md",
    replica_id: "replica-1",
    segment_index: 0,
    parent_restart_digest: d("parent-restart"),
    start_step: 0,
    end_step: 5000,
    start_time_ps: 0,
    end_time_ps: 10,
    frame_count: 11,
    trajectory_digest: evidence("evidence-trajectory").digest,
    restart_digest: evidence("evidence-restart").digest,
    continuity_status: "verified",
    payload_json: JSON.stringify({ marker: "trajectory-segment" }),
    recorded_at: NOW,
    revision: 1,
    segment_digest: d("segment"),
  });

  insert(raw, "scientific_md_analysis_results", {
    id: "analysis-backup-md",
    revision: 1,
    mission_id: "mission-backup-md",
    system_manifest_id: "system-backup-md",
    system_manifest_revision: 3,
    operation_id: "operation-analysis",
    operation_receipt_id: "receipt-analysis",
    analysis_kind: "trajectory_qc",
    result_digest: evidence("evidence-analysis").digest,
    payload_json: JSON.stringify({ marker: "analysis-result" }),
    recorded_at: NOW,
  });
  insert(raw, "scientific_md_metric_series", {
    id: "series-backup-md",
    mission_id: "mission-backup-md",
    stage_result_id: null,
    analysis_result_id: "analysis-backup-md",
    analysis_result_revision: 1,
    metric_name: "temperature",
    units: "K",
    artifact_digest: evidence("evidence-analysis").digest,
    payload_json: JSON.stringify({ marker: "metric-series" }),
    recorded_at: NOW,
    series_digest: d("series"),
  });
  insert(raw, "scientific_md_assessments", {
    id: "assessment-backup-md",
    revision: 1,
    mission_id: "mission-backup-md",
    assessment_kind: "stage",
    subject_id: "result-backup-md",
    subject_revision: 1,
    operation_id: "operation-assessment",
    operation_receipt_id: "receipt-assessment",
    assessment_digest: d("assessment"),
    payload_json: JSON.stringify({ marker: "stage-assessment" }),
    created_at: NOW,
  });
  insert(raw, "scientific_md_work_unit_completion_gates", {
    work_unit_id: "work-stage",
    mission_id: "mission-backup-md",
    stage_result_id: "result-backup-md",
    stage_result_digest: stageResultDigest,
    assessment_id: "assessment-backup-md",
    assessment_revision: 1,
    assessment_digest: d("assessment"),
    payload_json: JSON.stringify({ marker: "completion-gate" }),
    completed_at: NOW,
  });

  raw.exec("PRAGMA foreign_keys = ON");
  expect(raw.query("PRAGMA foreign_key_check").all()).toEqual([]);
  return objects;
}

describe("scientific biomolecular/MD backup authority", () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("round-trips the current mission, material, MD, analysis, and CAS schema", async () => {
    const root = mkdtempSync(join(tmpdir(), "eigengrid-scientific-backup-"));
    directories.push(root);
    const dbPath = join(root, "source.sqlite");
    const database = createDatabase(dbPath);
    await database.init();
    const sourceCas = new ContentAddressedArtifactStore(join(root, "source-cas"));
    await sourceCas.init();
    let expected: Map<string, Uint8Array>;
    try {
      expected = await seedScientificMdFixture(database, sourceCas);
      const expectedMigrationVersion = (database as unknown as { ensureDb(): Database })
        .ensureDb()
        .query("SELECT MAX(version) AS version FROM _migrations")
        .get() as {
        version: number;
      };
      const backupPath = join(root, "scientific.eigengrid-backup.tar.gz");
      const created = await createBackup(database, {
        dbPath,
        outputPath: backupPath,
        version: "test-v16",
        contentAddressedStore: sourceCas,
      });
      expect(created.fileCount).toBeGreaterThan(20);
      const inspected = await inspectBackup(backupPath);
      expect(inspected.manifest.counts.scientificCasReferences).toBe(expected.size);
      expect(inspected.manifest.counts.scientificCasObjects).toBe(expected.size);
      expect(inspected.checksumValid).toBe(true);

      const restoredRoot = join(root, "restored");
      const restored = await restoreBackup(backupPath, { targetDir: restoredRoot });
      expect(restored.ok).toBe(true);
      expect(
        JSON.parse(readFileSync(join(restoredRoot, "schema.json"), "utf-8")).migrationVersion,
      ).toBe(expectedMigrationVersion.version);
      const restoredEvidenceDigests = new Map<string, string>();
      const snapshot = new Database(join(restoredRoot, "head.sqlite"), { readonly: true });
      try {
        expect(snapshot.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
        expect(snapshot.query("PRAGMA foreign_key_check").all()).toEqual([]);
        expect(snapshot.query("SELECT MAX(version) AS version FROM _migrations").get()).toEqual({
          version: expectedMigrationVersion.version,
        });
        for (const [table, marker] of [
          ["scientific_missions", "mission-v16-round-trip"],
          ["scientific_force_field_stack_revisions", "force-field-stack-revision"],
          ["scientific_atom_map_revisions", "atom-map-revision"],
          ["scientific_md_stage_results", "stage-result"],
          ["scientific_md_trajectory_segments", "trajectory-segment"],
          ["scientific_md_analysis_results", "analysis-result"],
          ["scientific_md_work_unit_completion_gates", "completion-gate"],
        ] as const) {
          const row = snapshot.query(`SELECT payload_json FROM ${table}`).get() as {
            payload_json: string;
          };
          expect(JSON.parse(row.payload_json).marker).toBe(marker);
        }
        expect(
          snapshot
            .query("SELECT COUNT(*) AS count FROM scientific_biomolecular_material_effects")
            .get(),
        ).toEqual({ count: 3 });
        expect(
          snapshot
            .query("SELECT COUNT(*) AS count FROM scientific_biomolecular_material_artifact_claims")
            .get(),
        ).toEqual({ count: 4 });
        expect(snapshot.query("SELECT COUNT(*) AS count FROM scientific_evidence").get()).toEqual({
          count: expected.size,
        });
        for (const [evidenceId, bytes] of expected) {
          const row = snapshot
            .query(
              `SELECT uri, content_digest, immutable, payload_json
                 FROM scientific_evidence
                WHERE id = ?`,
            )
            .get(evidenceId) as {
            uri: string;
            content_digest: string;
            immutable: number;
            payload_json: string;
          };
          expect(row.content_digest).toBe(digest(bytes));
          expect(row.uri).toBe(`cas://sha256/${row.content_digest}`);
          expect(row.immutable).toBe(1);
          expect(EvidenceReferenceSchema.parse(JSON.parse(row.payload_json)).id).toBe(evidenceId);
          restoredEvidenceDigests.set(evidenceId, row.content_digest);
        }
      } finally {
        snapshot.close();
      }

      const restoredCas = new ContentAddressedArtifactStore(join(restoredRoot, "cas"));
      await restoredCas.init();
      try {
        for (const [evidenceId, bytes] of expected) {
          const restoredObject = await restoredCas.get(restoredEvidenceDigests.get(evidenceId)!);
          expect(new TextDecoder().decode(restoredObject.bytes)).toBe(
            new TextDecoder().decode(bytes),
          );
          expect(restoredObject.uri).toBe(`cas://sha256/${digest(bytes)}`);
          expect(evidenceId).toStartWith("evidence-");
          expect(
            statSync(join(restoredRoot, "cas/sha256", digest(bytes).slice(0, 2), digest(bytes)))
              .mode & 0o777,
          ).toBe(0o444);
        }
      } finally {
        await restoredCas.close();
      }
      expect((await verifyBackup(backupPath)).ok).toBe(true);
    } finally {
      await sourceCas.close();
      await database.close();
    }
  });

  test("fails closed when a snapshot references CAS but no verified store is supplied", async () => {
    const root = mkdtempSync(join(tmpdir(), "eigengrid-scientific-backup-missing-cas-"));
    directories.push(root);
    const dbPath = join(root, "source.sqlite");
    const database = createDatabase(dbPath);
    await database.init();
    const sourceCas = new ContentAddressedArtifactStore(join(root, "source-cas"));
    await sourceCas.init();
    const backupPath = join(root, "must-not-exist.tar.gz");
    try {
      await seedScientificMdFixture(database, sourceCas);
      await expect(
        createBackup(database, { dbPath, outputPath: backupPath, version: "test-v16" }),
      ).rejects.toThrow("no verified content-addressed store");
      expect(existsSync(backupPath)).toBe(false);
    } finally {
      await sourceCas.close();
      await database.close();
    }
  });

  test("rejects a re-checksummed CAS object whose bytes no longer match its address", async () => {
    const root = mkdtempSync(join(tmpdir(), "eigengrid-scientific-backup-tamper-"));
    directories.push(root);
    const dbPath = join(root, "source.sqlite");
    const database = createDatabase(dbPath);
    await database.init();
    const sourceCas = new ContentAddressedArtifactStore(join(root, "source-cas"));
    await sourceCas.init();
    try {
      await seedScientificMdFixture(database, sourceCas);
      const original = join(root, "original.tar.gz");
      await createBackup(database, {
        dbPath,
        outputPath: original,
        version: "test-v16",
        contentAddressedStore: sourceCas,
      });
      const extracted = join(root, "extracted");
      mkdirSync(extracted);
      await tar.extract({ file: original, cwd: extracted, portable: true });
      const index = JSON.parse(readFileSync(join(extracted, "cas/index.json"), "utf-8")) as {
        objects: Array<{ archivePath: string }>;
      };
      const objectPath = index.objects[0]!.archivePath;
      const originalObject = readFileSync(join(extracted, objectPath));
      const tampered = Buffer.alloc(originalObject.length, 0x78);
      writeFileSync(join(extracted, objectPath), tampered);
      const checksumPath = join(extracted, "checksums.sha256");
      const checksums = readFileSync(checksumPath, "utf-8")
        .split("\n")
        .map((line) =>
          line.endsWith(`  ${objectPath}`) ? `${digest(tampered)}  ${objectPath}` : line,
        )
        .join("\n");
      writeFileSync(checksumPath, checksums);
      const attacked = join(root, "attacked.tar.gz");
      const entries = (await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: extracted }))).filter(
        (path) => !path.endsWith("/"),
      );
      await tar.create({ file: attacked, cwd: extracted, gzip: true, portable: true }, entries);
      const result = await verifyBackup(attacked);
      expect(result.ok).toBe(false);
      expect(result.checksumValid).toBe(false);
      expect(result.errors.join(" ")).toContain("bytes do not match their address");
    } finally {
      await sourceCas.close();
      await database.close();
    }
  });

  test("accepts a legacy v1 SQLite archive only when its frozen DB has no CAS references", async () => {
    const root = mkdtempSync(join(tmpdir(), "eigengrid-legacy-backup-"));
    directories.push(root);
    const dbPath = join(root, "source.sqlite");
    const database = createDatabase(dbPath);
    await database.init();
    try {
      const current = join(root, "current.tar.gz");
      await createBackup(database, { dbPath, outputPath: current, version: "legacy-fixture" });
      const extracted = join(root, "extracted");
      mkdirSync(extracted);
      await tar.extract({ file: current, cwd: extracted, portable: true });
      rmSync(join(extracted, "cas/index.json"));
      const manifestPath = join(extracted, "manifest.json");
      const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as {
        counts: Record<string, number>;
      };
      delete manifest.counts.scientificCasReferences;
      delete manifest.counts.scientificCasObjects;
      const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2));
      writeFileSync(manifestPath, manifestBytes);
      const checksumPath = join(extracted, "checksums.sha256");
      const checksums = readFileSync(checksumPath, "utf-8")
        .split("\n")
        .filter((line) => !line.endsWith("  cas/index.json"))
        .map((line) =>
          line.endsWith("  manifest.json") ? `${digest(manifestBytes)}  manifest.json` : line,
        )
        .join("\n");
      writeFileSync(checksumPath, checksums);
      const legacy = join(root, "legacy-v1.tar.gz");
      const entries = (await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: extracted }))).filter(
        (path) => !path.endsWith("/"),
      );
      await tar.create({ file: legacy, cwd: extracted, gzip: true, portable: true }, entries);
      expect((await verifyBackup(legacy)).ok).toBe(true);
      const restored = await restoreBackup(legacy, { targetDir: join(root, "restored") });
      expect(restored.ok).toBe(true);
      expect(restored.manifest?.counts.scientificCasObjects).toBeUndefined();
    } finally {
      await database.close();
    }
  });

  test("rejects a legacy-shaped archive that omits CAS bytes referenced by its frozen DB", async () => {
    const root = mkdtempSync(join(tmpdir(), "eigengrid-legacy-cas-gap-"));
    directories.push(root);
    const dbPath = join(root, "source.sqlite");
    const database = createDatabase(dbPath);
    await database.init();
    const sourceCas = new ContentAddressedArtifactStore(join(root, "source-cas"));
    await sourceCas.init();
    try {
      await seedScientificMdFixture(database, sourceCas);
      const current = join(root, "current.tar.gz");
      await createBackup(database, {
        dbPath,
        outputPath: current,
        version: "legacy-gap-fixture",
        contentAddressedStore: sourceCas,
      });
      const extracted = join(root, "extracted");
      mkdirSync(extracted);
      await tar.extract({ file: current, cwd: extracted, portable: true });
      rmSync(join(extracted, "cas"), { recursive: true, force: true });
      const checksumPath = join(extracted, "checksums.sha256");
      writeFileSync(
        checksumPath,
        readFileSync(checksumPath, "utf-8")
          .split("\n")
          .filter((line) => !line.includes("  cas/"))
          .join("\n"),
      );
      const legacyGap = join(root, "legacy-gap.tar.gz");
      const entries = (await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: extracted }))).filter(
        (path) => !path.endsWith("/"),
      );
      await tar.create({ file: legacyGap, cwd: extracted, gzip: true, portable: true }, entries);
      const verified = await verifyBackup(legacyGap);
      expect(verified.ok).toBe(false);
      expect(verified.errors.join(" ")).toContain("CAS references exist");
      const restored = await restoreBackup(legacyGap, {
        targetDir: join(root, "must-not-restore"),
      });
      expect(restored.ok).toBe(false);
      expect(existsSync(join(root, "must-not-restore"))).toBe(false);
    } finally {
      await sourceCas.close();
      await database.close();
    }
  });

  test("rejects missing, extra, mis-sized, and duplicate-index CAS objects", async () => {
    const root = mkdtempSync(join(tmpdir(), "eigengrid-cas-inventory-attacks-"));
    directories.push(root);
    const dbPath = join(root, "source.sqlite");
    const database = createDatabase(dbPath);
    await database.init();
    const sourceCas = new ContentAddressedArtifactStore(join(root, "source-cas"));
    await sourceCas.init();
    try {
      await seedScientificMdFixture(database, sourceCas);
      const original = join(root, "original.tar.gz");
      await createBackup(database, {
        dbPath,
        outputPath: original,
        version: "inventory-fixture",
        contentAddressedStore: sourceCas,
      });

      const cases = [
        {
          label: "missing-object",
          expected: "object is missing",
          mutate(directory: string) {
            const index = JSON.parse(readFileSync(join(directory, "cas/index.json"), "utf-8"));
            rmSync(join(directory, index.objects[0].archivePath));
          },
        },
        {
          label: "extra-object",
          expected: "Unreferenced scientific CAS object",
          mutate(directory: string) {
            const bytes = Buffer.from("unreferenced-object");
            const objectDigest = digest(bytes);
            const path = join(directory, "cas/sha256", objectDigest.slice(0, 2), objectDigest);
            mkdirSync(join(directory, "cas/sha256", objectDigest.slice(0, 2)), {
              recursive: true,
            });
            writeFileSync(path, bytes);
          },
        },
        {
          label: "wrong-size",
          expected: "object size mismatch",
          mutate(directory: string) {
            const path = join(directory, "cas/index.json");
            const index = JSON.parse(readFileSync(path, "utf-8"));
            index.objects[0].sizeBytes += 1;
            writeFileSync(path, JSON.stringify(index));
          },
        },
        {
          label: "duplicate-index",
          expected: "index is not uniquely canonical",
          mutate(directory: string) {
            const path = join(directory, "cas/index.json");
            const index = JSON.parse(readFileSync(path, "utf-8"));
            index.objects.push({ ...index.objects[0] });
            writeFileSync(path, JSON.stringify(index));
          },
        },
      ] as const;
      for (const attack of cases) {
        const archive = await repackWithChecksums(root, original, attack.label, attack.mutate);
        const verified = await verifyBackup(archive);
        expect(verified.ok).toBe(false);
        expect(verified.errors.join(" ")).toContain(attack.expected);
      }
    } finally {
      await sourceCas.close();
      await database.close();
    }
  });

  test("rejects canonical evidence, claim metadata, and manifest count drift", async () => {
    const root = mkdtempSync(join(tmpdir(), "eigengrid-cas-catalog-attacks-"));
    directories.push(root);
    const dbPath = join(root, "source.sqlite");
    const database = createDatabase(dbPath);
    await database.init();
    const sourceCas = new ContentAddressedArtifactStore(join(root, "source-cas"));
    await sourceCas.init();
    try {
      await seedScientificMdFixture(database, sourceCas);
      const original = join(root, "original.tar.gz");
      await createBackup(database, {
        dbPath,
        outputPath: original,
        version: "catalog-fixture",
        contentAddressedStore: sourceCas,
      });

      const payloadMismatch = await repackWithChecksums(
        root,
        original,
        "payload-mismatch",
        (directory) => {
          const snapshot = new Database(join(directory, "head.sqlite"));
          try {
            const row = snapshot
              .query("SELECT payload_json FROM scientific_evidence WHERE id = ?")
              .get("evidence-trajectory") as { payload_json: string };
            const payload = JSON.parse(row.payload_json);
            payload.sourceId = "receipt-analysis";
            snapshot
              .query("UPDATE scientific_evidence SET payload_json = ? WHERE id = ?")
              .run(JSON.stringify(payload), "evidence-trajectory");
          } finally {
            snapshot.close();
          }
        },
      );
      expect((await verifyBackup(payloadMismatch)).errors.join(" ")).toContain(
        "payload sourceId disagrees",
      );

      const invalidTimestamp = await repackWithChecksums(
        root,
        original,
        "invalid-evidence-timestamp",
        (directory) => {
          const snapshot = new Database(join(directory, "head.sqlite"));
          try {
            const row = snapshot
              .query("SELECT payload_json FROM scientific_evidence WHERE id = ?")
              .get("evidence-trajectory") as { payload_json: string };
            const payload = JSON.parse(row.payload_json);
            payload.createdAt = "not-a-timestamp";
            snapshot
              .query("UPDATE scientific_evidence SET created_at = ?, payload_json = ? WHERE id = ?")
              .run("not-a-timestamp", JSON.stringify(payload), "evidence-trajectory");
          } finally {
            snapshot.close();
          }
        },
      );
      expect((await verifyBackup(invalidTimestamp)).errors.join(" ")).toContain(
        "violates EvidenceReferenceSchema",
      );

      const nonCasMaterial = await repackWithChecksums(
        root,
        original,
        "non-cas-material",
        (directory) => {
          const snapshot = new Database(join(directory, "head.sqlite"));
          try {
            const row = snapshot
              .query("SELECT payload_json FROM scientific_evidence WHERE id = ?")
              .get("evidence-trajectory") as { payload_json: string };
            const payload = JSON.parse(row.payload_json);
            payload.uri = "file:///mutable/trajectory.nc";
            snapshot
              .query("UPDATE scientific_evidence SET uri = ?, payload_json = ? WHERE id = ?")
              .run(payload.uri, JSON.stringify(payload), "evidence-trajectory");
          } finally {
            snapshot.close();
          }
        },
      );
      expect((await verifyBackup(nonCasMaterial)).errors.join(" ")).toContain(
        "material evidence evidence-trajectory is not CAS-backed",
      );

      const claimMismatch = await repackWithChecksums(
        root,
        original,
        "claim-mismatch",
        (directory) => {
          const snapshot = new Database(join(directory, "head.sqlite"));
          try {
            snapshot
              .query(
                `UPDATE scientific_md_stage_result_artifacts
                    SET size_bytes = size_bytes + 1
                  WHERE evidence_id = ?`,
              )
              .run("evidence-trajectory");
          } finally {
            snapshot.close();
          }
        },
      );
      expect((await verifyBackup(claimMismatch)).errors.join(" ")).toContain(
        "metadata disagrees with evidence",
      );

      const claimSourceMismatch = await repackWithChecksums(
        root,
        original,
        "claim-source-mismatch",
        (directory) => {
          const snapshot = new Database(join(directory, "head.sqlite"));
          try {
            snapshot
              .query(
                `UPDATE scientific_md_stage_result_artifacts
                    SET operation_receipt_id = ?
                  WHERE evidence_id = ?`,
              )
              .run("receipt-analysis", "evidence-trajectory");
          } finally {
            snapshot.close();
          }
        },
      );
      expect((await verifyBackup(claimSourceMismatch)).errors.join(" ")).toContain(
        "metadata disagrees with evidence",
      );

      const claimMediaMismatch = await repackWithChecksums(
        root,
        original,
        "claim-media-mismatch",
        (directory) => {
          const snapshot = new Database(join(directory, "head.sqlite"));
          try {
            snapshot
              .query(
                `UPDATE scientific_md_stage_result_artifacts
                    SET media_type = ?
                  WHERE evidence_id = ?`,
              )
              .run("application/x-wrong", "evidence-trajectory");
          } finally {
            snapshot.close();
          }
        },
      );
      expect((await verifyBackup(claimMediaMismatch)).errors.join(" ")).toContain(
        "metadata disagrees with evidence",
      );

      const materialDigestMismatch = await repackWithChecksums(
        root,
        original,
        "material-digest-mismatch",
        (directory) => {
          const snapshot = new Database(join(directory, "head.sqlite"));
          try {
            snapshot
              .query("UPDATE scientific_atom_map_revisions SET map_digest = ? WHERE id = ?")
              .run(digest("wrong-atom-map"), "atom-map-backup");
          } finally {
            snapshot.close();
          }
        },
      );
      expect((await verifyBackup(materialDigestMismatch)).errors.join(" ")).toContain(
        "scientific_atom_map_revisions digest disagrees",
      );

      const countMismatch = await repackWithChecksums(
        root,
        original,
        "count-mismatch",
        (directory) => {
          const path = join(directory, "manifest.json");
          const manifest = JSON.parse(readFileSync(path, "utf-8"));
          manifest.counts.scientificCasReferences = 0;
          manifest.counts.scientificCasObjects = 0;
          writeFileSync(path, JSON.stringify(manifest));
        },
      );
      const countResult = await verifyBackup(countMismatch);
      expect(countResult.ok).toBe(false);
      expect(countResult.errors.join(" ")).toContain("reference count mismatch");
      expect(countResult.errors.join(" ")).toContain("object count mismatch");

      const missingCounts = await repackWithChecksums(
        root,
        original,
        "missing-counts",
        (directory) => {
          const path = join(directory, "manifest.json");
          const manifest = JSON.parse(readFileSync(path, "utf-8"));
          delete manifest.counts.scientificCasReferences;
          delete manifest.counts.scientificCasObjects;
          writeFileSync(path, JSON.stringify(manifest));
        },
      );
      expect((await verifyBackup(missingCounts)).errors.join(" ")).toContain(
        "missing scientific CAS counts",
      );
    } finally {
      await sourceCas.close();
      await database.close();
    }
  });

  test("rejects an over-limit CAS index before restore materialization", async () => {
    const root = mkdtempSync(join(tmpdir(), "eigengrid-cas-index-limit-"));
    directories.push(root);
    const dbPath = join(root, "source.sqlite");
    const database = createDatabase(dbPath);
    await database.init();
    try {
      const original = join(root, "original.tar.gz");
      await createBackup(database, { dbPath, outputPath: original, version: "limit-fixture" });
      const attacked = await repackWithChecksums(root, original, "oversized-index", (directory) => {
        writeFileSync(join(directory, "cas/index.json"), Buffer.alloc(1_048_577, 0x20));
      });
      const verified = await verifyBackup(attacked);
      expect(verified.ok).toBe(false);
      expect(verified.errors.join(" ")).toContain("cas/index.json exceeds 1 MiB limit");
      const target = join(root, "must-not-materialize");
      expect((await restoreBackup(attacked, { targetDir: target })).ok).toBe(false);
      expect(existsSync(target)).toBe(false);
    } finally {
      await database.close();
    }
  });

  test("preserves an existing destination when CAS staging fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "eigengrid-atomic-backup-failure-"));
    directories.push(root);
    const dbPath = join(root, "source.sqlite");
    const database = createDatabase(dbPath);
    await database.init();
    const sourceCas = new ContentAddressedArtifactStore(join(root, "source-cas"));
    await sourceCas.init();
    const outputPath = join(root, "existing.tar.gz");
    writeFileSync(outputPath, "previous-valid-backup");
    try {
      const objects = await seedScientificMdFixture(database, sourceCas);
      const bytesByDigest = new Map(
        Array.from(objects.values(), (bytes) => [digest(bytes), bytes] as const),
      );
      const failingStore = {
        async getStream(contentDigest: string) {
          const bytes = bytesByDigest.get(contentDigest)!;
          return {
            digest: contentDigest,
            uri: `cas://sha256/${contentDigest}`,
            sizeBytes: bytes.byteLength,
            bytes: (async function* () {
              yield bytes;
              throw new Error("injected CAS stream failure");
            })(),
          };
        },
      };
      await expect(
        createBackup(database, {
          dbPath,
          outputPath,
          version: "atomic-failure-fixture",
          contentAddressedStore: failingStore,
        }),
      ).rejects.toThrow("injected CAS stream failure");
      expect(readFileSync(outputPath, "utf-8")).toBe("previous-valid-backup");

      await expect(
        createBackup(database, {
          dbPath,
          outputPath,
          version: "late-atomic-failure-fixture",
          projectName: "x".repeat(1_048_576),
          contentAddressedStore: sourceCas,
        }),
      ).rejects.toThrow("manifest.json exceeds 1 MiB limit");
      expect(readFileSync(outputPath, "utf-8")).toBe("previous-valid-backup");
      expect(
        (await Array.fromAsync(new Bun.Glob(".eigengrid-backup-create-*").scan({ cwd: root })))
          .length,
      ).toBe(0);
    } finally {
      await sourceCas.close();
      await database.close();
    }
  });

  test("keeps PostgreSQL backup/restore unsupported instead of inventing a partial dump", async () => {
    const root = mkdtempSync(join(tmpdir(), "eigengrid-postgres-backup-boundary-"));
    directories.push(root);
    const fakePostgres = {
      _provider: "postgres",
      listJobs: () => {
        throw new Error("must not query a partial PostgreSQL export");
      },
    } as unknown as DatabaseLike;
    await expect(
      createBackup(fakePostgres, {
        dbPath: join(root, "not-a-sqlite-database"),
        outputPath: join(root, "unsupported.tar.gz"),
        version: "test-v16",
      }),
    ).rejects.toThrow("PostgreSQL export is not implemented");
    expect(existsSync(join(root, "unsupported.tar.gz"))).toBe(false);
  });
});
