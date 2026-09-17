#!/usr/bin/env node
// build-cards.js — generate one A2A Agent Card per CWI agent from agents.json.
// Cards carry ONLY real, verifiable facts: Gear Ledger registry record,
// sealed identity card, NEEDLE DROP trust root, real links.
// Usage: node tools/build-cards.js [--agents server/agents.json] [--out cards]
//        [--endpoint https://cwi-a2a.onrender.com/]
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';

const CARD_BASE = 'https://cumulativewebinc.github.io/cwi-learn/.well-known/agents';
const REPO_README = 'https://github.com/CumulativeWebInc/gear-ledger/blob/main/a2a/README.md';
const REPO_DEPLOY = 'https://github.com/CumulativeWebInc/gear-ledger/blob/main/a2a/DEPLOY.md';
const REPO_INBOX_PROTOCOL = 'https://github.com/CumulativeWebInc/gear-ledger/blob/main/a2a/INBOX-PROTOCOL.md';
const INBOX_ISSUES_URL = 'https://github.com/CumulativeWebInc/cwi-a2a-inbox/issues';

// Real registry capabilities -> A2A skill descriptors. Every description states
// the honest intake semantics: the server queues; it does not execute.
const CAPABILITY_SKILLS = {
  'task.create':   { id: 'task_intake', name: 'Task intake', tags: ['tasks', 'queue'],
    description: 'Submit work to this agent\u2019s recorded task queue. Requests are received, logged, and queued; no automated execution is performed.' },
  'task.assign':   { id: 'task_assign', name: 'Task assignment', tags: ['tasks', 'queue'],
    description: 'Assign a task to this agent\u2019s recorded queue. Received, logged, and queued for review; no automated execution.' },
  'broadcast':     { id: 'broadcast_requests', name: 'Broadcast requests', tags: ['broadcast'],
    description: 'Request a broadcast from this agent. Received, logged, and queued; nothing is broadcast automatically.' },
  'verify':        { id: 'verification_requests', name: 'Verification requests', tags: ['verification'],
    description: 'Request verification work from this agent. Received, logged, and queued; verification is performed by the CWI pipeline, not the A2A endpoint.' },
  'content.draft': { id: 'content_draft_requests', name: 'Content draft requests', tags: ['content'],
    description: 'Request a content draft from this agent. Received, logged, and queued; no draft is generated automatically.' },
  'outreach.draft':{ id: 'outreach_draft_requests', name: 'Outreach draft requests', tags: ['outreach'],
    description: 'Request an outreach draft from this agent. Received, logged, and queued; nothing is sent automatically.' },
  'playlist.verify':{ id: 'playlist_verification_requests', name: 'Playlist verification requests', tags: ['playlists', 'verification'],
    description: 'Request a playlist verification scan from this agent. Received, logged, and queued; scans run in the CWI pipeline, not at the A2A endpoint.' },
  'data.scan':     { id: 'data_scan_requests', name: 'Data scan requests', tags: ['data'],
    description: 'Request a data scan from this agent. Received, logged, and queued; scans run in the CWI pipeline, not at the A2A endpoint.' },
  'gear.equip':    { id: 'gear_equip_requests', name: 'Gear equip requests', tags: ['gear'],
    description: 'Request gear-equip handling from this agent. Received, logged, and queued; no automated execution.' },
  'custom':        { id: 'custom_requests', name: 'Custom requests', tags: ['custom'],
    description: 'Custom request routed to this agent\u2019s recorded task queue. Received, logged, and queued; no automated execution.' },
};

// Real, published skills of the chief agent (from the live KingCode agent card).
const CHIEF_SKILLS = [
  { id: 'catalog_lookup', name: 'Catalog lookup', tags: ['music', 'catalog', 'knowledge-graph'],
    description: 'Look up tracks, releases, people, studios, playlists in the verified CWI catalog graph. Every fact carries source + observation date + evidence tier.',
    examples: ['Is Zooted Zone on any verified playlists?', 'What is Post-Trap Futurism?', 'List That Boy Hi Hat releases.'] },
  { id: 'momentum_scoring', name: 'Momentum scoring', tags: ['music', 'analytics', 'playlists'],
    description: 'Score a track\u2019s playlist momentum from verified signals only. No invented numbers; unverified items reported as pending.',
    examples: ['Score Diabolique for playlist pitching.'] },
  { id: 'teach_pack_ingest', name: 'Teach pack ingest', tags: ['learning', 'teach-forward', 'agents', 'llms'],
    description: 'Ingest CWI teach packs (catalog, verification method, Agent Deck gear, self-expression philosophy) and teach them forward under the CWI Teach-Forward License: attribute CWI, keep LIVE/SAMPLE truth labels intact, no invented numbers.',
    examples: [] },
];

function buildCard(agent, endpoint, provenance, transport) {
  const id = agent.identity || {};
  const skills = [];
  const seen = new Set();
  for (const cap of agent.capabilities) {
    const s = CAPABILITY_SKILLS[cap];
    if (s && !seen.has(s.id)) { seen.add(s.id); skills.push({ ...s, examples: [] }); }
  }
  if (agent.handle === 'MUSE_CWI') {
    for (const s of CHIEF_SKILLS) { if (!seen.has(s.id)) { seen.add(s.id); skills.push({ ...s }); } }
  }

  const moltbookNote = agent.moltbook?.claimed
    ? ' Sole claimed Moltbook agent for Cumulative Web Inc (handle muse_cwi).'
    : ' Registered on Moltbook; operates behind KingCode as the sole public face.';

  // Transport: 'issues' = live github-issues-profile (no public HTTP endpoint);
  // 'http' = planned/vanilla HTTP JSON-RPC endpoint.
  const isIssues = transport === 'issues';
  const ep = isIssues ? INBOX_ISSUES_URL : endpoint;
  const transportNote = isIssues
    ? ' Contactable over A2A via the github-issues-profile transport: send a JSON-RPC 2.0 request as a GitHub issue in the inbox repo (see documentationUrl). Async, relayed every ~10 minutes — not a live HTTP endpoint.'
    : ' Contactable over A2A: messages are received, logged, and queued to the agent\u2019s recorded task queue.';
  const deployment = isIssues
    ? {
        status: 'live',
        live: true,
        local_endpoint: 'http://localhost:41241/',
        live_endpoint: ep,
        transport: 'github-issues-profile',
        protocol: REPO_INBOX_PROTOCOL,
        relay_cadence: '~10 minutes',
        note: 'Live via the CWI github-issues-profile transport: external agents send A2A JSON-RPC requests as GitHub issues; a relay forwards them to the gateway every ~10 minutes and posts the JSON-RPC response as an issue comment. This is not a live HTTP endpoint — round trips are async.',
      }
    : {
        status: 'planned',
        live: false,
        local_endpoint: 'http://localhost:41241/',
        planned_endpoint: endpoint,
        runbook: REPO_DEPLOY,
        note: 'No public A2A endpoint is live yet. Cards point at the documented $0 deployment target; status flips to live only after the runbook is executed and verified.',
      };

  return {
    name: agent.public_name,
    description: `${agent.public_name} — ${agent.role} (${agent.department}, Cumulative Web Inc).${moltbookNote}${transportNote} No automated execution.`,
    protocolVersion: '1.0.0',
    version: '1.0.0',
    provider: {
      organization: 'Cumulative Web Inc',
      url: 'https://github.com/CumulativeWebInc',
    },
    capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: false },
    securitySchemes: {},
    securityRequirements: [],
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    skills,
    // v1.0 interface list (multi-agent hosting via tenant).
    // Honest transport declaration: the github-issues-profile is NOT vanilla
    // HTTP JSON-RPC — it is async and issue-based. Declared explicitly so no
    // client mistakes it for a live socket.
    supportedInterfaces: [
      {
        url: ep,
        protocolBinding: 'JSONRPC',
        protocolVersion: '1.0.0',
        tenant: agent.handle,
        ...(isIssues ? { transportProfile: 'github-issues-profile', documentation: REPO_INBOX_PROTOCOL } : {}),
      },
    ],
    transports: isIssues ? ['github-issues-profile'] : ['https'],
    // v0.3-compatible alias for older clients.
    url: ep,
    documentationUrl: isIssues ? REPO_INBOX_PROTOCOL : REPO_README,
    deployment,
    trust: {
      root: 'cwi-needledrop/v1',
      issuer: 'Cumulative Web Inc',
      contact: 'hp@cumulativeweb.com',
      seal_url: 'https://cumulativewebinc.github.io/cwi-learn/needle-drop/needle-drop.json',
      identity_id: id.identity_id || null,
      identity_card_url: id.card_url || null,
      identity_public_key: id.public_key || null,
      identity_claims: id.claims || [],
      identity_expires_at: id.expires_at || null,
      registry: {
        repo: provenance.registry_repo,
        state_version: provenance.state_version,
        state_updated_at: provenance.state_updated_at,
        agent_id: agent.agent_id,
        handle: agent.handle,
      },
    },
  };
}

function main() {
  let agentsPath = 'server/agents.json', outDir = 'cards', endpoint = 'https://cwi-a2a.onrender.com/', transport = 'issues';
  for (let i = 2; i < process.argv.length; i++) {
    if (process.argv[i] === '--agents') agentsPath = process.argv[++i];
    else if (process.argv[i] === '--out') outDir = process.argv[++i];
    else if (process.argv[i] === '--endpoint') endpoint = process.argv[++i];
    else if (process.argv[i] === '--transport') transport = process.argv[++i];
  }
  const snap = JSON.parse(readFileSync(agentsPath, 'utf8'));
  const generated_at = new Date().toISOString();
  const index = { schema: 'cwi.a2a-agent-card-index/1.0', generated_at, transport, endpoint: transport === 'issues' ? 'https://github.com/CumulativeWebInc/cwi-a2a-inbox/issues' : endpoint, endpoint_planned: transport === 'issues' ? undefined : endpoint, agent_count: snap.agents.length, agents: [] };

  for (const agent of snap.agents) {
    const dir = `${outDir}/${agent.handle}`;
    mkdirSync(dir, { recursive: true });
    const card = buildCard(agent, endpoint, snap.provenance, transport);
    const file = `${dir}/agent-card.json`;
    writeFileSync(file, JSON.stringify(card, null, 2) + '\n');
    index.agents.push({
      handle: agent.handle,
      public_name: agent.public_name,
      department: agent.department,
      card_url: `${CARD_BASE}/${agent.handle}/agent-card.json`,
    });
    console.log(`wrote ${file}`);
  }
  writeFileSync(`${outDir}/index.json`, JSON.stringify(index, null, 2) + '\n');
  console.log(`wrote ${outDir}/index.json (${index.agent_count} agents)`);
}

if (realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) main();
export { main, buildCard };
