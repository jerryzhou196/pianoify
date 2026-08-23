import { useCallback, useEffect, useState } from "react";
import { createClient, type Session, type User } from "@supabase/supabase-js";

export type OAuthProvider = "google" | "github";

const url = (import.meta.env.VITE_SUPABASE_URL ?? "").trim();
const publishableKey = (import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? "").trim();

/** Missing auth configuration must not break the ten-second guest flow. The
 *  account form explains what is missing and keeps its provider buttons dead;
 *  the rest of the app can still decode and transcribe short clips locally. */
export const authConfigured = Boolean(url && publishableKey);

const client = authConfigured
  ? createClient(url, publishableKey, {
      auth: {
        autoRefreshToken: true,
        detectSessionInUrl: true,
        persistSession: true,
      },
    })
  : null;

export interface AuthState {
  configured: boolean;
  loading: boolean;
  session: Session | null;
  user: User | null;
  busyProvider: OAuthProvider | null;
  error: string | null;
  signIn: (provider: OAuthProvider) => Promise<void>;
  signOut: () => Promise<void>;
}

/** The one browser-side account state. Supabase owns the OAuth redirect and
 *  local session refresh; this hook only turns those changes into React state
 *  and gives the two provider buttons a small, predictable interface. */
export function useAuth(): AuthState {
  const [loading, setLoading] = useState(authConfigured);
  const [session, setSession] = useState<Session | null>(null);
  const [busyProvider, setBusyProvider] = useState<OAuthProvider | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!client) return;
    let live = true;

    void client.auth.getSession().then(({ data, error: sessionError }) => {
      if (!live) return;
      setSession(data.session);
      setError(sessionError?.message ?? null);
      setLoading(false);
    });

    const {
      data: { subscription },
    } = client.auth.onAuthStateChange((_event, next) => {
      if (!live) return;
      setSession(next);
      setLoading(false);
      setBusyProvider(null);
    });

    return () => {
      live = false;
      subscription.unsubscribe();
    };
  }, []);

  const signIn = useCallback(async (provider: OAuthProvider) => {
    if (!client) {
      setError("account sign-in is not configured for this deployment");
      return;
    }
    setError(null);
    setBusyProvider(provider);
    const { error: signInError } = await client.auth.signInWithOAuth({
      provider,
      options: {
        // Supabase accepts only allowlisted redirect URLs. Keeping the current
        // path makes this work at `/` locally and on a Vercel preview without
        // inventing a framework-specific callback route.
        redirectTo: `${window.location.origin}${window.location.pathname}`,
      },
    });
    if (signInError) {
      setBusyProvider(null);
      setError(signInError.message);
    }
  }, []);

  const signOut = useCallback(async () => {
    if (!client) return;
    setError(null);
    const { error: signOutError } = await client.auth.signOut();
    if (signOutError) setError(signOutError.message);
  }, []);

  return {
    configured: authConfigured,
    loading,
    session,
    user: session?.user ?? null,
    busyProvider,
    error,
    signIn,
    signOut,
  };
}

/** A compact identity for the header and the signed-in account row. */
export function userLabel(user: User): string {
  const metadata = user.user_metadata as Record<string, unknown>;
  const name = metadata.full_name ?? metadata.name ?? metadata.user_name ?? metadata.preferred_username;
  return typeof name === "string" && name.trim() ? name.trim() : user.email ?? "Account";
}
