/**
 * DSH MCP layers — gbrain_mcp_mode detection on the DeepSeek Harness.
 *
 * DSH mounts MCP servers from a layered config with silent shadowing, so the
 * detector must read the whole precedence chain, not one file. Before this,
 * gbrain_mcp_mode read "none" on dsh while the registration was live.
 *
 * Precedence, highest first:
 *   <project>/.dsh/mcp.yml > <project>/.dsh/mcp.json > <project>/.mcp.json >
 *   $DSH_HOME/profiles/<profile>/mcp.json > $DSH_HOME/mcp.yml > $DSH_HOME/mcp.json
 *
 * The dsh tier is LAST in the detector so no existing host's answer changes;
 * the integration test at the bottom pins the real bug (a live dsh-only
 * registration must not read as "none").
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawnSync } from "child_process";

import {
  activeDshProfile,
  dshHomeFromEnv,
  dshMcpLayerPaths,
  resolveDshMcpGbrain,
} from "../lib/dsh-mcp-layers";

const ROOT = path.resolve(import.meta.dir, "..");
const DETECT_BIN = path.join(ROOT, "bin", "gstack-gbrain-detect");

let tmpHome: string;
let tmpProject: string;

function writeJson(p: string, doc: unknown) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(doc, null, 2));
}

function writeYaml(p: string, text: string) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
}

function resolve(opts: Partial<Parameters<typeof resolveDshMcpGbrain>[0]> = {}) {
  return resolveDshMcpGbrain({
    projectRoot: tmpProject,
    dshHome: path.join(tmpHome, ".dsh"),
    ...opts,
  });
}

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-mcp-layers-home-"));
  tmpProject = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-mcp-layers-proj-"));
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(tmpProject, { recursive: true, force: true });
});

describe("dshMcpLayerPaths — precedence", () => {
  test("orders every layer highest-first, and omits the profile band without a profile", () => {
    const withProfile = dshMcpLayerPaths({
      projectRoot: "/p",
      dshHome: "/h/.dsh",
      profile: "web",
    }).map((l) => l.path);
    expect(withProfile).toEqual([
      "/p/.dsh/mcp.yml",
      "/p/.dsh/mcp.json",
      "/p/.mcp.json",
      "/h/.dsh/profiles/web/mcp.json",
      "/h/.dsh/mcp.yml",
      "/h/.dsh/mcp.json",
    ]);
    const noProfile = dshMcpLayerPaths({ projectRoot: "/p", dshHome: "/h/.dsh" }).map((l) => l.path);
    expect(noProfile).toEqual([
      "/p/.dsh/mcp.yml",
      "/p/.dsh/mcp.json",
      "/p/.mcp.json",
      "/h/.dsh/mcp.yml",
      "/h/.dsh/mcp.json",
    ]);
  });

  test("dshHomeFromEnv honours DSH_HOME", () => {
    expect(dshHomeFromEnv({ DSH_HOME: "/custom" }, "/home/x")).toBe("/custom");
    expect(dshHomeFromEnv({}, "/home/x")).toBe("/home/x/.dsh");
  });

  test("activeDshProfile prefers DSH_PROFILE and never guesses a name", () => {
    expect(activeDshProfile({ DSH_PROFILE: "web" }, null)).toBe("web");
    expect(activeDshProfile({}, null)).toBeNull();
    expect(activeDshProfile({}, "node .../dsh/lib/bin.js web")).toBe("web");
    // The flag form is recoverable too: the token after --profile.
    expect(activeDshProfile({}, "node .../dsh/lib/bin.js --profile headless")).toBe("headless");
    // Only flags, no positional: do not invent a profile name.
    expect(activeDshProfile({}, "node .../dsh/lib/bin.js --no-open")).toBeNull();
  });

  test("activeDshProfile rejects a traversing name from EITHER source", () => {
    // The name is joined into `profiles/<name>/mcp.json`, so an unvalidated
    // environment value would let an unrelated file pick the reported mode.
    for (const bad of ["../../etc", "a/b", "..", "/abs", "web/../other"]) {
      expect(activeDshProfile({ DSH_PROFILE: bad }, null)).toBeNull();
      expect(activeDshProfile({}, `node .../dsh/lib/bin.js ${bad}`)).toBeNull();
    }
    // And a traversing DSH_PROFILE must not select a layer outside dshHome.
    const escaped = resolveDshMcpGbrain({
      projectRoot: tmpProject,
      dshHome: path.join(tmpHome, ".dsh"),
      profile: activeDshProfile({ DSH_PROFILE: "../../evil" }, null),
    });
    expect(escaped).toBeNull();
  });
});

describe("resolveDshMcpGbrain — classification", () => {
  test("global ~/.dsh/mcp.json stdio → local-stdio", () => {
    writeJson(path.join(tmpHome, ".dsh", "mcp.json"), {
      mcpServers: { gbrain: { type: "stdio", command: "/x/gbrain", args: ["serve"] } },
    });
    const r = resolve();
    expect(r?.mode).toBe("local-stdio");
    expect(r?.server).toBe("gbrain");
  });

  test("a remote-http entry (url + headers) → remote-http", () => {
    writeJson(path.join(tmpHome, ".dsh", "mcp.json"), {
      mcpServers: { gbrain: { type: "http", url: "https://b.example/mcp", headers: {} } },
    });
    expect(resolve()?.mode).toBe("remote-http");
  });

  test("a differently-named gbrain server still counts (#2051 generalization)", () => {
    writeJson(path.join(tmpHome, ".dsh", "mcp.json"), {
      mcpServers: { "gbrain-remote": { type: "http", url: "https://b.example/mcp" } },
    });
    expect(resolve()?.mode).toBe("remote-http");
  });

  test("an unrelated server is not mistaken for gbrain", () => {
    writeJson(path.join(tmpHome, ".dsh", "mcp.json"), {
      mcpServers: { other: { type: "stdio", command: "/x/other" } },
    });
    expect(resolve()).toBeNull();
  });

  test("a malformed layer is discarded whole, not half-read", () => {
    fs.mkdirSync(path.join(tmpHome, ".dsh"), { recursive: true });
    fs.writeFileSync(path.join(tmpHome, ".dsh", "mcp.json"), "{ not json");
    expect(resolve()).toBeNull();
  });
});

describe("resolveDshMcpGbrain — shadowing", () => {
  test("a project layer shadows the global layer's gbrain row", () => {
    writeJson(path.join(tmpProject, ".dsh", "mcp.json"), {
      mcpServers: { gbrain: { type: "http", url: "https://project.example/mcp" } },
    });
    writeJson(path.join(tmpHome, ".dsh", "mcp.json"), {
      mcpServers: { gbrain: { type: "stdio", command: "/x/gbrain" } },
    });
    const r = resolve();
    expect(r?.mode).toBe("remote-http");
    expect(r?.layer).toBe(path.join(tmpProject, ".dsh", "mcp.json"));
  });

  test(".dsh/mcp.yml wins over .dsh/mcp.json", () => {
    writeYaml(
      path.join(tmpProject, ".dsh", "mcp.yml"),
      "mcpServers:\n  gbrain:\n    type: http\n    url: https://yml.example/mcp\n",
    );
    writeJson(path.join(tmpProject, ".dsh", "mcp.json"), {
      mcpServers: { gbrain: { type: "stdio", command: "/x/gbrain" } },
    });
    expect(resolve()?.mode).toBe("remote-http");
  });

  test("the profile band sits between project and global", () => {
    writeJson(path.join(tmpHome, ".dsh", "profiles", "web", "mcp.json"), {
      mcpServers: { gbrain: { type: "http", url: "https://profile.example/mcp" } },
    });
    writeJson(path.join(tmpHome, ".dsh", "mcp.json"), {
      mcpServers: { gbrain: { type: "stdio", command: "/x/gbrain" } },
    });
    expect(resolve({ profile: "web" })?.mode).toBe("remote-http");
    // Without the profile the global row is the effective one.
    expect(resolve({ profile: null })?.mode).toBe("local-stdio");
  });

  test("a shadowed, unclassifiable gbrain row reports nothing rather than a stale lower layer", () => {
    writeJson(path.join(tmpProject, ".dsh", "mcp.json"), {
      mcpServers: { gbrain: {} },
    });
    writeJson(path.join(tmpHome, ".dsh", "mcp.json"), {
      mcpServers: { gbrain: { type: "http", url: "https://lower.example/mcp" } },
    });
    // The higher row owns the name; it is mounted but unclassifiable.
    expect(resolve()).toBeNull();
  });
});

describe("gstack-gbrain-detect — dsh-only registration (the bug this fixes)", () => {
  function runDetect(env: Record<string, string>, cwd: string) {
    const realPath = process.env.PATH ?? "";
    const r = spawnSync(DETECT_BIN, [], {
      cwd,
      env: {
        PATH: `${path.join(ROOT, "bin")}:${realPath}`,
        HOME: tmpHome,
        GSTACK_HOME: path.join(tmpHome, ".gstack"),
        ...env,
      },
      encoding: "utf-8",
      timeout: 30_000,
    });
    let json: any = null;
    try {
      json = JSON.parse(r.stdout || "{}");
    } catch {
      json = null;
    }
    return { code: r.status ?? -1, json };
  }

  test("a live dsh stdio registration reads local-stdio, not none", () => {
    writeJson(path.join(tmpHome, ".dsh", "mcp.json"), {
      mcpServers: { gbrain: { type: "stdio", command: "/x/gbrain", args: ["serve"] } },
    });
    const r = runDetect({}, tmpProject);
    expect(r.code).toBe(0);
    expect(r.json.gbrain_mcp_mode).toBe("local-stdio");
  });

  test("a project-layer dsh registration is found too", () => {
    writeJson(path.join(tmpProject, ".dsh", "mcp.json"), {
      mcpServers: { gbrain: { type: "http", url: "https://remote.example/mcp" } },
    });
    expect(runDetect({}, tmpProject).json.gbrain_mcp_mode).toBe("remote-http");
  });

  test("no registration anywhere still reads none", () => {
    expect(runDetect({}, tmpProject).json.gbrain_mcp_mode).toBe("none");
  });
});
