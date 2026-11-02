# Releasing

Versions follow [SemVer](https://semver.org). A version is in `packages/cli/package.json` and `server.json`, and each
release has a tag `vX.Y.Z`.

1. Add the release to `CHANGELOG.md`: what changed in plain words, and any publicly known vulnerability it fixes, with
   its CVE if it has one. If there are none, say nothing more.
2. Update the version in both files.
3. Check that `npm run typecheck` and `npm test` pass, and that CodeQL has no open finding of medium or higher.
4. Tag the public repository's commit `vX.Y.Z` and publish a GitHub release with the changelog text.

`main` moves between releases, and the hosted service runs a recent `main`. Self-hosters who want a fixed point should
use a tag.
