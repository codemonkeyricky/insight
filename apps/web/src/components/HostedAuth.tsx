import { useEffect, useState } from "react";
import { authMe, signInUrl, signOut, type AuthState } from "../hostedApi";

/** What the header shows for the sign-in: a sign-in link, or the signed-in user with a sign-out. */
export function AuthChipView({ me, hash, onSignOut }: { me: AuthState; hash: string; onSignOut: () => void }) {
  if (!me.signedIn) {
    return (
      <a className="chip auth-chip" href={signInUrl(hash)} aria-label="Sign in with GitHub" title="Sign in with GitHub">
        <span className="auth-full">Sign in with GitHub</span>
        <span className="auth-short">Sign in</span>
      </a>
    );
  }
  return (
    <span className="auth-chip signed-in" title={`@${me.login ?? "github"}`}>
      {me.avatarUrl && <img className="auth-avatar" src={me.avatarUrl} alt="" width={20} height={20} referrerPolicy="no-referrer" />}
      <span className="auth-login">@{me.login ?? "github"}</span>
      <button type="button" className="auth-signout" onClick={onSignOut}>
        Sign out
      </button>
    </span>
  );
}

/** The header's sign-in control of the hosted build. It renders nothing until the state is known, and when sign-in is off. */
export function AuthChip() {
  const [me, setMe] = useState<AuthState | null>(null);
  useEffect(() => {
    let live = true;
    void authMe().then((state) => {
      if (live) setMe(state);
    });
    return () => {
      live = false;
    };
  }, []);
  if (me === null || !me.enabled) return null;
  const onSignOut = () => {
    void signOut()
      .then(() => window.location.reload())
      .catch(() => undefined);
  };
  return <AuthChipView me={me} hash={window.location.hash || "#/"} onSignOut={onSignOut} />;
}
