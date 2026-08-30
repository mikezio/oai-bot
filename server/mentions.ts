import type { AgentProfile } from "./types.js";

export function extractMentionedAgentIds(text: string, agents: AgentProfile[]): string[] {
  // A quoted example such as `reply @Scout` is content, not an address. The
  // host UI can render richer mention metadata later; until then, exclude
  // Markdown code spans and fences before applying the exact-name matcher.
  const lower = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`\n]*`/g, " ")
    .toLocaleLowerCase();
  return agents
    .filter((agent) => {
      const escaped = agent.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`(^|[^\\p{L}\\p{N}_])@${escaped}(?=$|[^\\p{L}\\p{N}_])`, "iu").test(lower);
    })
    .map((agent) => agent.id);
}

export function agentRoster(agents: AgentProfile[]) {
  return agents.map((agent) => `@${agent.name} — ${agent.title}: ${agent.description}`).join("\n");
}

export function sanitizeAgentName(value: string) {
  return value.trim().replace(/^@+/, "").trim().replace(/\s+/g, " ").slice(0, 32);
}
