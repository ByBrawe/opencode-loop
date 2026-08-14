import assert from "node:assert/strict"
import { createOpenCode2HostContract } from "../src/source/opencode2/host-contract.js"

assert.equal(typeof createOpenCode2HostContract, "function")
