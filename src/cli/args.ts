export interface CliArgs {
  fake: boolean;
  force: boolean;
  slot?: string;
  now?: string;
  state?: string;
  logs?: string;
}

export function parseArgs(argv: string[]): CliArgs {
  const a: CliArgs = { fake: false, force: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]!;
    const val = () => {
      const v = argv[++i];
      if (!v) throw new Error(`manca il valore di ${k}`);
      return v;
    };
    if (k === "--fake") a.fake = true;
    else if (k === "--force") a.force = true;
    else if (k === "--slot") a.slot = val();
    else if (k === "--now") a.now = val();
    else if (k === "--state") a.state = val();
    else if (k === "--logs") a.logs = val();
    else throw new Error(`opzione sconosciuta: ${k}`);
  }
  if (a.now && !a.fake) throw new Error("--now si usa solo con --fake");
  return a;
}
