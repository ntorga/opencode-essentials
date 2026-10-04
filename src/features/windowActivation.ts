// The freedesktop notification protocol has no "activate window" concept.
// `notify-send` runs as a separate process that owns no window. On KDE the
// only lever is the compositor's scripting D-Bus: load a throwaway script
// that finds the window and calls `requestActivate`.
//
// The window belongs to the terminal emulator, not to the OpenCode process.
// The script therefore receives the whole ancestor process chain and raises
// the first window whose owner PID appears in that chain.

import { execFile } from "node:child_process"
import { readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

const MAX_ANCESTOR_HOPS = 32
const BUSCTL_TIMEOUT_MS = 5_000
const runBusctl = promisify(execFile)

export type ProcStatReader = (pid: number) => string | undefined

// /proc/<pid>/stat field 4 is the parent PID. Field 2 (the comm) can contain
// spaces and parentheses, so parse past the last ')' before splitting.
export function parseParentPid(statLine: string): number | undefined {
  const nameEnd = statLine.lastIndexOf(")")
  if (nameEnd === -1) return undefined
  const parentField = statLine
    .slice(nameEnd + 1)
    .trim()
    .split(/\s+/)[1]
  const parentPid = Number(parentField)
  return Number.isInteger(parentPid) && parentPid >= 0 ? parentPid : undefined
}

export function resolveAncestorPids(
  readStat: ProcStatReader,
  startPid: number,
): number[] {
  const pids: number[] = []
  const seen = new Set<number>()
  let currentPid: number | undefined = startPid
  for (
    let hop = 0;
    currentPid !== undefined && hop < MAX_ANCESTOR_HOPS;
    hop += 1
  ) {
    if (currentPid <= 0 || seen.has(currentPid)) break
    pids.push(currentPid)
    seen.add(currentPid)
    const statLine = readStat(currentPid)
    if (statLine === undefined) break
    currentPid = parseParentPid(statLine)
  }
  return pids
}

export function buildWindowActivationScript(pids: readonly number[]): string {
  return [
    `var wanted = [${pids.join(", ")}];`,
    "var wins = workspace.windowList();",
    "for (var i = 0; i < wins.length; i++) {",
    "  if (wanted.indexOf(wins[i].pid) !== -1) {",
    "    wins[i].minimized = false;",
    "    wins[i].requestActivate();",
    "    break;",
    "  }",
    "}",
    "",
  ].join("\n")
}

export function supportsWindowActivation(
  currentDesktop: string | undefined,
): boolean {
  return (currentDesktop ?? "")
    .split(":")
    .some((token) => token.toLowerCase() === "kde")
}

function readProcStat(pid: number): string | undefined {
  try {
    return readFileSync(`/proc/${pid}/stat`, "utf8")
  } catch {
    return undefined
  }
}

async function callScripting(
  member: string,
  signature: string,
  args: string[],
): Promise<void> {
  await runBusctl(
    "busctl",
    [
      "--user",
      "--quiet",
      "--timeout=5000",
      "call",
      "org.kde.KWin",
      "/Scripting",
      "org.kde.kwin.Scripting",
      member,
      signature,
      ...args,
    ],
    { timeout: BUSCTL_TIMEOUT_MS },
  )
}

// Asks the compositor to raise the terminal's window and reports whether the
// request reached KWin — not whether a window matched. It never throws and
// never blocks the event loop: the busctl calls are async and time-bounded,
// and a failure on any step returns false so the caller keeps the prompt.
export type ActivationRunner = {
  ancestorPids: () => number[]
  writeScript: (path: string, body: string) => void
  callScripting: (
    member: string,
    signature: string,
    args: string[],
  ) => Promise<void>
  removeScript: (path: string) => void
  scriptPathFor: (scriptName: string) => string
}

export async function runWindowActivation(
  runner: ActivationRunner,
  scriptName: string,
): Promise<boolean> {
  const pids = runner.ancestorPids()
  if (pids.length === 0) return false
  const scriptPath = runner.scriptPathFor(scriptName)
  try {
    runner.writeScript(scriptPath, buildWindowActivationScript(pids))
    await runner.callScripting("loadScript", "ss", [scriptPath, scriptName])
    await runner.callScripting("start", "", [])
    await runner.callScripting("unloadScript", "s", [scriptName])
    return true
  } catch {
    return false
  } finally {
    try {
      runner.removeScript(scriptPath)
    } catch {
      // The temp file lives in tmpdir and the OS clears it; a cleanup failure
      // must not turn a delivered activation into a reported failure.
    }
  }
}

const realRunner: ActivationRunner = {
  ancestorPids: () => resolveAncestorPids(readProcStat, process.pid),
  writeScript: (path, body) => {
    writeFileSync(path, body, { flag: "wx" })
  },
  callScripting,
  removeScript: (path) => rmSync(path, { force: true }),
  scriptPathFor: (scriptName) =>
    join(tmpdir(), `opencode-essentials-${scriptName}.js`),
}

export function requestOwningWindowActivation(
  scriptName: string,
): Promise<boolean> {
  return runWindowActivation(realRunner, scriptName)
}
