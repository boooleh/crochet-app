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

## Step 2b — Create the image storage bucket  ⚠️ REQUIRED FOR PHOTOS TO SYNC

Text (patterns, projects, steps) syncs through the table above. **Photos sync through a separate Storage bucket.** If this bucket is missing, photos only ever save on the device they were added to — this is the #1 cause of "images don't sync".

In the **SQL Editor**, run this query:

```sql
-- Create a public bucket for crochet images
insert into storage.buckets (id, name, public)
values ('crochet-images', 'crochet-images', true)
on conflict (id) do nothing;

-- Anyone can view images (bucket is public)
create policy "Public read crochet images"
  on storage.objects for select to public
  using (bucket_id = 'crochet-images');

-- Signed-in users can upload/update/delete only inside their own folder
create policy "Users upload own crochet images"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'crochet-images' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "Users update own crochet images"
  on storage.objects for update to authenticated
  using (bucket_id = 'crochet-images' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "Users delete own crochet images"
  on storage.objects for delete to authenticated
  using (bucket_id = 'crochet-images' and (storage.foldername(name))[1] = auth.uid()::text);
```

To confirm: go to **Storage** in the sidebar — you should now see a `crochet-images` bucket.

> After running this, sign out and back in on each device. Photos that were stuck on one device will then upload to the cloud automatically.

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

**Text syncs but photos don't** — The `crochet-images` Storage bucket is missing or has no policies. Run the SQL in **Step 2b**, then sign out and back in on each device so stuck photos upload.

**Want to sign out?** — Call `supabaseSignOut()` from the browser console, or we can add a sign-out button to the app.
