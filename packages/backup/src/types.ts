// ────────────────────────────────────────────────────────────
// Backup / Restore / Export types
// ────────────────────────────────────────────────────────────

export interface BackupManifest {
  format: string;
  formatVersion: number;
  createdAt: string; // ISO 8601
  version: string; // eigengrid version
  projectName?: string;
  projectRoot?: string;
  hashAlgorithm: "sha256";
  includeArtifacts: boolean;
  counts: {
    jobs: number;
    attempts: number;
    artifacts: number;
    results: number;
    events: number;
    nodes: number;
    permissions: number;
    logs: number;
    proposals: number;
    users: number;
    projects: number;
    memberships: number;
    quotas: number;
    usageRecords: number;
    /** Number of scientific_evidence rows bound to cas://sha256 objects. */
    scientificCasReferences?: number;
    /** Number of unique, self-addressed CAS objects included in the archive. */
    scientificCasObjects?: number;
  };
}

export interface JobExportManifest {
  format: "eigengrid-job-export";
  formatVersion: number;
  createdAt: string;
  jobId: string;
  software: string;
  status: string;
  includeArtifacts: boolean;
  fileCount: number;
}

export interface DiagnosticManifest {
  format: "eigengrid-diagnostic";
  formatVersion: number;
  createdAt: string;
  jobId: string;
  software: string;
  status: string;
  fileCount: number;
}

export interface RestoreValidation {
  ok: boolean;
  errors: string[];
  warnings: string[];
  manifest?: BackupManifest;
  checksumValid: boolean;
  archiveSafe: boolean;
  schemaCompatible: boolean;
  targetExists: boolean;
  targetHasActiveDb: boolean;
  fileCount: number;
  totalSizeBytes: number;
}

export interface BackupInfo {
  manifest: BackupManifest;
  fileCount: number;
  totalSizeBytes: number;
  checksumValid: boolean;
  files: string[];
}

export interface RedactionPattern {
  regex: RegExp;
  replacement: string;
  name: string;
}

export interface ArchiveSafetyResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
}
