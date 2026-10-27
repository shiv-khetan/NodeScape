# NodeScape

NodeScape is a desktop control panel for Linux servers over SSH. It shows system health,
processes, services, logs, schedules, accounts and network state, with an interactive
terminal and an SFTP file browser. Nothing needs to be installed on the remote server.
The app uses native JavaScript modules and a Rust/Tauri backend.

> Screenshots: placeholder — add reviewed screenshots with made-up server data before release.

## Install

Download the Windows installer from this repository's Releases page and run it.
Windows needs Microsoft Edge WebView2 Runtime and the OpenSSH client available to your
account. Windows is the primary desktop target; Linux CI checks compilation and tests,
but native Linux installer and desktop behavior still need manual verification.

## First run

1. Open NodeScape. The environment check locates system SSH and ssh-keygen.
2. Choose an alias from an existing SSH config, or add a server to NodeScape's own config.
   For example, use alias `workshop`, host `box.example` and user `operator`.
3. Compare the host fingerprint with a trusted source. The embedded OpenSSH prompt lets
   you approve first contact explicitly. Investigate changed keys with the administrator.
4. Use an existing key, generate a key, or install a public key through the guided terminal.
   Test the connection and save the server.

Normal dashboard operations need authentication that works without interactive prompts
(for example an unlocked SSH agent). Profiles store names, targets and config paths,
not passwords or private-key contents. Files opens the SSH account's home directory.
Linux tools such as systemctl, journalctl, ip and sensors provide the displayed data;
missing tools or permissions appear as unavailable. Network inspection is read-only.

## Build from source

Install Node.js 22+, stable Rust, and the platform's Tauri build prerequisites.
On Windows these include Visual Studio C++ Build Tools, the Windows SDK and WebView2.
On Ubuntu install:

```sh
sudo apt-get install build-essential libwebkit2gtk-4.1-dev libssl-dev libxdo-dev librsvg2-dev libayatana-appindicator3-dev patchelf
```

From your checkout:

```sh
npm ci
npm run dev
npm run build
```

The build first scans the shipping frontend (`src/`) for test/demo material and likely
secrets or personal data, then produces installers in `src-tauri/target/release/bundle/`.
The scanner guards against common mistakes; review release contents as well.
For shared worktrees with a pre-existing node_modules junction, use the existing dependencies.

## Tests

```sh
npx playwright install chromium
npm test
npm run test:rust
npm run check:release
npm run test:app
```

`npm test` runs the frontend project against a local HTTP server and synthetic fixtures.
It enforces the same CSP as the desktop app and covers every page, charts and xterm.
Set `NODESCAPE_TEST_PORT=4214` to choose the server port (PowerShell:
`$env:NODESCAPE_TEST_PORT = '4214'`).

`npm run test:app` is a separate Windows/WebView2 project, excluded from `npm test`.
It builds the debug app, launches its executable with a free CDP port, attaches Playwright
to the real webview, and tears down the process and temporary profile/WebView2 folders.
Four tests cover first run, real IPC, denied commands and the enforced CSP.
The debug-only `NODESCAPE_CONFIG_DIR` override isolates profiles and managed SSH config;
release builds do not read it. Do not enable remote debugging for normal app use.

To enable the four additional real-host app tests, copy [test.env.example](test.env.example)
to `.env.test.local` at the repository root (`../.env.test.local` from `src-tauri`).
Fill in your local SSH config path, test alias and an existing remote test directory.
Use an unprivileged test account, verify its host key beforehand, and ensure key/agent
authentication works without a prompt. The app tests read Overview, echo a terminal marker,
list the test directory and render Network. Without the env file these tests are skipped.
Settings and host output must never be committed; app tests disable traces, video and screenshots.

Rust real-SSH integration tests are ignored by default. With the same local settings:

```sh
cargo test --manifest-path src-tauri/Cargo.toml -- --ignored
```

Some Rust integration tests create and remove files inside the configured test directory;
never point them at valuable data. CI uses no secrets or real hosts.
Additional release checks:

```sh
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
```

## Security model

- System OpenSSH handles keys, agents, SSH config and known_hosts. Normal connections
  use strict host-key checks; first-contact approval is explicit in OpenSSH's terminal prompt.
- Passwords are never stored. Sudo credentials are requested per action, sent over stdin
  for a fixed validated operation and discarded. Mutations are never automatically retried.
- Rust validates IPC inputs. Application commands are enrolled in an ACL manifest and granted
  only to the local main window. Dialog permissions allow only open/save; remote pages get none.
- Scripts and assets are local. CSP blocks inline scripts, eval, frames, forms and external
  connections; inline styles support charts and xterm's generated layout.
- No telemetry, account, cloud service or runtime CDN is required. The app works offline
  from the internet, provided your SSH server is reachable. Dependency downloads and installer
  tooling may need internet access during development or packaging.

See [SECURITY.md](SECURITY.md) for reporting and threat boundaries.

## License

NodeScape is licensed under the [Apache License, Version 2.0](LICENSE). See [NOTICE](NOTICE)
for attribution and the bundled third-party components (the Inter font under the SIL Open
Font License 1.1, and xterm.js under the MIT License), whose own license files ship with
the app in `src/fonts/` and `src/vendor/xterm/`.

Unless you state otherwise, any contribution you submit for inclusion is licensed under the
Apache License 2.0, without additional terms or conditions.
