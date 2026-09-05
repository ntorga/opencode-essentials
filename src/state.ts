import {
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
import type { EssentialsConfig } from "./valueObject/essentialsConfig.ts"
import {
  newDefaultEssentialsConfig,
  parseEssentialsConfig,
  serializeEssentialsConfig,
} from "./valueObject/essentialsConfig.ts"
import type { IdleTimeoutMs } from "./valueObject/idleTimeoutMs.ts"
import { newAbsolutePath } from "./valueObject/absolutePath.ts"

export type { EssentialsConfig } from "./valueObject/essentialsConfig.ts"

export type EssentialsConfigRead = {
  config: EssentialsConfig
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
function validateDirectoryTrust(directory: string): unknown {
  if (process.getuid === undefined) return undefined
  const directoryStats = statSync(directory, { throwIfNoEntry: false })
  if (directoryStats === undefined) return undefined
  const worldOrGroupWritable = (directoryStats.mode & 0o022) !== 0
  if (worldOrGroupWritable) {
    return new Error(`StateDirectoryWritable: ${directory}`)
  }
  if (directoryStats.uid !== process.getuid()) {
    return new Error(`StateDirectoryForeignOwner: ${directory}`)
  }
  return undefined
}

function readStateFile(filePath: string): EssentialsConfigRead {
  const directoryFailure = validateDirectoryTrust(path.dirname(filePath))
  if (directoryFailure) {
    return { config: newDefaultEssentialsConfig(), error: directoryFailure }
  }
  const fileStats = statSync(filePath, { throwIfNoEntry: false })
  if (fileStats === undefined) return { config: newDefaultEssentialsConfig() }
  if (!fileStats.isFile()) {
    return {
      config: newDefaultEssentialsConfig(),
      error: new Error(`StatePathNotFile: ${filePath}`),
    }
  }
  if (fileStats.size > MAX_STATE_FILE_BYTES) {
    return {
      config: newDefaultEssentialsConfig(),
      error: new Error(`StateFileOversized: ${filePath}`),
    }
  }
  let fileContents: string
  try {
    fileContents = readFileSync(filePath, "utf8")
  } catch (failure) {
    if (isMissingFileError(failure)) {
      return { config: newDefaultEssentialsConfig() }
    }
    return { config: newDefaultEssentialsConfig(), error: failure }
  }
  let parsedDocument: unknown
  try {
    parsedDocument = JSON.parse(fileContents)
  } catch (failure) {
    return { config: newDefaultEssentialsConfig(), error: failure }
  }
  const config = parseEssentialsConfig(parsedDocument)
  if (config === undefined) {
    return {
      config: newDefaultEssentialsConfig(),
      error: new Error(`StateFileUnrecognizable: ${filePath}`),
    }
  }
  return { config }
}

export function readEssentialsConfig(): EssentialsConfigRead {
  return readStateFile(resolveEssentialsStatePath())
}

export function isFeatureChosen(
  config: EssentialsConfig,
  featureId: FeatureId,
): boolean {
  return config.states[featureId] !== false
}

export function isFeatureEnabled(
  config: EssentialsConfig,
  featureId: FeatureId,
): boolean {
  if (!config.isEnabled) return false
  return isFeatureChosen(config, featureId)
}

export function resolveEffectiveIdleTimeoutMs(
  config: EssentialsConfig,
  featureId: FeatureId,
  fallbackMs: IdleTimeoutMs,
): IdleTimeoutMs {
  return config.timeouts[featureId] ?? fallbackMs
}

function writeStateFileAtomically(filePath: string, payload: string) {
  mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 })
  const directoryFailure = validateDirectoryTrust(path.dirname(filePath))
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
    rmSync(temporaryPath, { force: true })
  }
}

function mutateEssentialsConfig(
  mutate: (config: EssentialsConfig) => void,
) {
  const filePath = resolveEssentialsStatePath()
  const configRead = readStateFile(filePath)
  if (configRead.error) {
    const refusal = new Error(
      `StateWriteRefused: ${String(configRead.error)}`,
      { cause: configRead.error },
    )
    throw refusal
  }
  mutate(configRead.config)
  const payload = serializeEssentialsConfig(configRead.config)
  if (payload.length > MAX_STATE_FILE_BYTES) {
    throw new Error(`StateWriteOversized: ${String(payload.length)} bytes`)
  }
  writeStateFileAtomically(filePath, payload)
}

export function writeFeatureEnabled(
  featureId: FeatureId,
  enabled: boolean,
) {
  mutateEssentialsConfig((config) => {
    config.states[featureId] = enabled
  })
}

export function writeGlobalEnabled(enabled: boolean) {
  mutateEssentialsConfig((config) => {
    config.isEnabled = enabled
  })
}

export function writeIdleTimeoutMs(
  featureId: FeatureId,
  timeout: IdleTimeoutMs,
) {
  mutateEssentialsConfig((config) => {
    config.timeouts[featureId] = timeout
  })
}

export function clearIdleTimeoutMs(featureId: FeatureId) {
  mutateEssentialsConfig((config) => {
    delete config.timeouts[featureId]
  })
}
