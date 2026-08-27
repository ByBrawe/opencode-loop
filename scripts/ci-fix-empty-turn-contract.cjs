const fs = require('node:fs')
const file = 'scripts/host-adapter-contract-test.mjs'
let text = fs.readFileSync(file, 'utf8')
const before = 'messagesClient([{ info: { role: "assistant", time: { created: 110, completed: 120 } } }]), "done", { startedAt: 100 },'
const after = 'messagesClient([{ info: { role: "assistant", text: "done", time: { created: 110, completed: 120 } } }]), "done", { startedAt: 100 },'
if (!text.includes(before)) throw new Error('host adapter completion fixture marker not found')
text = text.replace(before, after)
fs.writeFileSync(file, text)
console.log('host adapter meaningful-completion fixture updated')
