# DSH MCP configuration layers — technical reference

Read-only investigation, 2026-10. `PKG` = `/home/matt/.dsh/profiles/web/node_modules/dsh-project-mcp-manager`
(plugin v0.6.0, `package.json:2`). Evidence is `PKG/...:line` unless marked "observed".

## 1. Files, scopes, priority (first-come-first-served; earlier layer wins)

| # | Source id | Path | Scope |
|---|---|---|---|
| 1 | `dsh-project` | `<projectRoot>/.dsh/mcp.yml` | project |
| 2 | `dsh-project-json` | `<projectRoot>/.dsh/mcp.json` | project |
| 3 | `cc-project` | `<projectRoot>/.mcp.json` | project, **read-only legacy** |
| 4 | `dsh-profile-user` | `~/.dsh/profiles/<active>/mcp.json` | **global** |
| 5 | `dsh-user-yml` | `~/.dsh/mcp.yml` | **global** |
| 6 | `dsh-user` | `~/.dsh/mcp.json` | **global** |

- Order: `PKG/lib/cli.js:263-278` (push 1→6); loader merge `PKG/lib/registry.js:1125` / `:1056`; doc table
  `PKG/docs/guide/layers.md:11-18`. `<projectRoot>` = nearest `.git` ancestor, else cwd (`PKG/lib/project-root.js:20-29`).
- User paths follow `$DSH_HOME` (here `/home/matt/.dsh`), else `<home>/.dsh` (`PKG/lib/dsh-paths.js:30-33`;
  names `:19-24`; profile path `:51-53`); profile name resolves at runtime and an unresolvable/invalid name
  skips layer 4 (`PKG/lib/registry.js:768-775`, `:783`, `:1005-1007`).
- Shadow keys, any hit drops the later row: exact `serverName`; normalized name (lowercased, non-alphanumerics
  stripped); service identity (`stdio`: `command`+`args`, `streamable-http`: `url`). Compared on raw
  pre-`${VAR}` strings; `env`/`headers`/`cwd` are not keys (`PKG/docs/guide/layers.md:56-74`).
- `enabled:false` → skipped, claims no name; `disabled:true` → claims all three keys, mounts nothing
  (`PKG/lib/json-file.js:218`, `:235-237`).

## 2. JSON dialect: `{"mcpServers": {...}}`

Top-level key is exactly `mcpServers` (`PKG/lib/json-file.js:4`, `:277-290`); missing = legal empty layer
(`:277-289`); present but not an object = whole-layer error (`:212-215`). Unknown entry keys tolerated
(`z.looseObject`, `:71`); names must match `^[A-Za-z0-9_-]{1,32}$` (`PKG/lib/model.js:12`, per-entry error
`:220-223`).

Fields (`PKG/lib/json-file.js:71-92`): stdio `command`/`args[]`/`env{}`/`cwd`; http `url`/`httpUrl`/`headers{}`;
both: `type` (`stdio`|`http`|`streamable-http`), native `transport`, passthrough
`toolCallTimeoutMs`/`failOnStartupError`/`reconnect`, `tools.allow`/`tools.deny` (or
`includeTools`/`excludeTools`, `:107-113`), `enabled`, `disabled`.

- Inference: no `type`/`transport` and only `url`/`httpUrl` (no `command`) → streamable-http (`:164-168`); a
  declared `transport` and `type` that disagree → error (`:129-132`); `command` + `url` with neither declared →
  error (`:171-173`); `sse` rejected per entry (`PKG/lib/model.js:227`, `:246-258`).
- `cwd` default: project layer → project root; global layers → `""` = host cwd (`PKG/lib/json-file.js:134-141`;
  CLI `PKG/lib/cli.js:428-429`).
- `${VAR}` in `command`/`args[*]`/`env[*]`/`cwd`/`url`/`headers[*]` is stored literally and interpolated from
  the **host** environment at mount time; unset/empty → row skipped `env-missing`
  (`PKG/docs/guide/env-expansion.md:7-13`; `PKG/lib/json-file.js:20`).

Literal example, validated against the plugin's own reader (`parseJsonServersValue`, 0 entry errors):

```json
{
  "mcpServers": {
    "gbrain": {
      "type": "stdio",
      "command": "/home/matt/.bun/bin/gbrain",
      "args": ["serve"]
    },
    "gbrain-remote": {
      "type": "http",
      "url": "https://brain.example/mcp",
      "headers": { "Authorization": "Bearer ${GBRAIN_MCP_TOKEN}" }
    }
  }
}
```

Reader maps these to `transport:"stdio"` / `transport:"streamable-http"` rows with id `panel-mcp-<name>`
(`PKG/lib/mcp-file.js:19`); the CLI writer emits `type:"stdio"|"http"` and omits empty `args`/`env`/`headers`
and `cwd` `""`/`"."` (`PKG/lib/json-write.js:89-109`, `:127-143`).

## 3. YAML managed block (`.dsh/mcp.yml`, `~/.dsh/mcp.yml`)

One marker pair and one editor for both project and user yml (`MCP_BLOCK_BEGIN`/`END`,
`PKG/lib/mcp-file.js:15-16`); CLI user scope targets `<dshHome>/mcp.yml` (`PKG/lib/cli.js:388`, `:397`) via
`updateManagedRows` (`:470`).

```yaml
# >>> dsh-project-mcp-manager:mcp:begin
- insert:
    - id: panel-mcp-gbrain
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: gbrain
        transport: stdio          # or streamable-http (url/headers)
        command: /home/matt/.bun/bin/gbrain
        args: ['serve']
        cwd: .                     # project layer: relative to project root
# <<< dsh-project-mcp-manager:mcp:end
```

- `disabled: true` on a line deactivates it (`PKG/docs/guide/format.md:39-41`).
- Validation: file parses as a top-level YAML **array** (`PKG/lib/mcp-file.js:31-39`); begin/end paired
  (`:77-86`, `:119-121`); block is an array (`:100-103`); any unresolved YAML tag (native cordis
  `!!js process.env.X`) is a hard error, so `env`/`headers`/`disabled` must be literals (`:91-99`).
- Bytes outside the markers are preserved verbatim (`:5-6`, `:113-147`); removing the last managed row
  re-normalizes a now-meaningless file to `[]` (`:126-133`); writes lock `<path>.mcp-project.lock` + rename
  (`:149-166`, `:171-205`).

## 4. Is `dsh-mcp` invokable as `node <PKG>/lib/cli.js`? — Not on this machine

- `dsh-mcp` is **not** on PATH (observed); `package.json:13-15` maps the bin to `lib/cli.js`, and the profile
  shim `~/.dsh/profiles/web/node_modules/.bin/dsh-mcp` is a symlink to it.
- The direct-execution entry is real: `import.meta.url === pathToFileURL(resolve(process.argv[1])).href` →
  `runCli(process.argv.slice(2), …)` (`PKG/lib/cli.js:1050-1057`), so `node <PKG>/lib/cli.js <cmd>` is the form.
- **Empirically broken here.** `node <PKG>/lib/cli.js status|list|--help` aborts at import time with
  `ERR_MODULE_NOT_FOUND: Cannot find package '@deepseek-ai/dsh-scope' imported from
  …/@deepseek-ai/dsh-mcp-client/lib/index.js`. Chain: `PKG/lib/cli.js:25` → `PKG/lib/registry.js:42` →
  `@deepseek-ai/dsh-mcp-client` line 2. `dsh-scope` is a peer dep absent from the profile's `node_modules`
  (only inside the DSH install's `.mise` tree); `NODE_PATH=<…dsh-scope parent>` and `pnpm exec dsh-mcp …` fail
  identically (ESM ignores `NODE_PATH`).
- The host is unaffected: `plugin_manager list_plugins` (observed) shows `include:mcp-project` /
  `dsh-project-mcp-manager`, `enabled:true`, `fiberPhase:"active"`; `dsh --profile web --dump-config` lists it.
- Working equivalents (import path validated; no host connection); `PKG/lib/json-write.js` needs only `mcp-file.js` +
  `model.js` (yaml/zod, both present), so importing it directly bypasses `registry.js`:

```bash
PKG=/home/matt/.dsh/profiles/web/node_modules/dsh-project-mcp-manager
# user-scope stdio `gbrain`: merges (keeps other top-level keys and servers); throws if the name exists
node --input-type=module -e '
const { updateJsonServers } = await import("file://'"$PKG"'/lib/json-write.js");
const p = process.env.DSH_HOME + "/mcp.json";
await updateJsonServers(p, (s) => { if (s.gbrain) throw new Error("gbrain exists");
  s.gbrain = { type: "stdio", command: process.env.GBRAIN_BIN || "/home/matt/.bun/bin/gbrain", args: ["serve"] }; });
console.log("wrote " + p);'
# user-scope http + bearer server (token stays in the environment as ${VAR})
node --input-type=module -e '
const { updateJsonServers } = await import("file://'"$PKG"'/lib/json-write.js");
const p = process.env.DSH_HOME + "/mcp.json";
await updateJsonServers(p, (s) => { s["gbrain-remote"] = { type: "http", url: process.env.GBRAIN_MCP_URL,
  headers: { Authorization: "Bearer ${GBRAIN_MCP_TOKEN}" } }; });
console.log("wrote " + p);'
```

`$DSH_HOME` may be omitted (defaults to `/home/matt/.dsh`). The CLI forms, had it run, would be
`node $PKG/lib/cli.js add --scope user --format json gbrain <bin> serve` and
`node $PKG/lib/cli.js add --scope user --format json --transport http gbrain <url> -H "Authorization: Bearer ${GBRAIN_MCP_TOKEN}"`
(`PKG/lib/cli.js:40-41`, `:352-362`, `:396-398`); the default target is `~/.dsh/mcp.yml` unless
`--format json` or `DSH_MCP_CLI_FORMAT=json` is set.

## 5. Plain write to the JSON file

Allowed — the plugin is read-only toward these files (`PKG/lib/json-file.js:11-12`;
`PKG/docs/guide/format.md:106-109`). Invariants:
1. Valid JSON, no comments/trailing commas: a parse failure loses the **entire layer** with only a note
   (`PKG/lib/json-file.js:255-261`, `:269-270`); the plugin never rewrites the file.
2. Top level must be an object (`:271-272`); `mcpServers` must be an object (`:212-215`).
3. Preserve every other top-level key yourself — the CLI does (`PKG/lib/json-write.js:5`, `:68-72`) and keeps
   non-object entries (`:68-70`).
4. The CLI locks `<path>.mcp-project.lock` and renames a temp file (`PKG/lib/mcp-file.js:149-205`); a plain `>`
   write bypasses both, so do not race `dsh-mcp add`/`import`. Its serialization
   (`JSON.stringify({...doc, mcpServers: next}, null, 2) + "\n"`, `PKG/lib/json-write.js:72`) is cosmetic only.

## 6. Verification without connecting to a host

- Static: `dsh-mcp list` / `get <name>` / `status` read layer + diag files only, never a running host (`PKG/lib/cli.js:9-13`, `:519-532`, `:1002-1022`).
- Diagnostic files: project `<projectRoot>/.dsh/.mcp-diag.json` (`PKG/lib/registry.js:1389`), global
  `$DSH_HOME/.mcp-diag.json` (`:1392-1395`, written `:1505`); shape `{summary?, events:[…]}` (`:425-431`);
  `summary` = `{at, rows, mounted, projects?, skippedByReason, unhealthy[], idle?, toolBudget?}` (`:432-450`),
  rendered at `PKG/lib/cli.js:937-951`. A file appears only after the **running host** reconciles and only when
  there is content or an error (`PKG/lib/registry.js:1379-1388`, `:1489-1499`); here it is currently absent.
- Loader-exact local check (no host), validated:

```bash
PKG=/home/matt/.dsh/profiles/web/node_modules/dsh-project-mcp-manager
node --input-type=module -e '
const { readDshJsonFile } = await import("file://'"$PKG"'/lib/json-file.js");
const r = await readDshJsonFile(process.env.DSH_HOME + "/mcp.json",
  { source: "dsh-user", cwdPolicy: "host", projectRoot: "" });
console.log("rows:", r.rows.map(x => x.rawName).join(","),
            "| entryErrors:", JSON.stringify(r.entryErrors), "| fileError:", r.fileError);'
cat "$DSH_HOME/.mcp-diag.json"   # host up: summary.mounted should include gbrain; failures land in unhealthy/skippedByReason
```
- Host-side: `plugin_manager list_plugins` shows `include:mcp-project` active (observed) and the agent's tool
  list gains `mcp__gbrain__*`.

## 7. Gotchas that silently prevent a hand-written config from loading

1. **The CLI is not a usable path here** (§4): not on PATH and `node …/lib/cli.js` dies with
   `ERR_MODULE_NOT_FOUND @deepseek-ai/dsh-scope`. Do not symlink `cli.js` onto PATH either — the guard at
   `PKG/lib/cli.js:1051-1057` compares realpath `import.meta.url` with symlink `resolve(process.argv[1])`, making a
   symlinked invocation a silent no-op once the dependency gap is fixed.
2. **Priority is not what filenames suggest.** Project layers outrank every user layer; among user layers
   `profiles/<name>/mcp.json` (4) and `~/.dsh/mcp.yml` (5) outrank `~/.dsh/mcp.json` (6). A duplicate on name,
   normalized name, or `command`+`args` in any higher layer drops the JSON entry with no error, only a shadow
   note (`PKG/lib/cli.js:305-351`, `PKG/docs/guide/layers.md:56-74`).
3. **Malformed JSON silently discards the whole layer** (comments, trailing commas, wrong top-level type:
   `PKG/lib/json-file.js:255-261`, `:269-272`); the other five layers keep loading, so the symptom is "server
   missing", not an error.
4. **`DSH_MCP_IGNORE_MCP_JSON=1` does NOT disable `.dsh/mcp.json`** — despite the name it only skips legacy
   `<projectRoot>/.mcp.json` (`PKG/lib/json-file.js:52-57`, applied `:269-274`; `PKG/lib/registry.js:1121`); no
   switch turns off the DSH JSON layers.
5. **Project detection requires `.git`** (`PKG/lib/project-root.js:20-29`); without one, a project config
   anchors at cwd and loads for any session started there.
6. **`enabled:false` vs `disabled:true`**: only the latter reserves the name, so a stale `disabled:true`
   placeholder makes `add` refuse it (`PKG/lib/json-file.js:218`, `:235-237`; `PKG/lib/cli.js:448-451`).
7. **Unset `${VAR}` is a skip, not an error**: the row disappears with `env-missing` and no mount (`PKG/docs/guide/env-expansion.md:11-13`).
8. **Profile scope is JSON-only and needs an existing profile dir** (`PKG/lib/cli.js:378-384`); the runtime layer
   is skipped when the active profile name cannot be resolved (`PKG/lib/registry.js:768-783`).
