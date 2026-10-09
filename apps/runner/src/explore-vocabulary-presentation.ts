import { formatExploreVocabularyCoverage, type ExploreVocabularyResource } from "./explore-vocabulary.js";

/** Optional display metadata; this view makes no meaning or authority assessment. */
export function exploreVocabularyPresentation(resource: ExploreVocabularyResource): {
  summary: string;
  detail: string;
} {
  return {
    summary: formatExploreVocabularyCoverage(resource),
    detail: "Labels and descriptions do not establish business meaning or permission.",
  };
}
