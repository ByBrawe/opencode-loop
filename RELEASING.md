# Releasing OpenCode Loop

**Manual publication only.** GitHub Actions workflows were removed to stop runner consumption. Do not restore push, pull-request, scheduled or publish workflows. The published 0.6.10 release is immutable; changing main does not update npm.

## Manual checks

1. Use a clean checkout of the intended main commit and choose a new version. Update package.json, the package-lock root version, numeric release notes and the version-specific release metadata before publishing. Never reuse an existing npm version.
2. Install the project's dependencies locally and run targeted checks. The existing npm run check, npm test and npm run package:smoke commands remain available for a deliberate local release verification. For a strict clean npm consumer, set OPENCODE_PACKAGE_SMOKE_REQUIRE_INSTALL=1. No GitHub runner is needed.
3. Rebuild the checked-in bundles using the repository's existing bundling instructions and compare them to the source. Verify the standalone installer, uninstaller, native server exports and read-only sidebar. For OpenCode 2.4.1 verify matching OpenTUI 0.9.4 and Solid 1.9.17 with Bun; retain older host support only where independently checked. Verify real prompt admission, stop/clear, restart and native Goal ownership. Source or peer-range changes alone do not prove actual runtime behavior.
4. Check the registry latest/predecessor and candidate version, name, source SHA, tarball contents and exports. The old Actions polling command is retired and must fail immediately. Offline registry/source-identity assertions remain in scripts/publish-workflow-test.mjs; the historic native-release helper is version-locked and does not authorize a new release.
5. Only after explicit approval and successful verification, an authorized maintainer may publish with npm's supported authentication. Do not expose credentials, bypass checks, or re-enable Actions to publish. Confirm the actual registry metadata and integrity, then independently install the published tarball and check it against the intended host.

Loop must remain independently installable and releasable. Goal is never an installation or publication dependency. No manual release is authorized by this document alone.
