import type { AgentProfile, AvatarLayerMotion, AvatarPaint, AvatarVectorLayer, AvatarVectorSpec } from "./types.js";

export const avatarShapeValues = ["blob", "pebble", "squircle", "tablet", "wedge", "hex", "cloud", "teardrop", "cat", "dog", "custom", "vector"] as const;
export const semanticAvatarShapes = new Set(["cat", "dog"]);

const paints = new Set<AvatarPaint>(["primary", "accent", "ink", "white", "none"]);
const motions = new Set<AvatarLayerMotion>(["none", "breathe", "float", "sway", "blink"]);
const roles = new Set<AvatarVectorLayer["role"]>(["body", "feature", "face", "accessory"]);
const kinds = new Set<AvatarVectorLayer["kind"]>(["path", "ellipse", "circle"]);
const pathSyntax = /^(?:[MLHVCSQTAZmlhvcsqtaz]|[-+]?\d*\.?\d+(?:e[-+]?\d+)?|[\s,])+$/i;

function finite(value: unknown, label: string, minimum = -20, maximum = 120) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < minimum || number > maximum) throw new Error(`${label} must be between ${minimum} and ${maximum}`);
  return Number(number.toFixed(3));
}

export function normalizeAvatarVectorSpec(input: unknown): AvatarVectorSpec {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("avatarVector must be an object");
  const candidate = input as Record<string, unknown>;
  if (candidate.version !== 1) throw new Error("avatarVector.version must be 1");
  const name = String(candidate.name || "").trim().slice(0, 60);
  if (!name) throw new Error("avatarVector.name is required");
  if (!Array.isArray(candidate.layers) || candidate.layers.length < 1 || candidate.layers.length > 16) throw new Error("avatarVector.layers must contain 1 to 16 layers");
  const ids = new Set<string>();
  const layers = candidate.layers.map((raw, index): AvatarVectorLayer => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`avatarVector layer ${index + 1} must be an object`);
    const layer = raw as Record<string, unknown>;
    const id = String(layer.id || "").trim();
    if (!/^[a-z][a-z0-9_-]{0,31}$/i.test(id) || ids.has(id)) throw new Error(`avatarVector layer ${index + 1} needs a unique safe id`);
    ids.add(id);
    const kind = layer.kind as AvatarVectorLayer["kind"];
    const role = layer.role as AvatarVectorLayer["role"];
    const fill = layer.fill as AvatarPaint;
    const stroke = layer.stroke == null ? undefined : layer.stroke as AvatarPaint;
    const motion = layer.motion == null ? "none" : layer.motion as AvatarLayerMotion;
    if (!kinds.has(kind)) throw new Error(`Unsupported avatarVector layer kind: ${String(layer.kind)}`);
    if (!roles.has(role)) throw new Error(`Unsupported avatarVector layer role: ${String(layer.role)}`);
    if (!paints.has(fill)) throw new Error(`Unsupported avatarVector fill token: ${String(layer.fill)}`);
    if (stroke != null && !paints.has(stroke)) throw new Error(`Unsupported avatarVector stroke token: ${String(layer.stroke)}`);
    if (!motions.has(motion)) throw new Error(`Unsupported avatarVector motion: ${String(layer.motion)}`);
    const normalized: AvatarVectorLayer = {
      id, kind, role, fill, motion,
      ...(stroke == null ? {} : { stroke }),
      ...(layer.strokeWidth == null ? {} : { strokeWidth: finite(layer.strokeWidth, "strokeWidth", 0, 8) }),
      ...(layer.opacity == null ? {} : { opacity: finite(layer.opacity, "opacity", 0, 1) })
    };
    if (kind === "path") {
      const d = String(layer.d || "").trim();
      if (!d || d.length > 1_200 || !pathSyntax.test(d) || !/[Mm]/.test(d)) throw new Error(`avatarVector path ${id} has invalid path data`);
      const pathNumbers = d.match(/[-+]?\d*\.?\d+(?:e[-+]?\d+)?/gi) || [];
      if (pathNumbers.length > 240 || pathNumbers.some((value) => !Number.isFinite(Number(value)) || Math.abs(Number(value)) > 500)) throw new Error(`avatarVector path ${id} exceeds numeric limits`);
      normalized.d = d;
    } else {
      normalized.cx = finite(layer.cx, `${id}.cx`);
      normalized.cy = finite(layer.cy, `${id}.cy`);
      if (kind === "circle") normalized.r = finite(layer.r, `${id}.r`, .5, 70);
      else {
        normalized.rx = finite(layer.rx, `${id}.rx`, .5, 70);
        normalized.ry = finite(layer.ry, `${id}.ry`, .5, 70);
      }
    }
    return normalized;
  });
  if (!layers.some((layer) => layer.role === "body")) throw new Error("avatarVector requires at least one body layer");
  return { version: 1, name, layers };
}

export function normalizedAvatarState(agent: AgentProfile) {
  const shape = agent.avatarShape || "blob";
  const semanticVerified = semanticAvatarShapes.has(shape);
  const renderableVector = shape === "vector" && Boolean(agent.avatarVector);
  const capability = shape === "custom"
    ? "Custom radial silhouettes are abstract and are not verified as recognizable characters. avatarShapeName is display-only."
    : shape === "vector"
      ? "The saved versioned vector character is renderable, but its subjective resemblance is not automatically vision-verified."
      : semanticVerified
        ? `The ${shape} preset is a supported deterministic semantic character.`
        : "The saved procedural preset is an abstract avatar shape.";
  return {
    shape,
    shapeName: agent.avatarShapeName || undefined,
    morph: agent.avatarMorph,
    vector: agent.avatarVector,
    primaryColor: agent.avatarColor || agent.color,
    accentColor: agent.avatarAccent || "#FFFFFF",
    face: agent.avatarFace || "dots",
    texture: agent.avatarTexture || "gradient",
    motion: agent.avatarMotion || "lively",
    accessory: agent.avatarAccessory || "none",
    hasBodyTexture: Boolean(agent.avatarDataUrl),
    semanticVerified,
    renderableVector,
    capability
  };
}
