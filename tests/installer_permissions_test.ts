import { assert, assertEquals } from "@std/assert";
import { dirnameOf, joinPath } from "../src/util/fs.ts";

/**
 * The installer's safety story rests on it being compiled with --allow-read and
 * --allow-write and nothing else: it structurally cannot phone home, spawn
 * anything, or read the environment. Two things have to hold for that to be
 * true, and both are checked here rather than trusted.
 */

const ROOT = new URL("../", import.meta.url).pathname;

/** Everything reachable from the installer entry point, transitively. */
async function installerModules(): Promise<string[]> {
  const seen = new Set<string>();
  const queue = ["src/installer/main.ts"];
  while (queue.length > 0) {
    const path = queue.pop()!;
    if (seen.has(path)) continue;
    seen.add(path);
    const source = await Deno.readTextFile(joinPath(ROOT, path));
    for (const match of source.matchAll(/from\s+"(\.[^"]+)"/g)) {
      const resolved = normalise(joinPath(dirnameOf(path), match[1]));
      queue.push(resolved);
    }
  }
  return [...seen].sort();
}

function normalise(path: string): string {
  const out: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "." || segment === "") continue;
    if (segment === "..") out.pop();
    else out.push(segment);
  }
  return out.join("/");
}

Deno.test("the installer reaches nothing but the filesystem", async () => {
  const forbidden = [
    /\bDeno\.env\b/,
    /\bDeno\.Command\b/,
    /\bDeno\.run\b/,
    /\bDeno\.connect\b/,
    /\bDeno\.listen\b/,
    /\bDeno\.serve\b/,
    /(^|[^.\w])fetch\s*\(/m,
    /\bnew\s+WebSocket\b/,
  ];
  const modules = await installerModules();
  // The graph must actually have been walked, or this test proves nothing.
  assert(modules.length >= 8, `only found ${modules.length} modules`);
  assert(modules.includes("src/util/fs.ts"), "expected the shared fs helpers in the graph");

  const offenders: string[] = [];
  for (const path of modules) {
    const source = await Deno.readTextFile(joinPath(ROOT, path));
    for (const pattern of forbidden) {
      if (pattern.test(source)) offenders.push(`${path} matches ${pattern}`);
    }
  }
  assertEquals(offenders, []);
});

Deno.test("the installer build tasks grant only read and write", async () => {
  const config = JSON.parse(await Deno.readTextFile(joinPath(ROOT, "deno.json")));
  const tasks: Record<string, string> = config.tasks;
  const buildTasks = Object.entries(tasks).filter(([name, command]) =>
    name.startsWith("build:installer") && command.includes("deno compile")
  );
  assert(buildTasks.length >= 2, "expected a Linux and a Windows installer build task");
  assert(
    buildTasks.some(([, command]) => command.includes("x86_64-unknown-linux-gnu")) &&
      buildTasks.some(([, command]) => command.includes("x86_64-pc-windows-msvc")),
    "expected both an x86_64 Linux and an x86_64 Windows target",
  );

  for (const [name, command] of buildTasks) {
    assert(command.includes("--allow-read"), `${name} should grant --allow-read`);
    assert(command.includes("--allow-write"), `${name} should grant --allow-write`);
    for (const forbidden of ["-A", "--allow-all", "--allow-net", "--allow-run", "--allow-env"]) {
      assert(
        !new RegExp(`(^|\\s)${forbidden.replace(/-/g, "\\-")}(\\s|=|$)`).test(command),
        `${name} must not grant ${forbidden}: ${command}`,
      );
    }
  }
});
