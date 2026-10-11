import { useCallback, useEffect, useState } from "react";
import {
  IconAlertCircle,
  IconCheck,
  IconCopy,
  IconKey,
  IconLoader2,
  IconShieldCheck,
  IconShieldOff,
} from "@tabler/icons-react";
import {
  disableTotp,
  enableTotp,
  getTotpStatus,
  setupTotp,
  type TotpSetup,
  type TotpStatus,
} from "../../auth/authClient";
import { useAuth } from "../../auth/authClient";
import styles from "./SecurityCard.module.css";

/**
 * Two-step verification management for email + password accounts.
 *
 * Enrolment is a three-step handshake — request a secret, confirm a code
 * against it, then store the one-time backup codes — so a half-finished setup
 * can never lock anyone out.
 */

type Phase = "loading" | "idle" | "setup" | "confirm" | "backup-codes" | "disabling" | "error";

export function SecurityCard() {
  const auth = useAuth();
  const [status, setStatus] = useState<TotpStatus | null>(null);
  const [phase, setPhase] = useState<Phase>("loading");
  const [setup, setSetup] = useState<TotpSetup | null>(null);
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [backupCodes, setBackupCodes] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const isLocalAccount = auth.session.authProvider === "password";

  const load = useCallback(async () => {
    if (!auth.session.authenticated || !isLocalAccount) {
      setPhase("idle");
      return;
    }
    try {
      const next = await getTotpStatus();
      setStatus(next);
      setPhase("idle");
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Unable to load security settings.");
      setPhase("error");
    }
  }, [auth.session.authenticated, isLocalAccount]);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  };

  const handleSetup = () =>
    run(async () => {
      const next = await setupTotp();
      setSetup(next);
      setCode("");
      setPhase("setup");
    });

  const handleEnable = () =>
    run(async () => {
      const result = await enableTotp(code.trim());
      setBackupCodes(result.backupCodes);
      setCode("");
      setPhase("backup-codes");
      setStatus(await getTotpStatus());
    });

  const handleDisable = () =>
    run(async () => {
      await disableTotp({ password, code: code.trim() });
      setPassword("");
      setCode("");
      setPhase("idle");
      setStatus(await getTotpStatus());
    });

  const copySecret = async () => {
    if (!setup) return;
    try {
      await navigator.clipboard.writeText(setup.secret);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setError("Copy failed — select the secret and copy it manually.");
    }
  };

  if (!auth.session.authenticated) return null;

  return (
    <section className={styles.card} aria-labelledby="security-settings-title">
      <div className={styles.header}>
        <div>
          <h2 id="security-settings-title">Two-step verification</h2>
          <p>
            {!isLocalAccount
              ? "Available for email and password accounts. Your Google sign-in already uses Google's own verification."
              : status?.enabled
                ? "Enabled — a code from your authenticator app is required at sign-in."
                : "Add a 6-digit code from an authenticator app as a second step at sign-in."}
          </p>
        </div>
        <span className={`${styles.status} ${status?.enabled ? styles.enabled : ""}`}>
          {status?.enabled ? (
            <>
              <IconShieldCheck size={15} aria-hidden="true" /> On
            </>
          ) : (
            <>
              <IconShieldOff size={15} aria-hidden="true" /> Off
            </>
          )}
        </span>
      </div>

      {!isLocalAccount && <p className={styles.note}>Sign in with a password to manage two-step verification.</p>}

      {error && (
        <p className={styles.error} role="alert">
          <IconAlertCircle size={16} aria-hidden="true" />
          {error}
        </p>
      )}

      {phase === "setup" && setup && (
        <div className={styles.panel}>
          <p>
            Add this to your authenticator app (1Password, Aegis, Google Authenticator, Raivo…). Scan nothing you
            don’t trust — the secret below is all the app needs.
          </p>
          <div className={styles.secretRow}>
            <code>{setup.secret}</code>
            <button type="button" onClick={() => void copySecret()} title="Copy secret">
              {copied ? <IconCheck size={16} /> : <IconCopy size={16} />}
            </button>
          </div>
          <details className={styles.uriDetails}>
            <summary>Can’t enter a secret? Use this setup link</summary>
            <code className={styles.uri}>{setup.otpauthUri}</code>
          </details>
          <label className={styles.field}>
            <span>Enter the 6-digit code it shows</span>
            <input
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              placeholder="123456"
              value={code}
              onChange={(event) => setCode(event.target.value.replace(/\D/g, ""))}
            />
          </label>
          <div className={styles.actions}>
            <button type="button" className={styles.secondary} onClick={() => setPhase("idle")} disabled={busy}>
              Cancel
            </button>
            <button
              type="button"
              className={styles.primary}
              onClick={() => void handleEnable()}
              disabled={busy || code.length !== 6}
            >
              {busy && <IconLoader2 className={styles.spinner} size={16} />}
              Turn on
            </button>
          </div>
        </div>
      )}

      {phase === "backup-codes" && (
        <div className={styles.panel}>
          <p>
            <strong>Save these backup codes somewhere safe.</strong> Each works once if you lose your authenticator
            app — leaving them here means losing them with this browser.
          </p>
          <ul className={styles.backupCodes}>
            {backupCodes.map((backupCode) => (
              <li key={backupCode}>
                <code>{backupCode}</code>
              </li>
            ))}
          </ul>
          <div className={styles.actions}>
            <button
              type="button"
              className={styles.secondary}
              onClick={() => void navigator.clipboard.writeText(backupCodes.join("\n"))}
            >
              Copy all
            </button>
            <button type="button" className={styles.primary} onClick={() => setPhase("idle")}>
              I’ve saved them
            </button>
          </div>
        </div>
      )}

      {phase === "disabling" && (
        <div className={styles.panel}>
          <p>
            Turning this off weakens your account. Confirm with your password and a current code.
          </p>
          <label className={styles.field}>
            <span>Password</span>
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
          <label className={styles.field}>
            <span>Current code</span>
            <input
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              placeholder="123456"
              value={code}
              onChange={(event) => setCode(event.target.value.replace(/\D/g, ""))}
            />
          </label>
          <div className={styles.actions}>
            <button type="button" className={styles.secondary} onClick={() => setPhase("idle")} disabled={busy}>
              Keep it on
            </button>
            <button
              type="button"
              className={styles.primary}
              onClick={() => void handleDisable()}
              disabled={busy || !password || code.length !== 6}
            >
              {busy && <IconLoader2 className={styles.spinner} size={16} />}
              Turn off
            </button>
          </div>
        </div>
      )}

      {phase === "idle" && status && isLocalAccount && (
        <div className={styles.row}>
          {status.enabled ? (
            <>
              <span className={styles.rowText}>
                <IconKey size={16} aria-hidden="true" />
                {status.backupCodesRemaining} of 10 backup codes remaining
              </span>
              <button type="button" className={styles.secondary} onClick={() => setPhase("disabling")} disabled={busy}>
                Turn off
              </button>
            </>
          ) : (
            <>
              <span className={styles.rowText}>
                <IconKey size={16} aria-hidden="true" />
                {status.enrolled ? "A secret was requested but never confirmed." : "Not configured yet."}
              </span>
              <button
                type="button"
                className={styles.primary}
                onClick={() => void handleSetup()}
                disabled={busy}
              >
                {busy && <IconLoader2 className={styles.spinner} size={16} />}
                Set up
              </button>
            </>
          )}
        </div>
      )}
    </section>
  );
}
