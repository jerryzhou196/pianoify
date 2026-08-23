import { userLabel, type AuthState, type OAuthProvider } from "../auth";

/** Registration and account state live in the upload flow because that is
 *  where the ten-second guest limit matters and, on a first visit, the header
 *  behind the scrim cannot be reached. A first OAuth sign-in creates the
 *  Supabase user; a returning one signs the same account back in. */
export function AuthForm({ auth }: { auth: AuthState }) {
  if (auth.loading) {
    return <div className="auth-card auth-loading">Checking your account…</div>;
  }

  if (auth.user) {
    return (
      <section className="auth-card auth-signed" aria-label="Signed-in account">
        <div>
          <span className="auth-kicker">FULL-LENGTH ACCESS</span>
          <strong>{userLabel(auth.user)}</strong>
          <p>You can stretch the selection to this model&apos;s full limit.</p>
        </div>
        <button type="button" className="auth-signout" onClick={() => void auth.signOut()}>
          Sign out
        </button>
      </section>
    );
  }

  return (
    <form
      className="auth-card"
      aria-labelledby="account-title"
      onSubmit={(event) => event.preventDefault()}
    >
      <div className="auth-copy">
        <span className="auth-kicker">FREE ACCOUNT</span>
        <strong id="account-title">Transcribe more than 10 seconds</strong>
        <p>Sign in or create an account, then stretch the selection to the model&apos;s full limit.</p>
      </div>
      <div className="auth-actions" aria-label="Account providers">
        <ProviderButton provider="google" auth={auth} />
        <ProviderButton provider="github" auth={auth} />
      </div>
      <p className="auth-note">
        {auth.configured
          ? "Or continue below as a guest with a 10-second clip."
          : "Sign-in needs the Supabase URL and publishable key for this deployment. Guest clips still work."}
      </p>
      {auth.error && <p className="auth-error">{auth.error}</p>}
    </form>
  );
}

function ProviderButton({ provider, auth }: { provider: OAuthProvider; auth: AuthState }) {
  const label = provider === "google" ? "Google" : "GitHub";
  const busy = auth.busyProvider === provider;
  return (
    <button
      type="button"
      className="auth-provider"
      disabled={!auth.configured || auth.busyProvider !== null}
      onClick={() => void auth.signIn(provider)}
    >
      <span className="provider-mark" aria-hidden="true">
        {provider === "google" ? "G" : "GH"}
      </span>
      {busy ? `Opening ${label}…` : `Continue with ${label}`}
    </button>
  );
}
