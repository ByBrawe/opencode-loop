const fs = require('node:fs')
const file = 'scripts/host-adapter-contract-test.mjs'
let text = fs.readFileSync(file, 'utf8')

const replacements = [
  [
    'messagesClient([{ info: { role: "assistant", time: { created: 110, completed: 120 } } }]), "done", { startedAt: 100 },',
    'messagesClient([{ info: { role: "assistant", text: "done", time: { created: 110, completed: 120 } } }]), "done", { startedAt: 100 },',
  ],
  [
    'return { data: [{ info: { role: "assistant", time: { created: 10, completed: 20 } } }] }',
    'return { data: [{ info: { role: "assistant", text: "adapter completed", time: { created: 10, completed: 20 } } }] }',
  ],
]

for (const [before, after] of replacements) {
  if (!text.includes(before)) throw new Error(`host adapter completion fixture marker not found: ${before}`)
  text = text.replace(before, after)
}
fs.writeFileSync(file, text)
console.log('host adapter meaningful-completion fixtures updated')
