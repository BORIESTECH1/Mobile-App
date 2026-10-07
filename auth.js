/*
    Auth utilities with graceful Firebase fallback.
    - Tries to use Firebase Auth if firebase is available and configured.
    - Otherwise uses a simple localStorage-backed auth for development/testing.
    Exports: signup, login, checkAuth, logout, loadUser
*/

// Minimal sanitizer
function _safe(val) {
    return String(val || "").trim();
}

async function signup() {
    const username = _safe(document.getElementById('su_username')?.value);
    const password = _safe(document.getElementById('su_password')?.value);
    if (!username || !password) { showToast('Please enter username and password', 'info'); return; }

    // Use Firebase if available and configured
    if (window.firebase && firebase.auth) {
        try {
            await firebase.auth().createUserWithEmailAndPassword(username, password);
            localStorage.setItem('loggedInUser', username);
            // ensure profile/account number exists for firebase users too
            const profiles = _getProfilesStore();
            if (!profiles[username] || !profiles[username].accountNumber) {
              const accountNumber = String(Math.floor(1000000000 + Math.random() * 9000000000));
              profiles[username] = Object.assign(profiles[username] || {}, { accountNumber });
              _saveProfilesStore(profiles);
            }
            showToast('Account created', 'success');
            setTimeout(() => { window.location.href = 'dashboard.html'; }, 700);
        } catch (err) {
            showToast(err.message || 'Signup failed', 'danger');
        }
        return;
    }

    // Local fallback
    const users = JSON.parse(localStorage.getItem('bt_users') || '{}');
    if (users[username]) { showToast('User already exists', 'info'); return; }
    const accountNumber = String(Math.floor(1000000000 + Math.random() * 9000000000)); // 10-digit
    users[username] = { password, accountNumber };
    localStorage.setItem('bt_users', JSON.stringify(users));
    // initialize profile with accountNumber
    const profiles = _getProfilesStore();
    profiles[username] = Object.assign(profiles[username] || {}, { accountNumber });
    _saveProfilesStore(profiles);
    localStorage.setItem('loggedInUser', username);
    showToast('Account created (local)', 'success');
    setTimeout(() => { window.location.href = 'dashboard.html'; }, 700);
}

async function login() {
    const username = _safe(document.getElementById('li_username')?.value);
    const password = _safe(document.getElementById('li_password')?.value);
    if (!username || !password) { showToast('Enter username and password', 'info'); return; }

    if (window.firebase && firebase.auth) {
        try {
            await firebase.auth().signInWithEmailAndPassword(username, password);
            localStorage.setItem('loggedInUser', username);
            window.location.href = 'dashboard.html';
        } catch (err) {
            showToast(err.message || 'Login failed', 'danger');
        }
        return;
    }

    // Local fallback
    const users = JSON.parse(localStorage.getItem('bt_users') || '{}');
    if (users[username] && users[username].password === password) {
        localStorage.setItem('loggedInUser', username);
        window.location.href = 'dashboard.html';
    } else {
        showToast('Invalid credentials', 'danger');
    }
}

function checkAuth(redirect = true) {
    const user = localStorage.getItem('loggedInUser');
    if (!user && redirect) {
        window.location.href = 'login.html';
        return false;
    }
    return Boolean(user);
}

function logout() {
    // If firebase present, try sign out
    if (window.firebase && firebase.auth) {
        firebase.auth().signOut().catch(() => {});
    }
    localStorage.removeItem('loggedInUser');
    window.location.href = 'login.html';
}

function loadUser() {
    const user = localStorage.getItem('loggedInUser') || '';
    const el = document.getElementById('userDisplay');
    if (el) {
        // prefer displayName from profile if available
        const profile = getProfile(user) || {};
        const name = profile.displayName || user;
        el.innerText = user ? `👋 ${name}` : '';
    }
}

function _getCurrentUser() {
    return localStorage.getItem('loggedInUser') || null;
}

/* Profile storage (per-username) */
function _getProfilesStore() {
    try {
        return JSON.parse(localStorage.getItem('bt_profiles') || '{}');
    } catch (e) {
        return {};
    }
}

function _saveProfilesStore(obj) {
    localStorage.setItem('bt_profiles', JSON.stringify(obj));
}

function saveProfile(profile) {
    // profile: { avatar: dataURL, displayName: string }
    const user = _getCurrentUser();
    if (!user) return false;
    const store = _getProfilesStore();
    store[user] = Object.assign(store[user] || {}, profile || {});
    _saveProfilesStore(store);
    return true;
}

function getProfile(username) {
    const store = _getProfilesStore();
    return store[username] || null;
}

function setProfilePictureFromFile(file) {
    // Resize/compress client-side before saving to reduce localStorage usage.
    return new Promise((resolve, reject) => {
        if (!file) return reject(new Error('No file provided'));
        const avatarEl = document.getElementById('userAvatar');
        if (avatarEl) avatarEl.classList.add('loading');

        // helper: load image from file
        const loadImage = (file) => new Promise((res, rej) => {
            const fr = new FileReader();
            fr.onload = () => {
                const img = new Image();
                img.onload = () => res(img);
                img.onerror = rej;
                img.src = fr.result;
            };
            fr.onerror = rej;
            fr.readAsDataURL(file);
        });

        // helper: resize image to fit within max dimensions, returns dataURL
        const resizeImage = (img, maxW = 512, maxH = 512, quality = 0.8) => {
            const canvas = document.createElement('canvas');
            let { width: w, height: h } = img;
            // calculate new size while keeping aspect ratio
            if (w > maxW || h > maxH) {
                const ratio = Math.min(maxW / w, maxH / h);
                w = Math.round(w * ratio);
                h = Math.round(h * ratio);
            }
            canvas.width = w;
            canvas.height = h;
            const ctx = canvas.getContext('2d');
            // fill transparent background with white for JPG
            ctx.fillStyle = '#fff';
            ctx.fillRect(0, 0, w, h);
            ctx.drawImage(img, 0, 0, w, h);
            return canvas.toDataURL('image/jpeg', quality);
        };

        loadImage(file).then(img => {
            try {
                const dataUrl = resizeImage(img, 512, 512, 0.8);
                const ok = saveProfile({ avatar: dataUrl });
                if (ok) {
                    loadProfile();
                    if (avatarEl) avatarEl.classList.remove('loading');
                    resolve(dataUrl);
                } else {
                    if (avatarEl) avatarEl.classList.remove('loading');
                    reject(new Error('No logged in user'));
                }
            } catch (err) {
                if (avatarEl) avatarEl.classList.remove('loading');
                reject(err);
            }
        }).catch(err => {
            if (avatarEl) avatarEl.classList.remove('loading');
            reject(err);
        });
    });
}

function loadProfile() {
    const user = _getCurrentUser();
    if (!user) return;
    const profile = getProfile(user);
    // set avatar in topbar if present
    const avatarEl = document.getElementById('userAvatar');
    if (avatarEl) {
        if (profile && profile.avatar) {
            avatarEl.src = profile.avatar;
            avatarEl.style.display = 'inline-block';
        } else {
            avatarEl.style.display = 'none';
        }
    }
    // account number
    const acctEl = document.getElementById('accountNumber');
    if (acctEl) {
        const acct = (profile && profile.accountNumber) || (JSON.parse(localStorage.getItem('bt_users') || '{}')[user] || {}).accountNumber || '';
        acctEl.textContent = acct ? `Account: ${acct}` : '';
    }
    // account name
    const acctNameEl = document.getElementById('accountName');
    if (acctNameEl) {
        const acctName = (profile && profile.displayName) || user || '';
        acctNameEl.textContent = acctName ? `Account name: ${acctName}` : '';
    }
    // balance visibility preference
    const prefs = JSON.parse(localStorage.getItem('bt_prefs') || '{}');
    const hidden = prefs[user] && prefs[user].hideBalance;
    const balanceVal = document.getElementById('balanceValue');
    const btn = document.getElementById('btnToggleBalance');
    if (balanceVal) {
        if (hidden) balanceVal.textContent = '••••••';
        else balanceVal.textContent = (window._bt_balance_display || '₦250,000');
    }
    if (btn) btn.textContent = hidden ? 'Show' : 'Hide';
    // set profile page fields if present
    const nameEl = document.getElementById('profileUsername');
    if (nameEl) nameEl.textContent = (profile && profile.displayName) ? profile.displayName : user;
    const preview = document.getElementById('profileAvatarPreview');
    if (preview) {
        if (profile && profile.avatar) preview.src = profile.avatar;
        else preview.src = '';
    }
}

function toggleBalance() {
    const user = _getCurrentUser();
    if (!user) return;
    const prefs = JSON.parse(localStorage.getItem('bt_prefs') || '{}');
    prefs[user] = prefs[user] || {};
    prefs[user].hideBalance = !prefs[user].hideBalance;
    localStorage.setItem('bt_prefs', JSON.stringify(prefs));
    loadProfile();
}

function setBalanceDisplay(val) {
    // allow overriding the displayed balance (used by tests or server integration)
    window._bt_balance_display = val;
    loadProfile();
}

window.toggleBalance = toggleBalance;
window.setBalanceDisplay = setBalanceDisplay;

// expose profile helpers
window.saveProfile = saveProfile;
window.getProfile = getProfile;
window.setProfilePictureFromFile = setProfilePictureFromFile;
window.loadProfile = loadProfile;

// export to window for pages that call these functions directly
window.signup = signup;
window.login = login;
window.checkAuth = checkAuth;
window.logout = logout;
window.loadUser = loadUser;

