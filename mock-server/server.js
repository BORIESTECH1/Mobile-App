const express = require('express');
const cors = require('cors');
const path = require('path');
const { exec } = require('child_process');
const fs = require('fs');
const app = express();
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const speakeasy = require('speakeasy');
app.use(cors());
app.use(express.json());
app.use(cookieParser());

// basic rate limiter for auth endpoints (IP-based)
const authLimiter = rateLimit({ windowMs: 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false });

// serve static files from project root so dashboard.html is reachable at /dashboard.html
app.use(express.static(path.join(__dirname, '..')));

// serve uploaded avatars
const UPLOAD_DIR = path.join(__dirname, 'uploads');
try{ if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true }); }catch(e){}
app.use('/uploads', express.static(UPLOAD_DIR));

// Persist accounts to disk for debugging and stateful tests
const ACCOUNTS_FILE = path.join(__dirname, 'accounts.json');
function loadAccounts(){
  try{
    if (fs.existsSync(ACCOUNTS_FILE)){
      const raw = fs.readFileSync(ACCOUNTS_FILE, 'utf8');
      const obj = JSON.parse(raw || '{}');
      Object.assign(accounts, obj);
    }
  }catch(e){ console.warn('Failed to load accounts.json', e); }
}
function saveAccounts(){
  try{ fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(accounts, null, 2), 'utf8'); }catch(e){ console.warn('Failed to save accounts.json', e); }
}
// load at startup
loadAccounts();

function randomChoice(arr){ return arr[Math.floor(Math.random()*arr.length)]; }

app.get('/', (req, res) => {
  res.send('<h3>Fast & Reliable Bank Mock Server</h3><p>POST /process-tx to simulate processing. Dashboard is available at <a href="/dashboard.html">/dashboard.html</a></p>');
});

app.post('/process-tx', (req, res) => {
  const tx = req.body || {};
  console.log('Received process-tx', tx.id || 'no-id', tx);
  // If MOCK_AUTH=1 then require Authorization (either static token or Bearer JWT)
  if (process.env.MOCK_AUTH === '1'){
    const a = authCheck(req);
    if (!a.ok) {
      console.warn('Unauthorized request - auth required');
      return res.status(401).json({ status: 'failed', error: 'unauthorized' });
    }
  }
  // simple deterministic-ish behaviour: if amount > 100000 -> fail sometimes
  const amount = Number(tx.amount || 0);
  const r = Math.random();
  let status = 'success';
  if (r < 0.05) status = 'pending';
  else if (r < 0.13) status = 'failed';
  else status = 'success';

  // slight bias: large amounts more likely to fail
  if (amount > 100000 && Math.random() < 0.25) status = 'failed';

  const result = {
    status,
    ref: 'srv_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2,8),
    transactionRef: 'srv_' + Date.now().toString(36)
  };
  // simulate a short processing delay
  setTimeout(()=> res.json(result), 600 + Math.floor(Math.random()*900));
});

// Simple fraud assessment endpoint (mock): returns a score 0-100 and reasons
app.post('/fraud/assess', (req, res) => {
  const body = req.body || {};
  const username = (body.user || '').toString();
  const amount = Number(body.amount || 0);
  const dest = body.dest || null;
  const reasons = [];
  let score = 0;

  // high amount checks
  if (amount > 100000) { score += 60; reasons.push('high_amount'); }
  else if (amount > 50000) { score += 30; reasons.push('medium_amount'); }

  // user known? low trust increases score
  const acct = accounts[username];
  if (!acct) { score += 20; reasons.push('unknown_user'); }
  else {
    const trust = (acct.trustScore != null) ? Number(acct.trustScore) : 50;
    if (trust < 40){ score += 20; reasons.push('low_trust'); }
  }

  // velocity: recent txs stored on account
  try{
    accounts[username] = accounts[username] || {};
    accounts[username].recentTxs = accounts[username].recentTxs || [];
    const now = Date.now();
    // remove old entries older than 60s
    accounts[username].recentTxs = accounts[username].recentTxs.filter(t => now - t < 60*1000);
    // count recent
    const recent = accounts[username].recentTxs.length || 0;
    if (recent >= 3){ score += 40; reasons.push('high_velocity'); }
    else if (recent > 0){ score += 10; }
    // record this attempt
    accounts[username].recentTxs.push(now);
    saveAccounts();
  }catch(e){}

  // dest name mismatch heuristic (if dest provided and acct has displayName)
  if (dest && acct && acct.displayName){
    const destStr = (''+dest).toLowerCase();
    const nameStr = (''+acct.displayName).toLowerCase();
    if (destStr && nameStr && destStr.indexOf(nameStr) === -1){ score += 15; reasons.push('name_mismatch'); }
  }

  if (score > 100) score = 100;
  let action = 'allow';
  if (score >= 75) action = 'block';
  else if (score >= 50) action = 'review';

  return res.json({ score, reasons, action });
});

// simple create-account endpoint for signup testing
const accounts = {};

// Authentication helpers (optional via environment)
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const JWT_SECRET = process.env.MOCK_JWT_SECRET || 'dev_mock_secret_please_change';
const ACCESS_EXPIRES = process.env.MOCK_ACCESS_EXPIRES || '15m';
const REFRESH_EXPIRES = process.env.MOCK_REFRESH_EXPIRES || (60 * 60 * 24 * 30) + 's'; // 30 days


// Load or generate RSA keypair for signing ID tokens and JWTs (RS256)
let RSA_PRIVATE_KEY = null;
let RSA_PUBLIC_JWK = null;
let RSA_PUBLIC_PEM = null; // PEM form of public key for jwt.verify when available
// Persist RSA keys to disk so JWKS remains stable across restarts
const KEYS_DIR = path.join(__dirname, 'keys');
const PRIV_PATH = path.join(KEYS_DIR, 'private.pem');
const PUB_JWK_PATH = path.join(KEYS_DIR, 'public.jwk.json');
try{
  if (!fs.existsSync(KEYS_DIR)) fs.mkdirSync(KEYS_DIR, { recursive: true });
  if (fs.existsSync(PRIV_PATH) && fs.existsSync(PUB_JWK_PATH)){
    // load existing
    RSA_PRIVATE_KEY = fs.readFileSync(PRIV_PATH, 'utf8');
    const jwkRaw = fs.readFileSync(PUB_JWK_PATH, 'utf8');
    try{ RSA_PUBLIC_JWK = JSON.parse(jwkRaw); }catch(e){ RSA_PUBLIC_JWK = null; }
    // attempt to load public PEM if present, otherwise try to derive from JWK
    const pubPemPath = path.join(KEYS_DIR, 'public.pem');
    if (fs.existsSync(pubPemPath)){
      try{ RSA_PUBLIC_PEM = fs.readFileSync(pubPemPath, 'utf8'); }catch(e){ RSA_PUBLIC_PEM = null; }
    } else if (RSA_PUBLIC_JWK) {
      try{
        // convert JWK to PEM using crypto
        const pubKeyObj = crypto.createPublicKey(RSA_PUBLIC_JWK);
        RSA_PUBLIC_PEM = pubKeyObj.export({ type: 'spki', format: 'pem' });
        fs.writeFileSync(pubPemPath, RSA_PUBLIC_PEM, 'utf8');
      }catch(e){ RSA_PUBLIC_PEM = null; }
    }
  } else {
    // generate and persist
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    RSA_PRIVATE_KEY = privateKey.export({ type: 'pkcs1', format: 'pem' });
    // attempt to export JWK for the public key
    try{
      const pubJwk = publicKey.export({ format: 'jwk' });
      pubJwk.kid = pubJwk.kid || 'mock-rs-kid';
      RSA_PUBLIC_JWK = pubJwk;
      // also export public PEM for jwt.verify convenience
      try{ RSA_PUBLIC_PEM = publicKey.export({ type: 'spki', format: 'pem' }); }catch(e){ RSA_PUBLIC_PEM = null; }
      fs.writeFileSync(PRIV_PATH, RSA_PRIVATE_KEY, 'utf8');
      fs.writeFileSync(PUB_JWK_PATH, JSON.stringify(RSA_PUBLIC_JWK, null, 2), 'utf8');
      if (RSA_PUBLIC_PEM) fs.writeFileSync(path.join(KEYS_DIR, 'public.pem'), RSA_PUBLIC_PEM, 'utf8');
    }catch(e){
      // if JWK export fails, still persist the private key
      fs.writeFileSync(PRIV_PATH, RSA_PRIVATE_KEY, 'utf8');
      RSA_PUBLIC_JWK = null;
      RSA_PUBLIC_PEM = null;
    }
  }
}catch(e){ console.warn('RSA keygen/load failed, falling back to symmetric JWT', e); RSA_PRIVATE_KEY = null; RSA_PUBLIC_JWK = null; }

function generateAccessToken(username){
  // Prefer RSA signing (RS256) when private key is available for realistic JWKS/verification.
  const payload = { username };
  if (RSA_PRIVATE_KEY) {
    const opts = { expiresIn: ACCESS_EXPIRES, algorithm: 'RS256' };
    if (RSA_PUBLIC_JWK && RSA_PUBLIC_JWK.kid) opts.keyid = RSA_PUBLIC_JWK.kid;
    return jwt.sign(payload, RSA_PRIVATE_KEY, opts);
  }
  // fallback to symmetric HS256
  return jwt.sign(payload, JWT_SECRET, { expiresIn: ACCESS_EXPIRES });
}

function generateRefreshToken(){
  return crypto.randomBytes(32).toString('hex');
}

function verifyAccessToken(token){
  try{
    if (RSA_PUBLIC_PEM) return jwt.verify(token, RSA_PUBLIC_PEM);
    return jwt.verify(token, JWT_SECRET);
  }catch(e){ return null; }
}

function findUserByRefresh(token){
  for (const k of Object.keys(accounts)){
    const a = accounts[k];
    if (a && a.refreshTokens && a.refreshTokens.indexOf(token) !== -1) return a;
  }
  return null;
}

// Middleware: check either static MOCK_API_TOKEN or Bearer JWT
function authCheck(req){
  const required = process.env.MOCK_API_TOKEN || null;
  if (required){
    const auth = (req.headers['authorization'] || '').toString();
    const want = 'Bearer ' + required;
    if (auth === want) return { ok: true };
  }
  // try Bearer JWT
  const auth = (req.headers['authorization'] || '').toString();
  if (auth && auth.indexOf('Bearer ') === 0){
    const token = auth.slice(7).trim();
    const payload = verifyAccessToken(token);
    if (payload && payload.username) return { ok: true, username: payload.username };
  }
  return { ok: false };
}

app.post('/create-account', (req, res) => {
  const body = req.body || {};
  const username = (body.username || '').toString().trim();
  if (!username) return res.status(400).json({ error: 'invalid_username' });
  // If MOCK_AUTH=1 then require Authorization
  if (process.env.MOCK_AUTH === '1'){
    const a = authCheck(req);
    if (!a.ok) return res.status(401).json({ error: 'unauthorized' });
  }
  if (!accounts[username]) {
    accounts[username] = { username, createdAt: Date.now(), wallet: 0 };
  }
  // accept optional avatar and displayName in body
  if (body.displayName) accounts[username].displayName = body.displayName;
  let avatarUrl = null;
  if (body.avatar && typeof body.avatar === 'string' && /^data:/.test(body.avatar)){
    // parse data URL and write file, with server-side validation
    try{
      // allow only common image mime types
      const m = body.avatar.match(/^data:(image\/(png|jpeg|jpg|webp));base64,(.+)$/);
      if (m){
        const mime = m[1];
        const subtype = m[2];
        const b64 = m[3];
        const buffer = Buffer.from(b64, 'base64');
        const sizeBytes = buffer.length;
        // enforce maximum size ~800KB
        const MAX_BYTES = 800 * 1024;
        if (sizeBytes > MAX_BYTES) {
          console.warn('Rejected avatar: too large', sizeBytes);
          return res.status(400).json({ error: 'avatar_too_large', maxBytes: MAX_BYTES });
        }
        // accepted image types only
        const ext = (subtype === 'jpeg' || subtype === 'jpg') ? 'jpg' : (subtype === 'png' ? 'png' : (subtype === 'webp' ? 'webp' : 'bin'));
        const filename = `${username.replace(/[^a-z0-9_-]/gi,'')}_${Date.now()}.${ext}`;
        const filePath = path.join(UPLOAD_DIR, filename);
        fs.writeFileSync(filePath, buffer);
        avatarUrl = `${req.protocol}://${req.get('host')}/uploads/${filename}`;
        accounts[username].avatarUrl = avatarUrl;
      } else {
        // unsupported data URL format
        console.warn('Rejected avatar: unsupported data URL');
        return res.status(400).json({ error: 'unsupported_avatar_format' });
      }
    }catch(err){ console.warn('Failed to save avatar', err); return res.status(500).json({ error: 'avatar_save_failed' }); }
  }

  if (body.avatar && !accounts[username].avatar && !accounts[username].avatarUrl) accounts[username].avatar = body.avatar;

  // simulate a short delay and return created account
  setTimeout(()=> res.json({ ok: true, username: accounts[username].username, createdAt: accounts[username].createdAt, avatarUrl: avatarUrl || null }), 300 + Math.floor(Math.random()*400));
});

// Authentication endpoints
app.post('/auth/register', authLimiter, (req, res) => {
  const body = req.body || {};
  const username = (body.username || '').toString().trim();
  const password = (body.password || '').toString();
  const displayName = (body.displayName || '') || username;
  if (!username || !password) return res.status(400).json({ error: 'invalid_input' });
  if (accounts[username] && accounts[username].passwordHash) return res.status(409).json({ error: 'user_exists' });
  // password strength enforcement
  if (password.length < 8) return res.status(400).json({ error: 'weak_password' });
  try{
    const hash = bcrypt.hashSync(password, 10);
    accounts[username] = accounts[username] || { username, createdAt: Date.now(), wallet: 0 };
    accounts[username].passwordHash = hash;
    accounts[username].displayName = displayName;
    accounts[username].refreshTokens = accounts[username].refreshTokens || [];
    // accept avatar optionally
    if (body.avatar && typeof body.avatar === 'string' && /^data:/.test(body.avatar)){
      const m = body.avatar.match(/^data:(image\/(png|jpeg|jpg|webp));base64,(.+)$/);
      if (m){
        const b64 = m[3]; const buffer = Buffer.from(b64,'base64');
        const MAX_BYTES = 800 * 1024;
        if (buffer.length <= MAX_BYTES){
          const ext = (m[2] === 'jpeg' || m[2] === 'jpg') ? 'jpg' : (m[2] === 'png' ? 'png' : 'webp');
          const filename = `${username.replace(/[^a-z0-9_-]/gi,'')}_${Date.now()}.${ext}`;
          fs.writeFileSync(path.join(UPLOAD_DIR, filename), buffer);
          accounts[username].avatarUrl = `${req.protocol}://${req.get('host')}/uploads/${filename}`;
        }
      }
    }
    // Optionally set a refresh cookie for immediate session if requested
    const issue = req.body && (req.body.issueSession || false);
    if (issue){
    const refreshToken = generateRefreshToken();
    accounts[username].refreshTokens = accounts[username].refreshTokens || [];
    accounts[username].refreshTokens.push(refreshToken);
    saveAccounts();
    const cookieSecure = process.env.MOCK_COOKIE_SECURE === '1';
    // Use SameSite=None to allow cross-site usage from PWAs; Secure flag controlled by env for local testing
    res.cookie('bt_refresh', refreshToken, { httpOnly: true, secure: cookieSecure, sameSite: 'none', maxAge: 30*24*60*60*1000 });
      const accessToken = generateAccessToken(username);
      return res.json({ ok: true, username, createdAt: accounts[username].createdAt, avatarUrl: accounts[username].avatarUrl || null, accessToken });
    }
    return res.json({ ok: true, username, createdAt: accounts[username].createdAt, avatarUrl: accounts[username].avatarUrl || null });
  }catch(err){ console.warn('register failed', err); return res.status(500).json({ error: 'server_error' }); }
});

// login with rate-limiting and optional 2FA challenge
app.post('/auth/login', authLimiter, (req, res) => {
  const body = req.body || {};
  const username = (body.username || '').toString().trim();
  const password = (body.password || '').toString();
  if (!username || !password) return res.status(400).json({ error: 'invalid_input' });
  const acct = accounts[username];
  if (!acct || !acct.passwordHash) return res.status(401).json({ error: 'invalid_credentials' });

  // account lockout check
  const LOCK_THRESHOLD = 5;
  const LOCK_WINDOW_MS = 15 * 60 * 1000;
  if (acct.failedAttempts && acct.failedAttempts >= LOCK_THRESHOLD){
    const last = acct.lastFailedAt || 0;
    if (Date.now() - last < LOCK_WINDOW_MS) return res.status(429).json({ error: 'account_locked' });
    // reset if lock window passed
    acct.failedAttempts = 0;
  }

  const ok = bcrypt.compareSync(password, acct.passwordHash);
  if (!ok){
    acct.failedAttempts = (acct.failedAttempts || 0) + 1;
    acct.lastFailedAt = Date.now();
    saveAccounts();
    return res.status(401).json({ error: 'invalid_credentials' });
  }
  // successful password: reset failure counters
  acct.failedAttempts = 0; acct.lastFailedAt = 0;
  saveAccounts();

  // if 2FA is enabled, issue a short-lived MFA temp token and require second factor
  if (acct.twoFA && acct.twoFA.enabled){
    const temp = crypto.randomBytes(20).toString('hex');
    acct.mfaTemp = { token: temp, expiresAt: Date.now() + (5 * 60 * 1000) };
    saveAccounts();
    return res.json({ mfaRequired: true, tempToken: temp });
  }

  // issue tokens: access token in body, refresh token in httpOnly cookie
  const accessToken = generateAccessToken(username);
  const refreshToken = generateRefreshToken();
  acct.refreshTokens = acct.refreshTokens || [];
  acct.refreshTokens.push(refreshToken);
  const cookieSecure = process.env.MOCK_COOKIE_SECURE === '1';
  saveAccounts();
  res.cookie('bt_refresh', refreshToken, { httpOnly: true, secure: cookieSecure, sameSite: 'none', maxAge: 30*24*60*60*1000 });

  // optionally issue id_token when requested via scope or flag
  let idToken = null;
  const scope = (body.scope || '').toString();
  if (scope && scope.indexOf('openid') !== -1) {
    const payload = { sub: username, name: acct.displayName || username };
    const issuer = `http://localhost:${process.env.PORT||3333}`;
    if (RSA_PRIVATE_KEY) {
      idToken = jwt.sign(payload, RSA_PRIVATE_KEY, { algorithm: 'RS256', keyid: (RSA_PUBLIC_JWK && RSA_PUBLIC_JWK.kid) || 'mock-rs-kid', expiresIn: '15m', issuer });
    } else {
      idToken = jwt.sign(payload, JWT_SECRET, { expiresIn: '15m', issuer });
    }
  }

  return res.json({ accessToken, displayName: acct.displayName || username, avatarUrl: acct.avatarUrl || null, idToken });
});

// Refresh uses httpOnly cookie bt_refresh. Returns new access token and rotates cookie.
app.post('/auth/refresh', (req, res) => {
  const cookieToken = (req.cookies && req.cookies.bt_refresh) ? req.cookies.bt_refresh.toString() : '';
  if (!cookieToken) return res.status(400).json({ error: 'invalid_input' });
  const acct = findUserByRefresh(cookieToken);
  if (!acct) return res.status(401).json({ error: 'invalid_refresh' });
  // rotate refresh token
  acct.refreshTokens = acct.refreshTokens.filter(t => t !== cookieToken);
  const newRefresh = generateRefreshToken();
  acct.refreshTokens.push(newRefresh);
  const accessToken = generateAccessToken(acct.username);
  const cookieSecure = process.env.MOCK_COOKIE_SECURE === '1';
  saveAccounts();
  res.cookie('bt_refresh', newRefresh, { httpOnly: true, secure: cookieSecure, sameSite: 'none', maxAge: 30*24*60*60*1000 });
  return res.json({ accessToken });
});

// Setup 2FA (TOTP) - requires valid access token
app.post('/auth/setup-2fa', (req, res) => {
  const a = authCheck(req);
  if (!a.ok) return res.status(401).json({ error: 'unauthorized' });
  const username = a.username;
  const secret = speakeasy.generateSecret({ length: 20, name: `FastBank (${username})` });
  accounts[username].twoFA = accounts[username].twoFA || {};
  accounts[username].twoFA.tempSecret = secret.base32;
  return res.json({ otpauth_url: secret.otpauth_url, base32: secret.base32 });
});

// Enable 2FA - verify the TOTP once and persist secret
app.post('/auth/enable-2fa', (req, res) => {
  const a = authCheck(req);
  if (!a.ok) return res.status(401).json({ error: 'unauthorized' });
  const username = a.username;
  const body = req.body || {};
  const token = (body.token || '').toString().trim();
  const acct = accounts[username];
  if (!acct || !acct.twoFA || !acct.twoFA.tempSecret) return res.status(400).json({ error: 'no_temp_secret' });
  const ok = speakeasy.totp.verify({ secret: acct.twoFA.tempSecret, encoding: 'base32', token, window: 1 });
  if (!ok) return res.status(400).json({ error: 'invalid_token' });
  acct.twoFA.secret = acct.twoFA.tempSecret;
  acct.twoFA.enabled = true;
  delete acct.twoFA.tempSecret;
  saveAccounts();
  return res.json({ ok: true });
});

// Verify 2FA challenge produced during login: exchange tempToken + code for session tokens
app.post('/auth/verify-2fa', authLimiter, (req, res) => {
  const body = req.body || {};
  const temp = (body.tempToken || '').toString().trim();
  const token = (body.token || '').toString().trim();
  if (!temp || !token) return res.status(400).json({ error: 'invalid_input' });
  // find account with matching temp
  const acct = Object.values(accounts).find(a => a.mfaTemp && a.mfaTemp.token === temp && a.mfaTemp.expiresAt > Date.now());
  if (!acct) return res.status(400).json({ error: 'invalid_temp' });
  if (!acct.twoFA || !acct.twoFA.secret) return res.status(400).json({ error: 'no_2fa' });
  const ok = speakeasy.totp.verify({ secret: acct.twoFA.secret, encoding: 'base32', token, window: 1 });
  if (!ok) return res.status(400).json({ error: 'invalid_token' });
  // success: issue access token and set refresh cookie
  const accessToken = generateAccessToken(acct.username);
  const refreshToken = generateRefreshToken();
  acct.refreshTokens = acct.refreshTokens || [];
  acct.refreshTokens.push(refreshToken);
  const cookieSecure = process.env.MOCK_COOKIE_SECURE === '1';
  // remove temp MFA challenge before persisting
  delete acct.mfaTemp;
  saveAccounts();
  res.cookie('bt_refresh', refreshToken, { httpOnly: true, secure: cookieSecure, sameSite: 'none', maxAge: 30*24*60*60*1000 });
  return res.json({ accessToken, displayName: acct.displayName || acct.username, avatarUrl: acct.avatarUrl || null });
});

// OIDC discovery and JWKS for mock id_token validation
app.get('/.well-known/openid-configuration', (req, res) => {
  const port = process.env.PORT || 3333;
  const issuer = `http://localhost:${port}`;
  return res.json({ issuer, jwks_uri: issuer + '/.well-known/jwks.json', authorization_endpoint: issuer + '/auth/authorize', token_endpoint: issuer + '/auth/token', userinfo_endpoint: issuer + '/auth/userinfo' });
});

function base64url(buf){ return Buffer.from(buf).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,''); }

app.get('/.well-known/jwks.json', (req, res) => {
  // Prefer RSA public JWK if available
  if (RSA_PUBLIC_JWK) {
    const jwk = Object.assign({}, RSA_PUBLIC_JWK);
    jwk.alg = 'RS256'; jwk.use = 'sig'; jwk.kid = jwk.kid || 'mock-rs-kid';
    return res.json({ keys: [jwk] });
  }
  // fallback: return a symmetric jwk using the shared JWT_SECRET (mock-only)
  const k = base64url(JWT_SECRET);
  return res.json({ keys: [{ kty: 'oct', k, alg: 'HS256', use: 'sig', kid: 'mock-key-1' }] });
});

app.get('/auth/userinfo', (req, res) => {
  const a = authCheck(req);
  if (!a.ok) return res.status(401).json({ error: 'unauthorized' });
  const uname = a.username;
  const acct = accounts[uname] || {};
  return res.json({ sub: uname, name: acct.displayName || uname, preferred_username: uname, picture: acct.avatarUrl || null });
});

app.post('/auth/logout', (req, res) => {
  const cookieToken = (req.cookies && req.cookies.bt_refresh) ? req.cookies.bt_refresh.toString() : '';
  if (cookieToken){
    const acct = findUserByRefresh(cookieToken);
    if (acct) acct.refreshTokens = acct.refreshTokens.filter(t => t !== cookieToken);
  }
  // clear cookie
  saveAccounts();
  const cookieSecure = process.env.MOCK_COOKIE_SECURE === '1';
  res.clearCookie('bt_refresh', { sameSite: 'none', httpOnly: true, secure: cookieSecure });
  return res.json({ ok: true });
});

// expose account lookup for tests
app.get('/account/:username', (req, res) => {
  const u = (req.params.username||'').toString();
  if (!u || !accounts[u]) return res.status(404).json({ error: 'not_found' });
  // return basic account info including avatar if present
  return res.json({ username: accounts[u].username, createdAt: accounts[u].createdAt, displayName: accounts[u].displayName || null, avatar: accounts[u].avatar || null });
});

// simple account resolve endpoint for local testing
app.post('/resolve-account', (req, res) => {
  const body = req.body || {};
  const acct = (String(body.accountNumber || '')).replace(/\D/g,'');
  const bank = (body.bank || '').toString();
  // optional token enforcement
  const required = process.env.MOCK_API_TOKEN || null;
  if (required) {
    const auth = (req.headers['authorization'] || '').toString();
    const want = 'Bearer ' + required;
    if (auth !== want) return res.status(401).json({ error: 'unauthorized' });
  }
  if (!acct || acct.length < 6) return res.status(400).json({ error: 'invalid_account' });

  // deterministic mapping similar to client-side simulator
  let name = null;
  if (/^10/.test(acct)) name = 'Aisha Bello';
  else if (/^20/.test(acct)) name = 'John Okafor';
  else if (/^30/.test(acct)) name = 'Mary Smith';
  else if (/^40/.test(acct)) name = 'Chinedu Emeka';
  else name = 'Srv ' + acct.slice(-4);

  // simulate a small delay and occasionally fail
  const delay = 200 + Math.floor(Math.random()*600);
  setTimeout(()=>{
    if (Math.random() < 0.06) return res.status(500).json({ error: 'server_error' });
    return res.json({ name });
  }, delay);
});

const port = process.env.PORT || 3333;
app.listen(port, ()=> {
  const url = `http://localhost:${port}/dashboard.html`;
  console.log('Mock server listening on port', port, '; auth=' + (process.env.MOCK_AUTH === '1' ? 'ENABLED' : 'off'));
  // auto-open browser unless OPEN_BROWSER is set to `0`
  if (process.env.OPEN_BROWSER !== '0'){
    const plat = process.platform;
    let cmd = null;
    if (plat === 'darwin') cmd = `open "${url}"`;
    else if (plat === 'win32') cmd = `start "" "${url}"`;
    else cmd = `xdg-open "${url}"`;
    if (cmd) {
      exec(cmd, (err)=>{ if (err) console.warn('Failed to open browser automatically', err); });
    }
  }
});
