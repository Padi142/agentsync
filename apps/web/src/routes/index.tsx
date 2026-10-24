import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useState, type FormEvent } from 'react';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { RouterClient } from '@orpc/server';
import type { AppRouter } from '../api/router';

export const Route = createFileRoute('/')({ component: HomePage });

type User = { id: string; name: string; email: string };
type FileRecord = {
  id: string;
  path: string;
  content: string;
  revision: number;
  updatedAt: string;
};

const getRpcClient = () => {
  const link = new RPCLink({ url: `${window.location.origin}/rpc` });
  return createORPCClient<RouterClient<AppRouter>>(link);
};

function HomePage() {
  const [user, setUser] = useState<User | null>(null);
  const [files, setFiles] = useState<FileRecord[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [path, setPath] = useState('AGENTS.md');
  const [content, setContent] = useState('# Shared agent instructions\n');
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;

    fetch('/api/auth/get-session')
      .then(async (response) => {
        if (!response.ok) return null;
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
      setFiles([]);
      setSelectedId(null);
      return;
    }

    getRpcClient()
      .files.list(undefined)
      .then((result) => {
        const nextFiles = result.map((item) => ({
          ...item,
          updatedAt: item.updatedAt.toISOString(),
        }));
        setFiles(nextFiles);
        const first = nextFiles[0];
        if (first) {
          setSelectedId(first.id);
          setPath(first.path);
          setContent(first.content);
        }
      })
      .catch(() => setNotice('Could not load your files.'));
  }, [user]);

  const saveFile = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!user) return;

    setNotice('');
    const client = getRpcClient();
    try {
      if (selectedId) {
        const current = files.find((item) => item.id === selectedId);
        if (!current) return;
        const saved = await client.files.update({
          id: selectedId,
          path,
          content,
          expectedRevision: current.revision,
        });
        setFiles((currentFiles) =>
          currentFiles.map((item) =>
            item.id === saved.id
              ? { ...saved, updatedAt: saved.updatedAt.toISOString() }
              : item,
          ),
        );
        setNotice('Saved.');
      } else {
        const created = await client.files.create({ path, content });
        setFiles((currentFiles) => [
          ...currentFiles,
          { ...created, updatedAt: created.updatedAt.toISOString() },
        ]);
        setSelectedId(created.id);
        setNotice('File created.');
      }
    } catch {
      setNotice('Save failed. Refresh and resolve any concurrent edit.');
    }
  };

  const signOut = async () => {
    // Redirect to WorkOS logout which will clear session and redirect back
    window.location.href = '/logout';
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
        <section className="workspace-panel" aria-label="Your instruction files">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Your files</p>
              <h2>Instruction shelf</h2>
            </div>
            <button className="quiet-button" type="button" onClick={signOut}>
              Sign out
            </button>
          </div>
          <div className="workspace-grid">
            <aside className="file-list">
              {files.length > 0 ? (
                files.map((item) => (
                  <button
                    className={item.id === selectedId ? 'file-item active' : 'file-item'}
                    key={item.id}
                    type="button"
                    onClick={() => {
                      setSelectedId(item.id);
                      setPath(item.path);
                      setContent(item.content);
                    }}
                  >
                    <span>{item.path}</span>
                    <small>rev {item.revision}</small>
                  </button>
                ))
              ) : (
                <p className="empty-state">No files yet. Add your first one.</p>
              )}
              <button
                className="new-file"
                type="button"
                onClick={() => {
                  setSelectedId(null);
                  setPath('CLAUDE.md');
                  setContent('# Shared Claude instructions\n');
                }}
              >
                + New file
              </button>
            </aside>
            <form className="editor" onSubmit={saveFile}>
              <label>
                File path
                <input value={path} onChange={(event) => setPath(event.target.value)} />
              </label>
              <label>
                Content
                <textarea
                  value={content}
                  onChange={(event) => setContent(event.target.value)}
                  rows={16}
                  spellCheck={false}
                />
              </label>
              <button className="primary-button" type="submit">
                {selectedId ? 'Save changes' : 'Create file'}
              </button>
            </form>
          </div>
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
            <p style={{ marginBottom: '1rem', color: 'var(--color-text-secondary)' }}>
              Sign in to access your instruction files and keep them synced across your machines.
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
