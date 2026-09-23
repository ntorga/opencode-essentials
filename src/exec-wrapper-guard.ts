/*
 * The hook has no agent identity. Specific deny and ask rules combine across
 * profiles, so one profile can block a command that another allows. OpenCode
 * still applies each profile's default rules. The hook cannot create a prompt;
 * ask rules require the user to run the inner command unwrapped.
 *
 * V1 unwraps natural bash wrappers and shell -c scripts. It does not inspect
 * python -c, node -e, perl -e, awk system(), go run, make, npm run, script
 * files, runtime variable expansion, xargs, or parallel. The devbox contains
 * those execution paths.
 */
import { readFile, stat } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import type { Plugin, PluginInput } from "@opencode-ai/plugin"
import type { Node, Parser } from "web-tree-sitter"
import { writeLog } from "./log.ts"
import { isRecord } from "./valueObject/util.ts"

type PermissionAction = "allow" | "ask" | "deny"

type BashRule = {
  pattern: string
  action: PermissionAction
}

type AgentRules = Map<string, BashRule[]>

type RuleCache = {
  modifiedAt: number
  size: number
  rules: AgentRules | undefined
}

type RuleSource = {
  client: PluginInput["client"]
  configPath: string
  cache: RuleCache | undefined
}

type InnerCommand = {
  command: string
  innermostCommand: string
}

type WrapperRule = {
  head: string
  argumentSkipper: (args: readonly string[]) => string[]
  isShell: boolean
}

const FAIL_OPEN_ON_EVALUATION_ERROR = true

function isPermissionAction(value: unknown): value is PermissionAction {
  return value === "allow" || value === "ask" || value === "deny"
}

function parseBashRules(rawValue: unknown): BashRule[] {
  if (typeof rawValue === "string") {
    if (!isPermissionAction(rawValue)) {
      throw new Error(`Invalid bash permission action: ${rawValue}`)
    }
    return [{ pattern: "*", action: rawValue }]
  }
  if (!isRecord(rawValue)) throw new Error("Invalid bash permission map")

  return Object.entries(rawValue).map(([pattern, rawAction]) => {
    if (!isPermissionAction(rawAction)) {
      throw new Error(`Invalid bash permission action: ${String(rawAction)}`)
    }
    return { pattern, action: rawAction }
  })
}

function parseAgentRules(rawConfig: unknown): AgentRules {
  if (!isRecord(rawConfig)) throw new Error("Invalid OpenCode config")
  if (rawConfig.agent === undefined) return new Map()
  if (!isRecord(rawConfig.agent)) {
    throw new Error("Invalid OpenCode agent map")
  }

  const rules = new Map<string, BashRule[]>()
  for (const [agentName, rawAgent] of Object.entries(rawConfig.agent)) {
    if (!isRecord(rawAgent) || !isRecord(rawAgent.permission)) continue
    const rawBashRules = rawAgent.permission.bash
    if (rawBashRules === undefined) continue
    rules.set(agentName, parseBashRules(rawBashRules))
  }
  return rules
}

function isMissingFileFailure(failure: unknown): boolean {
  return isRecord(failure) && failure.code === "ENOENT"
}

function isMatchingFileVersion(
  cache: RuleCache | undefined,
  fileStats: Awaited<ReturnType<typeof stat>>,
) {
  return (
    cache?.modifiedAt === fileStats.mtimeMs && cache.size === fileStats.size
  )
}

async function refreshAgentRules(
  source: RuleSource,
): Promise<AgentRules | undefined> {
  let fileStats: Awaited<ReturnType<typeof stat>>
  try {
    fileStats = await stat(source.configPath)
  } catch (failure) {
    if (!isMissingFileFailure(failure)) throw failure
    source.cache = undefined
    return undefined
  }

  if (isMatchingFileVersion(source.cache, fileStats)) {
    return source.cache?.rules
  }

  const fileContents = await readFile(source.configPath, "utf8")
  let rules: AgentRules | undefined
  try {
    rules = parseAgentRules(JSON.parse(fileContents))
  } catch (failure) {
    source.cache = {
      modifiedAt: fileStats.mtimeMs,
      size: fileStats.size,
      rules: undefined,
    }
    throw failure
  }

  source.cache = {
    modifiedAt: fileStats.mtimeMs,
    size: fileStats.size,
    rules,
  }
  return rules
}

function canonicalizeWindowsCase(character: string): string {
  const uppercase = character.toUpperCase()
  if (uppercase.length !== 1) return character
  const inputCodeUnit = character.charCodeAt(0)
  const uppercaseCodeUnit = uppercase.charCodeAt(0)
  if (inputCodeUnit >= 128 && uppercaseCodeUnit < 128) return character
  return uppercase
}

function literalCharactersMatch(
  inputCharacter: string,
  patternCharacter: string,
  ignoreCase: boolean,
): boolean {
  if (!ignoreCase) return inputCharacter === patternCharacter
  return (
    canonicalizeWindowsCase(inputCharacter) ===
    canonicalizeWindowsCase(patternCharacter)
  )
}

function readWildcardMatchState(
  matchStates: readonly boolean[],
  position: number,
): boolean {
  const matchState = matchStates[position]
  if (matchState === undefined) {
    throw new Error(`Missing wildcard match state at position ${position}`)
  }
  return matchState
}

function globMatches(
  input: string,
  pattern: string,
  ignoreCase: boolean,
): boolean {
  let matchingPrefixes = new Array<boolean>(input.length + 1).fill(false)
  matchingPrefixes[0] = true

  for (
    let patternPosition = 0;
    patternPosition < pattern.length;
    patternPosition++
  ) {
    const patternCharacter = pattern.charAt(patternPosition)
    const nextMatchingPrefixes = new Array<boolean>(input.length + 1).fill(
      false,
    )
    if (patternCharacter === "*") {
      nextMatchingPrefixes[0] = readWildcardMatchState(matchingPrefixes, 0)
      for (
        let inputPosition = 1;
        inputPosition <= input.length;
        inputPosition++
      ) {
        const starMatchesNoMoreCharacters = readWildcardMatchState(
          matchingPrefixes,
          inputPosition,
        )
        const starMatchesOneMoreCharacter = readWildcardMatchState(
          nextMatchingPrefixes,
          inputPosition - 1,
        )
        nextMatchingPrefixes[inputPosition] =
          starMatchesNoMoreCharacters || starMatchesOneMoreCharacter
      }
      matchingPrefixes = nextMatchingPrefixes
      continue
    }

    for (
      let inputPosition = 1;
      inputPosition <= input.length;
      inputPosition++
    ) {
      const matchedPriorCharacters = readWildcardMatchState(
        matchingPrefixes,
        inputPosition - 1,
      )
      if (!matchedPriorCharacters) continue
      if (patternCharacter === "?") {
        nextMatchingPrefixes[inputPosition] = true
        continue
      }
      nextMatchingPrefixes[inputPosition] = literalCharactersMatch(
        input.charAt(inputPosition - 1),
        patternCharacter,
        ignoreCase,
      )
    }
    matchingPrefixes = nextMatchingPrefixes
  }

  return readWildcardMatchState(matchingPrefixes, input.length)
}

// Mirrors Wildcard.match: slash normalization, * and ?, case-insensitive
// matching on Windows, and optional trailing command arguments.
function wildcardMatches(input: string, pattern: string): boolean {
  const normalizedInput = input.replaceAll("\\", "/")
  const normalizedPattern = pattern.replaceAll("\\", "/")
  const ignoreCase = process.platform === "win32"
  if (
    normalizedPattern.endsWith(" *") &&
    globMatches(normalizedInput, normalizedPattern.slice(0, -2), ignoreCase)
  ) {
    return true
  }
  return globMatches(normalizedInput, normalizedPattern, ignoreCase)
}

function lastSpecificRule(
  command: string,
  rules: BashRule[],
): BashRule | undefined {
  // Permission.evaluate uses findLast, so later rules override earlier rules.
  const lastMatch = rules.findLast((rule) =>
    wildcardMatches(command, rule.pattern),
  )
  if (!lastMatch || lastMatch.pattern === "*") return undefined
  return lastMatch
}

function resolveInnerAction(
  command: string,
  agents: AgentRules,
): PermissionAction {
  const actions = [...agents.values()].flatMap((rules) => {
    const rule = lastSpecificRule(command, rules)
    return rule ? [rule.action] : []
  })
  if (actions.includes("deny")) return "deny"
  if (actions.includes("ask")) return "ask"
  return "allow"
}

function readCommandWord(words: readonly string[], position: number): string {
  const word = words[position]
  if (word === undefined) {
    throw new Error(`Missing command word at position ${position}`)
  }
  return word
}

function skipOptions(
  args: readonly string[],
  valueOptions: ReadonlySet<string>,
  flagOptions: ReadonlySet<string>,
  joinedValuePrefixes: readonly string[] = [],
): string[] {
  let position = 0
  while (position < args.length) {
    const argument = readCommandWord(args, position)
    if (argument === "--") return args.slice(position + 1)
    if (!argument.startsWith("-")) return args.slice(position)
    if (valueOptions.has(argument)) {
      if (position + 1 >= args.length) {
        throw new Error(`Missing value for wrapper option: ${argument}`)
      }
      position += 2
      continue
    }
    if (
      flagOptions.has(argument) ||
      joinedValuePrefixes.some(
        (prefix) =>
          argument.startsWith(prefix) && argument.length > prefix.length,
      )
    ) {
      position++
      continue
    }
    throw new Error(`Unsupported wrapper option: ${argument}`)
  }
  return []
}

function skipEnvArguments(args: readonly string[]): string[] {
  let position = 0
  while (position < args.length) {
    const argument = readCommandWord(args, position)
    if (argument === "--") return args.slice(position + 1)
    if (["-i", "--ignore-environment", "-0", "--null"].includes(argument)) {
      position++
      continue
    }
    if (["-u", "--unset", "-C", "--chdir"].includes(argument)) {
      if (position + 1 >= args.length) {
        throw new Error(`Missing value for env option: ${argument}`)
      }
      position += 2
      continue
    }
    if (/^--(?:unset|chdir)=/.test(argument)) {
      position++
      continue
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(argument)) {
      position++
      continue
    }
    if (argument.startsWith("-")) {
      throw new Error(`Unsupported env option: ${argument}`)
    }
    return args.slice(position)
  }
  return []
}

function skipTimeoutArguments(args: readonly string[]): string[] {
  const afterOptions = skipOptions(
    args,
    new Set(["-k", "--kill-after", "-s", "--signal"]),
    new Set(["-v", "--verbose", "--foreground", "--preserve-status"]),
    ["--kill-after=", "--signal=", "-k", "-s"],
  )
  if (afterOptions.length === 0) throw new Error("timeout has no duration")
  const command = afterOptions.slice(1)
  return command[0] === "--" ? command.slice(1) : command
}

function skipNiceArguments(args: readonly string[]): string[] {
  return skipOptions(
    args,
    new Set(["-n", "--adjustment"]),
    new Set(["--help", "--version"]),
    ["--adjustment=", "-n"],
  )
}

function skipStdbufArguments(args: readonly string[]): string[] {
  return skipOptions(
    args,
    new Set(["-i", "-o", "-e", "--input", "--output", "--error"]),
    new Set(["--help", "--version"]),
    ["--input=", "--output=", "--error=", "-i", "-o", "-e"],
  )
}

function skipSetsidArguments(args: readonly string[]): string[] {
  return skipOptions(
    args,
    new Set<string>(),
    new Set([
      "-c",
      "-f",
      "-w",
      "--ctty",
      "--fork",
      "--wait",
      "--help",
      "--version",
    ]),
  )
}

function skipMiseExecArguments(args: readonly string[]): string[] {
  return skipOptions(
    args,
    new Set(["--profile", "--env", "--cd", "--tool"]),
    new Set(["--quiet", "--verbose", "--help", "--version"]),
    ["--profile=", "--env=", "--cd=", "--tool="],
  )
}

function skipMiseXArguments(args: readonly string[]): string[] {
  const separator = args.indexOf("--")
  if (separator === -1) throw new Error("mise x needs -- before its command")
  return args.slice(separator + 1)
}

function skipDirenvExecArguments(args: readonly string[]): string[] {
  if (args.length < 2)
    throw new Error("direnv exec needs a directory and command")
  return args.slice(1)
}

function unquoteShellWord(word: string): string {
  if (word.length < 2) return word
  const firstCharacter = word[0]
  if (firstCharacter !== word.at(-1)) return word
  if (firstCharacter === "'") return word.slice(1, -1)
  if (firstCharacter !== '"') return word
  return word.slice(1, -1).replace(/\\(["\\$`])/g, "$1")
}

function readShellScriptArgument(args: readonly string[]): string[] {
  const commandOption = args.findIndex(
    (argument) =>
      argument === "-c" ||
      argument === "--command" ||
      (/^-[^-]+$/.test(argument) && argument.includes("c")),
  )
  if (commandOption === -1) {
    throw new Error("shell wrapper has no -c script")
  }
  const script = args[commandOption + 1]
  if (script === undefined) throw new Error("shell wrapper has no script")
  return [unquoteShellWord(script)]
}

function passArguments(args: readonly string[]): string[] {
  return [...args]
}

const WRAPPER_RULES: readonly WrapperRule[] = [
  { head: "env", argumentSkipper: skipEnvArguments, isShell: false },
  { head: "timeout", argumentSkipper: skipTimeoutArguments, isShell: false },
  { head: "nohup", argumentSkipper: passArguments, isShell: false },
  { head: "nice", argumentSkipper: skipNiceArguments, isShell: false },
  { head: "stdbuf", argumentSkipper: skipStdbufArguments, isShell: false },
  { head: "setsid", argumentSkipper: skipSetsidArguments, isShell: false },
  { head: "sh", argumentSkipper: readShellScriptArgument, isShell: true },
  { head: "bash", argumentSkipper: readShellScriptArgument, isShell: true },
  { head: "zsh", argumentSkipper: readShellScriptArgument, isShell: true },
  { head: "mise exec", argumentSkipper: skipMiseExecArguments, isShell: false },
  { head: "mise x", argumentSkipper: skipMiseXArguments, isShell: false },
  {
    head: "direnv exec",
    argumentSkipper: skipDirenvExecArguments,
    isShell: false,
  },
]

const WRAPPER_HINT = new RegExp(
  `\\b(?:${[
    ...new Set(WRAPPER_RULES.flatMap((rule) => rule.head.split(" "))),
  ].join("|")})\\b`,
)

let parserPromise: Promise<Parser> | undefined

async function loadBashParser(): Promise<Parser> {
  const { Language, Parser } = await import("web-tree-sitter")
  const treeSitterPath = fileURLToPath(
    import.meta.resolve("web-tree-sitter/tree-sitter.wasm"),
  )
  await Parser.init({ locateFile: () => treeSitterPath })

  const bashWasmPath = fileURLToPath(
    import.meta.resolve("tree-sitter-bash/tree-sitter-bash.wasm"),
  )
  const bashLanguage = await Language.load(bashWasmPath)
  const parser = new Parser()
  parser.setLanguage(bashLanguage)
  return parser
}

function loadOrReuseBashParser(): Promise<Parser> {
  parserPromise ??= loadBashParser()
  return parserPromise
}

function appendCommandWords(node: Node, words: string[]) {
  if (
    node.type === "command_name" ||
    node.type === "command_name_expr" ||
    node.type === "word" ||
    node.type === "string" ||
    node.type === "raw_string" ||
    node.type === "concatenation" ||
    node.type === "number"
  ) {
    words.push(node.text)
  }
}

function readCommandWords(node: Node): string[] {
  const words: string[] = []
  for (let position = 0; position < node.childCount; position++) {
    const child = node.child(position)
    if (!child) continue
    if (child.type !== "command_elements") {
      appendCommandWords(child, words)
      continue
    }
    for (
      let itemPosition = 0;
      itemPosition < child.childCount;
      itemPosition++
    ) {
      const item = child.child(itemPosition)
      if (
        !item ||
        item.type === "command_argument_sep" ||
        item.type === "redirection"
      ) {
        continue
      }
      words.push(item.text)
    }
  }
  return words
}

function parseCommandWords(parser: Parser, script: string): string[][] {
  const tree = parser.parse(script)
  if (!tree) throw new Error("Bash parser returned no syntax tree")
  try {
    if (tree.rootNode.hasError)
      throw new Error("Bash parser found invalid syntax")
    return tree.rootNode
      .descendantsOfType("command")
      .filter((node): node is Node => Boolean(node))
      .map((node) => readCommandWords(node))
      .filter((words) => words.length > 0)
  } finally {
    tree.delete()
  }
}

function stripLeadingEnvironmentAssignments(
  words: readonly string[],
): string[] {
  let position = 0
  while (
    position < words.length &&
    /^[A-Za-z_][A-Za-z0-9_]*=/.test(readCommandWord(words, position))
  ) {
    position++
  }
  return words.slice(position)
}

function matchWrapper(words: readonly string[]): WrapperRule | undefined {
  return WRAPPER_RULES.find((rule) => {
    const headWords = rule.head.split(" ")
    return headWords.every(
      (word, position) => unquoteShellWord(words[position] ?? "") === word,
    )
  })
}

function reconstructCommand(words: readonly string[]): string {
  const commandName = unquoteShellWord(words[0] ?? "")
  if (/[$`]/.test(commandName)) {
    throw new Error("Runtime-expanded command names cannot be inspected")
  }
  return words.join(" ")
}

function collectShellInnerCommands(
  script: string,
  parser: Parser,
): InnerCommand[] {
  return parseCommandWords(parser, script).flatMap((words) => {
    const commandWords = stripLeadingEnvironmentAssignments(words)
    const command = reconstructCommand(commandWords)
    const nested = unwrapCommand(commandWords, parser)
    const innermostCommand = nested.at(-1)?.innermostCommand ?? command
    return [{ command, innermostCommand }, ...nested]
  })
}

function unwrapCommand(
  words: readonly string[],
  parser: Parser,
): InnerCommand[] {
  const commandWords = stripLeadingEnvironmentAssignments(words)
  const wrapper = matchWrapper(commandWords)
  if (!wrapper) return []

  const headLength = wrapper.head.split(" ").length
  const innerWords = wrapper.argumentSkipper(commandWords.slice(headLength))
  if (innerWords.length === 0) return []

  if (wrapper.isShell) {
    return collectShellInnerCommands(readCommandWord(innerWords, 0), parser)
  }

  const command = reconstructCommand(innerWords)
  const nested = unwrapCommand(innerWords, parser)
  const innermostCommand = nested.at(-1)?.innermostCommand ?? command
  return [{ command, innermostCommand }, ...nested]
}

function resolveInnerCommands(command: string, parser: Parser): InnerCommand[] {
  return parseCommandWords(parser, command).flatMap((words) =>
    unwrapCommand(words, parser),
  )
}

async function logEvaluationFailure(
  client: PluginInput["client"],
  failure: unknown,
) {
  await writeLog(client, "warn", "ExecWrapperEvaluationFailed", {
    error: String(failure),
  })
}

const execWrapperGuard: Plugin = async (input) => {
  const source: RuleSource = {
    client: input.client,
    configPath: path.join(input.worktree, "opencode.json"),
    cache: undefined,
  }

  try {
    await refreshAgentRules(source)
  } catch (failure) {
    if (!FAIL_OPEN_ON_EVALUATION_ERROR) throw failure
    await logEvaluationFailure(input.client, failure)
  }

  return {
    "tool.execute.before": async (toolInput, output) => {
      if (toolInput.tool !== "bash") return
      const command = isRecord(output.args) ? output.args.command : undefined
      if (typeof command !== "string" || !WRAPPER_HINT.test(command)) return

      let rules: AgentRules
      let innerCommands: InnerCommand[]
      try {
        const refreshedRules = await refreshAgentRules(source)
        if (!refreshedRules) return
        rules = refreshedRules
        innerCommands = resolveInnerCommands(
          command,
          await loadOrReuseBashParser(),
        )
      } catch (failure) {
        if (!FAIL_OPEN_ON_EVALUATION_ERROR) throw failure
        await logEvaluationFailure(input.client, failure)
        return
      }

      const decisions = innerCommands.map((innerCommand) => ({
        innerCommand,
        action: resolveInnerAction(innerCommand.command, rules),
      }))
      const denied = decisions.find((decision) => decision.action === "deny")
      if (denied) {
        throw new Error(
          `Blocked wrapped command: ${denied.innerCommand.innermostCommand}`,
        )
      }
      const asked = decisions.find((decision) => decision.action === "ask")
      if (asked) {
        throw new Error(
          `run this unwrapped so the human is prompted: ${asked.innerCommand.innermostCommand}`,
        )
      }
    },
  }
}

export default execWrapperGuard
