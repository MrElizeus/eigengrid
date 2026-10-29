/** Production mission/project authority is PostgreSQL-only. One CAS object can
 * be both immutable input and an independently receipted output. Keep exact
 * evidence IDs immutable and reject duplicate claims within one provenance,
 * rather than conflating all modern kinds with their legacy storage category. */
export const EVIDENCE_AUTHORITY_POSTGRES_MIGRATION = {
  version: 22,
  name: "bind_evidence_uniqueness_to_exact_authority",
  sql: `
    ALTER TABLE scientific_evidence
      DROP CONSTRAINT IF EXISTS scientific_evidence_mission_id_kind_uri_content_digest_key;
    CREATE UNIQUE INDEX scientific_evidence_authority_identity
      ON scientific_evidence (mission_id, evidence_kind_id, uri, content_digest,
         COALESCE(work_unit_id, ''), COALESCE(source_id, ''));
  `,
};
