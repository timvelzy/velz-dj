# Deploying Velz DJ

Velz DJ is a **static site** — `npm run build` produces a self-contained
`dist/` (HTML + hashed JS/CSS + AudioWorklet chunks + PWA files). There is
no backend. One build runs everywhere because the Vite base is relative
(`./`): the same `dist/` works at a domain root or under a subpath.

## GitHub Pages (the default pipeline)

`.github/workflows/deploy.yml` builds on every push to `main` and deploys
`dist/` to GitHub Pages via the official Pages actions.

**One-time setup (Tim, repo admin):**
1. **Commit the workflow file.** `.github/workflows/deploy.yml` exists in
   this repo locally, but the assistant's git token lacks the `workflow`
   scope, so GitHub rejected it. From your own machine:
   `gh auth refresh -s workflow` once, then commit + push
   `.github/workflows/deploy.yml` — or paste its contents via the GitHub
   web UI (Add file → Create new file → `.github/workflows/deploy.yml`).
2. GitHub → `timvelzy/velz-dj` → **Settings → Pages**
3. **Build and deployment → Source: GitHub Actions**
4. Push to `main` (or run the workflow manually). The site appears at
   `https://timvelzy.github.io/velz-dj/`.

## The same build, other hosts

Point any static host at `dist/` as the publish/output directory, build
command `npm run build`:

- **Cloudflare Pages:** connect the repo, framework preset "Vite",
  build `npm run build`, output `dist`. Custom domains + HTTPS are
  automatic.
- **Netlify:** build `npm run build`, publish `dist` (or drag-and-drop
  the folder). No redirects config needed — it's a single-page app with
  no client-side routes.
- **Azure Static Web Apps:** app location `/`, output location `dist`,
  build `npm run build`.

## Custom domain + HTTPS (important)

Several browser APIs Velz DJ depends on require a **secure context**
(HTTPS, or `localhost`):

- **AudioWorklet** (time-stretch + recorder) — secure context
- **Web MIDI** (the S8) — secure context, Chromium only
- **File System Access** (streaming set recordings to disk) — secure
  context, Chromium only
- **PWA install + service worker** — secure context

GitHub Pages / Cloudflare / Netlify / Azure all serve HTTPS by default,
and custom domains get free certificates on each. On a custom domain,
set it in the host's dashboard and add the DNS records it shows you;
nothing in the app changes (relative base).

## Running a live set locally (recommended)

Hosting is for convenience; a live set shouldn't depend on venue WiFi:

1. Open the hosted site once on the performance laptop (Chrome/Edge).
   Click **Start the decks** once so the worklets get cached.
2. Install it: browser menu → **Install Velz DJ** (PWA). It now launches
   like a local app and loads fully offline.
3. Your Traktor collection and track peaks persist in IndexedDB; your
   audio files stay on disk where they always were.

Fallback if there's no hosted copy handy: `npm run dev` on
`http://localhost` is also a secure context and everything works.
