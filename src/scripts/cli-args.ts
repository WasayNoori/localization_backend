// src/scripts/cli-args.ts — tiny argv helper shared by the CLI scripts.
export function parseArgs(argv: string[] = process.argv.slice(2)) {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      positional.push(a);
      continue;
    }
    const [key, inline] = a.slice(2).split("=", 2);
    const next = argv[i + 1];
    if (inline !== undefined) flags.set(key, inline);
    else if (next !== undefined && !next.startsWith("--") && key === "max-seconds") flags.set(key, argv[++i]);
    else flags.set(key, true);
  }
  const maxSeconds = Number(flags.get("max-seconds") ?? 0);
  const deadline = maxSeconds > 0 ? Date.now() + maxSeconds * 1000 : Infinity;
  return { positional, flag: (name: string) => flags.has(name), outOfTime: () => Date.now() > deadline };
}

export function runMain(main: () => Promise<number>): void {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
