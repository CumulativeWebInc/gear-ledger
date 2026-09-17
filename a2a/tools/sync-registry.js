#!/usr/bin/env node
// sync-registry.js — regenerate a2a/agents.json from the REAL canonical sources.
// Sources (all live, verifiable):
//   1. Gear Ledger canonical state: `node ~/workspace/gear-ledger/cli/ledger.js state get`
//   2. Sealed identity cards: CumulativeWebInc/cwi-identity-ledger (cards.json index)
// Usage: node tools/sync-registry.js [--out a2a/agents.json] [--identity-snapshot /tmp/identity-cards.json]
// Writes agents.json with provenance (source repo, state version, synced_at).
import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';

const LEDGER_CLI = process.env.CWI_LEDGER_CLI || '/home/hatch/workspace/gear-ledger/cli/ledger.js';

function args() {
  const a = {};
  for (let i = 2; i < process.argv.length; i++) {
    if (process.argv[i] === '--out') a.out = process.argv[++i];
    else if (process.argv[i] === '--identity-snapshot') a.identity = process.argv[++i];
  }
  return a;
}

function main() {
  const { out = 'a2a/agents.json', identity = null } = args();

  // 1. Canonical agent registry from the Gear Ledger CLI (live state).
  const raw = execFileSync('node', [LEDGER_CLI, 'state', 'get'], { maxBuffer: 64 * 1024 * 1024 });
  const state = JSON.parse(raw.toString('utf8'));

  // 2. Sealed identity cards (optional snapshot file; identity ids are stable).
  let identities = {};
  if (identity) {
    try { identities = JSON.parse(readFileSync(identity, 'utf8')); } catch { identities = {}; }
  }

  const agents = state.agents
    .filter((a) => a.status === 'active')
    .map((a) => ({
      handle: a.handle,
      agent_id: a.agent_id,
      public_name: a.public_name,
      department: a.department,
      role: a.role,
      capabilities: a.capabilities || [],
      home_island: a.home_island || null,
      moltbook: a.moltbook || { registered: false, claimed: false },
      identity: identities[a.handle] || null,
    }));

  const snapshot = {
    schema: 'cwi.a2a-agent-snapshot/1.0',
    synced_at: new Date().toISOString(),
    provenance: {
      registry_repo: state.repo || 'CumulativeWebInc/gear-ledger',
      state_version: state.version,
      state_updated_at: state.updated_at,
      ledger_cli: LEDGER_CLI,
      identity_repo: 'CumulativeWebInc/cwi-identity-ledger',
      trust_root: {
        format: 'cwi-needledrop/v1',
        issuer: 'Cumulative Web Inc',
        contact: 'hp@cumulativeweb.com',
        seal_url: 'https://cumulativewebinc.github.io/cwi-learn/needle-drop/needle-drop.json',
      },
    },
    agent_count: agents.length,
    agents,
  };

  writeFileSync(out, JSON.stringify(snapshot, null, 2) + '\n');
  console.log(`wrote ${out}: ${agents.length} agents, state v${state.version} @ ${state.updated_at}`);
}

if (realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) main();
export { main };
