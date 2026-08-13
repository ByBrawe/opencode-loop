import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
const file = path.resolve("src/source/legacy-v1.js")
const out = path.resolve("src/source/core/jobs.js")
const s = await readFile(file, "utf8")
const imp = 'import { DEFAULT_GOAL_MAX_NO_PROGRESS, now, safeID, parseDuration, durationToText, splitFirst, stripOuterQuotes, escapeRegExp, takeFlag, takeFlagValue, takeAllFlagValues, parsePositiveInt, parseNonNegativeInt, parseCompactEvery, parseLoopArgs } from "./core/args.js"\n'
const a = s.indexOf("function presetDefaults(name)")
const b = s.indexOf("\nasync function appendLoopLog(directory, line, extra = {})", a)
const c = s.indexOf("function actionKind(action, job = {})", b)
const d = s.indexOf("\nasync function buildGoalPrompt(directory, job)", c)
if (a < 0 || b < 0 || c < 0 || d < 0 || !s.includes(imp)) throw new Error("layout")
let one = s.slice(a, b)
let two = s.slice(c, d)
for (const n of ["presetDefaults","jobLabel","matchJob","actionKind","decoratePrompt","isGoalJob","goalStatusText"]) {
  one = one.replace(`function ${n}(`, `export function ${n}(`)
  two = two.replace(`function ${n}(`, `export function ${n}(`)
}
const mod = 'import { DEFAULT_GOAL_MAX_NO_PROGRESS, parseDuration, durationToText } from "./args.js"\n\n' + one.trim() + "\n\n" + two.trim() + "\n"
const add = 'import { presetDefaults, jobLabel, matchJob, actionKind, decoratePrompt, isGoalJob, goalStatusText } from "./core/jobs.js"\n'
let next = s.slice(0, a) + s.slice(b, c) + s.slice(d)
next = next.replace(imp, imp + add)
await mkdir(path.dirname(out), { recursive: true })
await writeFile(out, mod)
await writeFile(file, next)
