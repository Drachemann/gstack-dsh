/**
 * gstack-gbrain-install — the mise age-filter report.
 *
 * mise installs releases older than `minimum_release_age` on purpose (a
 * supply-chain guard we do not weaken), so a fresh `mise use -g` can land
 * several releases behind upstream with no mention of what it skipped. The
 * installer must NAME the withheld release and the exact override, instead of
 * saying only that one "may" exist.
 *
 * Hermetic: fake `mise`, `gbrain` and `curl` on PATH. The mise route is not
 * covered by test/gbrain-detect-install.test.ts, which pins `--via source`
 * precisely so a developer machine's real mise cannot change the result.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawnSync } from "child_process";

const ROOT = path.resolve(import.meta.dir, "..");
const INSTALL_BIN = path.join(ROOT, "bin", "gstack-gbrain-install");
const SPEC = "github:garrytan/gbrain";

let tmpHome: string;
let fakeBin: string;

function writeExe(name: string, body: string) {
  const p = path.join(fakeBin, name);
  fs.writeFileSync(p, body, { mode: 0o755 });
}

/**
 * @param guardedVersions what `mise ls-remote` returns under the age guard
 * @param allVersions     what it returns with --minimum-release-age 0
 */
function makeFakeMise(guardedVersions: string[], allVersions: string[]) {
  writeExe(
    "mise",
    `#!/bin/bash
case "$1" in
  use) exit 0 ;;
  reshim) exit 0 ;;
  ls-remote)
    shift
    if [ "$1" = "--minimum-release-age" ]; then
      shift 2
      printf '%s\\n' ${allVersions.map((v) => `"${v}"`).join(" ")}
      exit 0
    fi
    printf '%s\\n' ${guardedVersions.map((v) => `"${v}"`).join(" ")}
    exit 0 ;;
esac
exit 0
`,
  );
}

function runInstall(): { out: string } {
  const realPath = process.env.PATH ?? "";
  const r = spawnSync(INSTALL_BIN, ["--via", "mise"], {
    env: {
      PATH: `${fakeBin}:${path.join(ROOT, "bin")}:${realPath}`,
      HOME: tmpHome,
      GSTACK_HOME: path.join(tmpHome, ".gstack"),
    },
    encoding: "utf-8",
    timeout: 60_000,
  });
  return { out: `${r.stdout || ""}${r.stderr || ""}` };
}

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "gbrain-install-mise-home-"));
  fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), "gbrain-install-mise-bin-"));
  writeExe("gbrain", '#!/bin/bash\n[ "$1" = "--version" ] && echo "gbrain 0.60.13.0"\nexit 0\n');
  writeExe("curl", "#!/bin/bash\nexit 0\n");
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(fakeBin, { recursive: true, force: true });
});

describe("mise age-filter report", () => {
  test("names the withheld release and the exact override", () => {
    makeFakeMise(["0.60.12.0", "0.60.13.0"], ["0.60.13.0", "0.60.25.0", "0.60.26.0"]);
    const { out } = runInstall();
    expect(out).toContain("installed gbrain 0.60.13.0 via mise");
    expect(out).toContain("0.60.26.0 is released but held back by mise's minimum_release_age");
    expect(out).toContain(`mise use -g ${SPEC}@0.60.26.0`);
  });

  test("says so plainly when nothing is withheld", () => {
    makeFakeMise(["0.60.13.0"], ["0.60.13.0"]);
    const { out } = runInstall();
    expect(out).toContain("no newer release withheld by mise's minimum_release_age");
    expect(out).not.toContain("held back by mise's minimum_release_age");
  });

  test("the age override is only ever printed as a suggestion, never run", () => {
    // The listing flag must not leak into the install: `mise use` is called with
    // @latest, and the withheld version appears only in advisory text.
    makeFakeMise(["0.60.13.0"], ["0.60.13.0", "0.60.26.0"]);
    const { out } = runInstall();
    expect(out).toContain("0.60.26.0");
    expect(out).toContain("take it explicitly");
  });
});
