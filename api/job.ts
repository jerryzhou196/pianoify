/**
 * POST /api/job   — start a transcription of an already-uploaded asset.
 * GET  /api/job?id=… — how that transcription is going.
 *
 * The async endpoint rather than `/sync`, for two reasons. Transcription runs
 * at roughly 1.5× realtime, so a two-minute clip would hold a function open for
 * three minutes and a longer one would hit the platform's ceiling outright;
 * and a job that is still running reports `progress_percent` and the notes it
 * has decoded so far, which is what lets the roll fill in while the model is
 * still working instead of staying empty until the end.
 */
import { INSTRUMENTS, json, mirelo, query, readJson, route } from "./_mirelo.js";

const BASE = "/v2/audio-to-midi/v1.0";

/** How note times are written. `performance` keeps the take as played;
 *  `quantized` snaps onsets to the detected beats — and is honoured only when
 *  the grid it found is steady enough to move notes onto, so the response's
 *  `timing.applied` is the one worth reading. */
const TIMING = new Set(["performance", "quantized"]);

/** A job id as Mirelo writes them: a hex digest. Validated rather than
 *  interpolated blind, because it lands in a URL path. */
const JOB_ID = /^[a-zA-Z0-9_-]{8,128}$/;

export default route({
  POST: async (req, res) => {
    const body = await readJson(req);
    const assetId = String(body.asset_id ?? "");
    if (!assetId) {
      json(res, 400, { error: "asset_id is required — open a slot with POST /api/asset first" });
      return;
    }
    const timing = String(body.timing ?? "performance");
    if (!TIMING.has(timing)) {
      json(res, 400, { error: `timing must be performance or quantized, got "${timing}"` });
      return;
    }

    const job = await mirelo(`${BASE}/jobs`, {
      method: "POST",
      body: {
        audio: { type: "asset", asset_id: assetId },
        instruments: [...INSTRUMENTS],
        timing,
      },
    });
    json(res, 200, {
      job_id: job.job_id,
      estimated_ms: job.estimated_ms ?? null,
    });
  },

  GET: async (req, res) => {
    const id = query(req).get("id") ?? "";
    if (!JOB_ID.test(id)) {
      json(res, 400, { error: "id must be a job id from POST /api/job" });
      return;
    }
    // Forwarded whole: `status`, `progress_percent`, and — while the job is
    // still running — whatever `result.notes` has been decoded so far. The
    // client decides what to draw from it.
    json(res, 200, await mirelo(`${BASE}/jobs/${id}`));
  },
});
