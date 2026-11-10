// Preload dei test (bunfig.toml): i test misurano la meccanica del motore con i limiti storici (5 posizioni, 20% per
// titolo, taglia non legata alla fiducia in Kronos, limite di volatilità spento). I valori di serie per l'uso reale
// sono in src/config.ts e hanno test propri (vedi "taglia proporzionale alla fiducia").
import { AGENTS, LIMITS } from "../src/config.ts";

LIMITS.maxPositions = 5;
LIMITS.maxPositionPct = 0.2;
AGENTS.sizing.byKronos = false;
LIMITS.breakerEnabled = true;
// La meccanica intraday è provata soprattutto sulle crypto (24 ore su 24) e con le soglie storiche 55%/57%: di serie gli
// acquisti crypto sono fermi e le soglie al 60% (10/11/2026), con test propri in tests/crypto-ferme.test.ts.
AGENTS.cryptoAcquisti.enabled = true;
AGENTS.intraday.kronos.minProb = 0.55;
AGENTS.intraday.kronos.minProbSenzaGrafico = 0.57;
