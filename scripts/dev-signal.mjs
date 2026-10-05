#!/usr/bin/env node
/**
 * `node scripts/dev-signal.mjs [port]` — a LOCAL PeerJS signalling server for QA / LAN play (online multiplayer, WP-N1).
 *
 * The game normally brokers WebRTC connections through the free public PeerJS cloud. For testing without internet
 * (or without depending on a third party) run this server and point the clients at it with the `signal` URL parameter:
 *
 *     node scripts/dev-signal.mjs                      # listens on port 9000 (or $PORT / the first argument)
 *     http://localhost:5173/?signal=localhost:9000     # Vite dev server, one tab per player
 *
 * Packet-loss / latency simulation per tab (optional, outgoing packets of that tab only):
 *     ...&netsim=latency:80,jitter:20,loss:0.05
 *
 * Electron windows have no address bar: set the same values once in DevTools (F12) → Console:
 *     localStorage.setItem('gk-signal', 'localhost:9000'); localStorage.setItem('gk-netsim', 'latency:80,jitter:20,loss:0.05')
 * and reload. (Electron's CSP only allows localhost / 127.0.0.1 signalling servers.)
 *
 * Only the signalling (who is online, SDP/ICE hand-off) goes through this server; game traffic flows peer to peer.
 * Nothing here is used in production.
 */

import { createServer } from 'node:net';
import { networkInterfaces } from 'node:os';
import { PeerServer } from 'peer';

const arg = process.argv[2];
const port = Number(arg ?? process.env.PORT ?? 9000);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(`Invalid port "${arg ?? process.env.PORT}". Usage: node scripts/dev-signal.mjs [port]`);
  process.exit(1);
}

// The PeerServer's HTTP server throws an uncaught EADDRINUSE; check the port first for a friendly message.
await new Promise((resolve) => {
  const probe = createServer();
  probe.once('error', (err) => {
    console.error(err && err.code === 'EADDRINUSE' ? `Port ${port} is already in use. Is another dev-signal running? Try: node scripts/dev-signal.mjs ${port + 1}` : `Cannot listen on port ${port}: ${err.message}`);
    process.exit(1);
  });
  probe.listen(port, () => probe.close(() => resolve()));
});

const server = PeerServer({ port, path: '/', allow_discovery: false, corsOptions: { origin: true } }, () => {
  console.log(`PeerJS signalling server listening on port ${port}  (path "/", key "peerjs")`);
  console.log('');
  console.log('Open the game with the signal parameter, e.g. on this machine:');
  console.log(`  http://localhost:5173/?signal=localhost:${port}`);
  const lan = Object.values(networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);
  if (lan.length > 0) {
    console.log('From other machines on the LAN (plain http pages only; browsers block ws:// from https pages):');
    for (const ip of lan) console.log(`  http://${ip}:5173/?signal=${ip}:${port}`);
  }
  console.log('');
  console.log('Add &netsim=latency:80,jitter:20,loss:0.05 to degrade one tab. Ctrl+C stops the server.');
});

server.on('connection', (client) => console.log(`+ ${client.getId()}`));
server.on('disconnect', (client) => console.log(`- ${client.getId()}`));
server.on('error', (err) => {
  console.error(`Signalling server error: ${err && err.message ? err.message : err}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(0));
