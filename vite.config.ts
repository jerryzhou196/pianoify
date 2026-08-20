import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

/**
 * The dev server proxies the two backends rather than calling them directly.
 *
 * Both are CORS-gated on exact origins — the GPU box lists the deployed site
 * and nothing else — so a browser on `localhost:5173` would be refused at the
 * preflight. Proxying makes the requests same-origin from the browser's point
 * of view and server-to-server from the backend's, where CORS does not apply,
 * so local development needs no change to a live deployment's allowlist.
 *
 * `src/config.ts` resolves `VITE_*_API_BASE` to `""` when the variable is set
 * but empty, which is what turns every URL into the relative path this proxy
 * is keyed on. `.env.development` does exactly that.
 */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const transcribe = env.DEV_TRANSCRIBE_BACKEND ?? "https://muscriptor-api.jerryzhou.ca";
  const chords = env.DEV_CHORD_BACKEND ?? "https://jerrdeh-muscriptor-chords.hf.space";
  const forward = (target: string) => ({ target, changeOrigin: true, secure: true });

  return {
    plugins: [react()],
    server: {
      proxy: {
        "/transcribe": forward(transcribe),
        "/soundfonts": forward(transcribe),
        "/instruments": forward(transcribe),
        "/health": forward(transcribe),
        "/analyze": forward(chords),
      },
    },
    build: { outDir: "dist", emptyOutDir: true },
  };
});
