import type { IncomingMessage, ServerResponse } from "node:http";
import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

/**
 * The dev server stands in for Vercel.
 *
 * Two things have to work locally that a plain static server does not give us:
 *
 *   `/api/*` — the functions in `api/` hold `MIRELO_KEY`, so they cannot be
 *   proxied to production and cannot run in the browser. They are written
 *   against `node:http` types, which is the signature Vercel's Node runtime
 *   and Connect (what Vite's dev server is) both satisfy, so the same files
 *   run in both places. `ssrLoadModule` compiles the TypeScript and picks up
 *   edits without a restart.
 *
 *   `/analyze` and `/ytdlp` — the chord Space and the self-hosted yt-dlp
 *   service are both CORS-gated on exact origins, and no localhost is in
 *   either allowlist. Proxying makes the request same-origin to the browser
 *   and server-to-server to the backend, where CORS does not apply. In
 *   production `vercel.json` rewrites `/ytdlp` the same way, so the app never
 *   appears in that service's allowlist at all.
 */
function devApi(): Plugin {
  const ROUTES: Record<string, string> = {
    "/api/asset": "/api/asset.ts",
    "/api/job": "/api/job.ts",
    "/api/preflight": "/api/preflight.ts",
    "/api/fetch": "/api/fetch.ts",
  };

  return {
    name: "pianoify-dev-api",
    configureServer(server) {
      server.middlewares.use(async (req: IncomingMessage, res: ServerResponse, next) => {
        const path = (req.url ?? "").split("?")[0];
        const file = ROUTES[path];
        if (!file) return next();
        try {
          const mod = await server.ssrLoadModule(file);
          await mod.default(req, res);
        } catch (e) {
          // A compile error in a handler would otherwise surface as a hung
          // request; say it in the response as well as the terminal.
          server.config.logger.error(`[api] ${path}: ${e}`);
          res.statusCode = 500;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
        }
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  // The key normally comes from the shell. Reading it out of a `.env.local`
  // too means `npm run dev` works in a terminal that never sourced a profile.
  if (!process.env.MIRELO_KEY && env.MIRELO_KEY) process.env.MIRELO_KEY = env.MIRELO_KEY;

  const chords = env.DEV_CHORD_BACKEND ?? "https://jerrdeh-muscriptor-chords.hf.space";
  const ytdlp = env.DEV_YTDLP_BACKEND ?? "https://jerryzhou.ca";

  return {
    plugins: [react(), devApi()],
    server: {
      proxy: {
        "/analyze": { target: chords, changeOrigin: true, secure: true },
        "/health": { target: chords, changeOrigin: true, secure: true },
        // The yt-dlp service. Proxied for the same reason as the chord Space —
        // its CORS allowlist is the slowedrvb origins — and with no timeout,
        // because a download runs at about half the video's own length.
        "/ytdlp": { target: ytdlp, changeOrigin: true, secure: true, timeout: 0, proxyTimeout: 0 },
      },
    },
    build: {
      outDir: "dist",
      emptyOutDir: true,
      rollupOptions: {
        output: {
          // The engraver is a megabyte of vendor code that only the sheet-music
          // tab ever needs; splitting it keeps it out of the first paint.
          manualChunks: (id) =>
            id.includes("opensheetmusicdisplay") ? "engraver" : undefined,
        },
      },
    },
  };
});
