export type HistoryClassification =
  | 'exact_commit'
  | 'acceptable_ancestor_or_window'
  | 'correct_relationship'
  | 'correct_manifest'
  | 'unknown_ground_truth'
  | 'ambiguous_history'
  | 'incorrect';
export interface HistoryValidationInput {
  observed: { commit_sha?: string; relationship?: string; path?: string; history_status?: string };
  truth: { commit?: string; relationship?: string; path?: string; ambiguous?: boolean };
}
export function classifyHistory(
  input: HistoryValidationInput,
): Record<string, HistoryClassification> {
  const out: Record<string, HistoryClassification> = {};
  if (input.truth.ambiguous) out.introduction_commit = 'unknown_ground_truth';
  else if (!input.observed.commit_sha) out.introduction_commit = 'unknown_ground_truth';
  else
    out.introduction_commit =
      input.observed.commit_sha === input.truth.commit
        ? 'exact_commit'
        : input.observed.history_status === 'history_partial'
          ? 'acceptable_ancestor_or_window'
          : 'incorrect';
  out.relationship =
    input.observed.relationship && input.truth.relationship
      ? input.observed.relationship === input.truth.relationship
        ? 'correct_relationship'
        : 'incorrect'
      : 'ambiguous_history';
  out.manifest =
    input.observed.path && input.truth.path
      ? input.observed.path === input.truth.path
        ? 'correct_manifest'
        : 'incorrect'
      : 'ambiguous_history';
  return out;
}
