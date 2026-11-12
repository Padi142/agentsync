import { useId, useRef, useState, type FormEvent } from 'react';
import { loginHref, type EmailLoginError } from '../login';
import { GitHubMark, GoogleMark, Icon } from './Icon';

const ERRORS: Record<EmailLoginError, string> = {
  invalid_email: 'Enter a valid email address.',
  invalid_code: 'That code is wrong or has expired.',
  too_many: 'Too many attempts. Wait a minute and try again.',
  unavailable: 'Email sign-in is not available right now.',
};

/** POST one step of the email sign-in. Resolves to the response body, or to why it failed. */
async function emailStep<T>(path: string, body: object): Promise<{ ok: true; data: T } | { ok: false; error: EmailLoginError }> {
  try {
    const response = await fetch(path, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    if (response.ok) return { ok: true, data: (response.status === 204 ? null : await response.json()) as T };
    const { error } = await response.json() as { error?: EmailLoginError };
    return { ok: false, error: error && error in ERRORS ? error : 'unavailable' };
  } catch {
    return { ok: false, error: 'unavailable' };
  }
}

/**
 * A "Sign in" button that opens the sign-in dialog: Google, GitHub, or a six-digit code by email.
 * `returnTo` is the path to land on afterwards.
 */
export function SignInButton({ returnTo, className = 'button' }: { returnTo?: string; className?: string }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  // The address a code was sent to; until then the dialog asks for the email.
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<EmailLoginError | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    if (sentTo === null) {
      const sent = await emailStep<null>('/login/email', { email });
      if (sent.ok) setSentTo(email);
      else setError(sent.error);
    } else {
      const verified = await emailStep<{ returnTo: string }>('/login/email/verify', { email: sentTo, code, returnTo });
      // A full load, so the page asks for the session again.
      if (verified.ok) return window.location.assign(verified.data.returnTo);
      setError(verified.error);
    }
    setBusy(false);
  };
  const startOver = () => { setSentTo(null); setCode(''); setError(null); };

  return (
    <>
      <button type="button" className={className} onClick={() => dialog.current?.showModal()}>Sign in</button>
      <dialog ref={dialog} className="sk-dialog signin-dialog" aria-labelledby={titleId}
        onClick={(event) => { if (event.target === dialog.current) dialog.current.close(); }}>
        <div className="sk-dialog-head">
          <strong id={titleId}>Sign in to AgentSync</strong>
          <button type="button" className="icon-button" aria-label="Close" onClick={() => dialog.current?.close()}>
            <Icon name="close" />
          </button>
        </div>
        <div className="signin-body">
          <a className="button secondary" href={loginHref('google', returnTo)}><GoogleMark />Continue with Google</a>
          <a className="button secondary" href={loginHref('github', returnTo)}><GitHubMark />Continue with GitHub</a>
          <p className="signin-or">or</p>
          <form onSubmit={submit}>
            {sentTo === null ? (
              <input className="input" type="email" name="email" autoComplete="email" required placeholder="you@example.com"
                aria-label="Email" aria-invalid={error === 'invalid_email'} value={email}
                onChange={(event) => setEmail(event.target.value)} />
            ) : (
              <>
                <p className="signin-sent">Enter the code sent to <strong>{sentTo}</strong></p>
                <input className="input signin-code" name="code" inputMode="numeric" autoComplete="one-time-code" required
                  pattern="\d{6}" maxLength={6} placeholder="000000" aria-label="Six-digit code" autoFocus
                  aria-invalid={error === 'invalid_code'} value={code}
                  onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))} />
              </>
            )}
            {error ? <p className="field-issue" role="alert">{ERRORS[error]}</p> : null}
            <button className="button" type="submit" disabled={busy}>
              {sentTo === null ? 'Email me a code' : 'Sign in'}
            </button>
            {sentTo === null ? null : (
              <button type="button" className="signin-restart" onClick={startOver}>Use a different email</button>
            )}
          </form>
        </div>
      </dialog>
    </>
  );
}
