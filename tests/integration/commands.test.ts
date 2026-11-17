import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { runCtl } from "../../src/adapter/opencode/ctl"
import { createStore } from "../../src/adapter/opencode/store"

function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), "ctl-render-"))
  mkdirSync(path.join(dir, ".opencode"), { recursive: true })
  writeFileSync(
    path.join(dir, ".opencode", "rollover.json"),
    JSON.stringify({ mode: "auto", thresholdTokens: 200_000, renderBudgetTokens: 4000, extractionModel: "test/model" }),
  )
  const store = createStore({ dataDir: path.join(dir, ".opencode", "rollover") })
  const deps = {
    store,
    homeConfigDir: dir,
    projectDir: dir,
    env: {} as Record<string, string | undefined>,
    modelLimits: new Map<string, number>([["s1", 1_000_000]]),
    lastMessages: new Map(),
  }
  return { dir, store, deps }
}

describe("/rollover --render", () => {
  test("stores the per-session budget and implies activation", async () => {
    const { dir, store, deps } = setup()
    try {
      await runCtl(deps, "s1", "--render 10k")
      expect((await store.readState("s1"))?.settings).toEqual({ renderBudgetTokens: 10_000, enabled: true })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("status shows the session budget over the config value", async () => {
    const { dir, store, deps } = setup()
    try {
      await store.writeState("s1", {
        v: 1,
        sessionId: "s1",
        settings: { enabled: true, renderBudgetTokens: 10_000 },
        epoch: 0,
        extractedUntilMessageId: null,
        lastContextTokens: 0,
        lastContextSource: "estimate",
        lastContextAt: 0,
        rollover: null,
        decidedUserMessageIds: [],
        consolidatedAtRecordCount: 0,
        touchedFiles: {},
      })
      const text = await runCtl(deps, "s1", "status")
      expect(text).toContain("/ 10k")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("below the minimum is rejected without touching settings", async () => {
    const { dir, store, deps } = setup()
    try {
      const text = await runCtl(deps, "s1", "--render 500")
      expect(text).toContain("Render budget must be at least 1k.")
      expect((await store.readState("s1"))?.settings).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
