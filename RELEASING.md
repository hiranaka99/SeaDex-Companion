# Release process

1. Update `version` in the root and frontend package manifests and lockfiles.
2. Add the release notes to `CHANGELOG.md`.
3. Run `npm ci`, `npm ci --prefix frontend`, `npm test`, and `npm run build`.
4. Build and smoke-test the production image.
5. Scan the image and resolve all critical and high vulnerabilities.
6. Merge through a pull request with the CI workflow passing.
7. Create and push an annotated semantic-version tag such as `v1.0.1`.
8. The release workflow publishes immutable version tags, `latest`, provenance, an SBOM, and the image digest.
9. Record the published digest in the GitHub release notes.

Rollback by deploying the previous immutable version tag or digest. Never use `latest` when deterministic rollback is required.
