import type { AgentProfile } from "./types.js";

export function extractMentionedAgentIds(text: string, agents: AgentProfile[]): string[] {
  const lower = text.toLocaleLowerCase();
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
