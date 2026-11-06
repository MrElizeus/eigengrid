import { digestBytes, digestCanonical } from "@eigengrid/scientific-schema";
import type { SkillFragmentReference } from "@eigengrid/scientific-schema";
import type { CatalogSnapshot } from "./catalog";
import { skillKey } from "./catalog";

export const DOCUMENT_POLICY = "scientific-fragments/1:chars1200:overlap160:metadata";

export interface RetrievalDocument {
  id: string;
  reference: SkillFragmentReference;
  catalogId: string;
  accessScope: string;
  assetKind: string;
  domains: readonly string[];
  engines: readonly string[];
  reviewStatus: string;
  /** UTF-16 offsets into the canonical fragment; documents are derived windows only. */
  start: number;
  end: number;
  contentDigest: string;
  text: string;
}

/** Bounded embedding windows retain their parent identity; context always returns exact full fragments. */
export function retrievalDocuments(snapshot: CatalogSnapshot): RetrievalDocument[] {
  return snapshot.fragments.flatMap((fragment) => {
    const ref = fragment.reference;
    const skill = snapshot.registry.exact(ref.skillId, ref.version)!;
    const grant = snapshot.catalogBySkill.get(skillKey(ref.skillId, ref.version))!;
    const output: RetrievalDocument[] = [];
    for (let start = 0; start < fragment.content.length; ) {
      let end = Math.min(start + 1200, fragment.content.length);
      // Offsets remain UTF-16, but a window must not split an astral scientific symbol.
      if (end < fragment.content.length && /[\uDC00-\uDFFF]/u.test(fragment.content[end])) end -= 1;
      const content = fragment.content.slice(start, end);
      const text = `${ref.skillId}\n${skill.manifest.title}\n${fragment.assetKind}\n${ref.selector}\n${content}`;
      output.push({
        id: digestCanonical({ ref, start, end, policy: DOCUMENT_POLICY }),
        reference: ref,
        catalogId: grant.id,
        accessScope: grant.access.kind,
        assetKind: fragment.assetKind,
        domains: skill.manifest.domains,
        engines: Object.keys(skill.manifest.engine_compatibility).sort(),
        reviewStatus: skill.manifest.review.status,
        start,
        end,
        contentDigest: digestBytes(text),
        text,
      });
      if (end === fragment.content.length) break;
      start = end - 160;
      if (/[\uDC00-\uDFFF]/u.test(fragment.content[start])) start -= 1;
    }
    return output;
  });
}
