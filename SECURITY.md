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
- Sudo passwords are transient: privileged actions request sudo per action and never store it.
- Server login passwords are typed when connecting and held in memory for the session. With
  "Remember on this computer" they are saved in Windows Credential Manager (DPAPI-encrypted for
  the Windows user, Local persistence so they never roam). No IPC command returns a saved
  password; it is removed when the server refuses it or the profile is removed. For each SSH
  connection the password is passed only through the ssh child's environment to NodeScape's own
  askpass mode, which answers password prompts only (never key passphrases, host key questions
  or password changes). Jump hosts run with BatchMode and never receive it. Any process running
  as the same Windows user can read Credential Manager and process environments, so this
  protects against other users and offline disk access, not against same-user malware.
- Profiles contain connection metadata. Their local confidentiality depends on OS access controls.
- There is no telemetry or cloud backend. Network access is limited to SSH targets and
  routes chosen by the user's SSH configuration. Debug builds used in app tests expose
  a local CDP endpoint; production operation must not enable remote debugging.

Release readiness also requires manual installer, native-picker, trust/passphrase, terminal
and disconnect testing. Automated tests and the release scanner are safeguards, not guarantees.
