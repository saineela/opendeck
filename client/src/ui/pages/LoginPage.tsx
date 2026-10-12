import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  IconKey,
  IconLock,
  IconMail,
  IconShieldCheck,
  IconUser,
} from "@tabler/icons-react";
import {
  completeTotpLogin,
  refreshAuthSession,
  registerAccount,
  signInWithPassword,
  startGoogleQrSignIn,
  verifyGoogleQrSignIn,
  useAuth,
  type GoogleQrSignIn,
} from "../../auth/authClient";
import { QrCode } from "../components/QrCode";
import styles from "./LoginPage.module.css";

/**
 * The branded sign-in surface, served at `/login`.
 *
 * Covers every way into an account: first-run admin setup (while the
 * instance has no users), email + password, the TOTP second step (or a
 * backup code), invite codes, and the configured OIDC provider. It is a
 * full page rather than a dialog so it can be linked to directly, survives
 * reloads mid-flow, and carries the app's branding on a surface of its own.
 */

export interface LoginPageProps {
  /** Called after a session exists (and any TOTP step is complete). */
  onSignedIn: () => void;
  /**
   * Called when the visitor backs out to the app without signing in.
   * Omitted while the app is gated (no session): there is nowhere to go
   * back to, so the "Back to the app" affordance is hidden entirely.
   */
  onCancel?: () => void;
}

type Mode = "setup" | "signin" | "signup" | "totp";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function LoginPage({ onSignedIn, onCancel }: LoginPageProps) {
  const auth = useAuth();
  const session = auth.session;
  const needsSetup = session.needsSetup;

  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [totpChallenge, setTotpChallenge] = useState<string | null>(null);
  const [totpCode, setTotpCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [qr, setQr] = useState<GoogleQrSignIn | null>(null);
  const [qrBusy, setQrBusy] = useState(false);
  const [qrError, setQrError] = useState<string | null>(null);
  const [qrNotice, setQrNotice] = useState<string | null>(null);
  const qrStartedRef = useRef(false);
  const emailRef = useRef<HTMLInputElement>(null);
  const totpRef = useRef<HTMLInputElement>(null);
  const finishedRef = useRef(false);

  // First-run setup is the default mode until the instance has an account.
  useEffect(() => {
    setMode(needsSetup ? "setup" : "signin");
  }, [needsSetup]);

  // Already signed in (or just signed in): hand control back to the app —
  // exactly once, no matter how many auth refreshes land afterwards.
  useEffect(() => {
    if (session.authenticated && !finishedRef.current) {
      finishedRef.current = true;
      onSignedIn();
    }
  }, [session.authenticated, onSignedIn]);

  // Focus the field the flow is waiting on.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      (mode === "totp" ? totpRef.current : emailRef.current)?.focus();
    }, 30);
    return () => window.clearTimeout(timer);
  }, [mode]);

  const finish = async () => {
    if (finishedRef.current) return;
    finishedRef.current = true;
    await refreshAuthSession();
    onSignedIn();
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setError(null);

    if (mode === "totp") {
      if (!/^\d{6}$/.test(totpCode.replace(/\s+/g, ""))) {
        setError("Enter the 6-digit code from your authenticator app.");
        return;
      }
      setBusy(true);
      try {
        await completeTotpLogin({ challenge: totpChallenge!, code: totpCode.trim() });
        await finish();
      } catch (submitError) {
        setError(submitError instanceof Error ? submitError.message : "That code was not accepted.");
      } finally {
        setBusy(false);
      }
      return;
    }

    if (!EMAIL_RE.test(email.trim())) {
      setError("Enter a valid email address.");
      emailRef.current?.focus();
      return;
    }
    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }

    setBusy(true);
    try {
      if (mode === "setup" || mode === "signup") {
        await registerAccount({
          email: email.trim(),
          password,
          name: name.trim() || undefined,
          inviteCode: mode === "signup" ? inviteCode.trim() || undefined : undefined,
        });
        await finish();
        return;
      }
      const result = await signInWithPassword({ email: email.trim(), password });
      if (result.status === "totp_required" && result.challenge) {
        setTotpChallenge(result.challenge);
        setTotpCode("");
        setError(null);
        setMode("totp");
        return;
      }
      await finish();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Sign-in failed.");
    } finally {
      setBusy(false);
    }
  };

  const startQr = async () => {
    setQrBusy(true);
    setQrError(null);
    setQrNotice(null);
    try {
      setQr(await startGoogleQrSignIn());
    } catch (qrStartError) {
      setQr(null);
      setQrError(
        qrStartError instanceof Error ? qrStartError.message : "Unable to start QR sign-in.",
      );
    } finally {
      setQrBusy(false);
    }
  };

  // QR handoff is the OAuth affordance: arm an attempt as soon as the
  // provider is known (once per page visit; "Get a new code" re-arms it).
  const oauthConfigured = session.oauthProvider.configured;
  useEffect(() => {
    if (!oauthConfigured || qrStartedRef.current) return;
    qrStartedRef.current = true;
    void startQr();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [oauthConfigured]);

  const handleQrVerify = async () => {
    if (!qr || busy) return;
    setError(null);
    setQrError(null);
    setQrNotice(null);
    setBusy(true);
    try {
      const result = await verifyGoogleQrSignIn(qr.attemptId);
      if (result.status === "verified") {
        await finish();
        return;
      }
      setQrNotice("Still waiting — finish signing in on your phone, then press Verify again.");
    } catch (verifyError) {
      setQrError(
        verifyError instanceof Error ? verifyError.message : "That sign-in could not be verified.",
      );
    } finally {
      setBusy(false);
    }
  };

  const oauthName = session.oauthProvider.name;
  const showOAuth = session.oauthProvider.configured;
  const showPasswordForm = session.passwordLoginEnabled || needsSetup;
  const showSignupToggle = !needsSetup && session.registrationEnabled && mode !== "totp";
  const canSubmit =
    !busy && EMAIL_RE.test(email.trim()) && password.length >= 8;

  const title =
    mode === "totp"
      ? "Two-step verification"
      : mode === "setup"
        ? "Set up OpenDeck"
        : mode === "signup"
          ? "Create your account"
          : "Sign in";

  const subtitle =
    mode === "totp"
      ? "Enter the 6-digit code from your authenticator app. A backup code works too."
      : mode === "setup"
        ? "This is the first account on this server — it becomes the administrator."
        : mode === "signup"
          ? "Your playlists and likes are stored on this server and follow your account."
          : "Your playlists and likes, on this server, on every device.";

  return (
    <div className={styles.page}>
      <aside className={styles.brand}>
        <div className={styles.brandTop}>
          <span className={styles.wordmark}>OpenDeck</span>
        </div>

        <div className={styles.brandCopy}>
          <h2>Your library, wherever you listen.</h2>
          <ul className={styles.points}>
            <li>Every account gets its own library, playlists, and likes.</li>
            <li>Two-step verification with TOTP and backup codes.</li>
            <li>Offline playback and programmatic API keys.</li>
            <li>Self-hosted and multi-user from one container.</li>
          </ul>
        </div>

        <p className={styles.brandFoot}>OpenDeck — a self-hosted music client for YouTube Music</p>
      </aside>

      <main className={styles.formSide}>
        <section className={styles.card}>
          <div className={styles.cardHead}>
            <h1>{title}</h1>
            <p>{subtitle}</p>
          </div>

          {showOAuth && mode !== "totp" && (
            <>
              <section className={styles.qrPanel} aria-label={`Sign in with ${oauthName}`}>
                <div className={styles.qrHead}>
                  <IconShieldCheck size={17} aria-hidden="true" />
                  <strong>Scan to sign in with {oauthName}</strong>
                </div>
                <div className={styles.qrCodeWrap}>
                  {qr ? (
                    <a
                      className={styles.qrLink}
                      href={qr.qrUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      title="Open the sign-in link directly"
                    >
                      <QrCode
                        value={qr.qrUrl}
                        size={164}
                        label={`Sign in with ${oauthName} QR code`}
                      />
                    </a>
                  ) : (
                    <span className={styles.qrPending} role="status">
                      {qrBusy ? "Preparing code…" : "Code unavailable"}
                    </span>
                  )}
                </div>
                <p className={styles.qrHint}>
                  Scan with your phone and finish signing in there — then press Verify below.
                </p>
                {qrNotice && <p className={styles.qrNotice}>{qrNotice}</p>}
                {qrError && <p className={styles.error}>{qrError}</p>}
                <div className={styles.qrActions}>
                  <button
                    className={styles.oauth}
                    type="button"
                    disabled={!qr || busy}
                    onClick={() => void handleQrVerify()}
                  >
                    <IconShieldCheck size={18} aria-hidden="true" />
                    {busy ? "Verifying…" : "Verify sign-in"}
                  </button>
                  <button
                    className={styles.qrRefresh}
                    type="button"
                    disabled={qrBusy}
                    onClick={() => void startQr()}
                  >
                    Get a new code
                  </button>
                </div>
              </section>
              {showPasswordForm && <div className={styles.divider}>or with email</div>}
            </>
          )}

          {showPasswordForm || mode === "totp" ? (
            <form className={styles.form} onSubmit={handleSubmit}>
              {mode === "totp" ? (
                <label className={styles.field}>
                  <span>Authentication code</span>
                  <span className={styles.inputWrap}>
                    <IconLock size={17} aria-hidden="true" />
                    <input
                      ref={totpRef}
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      pattern="[0-9]*"
                      maxLength={10}
                      placeholder="123456"
                      value={totpCode}
                      onChange={(event) => setTotpCode(event.target.value.replace(/[^\d\s]/g, ""))}
                    />
                  </span>
                </label>
              ) : (
                <>
                  {(mode === "setup" || mode === "signup") && (
                    <label className={styles.field}>
                      <span>Name <em>(optional)</em></span>
                      <span className={styles.inputWrap}>
                        <IconUser size={17} aria-hidden="true" />
                        <input
                          value={name}
                          onChange={(event) => setName(event.target.value)}
                          placeholder="What should we call you?"
                          maxLength={80}
                          autoComplete="nickname"
                        />
                      </span>
                    </label>
                  )}

                  <label className={styles.field}>
                    <span>Email</span>
                    <span className={styles.inputWrap}>
                      <IconMail size={17} aria-hidden="true" />
                      <input
                        ref={emailRef}
                        type="email"
                        value={email}
                        onChange={(event) => setEmail(event.target.value)}
                        placeholder="you@example.com"
                        maxLength={254}
                        autoComplete="email"
                      />
                    </span>
                  </label>

                  <label className={styles.field}>
                    <span>Password <em>(8+ characters)</em></span>
                    <span className={styles.inputWrap}>
                      <IconLock size={17} aria-hidden="true" />
                      <input
                        type="password"
                        value={password}
                        onChange={(event) => setPassword(event.target.value)}
                        placeholder="Your password"
                        maxLength={256}
                        autoComplete={
                          mode === "signin" ? "current-password" : "new-password"
                        }
                      />
                    </span>
                  </label>

                  {mode === "signup" && session.inviteCodeRequired && (
                    <label className={styles.field}>
                      <span>Invite code</span>
                      <span className={styles.inputWrap}>
                        <IconKey size={17} aria-hidden="true" />
                        <input
                          value={inviteCode}
                          onChange={(event) => setInviteCode(event.target.value)}
                          placeholder="Provided by your administrator"
                          maxLength={128}
                          autoComplete="off"
                        />
                      </span>
                    </label>
                  )}
                </>
              )}

              {error && <p className={styles.error}>{error}</p>}

              <button className={styles.submit} type="submit" disabled={!canSubmit}>
                {busy
                  ? "Please wait…"
                  : mode === "totp"
                    ? "Verify"
                    : mode === "setup"
                      ? "Create administrator account"
                      : mode === "signup"
                        ? "Create account"
                        : "Sign in"}
              </button>
            </form>
          ) : (
            !showOAuth && (
              <p className={styles.notice}>
                Sign-in is not configured on this server. Ask your administrator to set up email
                and password access or an identity provider.
              </p>
            )
          )}

          {mode === "totp" ? (
            <p className={styles.switch}>
              <button
                type="button"
                onClick={() => {
                  setMode("signin");
                  setTotpChallenge(null);
                  setTotpCode("");
                  setError(null);
                }}
              >
                Use a different account
              </button>
            </p>
          ) : (
            <>
              {showSignupToggle && (
                <p className={styles.switch}>
                  {mode === "signup" ? (
                    <>
                      Already have an account?{" "}
                      <button
                        type="button"
                        onClick={() => {
                          setMode("signin");
                          setError(null);
                        }}
                      >
                        Sign in
                      </button>
                    </>
                  ) : (
                    <>
                      New here?{" "}
                      <button
                        type="button"
                        onClick={() => {
                          setMode("signup");
                          setError(null);
                        }}
                      >
                        Create an account
                      </button>
                    </>
                  )}
                </p>
              )}
              {onCancel && (
                <p className={styles.back}>
                  <button type="button" onClick={onCancel}>
                    Back to the app
                  </button>
                </p>
              )}
            </>
          )}
        </section>
      </main>
    </div>
  );
}
