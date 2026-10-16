# Build-system sources

The Bazel, Nix, and Buck readers are bounded structural readers. They do not evaluate Starlark, Nix, macros, imports, concatenation, or generated files. Remote URLs, refs, checksums, lock revisions, dynamic syntax, target counts, and safe declared paths are reported in `build_sources`.

HTTP URLs, mutable refs, missing hashes, and unpinned remote sources are informational findings. A path supplied by repository content is never a trust root and is accepted only through the existing retrieval path-safety checks.
