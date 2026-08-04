export type ToolFailureKind = "aborted" | "failed" | "timedOut" | "interrupted"

function appendStatus(body: string, status: string): string {
  return `${body ? `${body}\n\n` : ""}${status}`
}

/** 将 pi 工具错误转换为统一 Operation 协议，并保留 Bash 已产生的输出。 */
export function normalizeToolFailure(
  toolName: string,
  error: unknown,
  signal?: AbortSignal,
): { kind: ToolFailureKind; message: string } {
  const message = error instanceof Error ? error.message : String(error)
  if (toolName === "bash") {
    if (message.endsWith("Command aborted")) {
      const output = message.slice(0, -"Command aborted".length).replace(/\n\n$/, "")
      return {
        kind: "aborted",
        message: appendStatus(output, "Operation aborted: User aborted the turn while the tool was running."),
      }
    }
    const timeout = message.match(/^(.*?)(?:\n\n)?Command timed out after ([^\n]+)$/s)
    if (timeout)
      return {
        kind: "timedOut",
        message: appendStatus(timeout[1] ?? "", `Operation timed out: Command timed out after ${timeout[2]}.`),
      }
    const exited = message.match(/^(.*?)(?:\n\n)?Command exited with code (-?\d+)$/s)
    if (exited)
      return {
        kind: "failed",
        message: appendStatus(exited[1] ?? "", `Operation failed: Command exited with code ${exited[2]}.`),
      }
  }
  if (signal?.aborted)
    return {
      kind: "aborted",
      message: `Operation aborted: User aborted the turn while the tool was running.${message ? ` Reason: ${message}` : ""}`,
    }
  if (message.startsWith("Operation aborted:")) return { kind: "aborted", message }
  if (message.startsWith("Operation timed out:")) return { kind: "timedOut", message }
  if (message.startsWith("Operation interrupted:")) return { kind: "interrupted", message }
  if (message.startsWith("Operation failed:") || message.startsWith("Operation denied:"))
    return { kind: "failed", message }
  return { kind: "failed", message: `Operation failed: ${message}` }
}
