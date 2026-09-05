declare const validatedInput: unique symbol

// The brand admits no raw value: only the constructors in this package,
// which run the token through a pattern and cast after validation, can
// produce one. The restructure that failed is a plain alias —
// `type SessionId = string` would accept any string the moment a caller
// forgets the constructor.
export type ValidatedString<Token extends string> = string & {
  readonly [validatedInput]: Token
}

export type ValidatedNumber<Token extends string> = number & {
  readonly [validatedInput]: Token
}

export function newValidated<Token extends string>(
  rawValue: unknown,
  pattern: RegExp,
): ValidatedString<Token> | undefined {
  if (typeof rawValue !== "string") return undefined
  if (!pattern.test(rawValue)) return undefined
  return rawValue as ValidatedString<Token>
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

// Model tokens legitimately contain separators ("hyper/qwen3.8-flash") but
// never whitespace or control characters. They travel in a JSON body, not a
// path, so the pattern guards shape, not traversal.
export const MODEL_TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/
