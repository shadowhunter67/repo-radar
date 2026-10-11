/**
 * The words that must accompany every regulatory/readiness output. They are part of the report contract (tests assert
 * their presence), not decoration.
 */
export const LEGAL_DISCLAIMER =
  'repo-radar performs technical readiness and applicability analysis from repository evidence. It does not provide legal advice and does not determine legal compliance or non-compliance. Repository contents alone may be insufficient to decide whether a regulation applies: deployment context, the role of the organization, jurisdiction and the commercial distribution context all matter. An indicator that is "not observed" means no evidence was found in the analyzed repository revision, not that a control is absent.';

export const LEGAL_DETERMINATION = 'not_provided' as const;

/** Statuses an indicator can take; none of them is a legal verdict. */
export const INDICATOR_STATUSES = ['observed', 'partial', 'not_observed', 'unknown'] as const;
export type IndicatorStatus = (typeof INDICATOR_STATUSES)[number];
