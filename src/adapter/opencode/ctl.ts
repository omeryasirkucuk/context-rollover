/** `/rollover` command + `rollover_ctl` tool executor (spec §9). */
import { activeRecords } from "../../core/ledger"
import { packLedger } from "../../core/packer"
import { estimateTokens } from "../../core/tokens"
import { showText, statusText, ERR_CTL } from "../../core/messages"
import { parseCommand, validateSettings } from "../../core/commands"
import { effectiveThreshold } from "../../core/threshold"
import { loadConfig, withSessionSettings } from "../../core/config"
import { contextInfoFor, ensureState } from "./hooks"
import type { LedgerLine, NMessage, RolloverConfig, SessionState } from "../../core/types"
import type { StorePort } from "../../core/ports"

export interface CtlDeps {
  store: Pick<StorePort, "readState" | "writeState" | "readLedger">
  homeConfigDir: string
  projectDir: string
  env: Record<string, string | undefined>
  modelLimits: Map<string, number>
  lastMessages: Map<string, NMessage[]>
  /** Session model label used only when no extraction model is configured. */
  sessionModel?: (sid: string) => string | null
}

export async function runCtl(deps: CtlDeps, sid: string, text: string): Promise<string> {
  try {
    return await executeCtl(deps, sid, text)
  } catch (error) {
    return ERR_CTL(String(error))
  }
}

async function executeCtl(deps: CtlDeps, sid: string, text: string): Promise<string> {
  const cfg = loadConfig({ homeConfigDir: deps.homeConfigDir, projectDir: deps.projectDir, env: deps.env })
  const parsed = parseCommand(text)

  if (parsed.kind === "status") return readStatus(deps, cfg, sid)
  if (parsed.kind === "show") return readShow(deps, cfg, sid, parsed.raw === true)

  // Per-session opt-in (2026-11-17): on/off writes `settings.enabled`, which
  // wins over every config layer for THIS session only. Fresh sessions start
  // disabled (the built-in config default is off); `/rollover on` turns the
  // full pipeline on for this chat alone.
  if (parsed.kind === "enable" || parsed.kind === "disable") {
    const current = await ensureState(deps.store, sid)
    const updated: SessionState = {
      ...current,
      settings: { ...current.settings, enabled: parsed.kind === "enable" },
    }
    await deps.store.writeState(sid, updated)
    return statusFor(deps, withSessionSettings(cfg, updated), updated, sid, await deps.store.readLedger(sid))
  }

  // Settings commands (<N>, -n) imply activation (user ruling 2026-11-17):
  // giving values means "run rollover with these", so they also write
  // settings.enabled = true — on an already-enabled session this only updates
  // the values, and on a disabled one (explicitly or by default) it turns the
  // pipeline on. /rollover on|off stay the pure toggles.
  const validated = validateSettings(parsed, {
    thresholdMinTokens: cfg.thresholdMinTokens,
    modelLimit: deps.modelLimits.get(sid) ?? null,
    tailMaxN: cfg.tailMaxN,
  })
  if (!validated.ok) return validated.message

  // Store methods take the per-session lock themselves; nesting them inside
  // withSessionLock would deadlock because the lock is not reentrant.
  const current = await ensureState(deps.store, sid)
  const updated: SessionState = {
    ...current,
    settings: { ...current.settings, ...validated.settings, enabled: true },
  }
  await deps.store.writeState(sid, updated)
  return statusFor(deps, withSessionSettings(cfg, updated), updated, sid, await deps.store.readLedger(sid))
}

async function readStatus(deps: CtlDeps, cfg: RolloverConfig, sid: string): Promise<string> {
  const state = await ensureState(deps.store, sid)
  return statusFor(deps, withSessionSettings(cfg, state), state, sid, await deps.store.readLedger(sid))
}

function statusFor(deps: CtlDeps, cfg: RolloverConfig, state: SessionState, sid: string, lines: LedgerLine[]): string {
  const messages = deps.lastMessages.get(sid) ?? []
  const packed = packFor(cfg, state, lines, messages)
  const context = contextInfoFor(state, messages)
  const threshold = effectiveThreshold({
    cfg,
    sessionOverride: state.settings.thresholdTokens,
    modelLimit: deps.modelLimits.get(sid),
  })
  return statusText({
    mode: cfg.mode,
    thresholdValue: threshold.value,
    thresholdSource: threshold.source,
    modelLimit: deps.modelLimits.get(sid) ?? null,
    contextTokens: context.tokens,
    tailN: Math.min(cfg.tailMaxN, state.settings.tailN ?? cfg.tailN),
    summaryModel: cfg.extractionModel ?? deps.sessionModel?.(sid) ?? null,
    recordCount: activeRecords(lines).length,
    epoch: state.epoch,
    renderTokens: estimateTokens(packed.text),
    renderBudgetTokens: cfg.renderBudgetTokens,
    lastRollover: state.lastRollover
      ? { before: state.lastRollover.before, after: state.lastRollover.after, at: state.lastRollover.at }
      : null,
  })
}

async function readShow(deps: CtlDeps, cfg: RolloverConfig, sid: string, raw: boolean): Promise<string> {
  const state = await ensureState(deps.store, sid)
  const lines = await deps.store.readLedger(sid)
  const packed = packFor(cfg, state, lines, deps.lastMessages.get(sid) ?? [])
  const counts: Record<string, number> = {}
  for (const record of activeRecords(lines)) counts[record.type] = (counts[record.type] ?? 0) + 1
  return showText({
    renderText: packed.text,
    renderTokens: estimateTokens(packed.text),
    renderBudgetTokens: cfg.renderBudgetTokens,
    epoch: state.epoch,
    counts,
    truncated: packed.truncated,
    raw,
  })
}

function packFor(cfg: RolloverConfig, state: SessionState, lines: LedgerLine[], messages: NMessage[]) {
  const lastReply =
    messages
      .filter((m) => m.role === "assistant")
      .flatMap((m) => m.parts.filter((p) => p.type === "text").map((p) => p.text ?? ""))
      .filter((text) => text.trim() !== "")
      .at(-1) ?? ""
  return packLedger({
    lines,
    epochAtSwap: state.epoch,
    touchedFiles: state.touchedFiles,
    lastReply: lastReply.slice(0, 1500),
    tailLastReply: null,
    budgetTokens: cfg.renderBudgetTokens,
  })
}
