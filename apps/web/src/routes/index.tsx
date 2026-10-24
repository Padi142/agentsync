import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useState, type FormEvent } from 'react';
import { createORPCClient, isDefinedError, safe } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { ContractClient } from '@agentsync/contract';

export const Route = createFileRoute('/')({ component: HomePage });

type User = { id: string; name: string; email: string };

const getRpcClient = () => {
  const link = new RPCLink({ url: `${window.location.origin}/rpc` });
  return createORPCClient<ContractClient>(link);
};

function HomePage() {
  const [user, setUser] = useState<User | null>(null);
  const [revision, setRevision] = useState(0);
  const [text, setText] = useState('');
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    const authError = new URLSearchParams(window.location.search).get('authError');
    if (authError) {
      setNotice(authError === 'cancelled'
        ? 'Sign-in was cancelled. You can try again.'
        : 'Sign-in could not be completed. Please try again.');
      window.history.replaceState(null, '', '/');
    }

    fetch('/api/auth/get-session')
      .then(async (response) => {
        if (!response.ok) throw new Error('Session unavailable');
        const payload: unknown = await response.json();
        if (!isRecord(payload) || !isRecord(payload.user)) return null;
        const account = payload.user;
        if (
          typeof account.id !== 'string' ||
          typeof account.name !== 'string' ||
          typeof account.email !== 'string'
        ) {
          return null;
        }
        return { id: account.id, name: account.name, email: account.email };
      })
      .then((nextUser) => {
        if (active) {
          setUser(nextUser);
          setLoading(false);
        }
      })
      .catch(() => {
        if (active) {
          setNotice('The local auth endpoint is unavailable.');
          setLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!user) {
      setRevision(0);
      setText('');
      return;
    }

    getRpcClient()
      .template.get()
      .then((template) => {
        setRevision(template.revision);
        setText(template.text);
      })
      .catch(() => setNotice('Could not load your Template.'));
  }, [user]);

  const saveTemplate = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!user) return;

    setNotice('');
    const [error, saved] = await safe(getRpcClient().template.put({ text, expectedRevision: revision }));
    if (!error) {
      setRevision(saved.revision);
      setNotice(`Saved revision ${saved.revision}.`);
    } else if (isDefinedError(error) && error.code === 'INVALID_TEMPLATE') {
      const [issue] = error.data.issues;
      setNotice(`Line ${issue.line}, column ${issue.column}: ${issue.message}`);
    } else if (isDefinedError(error) && error.code === 'CONFLICT') {
      setNotice(`The Template changed (now revision ${error.data.currentRevision}). Copy your edit and reload.`);
    } else {
      setNotice('Save failed. Please try again.');
    }
  };

  if (loading) {
    return <p className="loading">Checking your session…</p>;
  }

  return (
    <div className="dashboard">
      <section className="intro">
        <p className="kicker">A small home for big context</p>
        <h1>One source for the instructions your tools depend on.</h1>
        <p className="lede">
          Keep the files that shape your coding agents together, ready to carry
          from one machine to the next.
        </p>
        <div className="status-line">
          <span className="status-dot" aria-hidden="true" />
          <span>
            {user ? `Signed in as ${user.email}` : 'Local starter · sync is not connected yet'}
          </span>
        </div>
      </section>

      {user ? (
        <section className="workspace-panel" aria-label="Your Template">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Your Global Instructions</p>
              <h2>Template</h2>
            </div>
            <form action="/logout" method="post">
              <button className="quiet-button" type="submit">Sign out</button>
            </form>
          </div>
          <form className="editor" onSubmit={saveTemplate}>
            <label>
              Template <small>rev {revision}</small>
              <textarea
                value={text}
                onChange={(event) => setText(event.target.value)}
                rows={16}
                spellCheck={false}
              />
            </label>
            <button className="primary-button" type="submit">Save Template</button>
          </form>
          {notice ? <p className="notice" role="status">{notice}</p> : null}
        </section>
      ) : (
        <section className="auth-panel" aria-label="Account access">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Start here</p>
              <h2>Open your shelf</h2>
            </div>
          </div>
          <div className="auth-form">
            <p style={{ marginBottom: '1rem', color: '#746b61' }}>
              Sign in or create an account to manage your instruction files.
            </p>
            <a href="/login" className="primary-button" style={{ display: 'inline-block', textAlign: 'center', textDecoration: 'none' }}>
              Sign in
            </a>
          </div>
          {notice ? <p className="notice" role="status">{notice}</p> : null}
        </section>
      )}
    </div>
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
