import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

export type FeatureStates = Record<string, boolean>

export type FeatureStatesRead = {
  states: FeatureStates
  error?: unknown
}

const MAX_STATE_FILE_BYTES = 64 * 1024

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

// A toggle file in a shared or foreign-owned directory lets another user
// forge the states this process trusts. XDG_DATA_HOME=/tmp is the realistic
// shape of that risk; the mode and uid of the parent directory reveal it.
function directoryTrustFailure(directory: string): unknown {
  if (process.getuid === undefined) return undefined
  const stats = statSync(directory, { throwIfNoEntry: false })
  if (stats === undefined) return undefined
  const worldOrGroupWritable = (stats.mode & 0o022) !== 0
  if (worldOrGroupWritable) {
    return new Error(`state directory is writable by others: ${directory}`)
  }
  if (stats.uid !== process.getuid()) {
    return new Error(`state directory is owned by another user: ${directory}`)
  }
  return undefined
}

function booleanStatesOf(parsed: unknown): FeatureStates | undefined {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return undefined
  }
  const states: FeatureStates = Object.create(null)
  for (const [featureID, value] of Object.entries(parsed)) {
    if (typeof value === "boolean") states[featureID] = value
  }
  return states
}

function readStateFile(filePath: string): FeatureStatesRead {
  const directoryFailure = directoryTrustFailure(path.dirname(filePath))
  if (directoryFailure) return { states: {}, error: directoryFailure }
  const stats = statSync(filePath, { throwIfNoEntry: false })
  if (stats === undefined) return { states: {} }
  if (!stats.isFile()) {
    return { states: {}, error: new Error("state path is not a file") }
  }
  if (stats.size > MAX_STATE_FILE_BYTES) {
    return { states: {}, error: new Error("state file exceeds 64 KiB") }
  }
  let raw: string
  try {
    raw = readFileSync(filePath, "utf8")
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

export function readFeatureStates(): FeatureStatesRead {
  return readStateFile(resolveEssentialsStatePath())
}

export function isFeatureEnabled(
  states: FeatureStates,
  featureID: string,
): boolean {
  return states[featureID] !== false
}

function writeStateFileAtomically(filePath: string, payload: string) {
  mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 })
  const directoryFailure = directoryTrustFailure(path.dirname(filePath))
  if (directoryFailure) throw directoryFailure
  // A direct writeFileSync at the final path would let a concurrent reader
  // observe the truncated file; rename replaces it in one step. The "wx"
  // flag fails if the path already exists, so a planted symlink cannot
  // redirect this write to another file.
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`
  try {
    writeFileSync(temporaryPath, `${payload}\n`, { flag: "wx", mode: 0o600 })
    renameSync(temporaryPath, filePath)
  } finally {
    if (existsSync(temporaryPath)) rmSync(temporaryPath, { force: true })
  }
}

export function writeFeatureEnabled(featureID: string, enabled: boolean) {
  const filePath = resolveEssentialsStatePath()
  const read = readStateFile(filePath)
  if (read.error) {
    const refusal = new Error(
      `Refusing to overwrite unreadable state file: ${String(read.error)}`,
      { cause: read.error },
    )
    throw refusal
  }
  const payload = JSON.stringify(
    { ...read.states, [featureID]: enabled },
    null,
    2,
  )
  writeStateFileAtomically(filePath, payload)
}
