# Supabase Setup Guide — Crochet Corner

Follow these steps once and your app will sync across all your devices.

---

## Step 1 — Create a Supabase project

1. Go to [supabase.com](https://supabase.com) and sign in.
2. Click **New project**.
3. Give it a name (e.g. `crochet-corner`), choose a region close to you, and set a database password.
4. Click **Create new project** and wait ~1 minute for it to spin up.

---

## Step 2 — Create the database table

1. In your Supabase project, click **SQL Editor** in the left sidebar.
2. Click **New query** and paste in the following SQL, then click **Run**:

```sql
-- Table that holds each user's complete app data
CREATE TABLE user_data (
  user_id    UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  data       JSONB NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Row Level Security: each user can only see and edit their own row
ALTER TABLE user_data ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage their own data"
  ON user_data FOR ALL
  USING      (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);
```

You should see **Success. No rows returned** — that's correct.

---

## Step 3 — Allow your app's URL as a redirect

Magic links redirect back to your app after sign-in. You need to tell Supabase which URLs are allowed.

1. Go to **Authentication → URL Configuration** in the sidebar.
2. Under **Redirect URLs**, add the URL you use to open your app, e.g.:
   - `http://127.0.0.1:5500` (local Live Server)
   - `http://localhost:5500`
   - Your GitHub Pages URL if you've deployed it (e.g. `https://yourusername.github.io/crochet-app`)
3. Click **Save**.

---

## Step 4 — Copy your API credentials

1. Go to **Project Settings → API** in the sidebar.
2. Copy the **Project URL** (looks like `https://abcdefgh.supabase.co`).
3. Copy the **anon / public** key (a long string starting with `eyJ…`).

---

## Step 5 — Paste credentials into the app

Open `supabase-config.js` in your code editor and replace the placeholder values:

```js
const SUPABASE_URL      = 'https://YOUR_PROJECT.supabase.co';  // ← paste here
const SUPABASE_ANON_KEY = 'eyJ...YOUR_KEY...';                  // ← paste here
```

Save the file.

---

## Step 6 — Test it

1. Open the app in your browser (`http://127.0.0.1:5500`).
2. You should see a **"Sync across devices"** sign-in screen.
3. Enter your email and tap **Send magic link**.
4. Check your email, click the link — you'll be redirected back to the app and signed in.
5. Your data will sync automatically from now on. ☁️

---

## How sync works

| Action | What happens |
|---|---|
| Sign in on a new device | Your patterns & projects are pulled from the cloud |
| Add/edit a pattern or project | Saved locally first, then pushed to cloud ~2 sec later |
| Check step progress | Synced to cloud automatically |
| Open app on another device | Latest data is fetched on load |
| Use without signing in | Everything stays on the device only (local mode) |

---

## Troubleshooting

**"Magic link sent" but nothing arrives** — Check your spam folder. Also make sure the email you entered is correct.

**Redirect goes to a blank page** — Make sure the URL you added in Step 3 exactly matches the URL in your browser bar (including the port number).

**Data doesn't appear on second device** — Sign in on the second device, then refresh. The pull happens automatically after sign-in.

**Want to sign out?** — Call `supabaseSignOut()` from the browser console, or we can add a sign-out button to the app.
