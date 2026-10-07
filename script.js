/*
    Application script: small improvements for reliability and performance.
    - Guards DOM operations so pages that don't include certain elements won't throw.
    - Provides same function names used in HTML for compatibility.
    - Uses DOMContentLoaded and event delegation where appropriate.
*/

(function () {
    'use strict';

    // Lightweight localStorage tamper-detection wrapper
    // Wraps Storage.prototype.setItem/getItem so stored values include a simple checksum.
    // Not cryptographically secure — helpful to detect accidental or manual tampering.
    (function hardenLocalStorage(){
        try{
            const originalSet = Storage.prototype.setItem;
            const originalGet = Storage.prototype.getItem;
            const originalRemove = Storage.prototype.removeItem;
            // simple checksum: 32-bit sum of char codes, hex
            function computeChecksum(str){
                if (!str) return '0';
                let sum = 0;
                for (let i=0;i<str.length;i++) sum = (sum + str.charCodeAt(i)) >>> 0;
                return sum.toString(16);
            }

            Storage.prototype.setItem = function(key, value){
                try{
                    // ensure value is a string
                    const s = (typeof value === 'string') ? value : String(value);
                    const payload = JSON.stringify({ __bt_wrapped: 1, v: s, c: computeChecksum(s) });
                    return originalSet.call(this, key, payload);
                }catch(e){ return originalSet.call(this, key, value); }
            };

            Storage.prototype.getItem = function(key){
                try{
                    const raw = originalGet.call(this, key);
                    if (!raw) return raw;
                    // try parse — if it's our wrapped object, verify checksum and return inner value string
                    try{
                        const obj = JSON.parse(raw);
                        if (obj && obj.__bt_wrapped){
                            const v = obj.v || '';
                            const c = obj.c || '';
                            if (computeChecksum(v) === c){
                                return v;
                            } else {
                                // tamper detected
                                window.localStorageTampered = true;
                                try{ if (window.showToast) window.showToast('LocalStorage tamper detected for ' + key, 'danger'); }catch(e){}
                                return null;
                            }
                        }
                    }catch(e){ /* not JSON / not wrapped */ }
                    return raw;
                }catch(e){ return originalGet.call(this, key); }
            };

            Storage.prototype.removeItem = function(key){ try{ return originalRemove.call(this,key); }catch(e){ return originalRemove.call(this,key); } };
            // expose helpers
            window.localStorageHardened = true;
        }catch(e){ console.warn('Failed to harden localStorage', e); }
    })();

    // safe query helpers
    function $(id) { return document.getElementById(id); }
    function text(id, value) { const el = $(id); if (!el) return; el.innerText = value; }

    // Resize image (File or dataURL) to limit dimensions and reduce size. Returns dataURL (JPEG or original mime if small)
    async function resizeImageDataURL(input, maxDim = 256, quality = 0.75){
        return new Promise((resolve)=>{
            try{
                const toImage = (src)=>{
                    const img = new Image();
                    img.onload = ()=>{
                        try{
                            const w = img.naturalWidth, h = img.naturalHeight;
                            if (!w || !h) return resolve(null);
                            let nw = w, nh = h;
                            if (Math.max(w,h) > maxDim){
                                if (w >= h){ nw = maxDim; nh = Math.round(h * (maxDim / w)); }
                                else { nh = maxDim; nw = Math.round(w * (maxDim / h)); }
                            }
                            const c = document.createElement('canvas'); c.width = nw; c.height = nh;
                            const ctx = c.getContext('2d');
                            // draw with smoothing
                            ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
                            ctx.clearRect(0,0,nw,nh);
                            ctx.drawImage(img, 0, 0, nw, nh);
                            // always produce JPEG to keep size small; quality param helps
                            const dataUrl = c.toDataURL('image/jpeg', quality);
                            resolve(dataUrl);
                        }catch(err){ console.warn('resizeImage error', err); resolve(null); }
                    };
                    img.onerror = ()=> resolve(null);
                    img.src = src;
                };

                if (!input) return resolve(null);
                // If input is a File
                if (typeof File !== 'undefined' && input instanceof File){
                    const fr = new FileReader();
                    fr.onload = ()=> toImage(fr.result);
                    fr.onerror = ()=> resolve(null);
                    fr.readAsDataURL(input);
                    return;
                }
                // If input is already a dataURL
                if (typeof input === 'string' && input.indexOf('data:') === 0){
                    toImage(input); return;
                }
                // Unknown type
                resolve(null);
            }catch(e){ console.warn('resizeImageDataURL failed', e); resolve(null); }
        });
    }

    // Loading animation (if present)
    document.addEventListener('DOMContentLoaded', () => {
        const loader = $('loader');
        const content = $('content');
        if (loader) {
            setTimeout(() => {
                loader.classList.add('fade-out');
                if (content) content.style.display = 'block';
                setTimeout(() => loader.remove(), 1200);
            }, 600);
        }

        // register service worker non-blocking
        if ('serviceWorker' in navigator) {
            navigator.serviceWorker.register('sw.js').catch(() => {});
        }
        // initialize theme toggle (adds a small button in .topbar)
        try { if (typeof initTheme === 'function') initTheme(); } catch (e) { /* ignore */ }
        // Add iOS safe-area helper class to body when running on iOS devices
        try {
            const ua = navigator.userAgent || navigator.vendor || window.opera || '';
            const iOS = /iP(ad|hone|od)/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
            if (iOS) document.body.classList.add('ios');
        } catch (e) { /* ignore */ }
        // API helper: attach access token, auto-refresh using refresh token when available
        async function apiFetch(path, opts){
            const ep = (localStorage.getItem('bt_api_endpoint') || window.BT_API_ENDPOINT || '').replace(/\/$/, '');
            if (!ep) throw new Error('No API endpoint configured');
            const headers = Object.assign({}, (opts && opts.headers) || {});
            const access = localStorage.getItem('bt_api_token') || window.BT_API_TOKEN || null;
            if (access) headers['Authorization'] = 'Bearer ' + access;
            const final = Object.assign({}, opts || {}, { headers });
            let res;
            try{ res = await fetch(ep + path, final); }
            catch(err){ throw err; }
            // if unauthorized, attempt refresh flow once by calling /auth/refresh (httpOnly cookie)
            if (res && res.status === 401){
                try{
                    const r = await fetch(ep + '/auth/refresh', { method: 'POST', credentials: 'include' });
                    if (r && r.ok){
                        const j = await r.json();
                        if (j && j.accessToken) localStorage.setItem('bt_api_token', j.accessToken);
                        headers['Authorization'] = 'Bearer ' + (j && j.accessToken ? j.accessToken : access);
                        const retry = Object.assign({}, final, { headers });
                        return await fetch(ep + path, retry);
                    }
                }catch(e){ /* refresh failed */ }
            }
            return res;
        }

        function isStrongPassword(p){
            if (!p || p.length < 8) return false;
            if (!/[a-z]/.test(p)) return false;
            if (!/[A-Z]/.test(p)) return false;
            if (!/[0-9]/.test(p)) return false;
            return true;
        }

        // Login helper used by login.html — will use API auth if an endpoint is configured
        window.login = async function(){
            try{
                const uEl = document.getElementById('li_username');
                const pEl = document.getElementById('li_password');
                const username = (uEl && uEl.value || '').trim();
                const pass = (pEl && pEl.value || '').trim();
                if (!username) { window.showToast && window.showToast('Enter username','info'); uEl && uEl.focus(); return; }
                const loader = document.getElementById('loginLoader'); const msg = document.getElementById('loginLoaderMsg');
                if (loader) loader.style.display = 'flex'; if (msg) msg.innerText = 'Logging in to Fast & Reliable Bank…';

                const ep = (localStorage.getItem('bt_api_endpoint') || window.BT_API_ENDPOINT || null);
                if (ep){
                    try{
                        const res = await fetch((ep||'').replace(/\/$/, '') + '/auth/login', {
                            method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ username: username, password: pass }), credentials: 'include'
                        });
                        if (res && res.ok){
                            const j = await res.json();
                            if (j && j.accessToken) localStorage.setItem('bt_api_token', j.accessToken);
                            // ensure profile stored locally for UI
                            const profiles = JSON.parse(localStorage.getItem('bt_profiles')||'{}');
                            profiles[username] = profiles[username] || { displayName: j.displayName || username, wallet: Number((profiles[username] && profiles[username].wallet) || 0) };
                            if (j.avatarUrl) profiles[username].avatar = j.avatarUrl;
                            localStorage.setItem('bt_profiles', JSON.stringify(profiles));
                            localStorage.setItem('loggedInUser', username);
                            if (msg) msg.innerText = 'Welcome to Fast & Reliable Bank — loading your dashboard…';
                            window.showToast && window.showToast('Signed in — redirecting to dashboard', 'success');
                            await new Promise(r => setTimeout(r, 700));
                            if (loader) loader.style.display = 'none';
                            try{ window.location.href = 'dashboard.html'; }catch(e){}
                            return;
                        } else {
                            // attempt to parse server JSON to detect MFA challenge
                            let j2 = null;
                            try{ j2 = await res.json(); }catch(e){ j2 = null; }
                            if (j2 && j2.mfaRequired && j2.tempToken){
                                const code = await window.openInputModal({ title: 'Two-factor authentication', label: 'Enter your 2FA code' });
                                if (!code) { window.showToast && window.showToast('2FA code required','warning'); if (loader) loader.style.display = 'none'; return; }
                                const v = await fetch((ep||'').replace(/\/$/, '') + '/auth/verify-2fa', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ tempToken: j2.tempToken, token: code }), credentials: 'include' });
                                if (v && v.ok){
                                    const cred = await v.json();
                                    if (cred && cred.accessToken) localStorage.setItem('bt_api_token', cred.accessToken);
                                    const profiles = JSON.parse(localStorage.getItem('bt_profiles')||'{}');
                                    profiles[username] = profiles[username] || { displayName: cred.displayName || username, wallet: 0 };
                                    if (cred.avatarUrl) profiles[username].avatar = cred.avatarUrl;
                                    localStorage.setItem('bt_profiles', JSON.stringify(profiles));
                                    localStorage.setItem('loggedInUser', username);
                                    window.showToast && window.showToast('Signed in (2FA) — redirecting to dashboard', 'success');
                                    await new Promise(r => setTimeout(r, 700));
                                    if (loader) loader.style.display = 'none';
                                    try{ window.location.href = 'dashboard.html'; }catch(e){}
                                    return;
                                } else {
                                    window.showToast && window.showToast('2FA verify failed','danger');
                                    if (loader) loader.style.display = 'none';
                                    return;
                                }
                            }
                            // fallback to text/log
                            const text = await res.text().catch(()=> '');
                            console.warn('Server login failed', res && res.status, text);
                        }
                    }catch(err){ console.warn('Server login error', err && err.message ? err.message : err); }
                }

                // Local fallback (demo mode)
                await new Promise(r => setTimeout(r, 300 + Math.floor(Math.random()*500)));
                const profiles = JSON.parse(localStorage.getItem('bt_profiles')||'{}');
                profiles[username] = profiles[username] || { displayName: username, wallet: Number((profiles[username] && profiles[username].wallet) || 0) };
                localStorage.setItem('bt_profiles', JSON.stringify(profiles));
                localStorage.setItem('loggedInUser', username);
                if (msg) msg.innerText = 'Welcome to Fast & Reliable Bank — loading your dashboard…';
                window.showToast && window.showToast('Signed in — redirecting to dashboard', 'success');
                await new Promise(r => setTimeout(r, 700));
                if (loader) loader.style.display = 'none';
                try{ window.location.href = 'dashboard.html'; }catch(e){}
            }catch(e){ console.error('login failed', e); window.showToast && window.showToast('Login failed','danger'); const loader = document.getElementById('loginLoader'); if (loader) loader.style.display='none'; }
        };
        });

        // Signup helper used by signup.html
        document.addEventListener('DOMContentLoaded', () => {
            window.signup = async function(){
                try{
                    const uEl = document.getElementById('su_username');
                    const pEl = document.getElementById('su_password');
                    const dEl = document.getElementById('su_displayName');
                    const avatarEl = document.getElementById('su_avatar');
                    const username = (uEl && uEl.value || '').trim();
                    const pass = (pEl && pEl.value || '').trim();
                    const displayName = (dEl && dEl.value || '').trim() || username;
                    if (!username) { window.showToast && window.showToast('Enter username','info'); uEl && uEl.focus(); return; }
                    if (!isStrongPassword(pass)) { window.showToast && window.showToast('Password must be at least 8 chars and include upper, lower and digits','warning'); pEl && pEl.focus(); return; }
                    const loader = document.getElementById('signupLoader'); const msg = document.getElementById('signupLoaderMsg');
                    if (loader) loader.style.display = 'flex'; if (msg) msg.innerText = 'Creating your Fast & Reliable Bank account…';
                    // read avatar file if provided (convert to data URL)
                    let avatarData = null;
                    try{
                        if (avatarEl && avatarEl.files && avatarEl.files[0]){
                            const file = avatarEl.files[0];
                            // resize & compress to keep storage small
                            avatarData = await resizeImageDataURL(file, 256, 0.75);
                        }
                    }catch(e){ console.warn('Failed to read/resize avatar file', e); avatarData = null; }

                    const ep = (localStorage.getItem('bt_api_endpoint') || window.BT_API_ENDPOINT || null);
                    let serverOk = false;
                    const profiles = JSON.parse(localStorage.getItem('bt_profiles')||'{}');
                    if (ep){
                        try{
                            const res = await fetch((ep||'').replace(/\/$/, '') + '/auth/register', {
                                method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ username: username, password: pass, displayName: displayName, avatar: avatarData, issueSession: true }), credentials: 'include'
                            });
                            const txt = await res.text().catch(()=> '');
                            let j = null;
                            try{ j = txt ? JSON.parse(txt) : null; }catch(e){}
                            if (res && res.ok){
                                serverOk = true;
                                window.showToast && window.showToast('Account created (server)', 'success');
                                // auto-login: call /auth/login to obtain tokens
                                try{
                                    const r = await fetch((ep||'').replace(/\/$/, '') + '/auth/login', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ username: username, password: pass }), credentials: 'include' });
                                    if (r && r.ok){ const cred = await r.json(); if (cred && cred.accessToken) localStorage.setItem('bt_api_token', cred.accessToken); if (cred && cred.avatarUrl) profiles[username] = profiles[username] || { displayName: displayName, wallet: 0, avatar: cred.avatarUrl }; }
                                }catch(e){ /* ignore */ }
                                if (j && j.avatarUrl) profiles[username] = profiles[username] || { displayName: displayName, wallet: 0, avatar: j.avatarUrl };
                            } else {
                                // server rejected creation — provide feedback if available
                                const body = j || { message: txt };
                                console.warn('Signup server rejected', body);
                                if (body && body.error) window.showToast && window.showToast('Server: ' + body.error, 'danger');
                            }
                        }catch(err){ console.warn('Signup: server create-account failed, falling back to local', err && err.message ? err.message : err); }
                    }

                    if (!serverOk){
                        if (!profiles[username]){
                            profiles[username] = { displayName: displayName, wallet: 0, createdAt: (new Date()).toISOString() };
                            if (avatarData) profiles[username].avatar = avatarData;
                            localStorage.setItem('bt_profiles', JSON.stringify(profiles));
                            window.showToast && window.showToast('Account created', 'success');
                        } else {
                            // update displayName/avatar if provided
                            profiles[username].displayName = profiles[username].displayName || displayName;
                            if (avatarData) profiles[username].avatar = avatarData;
                            localStorage.setItem('bt_profiles', JSON.stringify(profiles));
                            window.showToast && window.showToast('Account exists, signing in', 'info');
                        }
                    }

                    localStorage.setItem('loggedInUser', username);
                    if (msg) msg.innerText = 'Welcome to Fast & Reliable Bank — loading your dashboard…';
                    await new Promise(r => setTimeout(r, 600));
                    if (loader) loader.style.display = 'none';
                    try{ window.location.href = 'dashboard.html'; }catch(e){ }
                }catch(e){ console.error('signup failed', e); window.showToast && window.showToast('Signup failed','danger'); const loader = document.getElementById('signupLoader'); if (loader) loader.style.display='none'; }
            };
        });

    /* Toast manager - accessible, queued and dismissible toasts with optional action.
       Public API: showToast(message, type='info', { duration=3500, action: { label, onClick } })
    */
    (function setupToast(){
        function ensureContainer(){
            let c = document.getElementById('globalToastContainer');
            if (!c){
                c = document.createElement('div');
                c.id = 'globalToastContainer';
                c.className = 'toast-container';
                c.setAttribute('aria-live','polite');
                c.setAttribute('aria-atomic','true');
                document.body.appendChild(c);
            }
            return c;
        }

        function makeToastEl(message, type, opts){
            const wrapper = document.createElement('div');
            wrapper.className = 'toast ' + (type || 'info');
            wrapper.tabIndex = 0;
            wrapper.setAttribute('role','status');
            const body = document.createElement('div'); body.className = 'toast-body'; body.innerText = message;
            wrapper.appendChild(body);
            if (opts && opts.action){
                const act = document.createElement('button');
                act.className = 'toast-action';
                act.type = 'button';
                act.innerText = opts.action.label || 'Action';
                act.addEventListener('click', (e)=>{ try{ opts.action.onClick && opts.action.onClick(e); }catch(err){} });
                wrapper.appendChild(act);
            }
            const close = document.createElement('button'); close.className = 'toast-close'; close.type='button'; close.setAttribute('aria-label','Dismiss'); close.innerText = '✕';
            close.addEventListener('click', ()=>{ wrapper.classList.remove('visible'); setTimeout(()=> wrapper.remove(),220); });
            wrapper.appendChild(close);
            // keyboard: Esc to dismiss, Enter triggers first action if present
            wrapper.addEventListener('keydown', (ev)=>{
                if (ev.key === 'Escape') { ev.preventDefault(); close.click(); }
                if (ev.key === 'Enter') { const btn = wrapper.querySelector('.toast-action'); if (btn){ btn.click(); } }
            });
            return wrapper;
        }

        window.showToast = function(message, type='info', opts){
            try{
                const container = ensureContainer();
                const el = makeToastEl(message, type, opts || {});
                container.appendChild(el);
                // small entrance
                requestAnimationFrame(()=> el.classList.add('visible'));
                const duration = (opts && opts.duration) ? opts.duration : 3500;
                if (duration > 0) setTimeout(()=>{ if (el.parentNode){ el.classList.remove('visible'); setTimeout(()=> el.remove(), 240); } }, duration);
                // ensure focus for keyboard dismiss
                el.focus();
                // also write into an announce node if present for screen readers
                const announceNode = document.getElementById('formLive') || document.getElementById('ariaAnnounce');
                if (announceNode) announceNode.textContent = message;
            }catch(e){ console.error('showToast failed', e); }
        };
        // small helper for legacy pages
        window.announce = function(msg){ const n = document.getElementById('formLive') || document.getElementById('ariaAnnounce'); if (n) n.textContent = msg; };
    })();

    /* Small modal helpers: openInputModal & openConfirmModal
       - openInputModal(opts) -> Promise<string|null>
         opts: { title, label, placeholder, type='text', defaultValue }
       - openConfirmModal({ title, body }) -> Promise<boolean>
    */
    (function modalHelpers(){
        function _ensureModalContainer(){
            let m = document.getElementById('globalModalContainer');
            if (!m){ m = document.createElement('div'); m.id = 'globalModalContainer'; document.body.appendChild(m); }
            return m;
        }

        window.openInputModal = function(opts){
            opts = opts || {};
            return new Promise((resolve)=>{
                _ensureModalContainer();
                // create overlay
                const overlay = document.createElement('div'); overlay.className = 'confirm-modal'; overlay.style.display='flex'; overlay.style.zIndex=12000;
                const card = document.createElement('div'); card.className='confirm-card';
                card.innerHTML = `
                    <header class="confirm-header"><strong>${escapeHtml(opts.title||'Input')}</strong><div><button class="modal-close">✖</button></div></header>
                    <div class="confirm-body">
                        <div style="display:flex;flex-direction:column;gap:8px">
                            ${opts.label ? `<label>${escapeHtml(opts.label)}</label>` : ''}
                            <input class="modal-input" type="${opts.type||'text'}" placeholder="${escapeHtml(opts.placeholder||'')}" value="${escapeHtml(opts.defaultValue||'')}" />
                            <div class="small-link" style="color:var(--danger);display:none"></div>
                        </div>
                    </div>
                    <div class="confirm-actions"><button class="btn-ghost modal-cancel">Cancel</button><button class="primary modal-ok">OK</button></div>
                `;
                overlay.appendChild(card);
                document.body.appendChild(overlay);
                const input = card.querySelector('.modal-input'); const ok = card.querySelector('.modal-ok'); const cancel = card.querySelector('.modal-cancel'); const close = card.querySelector('.modal-close'); const err = card.querySelector('.small-link');
                input.focus(); input.select();
                function cleanup(){ overlay.remove(); }
                ok.addEventListener('click', ()=>{ const v = input.value; cleanup(); resolve(v); });
                cancel.addEventListener('click', ()=>{ cleanup(); resolve(null); });
                close.addEventListener('click', ()=>{ cleanup(); resolve(null); });
                overlay.addEventListener('keydown', (e)=>{ if (e.key === 'Escape'){ e.preventDefault(); cleanup(); resolve(null); } if (e.key === 'Enter'){ e.preventDefault(); ok.click(); } });
            });
        };

        window.openConfirmModal = function(opts){
            opts = opts || {};
            return new Promise((resolve)=>{
                _ensureModalContainer();
                const overlay = document.createElement('div'); overlay.className = 'confirm-modal'; overlay.style.display='flex'; overlay.style.zIndex=12000;
                const card = document.createElement('div'); card.className='confirm-card';
                card.innerHTML = `
                    <header class="confirm-header"><strong>${escapeHtml(opts.title||'Confirm')}</strong><div><button class="modal-close">✖</button></div></header>
                    <div class="confirm-body"><div>${escapeHtml(opts.body||'Are you sure?')}</div></div>
                    <div class="confirm-actions"><button class="btn-ghost modal-no">No</button><button class="primary modal-yes">Yes</button></div>
                `;
                overlay.appendChild(card); document.body.appendChild(overlay);
                const yes = card.querySelector('.modal-yes'); const no = card.querySelector('.modal-no'); const close = card.querySelector('.modal-close');
                function cleanup(){ overlay.remove(); }
                yes.addEventListener('click', ()=>{ cleanup(); resolve(true); });
                no.addEventListener('click', ()=>{ cleanup(); resolve(false); });
                close.addEventListener('click', ()=>{ cleanup(); resolve(false); });
                overlay.addEventListener('keydown', (e)=>{ if (e.key === 'Escape'){ e.preventDefault(); cleanup(); resolve(false); } if (e.key === 'Enter'){ e.preventDefault(); yes.click(); } });
            });
        };
    })();

    /* Esusu UI helpers: join modal and demo scheduler */
    (function esusuUiHelpers(){
        function _createJoinModalIfNeeded(){
            if (document.getElementById('esusuJoinModal')) return;
            const modal = document.createElement('div'); modal.id = 'esusuJoinModal'; modal.className = 'confirm-modal'; modal.style.display = 'none';
            modal.innerHTML = `
                <div class="confirm-card">
                    <header class="confirm-header"><strong id="esusuJoinTitle">Join Group</strong><div><button id="esusuJoinClose">✖</button></div></header>
                    <div class="confirm-body">
                        <div style="display:flex;flex-direction:column;gap:8px">
                            <div id="esusuJoinDesc" style="color:var(--muted)"></div>
                            <label>Join as user id</label>
                            <input id="esusuJoinUser" placeholder="e.g., alice" />
                            <div id="esusuJoinError" style="color:var(--danger);display:none"></div>
                        </div>
                    </div>
                    <div class="confirm-actions"><button id="esusuJoinCancel" class="btn-ghost">Cancel</button><button id="esusuJoinConfirm" class="primary">Join</button></div>
                </div>
            `;
            document.body.appendChild(modal);
            modal.querySelector('#esusuJoinClose')?.addEventListener('click', ()=> modal.style.display = 'none');
            modal.querySelector('#esusuJoinCancel')?.addEventListener('click', ()=> modal.style.display = 'none');
        }

        // open join modal for groupId
        function openEsusuJoinModal(groupId){
            _createJoinModalIfNeeded();
            const modal = document.getElementById('esusuJoinModal');
            const title = modal.querySelector('#esusuJoinTitle');
            const desc = modal.querySelector('#esusuJoinDesc');
            const userInput = modal.querySelector('#esusuJoinUser');
            const err = modal.querySelector('#esusuJoinError');
            const confirmBtn = modal.querySelector('#esusuJoinConfirm');
            const g = window.esusu && window.esusu.getGroup ? window.esusu.getGroup(groupId) : null;
            title.innerText = g ? `Join ${g.name}` : 'Join Group';
            desc.innerText = g ? `Contribution: ₦${g.contributionAmount} • Starts: ${g.startDate} • Members: ${g.members.length}` : '';
            userInput.value = localStorage.getItem('loggedInUser') || '';
            err.style.display = 'none';
            modal.style.display = 'flex';
            confirmBtn.onclick = function(){
                const userId = (userInput.value || '').trim();
                if (!userId){ err.innerText = 'Enter user id to join'; err.style.display='block'; return; }
                try{
                    window.esusu.joinGroup(groupId, userId);
                    modal.style.display = 'none';
                    // use the centralized toast API
                    window.showToast && window.showToast('Joined group', 'success');
                    // update any list UIs if present
                    try{ if (window.renderGroups) window.renderGroups(); } catch(e){}
                    try{ if (window.populateDashboard) window.populateDashboard(); } catch(e){}
                }catch(e){ err.innerText = e && e.message ? e.message : String(e); err.style.display='block'; }
            };
        }

        // Demo scheduler: processes due payouts for today periodically while page is open
        let _esusuScheduler = { timer: null, interval: 60000, running: false };
        function startEsusuScheduler(intervalMs){
            if (!window.esusu || !window.esusu.processDuePayouts) return false;
            _esusuScheduler.interval = Number(intervalMs) || _esusuScheduler.interval;
            if (_esusuScheduler.timer) clearInterval(_esusuScheduler.timer);
            _esusuScheduler.timer = setInterval(()=>{
                try{ const res = window.esusu.processDuePayouts(); if (res && res.length) { /* optionally show notification */ } }catch(e){ console.error('Esusu scheduler error', e); }
            }, _esusuScheduler.interval);
            _esusuScheduler.running = true;
            localStorage.setItem('esusu_auto_process','1');
            return true;
        }
        function stopEsusuScheduler(){ if (_esusuScheduler.timer) clearInterval(_esusuScheduler.timer); _esusuScheduler.timer = null; _esusuScheduler.running = false; localStorage.setItem('esusu_auto_process','0'); }

        // auto-start if enabled previously
        document.addEventListener('DOMContentLoaded', ()=>{
            // wire avatar preview on signup form (if present)
            try{
                const avatarEl = document.getElementById('su_avatar');
                const preview = document.getElementById('signupAvatarPreview');
                if (avatarEl && preview){
                const errorNode = document.getElementById('signupAvatarError');
                const btnSignup = document.getElementById('btnSignup');
                const ALLOWED = ['image/png','image/jpeg','image/webp'];
                const WARN_SIZE = 150 * 1024; // 150KB - show warning
                const HARD_LIMIT = 800 * 1024; // 800KB - reject
                avatarEl.addEventListener('change', (e)=>{
                    try{
                        const f = avatarEl.files && avatarEl.files[0];
                        if (!f) { preview.src = ''; if (errorNode) errorNode.textContent = ''; if (btnSignup) btnSignup.disabled = false; return; }
                        // validate type
                        if (ALLOWED.indexOf(f.type) === -1){
                            if (errorNode) errorNode.textContent = 'Unsupported image format. Use PNG, JPEG or WebP.';
                            preview.src = '';
                            avatarEl.value = '';
                            if (btnSignup) btnSignup.disabled = true;
                            return;
                        }
                        // size checks
                        if (f.size > HARD_LIMIT){
                            if (errorNode) errorNode.textContent = 'File too large. Please use an image under 800KB.';
                            preview.src = '';
                            avatarEl.value = '';
                            if (btnSignup) btnSignup.disabled = true;
                            return;
                        }
                        if (f.size > WARN_SIZE){
                            if (errorNode) errorNode.textContent = 'Large image — it will be resized to reduce storage.';
                        } else {
                            if (errorNode) errorNode.textContent = '';
                        }
                        const fr = new FileReader();
                        fr.onload = ()=>{ try{ preview.src = fr.result; if (btnSignup) btnSignup.disabled = false; }catch(e){} };
                        fr.onerror = ()=> { preview.src = ''; if (errorNode) errorNode.textContent = 'Failed to preview image'; };
                        fr.readAsDataURL(f);
                    }catch(err){ console.warn('avatar preview failed', err); if (errorNode) errorNode.textContent = 'Failed to read image file'; }
                });
            }
            }catch(e){}
            try{
                const enabled = localStorage.getItem('esusu_auto_process');
                if (enabled === '1') startEsusuScheduler(_esusuScheduler.interval);
            }catch(e){}
        });

        // expose helpers
        window.openEsusuJoinModal = openEsusuJoinModal;
        window.esusuScheduler = { start: startEsusuScheduler, stop: stopEsusuScheduler, status: ()=> _esusuScheduler };
    })();

    const trustedAgents = new Set(['john','mary','emeka','sarah']);

    // Networks, plans and billers (simple local lists for Nigeria)
    const NETWORKS = [
        { id: 'mtn', name: 'MTN', emoji: '🟡' },
        { id: 'glo', name: 'GLO', emoji: '🟢' },
        { id: 'airtel', name: 'AIRTEL', emoji: '🔵' },
        { id: '9mobile', name: '9MOBILE', emoji: '🟣' }
    ];

    const COMMON_DATA_PLANS = [
        { id: '500mb', label: '500MB - Daily', amount: 100 },
        { id: '1gb', label: '1GB - Weekly', amount: 300 },
        { id: '2gb', label: '2GB - Weekly', amount: 500 },
        { id: '5gb', label: '5GB - Monthly', amount: 2000 },
        { id: '10gb', label: '10GB - Monthly', amount: 3500 }
    ];

    // Operator specific plans (simplified examples)
    const DATA_PLANS_BY_NETWORK = {
        mtn: [
            { id: 'mtn_500mb', label: '500MB - Daily (MTN)', amount: 120 },
            { id: 'mtn_1gb', label: '1GB - Weekly (MTN)', amount: 350 },
            { id: 'mtn_5gb', label: '5GB - Monthly (MTN)', amount: 2100 }
        ],
        glo: [
            { id: 'glo_500mb', label: '500MB - Daily (GLO)', amount: 90 },
            { id: 'glo_1gb', label: '1GB - Weekly (GLO)', amount: 280 },
            { id: 'glo_3gb', label: '3GB - Monthly (GLO)', amount: 1500 }
        ],
        airtel: [
            { id: 'airtel_500mb', label: '500MB - Daily (Airtel)', amount: 110 },
            { id: 'airtel_2gb', label: '2GB - Weekly (Airtel)', amount: 520 },
            { id: 'airtel_10gb', label: '10GB - Monthly (Airtel)', amount: 3400 }
        ],
        '9mobile': [
            { id: '9_500mb', label: '500MB - Daily (9mobile)', amount: 100 },
            { id: '9_1gb', label: '1GB - Weekly (9mobile)', amount: 300 },
            { id: '9_5gb', label: '5GB - Monthly (9mobile)', amount: 2200 }
        ]
    };

    const BILLERS = [
        { id: 'eko-electric', name: 'Eko Electricity', type: 'electricity', desc: 'Prepaid & Postpaid' },
        { id: 'ikeja-electric', name: 'Ikeja Electric', type: 'electricity', desc: 'Prepaid & Postpaid' },
        { id: 'phcn', name: 'PHCN (Generic)', type: 'electricity', desc: 'National' },
        { id: 'dstv', name: 'DSTV', type: 'cable', desc: 'Satellite TV' },
        { id: 'gotv', name: 'GOtv', type: 'cable', desc: 'Digital Terrestrial' },
        { id: 'startimes', name: 'Startimes', type: 'cable', desc: 'Satellite TV' },
        { id: 'nwsca', name: 'Water (Generic)', type: 'water', desc: 'Water bills' },
        { id: 'spectranet', name: 'Spectranet', type: 'internet', desc: 'Broadband' },
        { id: 'school', name: 'School Fees', type: 'tuition', desc: 'Institution payments' }
    ];

    // common phone prefixes per operator (Nigeria) for basic validation
    const OP_PREFIXES = {
        mtn: ['0803','0806','0703','0706','0813','0816','0810','0814','0903','0906','07025','07026'],
        glo: ['0805','0807','0815','0811','0705','0905'],
        airtel: ['0802','0808','0708','0812','0701','0902','0907','0912'],
        '9mobile': ['0809','0817','0818','0909','0908','0917','0918']
    };

    function _normalizePhone(phone){
        if(!phone) return '';
        let p = phone.replace(/[^0-9+]/g,'');
        // convert +234... to 0....
        if (p.startsWith('+234')) p = '0' + p.slice(4);
        if (p.startsWith('234') && p.length>10) p = '0' + p.slice(3);
        return p;
    }

    function validatePhoneForNetwork(networkId, phone){
        const p = _normalizePhone(phone);
        if (!p) return { valid:false, msg: 'Enter phone number' };
        if (p.length !== 11) return { valid:false, msg: 'Phone should be 11 digits (e.g., 0803xxxxxxx)' };
        const prefixes = OP_PREFIXES[networkId] || [];
        const pref4 = p.slice(0,4);
        const matches = prefixes.includes(pref4);
        return { valid: matches, msg: matches ? '' : `Phone prefix ${pref4} may not belong to ${networkId.toUpperCase()}` };
    }

    // Populate network tiles into a container
    function populateNetworks(containerId){
        const container = document.getElementById(containerId);
        if (!container) return;
        container.innerHTML = '';
        NETWORKS.forEach(n => {
            const el = document.createElement('div');
            el.className = 'network-tile';
            el.setAttribute('data-network', n.id);
            // use provided SVG if available under images/networks/{id}.svg
            el.innerHTML = `<div class="network-icon"><img src="images/networks/${n.id}.svg" alt="${n.name}" onerror="this.style.display='block';this.parentNode.innerText='${n.emoji}'"></div><div class="network-label">${n.name}</div>`;
            el.addEventListener('click', ()=>{
                // clear other selections
                const others = container.querySelectorAll('.network-tile');
                others.forEach(o => o.classList.remove('selected'));
                el.classList.add('selected');
                window._selectedNetwork = n;
                // if there's a data plans container on the page, refresh plans for this network
                try { if (document.getElementById('data_plans')) populateDataPlans('data_plans', n.id); } catch(e){}
                // live-validate phone inputs if present
                try { if (document.getElementById('air_phone')) updatePhoneWarning('air_phone','air_phone_warn', n.id); } catch(e){}
                try { if (document.getElementById('data_phone')) updatePhoneWarning('data_phone','data_phone_warn', n.id); } catch(e){}
            });
            container.appendChild(el);
        });
        // auto-select first
        const first = container.querySelector('.network-tile'); if (first) { first.classList.add('selected'); window._selectedNetwork = NETWORKS[0]; try { if (document.getElementById('data_plans')) populateDataPlans('data_plans', NETWORKS[0].id); } catch(e){} }
    }

    // update inline phone warning element by id
    function updatePhoneWarning(inputId, warnId, networkId){
        try{
            const inp = document.getElementById(inputId);
            const warn = document.getElementById(warnId);
            if(!inp || !warn) return;
            const net = networkId || (window._selectedNetwork && window._selectedNetwork.id) || null;
            if (!net) { warn.style.display = 'none'; return; }
            const res = validatePhoneForNetwork(net, inp.value || '');
            if (!res.valid){ warn.innerText = res.msg; warn.style.display = 'block'; }
            else { warn.style.display = 'none'; }
        }catch(e){/*ignore*/}
    }

    // Populate data plans into a container
    function populateDataPlans(containerId, networkId){
        const container = document.getElementById(containerId);
        if (!container) return;
        container.innerHTML = '';
        // prefer explicit networkId, else use currently selected network, else fallback to common plans
        const net = networkId || (window._selectedNetwork && window._selectedNetwork.id) || null;
        const plans = (net && DATA_PLANS_BY_NETWORK[net]) ? DATA_PLANS_BY_NETWORK[net] : COMMON_DATA_PLANS;
        plans.forEach(p => {
            const el = document.createElement('div');
            el.className = 'plan-tile';
            el.setAttribute('data-plan', p.id);
            el.innerHTML = `<div class="plan-amount">₦${Number(p.amount).toLocaleString()}</div><div class="plan-sub">${p.label}</div>`;
            el.addEventListener('click', ()=>{
                // clear other selections
                const others = container.querySelectorAll('.plan-tile');
                others.forEach(o => o.classList.remove('selected'));
                el.classList.add('selected');
                window._selectedPlan = p;
                // autofill amount input if present
                const amt = document.getElementById('data_amount'); if (amt) amt.value = p.amount;
            });
            container.appendChild(el);
        });
        // auto-select first plan for convenience
        const firstPlan = container.querySelector('.plan-tile');
        if (firstPlan) {
            firstPlan.classList.add('selected');
            window._selectedPlan = plans[0];
            const amt = document.getElementById('data_amount'); if (amt) amt.value = plans[0].amount;
        }
    }

    // Populate billers into grid
    function populateBillers(containerId){
        const container = document.getElementById(containerId);
        if (!container) return;
        container.innerHTML = '';
        BILLERS.forEach(b => {
            const el = document.createElement('div');
            el.className = 'biller-tile';
            el.setAttribute('data-biller', b.id);
            // use biller svg if present
            el.innerHTML = `<div class="biller-row"><div class="biller-logo"><img class="biller-img" src="images/billers/${b.id}.svg" alt="${b.name}" onerror="this.style.display='none'"></div><div style="flex:1"><div class="biller-name">${b.name}</div><div class="biller-sub">${b.desc}</div></div></div>`;
            el.addEventListener('click', ()=>{
                const others = container.querySelectorAll('.biller-tile');
                others.forEach(o => o.classList.remove('selected'));
                el.classList.add('selected');
                window._selectedBiller = b;
            });
            container.appendChild(el);
        });
        // optionally auto-select first biller
        const first = container.querySelector('.biller-tile'); if (first) { first.classList.add('selected'); window._selectedBiller = BILLERS[0]; }
    }

    window.populateNetworks = populateNetworks;
    window.populateDataPlans = populateDataPlans;
    window.populateBillers = populateBillers;

    // verify agent - safe no-throw
    function verifyAgent() {
        const el = $('agent');
        const result = $('result');
        if (!el || !result) return;
        const name = (el.value || '').toLowerCase();
        if (trustedAgents.has(name)) {
            result.textContent = '✅ Trusted Agent';
            result.className = 'success';
        } else {
            result.textContent = '⚠️ Suspicious Agent';
            result.className = 'danger';
        }
    }

    function showNotification(msg, timeout = 3000) {
        const note = document.createElement('div');
        note.className = 'notification';
        note.innerText = msg;
        document.body.appendChild(note);
        setTimeout(() => note.remove(), timeout);
    }

    // expose notification for other pages
    window.showNotification = showNotification;

    function saveReport() {
        const name = $('r_name')?.value || '';
        const location = $('r_location')?.value || '';
        const message = $('r_message')?.value || '';
        try {
            const reports = JSON.parse(localStorage.getItem('reports') || '[]');
            const reporter = localStorage.getItem('loggedInUser') || 'guest';
            reports.push({ name, location, message, reporter, time: Date.now() });
            localStorage.setItem('reports', JSON.stringify(reports));
            showToast('Report submitted successfully!', 'success');
            (function clear() { if ($('r_name')) $('r_name').value = ''; if ($('r_location')) $('r_location').value = ''; if ($('r_message')) $('r_message').value = ''; })();
        } catch (e) {
            console.error('saveReport failed', e);
            showToast('Unable to save report.', 'danger');
        }
    }

    /*
      Support tickets handler
      Stores into localStorage under 'supportTickets' and shows a notification.
    */
    function createSupportTicket() {
        const name = $('s_name')?.value || localStorage.getItem('loggedInUser') || 'Guest';
        const email = $('s_email')?.value || '';
        const subject = $('s_subject')?.value || '';
        const category = $('s_category')?.value || 'General';
        const priority = $('s_priority')?.value || 'Normal';
        const message = $('s_message')?.value || '';
    if (!subject || !message) { showToast('Please provide a subject and message for support', 'info'); return; }
        try {
            const tickets = JSON.parse(localStorage.getItem('supportTickets') || '[]');
            const reporter = localStorage.getItem('loggedInUser') || name || 'guest';
            tickets.push({ name, email, subject, category, priority, message, reporter, time: Date.now(), status: 'open' });
            localStorage.setItem('supportTickets', JSON.stringify(tickets));
            showToast('Support request submitted — our team will contact you shortly.', 'success');
            // clear some fields for convenience
            if ($('s_subject')) $('s_subject').value = '';
            if ($('s_message')) $('s_message').value = '';
            setTimeout(() => { window.location.href = 'dashboard.html'; }, 900);
        } catch (e) {
            console.error('createSupportTicket failed', e);
            showToast('Unable to submit support request.', 'danger');
        }
    }

    /* Simple support chat (client-side rule-based bot + persistent history)
       Stores messages in localStorage under 'supportChat' as an array of { user, role, text, time }
    */
    function _getChatStore() {
        return JSON.parse(localStorage.getItem('supportChat') || '[]');
    }
    function _saveChatStore(arr) {
        localStorage.setItem('supportChat', JSON.stringify(arr));
    }

    function renderSupportChat(containerId = 'chatMessages') {
        const container = document.getElementById(containerId);
        if (!container) return;
        const messages = _getChatStore();
        if (!messages.length) return container.innerHTML = '<div style="color:rgba(255,255,255,0.6)">No messages yet. Say hi 👋</div>';
        container.innerHTML = messages.map(m => {
            const ts = new Date(m.time).toLocaleTimeString();
            if (m.role === 'user') {
                return `<div class="msg user"><div class="bubble">${escapeHtml(m.text)}<div class="ts">${ts}</div></div></div>`;
            }
            return `<div class="msg bot"><div class="bubble">${escapeHtml(m.text)}<div class="ts">${ts}</div></div></div>`;
        }).join('');
        container.scrollTop = container.scrollHeight;
    }

    function escapeHtml(str){
        if (!str) return '';
        return String(str).replace(/[&<>\"]/g, function(c){return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c];});
    }

    function openSupportChat() {
        const widget = document.getElementById('chatWidget');
        if (!widget) return;
        widget.setAttribute('aria-hidden', 'false');
        renderSupportChat();
        document.getElementById('chatInputField')?.focus();
    }
    function closeSupportChat() {
        const widget = document.getElementById('chatWidget');
        if (!widget) return;
        widget.setAttribute('aria-hidden', 'true');
    }

    function sendSupportChat() {
        const input = document.getElementById('chatInputField');
        if (!input) return;
        const text = (input.value || '').trim();
        if (!text) return;
        const user = localStorage.getItem('loggedInUser') || 'guest';
        const messages = _getChatStore();
        messages.push({ user, role: 'user', text, time: Date.now() });
        _saveChatStore(messages);
        input.value = '';
        renderSupportChat();

        // simulate bot typing and a reply
        setTimeout(() => {
            const reply = _generateBotReply(text);
            messages.push({ user: 'support-bot', role: 'bot', text: reply, time: Date.now() });
            _saveChatStore(messages);
            renderSupportChat();
        }, 700 + Math.floor(Math.random() * 900));
    }

    function _generateBotReply(userText) {
        const t = (userText || '').toLowerCase();
        const rules = [
            {k: ['balance','show balance','available balance'], r: 'To check your balance, open the app dashboard — your balance is shown on the top. If it looks incorrect, please provide the transaction details.'},
            {k: ['transfer','sent','send money'], r: 'Transfers are processed instantly. If the recipient did not receive funds, check the transaction history page and share the transaction reference for us to investigate.'},
            {k: ['pin','password','passcode'], r: 'For security reasons we do not store your PIN. If you suspect your PIN is compromised, change it immediately in the profile settings.'},
            {k: ['airtime','data','buy airtime','buy data'], r: 'Airtime and data purchases are visible in Recent Activity. If a purchase failed but money was deducted, please provide the phone number and amount.'},
            {k: ['loan','loan request'], r: 'Loan requests are reviewed by our team. Check the Loans section for status. If you need urgent help, select High priority when creating a ticket.'},
            {k: ['scam','fraud','suspicious'], r: 'If you suspect fraud, stop any outgoing payments, take screenshots, and submit a Support ticket with details. We will escalate immediately.'},
            {k: ['hello','hi','hey'], r: 'Hi there! I am Fast & Reliable Bank helper. How can I assist you today? You can ask about balance, transfers, airtime, loans or report suspicious activity.'}
        ];
        for (const rule of rules) {
            for (const kw of rule.k) {
                if (t.includes(kw)) return rule.r;
            }
        }
        // fallback
        return 'Thanks — your message has been received. Our human support team will reply in under 24 hours. For urgent issues, create a ticket in the form above.';
    }

    // expose chat functions
    window.openSupportChat = openSupportChat;
    window.closeSupportChat = closeSupportChat;
    window.sendSupportChat = sendSupportChat;
    window.renderSupportChat = renderSupportChat;

    /* PIN, biometrics and preferences helpers */
    function _toHex(buffer) {
        return Array.from(new Uint8Array(buffer)).map(b => b.toString(16).padStart(2,'0')).join('');
    }
    function _fromBase64(s) {
        try { return Uint8Array.from(atob(s), c => c.charCodeAt(0)); } catch (e) { return null; }
    }
    function _toBase64(u8) { return btoa(String.fromCharCode(...u8)); }

    async function hashPinWithSalt(pin, saltU8) {
        const enc = new TextEncoder();
        const pinU8 = enc.encode(pin);
        // concat salt + pin
        const merged = new Uint8Array(saltU8.length + pinU8.length);
        merged.set(saltU8, 0);
        merged.set(pinU8, saltU8.length);
        const digest = await crypto.subtle.digest('SHA-256', merged);
        return _toHex(digest);
    }

    async function setPin(pin) {
        // generate 12-byte salt
        const salt = crypto.getRandomValues(new Uint8Array(12));
        const hash = await hashPinWithSalt(pin, salt);
        const obj = { hash, salt: _toBase64(salt), created: Date.now() };
        localStorage.setItem('bt_pin', JSON.stringify(obj));
        return true;
    }

    async function verifyPinInput(pin) {
        try {
            const raw = localStorage.getItem('bt_pin');
            if (!raw) return false;
            const obj = JSON.parse(raw);
            const saltU8 = _fromBase64(obj.salt);
            if (!saltU8) return false;
            const h = await hashPinWithSalt(pin, saltU8);
            return h === obj.hash;
        } catch (e) { console.error('verifyPinInput', e); return false; }
    }

    async function changePin(oldPin, newPin) {
        const ok = await verifyPinInput(oldPin);
        if (!ok) return false;
        await setPin(newPin);
        return true;
    }

    async function forgotPin() {
        // simple demo: if profile email exists, generate a short code and prompt user
        try {
            const user = localStorage.getItem('loggedInUser') || 'guest';
            const profiles = JSON.parse(localStorage.getItem('bt_profiles') || '{}');
            const p = profiles[user] || {};
            if (!p.email) { showToast('No recovery email set in your profile. Please contact support.', 'danger'); return; }
            const code = Math.floor(100000 + Math.random()*900000).toString();
            const expires = Date.now() + 5*60*1000; // 5 min
            localStorage.setItem('bt_pin_reset', JSON.stringify({ code, expires, user }));
            // demo: show code to user (in real app, send by email)
            showToast(`Recovery code (demo): ${code}. It expires in 5 minutes.`, 'info', { duration: 8000 });
            const entered = await window.openInputModal({ title: 'Enter recovery code', placeholder: '123456', label: 'Recovery code' });
            if (!entered) return;
            const stored = JSON.parse(localStorage.getItem('bt_pin_reset')||'{}');
            if (stored.user !== user || stored.code !== entered || Date.now() > stored.expires) { showToast('Invalid or expired code','danger'); return; }
            const newPin = await window.openInputModal({ title: 'Enter new PIN', placeholder: 'New PIN', label: 'New PIN', type: 'password' });
            if (!newPin) return;
            await setPin(newPin);
            showToast('PIN reset successfully', 'success');
            localStorage.removeItem('bt_pin_reset');
    } catch (e) { console.error(e); showToast('Unable to reset PIN', 'danger'); }
    }

    async function enableBiometrics(kind='fingerprint') {
        // feature-detect platform authenticator availability, but this demo will mostly store a flag locally
        const isAvailable = !!(window.PublicKeyCredential && navigator.credentials);
        const flag = { enabled: true, kind, available: isAvailable, time: Date.now() };
        localStorage.setItem('bt_biometrics', JSON.stringify(flag));
    showToast(isAvailable ? 'Biometrics enabled (demo). Use device prompt where supported.' : 'Biometrics flag enabled (simulated)', 'success');
        return flag;
    }

    function setPref(key, value) {
        const prefs = JSON.parse(localStorage.getItem('bt_prefs')||'{}');
        prefs[key] = value;
        localStorage.setItem('bt_prefs', JSON.stringify(prefs));
    }

    function getPref(key, fallback) {
        const prefs = JSON.parse(localStorage.getItem('bt_prefs')||'{}');
        return prefs.hasOwnProperty(key) ? prefs[key] : fallback;
    }

    // expose security helpers
    window.setPin = setPin;
    window.verifyPinInput = verifyPinInput;
    window.changePin = changePin;
    window.forgotPin = forgotPin;
    window.enableBiometrics = enableBiometrics;
    window.setPref = setPref;
    window.getPref = getPref;

    /* Receipt modal and helpers */
    function _getTxById(id) {
        const history = JSON.parse(localStorage.getItem('history') || '[]');
        return history.find(t => t.id === id) || null;
    }

    function _createReceiptModalIfNeeded() {
        if (document.getElementById('receiptModal')) return;
        const modal = document.createElement('div');
        modal.id = 'receiptModal';
        modal.className = 'receipt-modal';
        modal.innerHTML = `
          <div class="receipt-card">
            <header class="receipt-header"><strong>Transaction Receipt</strong><div><button id="receiptPrintBtn">Print</button> <button id="receiptCloseBtn">Close</button></div></header>
            <div id="receiptBody" class="receipt-body">Loading...</div>
          </div>
        `;
        document.body.appendChild(modal);
        // wire buttons
        modal.querySelector('#receiptCloseBtn')?.addEventListener('click', () => { modal.style.display = 'none'; });
        modal.querySelector('#receiptPrintBtn')?.addEventListener('click', () => {
            const printContent = document.getElementById('receiptBody')?.innerHTML || '';
            const w = window.open('', '_blank');
            if (!w) { showToast('Popup blocked. Please allow popups to print.', 'info'); return; }
            w.document.write('<html><head><title>Receipt</title><style>body{font-family:Inter,Arial,Helvetica,sans-serif;padding:20px;color:#111} .r{border-bottom:1px solid #eee;padding:6px 0}</style></head><body>');
            w.document.write(printContent);
            w.document.write('</body></html>');
            w.document.close();
            w.focus();
            setTimeout(() => w.print(), 300);
        });
    }

    // Confirmation modal for purchases
    function _createConfirmModalIfNeeded() {
        if (document.getElementById('confirmModal')) return;
        const modal = document.createElement('div');
        modal.id = 'confirmModal';
        modal.className = 'confirm-modal';
        modal.style.display = 'none';
        modal.innerHTML = `
          <div class="confirm-card">
            <header class="confirm-header"><strong id="confirmTitle">Confirm Purchase</strong><div><button id="confirmCloseBtn">✖</button></div></header>
            <div id="confirmBody" class="confirm-body">...</div>
            <div class="confirm-actions"><button id="confirmCancel" class="btn-ghost">Cancel</button><button id="confirmBtn" class="primary">Confirm</button></div>
          </div>`;
        document.body.appendChild(modal);
        modal.querySelector('#confirmCloseBtn')?.addEventListener('click', ()=> modal.style.display = 'none');
        modal.querySelector('#confirmCancel')?.addEventListener('click', ()=> modal.style.display = 'none');
    }

    function computeFee(type, amount){
        amount = Number(amount) || 0;
        if (type === 'airtime') return Math.max(10, Math.round(amount * 0.015));
        if (type === 'data') return Math.max(20, Math.round(amount * 0.02));
        if (type === 'bill') return Math.max(20, Math.round(amount * 0.005));
        return Math.max(20, Math.round(amount * 0.01));
    }
    // helper: update tx status in history (and return updated tx)
    function updateTxStatus(id, status, extras){
        try{
            const history = JSON.parse(localStorage.getItem('history')||'[]');
            const idx = history.findIndex(t => t.id === id);
            if (idx === -1) return null;
            history[idx].status = status;
            if (extras) Object.assign(history[idx], extras);
            // update time for status change
            history[idx].updated = Date.now();
            localStorage.setItem('history', JSON.stringify(history));
            return history[idx];
        }catch(e){ console.error('updateTxStatus', e); return null; }
    }

    // process a pending transaction by id: show processing UI in the confirm modal and settle it
    async function processPendingTx(txId, modal){
        try{
            _createConfirmModalIfNeeded();
            modal = modal || document.getElementById('confirmModal');
            const body = modal.querySelector('#confirmBody');
            const cancel = modal.querySelector('#confirmCancel');
            if (!body) return;
            // show processing UI
            body.innerHTML = `
                <div style="display:flex;flex-direction:column;align-items:center;gap:12px;padding:18px">
                    <div class="processing-spinner"></div>
                    <div style="font-weight:600">Processing payment…</div>
                    <div style="color:rgba(0,0,0,0.6)">This may take a few seconds. Do not close the app.</div>
                </div>
            `;
            if (cancel) cancel.style.display = 'none';
            // If an API endpoint is configured, try server-side processing first
            const apiEndpoint = window.BT_API_ENDPOINT || localStorage.getItem('bt_api_endpoint') || null;
            let apiResult = null;
            if (apiEndpoint) {
                try {
                    apiResult = await processTxViaApi(txId, apiEndpoint);
                } catch (e) {
                    console.warn('API processing failed, will fallback to local simulation', e);
                    apiResult = null;
                }
            }

            if (apiResult && apiResult.status) {
                // server returned a definitive result
                if (apiResult.status === 'success' || apiResult.status === 'completed') {
                    updateTxStatus(txId, 'success', { serverRef: apiResult.ref || apiResult.transactionRef });
                    // update UI to success below
                } else if (apiResult.status === 'failed') {
                    updateTxStatus(txId, 'failed', { serverRef: apiResult.ref || apiResult.transactionRef, error: apiResult.error || null });
                } else {
                    // unknown / pending from server - treat as pending and continue simulation
                    updateTxStatus(txId, 'pending');
                    apiResult = null; // allow fallback to simulation
                }
            }

            // If apiResult was null (no endpoint or server returned pending), fallback to local simulation
            if (!apiResult) {
                // simulate async processing delay
                const delay = 900 + Math.floor(Math.random()*1600);
                await new Promise(res => setTimeout(res, delay));
                const success = Math.random() < 0.92;
                if (success) {
                    updateTxStatus(txId, 'success');
                } else {
                    updateTxStatus(txId, 'failed');
                }
            }

            // re-read tx to decide UI
            const txAfter = _getTxById(txId) || {};
            const finalStatus = txAfter.status || 'failed';
            if (finalStatus === 'success' || finalStatus === 'completed') {
                body.innerHTML = `
                    <div style="display:flex;flex-direction:column;align-items:center;gap:10px;padding:18px">
                        <div style="font-size:36px">✅</div>
                        <div style="font-weight:700">Payment Successful</div>
                        <div style="color:rgba(0,0,0,0.6)">Reference: ${escapeHtml(txId)}</div>
                        <div style="display:flex;gap:8px;margin-top:12px"><button id="confirmViewReceipt" class="primary">View receipt</button><button id="confirmCloseFinal" class="btn-ghost">Close</button></div>
                    </div>
                `;
                modal.querySelector('#confirmViewReceipt')?.addEventListener('click', ()=> showReceipt(txId));
                modal.querySelector('#confirmCloseFinal')?.addEventListener('click', ()=>{ modal.style.display = 'none'; window.location.href = 'dashboard.html'; });
                showToast('✅ Payment processed — receipt available', 'success');
            } else {
                body.innerHTML = `
                    <div style="display:flex;flex-direction:column;align-items:center;gap:10px;padding:18px">
                        <div style="font-size:36px">❌</div>
                        <div style="font-weight:700">Payment Failed</div>
                        <div style="color:rgba(0,0,0,0.6)">Reference: ${escapeHtml(txId)}</div>
                        <div style="display:flex;gap:8px;margin-top:12px"><button id="confirmRetry" class="primary">Retry</button><button id="confirmCloseFinal2" class="btn-ghost">Close</button></div>
                    </div>
                `;
                modal.querySelector('#confirmRetry')?.addEventListener('click', ()=>{ modal.style.display = 'none'; retryTx(txId); });
                modal.querySelector('#confirmCloseFinal2')?.addEventListener('click', ()=>{ modal.style.display = 'none'; });
                showToast('⚠️ Payment failed. Please try again.', 'danger');
            }
        }catch(e){ console.error('processPendingTx', e); }
    }

    // Helper: call a backend API to process a transaction by txId.
    // The API is expected to accept POST { txId } and return JSON { status: 'success'|'failed'|'pending', ref?:string, error?:string }
    async function processTxViaApi(txId, endpoint){
        const tx = _getTxById(txId);
        if (!tx) throw new Error('tx-not-found');
        // build payload with minimal fields; server should reconcile by id
        const payload = { id: tx.id, user: tx.user, type: tx.type, amount: tx.amount, phone: tx.phone || null, plan: tx.plan || null, biller: tx.biller || null };
        const controller = new AbortController();
        const timeout = setTimeout(()=> controller.abort(), 12000); // 12s timeout
        try {
            const fetchOptions = {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
                signal: controller.signal
            };
            // allow optional auth token
            const token = window.BT_API_TOKEN || localStorage.getItem('bt_api_token');
            if (token) fetchOptions.headers['Authorization'] = 'Bearer ' + token;
            const res = await fetch(endpoint, fetchOptions);
            clearTimeout(timeout);
            if (!res.ok) {
                const txt = await res.text().catch(()=> '');
                throw new Error('bad-status:' + res.status + ' ' + txt);
            }
            const json = await res.json().catch(()=> null);
            if (!json) throw new Error('invalid-json');
            return json;
        }finally{ clearTimeout(timeout); }
    }

    // show confirmation modal with summary and onConfirm callback
    // onConfirm should return either a tx details object (not yet saved) or a tx id string
    function showConfirm(summary, onConfirm){
        _createConfirmModalIfNeeded();
        const modal = document.getElementById('confirmModal');
        const body = document.getElementById('confirmBody');
        const title = document.getElementById('confirmTitle');
        if (!modal || !body) return;
        title.innerText = summary.title || 'Confirm Purchase';
        const fee = computeFee(summary.type, summary.amount);
        const total = Number(summary.amount) + fee;
        let warnHtml = '';
        if (summary.phone && summary.networkId){
            const v = validatePhoneForNetwork(summary.networkId, summary.phone);
            if (!v.valid) warnHtml = `<div class="warning-text">Warning: ${escapeHtml(v.msg)}</div>`;
        }
        body.innerHTML = `
          <div class="confirm-row"><div>Type</div><div><strong>${escapeHtml(summary.type||'')}</strong></div></div>
          <div class="confirm-row"><div>Network / Provider</div><div>${escapeHtml(summary.networkName||summary.biller||'—')}</div></div>
          <div class="confirm-row"><div>Reference / Phone</div><div>${escapeHtml(summary.phone||summary.ref||'—')}</div></div>
          <div class="confirm-row"><div>Amount</div><div>₦${Number(summary.amount||0).toLocaleString()}</div></div>
          <div class="confirm-row"><div>Fee</div><div>₦${Number(fee).toLocaleString()}</div></div>
          <div class="confirm-row"><div>Total</div><div><strong>₦${Number(total).toLocaleString()}</strong></div></div>
          ${warnHtml}
        `;
        // wire confirm button
        const btn = modal.querySelector('#confirmBtn');
        const cancel = modal.querySelector('#confirmCancel');
        const close = ()=> modal.style.display = 'none';
        btn.onclick = async function(){
            try{
                btn.disabled = true; btn.innerText = 'Processing...';
                // call onConfirm to get tx details or id
                const maybe = await onConfirm({ fee, total });
                let txId = null;
                // if onConfirm returned a string, assume it's tx id
                if (typeof maybe === 'string') txId = maybe;
                // if onConfirm returned an object, create a pending tx
                else if (typeof maybe === 'object' && maybe !== null) {
                    const details = Object.assign({}, maybe, { fee, total, status: 'pending' });
                    txId = _saveTx(summary.type || maybe.type || 'payment', details);
                } else {
                    // fallback: if onConfirm didn't return details, create nothing but still show processing simulation
                    const details = { fee, total, status: 'pending' };
                    txId = _saveTx(summary.type || 'payment', details);
                }

                // hand off to centralized processing that will update tx status and modal UI
                await processPendingTx(txId, modal);

            }catch(e){ console.error(e); showToast('Failed to process', 'danger'); }
            btn.disabled = false; btn.innerText = 'Confirm';
        };
        modal.style.display = 'flex';
    }

    function showReceipt(id) {
        _createReceiptModalIfNeeded();
        const modal = document.getElementById('receiptModal');
        const body = document.getElementById('receiptBody');
        const tx = _getTxById(id) || (JSON.parse(localStorage.getItem('loanRequests')||'[]').find(l=>l.id===id) || null);
        if (!tx) {
            body.innerHTML = '<div class="r">Receipt not found.</div>';
            modal.style.display = 'block';
            return;
        }
        const when = new Date(tx.time).toLocaleString();
        // build details area depending on type
        let details = '';
        if (tx.type === 'airtime') details = `<div class="r">Phone: ${escapeHtml(tx.phone)}</div><div class="r">Amount: ₦${Number(tx.amount).toLocaleString()}</div>`;
        else if (tx.type === 'data') details = `<div class="r">Phone: ${escapeHtml(tx.phone)}</div><div class="r">Plan: ${escapeHtml(tx.plan)}</div><div class="r">Amount: ₦${Number(tx.amount).toLocaleString()}</div>`;
        else if (tx.type === 'bill') details = `<div class="r">Biller: ${escapeHtml(tx.biller)}</div><div class="r">Reference: ${escapeHtml(tx.ref)}</div><div class="r">Amount: ₦${Number(tx.amount).toLocaleString()}</div>`;
        else if ((tx.type||'').startsWith('loan')) details = `<div class="r">Loan request: ₦${Number(tx.amount).toLocaleString()}</div><div class="r">Term: ${escapeHtml(tx.term||'')}</div>`;
        else details = `<div class="r">To: ${escapeHtml(tx.receiver||tx.beneficiary||'')}</div><div class="r">Amount: ₦${Number(tx.amount||0).toLocaleString()}</div>`;

        body.innerHTML = `
          <div style="padding:12px">
            <div class="r"><strong>${escapeHtml(tx.type ? tx.type.toUpperCase() : 'TRANSACTION')}</strong></div>
            <div class="r">Reference: <strong>${escapeHtml(tx.id || '')}</strong></div>
            <div class="r">Account: ${escapeHtml(tx.user || 'guest')}</div>
            ${details}
            <div class="r">Date: ${when}</div>
            <div class="r">Status: ${escapeHtml(tx.status || 'completed')}</div>
          </div>
        `;
                // if failed and belongs to current user, offer retry
                const currentUser = localStorage.getItem('loggedInUser') || 'guest';
                if (tx.status === 'failed' && tx.user === currentUser) {
                        const footer = document.createElement('div');
                        footer.style.display = 'flex';
                        footer.style.justifyContent = 'flex-end';
                        footer.style.gap = '8px';
                        footer.style.padding = '10px';
                        const retryBtn = document.createElement('button');
                        retryBtn.className = 'primary';
                        retryBtn.innerText = 'Retry Payment';
                        retryBtn.addEventListener('click', ()=>{ modal.style.display = 'none'; retryTx(tx.id); });
                        footer.appendChild(retryBtn);
                        // append footer after body content
                        const card = modal.querySelector('.receipt-card');
                        if (card) card.appendChild(footer);
                }
                modal.style.display = 'block';
    }

        // retry a failed tx by id: mark pending and process again
        function retryTx(txId){
                const tx = _getTxById(txId);
                if (!tx) { showToast('Transaction not found', 'info'); return; }
                updateTxStatus(txId, 'pending');
                _createConfirmModalIfNeeded();
                const modal = document.getElementById('confirmModal');
                modal.style.display = 'flex';
                processPendingTx(txId, modal);
        }

        window.retryTx = retryTx;

    // Theme toggle: inject a small toggle into topbar and persist choice
    function initTheme() {
        try {
            const bar = document.querySelector('.topbar');
            if (!bar) return;
            const btn = document.createElement('button');
            btn.id = 'themeToggleBtn';
            btn.title = 'Toggle theme';
            btn.style.padding = '6px 8px';
            btn.style.borderRadius = '8px';
            btn.style.border = 'none';
            btn.style.cursor = 'pointer';
            btn.innerText = '🌙';
            btn.addEventListener('click', toggleTheme);
            bar.appendChild(btn);
            // add quick settings link
            const s = document.createElement('a');
            s.href = 'settings.html';
            s.title = 'Settings';
            s.style.marginLeft = '8px';
            s.style.textDecoration = 'none';
            s.style.fontSize = '18px';
            s.innerText = '⚙️';
            bar.appendChild(s);
            // apply saved or system preference
            const saved = localStorage.getItem('bt_theme');
            if (saved === 'dark') document.body.classList.add('dark-mode');
            else if (saved === 'light') document.body.classList.remove('dark-mode');
            else if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) document.body.classList.add('dark-mode');
            _updateThemeButton();
        } catch (e) { /* ignore */ }
    }

    function toggleTheme() {
        document.body.classList.toggle('dark-mode');
        const active = document.body.classList.contains('dark-mode') ? 'dark' : 'light';
        localStorage.setItem('bt_theme', active);
        _updateThemeButton();
    }

    function _updateThemeButton(){
        const btn = document.getElementById('themeToggleBtn');
        if (!btn) return;
        btn.innerText = document.body.classList.contains('dark-mode') ? '☀️' : '🌙';
    }

    // expose receipt and theme helpers
    window.showReceipt = showReceipt;
    window.initTheme = initTheme;
    window.toggleTheme = toggleTheme;

    function detectFraud(amount, receiver) {
        let risk = 0;
        if (!Number.isFinite(amount)) amount = Number(amount) || 0;
        if (amount > 50000) risk += 50;
        if ((receiver || '').toLowerCase().includes('unknown')) risk += 30;
        if (Math.random() > 0.7) risk += 20;
        if (risk >= 70) return '⚠️ High Risk Transaction!';
        if (risk >= 40) return '⚠️ Medium Risk';
        return '✅ Safe Transaction';
    }

    function processTransaction() {
        const receiver = $('receiver')?.value || '';
        const amount = Number($('amount')?.value || 0);
        const result = detectFraud(amount, receiver);
        if ($('fraudResult')) $('fraudResult').innerText = result;
    if (result.includes('High Risk')) return showToast('Transaction blocked for high risk.', 'danger');
        localStorage.setItem('pendingTransaction', JSON.stringify({ receiver, amount, time: Date.now(), type: 'transfer' }));
        window.location.href = 'pin.html';
    }

    function verifyPin() {
        // new PIN verification uses hashed PIN stored in localStorage
        (async function(){
            const pin = $('pin')?.value || '';
            if (!pin) { showToast('Enter PIN', 'info'); return; }
            const ok = await verifyPinInput(pin);
            if (ok) {
                completeTransaction();
            } else {
                showToast('❌ Incorrect PIN', 'danger');
            }
        })();
    }

    function completeTransaction() {
        try {
            const tx = JSON.parse(localStorage.getItem('pendingTransaction') || '{}');
            if (!tx || !tx.receiver) { showToast('No pending transaction', 'info'); return; }
            // attach current user to transaction for profiling
            const currentUser = localStorage.getItem('loggedInUser') || 'guest';
            const history = JSON.parse(localStorage.getItem('history') || '[]');
            // ensure unique id for receipt
            const id = 'tx_' + Date.now() + '_' + Math.random().toString(36).slice(2,8);
            const fullTx = Object.assign({}, tx, { user: currentUser, id, time: Date.now(), type: tx.type || 'transfer' });
            history.push(fullTx);
            localStorage.setItem('history', JSON.stringify(history));
            localStorage.removeItem('pendingTransaction');
            // show receipt modal
            showReceipt(id);
            // small friendly notification
            showToast('✅ Transaction Successful! Receipt ready', 'success');
            // redirect after a short delay so user can view receipt
            setTimeout(() => { window.location.href = 'dashboard.html'; }, 1500);
        } catch (e) {
            console.error(e);
            showToast('Failed to complete transaction.', 'danger');
        }
    }

    // expose to global for compatibility with existing HTML handlers
    window.verifyAgent = verifyAgent;
    window.saveReport = saveReport;
    window.processTransaction = processTransaction;
    window.verifyPin = verifyPin;
    window.completeTransaction = completeTransaction;
    window.detectFraud = detectFraud;

    // Account name resolver: prefer server lookup when `bt_api_endpoint` is configured, else fallback to a simulated resolver.
    window.resolveAccountName = async function(bank, accountNumber){
        const acct = (accountNumber || '').toString().replace(/\D/g,'');
        if (acct.length < 6) return null;

        // Try configured endpoint first
        const ep = localStorage.getItem('bt_api_endpoint') || window.BT_API_ENDPOINT || null;
        const tok = localStorage.getItem('bt_api_token') || window.BT_API_TOKEN || null;
        if (ep) {
            try {
                const url = (ep||'').replace(/\/$/, '') + '/resolve-account';
                const controller = new AbortController();
                const timeout = setTimeout(()=>controller.abort(), 1800);
                const res = await fetch(url, {
                    method: 'POST',
                    headers: Object.assign({'Content-Type':'application/json'}, tok ? { 'Authorization': tok } : {}),
                    body: JSON.stringify({ bank: bank || '', accountNumber: acct }),
                    signal: controller.signal
                });
                clearTimeout(timeout);
                if (res && res.ok) {
                    const j = await res.json();
                    if (j && j.name) return j.name;
                }
            } catch (e) {
                // server lookup failed or timed out — fall back to local resolver
                console.warn('Account resolve via API failed, falling back to local:', e && e.message ? e.message : e);
            }
        }

        // Local simulated resolver (fast)
        return new Promise(resolve => {
            setTimeout(()=>{
                let name = null;
                if (/^10/.test(acct)) name = 'Aisha Bello';
                else if (/^20/.test(acct)) name = 'John Okafor';
                else if (/^30/.test(acct)) name = 'Mary Smith';
                else if (/^40/.test(acct)) name = 'Chinedu Emeka';
                else name = 'Customer ' + acct.slice(-4);
                resolve(name);
            }, 320);
        });
    };

    // Initialize send page behaviors if relevant elements exist
    (function initSendPage(){
        if (!document.getElementById) return;
        const acctEl = document.getElementById('accountNumber');
        if (!acctEl) return; // not on send page

        const bankEl = document.getElementById('bankSelect');
        const nameDisplay = document.getElementById('accountNameDisplay');
        const nameStatus = document.getElementById('accountNameStatus');
        const spinner = document.getElementById('acctLookupSpinner');
        const receiver = document.getElementById('receiver');
        const sendBtn = document.getElementById('btnSend');

        let lookupTimer = null;
        // per-bank rules (account number length + friendly hint). Adjust as needed for real banks.
        const bankRules = {
            access: { len:10, hint: 'Access Bank accounts are 10 digits' },
            gtb:    { len:10, hint: 'Guaranty Trust Bank accounts are 10 digits' },
            zenith: { len:10, hint: 'Zenith Bank accounts are 10 digits' },
            uba:    { len:10, hint: 'UBA accounts are 10 digits' },
            first:  { len:10, hint: 'First Bank accounts are 10 digits' }
        };

        function setAvatarFromName(name){
            const avat = document.getElementById('accountAvatar');
            if (!avat) return;
            if (!name) { avat.innerText = 'A'; avat.style.background = 'linear-gradient(90deg,var(--accent),#1a63e6)'; return; }
            const parts = name.split(' ').filter(Boolean);
            const initials = (parts.length === 1) ? parts[0].slice(0,2).toUpperCase() : (parts[0][0]+(parts[1] ? parts[1][0] : '')).toUpperCase();
            avat.innerText = initials;
            // gentle deterministic color from name
            let hash = 0; for (let i=0;i<name.length;i++) hash = (hash<<5)-hash + name.charCodeAt(i);
            const h = Math.abs(hash) % 360;
            avat.style.background = `linear-gradient(90deg,hsl(${h} 70% 45%), hsl(${(h+40)%360} 70% 40%))`;
        }

        async function doLookup(){
            const bank = bankEl?.value || '';
            const acct = acctEl.value || '';
            nameDisplay.className = '';
            nameStatus.innerText = '';
            document.getElementById('accountNameHint').innerText = '';
            receiver.value = '';
            sendBtn.disabled = true;

            const cleaned = acct.replace(/\D/g,'');
            // enforce per-bank length when bank selected and show friendly hints
            if (bank && bankRules[bank]){
                const required = bankRules[bank].len;
                const hint = bankRules[bank].hint;
                if (cleaned.length === 0){ nameDisplay.innerText = 'Account name will appear here'; document.getElementById('accountNameHint').innerText = hint; setAvatarFromName(null); return; }
                if (cleaned.length !== required) {
                    nameDisplay.innerText = `Account number must be ${required} digits for selected bank`;
                    nameDisplay.className = 'acct-warning';
                    document.getElementById('accountNameHint').innerText = hint;
                    setAvatarFromName(null);
                    sendBtn.disabled = true;
                    return;
                }
            } else {
                if (cleaned.length < 6) { nameDisplay.innerText = 'Account name will appear here'; setAvatarFromName(null); return; }
            }

            spinner.style.display = 'inline-block';
            // attempt server lookup first via resolveAccountName which now prefers bt_api_endpoint, else local
            const name = await window.resolveAccountName(bank, acct);
            spinner.style.display = 'none';
            if (name) {
                nameDisplay.innerText = name;
                nameDisplay.className = 'acct-ok';
                nameStatus.innerText = '✓';
                nameStatus.className = 'acct-ok';
                receiver.value = name;
                sendBtn.disabled = false;
                document.getElementById('accountNameHint').innerText = '';
                setAvatarFromName(name);
            } else {
                nameDisplay.innerText = 'Lookup failed';
                nameDisplay.className = 'acct-fail';
                nameStatus.innerText = '✖';
                nameStatus.className = 'acct-fail';
                receiver.value = '';
                sendBtn.disabled = true;
                setAvatarFromName(null);
            }
        }

        acctEl.addEventListener('input', ()=>{
            clearTimeout(lookupTimer);
            lookupTimer = setTimeout(doLookup, 420);
        });
        bankEl?.addEventListener('change', ()=>{ clearTimeout(lookupTimer); lookupTimer = setTimeout(doLookup, 300); });

        // preview button shows a small confirm with details
        document.getElementById('btnPreview')?.addEventListener('click', ()=>{
            const bank = bankEl?.value || ''; const acct = acctEl?.value || ''; const name = receiver?.value || '';
            const amount = Number(document.getElementById('amount')?.value || 0);
            if (!bank || !acct || !name) { showToast('Enter bank and valid account','info'); return; }
            // use showConfirm so preview flows into the same confirm/process UX
            if (window.showConfirm) {
                window.showConfirm({ title: 'Confirm Transfer', type: 'transfer', networkName: bank, phone: acct, amount }, async ({ fee, total }) => {
                    // return tx details to be saved and processed
                    return { receiver: name, accountNumber: acct, bank, amount, fee, total };
                });
            } else {
                showToast(`Preview: Bank: ${bank} Account: ${acct} Name: ${name} Amount: ₦${amount}`, 'info', { duration: 6000 });
            }
        });

        // wire Send button to the same confirm flow (shows confirm modal and processes on confirm)
        sendBtn?.addEventListener('click', ()=>{
            const bank = bankEl?.value || ''; const acct = acctEl?.value || ''; const name = receiver?.value || '';
            const amount = Number(document.getElementById('amount')?.value || 0);
            if (!bank || !acct || !name) { showToast('Enter bank and valid account','info'); return; }
            if (window.showConfirm) {
                window.showConfirm({ title: 'Confirm Transfer', type: 'transfer', networkName: bank, phone: acct, amount }, async ({ fee, total }) => {
                    return { receiver: name, accountNumber: acct, bank, amount, fee, total };
                });
            } else {
                // fallback to current behavior
                localStorage.setItem('pendingTransaction', JSON.stringify({ receiver: name, amount: amount, time: Date.now(), type: 'transfer' }));
                window.location.href = 'pin.html';
            }
        });

    })();

        // Quick handlers for airtime, data, bills and loan flows
        function _saveTx(type, details) {
            const user = localStorage.getItem('loggedInUser') || 'guest';
            const history = JSON.parse(localStorage.getItem('history') || '[]');
            const id = 'tx_' + Date.now() + '_' + Math.random().toString(36).slice(2,8);
            const tx = Object.assign({ user, type, time: Date.now(), id }, details);
            history.push(tx);
            localStorage.setItem('history', JSON.stringify(history));
            return id;
        }

        function processAirtime() {
            const phone = $('air_phone')?.value || '';
            const amount = Number($('air_amount')?.value || 0);
            const network = window._selectedNetwork || null;
            if (!phone || amount <= 0) { showToast('Enter phone and amount','info'); return; }
            const risk = detectFraud(amount, phone);
            if (risk.includes('High Risk')) return showToast('Airtime purchase blocked for high risk', 'danger');
            const details = { type: 'airtime', phone, amount };
            if (network) { details.networkId = network.id; details.networkName = network.name; }
            showConfirm({ title: 'Confirm Airtime Purchase', type: 'airtime', networkName: network ? network.name : '', networkId: network?network.id:null, phone, amount }, async ({ fee, total }) => {
                // return details to the confirm/processing flow — showConfirm will create pending tx and process it
                return Object.assign({}, details, { fee, total });
            });
        }

        function processData() {
            const phone = $('data_phone')?.value || '';
            const amountInput = document.getElementById('data_amount');
            const amount = Number(amountInput?.value || 0);
            const plan = window._selectedPlan || null;
            const network = window._selectedNetwork || null;
            if (!phone || !plan || amount <= 0) { showToast('Enter phone and select a plan','info'); return; }
            const risk = detectFraud(amount, phone);
            if (risk.includes('High Risk')) return showToast('Data purchase blocked for high risk', 'danger');
            const details = { type: 'data', phone, plan: plan.label, amount };
            if (network) { details.networkId = network.id; details.networkName = network.name; }
            showConfirm({ title: 'Confirm Data Purchase', type: 'data', networkName: network ? network.name : '', networkId: network?network.id:null, phone, amount, plan: plan.label }, async ({ fee, total }) => {
                return Object.assign({}, details, { fee, total });
            });
        }

        function payBill() {
            const selected = window._selectedBiller || null;
            const ref = $('bill_ref')?.value || '';
            const amount = Number($('bill_amount')?.value || 0);
            if (!selected || !ref || amount <= 0) { showToast('Select a provider, enter reference and amount','info'); return; }
            const risk = detectFraud(amount, selected.name);
            if (risk.includes('High Risk')) return showToast('Bill payment blocked for high risk', 'danger');
            const details = { type: 'bill', biller: selected.name, billerId: selected.id, billType: selected.type, ref, amount };
            showConfirm({ title: 'Confirm Bill Payment', type: 'bill', networkName: selected.name, phone: ref, amount }, async ({ fee, total }) => {
                return Object.assign({}, details, { fee, total });
            });
        }

        function requestLoan() {
            const amount = Number($('loan_amount')?.value || 0);
            const term = $('loan_term')?.value || '';
            if (amount <= 0 || !term) { showToast('Enter loan amount and term','info'); return; }
            const user = localStorage.getItem('loggedInUser') || 'guest';
            const loans = JSON.parse(localStorage.getItem('loanRequests') || '[]');
            const id = 'loan_' + Date.now() + '_' + Math.random().toString(36).slice(2,8);
            loans.push({ user, amount, term, time: Date.now(), status: 'pending', id });
            localStorage.setItem('loanRequests', JSON.stringify(loans));
            showToast('Loan request submitted', 'success');
            setTimeout(() => showReceipt(id), 120);
            setTimeout(() => window.location.href = 'dashboard.html', 1200);
        }

        window.processAirtime = processAirtime;
        window.processData = processData;
        window.payBill = payBill;
        window.requestLoan = requestLoan;
        window.createSupportTicket = createSupportTicket;

        // Render recent activity cards into #activityList (with quick-preview)
        window.renderRecentActivity = function(containerEl){
            try{
                const container = containerEl || document.getElementById('activityList');
                if(!container) return;
                const history = JSON.parse(localStorage.getItem('history')||'[]');
                const recent = history.slice().sort((a,b)=>new Date(b.time)-new Date(a.time)).slice(0,6);
                container.innerHTML = '';
                if(recent.length===0){
                    container.innerHTML = '<div class="tx-card centered"><div class="tx-content"><div class="tx-title">No recent activity</div><div class="tx-sub">Make your first transaction — buy airtime, pay a bill or send money.</div></div></div>';
                    return;
                }
                recent.forEach((tx, idx)=>{
                    const card = document.createElement('div');
                    card.className = 'tx-card';
                    card.style.animationDelay = (idx*60)+'ms';
                    // icon
                    const icon = document.createElement('div');
                    icon.className = 'tx-icon';
                    let emoji = '💸';
                    if(tx.type && tx.type.toLowerCase().includes('airtime')) emoji = '📱';
                    else if(tx.type && tx.type.toLowerCase().includes('data')) emoji = '🌐';
                    else if(tx.type && tx.type.toLowerCase().includes('bill')) emoji = '🧾';
                    else if(tx.type && tx.type.toLowerCase().includes('loan')) emoji = '🏦';
                    else if(tx.type && tx.type.toLowerCase().includes('transfer')) emoji = '➡️';
                    icon.textContent = emoji;
                    // small left-side status indicator (dot)
                    const indicator = document.createElement('span');
                    const st = (tx.status || (String(tx.id||'').startsWith('loan_') ? 'pending' : 'completed'));
                    indicator.className = 'tx-indicator ' + st;
                    icon.appendChild(indicator);

                    const content = document.createElement('div');
                    content.className = 'tx-content';
                    const title = document.createElement('div');
                    title.className = 'tx-title';
                    title.textContent = (tx.type ? tx.type : 'Transaction') + ' • ' + (tx.counterparty||tx.recipient||tx.service||'—');
                    const sub = document.createElement('div');
                    sub.className = 'tx-sub';
                    const when = new Date(tx.time||Date.now());
                    sub.textContent = when.toLocaleString();
                    content.appendChild(title);
                    content.appendChild(sub);

                    const amt = document.createElement('div');
                    amt.className = 'tx-amount';
                    if (tx.amount) amt.textContent = '₦' + Number(tx.amount).toLocaleString(); else amt.textContent = '₦0.00';

                    const view = document.createElement('a');
                    view.href = '#';
                    view.className = 'small-link tx-badge';
                    view.textContent = 'View receipt';
                    view.addEventListener('click', (e)=>{ e.preventDefault(); e.stopPropagation(); if(typeof showReceipt === 'function') showReceipt(tx.id);});

                    // status badge
                    const status = (tx.status || 'completed');
                    const statusEl = document.createElement('span');
                    statusEl.className = 'tx-status ' + status;
                    statusEl.innerText = status.charAt(0).toUpperCase() + status.slice(1);

                    // quick-preview element (hidden by default)
                    const preview = document.createElement('div');
                    preview.className = 'tx-preview';
                    preview.style.display = 'none';
                    preview.innerHTML = `
                        <div class="row"><div><strong>Reference</strong></div><div>${escapeHtml(tx.id||'')}</div></div>
                        <div class="row"><div><strong>Account</strong></div><div>${escapeHtml(tx.user||'')}</div></div>
                        <div class="row"><div><strong>Details</strong></div><div>${escapeHtml(tx.counterparty||tx.recipient||tx.service||tx.biller||'—')}</div></div>
                        <div class="row"><div><strong>Amount</strong></div><div>₦${Number(tx.amount||0).toLocaleString()}</div></div>
                    `;

                    // assemble
                    card.appendChild(icon);
                    card.appendChild(content);
                    const right = document.createElement('div');
                    right.style.display='flex';
                    right.style.flexDirection='column';
                    right.style.alignItems='flex-end';
                    right.appendChild(amt);
                    right.appendChild(view);
                    right.appendChild(statusEl);
                    card.appendChild(right);
                    card.appendChild(preview);

                    // toggle preview on card click (ignore clicks on links)
                    card.addEventListener('click', ()=>{
                        const open = preview.style.display === 'block';
                        // close any other open preview in container
                        const others = container.querySelectorAll('.tx-preview');
                        others.forEach(p => { if (p !== preview) p.style.display = 'none'; });
                        preview.style.display = open ? 'none' : 'block';
                    });

                    container.appendChild(card);
                });
                // draw sparkline for recent history
                try { drawSparkline('recentSparkline', recent); } catch(e){}
            }catch(err){
                console.error('renderRecentActivity error',err);
            }
        };

        // Render full history with filtering: 'all' | 'debits' | 'credits' | 'loans'
        // Accepts optional third param opts = { q: 'search string' }
        window.renderHistory = function(filter, containerEl, opts){
            try{
                const container = containerEl || document.getElementById('historyList');
                if(!container) return;
                // pagination state
                window._historyPager = window._historyPager || { page: 1, pageSize: 8 };
                // if filter changed or new search, reset page
                if (!window._historyPager.lastFilter || window._historyPager.lastFilter !== filter || (opts && opts.q !== window._historyPager.lastQuery)) {
                    window._historyPager.page = 1;
                    window._historyPager.lastFilter = filter;
                    window._historyPager.lastQuery = opts && opts.q ? opts.q : '';
                }
                const page = window._historyPager.page || 1;
                const pageSize = window._historyPager.pageSize || 8;

                const currentUser = localStorage.getItem('loggedInUser') || 'guest';
                const history = JSON.parse(localStorage.getItem('history')||'[]');
                const loans = JSON.parse(localStorage.getItem('loanRequests')||'[]');
                const merged = history.concat(loans).slice().sort((a,b)=>new Date(b.time)-new Date(a.time));

                // compute counts for filter badges
                const totalAll = merged.length;
                const totalLoans = merged.filter(it => String(it.id||'').startsWith('loan_')).length;
                const totalDebits = merged.filter(it => (it.user === currentUser) && !String(it.id||'').startsWith('loan_')).length;
                const totalCredits = merged.filter(it => (it.user !== currentUser) && !String(it.id||'').startsWith('loan_')).length;
                // update UI counts if present
                try { document.getElementById('count_all') && (document.getElementById('count_all').innerText = totalAll); } catch(e){}
                try { document.getElementById('count_loans') && (document.getElementById('count_loans').innerText = totalLoans); } catch(e){}
                try { document.getElementById('count_debits') && (document.getElementById('count_debits').innerText = totalDebits); } catch(e){}
                try { document.getElementById('count_credits') && (document.getElementById('count_credits').innerText = totalCredits); } catch(e){}

                const f = (filter||'all').toLowerCase();
                const q = (opts && opts.q) ? String(opts.q).toLowerCase().trim() : '';
                const filtered = merged.filter(it => {
                    if (f === 'all') return true;
                    if (f === 'loans') return String(it.id||'').startsWith('loan_');
                    const isDebit = (it.user === currentUser);
                    if (f === 'debits') return isDebit && !String(it.id||'').startsWith('loan_');
                    if (f === 'credits') return !isDebit && !String(it.id||'').startsWith('loan_');
                    return true;
                });

                // apply search query if present
                let finalFiltered = filtered;
                if (q) {
                    finalFiltered = filtered.filter(tx => {
                        const hay = [tx.id, tx.biller, tx.networkName, tx.plan, tx.phone, tx.ref, tx.user, tx.counterparty, tx.recipient, tx.service, tx.type].map(x=> (x||'')).join(' ').toLowerCase();
                        return hay.indexOf(q) !== -1;
                    });
                }

                // pagination slice
                const start = (page-1)*pageSize;
                const pageItems = (finalFiltered || filtered).slice(start, start + pageSize);

                container.innerHTML = '';
                if (!pageItems.length) {
                    if (page === 1) container.innerHTML = '<div class="tx-card centered"><div class="tx-content"><div class="tx-title">No transactions</div><div class="tx-sub">No records match this filter.</div></div></div>';
                    // hide load more
                    document.getElementById('loadMoreHistory') && (document.getElementById('loadMoreHistory').style.display = 'none');
                    return;
                }

                pageItems.forEach((tx, idx)=>{
                    const card = document.createElement('div');
                    card.className = 'tx-card';
                    card.style.animationDelay = (idx*40)+'ms';
                    const icon = document.createElement('div');
                    icon.className = 'tx-icon';
                    let emoji = '💸';
                    if(tx.type && tx.type.toLowerCase().includes('airtime')) emoji = '📱';
                    else if(tx.type && tx.type.toLowerCase().includes('data')) emoji = '🌐';
                    else if(tx.type && tx.type.toLowerCase().includes('bill')) emoji = '🧾';
                    else if(tx.type && tx.type.toLowerCase().includes('loan')) emoji = '🏦';
                    else if(tx.type && tx.type.toLowerCase().includes('transfer')) emoji = '➡️';
                    icon.textContent = emoji;
                    // small left-side status indicator
                    const indicator = document.createElement('span');
                    const st = (tx.status || (String(tx.id||'').startsWith('loan_') ? 'pending' : 'completed'));
                    indicator.className = 'tx-indicator ' + st;
                    icon.appendChild(indicator);

                    const content = document.createElement('div');
                    content.className = 'tx-content';
                    const title = document.createElement('div');
                    title.className = 'tx-title';
                    let label = (tx.type ? tx.type : 'Transaction');
                    if (String(tx.id||'').startsWith('loan_')) label = 'Loan Request';
                    title.textContent = `${label} • ${tx.counterparty||tx.recipient||tx.service||tx.biller||'—'}`;
                    const sub = document.createElement('div');
                    sub.className = 'tx-sub';
                    sub.textContent = new Date(tx.time||Date.now()).toLocaleString();
                    content.appendChild(title);
                    content.appendChild(sub);

                    const amt = document.createElement('div');
                    amt.className = 'tx-amount';
                    const isDebit = (tx.user === currentUser);
                    if (String(tx.id||'').startsWith('loan_')) {
                        amt.textContent = '₦' + Number(tx.amount||0).toLocaleString();
                    } else {
                        amt.textContent = (tx.amount? ('₦'+Number(tx.amount).toLocaleString()): '₦0.00');
                        amt.classList.add(isDebit ? 'debit' : 'credit');
                    }

                    const view = document.createElement('a');
                    view.href = '#';
                    view.className = 'small-link tx-badge';
                    view.textContent = 'View receipt';
                    view.addEventListener('click', (e)=>{ e.preventDefault(); e.stopPropagation(); if(typeof showReceipt === 'function') showReceipt(tx.id); });

                    // status badge
                    const status = (tx.status || (String(tx.id||'').startsWith('loan_') ? 'pending' : 'completed'));
                    const statusEl = document.createElement('span');
                    statusEl.className = 'tx-status ' + status;
                    statusEl.innerText = status.charAt(0).toUpperCase() + status.slice(1);

                    // preview panel
                    const preview = document.createElement('div');
                    preview.className = 'tx-preview';
                    preview.style.display = 'none';
                    preview.innerHTML = `
                        <div class="row"><div><strong>Reference</strong></div><div>${escapeHtml(tx.id||'')}</div></div>
                        <div class="row"><div><strong>Account</strong></div><div>${escapeHtml(tx.user||'')}</div></div>
                        <div class="row"><div><strong>Details</strong></div><div>${escapeHtml(tx.counterparty||tx.recipient||tx.service||tx.biller||'—')}</div></div>
                        <div class="row"><div><strong>Amount</strong></div><div>₦${Number(tx.amount||0).toLocaleString()}</div></div>
                    `;

                    card.appendChild(icon);
                    card.appendChild(content);
                    const right = document.createElement('div');
                    right.style.display='flex';
                    right.style.flexDirection='column';
                    right.style.alignItems='flex-end';
                    right.appendChild(amt);
                    right.appendChild(view);
                    right.appendChild(statusEl);
                    card.appendChild(right);
                    card.appendChild(preview);

                    // click toggles preview
                    card.addEventListener('click', ()=>{
                        const open = preview.style.display === 'block';
                        // close other previews
                        const others = container.querySelectorAll('.tx-preview');
                        others.forEach(p => { if (p !== preview) p.style.display = 'none'; });
                        preview.style.display = open ? 'none' : 'block';
                    });

                    container.appendChild(card);
                });

                // show or hide Load More button
                const loadBtn = document.getElementById('loadMoreHistory');
                if (loadBtn) {
                    if ((start + pageSize) < (finalFiltered || filtered).length) {
                        loadBtn.style.display = 'block';
                    } else {
                        loadBtn.style.display = 'none';
                    }
                }

            }catch(e){ console.error('renderHistory error', e); }
        };

        // Populate dashboard-specific elements (avatar, name, account, balance)
        function populateDashboard(){
            try{
                const user = localStorage.getItem('loggedInUser') || '';
                if (!user) return;
                const profile = getProfile(user) || {};
                const avatar = document.getElementById('dashAvatar');
                if (avatar) {
                    if (profile && profile.avatar) { avatar.src = profile.avatar; avatar.style.display = 'block'; }
                    else { avatar.style.display = 'none'; }
                }
                const name = document.getElementById('dashName'); if (name) name.innerText = (profile && profile.displayName) ? profile.displayName : user;
                const acct = document.getElementById('dashAccount'); if (acct) {
                    const acctNum = (profile && profile.accountNumber) || (JSON.parse(localStorage.getItem('bt_users')||'{}')[user]||{}).accountNumber || '';
                    acct.innerText = acctNum ? ('Acct: ' + acctNum) : 'Acct: —';
                }
                // compute derived balance from history if a display override isn't set
                const balEl = document.getElementById('dashBalance'); if (balEl) {
                    const prefs = JSON.parse(localStorage.getItem('bt_prefs')||'{}');
                    const hidden = prefs[user] && prefs[user].hideBalance;
                    const override = window._bt_balance_display;
                    const computed = computeDerivedBalance(user);
                    const displayVal = override ? override : (`₦${Number(computed).toLocaleString()}`);
                    balEl.innerText = hidden ? '••••••' : displayVal;
                }
                const btn = document.getElementById('btnToggleBalance'); if (btn) {
                    const prefs = JSON.parse(localStorage.getItem('bt_prefs')||'{}');
                    const hidden = prefs[user] && prefs[user].hideBalance;
                    btn.innerText = hidden ? 'Show' : 'Hide';
                    btn.onclick = () => { toggleBalance(); populateDashboard(); };
                }
                // refresh recent activity
                if (window.renderRecentActivity) window.renderRecentActivity();
                // update breakdown UI if present
                try {
                    const breakdown = window._dash_balance_breakdown || { credits:0, debits:0, net:0 };
                    const cEl = document.getElementById('dashCredits'); if (cEl) cEl.innerText = '₦' + Number(breakdown.credits||0).toLocaleString();
                    const dEl = document.getElementById('dashDebits'); if (dEl) dEl.innerText = '₦' + Number(breakdown.debits||0).toLocaleString();
                    const nEl = document.getElementById('dashNet'); if (nEl) nEl.innerText = '₦' + Number(breakdown.net||0).toLocaleString();
                } catch(e){}
            }catch(e){ console.error('populateDashboard', e); }
        }

            // Render fraud review queue: lists transactions flaggedForReview in local history
            window.renderFraudReviewQueue = function(){
                try{
                    const container = document.getElementById('fraudReviewQueue');
                    if (!container) return;
                    const history = JSON.parse(localStorage.getItem('history')||'[]');
                    // flagged items may have flaggedForReview true or status 'pending_review'
                    const flagged = history.filter(h => h.flaggedForReview || h.status === 'pending_review' || h.flagged === true);
                    container.innerHTML = '';
                    if (!flagged || !flagged.length){
                        container.innerHTML = '<div class="small-link">No items flagged for review.</div>';
                        return;
                    }
                    flagged.sort((a,b)=> (b.time||0) - (a.time||0));
                    flagged.forEach(tx => {
                        const el = document.createElement('div'); el.className = 'tx-card'; el.style.display='flex'; el.style.justifyContent='space-between'; el.style.alignItems='center'; el.style.marginBottom='8px';
                        const left = document.createElement('div'); left.style.flex='1'; left.innerHTML = `<div style="font-weight:800">${escapeHtml(tx.type||'Transaction')} • ${escapeHtml(tx.counterparty||tx.recipient||tx.service||tx.biller||'—')}</div><div style="color:var(--muted);font-size:0.9rem">${new Date(tx.time||Date.now()).toLocaleString()}</div>`;
                        const right = document.createElement('div'); right.style.display='flex'; right.style.gap='8px'; right.style.alignItems='center';
                        const amount = document.createElement('div'); amount.style.fontWeight='800'; amount.innerText = '₦' + Number(tx.amount||0).toLocaleString();
                        const btnApprove = document.createElement('button'); btnApprove.className='btn-ghost'; btnApprove.innerText='Approve'; btnApprove.addEventListener('click', async ()=>{ await approveFlaggedTx(tx.id); renderAll(); });
                        const btnReject = document.createElement('button'); btnReject.className='btn-ghost'; btnReject.innerText='Reject'; btnReject.addEventListener('click', async ()=>{ await rejectFlaggedTx(tx.id); renderAll(); });
                        const reasons = document.createElement('div'); reasons.style.fontSize='0.85rem'; reasons.style.color='var(--muted)'; reasons.innerText = (tx.fraudReasons && tx.fraudReasons.join(', ')) || (tx.reasons && tx.reasons.join(', ')) || '';
                        right.appendChild(amount); right.appendChild(btnApprove); right.appendChild(btnReject);
                        el.appendChild(left); el.appendChild(right);
                        if (reasons && reasons.innerText) { const rdiv = document.createElement('div'); rdiv.style.marginTop='6px'; rdiv.appendChild(reasons); el.appendChild(rdiv); }
                        container.appendChild(el);
                    });
                }catch(e){ console.error('renderFraudReviewQueue failed', e); }
            };

            // Approve a flagged transaction: attempt to call server /process-tx if configured, else mark completed locally
            async function approveFlaggedTx(txId){
                try{
                    const history = JSON.parse(localStorage.getItem('history')||'[]');
                    const idx = history.findIndex(h=>h.id === txId);
                    if (idx === -1) return false;
                    const tx = history[idx];
                    // call server if endpoint exists
                    const ep = (localStorage.getItem('bt_api_endpoint') || window.BT_API_ENDPOINT || '').replace(/\/$/, '');
                    const token = localStorage.getItem('bt_api_token') || window.BT_API_TOKEN || null;
                    if (ep){
                        try{
                            const res = await fetch(ep + '/process-tx', { method: 'POST', headers: Object.assign({'Content-Type':'application/json'}, token?{'Authorization':'Bearer '+token}:{}), body: JSON.stringify(tx), credentials: 'include' });
                            const j = await res.json().catch(()=>null);
                            if (res.ok && j && (j.status === 'success' || j.status === 'completed')){
                                history[idx].status = 'completed'; history[idx].serverRef = j.ref || j.transactionRef || null; delete history[idx].flaggedForReview; localStorage.setItem('history', JSON.stringify(history)); window.showToast && window.showToast('Transaction approved and processed','success'); return true;
                            }
                            if (j && j.status === 'pending'){ history[idx].status = 'pending'; history[idx].serverRef = j.ref || j.transactionRef || null; localStorage.setItem('history', JSON.stringify(history)); window.showToast && window.showToast('Transaction approved and queued (pending)','info'); return true; }
                        }catch(e){ console.warn('Server process failed', e); }
                    }
                    // fallback: mark completed locally
                    history[idx].status = 'completed'; delete history[idx].flaggedForReview; localStorage.setItem('history', JSON.stringify(history)); window.showToast && window.showToast('Transaction approved locally','success'); return true;
                }catch(e){ console.error('approveFlaggedTx', e); return false; }
            }

            // Reject a flagged transaction: mark failed with optional reason
            async function rejectFlaggedTx(txId){
                try{
                    const history = JSON.parse(localStorage.getItem('history')||'[]');
                    const idx = history.findIndex(h=>h.id === txId);
                    if (idx === -1) return false;
                    history[idx].status = 'failed'; history[idx].serverError = 'rejected_by_review'; delete history[idx].flaggedForReview; localStorage.setItem('history', JSON.stringify(history)); window.showToast && window.showToast('Transaction rejected','danger'); return true;
                }catch(e){ console.error('rejectFlaggedTx', e); return false; }
            }

            // helper to re-render both history and review queue
            function renderAll(){ if (window.renderHistory) window.renderHistory(document.querySelector('.filter-btn.active')?.getAttribute('data-filter') || 'all'); if (window.renderFraudReviewQueue) window.renderFraudReviewQueue(); if (window.renderRecentActivity) window.renderRecentActivity(); }

            // wire refresh link on dashboard
            document.addEventListener('DOMContentLoaded', ()=>{
                const r = document.getElementById('refreshReviewQueue'); if (r) r.addEventListener('click',(e)=>{ e.preventDefault(); renderAll(); });
                // initial render of review queue when dashboard loads
                try{ if (document.body && document.body.contains(document.getElementById('fraudReviewQueue'))) renderFraudReviewQueue(); }catch(e){}
            });

        // Compute a derived balance for a given user from settled transactions
        function computeDerivedBalance(user){
            try{
                user = user || localStorage.getItem('loggedInUser') || 'guest';
                const history = JSON.parse(localStorage.getItem('history')||'[]');
                // consider only settled transactions (success/completed)
                const settled = history.filter(t => (t.status || 'completed') === 'success' || (t.status || 'completed') === 'completed');
                let credits = 0; let debits = 0;
                settled.forEach(t => {
                    // skip loans as they are not part of wallet balance for now
                    if (String(t.id||'').startsWith('loan_')) return;
                    const amt = Number(t.total || t.amount || 0) || 0;
                    if (t.user === user) {
                        // user's outgoing (debit)
                        debits += amt;
                    } else {
                        // incoming (credit)
                        credits += amt;
                    }
                });
                const net = Math.round(credits - debits);
                // store a small cache for UI rendering
                window._dash_balance_breakdown = { credits: Math.round(credits), debits: Math.round(debits), net };
                return net;
            }catch(e){ console.error('computeDerivedBalance', e); return 0; }
        }

        // Draw a small HiDPI-aware sparkline on the recent activity canvas
        function drawSparkline(canvasId, txList){
            try{
                const c = document.getElementById(canvasId);
                if (!c || !c.getContext) return;
                const ctx = c.getContext('2d');
                // size canvas for devicePixelRatio to keep lines crisp
                const rect = c.getBoundingClientRect();
                const ratio = window.devicePixelRatio || 1;
                c.width = Math.max(1, Math.floor(rect.width * ratio));
                c.height = Math.max(1, Math.floor(rect.height * ratio));
                // use CSS pixel sizes for drawing coordinates
                const w = rect.width; const h = rect.height;
                ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
                ctx.clearRect(0,0,w,h);

                // prepare values (last 12 settled tx amounts, signed: credit positive, debit negative)
                const user = localStorage.getItem('loggedInUser') || 'guest';
                const recent = (txList || JSON.parse(localStorage.getItem('history')||'[]')).slice().sort((a,b)=>new Date(a.time)-new Date(b.time)).slice(-12);
                if (!recent.length) return;
                const vals = recent.map(t => {
                    if (String(t.id||'').startsWith('loan_')) return 0;
                    const amt = Number(t.total || t.amount || 0) || 0;
                    return (t.user === user) ? -amt : amt;
                });
                // normalize to canvas (CSS pixels)
                const max = Math.max(...vals.map(Math.abs)) || 1;
                const pad = 6; const usableH = h - pad*2; const usableW = w - pad*2;
                ctx.lineWidth = 2;
                // draw baseline
                ctx.strokeStyle = 'rgba(255,255,255,0.06)';
                ctx.beginPath(); ctx.moveTo(pad, h/2); ctx.lineTo(w-pad, h/2); ctx.stroke();
                // line path
                ctx.beginPath();
                vals.forEach((v,i)=>{
                    const x = pad + (i/(Math.max(1, vals.length-1))) * usableW;
                    const y = h/2 - (v/max) * (usableH/2);
                    if (i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
                });
                ctx.strokeStyle = 'rgba(0,102,255,0.9)';
                ctx.stroke();
                // fill area
                ctx.lineTo(w-pad, h/2); ctx.lineTo(pad, h/2); ctx.closePath();
                ctx.fillStyle = 'rgba(0,102,255,0.14)';
                ctx.fill();
                // draw small circles
                vals.forEach((v,i)=>{
                    const x = pad + (i/(Math.max(1, vals.length-1))) * usableW;
                    const y = h/2 - (v/max) * (usableH/2);
                    ctx.beginPath(); ctx.arc(x,y,3,0,Math.PI*2); ctx.fillStyle = v < 0 ? '#e04b4b' : '#19b456'; ctx.fill();
                });
                // reset transform for safety
                ctx.setTransform(1,0,0,1,0,0);
            }catch(e){ console.error('drawSparkline', e); }
        }

        // Export filtered history to CSV
        window.exportHistoryCSV = function(filter, opts){
            try{
                const currentUser = localStorage.getItem('loggedInUser') || 'guest';
                const history = JSON.parse(localStorage.getItem('history')||'[]');
                const loans = JSON.parse(localStorage.getItem('loanRequests')||'[]');
                const merged = history.concat(loans).slice().sort((a,b)=>new Date(b.time)-new Date(a.time));
                const f = (filter||'all').toLowerCase();
                const q = (opts && opts.q) ? String(opts.q).toLowerCase().trim() : '';
                const filtered = merged.filter(it => {
                    if (f === 'all') return true;
                    if (f === 'loans') return String(it.id||'').startsWith('loan_');
                    const isDebit = (it.user === currentUser);
                    if (f === 'debits') return isDebit && !String(it.id||'').startsWith('loan_');
                    if (f === 'credits') return !isDebit && !String(it.id||'').startsWith('loan_');
                    return true;
                });
                let finalFiltered = filtered;
                if (q) {
                    finalFiltered = filtered.filter(tx => {
                        const hay = [tx.id, tx.biller, tx.networkName, tx.plan, tx.phone, tx.ref, tx.user, tx.counterparty, tx.recipient, tx.service, tx.type].map(x=> (x||'')).join(' ').toLowerCase();
                        return hay.indexOf(q) !== -1;
                    });
                }
                const rows = finalFiltered.map(tx => ({
                    id: tx.id || '', user: tx.user || '', type: tx.type || '', time: new Date(tx.time||0).toISOString(), amount: tx.amount||0, fee: tx.fee||'', total: tx.total||'', status: tx.status||'', network: tx.networkName||'', biller: tx.biller||'', phone: tx.phone||'', ref: tx.ref||'', plan: tx.plan||''
                }));
                if (!rows.length) { showToast('No transactions to export','info'); return; }
                const keys = Object.keys(rows[0]);
                const csv = [keys.join(',')].concat(rows.map(r => keys.map(k=>('"'+String(r[k]||'').replace(/"/g,'""')+'"')).join(','))).join('\n');
                const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `fast_reliable_history_${new Date().toISOString().slice(0,10)}.csv`;
                document.body.appendChild(a);
                a.click();
                a.remove();
                URL.revokeObjectURL(url);
            }catch(e){ console.error('exportHistoryCSV', e); showToast('Export failed','danger'); }
        };

        // small helper to trigger search from UI
        window.searchHistory = function(q){
            const active = document.querySelector('.filter-btn.active');
            const f = active ? active.getAttribute('data-filter') : 'all';
            if (window.renderHistory) window.renderHistory(f, null, { q: q || '' });
        };

        // make populateDashboard available
        window.populateDashboard = populateDashboard;

                // Settings modal: configure BT_API_ENDPOINT and BT_API_TOKEN via UI
                function _createSettingsModalIfNeeded(){
                        if (document.getElementById('btSettingsModal')) return;
                        const modal = document.createElement('div');
                        modal.id = 'btSettingsModal';
                        modal.className = 'confirm-modal';
                        modal.style.display = 'none';
                        modal.innerHTML = `
                            <div class="confirm-card">
                                <header class="confirm-header"><strong>Dashboard Settings</strong><div><button id="btSettingsClose">✖</button></div></header>
                                <div class="confirm-body">
                                    <div style="display:flex;flex-direction:column;gap:8px">
                                        <label>API Endpoint (POST)</label>
                                        <input id="bt_api_endpoint_input" placeholder="https://example.com/process-tx" />
                                        <label>API Token (optional)</label>
                                        <input id="bt_api_token_input" placeholder="Bearer token" />
                                        <label class="toggle"><input type="checkbox" id="bt_use_override_balance" /> <span class="toggle-track" aria-hidden="true"></span><span class="label-text">Use manual balance override (instead of computed)</span></label>
                                        <label>Manual balance display (e.g., ₦250,000)</label>
                                        <input id="bt_balance_override_input" placeholder="₦0.00" />
                                    </div>
                                </div>
                                <div class="confirm-actions"><button id="btSettingsCancel" class="btn-ghost">Cancel</button><button id="btSettingsSave" class="primary">Save</button></div>
                            </div>
                        `;
                        document.body.appendChild(modal);
                        modal.querySelector('#btSettingsClose').addEventListener('click', ()=> modal.style.display = 'none');
                        modal.querySelector('#btSettingsCancel').addEventListener('click', ()=> modal.style.display = 'none');
                        modal.querySelector('#btSettingsSave').addEventListener('click', ()=>{
                                const ep = document.getElementById('bt_api_endpoint_input')?.value || '';
                                const tok = document.getElementById('bt_api_token_input')?.value || '';
                                const useOverride = document.getElementById('bt_use_override_balance')?.checked;
                                const balVal = document.getElementById('bt_balance_override_input')?.value || '';
                                if (ep) { localStorage.setItem('bt_api_endpoint', ep); window.BT_API_ENDPOINT = ep; }
                                else { localStorage.removeItem('bt_api_endpoint'); window.BT_API_ENDPOINT = null; }
                                if (tok) { localStorage.setItem('bt_api_token', tok); window.BT_API_TOKEN = tok; }
                                else { localStorage.removeItem('bt_api_token'); window.BT_API_TOKEN = null; }
                                const prefs = JSON.parse(localStorage.getItem('bt_prefs')||'{}');
                                const user = localStorage.getItem('loggedInUser') || '';
                                prefs[user] = prefs[user] || {};
                                prefs[user].useBalanceOverride = !!useOverride;
                                localStorage.setItem('bt_prefs', JSON.stringify(prefs));
                                if (useOverride && balVal) { window._bt_balance_display = balVal; } else { window._bt_balance_display = null; }
                                populateDashboard();
                                modal.style.display = 'none';
                                showToast('Settings saved', 'success');
                        });
                }
                window._createSettingsModalIfNeeded = _createSettingsModalIfNeeded;

    // Group settings modal: allows editing of approvalThreshold, payoutApprovalRequired, and escrow toggle
    function _createGroupSettingsModalIfNeeded(){
        if (document.getElementById('groupSettingsModal')) return;
        const modal = document.createElement('div'); modal.id = 'groupSettingsModal'; modal.className = 'confirm-modal'; modal.style.display = 'none';
        modal.innerHTML = `
            <div class="confirm-card">
                <header class="confirm-header"><strong>Group Settings</strong><div><button id="groupSettingsClose">✖</button></div></header>
                <div class="confirm-body">
                    <div style="display:flex;flex-direction:column;gap:10px">
                        <div class="row"><label>Require payout approvals</label><input type="checkbox" id="gs_approval_required" /></div>
                        <div class="row"><label>Approval threshold (fraction or 0-1)</label><input id="gs_threshold" type="number" min="0" max="1" step="0.01" /></div>
                        <div class="row"><label>Enable escrow (hold group funds)</label><input type="checkbox" id="gs_escrow_enabled" /></div>
                        <div class="row"><label>Initial escrow top-up (optional)</label><input id="gs_escrow_topup" type="number" min="0" step="1" placeholder="0" /></div>
                        <div id="gs_msg" class="small-link" style="color:var(--muted)"></div>
                    </div>
                </div>
                <div class="confirm-actions"><button id="groupSettingsCancel" class="btn-ghost">Cancel</button><button id="groupSettingsSave" class="primary">Save</button></div>
            </div>
        `;
        document.body.appendChild(modal);
        modal.querySelector('#groupSettingsClose')?.addEventListener('click', ()=> modal.style.display = 'none');
        modal.querySelector('#groupSettingsCancel')?.addEventListener('click', ()=> modal.style.display = 'none');
    }

    window.openGroupSettingsModal = async function(groupId){
        try{
            if (!groupId) throw new Error('Missing group id');
            _createGroupSettingsModalIfNeeded();
            const modal = document.getElementById('groupSettingsModal'); if (!modal) throw new Error('Modal init failed');
            const groups = JSON.parse(localStorage.getItem('esusu_groups')||'{}'); const g = groups[groupId]; if (!g) { window.showToast && window.showToast('Group not found','info'); return; }
            const req = modal.querySelector('#gs_approval_required'); const thr = modal.querySelector('#gs_threshold'); const esc = modal.querySelector('#gs_escrow_enabled'); const topup = modal.querySelector('#gs_escrow_topup'); const msg = modal.querySelector('#gs_msg');
            // populate
            req.checked = !!(g.settings && g.settings.payoutApprovalRequired);
            thr.value = (g.settings && g.settings.approvalThreshold != null) ? Number(g.settings.approvalThreshold) : 0.51;
            esc.checked = !!g.settings && !!g.settings.escrowEnabled;
            topup.value = '';
            msg.innerText = `Admin: ${g.adminUser} • Members: ${g.members ? g.members.length : 0}`;
            modal.style.display = 'flex';
            // save handler
            modal.querySelector('#groupSettingsSave').onclick = function(){
                try{
                    const groupsNow = JSON.parse(localStorage.getItem('esusu_groups')||'{}');
                    const grp = groupsNow[groupId]; if (!grp) throw new Error('Group not found');
                    grp.settings = grp.settings || {};
                    grp.settings.payoutApprovalRequired = !!req.checked;
                    const parsed = Number(thr.value);
                    grp.settings.approvalThreshold = (!isNaN(parsed) && parsed > 0 && parsed <= 1) ? parsed : 0.51;
                    grp.settings.escrowEnabled = !!esc.checked;
                    groupsNow[groupId] = grp;
                    localStorage.setItem('esusu_groups', JSON.stringify(groupsNow));
                    // optional escrow top-up
                    const up = Number(topup.value) || 0; if (up > 0){ const all = JSON.parse(localStorage.getItem('esusu_groups')||'{}'); all[groupId].escrow = (Number(all[groupId].escrow)||0) + up; localStorage.setItem('esusu_groups', JSON.stringify(all)); }
                    modal.style.display = 'none';
                    if (window.showToast) window.showToast('Group settings saved', 'success');
                    // re-render group page if present
                    try{ if (typeof render === 'function') render(); }catch(e){}
                }catch(err){ if (window.showToast) window.showToast(String(err),'danger'); }
            };
        }catch(e){ if (window.showToast) window.showToast(String(e),'danger'); }
    };

    /*
      Esusu (daily savings group) lightweight client-side module (localStorage-backed)
      - Groups stored at localStorage key: esusu_groups (object by id)
      - Contributions at esusu_contributions (array)
      - Payouts at esusu_payouts (array)
      - Wallet balances stored in bt_profiles[user].wallet (number in kobo) for simplicity
      Note: amounts handled in NGN (integers or floats) for demo; production should use integer minor units.
    */
    (function esusuModule(){
        const GROUPS_KEY = 'esusu_groups';
        const CONTRIBUTIONS_KEY = 'esusu_contributions';
        const PAYOUTS_KEY = 'esusu_payouts';
        const MAX_PARTICIPANTS = 20;
        const WEEKLY_CAP = 2000000; // NGN

        function _loadGroups(){ try { return JSON.parse(localStorage.getItem(GROUPS_KEY) || '{}'); } catch(e){ return {}; } }
        function _saveGroups(obj){ localStorage.setItem(GROUPS_KEY, JSON.stringify(obj)); }
        function _loadContribs(){ try { return JSON.parse(localStorage.getItem(CONTRIBUTIONS_KEY) || '[]'); } catch(e){ return []; } }
        function _saveContribs(arr){ localStorage.setItem(CONTRIBUTIONS_KEY, JSON.stringify(arr)); }
        function _loadPayouts(){ try { return JSON.parse(localStorage.getItem(PAYOUTS_KEY) || '[]'); } catch(e){ return []; } }
        function _savePayouts(arr){ localStorage.setItem(PAYOUTS_KEY, JSON.stringify(arr)); }

        function _nowDateStr(){ const d = new Date(); return d.toISOString().slice(0,10); }

        function createGroup({ name, contributionAmount, startDate, adminUser }){
            const groups = _loadGroups();
            const id = 'g_' + Date.now() + '_' + Math.random().toString(36).slice(2,6);
            const g = {
                id, name: name || ('Group ' + id), contributionAmount: Number(contributionAmount) || 0,
                startDate: startDate || _nowDateStr(), adminUser: adminUser || localStorage.getItem('loggedInUser') || 'admin',
                members: [], settings: { frequency: 'daily', maxWeeklyTotal: WEEKLY_CAP }, created_at: Date.now()
            };
            // add admin as first member (track last_seen for presence)
            g.members.push({ userId: g.adminUser, joined_at: Date.now(), orderIndex: 0, last_seen: Date.now() });
            groups[id] = g;
            _saveGroups(groups);
            return g;
        }

        function listGroups(){ return Object.values(_loadGroups()); }
        function getGroup(id){ const g = _loadGroups(); return g[id] || null; }

        function _getProfiles(){ try { return JSON.parse(localStorage.getItem('bt_profiles')||'{}'); } catch(e){ return {}; } }
        function _saveProfiles(p){ localStorage.setItem('bt_profiles', JSON.stringify(p)); }

        function topUpWallet(user, amount){ // amount in NGN
            const p = _getProfiles(); p[user] = p[user] || {}; p[user].wallet = (Number(p[user].wallet)||0) + Number(amount);
            _saveProfiles(p); return p[user].wallet;
        }
        function getWallet(user){ const p = _getProfiles(); return (p[user] && Number(p[user].wallet)) || 0; }

        // Withdraw from user's wallet: debits balance, records history and optionally notifies configured API endpoint.
        async function withdrawFromWallet(user, amount, opts){
            opts = opts || {};
            const p = _getProfiles(); p[user] = p[user] || {}; const bal = Number(p[user].wallet) || 0;
            amount = Number(amount) || 0;
            if (amount <= 0) return { success: false, error: 'invalid_amount' };
            if (bal < amount) return { success: false, error: 'insufficient_balance' };
            // debit locally
            p[user].wallet = bal - amount; _saveProfiles(p);
            // create history entry
            let tx = { id: 'wd_' + Date.now() + '_' + Math.random().toString(36).slice(2,6), user, type: 'withdraw', amount: amount, time: Date.now(), status: 'completed', dest: opts.dest || '' };
            try{ const history = JSON.parse(localStorage.getItem('history')||'[]'); history.push(tx); localStorage.setItem('history', JSON.stringify(history)); }catch(e){}

            // if a server endpoint is configured, attempt to notify/back the withdrawal (best-effort)
            const ep = localStorage.getItem('bt_api_endpoint') || window.BT_API_ENDPOINT || null;
            const token = localStorage.getItem('bt_api_token') || window.BT_API_TOKEN || null;
            if (ep){
                try{
                    // run local client-side fraud heuristics and optionally call server-side assessor
                    try{
                        if (window.fraud && typeof window.fraud.assessTransaction === 'function'){
                            const fraudRes = await window.fraud.assessTransaction(Object.assign({}, tx, { dest: opts.dest || null }));
                            if (fraudRes && typeof fraudRes.score === 'number'){
                                // Block high-risk transactions
                                if (fraudRes.score >= 75){
                                    // persist history as failed due to fraud
                                    try{ const history = JSON.parse(localStorage.getItem('history')||'[]'); const idx = history.findIndex(h=>h.id===tx.id); if (idx!==-1){ history[idx].status = 'failed'; history[idx].reason = 'fraud_suspected'; history[idx].fraudScore = fraudRes.score; history[idx].fraudReasons = fraudRes.reasons; localStorage.setItem('history', JSON.stringify(history)); } }catch(e){}
                                    if (loader) loader.style.display = 'none';
                                    return { success: false, error: 'fraud_suspected', score: fraudRes.score, reasons: fraudRes.reasons };
                                }
                                // For medium risk, mark pending/review
                                if (fraudRes.score >= 50){
                                    tx.flaggedForReview = true;
                                }
                            }
                        }
                    }catch(e){ console.warn('Fraud assessor failed', e); }
                    const url = (ep||'').replace(/\/$/, '') + '/process-tx';
                    const controller = new AbortController(); const timeout = setTimeout(()=>controller.abort(), 12000);
                    const res = await fetch(url, { method: 'POST', headers: Object.assign({'Content-Type':'application/json'}, token?{'Authorization':'Bearer '+token}:{}), body: JSON.stringify({ id: tx.id, user: user, amount: amount, type: 'withdraw', dest: opts.dest || null }), signal: controller.signal });
                    clearTimeout(timeout);
                    const j = await res.json().catch(()=>null);
                    if (j && (j.status === 'success' || j.status === 'completed')){
                        // update history status
                        try{ const history = JSON.parse(localStorage.getItem('history')||'[]'); const idx = history.findIndex(h=>h.id===tx.id); if (idx!==-1){ history[idx].status = 'completed'; history[idx].serverRef = j.ref || j.transactionRef || null; localStorage.setItem('history', JSON.stringify(history)); } }catch(e){}
                        return { success: true, server: j };
                    } else if (j && j.status === 'pending'){
                        try{ const history = JSON.parse(localStorage.getItem('history')||'[]'); const idx = history.findIndex(h=>h.id===tx.id); if (idx!==-1){ history[idx].status = 'pending'; localStorage.setItem('history', JSON.stringify(history)); } }catch(e){}
                        return { success: true, server: j };
                    } else {
                        try{ const history = JSON.parse(localStorage.getItem('history')||'[]'); const idx = history.findIndex(h=>h.id===tx.id); if (idx!==-1){ history[idx].status = 'failed'; history[idx].serverError = j && j.error ? j.error : 'server-failed'; localStorage.setItem('history', JSON.stringify(history)); } }catch(e){}
                        return { success: false, error: 'server_failed', server: j };
                    }
                }catch(e){ /* best-effort: return success locally but report server error */ return { success: true, warning: 'server_unavailable' }; }
            }

            return { success: true };
        }

        // Escrow withdrawal request flow: requests are stored in esusu_withdrawals and require approvals
        function _loadWithdrawals(){ try { return JSON.parse(localStorage.getItem('esusu_withdrawals') || '[]'); } catch(e){ return []; } }
        function _saveWithdrawals(arr){ localStorage.setItem('esusu_withdrawals', JSON.stringify(arr)); }

        function requestEscrowWithdrawal(groupId, userId, amount, opts){
            opts = opts || {};
            const g = getGroup(groupId); if (!g) throw new Error('Group not found');
            if (!g.settings || !g.settings.escrowEnabled) throw new Error('Escrow not enabled for group');
            amount = Number(amount) || 0; if (amount <= 0) throw new Error('Invalid amount');
            const withdrawals = _loadWithdrawals();
            const id = 'w_' + Date.now() + '_' + Math.random().toString(36).slice(2,6);
            const w = { id, groupId, userId, amount, dest: opts.dest||'', status: 'pending', approvals: [], requested_at: Date.now() };
            withdrawals.push(w); _saveWithdrawals(withdrawals);
            try{ const history = JSON.parse(localStorage.getItem('history')||'[]'); history.push({ id: id, user: userId, type: 'escrow_withdraw_request', amount, time: Date.now(), status: 'pending', groupId, note: opts.dest || '' }); localStorage.setItem('history', JSON.stringify(history)); }catch(e){}
            if (window.showToast) window.showToast(`Escrow withdrawal requested: ₦${amount}`, 'info');
            return w;
        }

        function approveEscrowWithdrawal(withdrawalId, approverUser){
            const withdrawals = _loadWithdrawals(); const w = withdrawals.find(x=>x.id===withdrawalId); if (!w) throw new Error('Withdrawal not found');
            if (w.approvals.includes(approverUser)) return { already: true };
            w.approvals.push(approverUser); _saveWithdrawals(withdrawals);
            const g = getGroup(w.groupId); const members = g && g.members ? g.members.map(m=>m.userId) : [];
            const threshold = (g && g.settings && g.settings.approvalThreshold) ? Number(g.settings.approvalThreshold) : 0.51;
            const needed = Math.ceil(members.length * threshold);
            if (w.approvals.length >= needed){
                releaseEscrowWithdrawal(withdrawalId, approverUser);
                return { released: true };
            }
            return { approved: true, approvals: w.approvals.length, needed };
        }

        function releaseEscrowWithdrawal(withdrawalId, byUser){
            const withdrawals = _loadWithdrawals(); const w = withdrawals.find(x=>x.id===withdrawalId); if (!w) throw new Error('Withdrawal not found');
            if (w.status === 'completed') return { already: true };
            const g = getGroup(w.groupId); if (!g) throw new Error('Group not found');
            const escrowAmt = Number(g.escrow)||0; const amt = Number(w.amount)||0;
            if (escrowAmt < amt) throw new Error('Insufficient group escrow');
            // debit escrow
            const groups = _loadGroups(); groups[g.id].escrow = escrowAmt - amt; _saveGroups(groups);
            // credit user
            try{ topUpWallet(w.userId, amt); }catch(e){}
            w.status = 'completed'; w.released_at = Date.now(); w.released_by = byUser || 'system'; _saveWithdrawals(withdrawals);
            try{ const history = JSON.parse(localStorage.getItem('history')||'[]'); history.push({ id: 'hist_'+Date.now()+'_'+Math.random().toString(36).slice(2,6), user: w.userId, type: 'escrow_withdraw_released', amount: amt, time: Date.now(), status: 'completed', groupId: w.groupId, note: `Released by ${byUser||'system'}` }); localStorage.setItem('history', JSON.stringify(history)); }catch(e){}
            if (window.showToast) window.showToast(`Escrow withdrawal released: ₦${amt} to ${w.userId}`, 'success');
            return { completed: true };
        }

        function getPendingEscrowWithdrawals(groupId){ return _loadWithdrawals().filter(w=>w.groupId===groupId && w.status==='pending'); }

        function joinGroup(groupId, userId){
            const groups = _loadGroups(); const g = groups[groupId];
            if (!g) throw new Error('Group not found');
            if (g.members.find(m=>m.userId===userId)) return g; // already
            if (g.members.length >= MAX_PARTICIPANTS) throw new Error('Group is full (max 20)');
            // enforce weekly cap: contributionAmount * (members+1) * 7 <= WEEKLY_CAP
            const N = g.members.length + 1;
            const weeklyTotal = Number(g.contributionAmount || 0) * N * 7;
            if (weeklyTotal > (g.settings && g.settings.maxWeeklyTotal || WEEKLY_CAP)) throw new Error('Joining would exceed weekly cap');
            const idx = g.members.length;
            g.members.push({ userId, joined_at: Date.now(), orderIndex: idx, last_seen: Date.now() });
            groups[groupId] = g; _saveGroups(groups); return g;
        }

        function leaveGroup(groupId, userId){ const groups = _loadGroups(); const g = groups[groupId]; if(!g) return null; g.members = g.members.filter(m=>m.userId!==userId); // reindex order
            g.members.forEach((m,i)=> m.orderIndex = i); groups[groupId]=g; _saveGroups(groups); return g; }

        function getBeneficiaryForDate(groupId, dateStr){ const g = getGroup(groupId); if(!g) return null; const N = g.members.length; if (!N) return null;
            const start = new Date(g.startDate);
            const d = new Date(dateStr);
            const days = Math.floor((d - start)/(24*60*60*1000));
            const idx = ((days % N) + N) % N; return g.members[idx];
        }

        // Internal helper: create payout entry for group/date and credit beneficiary wallet when appropriate
        function _createPayoutEntry(groupId, dateStr){
            const day = dateStr || _nowDateStr();
            const payouts = _loadPayouts();
            if (payouts.find(p => p.groupId === groupId && p.date === day)) return { skipped: true };
            const contribs = _loadContribs();
            const paidContribs = contribs.filter(c => c.groupId === groupId && c.scheduled_for_date === day && c.status === 'paid');
            const totalPaid = paidContribs.reduce((s,c)=> s + Number(c.amount || 0), 0);
            const beneficiary = getBeneficiaryForDate(groupId, day);
            const g = getGroup(groupId);
            const groupName = g ? g.name : groupId;
            const profiles = _getProfiles();
            const beneficiaryName = beneficiary ? ((profiles[beneficiary.userId] && profiles[beneficiary.userId].displayName) || beneficiary.userId) : null;
            const payout = { id: 'p_'+Date.now()+'_'+Math.random().toString(36).slice(2,6), groupId, groupName, beneficiary_userId: beneficiary ? beneficiary.userId : null, beneficiaryName: beneficiaryName, date: day, amount: totalPaid, processed_at: Date.now(), status: 'completed' };
            payouts.push(payout); _savePayouts(payouts);
            // credit beneficiary's wallet with totalPaid (if any)
            if (beneficiary && totalPaid > 0){
                try{ topUpWallet(beneficiary.userId, totalPaid); }catch(e){}
            }
            // write a small activity/history entry so it appears in Recent Activity
            try{
                const history = JSON.parse(localStorage.getItem('history')||'[]');
                history.push({ id: payout.id, user: beneficiary ? beneficiary.userId : '', type: 'payout', amount: totalPaid, time: Date.now(), status: 'completed', groupId: groupId, groupName: groupName, beneficiaryName: beneficiaryName, note: 'Esusu payout', link: `group.html?id=${encodeURIComponent(groupId)}` });
                localStorage.setItem('history', JSON.stringify(history));
            }catch(e){}
            // show a toast so members see the payout in real time (friendly name)
            try{ if (window.showToast) window.showToast(`Payout processed for ${groupName}: ₦${totalPaid} to ${beneficiaryName || '—'}`, 'success'); }catch(e){}
            return { payout, totalPaid, beneficiary_userId: beneficiary ? beneficiary.userId : null };
        }

        // Group escrow helpers
        function topUpGroupEscrow(groupId, amount){
            const groups = _loadGroups(); const g = groups[groupId]; if(!g) throw new Error('Group not found');
            g.escrow = (Number(g.escrow)||0) + Number(amount);
            groups[groupId] = g; _saveGroups(groups); return g.escrow;
        }

        function getGroupEscrow(groupId){ const g = getGroup(groupId); return g ? (Number(g.escrow)||0) : 0; }

        // Pending payout and approval flow
        function _createPendingPayout(groupId, dateStr){
            const day = dateStr || _nowDateStr();
            const payouts = _loadPayouts();
            if (payouts.find(p => p.groupId === groupId && p.date === day)) return { skipped: true };
            const contribs = _loadContribs();
            const paidContribs = contribs.filter(c => c.groupId === groupId && c.scheduled_for_date === day && c.status === 'paid');
            const totalPaid = paidContribs.reduce((s,c)=> s + Number(c.amount || 0), 0);
            const beneficiary = getBeneficiaryForDate(groupId, day);
            const g = getGroup(groupId);
            const groupName = g ? g.name : groupId;
            const profiles = _getProfiles();
            const beneficiaryName = beneficiary ? ((profiles[beneficiary.userId] && profiles[beneficiary.userId].displayName) || beneficiary.userId) : null;
            const payout = { id: 'p_'+Date.now()+'_'+Math.random().toString(36).slice(2,6), groupId, groupName, beneficiary_userId: beneficiary ? beneficiary.userId : null, beneficiaryName: beneficiaryName, date: day, amount: totalPaid, processed_at: Date.now(), status: 'pending', approvals: [] };
            payouts.push(payout); _savePayouts(payouts);
            // create history entry for pending payout
            try{ const history = JSON.parse(localStorage.getItem('history')||'[]'); history.push({ id: payout.id, user: beneficiary ? beneficiary.userId : '', type: 'payout_pending', amount: totalPaid, time: Date.now(), status: 'pending', groupId: groupId, groupName: groupName, beneficiaryName: beneficiaryName, note: 'Pending payout awaiting approvals', link: `group.html?id=${encodeURIComponent(groupId)}` }); localStorage.setItem('history', JSON.stringify(history)); }catch(e){}
            // show toast
            try{ if (window.showToast) window.showToast(`Pending payout for ${groupName}: ₦${totalPaid} to ${beneficiaryName || '—'}. Awaiting approvals.`, 'info'); }catch(e){}
            return { payout, totalPaid };
        }

        function approvePayout(payoutId, userId){
            const payouts = _loadPayouts(); const p = payouts.find(x=>x.id===payoutId); if(!p) throw new Error('Payout not found');
            if (p.approvals.includes(userId)) return { already: true };
            p.approvals.push(userId); _savePayouts(payouts);
            // check threshold
            const g = getGroup(p.groupId); const members = (g && g.members) ? g.members.map(m=>m.userId) : [];
            const threshold = (g && g.settings && g.settings.approvalThreshold) ? Number(g.settings.approvalThreshold) : 0.51;
            const needed = Math.ceil(members.length * threshold);
            if (p.approvals.length >= needed){
                // release payout
                releasePayout(p.id);
                return { released: true };
            }
            return { approved: true, approvals: p.approvals.length, needed };
        }

        function releasePayout(payoutId, byUser){
            const payouts = _loadPayouts(); const p = payouts.find(x=>x.id===payoutId); if(!p) throw new Error('Payout not found');
            if (p.status === 'completed') return { already: true };
            // check disputes
            const disputes = JSON.parse(localStorage.getItem('esusu_disputes')||'[]');
            if (disputes.find(d=>d.payoutId === payoutId && d.status === 'open')) throw new Error('Payout disputed');
            // If group uses escrow, transfer escrow to beneficiary; else credit beneficiary
            const g = getGroup(p.groupId);
            const total = Number(p.amount||0);
            if (g && g.escrow && Number(g.escrow) >= total){
                // debit escrow
                const groups = _loadGroups(); groups[p.groupId].escrow = Number(groups[p.groupId].escrow) - total; _saveGroups(groups);
                topUpWallet(p.beneficiary_userId, total);
            } else {
                // directly credit beneficiary
                if (total > 0) topUpWallet(p.beneficiary_userId, total);
            }
            p.status = 'completed'; p.processed_at = Date.now(); _savePayouts(payouts);
            // write history entry
            try{ const history = JSON.parse(localStorage.getItem('history')||'[]'); history.push({ id: 'hist_'+Date.now()+'_'+Math.random().toString(36).slice(2,6), user: p.beneficiary_userId || '', type: 'payout_released', amount: total, time: Date.now(), status: 'completed', groupId: p.groupId, groupName: p.groupName, beneficiaryName: p.beneficiaryName, note: `Payout released by ${byUser||'system'}`, link: `group.html?id=${encodeURIComponent(p.groupId)}` }); localStorage.setItem('history', JSON.stringify(history)); }catch(e){}
            if (window.showToast) window.showToast(`Payout released for ${p.groupName}: ₦${total} to ${p.beneficiaryName || p.beneficiary_userId}`, 'success');
            return { completed: true };
        }

        // dispute flow
        function createDispute(payoutId, userId, reason){
            const disputes = JSON.parse(localStorage.getItem('esusu_disputes')||'[]');
            const d = { id: 'd_'+Date.now()+'_'+Math.random().toString(36).slice(2,6), payoutId, userId, reason: reason || '', time: Date.now(), status: 'open' };
            disputes.push(d); localStorage.setItem('esusu_disputes', JSON.stringify(disputes));
            if (window.showToast) window.showToast('Dispute logged — payout paused', 'warning');
            return d;
        }

        function resolveDispute(disputeId, resolverUser, resolution){
            const disputes = JSON.parse(localStorage.getItem('esusu_disputes')||'[]'); const d = disputes.find(x=>x.id===disputeId); if(!d) throw new Error('Dispute not found');
            d.status = 'resolved'; d.resolvedBy = resolverUser; d.resolution = resolution || ''; d.resolvedAt = Date.now(); localStorage.setItem('esusu_disputes', JSON.stringify(disputes));
            if (window.showToast) window.showToast('Dispute resolved', 'info');
            return d;
        }

        // Reputation / trust score
        function getTrustScore(userId){
            try{
                const contribs = _loadContribs();
                const userContribs = contribs.filter(c=>c.userId===userId);
                if (!userContribs.length) return { score: 0, paid:0, total:0 };
                const paid = userContribs.filter(c=>c.status==='paid').length;
                const total = userContribs.length;
                const score = Math.round((paid/total)*100);
                return { score, paid, total };
            }catch(e){ return { score:0, paid:0, total:0 }; }
        }

        // small helper to record payment stats (used to compute trust over time)
        function _recordPaymentStat(userId, ok){
            const profiles = _getProfiles(); profiles[userId] = profiles[userId] || {}; profiles[userId].stats = profiles[userId].stats || { paid:0, missed:0 }; if (ok) profiles[userId].stats.paid = (profiles[userId].stats.paid||0)+1; else profiles[userId].stats.missed = (profiles[userId].stats.missed||0)+1; _saveProfiles(profiles);
        }

        // Process contributions and payout for a group on a specific date (wallet-first auto-debit if no contribs exist)
        function processPayoutForDate(groupId, dateStr){
            const day = dateStr || _nowDateStr();
            const g = getGroup(groupId); if(!g) throw new Error('Group not found');
            const contribs = _loadContribs(); const payouts = _loadPayouts();
            // idempotency: skip if payout already processed for group on this date
            if (payouts.find(p => p.groupId === groupId && p.date === day)) return { skipped: true };
            const paidMembers = [];
            // If contributions already recorded for this date, do not double-debit — respect their status
            const existingForDate = contribs.filter(c=>c.groupId===groupId && c.scheduled_for_date===day);
            if (existingForDate && existingForDate.length > 0){
                // mark any with status 'paid' as paidMembers
                existingForDate.forEach(c=>{ if (c.status === 'paid') paidMembers.push(c.userId); });
                // create payout from existing paid contributions
                const res = _createPayoutEntry(groupId, day);
                return Object.assign({ fromExisting: true }, res, { paidMembers });
            }

            // No existing contributions — attempt wallet-first auto-debit for all members
            g.members.forEach(m => {
                const user = m.userId; const wallet = getWallet(user);
                const amt = Number(g.contributionAmount)||0;
                if (wallet >= amt){
                    // debit
                    const profiles = _getProfiles(); profiles[user] = profiles[user] || {}; profiles[user].wallet = (Number(profiles[user].wallet)||0) - amt; _saveProfiles(profiles);
                    // record contribution
                    contribs.push({ id: 'c_'+Date.now()+'_'+Math.random().toString(36).slice(2,6), groupId, userId: user, amount: amt, scheduled_for_date: day, paid_at: Date.now(), status: 'paid' });
                    // update member last seen when payment occurs
                    try{ const gm = g.members.find(x=>x.userId===user); if (gm) gm.last_seen = Date.now(); }catch(e){}
                    paidMembers.push(user);
                } else {
                    contribs.push({ id: 'c_'+Date.now()+'_'+Math.random().toString(36).slice(2,6), groupId, userId: user, amount: amt, scheduled_for_date: day, paid_at: null, status: 'failed' });
                }
            });
            // persist member last_seen changes
            const allGroups = _loadGroups(); allGroups[groupId] = g; _saveGroups(allGroups);
            _saveContribs(contribs);
            // record payment stat for trust scoring
            try{ _recordPaymentStat(userId, true); }catch(e){}
            // create payout entry and credit beneficiary
            const res = _createPayoutEntry(groupId, day);
            return Object.assign({ payoutCreated: true }, res, { paidMembers });
        }

        // Backwards-compatible wrapper for today's date
        function processTodayPayout(groupId){ return processPayoutForDate(groupId, _nowDateStr()); }

        // Process due payouts across all groups for a given date (skips already processed groups for that date)
        function processDuePayouts(dateStr){
            const day = dateStr || _nowDateStr();
            const groups = listGroups(); const results = [];
            groups.forEach(g => {
                try{
                    if (new Date(g.startDate) <= new Date(day)){
                        const existing = _loadPayouts().find(p => p.groupId === g.id && p.date === day);
                        if (existing) { results.push({ groupId: g.id, skipped: true }); return; }

                        // If contributions already exist for this date, attempt to auto-debit any failed contributions
                        const contribs = _loadContribs();
                        const existingForDate = contribs.filter(c=>c.groupId===g.id && c.scheduled_for_date===day);
                        if (existingForDate && existingForDate.length > 0){
                            let updated = false;
                            existingForDate.forEach(c => {
                                if (c.status !== 'paid'){
                                    const user = c.userId; const amt = Number(c.amount||0);
                                    const bal = getWallet(user);
                                    if (bal >= amt){
                                        // debit and mark paid
                                        const profiles = _getProfiles(); profiles[user] = profiles[user] || {}; profiles[user].wallet = (Number(profiles[user].wallet)||0) - amt; _saveProfiles(profiles);
                                        c.status = 'paid'; c.paid_at = Date.now();
                                        // update member last_seen
                                        try{ const groupsObj = _loadGroups(); const gg = groupsObj[g.id]; if (gg){ const m = gg.members.find(x=>x.userId===user); if (m) m.last_seen = Date.now(); groupsObj[g.id]=gg; _saveGroups(groupsObj); } }catch(e){}
                                        updated = true;
                                    }
                                }
                            });
                            if (updated) _saveContribs(contribs);
                        } else {
                            // no existing contributions — perform wallet-first auto-debit for members
                            processPayoutForDate(g.id, day);
                        }

                        // create payout entry now (this will aggregate any paid contributions)
                        let res = null;
                        try{
                            if (g.settings && g.settings.payoutApprovalRequired) {
                                res = _createPendingPayout(g.id, day);
                            } else {
                                res = _createPayoutEntry(g.id, day);
                            }
                        }catch(e){ res = { error: String(e && e.message ? e.message : e) }; }
                        results.push(Object.assign({ groupId: g.id }, res));
                    }
                }catch(e){ results.push({ groupId: g.id, error: String(e && e.message ? e.message : e) }); }
            });
            return results;
        }

        // Simulate multiple days of processing (useful for demo). startDate optional, defaults to today
        function simulateDays(days, startDate){
            days = Number(days) || 1; if (days <= 0) return [];
            const start = startDate ? new Date(startDate) : new Date();
            const all = [];
            for (let i=0;i<days;i++){
                const d = new Date(start.getTime() + i*24*60*60*1000);
                const dayStr = d.toISOString().slice(0,10);
                const res = processDuePayouts(dayStr);
                all.push({ date: dayStr, results: res });
            }
            return all;
        }

        function getContributionsForDate(groupId, dateStr){
            const day = dateStr || _nowDateStr();
            return _loadContribs().filter(c=>c.groupId===groupId && c.scheduled_for_date===day);
        }

        function markAsPaid(groupId, userId, dateStr, opts){
            opts = opts || {};
            const day = dateStr || _nowDateStr();
            const contribs = _loadContribs();
            const amount = Number(opts.amount != null ? opts.amount : (getGroup(groupId) && getGroup(groupId).contributionAmount) || 0);
            // optional debit from wallet
            if (opts.debitWallet) {
                const profiles = _getProfiles(); profiles[userId] = profiles[userId] || {}; const bal = Number(profiles[userId].wallet) || 0;
                if (bal < amount) throw new Error('Insufficient wallet balance');
                profiles[userId].wallet = bal - amount;
                _saveProfiles(profiles);
            }
            // check if contribution exists for this user/group/date
            const existing = contribs.find(c=>c.groupId===groupId && c.userId===userId && c.scheduled_for_date===day);
            if (existing){ existing.status = 'paid'; existing.paid_at = Date.now(); existing.amount = amount; if (opts.note) existing.note = opts.note; }
            else {
                contribs.push({ id: 'c_'+Date.now()+'_'+Math.random().toString(36).slice(2,6), groupId, userId, amount: amount, scheduled_for_date: day, paid_at: Date.now(), status: 'paid', note: opts.note || '' });
            }
            _saveContribs(contribs);
            // update member last_seen
            try{ const groups = _loadGroups(); const g = groups[groupId]; if (g){ const m = g.members.find(x=>x.userId===userId); if (m) m.last_seen = Date.now(); groups[groupId]=g; _saveGroups(groups); } }catch(e){}
            // After marking paid, check if all members have paid for this date — if so, process payout automatically
            try{
                const groups = _loadGroups(); const g = groups[groupId]; if (g){
                    const members = g.members || [];
                    const contribsForDate = _loadContribs().filter(c=>c.groupId===groupId && c.scheduled_for_date===day);
                    const paidUsers = contribsForDate.filter(c=>c.status==='paid').map(c=>c.userId);
                    const allPaid = members.length > 0 && members.every(m => paidUsers.includes(m.userId));
                    if (allPaid){
                        // if group requires approval, create pending payout; else create and release immediately
                        try{
                            if (g.settings && g.settings.payoutApprovalRequired) {
                                _createPendingPayout(groupId, day);
                            } else {
                                _createPayoutEntry(groupId, day);
                            }
                        }catch(e){ /* ignore */ }
                    }
                }
            }catch(e){}
            return true;
        }

        // Sum total collected (paid contributions) for a group across all dates
        function getTotalCollected(groupId){
            return _loadContribs().filter(c=>c.groupId===groupId && c.status==='paid').reduce((s,c)=> s + Number(c.amount||0), 0);
        }

        // Sum total contributed by a member (paid) for a group across all dates
        function getMemberTotalContributed(groupId, userId){
            return _loadContribs().filter(c=>c.groupId===groupId && c.userId===userId && c.status==='paid').reduce((s,c)=> s + Number(c.amount||0), 0);
        }

        function updateLastSeen(groupId, userId){
            try{
                if (!groupId || !userId) return false;
                const groups = _loadGroups(); const g = groups[groupId]; if (!g) return false;
                const m = g.members.find(x=>x.userId===userId); if (!m) return false;
                m.last_seen = Date.now(); groups[groupId] = g; _saveGroups(groups); return true;
            }catch(e){ return false; }
        }

        // expose a helper to get beneficiary for a date (wrap internal implementation)
        function getBeneficiary(groupId, dateStr){ return getBeneficiaryForDate(groupId, dateStr); }

        // expose API
        window.esusu = {
            createGroup, listGroups, getGroup, joinGroup, leaveGroup, processTodayPayout,
            processPayoutForDate, processDuePayouts, simulateDays,
            topUpWallet, getWallet,
            getContributionsForDate, markAsPaid, getBeneficiary,
            // new helpers
            getTotalCollected, getMemberTotalContributed,
            // escrow and approvals
            topUpGroupEscrow, getGroupEscrow, approvePayout, releasePayout,
            // withdraw
            withdrawFromWallet,
            // escrow withdrawals
            requestEscrowWithdrawal, approveEscrowWithdrawal, releaseEscrowWithdrawal, getPendingEscrowWithdrawals,
            // disputes and reputation
            createDispute, resolveDispute, getTrustScore
        };
    })();

        // Inject a persistent "Back to dashboard" button on non-dashboard pages
        document.addEventListener('DOMContentLoaded', () => {
            try{
                // don't add on the dashboard page itself
                const path = (window.location.pathname || '').toLowerCase();
                if (path.endsWith('/dashboard.html') || path.endsWith('/')) return;
                if (document.getElementById('btnBackDashboard')) return; // already present

                const btn = document.createElement('button');
                btn.id = 'btnBackDashboard';
                btn.className = 'back-dashboard';
                btn.type = 'button';
                btn.setAttribute('aria-label', 'Go back to dashboard');
                btn.innerText = 'Back to dashboard';
                btn.addEventListener('click', (e) => {
                    e.preventDefault();
                    // preserve hash/query if user came from dashboard? for now navigate to dashboard
                    window.location.href = 'dashboard.html';
                });

                // If there's a header/topbar, place the button inside it so it doesn't overlay content.
                const headerEl = document.querySelector('header') || document.querySelector('.topbar');
                if (headerEl) {
                    btn.classList.add('inline-back');
                    // keep it visually separated
                    headerEl.insertBefore(btn, headerEl.firstChild);
                } else {
                    // insert as first child of body for predictable positioning
                    document.body.insertBefore(btn, document.body.firstChild);
                }
            }catch(e){ console.warn('Failed to add Back to dashboard button', e); }
        });

    })();

    // Lightweight fraud detection helpers (client-side heuristics + optional server-assisted assessment)
    (function initFraudModule(){
        const DEFAULTS = { highAmount: 100000, mediumAmount: 50000, velocityWindowMs: 60*1000, velocityThresh: 3 };

        async function assessTransactionClient(tx){
            const reasons = [];
            let score = 0;
            const amt = Number(tx.amount || 0);
            if (amt >= DEFAULTS.highAmount){ score += 60; reasons.push('high_amount'); }
            else if (amt >= DEFAULTS.mediumAmount){ score += 30; reasons.push('medium_amount'); }

            // velocity: recent transactions by this user
            try{
                const history = JSON.parse(localStorage.getItem('history')||'[]').filter(h=>h.user === tx.user);
                const now = Date.now();
                const recent = history.filter(h=> (now - (h.time||0)) <= DEFAULTS.velocityWindowMs ).length;
                if (recent >= DEFAULTS.velocityThresh){ score += 40; reasons.push('high_velocity'); }
                else if (recent > 0){ score += 10; }
            }catch(e){}

            // low trust profile (local heuristic)
            try{ const profiles = JSON.parse(localStorage.getItem('bt_profiles')||'{}'); const p = profiles[tx.user] || {}; if (p && p.reputation != null && Number(p.reputation) < 40){ score += 25; reasons.push('low_reputation'); } }catch(e){}

            // local storage tamper flag increases suspicion
            if (window.localStorageTampered) { score += 30; reasons.push('local_storage_tamper'); }

            // normalize to 0-100
            if (score > 100) score = 100;
            return { score, reasons };
        }

        async function assessTransaction(tx){
            // run client heuristics first
            const client = await assessTransactionClient(tx);
            // if client score is already high, return immediately
            if (client.score >= 80) return { source: 'client', ...client };

            // optionally call server-side assessor if endpoint configured
            const ep = (localStorage.getItem('bt_api_endpoint') || window.BT_API_ENDPOINT || '').replace(/\/$/, '');
            if (!ep) return { source: 'client', ...client };
            try{
                const controller = new AbortController(); const timeout = setTimeout(()=>controller.abort(), 5000);
                const res = await fetch(ep + '/fraud/assess', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(tx), signal: controller.signal, credentials: 'include' });
                clearTimeout(timeout);
                if (res && res.ok){ const j = await res.json().catch(()=>null); if (j && typeof j.score === 'number'){
                    // merge reasons and prefer higher score
                    const mergedScore = Math.max(client.score, j.score);
                    const reasons = Array.from(new Set([...(client.reasons||[]), ...(j.reasons||[])]));
                    return { source: 'hybrid', score: mergedScore, reasons };
                }}
            }catch(e){ /* server assessor unavailable, return client-only */ }
            return { source: 'client', ...client };
        }

        window.fraud = { assessTransaction };
    })();