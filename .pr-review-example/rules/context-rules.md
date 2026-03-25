# Context Rules

Add your project-specific rules here. The LLM will evaluate them against the PR context.

- Rules that require changes to a specific file → use `file_suggestions` in the output.
- Generic rules (coding standards, PR quality, etc.) → reflect them in `reasoning`.

## Examples

- CHANGELOG.md must be updated in every PR.
- Every new feature must include unit tests.
- Breaking changes must be documented in docs/breaking-changes.md.
