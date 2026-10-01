/**
 * DSH MCP config layers — resolve the *effective* gbrain registration.
 *
 * DSH mounts MCP servers from a layered config rather than a CLI, and a server
 * name defined by a higher-precedence layer **shadows** the same name in every
 * lower layer. The shadowed row is dropped with no error, so a detector that
 * reads only one file can report "none" while a live registration is mounted.
 *
 * Precedence, highest first (matches the DSH layer order):
 *   1. <projectRoot>/.dsh/mcp.yml
 *   2. <projectRoot>/.dsh/mcp.json
 *   3. <projectRoot>/.mcp.json                     (legacy name)
 *   4. <dshHome>/profiles/<profile>/mcp.json
 *   5. <dshHome>/mcp.yml
 *   6. <dshHome>/mcp.json
 *
 * This module is host-neutral in shape and inert unless a dsh layer on disk
 * actually resolves a gbrain server, so Claude/Codex behaviour is unchanged.
 *
 * Verified against DSH 0.2.0-rc.2: the profile is the positional argument of
 * `dsh <profile>` (e.g. `dsh web` → profile `web`), and the layer files use
 * the same `mcpServers` object with `type: "stdio" | "http"`.
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";

export type DshMcpMode = "local-stdio" | "remote-http";

export interface DshMcpServerEntry {
  type?: string;
  transport?: string;
  command?: string;
  args?: string[];
  url?: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
}

export interface DshMcpLayer {
  /** Absolute path to the layer file. */
  path: string;
  /** Which precedence band the layer belongs to. */
  scope: "project" | "profile" | "global";
}

export interface DshMcpResolution {
  mode: DshMcpMode;
  /** The layer file the winning entry came from. */
  layer: string;
  /** The server name that matched. */
  server: string;
}

/** `$DSH_HOME` or `~/.dsh`, matching DSH's own default. */
export function dshHomeFromEnv(env: NodeJS.ProcessEnv, home: string): string {
  return env.DSH_HOME || join(home, ".dsh");
}

/**
 * The active DSH profile.
 *
 * `DSH_PROFILE` wins when set. Otherwise DSH's own convention is that the
 * profile is the positional argument to `dsh` (`dsh web` → `web`), which we
 * recover from the running process table. No process table, no profile layer —
 * we never guess a name, because guessing would read another profile's servers.
 */
/** A profile name safe to interpolate into a path. Both sources use this. */
const PROFILE_NAME_RE = /^[a-z0-9][a-z0-9._-]*$/i;

export function activeDshProfile(env: NodeJS.ProcessEnv, psOutput: string | null): string | null {
  const explicit = (env.DSH_PROFILE || "").trim();
  // Validate the environment value too, not just the ps-derived one: this name
  // is joined into a filesystem path (`profiles/<name>/mcp.json`), so an
  // unvalidated `DSH_PROFILE=../../somewhere` would let an unrelated file pick
  // the reported MCP mode.
  if (explicit) return PROFILE_NAME_RE.test(explicit) ? explicit : null;
  if (!psOutput) return null;
  // Match the dsh entrypoint line and take the first non-flag token after the
  // script path: "node .../dsh/lib/bin.js web" -> "web".
  for (const line of psOutput.split("\n")) {
    if (!/\bdsh\b/.test(line) || !/lib\/bin\.js/.test(line)) continue;
    const after = line.replace(/^.*?lib\/bin\.js\s*/, "");
    const token = after.split(/\s+/).find((t) => t && !t.startsWith("-"));
    if (token && PROFILE_NAME_RE.test(token)) return token;
  }
  return null;
}

/** Layer files in precedence order, highest first. */
export function dshMcpLayerPaths(opts: {
  projectRoot: string;
  dshHome: string;
  profile?: string | null;
}): DshMcpLayer[] {
  const { projectRoot, dshHome, profile } = opts;
  const layers: DshMcpLayer[] = [
    { path: join(projectRoot, ".dsh", "mcp.yml"), scope: "project" },
    { path: join(projectRoot, ".dsh", "mcp.json"), scope: "project" },
    { path: join(projectRoot, ".mcp.json"), scope: "project" },
  ];
  if (profile) {
    layers.push({ path: join(dshHome, "profiles", profile, "mcp.json"), scope: "profile" });
  }
  layers.push(
    { path: join(dshHome, "mcp.yml"), scope: "global" },
    { path: join(dshHome, "mcp.json"), scope: "global" },
  );
  return layers;
}

function parseYaml(text: string): unknown | null {
  const bun = (globalThis as { Bun?: { YAML?: { parse?: (s: string) => unknown } } }).Bun;
  if (!bun?.YAML?.parse) return null;
  try {
    return bun.YAML.parse(text);
  } catch {
    return null;
  }
}

/**
 * Read one layer. A missing or unparseable file is null, never a throw: DSH
 * discards an entire malformed layer, and so must the detector.
 */
export function readDshMcpLayer(path: string): Record<string, DshMcpServerEntry> | null {
  if (!existsSync(path)) return null;
  let doc: unknown;
  try {
    const raw = readFileSync(path, "utf-8");
    doc = path.endsWith(".yml") || path.endsWith(".yaml") ? parseYaml(raw) : JSON.parse(raw);
  } catch {
    return null;
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return null;
  const servers = (doc as { mcpServers?: unknown }).mcpServers;
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) return null;
  return servers as Record<string, DshMcpServerEntry>;
}

export function classifyDshEntry(entry: DshMcpServerEntry): DshMcpMode | null {
  const mtype = entry.type || entry.transport || "";
  if (mtype === "url" || mtype === "http" || mtype === "sse") return "remote-http";
  if (mtype === "stdio") return "local-stdio";
  if (entry.url) return "remote-http";
  if (entry.command) return "local-stdio";
  return null;
}

function isGbrainish(name: string, entry: DshMcpServerEntry, remoteMcpUrl: string): boolean {
  if (remoteMcpUrl && entry.url && entry.url === remoteMcpUrl) return true;
  if (/^gbrain([-_][\w-]*)?$/.test(name)) return true;
  if (entry.command && /\bgbrain\b/.test(entry.command)) return true;
  if (entry.url && /\bgbrain\b/.test(entry.url)) return true;
  return false;
}

/**
 * The effective gbrain MCP registration across the dsh layers, or null.
 *
 * Server names are claimed highest-precedence-first, so a lower layer's copy of
 * an already-claimed name is treated as shadowed (dropped) rather than read.
 */
export function resolveDshMcpGbrain(opts: {
  projectRoot: string;
  dshHome: string;
  profile?: string | null;
  /** gbrain's own `remote_mcp.mcp_url`, used for the thin-client test. */
  remoteMcpUrl?: string;
}): DshMcpResolution | null {
  const remoteMcpUrl = opts.remoteMcpUrl || "";
  const claimed = new Set<string>();
  for (const layer of dshMcpLayerPaths(opts)) {
    const servers = readDshMcpLayer(layer.path);
    if (!servers) continue;
    for (const [name, entry] of Object.entries(servers)) {
      if (claimed.has(name)) continue; // shadowed by a higher layer
      claimed.add(name);
      if (!entry || typeof entry !== "object") continue;
      if (!isGbrainish(name, entry, remoteMcpUrl)) continue;
      const mode = classifyDshEntry(entry);
      // A gbrain-named server that cannot be classified is still mounted; it
      // shadows any lower layer's gbrain row, so report nothing rather than a
      // stale lower layer's mode.
      return mode ? { mode, layer: layer.path, server: name } : null;
    }
  }
  return null;
}

/** Layer paths that exist on disk, in precedence order (diagnostics). */
export function existingDshMcpLayers(opts: {
  projectRoot: string;
  dshHome: string;
  profile?: string | null;
}): DshMcpLayer[] {
  return dshMcpLayerPaths(opts).filter((l) => existsSync(l.path));
}
