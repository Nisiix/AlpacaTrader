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
// Tetti storici delle crypto e del budget intraday (fino all'11/11/2026): i test della meccanica (riparto, riserva, tetto
// per settore, ingressi per giro) li usano; i valori di serie (crypto fino al 100% del conto) hanno test propri in
// tests/crypto-cento.test.ts.
// I valori di serie di src/config.ts, letti prima che il preload li cambi.
export const TETTI_SERIE = { quota: AGENTS.intraday.budget.quota, maxCrypto: AGENTS.intraday.budget.maxCrypto, maxWeight: AGENTS.intraday.maxWeight, maxIngressiGiro: AGENTS.intraday.crypto.maxIngressiGiro, maxAperte: AGENTS.intraday.crypto.maxAperte, gruppi: { ...LIMITS.groupMaxBySector } };
export const TETTI_STORICI = { quota: 0.8, maxCrypto: 0.2, maxWeight: 0.25, maxIngressiGiro: 2, maxAperte: 3 };
AGENTS.intraday.budget.quota = TETTI_STORICI.quota;
AGENTS.intraday.budget.maxCrypto = TETTI_STORICI.maxCrypto;
AGENTS.intraday.maxWeight = TETTI_STORICI.maxWeight;
AGENTS.intraday.crypto.maxIngressiGiro = TETTI_STORICI.maxIngressiGiro;
AGENTS.intraday.crypto.maxAperte = TETTI_STORICI.maxAperte;
LIMITS.groupMaxBySector = {};
