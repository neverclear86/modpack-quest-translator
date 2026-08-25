import { runPackager } from "./run.ts";

if (import.meta.main) Deno.exit(await runPackager(Deno.args));

export { runPackager } from "./run.ts";
