import type { IncomingMessage } from "node:http";
import { createClient, type SupabaseClient, type User } from "@supabase/supabase-js";
import { ApiError } from "./_mirelo.js";

/** The unauthenticated product stays exactly where it was: ten seconds. A
 *  signed-in account unlocks the model-specific limit in the browser, and this
 *  copy is the server-side boundary before Mirelo opens a billed upload slot. */
export const GUEST_CLIP_SECONDS = 10;

let client: SupabaseClient | null = null;

function authClient(): SupabaseClient {
  if (client) return client;
  const url = (process.env.VITE_SUPABASE_URL ?? "").trim();
  const publishableKey = (process.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? "").trim();
  if (!url || !publishableKey) {
    throw new ApiError(
      503,
      "account sign-in is not configured — add VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY",
    );
  }
  client = createClient(url, publishableKey, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
  });
  return client;
}

/** Validate a Supabase access token against the Auth server. Reading a client
 *  session is not enough at an API boundary; `getUser(token)` verifies the JWT
 *  and returns the current user rather than trusting browser storage. */
export async function requireUser(req: IncomingMessage): Promise<User> {
  const value = req.headers.authorization;
  const authorization = Array.isArray(value) ? value[0] : value;
  const match = authorization?.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    throw new ApiError(401, "sign in with Google or GitHub to transcribe more than 10 seconds", {
      "WWW-Authenticate": "Bearer",
    });
  }

  const { data, error } = await authClient().auth.getUser(match[1]);
  if (error || !data.user) {
    throw new ApiError(401, "your sign-in expired — sign in again to transcribe this clip", {
      "WWW-Authenticate": "Bearer",
    });
  }
  return data.user;
}
