import assert from "node:assert/strict";
import test from "node:test";
import { extractMentionedAgentIds, sanitizeAgentName } from "./mentions.js";
import type { AgentProfile } from "./types.js";

const base = {
  title: "",
  description: "",
  instructions: "",
  avatar: "A",
  color: "#000",
  model: "gpt-5.6-luna",
  effort: "medium",
  networkAccess: true,
  status: "idle" as const,
  roomThreadIds: {},
  roomLastSeenMessageIds: {},
  createdAt: "",
  updatedAt: ""
};

const agents: AgentProfile[] = [
  { ...base, id: "atlas", name: "Atlas" },
  { ...base, id: "scout", name: "Scout" }
];

test("extracts case-insensitive mentions without partial matches", () => {
  assert.deepEqual(extractMentionedAgentIds("@ATLAS ask @Scout, please", agents), ["atlas", "scout"]);
  assert.deepEqual(extractMentionedAgentIds("email@atlas.example", agents), []);
});

test("sanitizes names", () => {
  assert.equal(sanitizeAgentName("@@  Ada   Lovelace "), "Ada Lovelace");
});
