'use strict';
/*
 * Render Xray (VLESS+WS+TLS) — Node supervisor edition
 *
 * Architecture:
 *   client --WSS(443, edge TLS)--> Render edge --WS upgrade--> this Node app (PORT)
 *   Node forwards only the configured WS path, over raw TCP, to Xray on 127.0.0.1:10000.
 *   Plain HTTP requests get a camouflage page, /health, and the subscription endpoint.
 *   TLS is terminated by the Render edge on the service's *.onrender.com address.
 */
const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8')); } catch (_) {}
if (process.env.NODE_UUID) cfg.uuid = process.env.NODE_UUID;
if (process.env.WS_PATH) cfg.wsPath = process.env.WS_PATH;
if (process.env.SUB_TOKEN) cfg.subToken = process.env.SUB_TOKEN;
if (process.env.REMARK) cfg.remark = process.env.REMARK;
if (!cfg.uuid || !cfg.wsPath || !cfg.subToken) {
  console.error('[supervisor] missing config: NODE_UUID / WS_PATH / SUB_TOKEN env vars (or config.json) are required');
  process.exit(1);
}
cfg.remark = cfg.remark || 'Render';
const PORT = parseInt(process.env.PORT || '8080', 10);
const XRAY_PORT = 10000;
const XRAY_BIN = path.join(__dirname, 'core', 'xray');

// ---------- Xray config ----------
function xrayConfig() {
  return {
    log: { loglevel: 'warning' },
    inbounds: [
      {
        listen: '127.0.0.1',
        port: XRAY_PORT,
        protocol: 'vless',
        settings: {
          clients: [{ id: cfg.uuid, flow: '' }],
          decryption: 'none',
        },
        streamSettings: {
          network: 'ws',
          security: 'none',
          wsSettings: { path: cfg.wsPath },
        },
        sniffing: {
          enabled: true,
          destOverride: ['http', 'tls'],
          routeOnly: true,
        },
      },
    ],
    outbounds: [
      { protocol: 'freedom', tag: 'direct' },
      { protocol: 'blackhole', tag: 'block' },
    ],
    routing: {
      domainStrategy: 'IPIfNonMatch',
      // Never let the proxy be used to reach private/metadata addresses.
      // (Xray 26 freedom also blocks private targets by default for
      // proxy inbounds — this rule is a second, explicit layer.)
      rules: [
        {
          type: 'field',
          ip: [
            '10.0.0.0/8',
            '172.16.0.0/12',
            '192.168.0.0/16',
            '127.0.0.0/8',
            '169.254.0.0/16',
            '::1/128',
            'fc00::/7',
            'fe80::/10',
          ],
          outboundTag: 'block',
        },
      ],
    },
  };
}

// ---------- Xray supervision ----------
let xrayProc = null;
let stopping = false;

function startXray() {
  const cfgPath = path.join(os.tmpdir(), 'xray-config.json');
  fs.writeFileSync(cfgPath, JSON.stringify(xrayConfig()));
  try { fs.chmodSync(XRAY_BIN, 0o755); } catch (_) {}
  xrayProc = spawn(XRAY_BIN, ['run', '-c', cfgPath], { stdio: ['ignore', 'pipe', 'pipe'] });
  xrayProc.stdout.on('data', (d) => process.stdout.write(`[xray] ${d}`));
  xrayProc.stderr.on('data', (d) => process.stderr.write(`[xray] ${d}`));
  xrayProc.on('exit', (code, signal) => {
    console.log(`[supervisor] xray exited code=${code} signal=${signal}`);
    if (!stopping) {
      console.log('[supervisor] restarting xray in 1s');
      setTimeout(startXray, 1000);
    }
  });
  console.log('[supervisor] xray started');
}

// ---------- Subscription helpers ----------
function publicHost(req) {
  let h = (req.headers.host || req.headers['x-forwarded-host'] || '').toString().split(',')[0].trim();
  return h || 'localhost';
}

function vlessLink(req) {
  const host = publicHost(req);
  const params = new URLSearchParams({
    encryption: 'none',
    security: 'tls',
    type: 'ws',
    host,
    path: cfg.wsPath,
    sni: host,
  });
  return `vless://${cfg.uuid}@${host}:443?${params.toString()}#${encodeURIComponent(cfg.remark)}`;
}

const HOME_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Field Notes</title>
<style>body{font-family:Georgia,serif;max-width:42rem;margin:4rem auto;padding:0 1.2rem;color:#222;line-height:1.7}h1{font-size:1.6rem}small{color:#777}</style>
</head><body>
<h1>Field Notes</h1>
<p><small>Occasional notes on self-hosting, small tools and quiet infrastructure.</small></p>
<p>Everything here runs on modest hardware and boring technology. Posts are written
when there is something worth writing down, and not a moment before.</p>
<p>More soon.</p>
</body></html>`;

// ---------- HTTP server ----------
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://internal');
  if (url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (url.pathname === `/sub/${cfg.subToken}`) {
    const body = Buffer.from(vlessLink(req) + '\n', 'utf8').toString('base64');
    res.writeHead(200, {
      'content-type': 'text/plain; charset=utf-8',
      'profile-update-interval': '24',
      'subscription-userinfo': 'upload=0; download=0; total=0; expire=0',
    });
    res.end(body);
    return;
  }
  if (url.pathname === `/link/${cfg.subToken}`) {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(vlessLink(req));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(HOME_PAGE);
});

// WebSocket upgrade: only the secret WS path is proxied to Xray, raw.
server.on('upgrade', (req, socket, head) => {
  let pathname;
  try { pathname = new URL(req.url, 'http://internal').pathname; } catch (_) { pathname = req.url; }
  if (pathname !== cfg.wsPath) {
    socket.destroy();
    return;
  }
  const upstream = net.connect(XRAY_PORT, '127.0.0.1', () => {
    const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
    }
    upstream.write(lines.join('\r\n') + '\r\n\r\n');
    if (head && head.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  upstream.on('error', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
});

function shutdown() {
  stopping = true;
  if (xrayProc) xrayProc.kill('SIGTERM');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

startXray();
server.listen(PORT, '0.0.0.0', () => {
  console.log(`[supervisor] http listening on 0.0.0.0:${PORT}`);
});
