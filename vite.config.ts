import { readdirSync, existsSync } from 'node:fs';
import { resolve, posix } from 'node:path';
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
  const ENDPOINT = '/brand/manifest.json';
  const EXTS = new Set(['.png', '.webp', '.svg']);

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
        const path = (req.url ?? '').split('?')[0];
        if (path !== ENDPOINT) { next(); return; }
        const files = scan(brandDir).sort();
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        res.end(JSON.stringify({ files }));
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
