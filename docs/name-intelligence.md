# Package-name intelligence

Name comparison is bounded and heuristic. It reports separate edit-distance, keyboard, separator, duplication/omission, homoglyph, scope, and prefix/suffix signals. Candidates come only from analyzed dependencies, the repository's published names, and the documented popular-package seed; this is not a registry search.

Findings say “possible package-name confusion” or “possible typosquatting indicator”, with `intent: undetermined`. Registry rename/deprecation evidence suppresses legitimate moves. Missing candidates or incomplete coverage remain unknown; absence facts are emitted only after every eligible dependency was compared.
