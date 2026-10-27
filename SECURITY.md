# Security

Please report vulnerabilities through this repository's **Security → Report a vulnerability**
option when private reporting is enabled. If it is unavailable, open an issue requesting a
private reporting contact without including exploit details, host information, credentials
or private keys. The owner must configure a private reporting channel before release.

Include the affected version/platform, a minimal reproduction using made-up data, expected
behavior and impact. Do not attach real SSH config, known_hosts, terminal recordings or secrets.

## Threat model

- Remote host output and frontend input are untrusted. Rendering escapes text; Rust validates
  inputs, limits commands and enforces the local-window IPC ACL. CSP restricts script execution
  and network access. Interactive terminals intentionally permit arbitrary remote shell use.
- OpenSSH and its trust store authenticate servers. First-contact trust requires the user's
  fingerprint check and explicit approval; changed keys require investigation. The app does
  not establish a server's identity on the user's behalf.
- The local OS account, system SSH binary, SSH configuration, agent and selected identity
  files are trusted. NodeScape cannot protect against a compromised local account, malicious
  SSH configuration or an already compromised remote account/server.
- Passwords are transient; privileged actions request sudo per action. Profiles contain
  connection metadata. Their local confidentiality still depends on OS access controls.
- There is no telemetry or cloud backend. Network access is limited to SSH targets and
  routes chosen by the user's SSH configuration. Debug builds used in app tests expose
  a local CDP endpoint; production operation must not enable remote debugging.

Release readiness also requires manual installer, native-picker, trust/passphrase, terminal
and disconnect testing. Automated tests and the release scanner are safeguards, not guarantees.
