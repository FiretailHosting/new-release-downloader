#!/usr/bin/env node
require('dotenv').config();
const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { Readable }     = require('stream');
const { pipeline }     = require('stream/promises');
const { Transform }    = require('stream');

/* ---------- CLI / ENV helper ---------- */
const cli = Object.fromEntries(
  process.argv.slice(2).map(a => {
    let [k, v] = a.startsWith('--') ? a.slice(2).split('=') : [];
    if (!v) { const i = process.argv.indexOf(a); v = !process.argv[i+1]?.startsWith('--') ? process.argv[i+1] : true; }
    return [k.replace(/-([a-z])/g, (_,c)=>c.toUpperCase()), v];
  })
);
const cfg = (k,e=k)=>cli[k] ?? process.env[e];

/* ---------- Client IP Helper ---------- */
function clientIP(req) {
  if (req.headers['x-forwarded-for']) {
    // may contain "client, proxy1, proxy2"
    return req.headers['x-forwarded-for'].split(',')[0].trim();
  }
  if (req.headers['x-real-ip']) {
    return req.headers['x-real-ip'];
  }
  return req.socket.remoteAddress;
}

/* ---------- configuration ---------- */
const appId     = cfg('appId','GITHUB_APP_ID');
const installationId  = cfg('installationId','GITHUB_INSTALLATION_ID');
const owner     = cfg('owner','GITHUB_OWNER');
const repo      = cfg('repo','GITHUB_REPO');
const downloadFolder = cfg('downloadFolder','DOWNLOAD_FOLDER') || './';
const assetName = cfg('assetName','ASSET_NAME');
const outputFileName = cfg('outputFileName','OUTPUT_FILE_NAME') || 'download';
const githubPrivateKeyFilepath = cfg('githubPrivateKeyFilepath','GITHUB_PRIVATE_KEY_FILEPATH');
const postDownloadCommand      = cfg('postDownloadCommand','POST_DOWNLOAD_COMMAND');
const webhookSecret            = cfg('webhookSecret','WEBHOOK_SECRET');      // NEW
const webhookPath       = cfg('webhookPath','WEBHOOK_PATH'); // NEW

/* ---------- simple log helpers ---------- */
const ok  = m => console.log(`✔ ${m}`);
const die = m => { console.error(m); process.exit(1); };
const warn = m => console.warn(`⚠ ${m}`);
const log = (tag, msg) => console.log(`[${new Date().toISOString()}] [${tag}] ${msg}`);

/* ---------- pre-flight checks (unchanged except for log) ---------- */
try {
  if (!appId||!installationId||!owner||!repo||!assetName||!githubPrivateKeyFilepath || !webhookPath)
    die('❌ Missing required config');
  ok('Required config present');
  if (!/^\d+$/.test(String(installationId))) die('❌ installationId must be numeric');
  ok('Installation ID numeric');
  fs.accessSync(githubPrivateKeyFilepath, fs.constants.R_OK);
  ok('Private-key file readable');
  if (postDownloadCommand) {
    if (typeof postDownloadCommand !== 'string') die('❌ postDownloadCommand must be a string');
    if (!postDownloadCommand.trim()) die('❌ postDownloadCommand must not be empty');
    ok('Post-download command valid');
  }
  if (webhookSecret) ok('Webhook secret set');
  else warn('webhookSecret not set, webhook auth disabled');
  if (webhookPath) {
    if (!webhookPath.startsWith('/')) die('❌ webhookPath must start with "/"');
    if (webhookPath.endsWith('/')) die('❌ webhookPath must not end with "/"');
    ok('Webhook path valid');
  }
} catch(e) { die(e.message); }

/* ---------- GitHub auth & asset presence (unchanged) ---------- */
let baseAuth;                // cached Octokit deps
(async () => {
  const { Octokit } = await import('@octokit/rest');
  const { createAppAuth } = await import('@octokit/auth-app');
  const privateKey = fs.readFileSync(githubPrivateKeyFilepath,'utf8');

  const octokit = new Octokit({ authStrategy:createAppAuth, auth:{ appId, privateKey, installationId } });
  try { await octokit.auth({ type:'installation' }); ok('Authenticated with GitHub'); }
  catch { die('❌ GitHub authentication failed'); }

  const rel = (await octokit.repos.getLatestRelease({ owner, repo })).data;
  if (!rel.assets?.length) die('❌ latest release has no assets');
  if (!rel.assets.find(a=>a.name===assetName)) die(`❌ asset "${assetName}" not found`);
  ok(`Asset "${assetName}" present in latest release`);

  baseAuth = { Octokit, createAppAuth, privateKey };
  console.log('🌐 Pre-flight done — starting server…');
  startServer();
})();

/* ---------- WEBHOOK SERVER ---------- */
function startServer() {
  let busy = false;                              // serialise downloads

  const server = http.createServer(async (req, res) => {
    const remote = clientIP(req);
    if (req.method === 'POST' && req.url === webhookPath) {
      log('REQ', `POST ${webhookPath} from ${remote}`);

      const body = await readBody(req);          // may be zero bytes

      /* ---------- secret validation ---------- */
      if (webhookSecret) {
        const sig = req.headers['x-hub-signature-256'];
        if (!sig) {
          log('AUTH', `Missing signature header from ${remote}`);
          return unauthorized(res, 'signature_required');
        }
        if (!verifySig(body, sig)) {
          log('AUTH', `Bad signature from ${remote}`);
          return unauthorized(res, 'signature_mismatch');
        }
        log('AUTH', `Signature OK from ${remote}`);
      }
      
      /* ---------- busy guard ---------- */
      if (busy) {
        log('BUSY', `Refusing new job (already busy)`);
        return json(res, 429, { status:'busy' });
      }

      /* ---------- run download ---------- */
      busy = true;
      try {
        const info = await runDownload();   // {bytes}
        log('DONE', `Download successful (${info.bytes} bytes)`);
        json(res, 200, { status:'success', asset:assetName, bytes:info.bytes });
      } catch (err) {
        log('ERR', `Download failed: ${err.message}`);
        json(res, 500, { status:'error', message:err.message });
      } finally {
        busy = false;
      }
    } else {
      json(res, 404, { status:'not_found'});
      log('REQ', `GET ${req.url} from ${remote}`);
    }
  });

  const port = process.env.PORT || 3000;
  server.listen(port, '0.0.0.0', () =>
    console.log(`🚀 Listening (IPv4-only) POST http://0.0.0.0:${port}${webhookPath}`)
  );
}

/* ---------- helper fns ---------- */
const json = (res, code, obj) =>
  res.writeHead(code, { 'content-type':'application/json' })
     .end(JSON.stringify(obj) + '\n');

const unauthorized = (res, reason) =>
  json(res, 401, { status:'unauthorized', reason });

const readBody = req => new Promise(resolve => {
  const chunks = [];
  req.on('data', c => chunks.push(c))
     .on('end', () => resolve(Buffer.concat(chunks)));
});

function verifySig(buf, header) {
  const expected = 'sha256=' +
    crypto.createHmac('sha256', webhookSecret).update(buf).digest('hex');
  // constant-time compare to avoid timing leaks
  try { return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(header)); }
  catch { return false; }
}

/* ---------- download logic (unchanged) ---------- */
async function runDownload() {
  const { Octokit, createAppAuth, privateKey } = baseAuth;
  const octokit = new Octokit({ authStrategy:createAppAuth, auth:{ appId, privateKey, installationId } });
  const { token } = await octokit.auth({ type:'installation' });

  const rel = (await octokit.repos.getLatestRelease({ owner, repo })).data;
  const asset = rel.assets.find(a => a.name === assetName);
  if (!asset) throw new Error('asset missing');

  const url = `https://api.github.com/repos/${owner}/${repo}/releases/assets/${asset.id}`;
  const response = await fetch(url, {
    headers:{
      Authorization:`token ${token}`,
      Accept:'application/octet-stream',
      'User-Agent':'release-downloader'
    },
    redirect:'follow'
  });
  if (!response.ok) throw new Error(`download HTTP ${response.status}`);

  const total = parseInt(response.headers.get('content-length') || '0', 10) || null;
  let bytes = 0;
  const progress = new Transform({
    transform(c, _e, cb) {
      bytes += c.length;
      if (total) {
        const pct = ((bytes / total) * 100).toFixed(1);
        process.stdout.write(`\r${bytes}/${total} (${pct}%)   `);
      }
      cb(null, c);
    }
  });
  const filePath = path.join(downloadFolder, outputFileName);
  await pipeline(Readable.fromWeb(response.body), progress, fs.createWriteStream(filePath));
  console.log('\n✅ file saved');

  if (postDownloadCommand) {
    const cmd = postDownloadCommand;  
    console.log(`▶ ${cmd}`);
    execFileSync('/bin/bash', ['-c', cmd], { stdio:'inherit' });
    console.log('✅ post-command finished');
  }
  return { bytes };
}
