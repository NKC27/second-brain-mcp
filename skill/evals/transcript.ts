/** Parsing of `claude -p --output-format stream-json` output into something the graders can inspect. */

export interface ToolCall {
  /** Tool name without the `mcp__second-brain__` prefix, e.g. `search_notes`. */
  name: string;
  input: Record<string, unknown>;
  /** True when the tool result came back flagged as an error. */
  isError: boolean;
}

export interface Transcript {
  calls: ToolCall[];
  finalText: string;
  /** Set when the session itself failed (for example an expired login), as opposed to the model misbehaving. */
  failed?: string;
}

const PREFIX = "mcp__second-brain__";

export function parseTranscript(stdout: string): Transcript {
  const calls: ToolCall[] = [];
  const byId = new Map<string, ToolCall>();
  let finalText = "";
  let failed: string | undefined;

  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }

    if (event.type === "assistant") {
      for (const block of event.message?.content ?? []) {
        if (block.type === "tool_use" && typeof block.name === "string" && block.name.startsWith(PREFIX)) {
          const call: ToolCall = { name: block.name.slice(PREFIX.length), input: block.input ?? {}, isError: false };
          calls.push(call);
          byId.set(block.id, call);
        }
      }
    } else if (event.type === "user") {
      const content = event.message?.content;
      for (const block of Array.isArray(content) ? content : []) {
        if (block.type === "tool_result" && block.is_error) {
          const call = byId.get(block.tool_use_id);
          if (call) call.isError = true;
        }
      }
    } else if (event.type === "result") {
      finalText = typeof event.result === "string" ? event.result : "";
      if (event.is_error) failed = finalText || "session failed";
    }
  }
  return { calls, finalText, failed };
}

export const WRITE_TOOLS = new Set([
  "create_note",
  "create_note_from_template",
  "update_note",
  "delete_note",
  "restore_note",
  "rename_note",
  "merge_notes",
  "journal_entry",
  "complete_todo",
  "link_mentions",
  "export_vault",
]);

export function called(t: Transcript, name: string): ToolCall[] {
  return t.calls.filter((c) => c.name === name);
}

/** Write-type calls that did not come back as errors. */
export function successfulWrites(t: Transcript): ToolCall[] {
  return t.calls.filter((c) => WRITE_TOOLS.has(c.name) && !c.isError);
}
