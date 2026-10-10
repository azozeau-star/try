# Deploy Sami Says — user website + developer dashboard

## Why the old deployment broke

This project has two parts:
- `docs/`: HTML, images and browser JavaScript.
- `server.js`: Node.js API, account storage, developer authentication and Socket.IO live chat.

Publishing only HTML does not start `server.js`. The original `docs/config.js` was empty, so login requests went to the static website instead of a backend. The original developer HTML was generated only inside `server.js`, so static hosting could not serve it. GitHub Pages also needs the correct publishing folder and repository URL.

The corrected folder contains a static developer page, a shared connection client, cross-domain sessions, Netlify build settings, and a backend health check.

## Existing repository with only project_fixed.zip

The included `.github/workflows/static.yml` also supports a repository that contains only this ZIP. Replace the repository's existing `static.yml` with the included version, set Pages Source to **GitHub Actions**, and commit. The workflow extracts the ZIP during deployment and uploads only `project/docs`, fixing the missing entry page. It also works if you upload the extracted source files.

After deploying the backend, you can set a GitHub repository Actions variable named `SAMI_BACKEND_URL` to its public HTTPS origin and rerun the workflow. The backend must allow `https://azozeau-star.github.io` in `STATIC_SITE_ORIGIN`. This workflow publishes the frontend only.

## Option 1: One Node.js service (fewest settings)

This hosts BOTH pages and the backend together; Netlify/GitHub Pages are optional.

1. Put the CONTENTS of this `project` folder at the root of a GitHub repository. `package.json`, `server.js` and `docs/` should be visible at the repository root. If you keep an outer `project/` folder, set your hosting service's Root Directory to `project`.
2. In Render, choose **New → Web Service**, and connect the repository.
3. Set Build Command to `npm ci`, Start Command to `npm start`, and Health Check Path to `/api/health`.
4. In the service Environment settings, add:

   | Variable | Value |
   | --- | --- |
   | `ADMIN_PASSWORD` | A long password YOU choose for developer login |
   | `GROQ_API_KEY` | Your Groq key, for AI responses |
   | `NODE_ENV` | `production` |

   Leave `STATIC_SITE_ORIGIN` unset for this option. Keep `docs/config.js` empty (`window.SAMI_BACKEND_URL = '';`). The server and both pages share one domain.
5. Deploy. Open:
   - User website: `https://YOUR-SERVICE.onrender.com/`
   - Developer page: `https://YOUR-SERVICE.onrender.com/developer/`
   - Health check: `https://YOUR-SERVICE.onrender.com/api/health`
6. Create a user account on the user website. Sign in to `/developer/` with `ADMIN_PASSWORD`. These are separate roles. The dashboard shows saved conversations even after users sign out. For testing, use a second browser, browser profile, or private window for the developer, so the two logins do not overwrite the same cookie.

`render.yaml` is an optional Blueprint alternative; manual Web Service setup above is sufficient.

### Developer visibility

Developers can reply to saved conversations while users are offline. The server saves each reply before confirming it, delivers it immediately to any connected sessions, and includes it in the user's chat history on their next connection. The dashboard keeps the draft if saving fails or confirmation times out. AI takeover controls apply only while a user is online.

The main conversation list hides accounts 14 days after their last successful sign-in. Signing in again returns an inactive account to the main list without changing its saved chat history. Older accounts without a recorded sign-in date get an initial 14-day window; optionally set `LOGIN_TRACKING_STARTED_AT` to the rollout timestamp in milliseconds to keep that baseline consistent when restoring old backups.

Each visible user has a `حذف` button that only hides the user from the developer's main list. It does not delete the account, password, or messages, and does not block sign-in. Manually hidden users remain hidden after signing in and can be restored from the `المخفية` tab. Inactivity still applies after restoring a manually hidden account. Open dashboards refresh the inactivity filter every minute.

Sign-in dates and visibility settings are stored in the same account database as the chats and require persistent storage to survive instance replacement.

### Neon database (configured production storage)

Production uses Neon PostgreSQL for users, password hashes, saved conversations, developer visibility, sign-in dates, and session hashes. Set `DATABASE_URL` privately on Render to the pooled Neon connection string, with TLS verification enabled. The browser never receives the connection string. With this variable set, the app uses PostgreSQL exclusively and fails startup if the database/schema is unavailable; it never falls back to temporary files or reimports an old snapshot.

Schema changes are tracked in `migrations/001-storage.sql`. On a fresh database, set a private direct `DATABASE_URL_UNPOOLED` and run `npm run db:migrate`. To import an existing private JSON backup, run `npm run db:migrate -- /absolute/path/accounts.json`. The import is transactional, preserves IDs/password hashes/history/visibility, ignores old sessions, and does not overwrite existing accounts or newer messages if repeated. Test migrations on a separate Neon branch first. Never publish backups or either connection URL.

Render may still sleep or restart on the free plan; PostgreSQL storage stays separate from those instances. Users receive saved offline replies when they reconnect. Messages are appended atomically so concurrent replies do not overwrite one another. The app confirms writes only after the database saves them and keeps browser drafts when confirmation fails. Free hosting/database usage limits still apply.

For local development, leaving `DATABASE_URL` unset retains the original JSON file storage. `npm test` checks both the app flows and PostgreSQL migration/storage operations using a local PostgreSQL engine.

### JSON storage alternative

When `DATABASE_URL` is unset, the app uses a JSON file. Render's free service has ephemeral storage: accounts/chats can disappear after redeployment or replacement of the instance.

To restore an existing account backup on an empty instance, set `INITIAL_DATA_JSON` privately in the backend's environment to the JSON account database. Never commit this value, password hashes, or chat history to GitHub. The server preserves existing files, imports the backup only when the data file is absent, and discards old sessions so users must sign in again. This restores the original snapshot after a reset; newer accounts and messages still require persistent storage.

For this single-instance project, attach a persistent disk on a Render plan that supports it:
- Mount path: `/opt/render/project/src/storage`
- Environment variable: `DATA_DIRECTORY=/opt/render/project/src/storage`

The server writes `accounts.json` there. Run only one instance against this JSON database. For a larger production app, migrate the account/chat storage to a managed database.

## Option 2: Netlify frontend + Node.js backend

Netlify publishes `docs/`. The Express/Socket.IO service must remain hosted separately, for example using Option 1 on Render.

1. Deploy the backend first and copy its HTTPS service URL, e.g. `https://YOUR-SERVICE.onrender.com`.
2. Import the repository into Netlify. If the files are inside a `project/` folder in the repository, set Netlify's Base directory to `project`. Otherwise leave Base directory empty.
3. The included `netlify.toml` sets:
   - Build command: `npm run build`
   - Publish directory: `docs`
4. In Netlify Environment variables, add:
   - `SAMI_BACKEND_URL=https://YOUR-SERVICE.onrender.com`
5. In the BACKEND's Environment settings, add:
   - `STATIC_SITE_ORIGIN=https://YOUR-SITE.netlify.app`
6. Redeploy the backend and Netlify after setting these values. Open:
   - User website: `https://YOUR-SITE.netlify.app/`
   - Developer page: `https://YOUR-SITE.netlify.app/developer/`

The frontend build intentionally fails if `SAMI_BACKEND_URL` is missing on Netlify, instead of publishing a broken login page. For a manual drag-and-drop deploy, first set `docs/config.js` as shown in Option 3, then drag the `docs` folder, not the whole backend project. You still need the running backend and its allowed-origin setting.

## Option 3: GitHub Pages frontend + Node.js backend

1. Deploy the backend using Option 1.
2. Edit `docs/config.js` and commit this public value:

   ```js
   window.SAMI_BACKEND_URL = 'https://YOUR-SERVICE.onrender.com';
   ```

3. In the BACKEND's Environment settings, set:
   - `STATIC_SITE_ORIGIN=https://YOUR-GITHUB-USERNAME.github.io`
   - Use the origin only; do NOT append `/YOUR-REPOSITORY`.
4. In the GitHub repository, go to **Settings → Pages**:
   - Source: **Deploy from a branch**
   - Branch: `main` (or the branch containing your files)
   - Folder: `/docs`
5. Wait for the Pages deployment to succeed, then open the URL shown by GitHub:
   - User website: `https://YOUR-GITHUB-USERNAME.github.io/YOUR-REPOSITORY/`
   - Developer page: `https://YOUR-GITHUB-USERNAME.github.io/YOUR-REPOSITORY/developer/`

For a repository named `YOUR-GITHUB-USERNAME.github.io`, the repository path is omitted. If `docs/` is nested in an outer `project/` folder, move the project contents to the repository root before selecting `/docs`.

### Using both static hosts

Set the backend variable to both origins, separated by a comma:

```text
STATIC_SITE_ORIGIN=https://YOUR-GITHUB-USERNAME.github.io,https://YOUR-SITE.netlify.app
```

Cross-domain authentication uses an opaque session token in the browser tab's session storage and Socket.IO authentication. It does not depend on third-party cookies. Same-domain hosting uses an HttpOnly cookie. Sign in again if you close a cross-domain tab. The developer login remains protected by the backend password.

## Local setup / applying the fix to your existing folder

The ZIP is suitable for uploading source files; it excludes real keys, account data and `node_modules`.

1. Back up your original folder. Copy the corrected source files over it, preserving your private `.env` and `.data/` files. Or extract into a new folder and privately copy `.env` and `.data/` from the original.
2. Open a terminal in `project` and run:

   ```text
   npm ci
   npm start
   ```

3. If starting fresh, copy `.env.example` to `.env` and fill in `ADMIN_PASSWORD` and, optionally, `GROQ_API_KEY`. Default port is 3000; with the example `.env` it is 3002.
4. Open `http://localhost:3002/` and `http://localhost:3002/developer/` (use the port printed by the server).
5. Use `npm test` for the bundled deployment/authentication tests.

Do not open `index.html` directly with `file://` for login/chat. A static preview or VS Code Live Server also needs `docs/config.js` pointed at the running Node.js service and that preview origin allowed on the backend.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| GitHub Pages 404 | Correct branch, `/docs` source, successful Pages deployment, exact URL with repository name |
| Netlify deployment fails with missing backend URL | Set `SAMI_BACKEND_URL` in Netlify and redeploy |
| Login error says backend is not connected | `/api/me` is returning HTML; check `docs/config.js` and deployed backend |
| Network/CORS error | Backend must be running with HTTPS; add the exact frontend origin to `STATIC_SITE_ORIGIN`, then restart/redeploy |
| Site works on Render but not Netlify | Netlify needs its own `SAMI_BACKEND_URL`; backend must allow the Netlify origin |
| Developer login unavailable | Set `ADMIN_PASSWORD` on the backend; a user's email/password does not grant developer access |
| No users in dashboard | Sign in on the user page in another browser/profile and wait for chat connection |
| AI is unavailable | Set `GROQ_API_KEY` on the backend; check backend logs and that `GROQ_MODEL` is supported by your Groq account |
| Accounts disappear after deploy | Configure persistent storage as described above |
| Slow first connection | The free backend may be starting after sleeping; wait and retry |

## Files changed

- `server.js`: allowed frontend origins, cross-domain sessions, proxy-aware cookies, configurable persistent data directory, health endpoint and configurable AI model.
- `docs/developer/index.html`: developer dashboard available to static hosts.
- `docs/client.js`: shared API/session/Socket.IO connection handling.
- `docs/index.html`: shared client, clearer connection errors, developer link and disconnected-send guard.
- `netlify.toml`, `scripts/build-static.js`, `render.yaml`: deployment setup.
- `.env.example`, `.gitignore`, `.nojekyll`, `package.json`, `package-lock.json`, `tests/deployment.test.js`: supporting configuration and tests.
- Root `index.html`: redirects to the actual frontend instead of using missing root-level assets.

Never upload `.env`, `.data/` or `node_modules/` to a public repository or a static-host publish directory. If a real API key was already committed publicly, replace it in the provider dashboard.

## Official references

- GitHub Pages: https://docs.github.com/en/pages/getting-started-with-github-pages/creating-a-github-pages-site
- Netlify configuration: https://docs.netlify.com/build/configure-builds/file-based-configuration/
- Render Node deployment: https://render.com/docs/deploy-node-express-app
- Render persistent disks: https://render.com/docs/disks
- Groq models: https://console.groq.com/docs/models
