import { assertEquals, assertMatch, assertStringIncludes } from "@std/assert";
import { runInstaller } from "../src/installer/run.ts";
import { VERSION } from "../src/version.ts";
import {
  ENGLISH,
  fakeClock,
  type Fixture,
  JAPANESE,
  makeFixture,
  TARGET_RELATIVE,
} from "./helpers/installer_fixture.ts";

interface Harness {
  stdout: string[];
  stderr: string[];
  answers: string[];
  prompts: string[];
}

function harness(answers: string[] = []): Harness {
  return { stdout: [], stderr: [], answers, prompts: [] };
}

async function invoke(
  argv: string[],
  h: Harness,
  extra: { interactive?: boolean } = {},
): Promise<number> {
  return await runInstaller(argv, {
    stdout: (line) => h.stdout.push(line),
    stderr: (line) => h.stderr.push(line),
    now: fakeClock(),
    isTerminal: extra.interactive ?? false,
    prompt: (question) => {
      h.prompts.push(question);
      return h.answers.shift() ?? null;
    },
  });
}

async function withFixture(
  fn: (fixture: Fixture) => Promise<void>,
  options: Parameters<typeof makeFixture>[0] = {},
): Promise<void> {
  const fixture = await makeFixture(options);
  try {
    await fn(fixture);
  } finally {
    await fixture.cleanup();
  }
}

Deno.test("install reports what it did in Japanese and English", async () => {
  await withFixture(async (fixture) => {
    const h = harness();
    const code = await invoke(
      ["install", "--bundle", fixture.bundleDir, "--instance", fixture.instanceRoot],
      h,
    );
    assertEquals(code, 0);
    const out = h.stdout.join("\n");
    assertStringIncludes(out, TARGET_RELATIVE);
    assertStringIncludes(out, "インストール");
    assertStringIncludes(out, "Installed");
    assertStringIncludes(out, "backups/");
    assertEquals(await fixture.read(), JAPANESE);
  });
});

Deno.test("a second install exits 0 and says there was nothing to do", async () => {
  await withFixture(async (fixture) => {
    await invoke(
      ["install", "--bundle", fixture.bundleDir, "--instance", fixture.instanceRoot],
      harness(),
    );
    const h = harness();
    const code = await invoke(
      ["install", "--bundle", fixture.bundleDir, "--instance", fixture.instanceRoot],
      h,
    );
    assertEquals(code, 0);
    assertStringIncludes(h.stdout.join("\n"), "Already installed, nothing to do");
    assertStringIncludes(h.stdout.join("\n"), "すでに導入済み");
  });
});

Deno.test("--json prints one machine-readable object and nothing else", async () => {
  await withFixture(async (fixture) => {
    const h = harness();
    const code = await invoke(
      ["install", "--bundle", fixture.bundleDir, "--instance", fixture.instanceRoot, "--json"],
      h,
    );
    assertEquals(code, 0);
    const body = JSON.parse(h.stdout.join("\n"));
    assertEquals(body.ok, true);
    assertEquals(body.command, "install");
    assertEquals(body.bundleId, fixture.bundleId);
    assertEquals(body.targets[0].relativePath, TARGET_RELATIVE);
    assertEquals(body.targets[0].status, "installed");
  });
});

Deno.test("a failure exits with the documented code and explains itself", async () => {
  await withFixture(async (fixture) => {
    const h = harness();
    const code = await invoke(
      ["uninstall", "--bundle", fixture.bundleDir, "--instance", fixture.instanceRoot],
      h,
    );
    assertEquals(code, 14);
    const err = h.stderr.join("\n");
    assertStringIncludes(err, "E_NOT_INSTALLED");
    // The gloss is Japanese; the detail is English.
    assertMatch(err, /[぀-ヿ一-鿿]/);
    assertEquals(await fixture.read(), ENGLISH);
  });
});

Deno.test("a failure in --json mode is still one JSON object on stdout", async () => {
  await withFixture(async (fixture) => {
    const h = harness();
    const code = await invoke(
      ["uninstall", "--bundle", fixture.bundleDir, "--instance", fixture.instanceRoot, "--json"],
      h,
    );
    assertEquals(code, 14);
    const body = JSON.parse(h.stdout.join("\n"));
    assertEquals(body.ok, false);
    assertEquals(body.code, "E_NOT_INSTALLED");
    assertEquals(body.exitCode, 14);
  });
});

Deno.test("uninstall restores and says where the file came from", async () => {
  await withFixture(async (fixture) => {
    await invoke(
      ["install", "--bundle", fixture.bundleDir, "--instance", fixture.instanceRoot],
      harness(),
    );
    const h = harness();
    const code = await invoke(
      ["uninstall", "--bundle", fixture.bundleDir, "--instance", fixture.instanceRoot],
      h,
    );
    assertEquals(code, 0);
    assertStringIncludes(h.stdout.join("\n"), "backups/");
    assertEquals(await fixture.read(), ENGLISH);
  });
});

Deno.test("status changes nothing and reports the install", async () => {
  await withFixture(async (fixture) => {
    await invoke(
      ["install", "--bundle", fixture.bundleDir, "--instance", fixture.instanceRoot],
      harness(),
    );
    const h = harness();
    const code = await invoke(
      ["status", "--bundle", fixture.bundleDir, "--instance", fixture.instanceRoot, "--json"],
      h,
    );
    assertEquals(code, 0);
    const body = JSON.parse(h.stdout.join("\n"));
    assertEquals(body.targets[0].matchesBundle, true);
    assertEquals(await fixture.read(), JAPANESE);
  });
});

Deno.test("without a terminal, a missing --instance is an error rather than a hang", async () => {
  await withFixture(async (fixture) => {
    const h = harness();
    const code = await invoke(["install", "--bundle", fixture.bundleDir], h);
    assertEquals(code, 2);
    assertEquals(h.prompts, []);
  });
});

Deno.test("with a terminal, the instance path is prompted for and confirmed", async () => {
  await withFixture(async (fixture) => {
    const h = harness([fixture.instanceRoot, "y"]);
    const code = await invoke(["install", "--bundle", fixture.bundleDir], h, { interactive: true });
    assertEquals(code, 0);
    assertEquals(h.prompts.length, 2);
    assertStringIncludes(h.prompts[1], TARGET_RELATIVE);
    assertEquals(await fixture.read(), JAPANESE);
  });
});

Deno.test("declining the confirmation changes nothing and exits cleanly", async () => {
  await withFixture(async (fixture) => {
    const h = harness([""]);
    const code = await invoke(
      ["install", "--bundle", fixture.bundleDir, "--instance", fixture.instanceRoot],
      h,
      { interactive: true },
    );
    assertEquals(code, 0);
    assertEquals(await fixture.read(), ENGLISH);
    assertStringIncludes(h.stdout.join("\n"), "Cancelled");
  });
});

Deno.test("--yes skips the confirmation", async () => {
  await withFixture(async (fixture) => {
    const h = harness();
    const code = await invoke(
      ["install", "--bundle", fixture.bundleDir, "--instance", fixture.instanceRoot, "--yes"],
      h,
      { interactive: true },
    );
    assertEquals(code, 0);
    assertEquals(h.prompts, []);
    assertEquals(await fixture.read(), JAPANESE);
  });
});

Deno.test("help and version answer without touching anything", async () => {
  const h = harness();
  assertEquals(await invoke(["--help"], h), 0);
  assertStringIncludes(h.stdout.join("\n"), "mqt-installer");
  assertStringIncludes(h.stdout.join("\n"), "uninstall");

  const v = harness();
  assertEquals(await invoke(["--version"], v), 0);
  assertEquals(v.stdout.join("\n").trim(), VERSION);
});

Deno.test("the bundle directory defaults to the one the executable sits in", async () => {
  await withFixture(async (fixture) => {
    const h = harness();
    const code = await runInstaller(
      ["install", "--instance", fixture.instanceRoot],
      {
        stdout: (line) => h.stdout.push(line),
        stderr: (line) => h.stderr.push(line),
        now: fakeClock(),
        isTerminal: false,
        prompt: () => null,
        execPath: `${fixture.bundleDir}/bin/mqt-installer-linux-x86_64`,
      },
    );
    assertEquals(code, 0);
    assertEquals(await fixture.read(), JAPANESE);
  });
});

Deno.test("a warning is surfaced without failing the run", async () => {
  await withFixture(async (fixture) => {
    await invoke(
      ["install", "--bundle", fixture.bundleDir, "--instance", fixture.instanceRoot],
      harness(),
    );
    await Deno.writeTextFile(`${fixture.instanceRoot}/.mqt-installer/state.json`, "{oops");
    const h = harness();
    const code = await invoke(
      ["status", "--bundle", fixture.bundleDir, "--instance", fixture.instanceRoot],
      h,
    );
    assertEquals(code, 0);
    assertStringIncludes(h.stderr.join("\n"), "state.json");
  });
});
