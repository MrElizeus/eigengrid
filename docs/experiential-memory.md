# Governed experiential memory

EigenGrid records local operational experiences and lets an operator review lessons
against retained observations. This is external, auditable memory: it does not train
LLM weights, establish scientific truth, publish skills or grant execution authority.

## Storage and boundaries

`packages/experience-memory` owns versioned Zod contracts, a SQLite repository,
redaction and retrieval eligibility. `packages/agent/src/experience-capture.ts` adapts
tool observations and verified agent journals. CLI tools and review commands are
separate adapters; they do not change scientific schema or journal digest formats.

The store lives beside the existing episodic database, at
`.eigengrid/experience/memory.sqlite`. The old `memory.db` is preserved. Its records
remain explicitly labelled unverified historical observations. New operational
captures go into the experience store and are not duplicated as legacy observations.

Every row belongs to a host-bound project and owner. The CLI derives these from the
canonical memory directory and current OS user. A lesson additionally has project,
session or installation scope. References cannot widen an evidence scope. Conditions
are exact key/value facts: missing facts prevent automatic retrieval. The default
Operator supplies platform and architecture; applications may bind additional facts
through `AgentMemoryOptions.experienceContext`.

This is a local OS-account trust boundary, not multi-tenant authentication. The web
runtime disables local memory and its tools; web conversation histories remain
separate. A future shared-memory service needs authenticated identities, explicit
ACLs and a separate promotion policy. Never bind a tenant from model arguments.

## Evidence and lessons

Evidence records include scope, source digest, retained-snapshot digest, origin,
outcome and observation time. Origins can identify tools, sessions, missions and
operations. The generic repository accepts trusted host ingestion; a caller-supplied
mission label alone is not proof of a Mission Runtime binding.

Snapshots are redacted and bounded to 4,000 bytes. The source digest identifies the
original capture material; the snapshot digest identifies the retained text. A digest
does not recover truncated data or certify that a tool's report was true. Original
scientific artifacts and durable receipts remain authoritative for their own domains.

Each candidate has an immutable claim, rationale, applicability conditions, evidence
references, outcome, confidence assessment, validity interval and author. Confidence
is a reviewer's assessment with a rationale, not a calibrated probability or a
similarity score. Changing a claim or its evidence requires a new candidate.

The normal lifecycle is:

```text
candidate → evidence_verified → reviewed → promoted
                       contradiction → contested
                 human resolution → candidate (fresh verification and review)
         reviewed replacement/refutation → superseded / refuted
```

Automatic verification checks referenced snapshots, digests and scope. It does not
test a causal hypothesis or qualify a scientific protocol. Only the owning human
reviewer can review or promote; scientific lessons require the scientific reviewer
role. CLI review explicitly records that role under the local OS identity, not an
external scientific credential. `promoted` means reusable reviewed memory guidance.
Publishing a protocol still uses the existing scientific skill lifecycle and review.

Relations reference exact immutable candidate digests and append events to both
lessons in one transaction. Contradictions exclude both from automatic context.
Refutation and replacement need a reviewed source and retire the target permanently.
Resolution of a dispute returns a lesson to candidate status; it never restores an
old approval. History is retained, hash chained and append only. Mutations compare
the expected current event digest inside an immediate transaction, rejecting stale
review or concurrent changes. Digests detect corruption; a hostile process with the
same OS permissions could rewrite the database and is outside this trust boundary.

## Operator capture and tools

Process-owned CLI/TUI chat captures actual tool observations, including errors, and
adds `memoryEvidence: { id, digest }` to the observation seen by subsequent inference.
After a turn, the verified event chain produces an evidence-backed candidate with
unknown confidence and a default 30-day validity interval. Successful completion
does not mean a scientific result was accepted. `tool_succeeded` means the tool
boundary returned successfully; inspect its payload for application-level errors.

Uncertain effects retain unresolved intent IDs and digests, without retrying the
effect. Memory tools do not become operational evidence about themselves. Pure
conversation creates a session observation but no operational lesson. Automatic
capture preserves the model's interpretation as unverified, rather than claiming
to have reconstructed the cause of a failure. A useful generalized lesson should
be proposed separately with the relevant evidence and narrower conditions.

The model can use:

- `search-experiences`: inspect eligible lessons, or explicitly inspect candidates
  and exclusion reasons; also returns a small recent-observation window.
- `inspect-experience`: read an exact lesson or evidence ID, with bounded pagination
  over the lesson's evidence, including observations outside the recent window.
- `propose-lesson`: submit a candidate with exact evidence references, conditions
  and expiry; host code verifies snapshot integrity.
- `contest-lesson`: relate two evidenced lessons as contradictory and quarantine
  both until human resolution.

The write tools require the normal Operator action policy. There are no model
review, promotion, refutation or protocol-publication tools. Memory text remains
non-authoritative context under the existing prompt and tool-policy boundaries.
Capture failures surface a warning and do not change or repeat a settled effect.

## CLI workflow

Run in the intended project's directory. Commands emit JSON; inspecting memory
does not require a model, PostgreSQL or a running scientific engine.

```bash
eigengrid memory search --query "AMBER modules" --include-candidates
eigengrid memory evidence
eigengrid memory show LESSON_ID
eigengrid memory evidence EVIDENCE_ID
eigengrid memory propose --file lesson.json
eigengrid memory verify LESSON_ID --expected CURRENT_EVENT_DIGEST
eigengrid memory review LESSON_ID --expected VERIFIED_EVENT_DIGEST \
  --confidence medium --reason "Checked the installation identity and module evidence"
eigengrid memory promote LESSON_ID --expected REVIEWED_EVENT_DIGEST \
  --reason "Reviewed guidance within the stated conditions"
```

`lesson.json` contains the candidate's `id`, `scope`, `domain`, `title`, `claim`,
`rationale`, `conditions`, `evidence`, `outcome`, `confidence`, `validFrom` and
`expiresAt`. Use actual evidence IDs and digests from `memory evidence` and an
explicit future expiry. Identity, timestamps, schema version and digests are bound
by the host. The model's proposal tool uses this same contract with a host-generated
ID and project scope.

Review, promotion, relations and resolution show the exact claim, observations,
rationale and current revisions. They require an interactive operator terminal and
typing the full source revision digest. There is no `--yes` or model-supplied reviewer
identity. This prevents the ordinary noninteractive model shell path from approving
itself; it does not sandbox a hostile process with unrestricted OS access.

```bash
eigengrid memory relate NEW_LESSON_ID --expected NEW_EVENT_DIGEST \
  --target OLD_LESSON_ID --target-expected OLD_EVENT_DIGEST \
  --relation contradicts --reason "New evidence conflicts with the original claim"
eigengrid memory resolve NEW_LESSON_ID --expected CONTESTED_EVENT_DIGEST \
  --reason "Evidence reviewed; this candidate needs fresh verification and review"
```

After verifying and reviewing the resolved source, use `refutes` or `supersedes`
instead of `contradicts` when justified. In the AMBER example, absence from one PATH
does not establish absence from the installation. Different identities or allocation
environments may explain the apparent conflict. Record those conditions and inspect
both sets of evidence before resolving it.

Durable scientific journals are imported explicitly into the current local boundary:

```bash
eigengrid memory import-session --journal-dir /owned/private/journals \
  --session-id SESSION_ID
```

Import validates the existing journal chain and reuses observed/reconciled results;
it never executes tools. Reimporting the same prefix is idempotent. Imports are not
an automatic Mission Runtime evidence feed and do not authenticate a mission solely
from the journal's session label. Observation time and the default expiry start at
first ingestion; the reviewer must assess the age of the original evidence.

## Retrieval, privacy and limits

Automatic retrieval requires a reviewed/promoted state, matching scope and every
condition, a live validity interval and intact evidence. Explicit inspection may
show excluded lessons with reasons. Search is bounded lexical retrieval over up to
500 matching recent candidates, with optional reciprocal-rank fusion of externally
supplied semantic candidate IDs. No embedding provider, vector database or internet
search is enabled by this change. A future provider cannot bypass the same scope,
evidence and eligibility filters by returning a high similarity score.

Directories are private (0700) and the database is 0600 on POSIX. Common credential
patterns are redacted before retention, but redaction cannot recognize every secret.
Do not put secrets into prompts or tool output. There is no encryption at rest.
Reviewed context sent to the configured model is bounded; explicit inspection tools
can return more of the retained records. A host can disable capture and tools with
`createAgentRuntime({ memory: false })` or omit `AgentInput.memory` when it owns its
own tool registry.

Expiry excludes a lesson; it does not delete audit history. There is no periodic
consolidation or pruning yet. Close all Operator processes before backing up the
experience directory or deleting it to reset local experience memory; include WAL
sidecars if using an external live SQLite backup mechanism. This local store is not
automatically included in a Mission Runtime database backup. Sessions, projects,
skills and web conversations keep their existing retention mechanisms.

Deferred work includes semantic indexing, scheduled consolidation, automatic causal
evaluation, authenticated collective memory and governed protocol-publication
proposals. The current implementation supplies the evidence and review contract
these features must preserve.
