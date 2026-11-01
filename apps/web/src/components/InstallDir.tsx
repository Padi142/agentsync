import { Fragment, type ReactNode } from 'react';
import { fillInstallDir, INSTALL_DIR, installCommand, setInstallDir, useInstallDir } from '../commands';
import { Command } from './Copy';

/** The install folder, editable in place inside a command. Sized to its text, so it reads as part of the line. */
export function InstallDirInput() {
  const dir = useInstallDir();
  return (
    <input className="install-dir" aria-label="Install folder" title="Where to clone AgentSync. Click to change it."
      value={dir} onChange={(event) => setInstallDir(event.target.value)}
      spellCheck={false} autoComplete="off" autoCapitalize="off" autoCorrect="off"
      style={{ width: `${Math.max(dir.length, 1)}ch` }} />
  );
}

/** `text` with each `<INSTALL_DIR>` shown as an `InstallDirInput`. */
export const withInstallDirInput = (text: string): ReactNode =>
  text.split(INSTALL_DIR).map((part, i) => (
    <Fragment key={i}>{i > 0 ? <InstallDirInput /> : null}{part}</Fragment>
  ));

/** The clone-build-register one-liner, with the folder editable. */
export function InstallCommand({ server, note }: { server?: string; note?: ReactNode }) {
  const dir = useInstallDir();
  const command = installCommand(server);
  return (
    <Command command={fillInstallDir(command, dir)} label="Install command" note={note}>
      {withInstallDirInput(command)}
    </Command>
  );
}
