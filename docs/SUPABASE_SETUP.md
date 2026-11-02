# Setting up accounts and access codes

This connects GridTheory to Supabase and turns on the invite-only gate. Until the two Vercel variables in step 4 are set, the site stays open with no accounts.

You'll need your Vercel site's address, which is written as `https://your-site.vercel.app` below.

## 1. Create the project

1. Create an account at [supabase.com](https://supabase.com) with two-factor login turned on.
2. Create a new project, in the region closest to your players.
3. Save the database password in a password manager. It can't be shown again.

## 2. Set the sign-in rules

In the project, under **Authentication**:

| Setting | Value |
| --- | --- |
| **Allow new users to sign up** | **Off.** This is the most important one. Access codes still work, because they create accounts on the server |
| Site URL | `https://your-site.vercel.app` |
| Redirect URLs | `https://your-site.vercel.app` |
| Minimum password length | 10 |
| Multi-factor authentication | TOTP (authenticator app) enabled |
| SMTP / email | Your own email provider, such as Resend. Supabase's built-in sender only allows a few emails an hour, so invites would fail without this |

## 3. Send the database and server function up

Run these in the project folder, one at a time. Find `YOUR_PROJECT_REF` in the project's settings or address bar.

```bash
npx supabase login
```

```bash
npx supabase link --project-ref YOUR_PROJECT_REF
```

```bash
npx supabase db push
```

```bash
npx supabase secrets set SITE_URL=https://your-site.vercel.app
```

```bash
npx supabase functions deploy redeem-invite
```

If the last command asks for Docker, add `--use-api` to it.

## 4. Connect the site

In Vercel, under **Settings → Environment Variables**, add these from Supabase's API settings:

| Name | Value |
| --- | --- |
| `VITE_SUPABASE_URL` | The project URL |
| `VITE_SUPABASE_ANON_KEY` | The **anon** or **publishable** key |

**Never use the `service_role` or secret key here.** It bypasses every rule in the database, and anything named `VITE_` is published. The build fails if it finds one.

Then deploy the `phase-4-backend` work. The gate is live from that deployment on.

## 5. Make yourself the admin

Admin rights can't be given from the site, by design.

1. In Supabase, go to **Authentication → Users → Add user**, and create your own account with a strong password, marked as confirmed.
2. Open the **SQL Editor**, and run this with your email:

```sql
select public.grant_admin('you@example.com');
```

3. Sign in on the site, and open **Admin** in the sidebar.
4. Set up two-factor login with an authenticator app. **Add the key to a second device or a password manager too**, because there are no recovery codes.

If you lose your authenticator, delete the factor in the SQL Editor, and set it up again:

```sql
delete from auth.mfa_factors where user_id = (select id from auth.users where email = 'you@example.com');
```

To take away admin rights from someone, including yourself:

```sql
delete from public.admins where user_id = (select id from auth.users where email = 'them@example.com');
```

## 6. Test it on the live site

Do these before giving anyone a code, because they're the checks that couldn't be run without your real project.

**As you:**
- [ ] Create a code in Admin, and use it in a private window with a second email address of yours
- [ ] The email arrives, its link opens the site, and you can set a password
- [ ] Use the same code again, and it's refused
- [ ] Make a move or finish a lesson, and check it appears on another device or browser

**Attack it as the second account:**
- [ ] Go to `#/admin`. It should say "Page not found"
- [ ] In the browser console, run the code below. It must fail with a "Not allowed" error
- [ ] Remove that account in Admin. On its next reload, it should see "No access"

```js
const auth = JSON.parse(localStorage[Object.keys(localStorage).find((k) => k.endsWith('auth-token'))]);
const { url, key } = { url: 'YOUR_SUPABASE_URL', key: 'YOUR_ANON_KEY' };
fetch(`${url}/rest/v1/rpc/admin_list_members`, { method: 'POST', headers: { apikey: key, Authorization: `Bearer ${auth.access_token}`, 'Content-Type': 'application/json' }, body: '{}' }).then((r) => r.json()).then(console.log);
```

**On the site:**
- [ ] No policy errors in the browser console
- [ ] [securityheaders.com](https://securityheaders.com) still shows the headers

## Backups

**Supabase's free plan has no automatic backups**, and pauses a project after about a week with no activity. Check its current plans, and move to a paid plan once people rely on the site. Until then, run this regularly and keep the file somewhere private:

```bash
npx supabase db dump --data-only -f gridtheory-backup.sql
```

**Never commit that file, or run it from a GitHub Action in this public repo.** It holds everyone's data, and Action outputs on public repos can be downloaded by anyone. Restore a backup into a test project at least once, because an untested backup might not work when you need it.

## If something goes wrong

- **A code or an admin account might be compromised:** revoke the code or delete the admin row above, then rotate the keys in Supabase's API settings.
- **The service role key might have leaked:** rotate it immediately in Supabase, then redeploy the function.
- **A person asks for their data to be deleted:** they can do it in Settings. To do it for them, delete their user under Authentication → Users. Everything else follows automatically.
