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
import type { FeatureId } from "./valueObject/featureId.ts"
import type { FeatureStates } from "./valueObject/featureStates.ts"
import { newAbsolutePath } from "./valueObject/absolutePath.ts"
import { newFeatureStates } from "./valueObject/featureStates.ts"

export type { FeatureStates } from "./valueObject/featureStates.ts"

export type FeatureStatesRead = {
  states: FeatureStates
  error?: unknown
}

const MAX_STATE_FILE_BYTES = 64 * 1024

export function resolveEssentialsStatePath(): string {
  const fallbackDataHome = path.join(homedir(), ".local", "share")
  const configuredDataHome = newAbsolutePath(process.env["XDG_DATA_HOME"])
  const dataHome = configuredDataHome ?? fallbackDataHome
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
  const directoryStats = statSync(directory, { throwIfNoEntry: false })
  if (directoryStats === undefined) return undefined
  const worldOrGroupWritable = (directoryStats.mode & 0o022) !== 0
  if (worldOrGroupWritable) {
    return new Error(`state directory is writable by others: ${directory}`)
  }
  if (directoryStats.uid !== process.getuid()) {
    return new Error(`state directory is owned by another user: ${directory}`)
  }
  return undefined
}

function readStateFile(filePath: string): FeatureStatesRead {
  const directoryFailure = directoryTrustFailure(path.dirname(filePath))
  if (directoryFailure) return { states: {}, error: directoryFailure }
  const fileStats = statSync(filePath, { throwIfNoEntry: false })
  if (fileStats === undefined) return { states: {} }
  if (!fileStats.isFile()) {
    return { states: {}, error: new Error("state path is not a file") }
  }
  if (fileStats.size > MAX_STATE_FILE_BYTES) {
    return { states: {}, error: new Error("state file exceeds 64 KiB") }
  }
  let fileContents: string
  try {
    fileContents = readFileSync(filePath, "utf8")
  } catch (failure) {
    if (isMissingFileError(failure)) return { states: {} }
    return { states: {}, error: failure }
  }
  let parsedDocument: unknown
  try {
    parsedDocument = JSON.parse(fileContents)
  } catch (failure) {
    return { states: {}, error: failure }
  }
  const states = newFeatureStates(parsedDocument)
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
  featureId: FeatureId,
): boolean {
  return states[featureId] !== false
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

export function writeFeatureEnabled(featureId: FeatureId, enabled: boolean) {
  const filePath = resolveEssentialsStatePath()
  const statesRead = readStateFile(filePath)
  if (statesRead.error) {
    const refusal = new Error(
      `Refusing to overwrite unreadable state file: ${String(statesRead.error)}`,
      { cause: statesRead.error },
    )
    throw refusal
  }
  const payload = JSON.stringify(
    { ...statesRead.states, [featureId]: enabled },
    null,
    2,
  )
  writeStateFileAtomically(filePath, payload)
}
