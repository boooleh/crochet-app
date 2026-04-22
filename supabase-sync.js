// ── Supabase Sync ─────────────────────────────────────────────────────
// Magic-link auth + cloud sync for Crochet Corner
// Loaded after supabase-config.js and the Supabase CDN script.

let _sb           = null;   // Supabase client instance
let _currentUser  = null;   // Logged-in user object (or null)
let _syncTimer    = null;   // Debounce timer handle
let _syncEnabled  = false;  // True once client is ready and user is signed in
let _dotState     = 'offline'; // Tracks real dot state so profile sheet doesn't override it

// ── Client init ───────────────────────────────────────────────────────

function _initSupabaseClient() {
  if (typeof SUPABASE_URL === 'undefined' || SUPABASE_URL.includes('YOUR_')) {
    console.warn('[Sync] supabase-config.js not filled in — running offline.');
    return false;
  }
  if (typeof supabase === 'undefined') {
    console.warn('[Sync] Supabase CDN not loaded — running offline.');
    return false;
  }
  _sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      autoRefreshToken: true,
      persistSession:   true,
      detectSessionInUrl: false  // prevents multiple tabs racing to parse the URL
    }
  });
  return true;
}

// ── Auth ──────────────────────────────────────────────────────────────

async function sendMagicLink(email) {
  const redirectTo = window.location.origin + window.location.pathname;
  const { error } = await _sb.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: redirectTo }
  });
  if (error) throw error;
}

async function supabaseSignOut() {
  console.log('[Sync] supabaseSignOut() called');

  // Show the signing-out loading overlay immediately so the user gets
  // feedback while we wait for signOut + reload (up to ~1.5s worst case).
  const signoutOverlay = document.getElementById('sb-signout-overlay');
  if (signoutOverlay) signoutOverlay.style.display = 'flex';

  // Stop any queued sync from firing after sign out
  clearTimeout(_syncTimer);
  _syncEnabled = false;

  // Close the profile sheet
  const scrim = document.getElementById('sb-profile-scrim');
  if (scrim) { scrim.style.display = 'none'; scrim.style.opacity = '0'; }

  // Sign out from Supabase — race it against a 1.5s timeout.
  // On iOS Safari / PWAs, supabase-js's internal navigator.locks.request()
  // call can hang forever without throwing, which would block the reload below.
  // scope:'local' also skips the server round-trip, so no network dependency.
  try {
    if (_sb) {
      await Promise.race([
        _sb.auth.signOut({ scope: 'local' }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('signOut timeout')), 1500))
      ]);
    }
  } catch (e) {
    console.warn('[Sync] signOut() failed or timed out — clearing session manually:', e?.message);
  }

  // Belt-and-suspenders: wipe the Supabase session from localStorage directly
  // so the session is gone even if signOut() failed or timed out.
  try {
    const projectRef = SUPABASE_URL.match(/https:\/\/([^.]+)\./)?.[1];
    if (projectRef) {
      localStorage.removeItem(`sb-${projectRef}-auth-token`);
      localStorage.removeItem(`sb-${projectRef}-auth-token-code-verifier`);
    }
    // Extra safety net: remove any stray sb-*-auth-token* keys
    Object.keys(localStorage).forEach(k => {
      if (k.startsWith('sb-') && k.includes('-auth-token')) localStorage.removeItem(k);
    });
  } catch (e) { /* ignore */ }

  // Reload the page — cleanest way to guarantee a fresh signed-out state
  // (avoids lock conflicts re-establishing the session after signOut)
  window.location.reload();
}

// ── Data helpers ──────────────────────────────────────────────────────

// Collects everything from localStorage into one object (same shape as backup export)
function _gatherAllData() {
  const pats  = JSON.parse(localStorage.getItem('crochet_patterns_v2') || '[]');
  const projs = JSON.parse(localStorage.getItem('crochet_projects_v1') || '[]');
  const d = {
    patterns:      pats,
    projects:      projs,
    patternImages: {},
    patternPdfs:   {},
    projectSteps:  {},
    projectPhotos: {}
  };
  pats.forEach(p => {
    const imgs = (typeof getPatternImages === 'function') ? getPatternImages(p.id) : [];
    if (imgs.length) d.patternImages[p.id] = imgs;
    const pdf = localStorage.getItem('crochet_pdf_' + p.id);
    if (pdf) d.patternPdfs[p.id] = pdf;
  });
  projs.forEach(p => {
    const steps = JSON.parse(localStorage.getItem('crochet_psteps_' + p.id) || '[]');
    if (steps.length) d.projectSteps[p.id] = steps;
    if (p.photoKey) {
      const photo = localStorage.getItem(p.photoKey);
      if (photo) d.projectPhotos[p.photoKey] = photo;
    }
  });
  return d;
}

// Writes a data blob (from Supabase) back into localStorage
function _applyDataToLocalStorage(d) {
  if (!d) return;
  if (Array.isArray(d.patterns)) localStorage.setItem('crochet_patterns_v2', JSON.stringify(d.patterns));
  if (Array.isArray(d.projects)) localStorage.setItem('crochet_projects_v1', JSON.stringify(d.projects));
  Object.entries(d.patternImages || {}).forEach(([id, imgs]) => localStorage.setItem('crochet_pat_imgs_' + id, JSON.stringify(imgs)));
  Object.entries(d.patternPdfs   || {}).forEach(([id, pdf])  => localStorage.setItem('crochet_pdf_' + id, pdf));
  Object.entries(d.projectSteps  || {}).forEach(([id, s])    => localStorage.setItem('crochet_psteps_' + id, JSON.stringify(s)));
  Object.entries(d.projectPhotos || {}).forEach(([key, ph])  => localStorage.setItem(key, ph));
}

// ── Push / Pull ───────────────────────────────────────────────────────

async function _pushToSupabase() {
  if (!_syncEnabled) return;

  const MAX_RETRIES  = 3;
  const RETRY_DELAYS = [3000, 6000, 12000]; // wait 3s, 6s, 12s between attempts

  // Only show the orange syncing dot if the push takes longer than 900ms.
  const syncingTimer = setTimeout(() => _updateAvatarDot('syncing'), 900);

  let lastErr;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      // Wait before retrying
      await new Promise(r => setTimeout(r, RETRY_DELAYS[attempt - 1]));
      if (!_syncEnabled) break; // user signed out while waiting
      console.log(`[Sync] Retrying push (attempt ${attempt + 1}/${MAX_RETRIES})…`);
    }
    try {
      const now = Date.now();
      const payload = {
        user_id:    _currentUser.id,
        data:       { ..._gatherAllData(), savedAt: now },
        updated_at: new Date().toISOString()
      };

      // Race each attempt against a 15-second timeout
      const { error } = await Promise.race([
        (async () => _sb.from('user_data').upsert(payload, { onConflict: 'user_id' }))(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Sync timeout after 15s')), 15000)
        )
      ]);

      if (error) throw error;

      // Success
      clearTimeout(syncingTimer);
      localStorage.setItem('crochet_sync_at', String(now));
      _updateSyncBadge(true);
      _updateAvatarDot('synced');
      if (typeof showSimpleToast === 'function') showSimpleToast('☁️ Saved to cloud');
      return;
    } catch (err) {
      lastErr = err;
      console.warn(`[Sync] Push attempt ${attempt + 1} failed:`, err?.message || err?.code);
    }
  }

  // All attempts failed
  clearTimeout(syncingTimer);
  console.error('[Sync] Push failed after', MAX_RETRIES, 'attempts:', lastErr?.message);
  _updateSyncBadge(false);
  _updateAvatarDot('error');
  if (typeof showSimpleToast === 'function') showSimpleToast('⚠️ Sync failed — saved locally');
}

async function _pullFromSupabase(force = false) {
  if (!_sb || !_currentUser) return false;
  try {
    // Race the pull against a 15-second timeout — without this it can hang forever
    const { data: row, error } = await Promise.race([
      _sb.from('user_data').select('data').eq('user_id', _currentUser.id).maybeSingle(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Pull timeout after 15s')), 15000)
      )
    ]);
    if (error) throw error;
    if (row && row.data) {
      const cloudSavedAt   = row.data.savedAt || 0;
      const localSavedAt   = parseInt(localStorage.getItem('crochet_sync_at') || '0');
      const cloudPatterns  = row.data.patterns  || [];
      const cloudProjects  = row.data.projects  || [];
      const localPatterns  = JSON.parse(localStorage.getItem('crochet_patterns_v2') || '[]');
      const localProjects  = JSON.parse(localStorage.getItem('crochet_projects_v1') || '[]');
      const cloudHasData   = cloudPatterns.length > 0 || cloudProjects.length > 0;
      const localIsEmpty   = localPatterns.length === 0 && localProjects.length === 0;

      console.log('[Sync] Pull check — cloudSavedAt:', cloudSavedAt, 'localSavedAt:', localSavedAt,
        '| cloud patterns:', cloudPatterns.length, 'local patterns:', localPatterns.length,
        '| force:', force);

      // Safety net: if local is empty but cloud has data, always pull regardless of timestamps.
      // This handles fresh installs, cleared storage, and missing savedAt fields.
      if (localIsEmpty && cloudHasData) {
        console.log('[Sync] Local empty + cloud has data → force pulling');
        _applyDataToLocalStorage(row.data);
        localStorage.setItem('crochet_sync_at', String(cloudSavedAt || Date.now()));
        return true;
      }

      // When triggered manually (force=true), always pull from cloud so the user
      // can recover from a "stuck" up-to-date state where timestamps match but
      // the phone is missing data the desktop saved.
      if (force && cloudHasData) {
        console.log('[Sync] Forced pull — applying cloud data regardless of timestamps');
        _applyDataToLocalStorage(row.data);
        localStorage.setItem('crochet_sync_at', String(cloudSavedAt || Date.now()));
        return true;
      }

      // Normal path: only pull if cloud timestamp is strictly newer
      if (cloudSavedAt <= localSavedAt) {
        console.log('[Sync] Local is up to date — skipping pull');
        return false;
      }

      console.log('[Sync] Cloud is newer → pulling');
      _applyDataToLocalStorage(row.data);
      localStorage.setItem('crochet_sync_at', String(cloudSavedAt));
      return true;
    }
    console.log('[Sync] No cloud data found');
    return false;
  } catch (err) {
    console.error('[Sync] Pull failed:', err?.message || err?.code || JSON.stringify(err));
    return false;
  }
}

// ── Debounced sync (called after every local save) ────────────────────

function queueSupabaseSync() {
  if (!_syncEnabled) return;
  clearTimeout(_syncTimer);
  _syncTimer = setTimeout(_pushToSupabase, 2000);
}

// ── Profile sheet ─────────────────────────────────────────────────────

function sbShowProfileSheet() {
  // Use the real tracked dot state — never override an error with a false green
  _updateAvatarDot(_dotState);

  // Update content before showing
  const email = _currentUser?.email || 'Not signed in';
  const syncLblMap = { synced: '● Synced', syncing: '● Syncing…', error: '● Sync error', offline: '● Offline mode' };
  const syncColMap = { synced: '#2a9d5c', syncing: '#7B4FD8', error: '#e05', offline: '#aaa' };
  const syncLbl = syncLblMap[_dotState] || '● Offline mode';
  const syncCol = syncColMap[_dotState] || '#aaa';
  const el = document.getElementById('sb-profile-email-lbl');
  const sl = document.getElementById('sb-profile-sync-lbl');
  if (el) el.textContent = email;
  if (sl) { sl.textContent = syncLbl; sl.style.color = syncCol; }

  // Set large avatar initial
  const av = document.getElementById('sb-profile-avatar-large');
  if (av && _currentUser?.email) av.textContent = _currentUser.email[0].toUpperCase();

  // Hide sign-out + change-pw if not signed in
  const showAuth = !!_currentUser;
  ['sb-signout-btn','sb-change-pw-btn'].forEach(id => {
    const b = document.getElementById(id);
    if (b) b.style.display = showAuth ? 'flex' : 'none';
  });

  const scrim = document.getElementById('sb-profile-scrim');
  if (scrim) { scrim.style.display = 'flex'; requestAnimationFrame(() => scrim.style.opacity = '1'); }
}

function sbHideProfileSheet() {
  const scrim = document.getElementById('sb-profile-scrim');
  if (scrim) scrim.style.display = 'none';
}

// ── Change password sheet ─────────────────────────────────────────────

function sbShowChangePw() {
  const scrim = document.getElementById('sb-changepw-scrim');
  if (scrim) scrim.style.display = 'flex';
  document.getElementById('sb-new-pw').value     = '';
  document.getElementById('sb-confirm-pw').value = '';
  document.getElementById('sb-changepw-msg').textContent = '';
}

function sbHideChangePw() {
  const scrim = document.getElementById('sb-changepw-scrim');
  if (scrim) scrim.style.display = 'none';
}

async function sbDoChangePw() {
  const newPw  = document.getElementById('sb-new-pw').value;
  const confPw = document.getElementById('sb-confirm-pw').value;
  const msg    = document.getElementById('sb-changepw-msg');

  if (newPw.length < 6)      { msg.textContent = 'Password must be at least 6 characters.'; msg.style.color = '#d00'; return; }
  if (newPw !== confPw)      { msg.textContent = 'Passwords don\'t match.'; msg.style.color = '#d00'; return; }

  msg.textContent = 'Saving…'; msg.style.color = '#888';
  const { error } = await _sb.auth.updateUser({ password: newPw });
  if (error) { msg.textContent = error.message; msg.style.color = '#d00'; return; }
  msg.textContent = '✅ Password updated!'; msg.style.color = '#2a9d5c';
  setTimeout(sbHideChangePw, 1500);
}

// ── Avatar dot state ──────────────────────────────────────────────────

function _updateAvatarDot(state) { // 'synced' | 'syncing' | 'error' | 'offline'
  _dotState = state; // always remember the real state
  document.querySelectorAll('.sb-avatar-dot').forEach(dot => {
    dot.className = 'sb-avatar-dot' + (state !== 'offline' ? ' ' + state : '');
  });
  // Also update initials with first letter of email
  if (_currentUser?.email) {
    document.querySelectorAll('.sb-avatar-initials').forEach(el => {
      el.textContent = _currentUser.email[0].toUpperCase();
    });
  }
}

// ── Auth overlay UI ───────────────────────────────────────────────────

function _showAuthOverlay() {
  const el = document.getElementById('sb-auth-overlay');
  if (el) el.classList.remove('sb-hidden');
}

function _hideAuthOverlay() {
  const el = document.getElementById('sb-auth-overlay');
  if (el) el.classList.add('sb-hidden');
}

function _updateSyncBadge(ok) {
  document.querySelectorAll('.sb-sync-badge').forEach(el => {
    el.textContent = ok ? '☁' : '⚠';
    el.title       = ok ? 'Synced to cloud' : 'Sync issue — changes saved locally';
    el.classList.toggle('sb-sync-ok',  ok);
    el.classList.toggle('sb-sync-err', !ok);
  });
}

function _updateUserChip(user) {
  document.querySelectorAll('.sb-user-chip').forEach(el => {
    if (user) {
      el.textContent = user.email;
      el.style.display = 'inline-block';
    } else {
      el.style.display = 'none';
    }
  });
}

// ── Auth tab switching ────────────────────────────────────────────────

let _sbCurrentTab = 'in'; // 'in' | 'up'

function sbSwitchTab(tab) {
  _sbCurrentTab = tab;
  document.getElementById('sb-auth-msg').textContent = '';
  document.getElementById('sb-tab-in').classList.toggle('active', tab === 'in');
  document.getElementById('sb-tab-up').classList.toggle('active', tab === 'up');
  document.getElementById('sb-submit-btn').textContent = tab === 'up' ? 'Create account' : 'Sign in';
}

// ── Email + password sign-in / sign-up ────────────────────────────────

async function sbHandleAuthSubmit() {
  const email    = (document.getElementById('sb-email-input')?.value    || '').trim();
  const password = (document.getElementById('sb-password-input')?.value || '').trim();
  const btn      = document.getElementById('sb-submit-btn');
  const msg      = document.getElementById('sb-auth-msg');

  if (!email || !email.includes('@')) { msg.textContent = 'Please enter a valid email.'; msg.style.color = '#d00'; return; }
  if (password.length < 6)            { msg.textContent = 'Password must be at least 6 characters.'; msg.style.color = '#d00'; return; }

  btn.disabled    = true;
  btn.textContent = _sbCurrentTab === 'up' ? 'Creating…' : 'Signing in…';
  msg.textContent = '';

  try {
    if (_sbCurrentTab === 'up') {
      const { error } = await _sb.auth.signUp({ email, password });
      if (error) throw error;
      msg.textContent = '✅ Account created! Check your email to confirm, then sign in.';
      msg.style.color = '#2a9d5c';
      sbSwitchTab('in');
    } else {
      const { error } = await _sb.auth.signInWithPassword({ email, password });
      if (error) throw error;
      // onAuthStateChange will fire and handle the rest
    }
  } catch (err) {
    msg.textContent = err.message || 'Something went wrong. Please try again.';
    msg.style.color = '#d00';
  }
  btn.disabled    = false;
  btn.textContent = _sbCurrentTab === 'up' ? 'Create account' : 'Sign in';
}

// ── Skip / sign out ───────────────────────────────────────────────────

function sbSkipAuth() {
  _hideAuthOverlay();
  if (typeof showSimpleToast === 'function') showSimpleToast('Offline mode — data stays on this device only 📱');
}

// Called by the ☁ button in the header
async function sbTriggerSync() {
  if (!_syncEnabled) { if (typeof showSimpleToast === 'function') showSimpleToast('Sign in to sync ☁️'); return; }
  await _doSync();
}

// ── Sync helpers (shared by pull-to-refresh and sync button) ──────────

async function _doSync() {
  _setSyncBtn('⟳', 'Syncing…', '#7B4FD8');
  const pulled = await _pullFromSupabase(true); // force=true: always apply cloud data on manual sync
  if (pulled) {
    if (typeof patterns !== 'undefined') {
      patterns   = JSON.parse(localStorage.getItem('crochet_patterns_v2') || '[]');
      nextPatId  = patterns.length ? Math.max(...patterns.map(p => p.id)) + 1 : 5;
    }
    if (typeof projects !== 'undefined') {
      projects   = JSON.parse(localStorage.getItem('crochet_projects_v1') || '[]');
      nextProjId = projects.length ? Math.max(...projects.map(p => p.id)) + 1 : 1;
    }
    if (typeof renderProjects === 'function') renderProjects();
    if (typeof renderLibrary  === 'function') renderLibrary();
    if (typeof showSimpleToast === 'function') showSimpleToast('☁️ Synced!');
  } else {
    if (typeof showSimpleToast === 'function') showSimpleToast('✓ Already up to date');
  }
  _setSyncBtn('☁', 'Synced', '#2a9d5c');
}

function _setSyncBtn(icon, title, color) {
  document.querySelectorAll('.sb-sync-btn').forEach(btn => {
    btn.textContent = icon;
    btn.title       = title;
    btn.style.color = color;
    btn.classList.toggle('synced', color === '#2a9d5c');
    btn.classList.toggle('error',  color === '#e05');
  });
}

// ── Sync button injected into every app header ────────────────────────

function _injectSyncButtons() {
  document.querySelectorAll('.app-header-side:first-child').forEach(side => {
    if (side.querySelector('.sb-sync-btn')) return; // already added
    const btn = document.createElement('button');
    btn.className   = 'sb-sync-btn';
    btn.textContent = '☁';
    btn.title       = 'Tap to sync';
    btn.setAttribute('aria-label', 'Sync now');
    Object.assign(btn.style, {
      background:   'none',
      border:       'none',
      fontSize:     '1.2rem',
      color:        '#bbb',
      cursor:       'pointer',
      padding:      '0.25rem',
      lineHeight:   '1',
      marginLeft:   '0.25rem'
    });
    btn.addEventListener('click', async () => {
      if (!_syncEnabled) {
        if (typeof showSimpleToast === 'function') showSimpleToast('Sign in to sync ☁️');
        return;
      }
      await _doSync();
    });
    side.appendChild(btn);
  });
}

// ── Pull-to-refresh (simple & reliable) ──────────────────────────────

function _initPullToRefresh() {
  const THRESHOLD = 80;
  let startY = 0;

  // Pill that appears at top after a successful pull
  const pill = document.createElement('div');
  pill.id = 'sb-ptr-pill';
  Object.assign(pill.style, {
    position:     'fixed',
    top:          '0.75rem',
    left:         '50%',
    transform:    'translateX(-50%) translateY(-120%)',
    background:   '#7B4FD8',
    color:        '#fff',
    fontSize:     '0.82rem',
    fontWeight:   '600',
    padding:      '0.45rem 1.1rem',
    borderRadius: '2rem',
    zIndex:       '1500',
    transition:   'transform 0.25s ease',
    pointerEvents:'none',
    whiteSpace:   'nowrap'
  });
  document.body.appendChild(pill);

  function _showPill(text) {
    pill.textContent = text;
    pill.style.transform = 'translateX(-50%) translateY(0)';
    setTimeout(() => { pill.style.transform = 'translateX(-50%) translateY(-120%)'; }, 2000);
  }

  document.addEventListener('touchstart', e => {
    startY = e.touches[0].clientY;
  }, { passive: true });

  document.addEventListener('touchend', async e => {
    if (!_syncEnabled) return;
    const dy = e.changedTouches[0].clientY - startY;
    if (dy < THRESHOLD) return;

    // Only fire if the user is at the top of the scrollable area
    const activeScreen = document.querySelector('.screen.on');
    const scrollable   = activeScreen?.querySelector('.list-pad') || activeScreen;
    if (scrollable && scrollable.scrollTop > 10) return;

    _showPill('⟳  Syncing…');
    const pulled = await _pullFromSupabase(true); // force=true: always apply cloud data on pull-to-refresh
    if (pulled) {
      if (typeof patterns !== 'undefined') {
        patterns   = JSON.parse(localStorage.getItem('crochet_patterns_v2') || '[]');
        nextPatId  = patterns.length ? Math.max(...patterns.map(p => p.id)) + 1 : 5;
      }
      if (typeof projects !== 'undefined') {
        projects   = JSON.parse(localStorage.getItem('crochet_projects_v1') || '[]');
        nextProjId = projects.length ? Math.max(...projects.map(p => p.id)) + 1 : 1;
      }
      if (typeof renderProjects === 'function') renderProjects();
      if (typeof renderLibrary  === 'function') renderLibrary();
      _showPill('✓  Synced!');
    } else {
      _showPill('✓  Up to date');
    }
  }, { passive: true });
}

// ── App init ──────────────────────────────────────────────────────────

async function initSupabase() {
  if (!_initSupabaseClient()) return; // config not ready → offline mode

  // React to sign-in / sign-out events (also fires on page load with existing session)
  _sb.auth.onAuthStateChange(async (event, session) => {
    _currentUser = session?.user || null;

    if (_currentUser) {
      _syncEnabled = true;
      _hideAuthOverlay();
      _updateUserChip(_currentUser);

      // Reflect sync state in the avatar dot immediately — otherwise it stays
      // gray (the default CSS state) until the pull below finishes, which on
      // a slow mobile connection can be several seconds.
      _updateAvatarDot('syncing');

      // Pull from cloud, then reload app state from localStorage
      const pulled = await _pullFromSupabase();
      if (pulled) {
        // Reload global arrays that app.js uses
        if (typeof patterns !== 'undefined') {
          patterns = JSON.parse(localStorage.getItem('crochet_patterns_v2') || '[]');
          nextPatId = patterns.length ? Math.max(...patterns.map(p => p.id)) + 1 : 5;
        }
        if (typeof projects !== 'undefined') {
          projects = JSON.parse(localStorage.getItem('crochet_projects_v1') || '[]');
          nextProjId = projects.length ? Math.max(...projects.map(p => p.id)) + 1 : 1;
        }
        if (typeof renderProjects === 'function') renderProjects();
        if (typeof renderLibrary  === 'function') renderLibrary();
        if (typeof showSimpleToast === 'function') showSimpleToast('☁️ Synced from cloud!');
      } else {
        // Pull was skipped (local is up to date) — push local up only if it actually has data
        const localPatterns = JSON.parse(localStorage.getItem('crochet_patterns_v2') || '[]');
        const localProjects = JSON.parse(localStorage.getItem('crochet_projects_v1') || '[]');
        if (localPatterns.length > 0 || localProjects.length > 0) {
          console.log('[Sync] Local has data, pushing to cloud');
          await _pushToSupabase(); // await so the dot only goes green once upload is done
        } else {
          console.log('[Sync] Local is empty — skipping push to protect cloud data');
        }
      }
      _updateSyncBadge(true);
      _updateAvatarDot('synced');
    } else {
      // SIGNED_OUT — reset everything and force the login screen
      _syncEnabled = false;
      _updateSyncBadge(false);
      _updateAvatarDot('offline');
      _updateUserChip(null);
      _showAuthOverlay();
    }
  });

  // Check whether there's already an active session (e.g. returning user)
  const { data: { session } } = await _sb.auth.getSession();
  if (!session) {
    _showAuthOverlay();
  }


  // ── Pull fresh data whenever the user switches back to the app ────
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'visible' && _syncEnabled) {
      const pulled = await _pullFromSupabase();
      if (pulled) {
        if (typeof patterns !== 'undefined') {
          patterns   = JSON.parse(localStorage.getItem('crochet_patterns_v2') || '[]');
          nextPatId  = patterns.length ? Math.max(...patterns.map(p => p.id)) + 1 : 5;
        }
        if (typeof projects !== 'undefined') {
          projects   = JSON.parse(localStorage.getItem('crochet_projects_v1') || '[]');
          nextProjId = projects.length ? Math.max(...projects.map(p => p.id)) + 1 : 1;
        }
        if (typeof renderProjects === 'function') renderProjects();
        if (typeof renderLibrary  === 'function') renderLibrary();
      }
    }
  });
}
