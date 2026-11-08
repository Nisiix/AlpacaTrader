export interface CliArgs {
  fake: boolean;
  force: boolean;
  slot?: string;
  now?: string;
  state?: string;
  logs?: string;
  // Motore degli agenti e dashboard.
  once: boolean;
  tick?: number;
  port?: number;
  noDashboard: boolean;
  kronos?: string;
  profitto: boolean;
  crypto: boolean;
  // Motore degli agenti: le crypto sono di serie; --no-crypto le toglie.
  noCrypto: boolean;
}

export function parseArgs(argv: string[]): CliArgs {
  const a: CliArgs = { fake: false, force: false, once: false, noDashboard: false, profitto: false, crypto: false, noCrypto: false };
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
    else if (k === "--once") a.once = true;
    else if (k === "--tick") a.tick = Number(val());
    else if (k === "--port") a.port = Number(val());
    else if (k === "--no-dashboard") a.noDashboard = true;
    else if (k === "--kronos") a.kronos = val();
    else if (k === "--profitto") a.profitto = true;
    else if (k === "--crypto") a.crypto = true;
    else if (k === "--no-crypto") a.noCrypto = true;
    else throw new Error(`opzione sconosciuta: ${k}`);
  }
  if (a.now && !a.fake) throw new Error("--now si usa solo con --fake");
  return a;
}
