#!/bin/bash
# Prepara una sessione cloud: dipendenze di sviluppo (bun-types, typescript) e un secrets.ts vuoto,
# così `bun test` e `bun run typecheck` funzionano. Non tocca mai un secrets.ts esistente.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-$(dirname "$0")/../..}"

if ! command -v bun >/dev/null 2>&1; then
  curl -fsSL https://bun.sh/install | bash
  export PATH="$HOME/.bun/bin:$PATH"
  echo "export PATH=\"$HOME/.bun/bin:\$PATH\"" >> "${CLAUDE_ENV_FILE:-/dev/null}"
fi

bun install

# Chiavi vuote: il broker finto non le usa e il guard le accetta; quelle vere restano solo sul tuo computer.
if [ ! -f secrets.ts ]; then
  cp secrets.example.ts secrets.ts
fi
