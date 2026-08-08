from pathlib import Path
import json


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected one match, found {count}")
    p.write_text(text.replace(old, new, 1))


replace_once(
    "src/index.js",
    '''  const handled = () => {
    // OpenCode server plugins cannot currently cancel the command prompt turn.
    // Keep the command markdown acknowledgement intact so opencode-loop-local
    // receives a valid, tool-denied message instead of an empty parts array.
    return true
  }
''',
    '''  const handled = () => {
    // OpenCode 1.18.x ignores unknown hook output fields, while proposed/newer
    // hosts can honor noReply to skip the otherwise unavoidable model turn.
    // Keep acknowledgement parts intact as the compatibility fallback.
    if (output && typeof output === "object") output.noReply = true
    return true
  }
''',
)

replace_once(
    "scripts/smoke-test.mjs",
    '''  assert.equal(output.parts.length, 1, "a locally handled slash command must keep a valid acknowledgement prompt")
  assert.equal(output.parts[0].text, "original command body")
''',
    '''  assert.equal(output.parts.length, 1, "a locally handled slash command must keep a valid acknowledgement prompt")
  assert.equal(output.parts[0].text, "original command body")
  assert.equal(output.noReply, true, "handled commands should request noReply for compatible OpenCode hosts")
''',
)

package_path = Path("package.json")
package = json.loads(package_path.read_text())
if package.get("version") != "0.5.21":
    raise SystemExit(f"unexpected package version: {package.get('version')}")
package["version"] = "0.5.22"
package["devDependencies"]["@opencode-ai/plugin"] = "^1.18.15"
package_path.write_text(json.dumps(package, indent=2) + "\n")

changelog = Path("CHANGELOG.md")
text = changelog.read_text()
entry = '''## 0.5.22

- Hardened compatibility with current OpenCode 1.18.15 while preserving the existing `>=1.4.0` peer range.
- Handled loop commands now also set `output.noReply = true`; OpenCode 1.18.x safely ignores the unknown field, while hosts that add the proposed `noReply` hook support can skip the acknowledgement model turn automatically.
- Added Bun runtime loading coverage so CI exercises the runtime OpenCode actually uses to load plugins, not only Node syntax/tests.
- Added explicit minimum-peer coverage against `@opencode-ai/plugin@1.4.0` and scheduled testing against the latest published OpenCode plugin package.
- Kept the v0.5.21 server-plugin acknowledgement fallback for current OpenCode versions where `command.execute.before` cannot cancel the prompt turn.

'''
if not text.startswith("# Changelog\n\n"):
    raise SystemExit("unexpected changelog header")
changelog.write_text("# Changelog\n\n" + entry + text[len("# Changelog\n\n"):])

readme = Path("README.md")
text = readme.read_text()
marker = "**v0.5.21 targets current OpenCode 1.18.x compatibility and safer releases.**"
if marker not in text:
    raise SystemExit("README v0.5.21 marker missing")
replacement = (
    "**v0.5.22 adds forward-compatible OpenCode command handling plus Bun and peer-range compatibility CI.** "
    + marker
)
readme.write_text(text.replace(marker, replacement, 1))
