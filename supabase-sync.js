// ── Supabase Sync ─────────────────────────────────────────────────────
// Magic-link auth + cloud sync for Crochet Corner
// Loaded after supabase-config.js and the Supabase CDN script.

let _sb           = null;   // Supabase client instance
let _currentUser  = null;   // Logged-in user object (or null)
let _syncTimer    = null;   // Debounce timer handle
let _syncEnabled  = false;  // True once client is ready and user is signed in

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
  _sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  return true;
}

// ── Auth ──────────────────────────────────────────────────────────────

async function sendMagicLink(email) {
  const { error } = await _sb.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: window.location.href }
  });
  if (error) throw error;
}

async function supabaseSignOut() {
  if (!_sb) return;
  await _sb.auth.signOut();
  _currentUser = null;
  _syncEnabled = false;
  _showAuthOverlay();
  _updateSyncBadge(false);
  _updateUserChip(null);
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
  try {
    const payload = {
      user_id:    _currentUser.id,
      data:       _gatherAllData(),
      updated_at: new Date().toISOString()
    };
    const { error } = await _sb
      .from('user_data')
      .upsert(payload, { onConflict: 'user_id' });
    if (error) throw error;
    _updateSyncBadge(true);
  } catch (err) {
    console.error('[Sync] Push failed:', err);
    _updateSyncBadge(false);
  }
}

async function _pullFromSupabase() {
  if (!_sb || !_currentUser) return false;
  try {
    const { data: row, error } = await _sb
      .from('user_data')
      .select('data')
      .eq('user_id', _currentUser.id)
      .maybeSingle();
    if (error) throw error;
    if (row && row.data) {
      _applyDataToLocalStorage(row.data);
      return true;
    }
    return false;
  } catch (err) {
    console.error('[Sync] Pull failed:', err);
    return false;
  }
}

// ── Debounced sync (called after every local save) ────────────────────

function queueSupabaseSync() {
  if (!_syncEnabled) return;
  clearTimeout(_syncTimer);
  _syncTimer = setTimeout(_pushToSupabase, 2000);
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

// Called by the "Send magic link" button in the auth overlay
async function sbHandleAuthSubmit() {
  const emailInput = document.getElementById('sb-email-input');
  const btn        = document.getElementById('sb-submit-btn');
  const msg        = document.getElementById('sb-auth-msg');
  const email      = (emailInput?.value || '').trim();

  if (!email || !email.includes('@')) {
    msg.textContent = 'Please enter a valid email address.';
    msg.style.color = '#d00';
    return;
  }

  btn.disabled    = true;
  btn.textContent = 'Sending…';
  msg.textContent = '';

  try {
    await sendMagicLink(email);
    msg.textContent = '✉️ Check your email and tap the magic link!';
    msg.style.color = '#2a9d5c';
    btn.textContent = 'Resend link';
    btn.disabled    = false;
  } catch (err) {
    msg.textContent = 'Couldn\'t send the link. Please try again.';
    msg.style.color = '#d00';
    btn.textContent = 'Send magic link';
    btn.disabled    = false;
  }
}

// Called by the "Continue without signing in" button
function sbSkipAuth() {
  _hideAuthOverlay();
  if (typeof showSimpleToast === 'function') {
    showSimpleToast('Offline mode — data stays on this device only 📱');
  }
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
        // No cloud data yet — push local data up
        _pushToSupabase();
      }
      _updateSyncBadge(true);
    } else {
      _syncEnabled = false;
      _updateSyncBadge(false);
      _updateUserChip(null);
    }
  });

  // Check whether there's already an active session (e.g. returning user)
  const { data: { session } } = await _sb.auth.getSession();
  if (!session) {
    _showAuthOverlay();
  }
}
