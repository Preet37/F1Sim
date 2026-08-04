import { createReadStream, readdirSync, existsSync, statSync } from 'node:fs';
import { resolve, posix, sep } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

/**
 * The `public/brand/` index, served as one always-200 endpoint.
 *
 * WHY THIS EXISTS AT ALL. `src/render/BrandAssets.ts` resolves an asset slot to
 * `<team-id>/<slot>.png|webp|svg` and has to answer "is there a file here" for
 * slots that mostly have no file. Asking the network that question directly
 * means a 404 per candidate, and Chrome writes every failed subresource load to
 * the console — which five harnesses in `scripts/` already read as a failure
 * signal, and which on a build carrying no artwork at all would be 264 of them.
 * So the question is answered once, by the thing that can actually see the disk.
 *
 * ALWAYS 200, INCLUDING WHEN `public/brand/` DOES NOT EXIST — that case returns
 * `{"files":[]}`. That is what makes "delete the directory and the game is
 * unchanged" true at the network layer as well as in the painter: one request,
 * one success, no artwork, generated marks everywhere.
 *
 * Rescanned per request in dev rather than cached, so dropping a file into
 * `public/brand/ferrari/` and reloading is the whole workflow. There is no build
 * step for the user to run and no manifest for them to maintain.
 */
function brandManifest(): Plugin {
  const PREFIX = '/brand/';
  const ENDPOINT = '/brand/manifest.json';
  const EXTS = new Set(['.png', '.webp', '.svg']);
  const MIME: Record<string, string> = {
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
  };

  const scan = (dir: string, prefix = '', out: string[] = []): string[] => {
    if (!existsSync(dir)) return out;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const rel = prefix ? posix.join(prefix, entry.name) : entry.name;
      if (entry.isDirectory()) scan(resolve(dir, entry.name), rel, out);
      else if (EXTS.has(entry.name.slice(entry.name.lastIndexOf('.')).toLowerCase())) out.push(rel);
    }
    return out;
  };

  let brandDir = resolve(process.cwd(), 'public', 'brand');

  return {
    name: 'f1sim-brand-manifest',
    configResolved(config) {
      brandDir = resolve(config.publicDir || resolve(config.root, 'public'), 'brand');
    },
    // Registered directly rather than returned from a closure, so it runs
    // BEFORE vite's static handler for `public/`. A physical
    // `public/brand/manifest.json` a user happened to drop in must not shadow
    // the live scan.
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = decodeURIComponent((req.url ?? '').split('?')[0]);
        if (!path.startsWith(PREFIX)) { next(); return; }

        if (path === ENDPOINT) {
          const files = scan(brandDir).sort();
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.setHeader('Cache-Control', 'no-store');
          res.end(JSON.stringify({ files }));
          return;
        }

        // THE ARTWORK ITSELF IS SERVED HERE TOO, AND IT HAS TO BE.
        //
        // Vite keeps an in-memory Set of the files in `public/` scanned once at
        // server start, and its static middleware `next()`s straight past
        // anything not in that Set — the Set being kept current by the file
        // watcher. Harnesses in `scripts/` create their server with
        // `watch: null`, so a file dropped into `public/` while such a server is
        // running is INVISIBLE to it, the request falls through to the SPA html
        // fallback (which accepts `Accept: */*`, and `fetch` sends exactly
        // that), and the answer to a request for `badge.png` is **`index.html`
        // with a 200 and `Content-Type: text/html`**.
        //
        // That is not a hypothetical. It cost two rewrites of `BrandAssets
        // .decode`, because through an `<img>` the whole thing arrives as a
        // single `onerror` on a 200 response and reads exactly like a corrupt
        // file. `probe:assets` named it the moment the decoder was asked for a
        // reason: `element text/html 1509B /brand/__probe__/badge.png`.
        //
        // Serving it here is also simply right rather than a workaround: this
        // directory is the one place in the project whose whole purpose is that
        // a file appears the moment it is dropped in, and a cache refreshed
        // only by a watcher is the wrong mechanism for that. Dev only — a
        // production build copies `public/brand/` into `dist/` like any other
        // static file.
        const rel = path.slice(PREFIX.length);
        const file = resolve(brandDir, rel);
        if (!file.startsWith(brandDir + sep)) { next(); return; }
        if (!EXTS.has(file.slice(file.lastIndexOf('.')).toLowerCase())) { next(); return; }
        let size: number;
        try {
          const st = statSync(file);
          if (!st.isFile()) { next(); return; }
          size = st.size;
        } catch { next(); return; }
        res.statusCode = 200;
        res.setHeader('Content-Type', MIME[file.slice(file.lastIndexOf('.')).toLowerCase()]);
        res.setHeader('Content-Length', String(size));
        res.setHeader('Cache-Control', 'no-store');
        createReadStream(file).pipe(res);
      });
    },
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'brand/manifest.json',
        source: JSON.stringify({ files: scan(brandDir).sort() }),
      });
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [brandManifest()],
  server: { host: true, port: 5173 },
  build: {
    target: 'es2020',
    sourcemap: false,
    // Vite 8 bundles with rolldown, which does not accept the object form of
    // manualChunks. Three.js is a single large dependency and splitting it out
    // buys nothing here — the game needs all of it on the first screen anyway.
  },
});
