/**
 * POST /api/asset — measure one clip and open the slot it will be uploaded to.
 * The body is the WAV's leading bytes, `Content-Type: audio/wav`; the answer is
 * the asset id Mirelo will transcribe and the URL to PUT the audio at.
 *
 * The audio does not come through here, and for a while it did. Mirelo's asset
 * flow hands back a presigned S3 URL the browser can PUT to directly, and the
 * first version of this app used it — then the ten-second cap arrived, the cap
 * had to hold somewhere the browser could not reach around, and the only way
 * to know how long a clip is was to look at it. Ten seconds of mono PCM is
 * under a megabyte, so the detour cost nothing.
 *
 * Ten minutes is fifty megabytes, and a Vercel function refuses a request body
 * past 4.5MB — about fifty seconds of it. So the detour is over: the bytes go
 * back to travelling from the tab straight to storage, and what comes here
 * instead is the file's header, which is where its duration was written all
 * along. See `wavSeconds` for why a header is a measurement and not a promise.
 *
 * So: read the header, measure the clip from it, refuse it if it is too long,
 * and only then spend a slot.
 */
import { ApiError, MAX_CLIP_SECONDS, json, mirelo, readBody, route, throttle, wavSeconds } from "./_mirelo.js";

/** How much of the WAV to look at. The app's own encoder writes a 44-byte
 *  header and nothing else before the samples, but a file from elsewhere can
 *  carry `LIST`/`INFO` chunks ahead of `data`, and 128KB walks past any of
 *  them. It is also the ceiling: a body larger than this is not a header. */
const MAX_BYTES = 128 * 1024;

/** Nothing here waits on an upload any more — it is one small POST to Mirelo
 *  for a slot. The default would do; this says so. */
export const config = { maxDuration: 15 };

export default route({
  POST: async (req, res) => {
    // The credit spend is POST /api/job, but this is the door it opens.
    // Six clips in ten minutes is more than a sitting; a loop is not.
    throttle(req, "asset", 6, 10 * 60_000);
    const header = await readBody(req, MAX_BYTES);
    const seconds = wavSeconds(header);

    // A hair of tolerance: a crop of exactly the cap can land a sample or two
    // over once it has been cut on a frame boundary.
    if (seconds > MAX_CLIP_SECONDS + 0.05) {
      throw new ApiError(
        413,
        `that clip is ${Math.round(seconds)}s — mirelo transcribes at most ${MAX_CLIP_SECONDS / 60} minutes at a time`,
      );
    }
    if (seconds < 0.5) {
      throw new ApiError(400, "that clip is too short to transcribe");
    }

    const slot = await mirelo("/v2/assets", {
      method: "POST",
      body: { content_type: "audio/wav" },
    });

    json(res, 200, {
      asset_id: slot.asset_id,
      upload_url: slot.upload_url,
      seconds,
    });
  },
});
