import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

export type FeatureStates = Record<string, boolean>

export type FeatureStatesRead = {
  states: FeatureStates
  error?: unknown
}

export function resolveEssentialsStatePath(): string {
  const localShare = path.join(homedir(), ".local", "share")
  const fromEnv = process.env["XDG_DATA_HOME"]
  const dataHome = fromEnv && path.isAbsolute(fromEnv) ? fromEnv : localShare
  return path.join(dataHome, "opencode", "essentials.json")
}

function isMissingFileError(failure: unknown): boolean {
  if (typeof failure !== "object" || failure === null) return false
  return (failure as { code?: unknown }).code === "ENOENT"
}

function booleanStatesOf(parsed: unknown): FeatureStates | undefined {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return undefined
  }
  const states: FeatureStates = {}
  for (const [featureID, value] of Object.entries(parsed)) {
    if (typeof value === "boolean") states[featureID] = value
  }
  return states
}

export function readFeatureStates(): FeatureStatesRead {
  let raw: string
  try {
    raw = readFileSync(resolveEssentialsStatePath(), "utf8")
  } catch (failure) {
    if (isMissingFileError(failure)) return { states: {} }
    return { states: {}, error: failure }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (failure) {
    return { states: {}, error: failure }
  }
  const states = booleanStatesOf(parsed)
  if (states === undefined) {
    return { states: {}, error: new Error("state file is not a JSON object") }
  }
  return { states }
}

export function isFeatureEnabled(
  states: FeatureStates,
  featureID: string,
): boolean {
  return states[featureID] !== false
}

export function writeFeatureEnabled(featureID: string, enabled: boolean) {
  const filePath = resolveEssentialsStatePath()
  mkdirSync(path.dirname(filePath), { recursive: true })
  const payload = JSON.stringify(
    { ...readFeatureStates().states, [featureID]: enabled },
    null,
    2,
  )
  // Rename replaces the file in one step; a plain rewrite would let a
  // concurrent reader observe the truncated file.
  const temporaryPath = `${filePath}.${process.pid}.tmp`
  writeFileSync(temporaryPath, `${payload}\n`)
  renameSync(temporaryPath, filePath)
}
