#!/usr/bin/env node
/**
 * Start the mock server (node mock-server/server.js), wait for readiness, run Playwright tests,
 * then stop the server. Cross-platform and suitable for CI.
 *
 * Usage: node scripts/run-mock-and-test.js
 */
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');

const MOCK_PORT = process.env.MOCK_PORT || 3333;
const MOCK_URL = `http://localhost:${MOCK_PORT}`;
const SERVER_SCRIPT = path.join(__dirname, '..', 'mock-server', 'server.js');

function waitForReady(url, timeout = 10000, interval = 200) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    (function poll(){
      const req = http.get(url, (res)=>{
        res.resume();
        resolve();
      });
      req.on('error', ()=>{
        if (Date.now() - start > timeout) return reject(new Error('Timeout waiting for server')); 
        setTimeout(poll, interval);
      });
    })();
  });
}

function run() {
  console.log('Starting mock server:', SERVER_SCRIPT);
  const server = spawn(process.execPath, [SERVER_SCRIPT], {
    env: Object.assign({}, process.env, { PORT: String(MOCK_PORT) }),
    stdio: ['ignore', 'inherit', 'inherit']
  });

  server.on('error', (err)=>{ console.error('Failed to start mock server', err); process.exit(1); });

  waitForReady(`${MOCK_URL}/`).then(async ()=>{
    console.log('Mock server ready at', MOCK_URL);
    // run playwright tests with BASE_URL pointing to mock server
    const runner = spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['playwright', 'test'], {
      env: Object.assign({}, process.env, { BASE_URL: MOCK_URL }),
      stdio: 'inherit'
    });

    runner.on('exit', (code)=>{
      console.log('Playwright exited with', code, '— shutting down mock server');
      try{
        server.kill();
      }catch(e){}
      process.exit(code === null ? 1 : code);
    });

    runner.on('error', (err)=>{
      console.error('Failed to run Playwright:', err);
      try{ server.kill(); }catch(e){}
      process.exit(1);
    });
  }).catch((err)=>{
    console.error('Mock server did not become ready:', err);
    try{ server.kill(); }catch(e){}
    process.exit(1);
  });

  // ensure child is killed when parent exits
  process.on('exit', ()=>{ try{ server.kill(); }catch(e){} });
  process.on('SIGINT', ()=>{ try{ server.kill(); }catch(e){} process.exit(1); });
  process.on('SIGTERM', ()=>{ try{ server.kill(); }catch(e){} process.exit(1); });
}

run();
