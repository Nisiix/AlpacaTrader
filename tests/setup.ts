// Preload dei test (bunfig.toml): i test misurano la meccanica del motore con i limiti storici (5 posizioni, 20% per
// titolo, taglia non legata alla fiducia in Kronos, limite di volatilità spento). I valori di serie per l'uso reale
// sono in src/config.ts e hanno test propri (vedi "taglia proporzionale alla fiducia").
import { AGENTS, LIMITS } from "../src/config.ts";

LIMITS.maxPositions = 5;
LIMITS.maxPositionPct = 0.2;
AGENTS.sizing.byKronos = false;
