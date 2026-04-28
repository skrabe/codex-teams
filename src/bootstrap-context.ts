export type ContextWindow = "startup" | "reentry";

export interface ScopedContextSpec {
  window: ContextWindow;
  objective: string;
  assignedScope: string[];
  essentialContextSources: string[];
}

export function renderScopedContext(spec: ScopedContextSpec): string {
  const heading = spec.window === "startup" ? "STARTUP CONTEXT" : "SCOPED RE-ENTRY CONTEXT";
  const opening =
    spec.window === "startup"
      ? "This startup context is intentionally minimal and scoped."
      : "This re-entry context is intentionally minimal and scoped.";

  return `=== ${heading} ===
${opening}
- Do not assume any hidden parent transcript, prior turns, or full chat history are already in context.
- If you need more detail, fetch it explicitly from the task, chat, protocol, and shared-artifact tools.

=== MISSION OBJECTIVE ===
${spec.objective}

=== ASSIGNED SCOPE ===
${spec.assignedScope.map((item) => `- ${item}`).join("\n")}

=== ESSENTIAL CONTEXT SOURCES ===
${spec.essentialContextSources.map((item) => `- ${item}`).join("\n")}`;
}
