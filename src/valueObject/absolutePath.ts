import path from "node:path"

// A relative data home would resolve against whatever directory OpenCode
// happens to run in, scattering the toggle file. Only absolute paths pass.
export function newAbsolutePath(rawValue: unknown): string | undefined {
  if (typeof rawValue !== "string") return undefined
  if (!path.isAbsolute(rawValue)) return undefined
  return rawValue
}
