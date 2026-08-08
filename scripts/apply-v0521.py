from pathlib import Path
import json
import re


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected one match for {old!r}, found {count}")
    p.write_text(text.replace(old, new, 1))


# OpenCode 1.18.x server plugins cannot cancel the command prompt turn.
# Keep a valid prompt for the locked-down local acknowledgement agent instead
# of clearing output.parts and creating an empty command message.
p = Path("src/index.js")
text = p.read_text()
pattern = re.compile(
    r'''  const handled = \(\) => \{\n    if \(output && Array\.isArray\(output\.parts\)\) \{\n(?:.*\n)*?      output\.parts\.length = 0\n    \}\n    return true\n  \}\n'''
)
replacement = '''  const handled = () => {\n    // OpenCode server plugins cannot currently cancel the command prompt turn.\n    // Keep the command markdown acknowledgement intact so opencode-loop-local\n    // receives a valid, tool-denied message instead of an empty parts array.\n    return true\n  }\n'''
text, count = pattern.subn(replacement, text, count=1)
if count != 1:
    raise SystemExit(f"src/index.js: handled() block match count={count}")

old_compact = 'for (const command of ["session_compact", "session.compact"]) {'
if text.count(old_compact) != 1:
    raise SystemExit("src/index.js: compact command sequence changed")
text = text.replace(old_compact, 'for (const command of ["session.compact", "session_compact"]) {', 1)
p.write_text(text)

# Cross-platform failure fixture: no shell-significant parentheses.
replace_once("scripts/comprehensive-test.mjs", "node -e process.exit(7)", "node -e process.exitCode=7")

# Current OpenCode still runs the command prompt after command.execute.before.
# Verify both smoke and comprehensive tests retain valid acknowledgement parts.
replace_once(
    "scripts/smoke-test.mjs",
    '  assert.equal(output.parts.length, 0, "a locally handled slash command must not start a placeholder model turn")',
    '  assert.equal(output.parts.length, 1, "a locally handled slash command must keep a valid acknowledgement prompt")\n  assert.equal(output.parts[0].text, "original command body")',
)
replace_once(
    "scripts/comprehensive-test.mjs",
    '    const beforeReports = h.reportTexts().length\n    await h.command("loop-status")\n    await h.commandEvent("loop-status", "", "msg_status_1")',
    '    const beforeReports = h.reportTexts().length\n    const statusOutput = { parts: [{ type: "text", text: "OpenCode Loop status command handled locally. Reply exactly: OK." }] }\n    await h.command("loop-status", "", statusOutput)\n    assert.equal(statusOutput.parts.length, 1, "handled commands must keep a valid acknowledgement prompt")\n    assert.match(statusOutput.parts[0].text, /Reply exactly: OK/)\n    await h.commandEvent("loop-status", "", "msg_status_1")',
)

package_path = Path("package.json")
package = json.loads(package_path.read_text())
if package.get("version") != "0.5.20":
    raise SystemExit(f"unexpected package version: {package.get('version')}")
package["version"] = "0.5.21"
package.setdefault("devDependencies", {})["@opencode-ai/plugin"] = "^1.18.15"
package_path.write_text(json.dumps(package, indent=2) + "\n")

changelog = Path("CHANGELOG.md")
change_text = changelog.read_text()
entry = """## 0.5.21

- Verified server-plugin compatibility against OpenCode 1.18.15 and updated the development plugin dependency accordingly.
- Stopped clearing `command.execute.before` output parts. Current OpenCode still creates a command prompt turn for server-plugin slash commands, so control commands keep the valid tool-denied `opencode-loop-local` acknowledgement instead of producing an empty message.
- Prefer the current `session.compact` TUI command value while retaining `session_compact` and `session.summarize` as compatibility fallbacks.
- Fixed the comprehensive preflight failure test to use a cross-platform shell-safe Node expression.
- Added Ubuntu and Windows pull-request CI, and hardened npm publishing with full tests, tag/version verification, and `npm pack --dry-run`.
- Retained the v0.5.20 Windows state-write retry hardening and deterministic EPERM/partial-read regressions.

"""
if not change_text.startswith("# Changelog\n"):
    raise SystemExit("unexpected CHANGELOG header")
changelog.write_text("# Changelog\n\n" + entry + change_text[len("# Changelog\n\n"):])

readme = Path("README.md")
readme_text = readme.read_text()
marker = "**v0.5.20 fixes Windows TUI state writes.**"
if marker not in readme_text:
    raise SystemExit("README current-status marker missing")
status = (
    "**v0.5.21 targets current OpenCode 1.18.x compatibility and safer releases.** "
    "Server-plugin control commands keep their locked-down acknowledgement prompt instead of creating an empty command message, "
    "`/compact` prefers the current `session.compact` TUI command, and CI now covers Ubuntu and Windows before publishing. "
    + marker
)
readme.write_text(readme_text.replace(marker, status, 1))

Path(".github/workflows/publish-npm.yml").write_text("""name: Publish to npm

on:
  push:
    tags:
      - "v*"

permissions:
  contents: read
  id-token: write

jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - uses: actions/setup-node@v6
        with:
          node-version: "24"
          registry-url: "https://registry.npmjs.org"
          cache: npm
      - run: npm ci
      - name: Verify tag matches package version
        shell: bash
        run: |
          TAG_VERSION="${GITHUB_REF_NAME#v}"
          PACKAGE_VERSION="$(node -p \"require('./package.json').version\")"
          test "$TAG_VERSION" = "$PACKAGE_VERSION"
      - run: npm run check
      - run: npm test
      - run: npm pack --dry-run
      - run: npm publish --access public
""")

Path(".github/workflows/ci.yml").write_text("""name: CI

on:
  pull_request:
  push:
    branches:
      - main

permissions:
  contents: read

jobs:
  test:
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, windows-latest]
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v6
      - uses: actions/setup-node@v6
        with:
          node-version: "24"
          cache: npm
      - run: npm ci
      - run: npm run check
      - run: npm test
""")
