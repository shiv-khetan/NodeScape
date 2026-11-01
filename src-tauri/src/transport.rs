use crate::contracts::{
    auth_kind, classify_ssh_failure, classify_ssh_failure_redacted, redact_text, valid_host,
    AppError, ErrorKind, Target,
};
use crate::credentials;
use std::{
    collections::HashMap,
    io,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Mutex, OnceLock,
    },
    time::Duration,
};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWriteExt},
    process::Command,
    sync::watch,
    time::{sleep_until, Instant},
};

use zeroize::Zeroizing;

#[derive(Clone)]
pub struct RunOpts {
    pub timeout: Duration,
    /// Combined stdout and stderr capture limit, in bytes.
    pub max_output: usize,
    pub operation_id: Option<String>,
    pub ssh_program: PathBuf,
    /// Restrict trust to this file; ignore global keys, DNS and KnownHostsCommand.
    pub known_hosts_file: Option<PathBuf>,
    /// Secret removed from output before any remote diagnostic becomes an AppError.
    pub(crate) redact: Option<Zeroizing<String>>,
    /// Program ssh runs as SSH_ASKPASS for password logins: NodeScape itself (see askpass.rs).
    pub askpass_program: PathBuf,
    /// Run `ssh -v` and copy the redacted client log here, for connection diagnostics.
    pub(crate) diagnostics: Option<std::sync::Arc<Mutex<String>>>,
}

impl Default for RunOpts {
    fn default() -> Self {
        Self {
            timeout: Duration::from_secs(15),
            max_output: 16 * 1024 * 1024,
            operation_id: None,
            ssh_program: ssh_program(),
            known_hosts_file: None,
            redact: None,
            askpass_program: std::env::current_exe().unwrap_or_else(|_| "nodescape".into()),
            diagnostics: None,
        }
    }
}

pub(crate) fn ssh_program() -> PathBuf {
    #[cfg(windows)]
    if let Some(root) = std::env::var_os("SystemRoot") {
        let program = Path::new(&root).join("System32/OpenSSH/ssh.exe");
        if program.is_file() {
            return program;
        }
    }
    "ssh".into()
}

const OPTIONS: &[&str] = &[
    "BatchMode=yes",
    "ConnectTimeout=5",
    "RequestTTY=no",
    "SessionType=default",
    "ClearAllForwardings=yes",
    "PermitLocalCommand=no",
    "StrictHostKeyChecking=yes",
    "UpdateHostKeys=no",
    "ForkAfterAuthentication=no",
    "ControlMaster=no",
    "ControlPath=none",
    "ControlPersist=no",
];

/// With a saved login password, ssh may prompt once and asks NodeScape (askpass) for the answer.
fn connection_options(password: bool) -> impl Iterator<Item = &'static str> {
    OPTIONS
        .iter()
        .map(move |option| match *option {
            "BatchMode=yes" if password => "BatchMode=no",
            other => other,
        })
        .chain(password.then_some("NumberOfPasswordPrompts=1"))
}

/// The password only ever travels in the ssh child's environment, never in argv or on disk.
fn askpass_env(command: &mut Command, opts: &RunOpts, password: &str) {
    command
        .env("SSH_ASKPASS", &opts.askpass_program)
        .env("SSH_ASKPASS_REQUIRE", "force")
        .env(crate::askpass::SECRET_ENV, password);
}

/// "Permission denied" from a server that accepts passwords means "ask for one" or "that one was wrong".
fn refine_auth(mut error: AppError, target: &Target, text: &str, used_password: bool) -> AppError {
    if error.kind == ErrorKind::AuthFailed {
        if let Some(kind) = auth_kind(text, used_password) {
            error.kind = kind;
            if used_password {
                credentials::forget(target);
            }
        }
    }
    error
}

#[derive(serde::Serialize)]
pub struct Diagnosis {
    pub ok: bool,
    pub error: Option<AppError>,
    pub log: String,
}

/// Connect with `ssh -v`, run nothing but `exit`, and return the typed outcome with the client log.
pub async fn diagnose(target: &Target, mut opts: RunOpts) -> Diagnosis {
    let sink = std::sync::Arc::new(Mutex::new(String::new()));
    opts.diagnostics = Some(sink.clone());
    let result = run(target, "exit 0\n", opts).await;
    let log = std::mem::take(&mut *sink.lock().unwrap_or_else(|e| e.into_inner()));
    match result {
        Ok(_) => Diagnosis {
            ok: true,
            error: None,
            log,
        },
        Err(error) => Diagnosis {
            ok: false,
            error: Some(error),
            log,
        },
    }
}

/// `ssh -G` (the ProxyJump lookup) runs before every connection; cache its answer briefly.
/// The key includes the ssh program, config path and the config file's size and modification time,
/// so editing the config is picked up at once. ponytail: Include'd files only refresh after the TTL.
const PROXY_TTL: Duration = Duration::from_secs(60);
type ProxyCache = Mutex<HashMap<String, (std::time::Instant, Option<String>)>>;

fn proxy_cache() -> &'static ProxyCache {
    static CACHE: OnceLock<ProxyCache> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn proxy_cache_key(target: &Target, opts: &RunOpts) -> String {
    let config = selected_config(target).map(PathBuf::from).or_else(|| {
        std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
            .map(|home| Path::new(&home).join(".ssh").join("config"))
    });
    let stamp = config
        .as_deref()
        .and_then(|path| std::fs::metadata(path).ok())
        .map(|m| format!("{}:{:?}", m.len(), m.modified().ok()))
        .unwrap_or_default();
    format!(
        "{}\0{}\0{}\0{}",
        opts.ssh_program.display(),
        selected_config(target).unwrap_or(""),
        target.host,
        stamp
    )
}

/// The ProxyJump value for this target ("none" filtered out), from cache or a fresh `ssh -G`.
async fn proxy_jump(
    target: &Target,
    opts: &RunOpts,
    deadline: Instant,
    cancelled: &mut watch::Receiver<bool>,
) -> Result<Option<String>, AppError> {
    let key = proxy_cache_key(target, opts);
    if let Some((at, jump)) = proxy_cache()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&key)
    {
        if at.elapsed() < PROXY_TTL {
            return Ok(jump.clone());
        }
    }
    let config = invoke(target, None, opts, None, deadline, cancelled).await?;
    let jump = config
        .lines()
        .find_map(|line| line.strip_prefix("proxyjump "))
        .filter(|jump| !jump.eq_ignore_ascii_case("none"))
        .map(str::to_owned);
    proxy_cache()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(key, (std::time::Instant::now(), jump.clone()));
    Ok(jump)
}

type Operations = Mutex<HashMap<String, watch::Sender<bool>>>;

fn operations() -> &'static Operations {
    static OPERATIONS: OnceLock<Operations> = OnceLock::new();
    OPERATIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

struct Registration(Option<String>);

impl Registration {
    fn new(id: Option<String>, sender: watch::Sender<bool>) -> Result<Self, AppError> {
        if let Some(id) = &id {
            if id.is_empty() {
                return Err(AppError::new(ErrorKind::InvalidInput, "Empty operation id"));
            }
            let mut registry = operations().lock().unwrap_or_else(|e| e.into_inner());
            if registry.contains_key(id) {
                return Err(AppError::new(
                    ErrorKind::InvalidInput,
                    "Operation id is already in use",
                ));
            }
            registry.insert(id.clone(), sender);
        }
        Ok(Self(id))
    }
}

impl Drop for Registration {
    fn drop(&mut self) {
        if let Some(id) = &self.0 {
            operations()
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(id);
        }
    }
}

/// The running call owns and reaps its child, and returns ErrorKind::Cancelled.
/// Repeated cancellation is harmless; false means the operation is no longer registered.
pub async fn operation_cancel(id: &str) -> Result<bool, AppError> {
    let registry = operations().lock().unwrap_or_else(|e| e.into_inner());
    Ok(registry
        .get(id)
        .is_some_and(|sender| sender.send(true).is_ok()))
}

fn local_error(error: io::Error) -> AppError {
    AppError::new(ErrorKind::Internal, error.to_string())
}

fn validate(target: &Target) -> Result<(), AppError> {
    if !valid_host(&target.host) {
        return Err(AppError::new(
            ErrorKind::InvalidInput,
            "Invalid host. Use an ssh config alias or user@host.",
        ));
    }
    if let Some(config) = selected_config(target) {
        if config.contains(['\0', '\r', '\n']) || !Path::new(config).is_file() {
            return Err(AppError::new(
                ErrorKind::InvalidInput,
                "SSH config file not found or invalid path",
            ));
        }
    }
    Ok(())
}

fn selected_config(target: &Target) -> Option<&str> {
    target
        .config
        .as_deref()
        .map(str::trim)
        .filter(|c| !c.is_empty())
}

fn quote(value: &str) -> Result<String, AppError> {
    if value.contains(['\0', '\r', '\n']) {
        return Err(AppError::new(
            ErrorKind::InvalidInput,
            "Invalid proxy argument",
        ));
    }
    // OpenSSH expands percent tokens before launching the proxy command.
    let value = value.replace('%', "%%");
    #[cfg(windows)]
    {
        // Windows argv quoting: double backslashes before a quote or the closing delimiter.
        let mut quoted = String::from("\"");
        let mut slashes = 0;
        for c in value.chars() {
            if c == '\\' {
                slashes += 1;
                continue;
            }
            if c == '"' {
                quoted.extend(std::iter::repeat_n('\\', slashes * 2 + 1));
            } else {
                quoted.extend(std::iter::repeat_n('\\', slashes));
            }
            slashes = 0;
            quoted.push(c);
        }
        quoted.extend(std::iter::repeat_n('\\', slashes * 2));
        quoted.push('"');
        Ok(quoted)
    }
    #[cfg(not(windows))]
    {
        Ok(format!("'{}'", value.replace('\'', "'\\''")))
    }
}

fn known_hosts_option(path: &Path) -> Result<String, AppError> {
    let path = path_text(path)?;
    if path.contains(['\0', '\r', '\n', '"']) {
        return Err(AppError::new(
            ErrorKind::InvalidInput,
            "Invalid known_hosts path",
        ));
    }
    #[cfg(windows)]
    let path = path.replace('\\', "/");
    Ok(format!("UserKnownHostsFile=\"{path}\""))
}

fn path_text(path: &Path) -> Result<&str, AppError> {
    path.to_str()
        .ok_or_else(|| AppError::new(ErrorKind::InvalidInput, "SSH path must be UTF-8"))
}

pub(crate) fn proxy_command(
    target: &Target,
    program: &Path,
    jump: &str,
    known_hosts: Option<&Path>,
) -> Result<String, AppError> {
    if jump.contains(',') {
        return Err(AppError::new(
            ErrorKind::InvalidInput,
            "Multiple jump hosts are not supported yet",
        ));
    }
    // ProxyJump uses [user@]host[:port], whereas ssh takes the port as a separate argument.
    let (user, host_port) = match jump.split_once('@') {
        Some((user, rest))
            if !user.is_empty()
                && user
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || "._-".contains(c)) =>
        {
            (format!("{user}@"), rest)
        }
        Some(_) => return Err(AppError::new(ErrorKind::InvalidInput, "Invalid jump host")),
        None => (String::new(), jump),
    };
    let (host, port) = if let Some(rest) = host_port.strip_prefix('[') {
        let (host, suffix) = rest
            .split_once(']')
            .ok_or_else(|| AppError::new(ErrorKind::InvalidInput, "Invalid jump host"))?;
        let port = if suffix.is_empty() {
            None
        } else {
            Some(
                suffix
                    .strip_prefix(':')
                    .ok_or_else(|| AppError::new(ErrorKind::InvalidInput, "Invalid jump port"))?,
            )
        };
        (host, port)
    } else if host_port.matches(':').count() == 1 {
        let (host, port) = host_port.split_once(':').expect("one colon");
        (host, Some(port))
    } else {
        (host_port, None)
    };
    let hop = format!("{user}{host}");
    if host.is_empty() || host.starts_with('-') || !valid_host(&hop) {
        return Err(AppError::new(ErrorKind::InvalidInput, "Invalid jump host"));
    }
    if let Some(port) = port {
        if port.parse::<u16>().ok().filter(|p| *p != 0).is_none() {
            return Err(AppError::new(ErrorKind::InvalidInput, "Invalid jump port"));
        }
    }
    let mut parts = vec![quote(path_text(program)?)?];
    if let Some(config) = selected_config(target) {
        parts.extend(["-F".into(), quote(config)?]);
    }
    parts.push("-T".into());
    for option in OPTIONS {
        parts.extend(["-o".into(), (*option).into()]);
    }
    // This package supports one hop; do not let its config silently start another proxy.
    for option in ["ProxyJump=none", "ProxyCommand=none"] {
        parts.extend(["-o".into(), option.into()]);
    }
    if let Some(path) = known_hosts {
        parts.extend(["-o".into(), quote(&known_hosts_option(path)?)?]);
        for option in [
            "GlobalKnownHostsFile=none",
            "KnownHostsCommand=none",
            "VerifyHostKeyDNS=no",
        ] {
            parts.extend(["-o".into(), option.into()]);
        }
    }
    if let Some(port) = port {
        parts.extend(["-p".into(), port.into()]);
    }
    parts.extend(["-W".into(), "\"%h:%p\"".into(), "--".into(), quote(&hop)?]);
    Ok(parts.join(" "))
}

async fn capture(
    mut stream: impl AsyncRead + Unpin,
    captured: &AtomicUsize,
    limit: usize,
) -> Result<Zeroizing<Vec<u8>>, AppError> {
    let mut output = Zeroizing::new(Vec::new());
    let mut buffer = Zeroizing::new([0; 8192]);
    loop {
        let count = stream.read(&mut buffer[..]).await.map_err(local_error)?;
        if count == 0 {
            return Ok(output);
        }
        // Both streams share one budget; the call fails as soon as it is exceeded.
        if captured
            .fetch_add(count, Ordering::Relaxed)
            .saturating_add(count)
            > limit
        {
            return Err(AppError::new(ErrorKind::Remote, "output too large"));
        }
        output.extend_from_slice(&buffer[..count]);
    }
}

pub async fn run(target: &Target, script: &str, opts: RunOpts) -> Result<String, AppError> {
    execute(target, Some(script), opts).await
}

/// None is the bounded, local-only ssh -G inspection path.
pub(crate) async fn execute(
    target: &Target,
    script: Option<&str>,
    opts: RunOpts,
) -> Result<String, AppError> {
    let deadline = Instant::now() + opts.timeout;
    validate(target)?;
    let (sender, mut cancelled) = watch::channel(false);
    let _registration = Registration::new(opts.operation_id.clone(), sender.clone())?;
    // Keep the channel open for calls without an operation id too.
    let _sender = sender;
    let proxy = if script.is_some() {
        proxy_jump(target, &opts, deadline, &mut cancelled)
            .await?
            .map(|jump| {
                proxy_command(
                    target,
                    &opts.ssh_program,
                    &jump,
                    opts.known_hosts_file.as_deref(),
                )
            })
            .transpose()?
    } else {
        None
    };
    invoke(
        target,
        script,
        &opts,
        proxy.as_deref(),
        deadline,
        &mut cancelled,
    )
    .await
}

async fn invoke(
    target: &Target,
    script: Option<&str>,
    opts: &RunOpts,
    proxy: Option<&str>,
    deadline: Instant,
    cancelled: &mut watch::Receiver<bool>,
) -> Result<String, AppError> {
    let mut command = Command::new(&opts.ssh_program);
    if let Some(config) = selected_config(target) {
        command.arg("-F").arg(config);
    }
    command.arg("-T");
    // `ssh -G` only reads config, so it never needs the login password.
    let password = script.and(credentials::password(target));
    if let Some(password) = &password {
        askpass_env(&mut command, opts, password);
    }
    for option in connection_options(password.is_some()) {
        command.arg("-o").arg(option);
    }
    if opts.diagnostics.is_some() && script.is_some() {
        command.arg("-v");
    }
    if let Some(path) = &opts.known_hosts_file {
        command.arg("-o").arg(known_hosts_option(path)?);
        for option in [
            "GlobalKnownHostsFile=none",
            "KnownHostsCommand=none",
            "VerifyHostKeyDNS=no",
        ] {
            command.arg("-o").arg(option);
        }
    }
    if let Some(proxy) = proxy {
        command.arg("-o").arg(format!("ProxyCommand={proxy}"));
    }
    if script.is_none() {
        command.arg("-G");
    }
    command.arg("--").arg(&target.host);
    if script.is_some() {
        command.arg("sh -s");
    }
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    let mut child = command.spawn().map_err(|error| {
        let kind = if error.kind() == io::ErrorKind::NotFound {
            ErrorKind::SshMissing
        } else {
            ErrorKind::Internal
        };
        AppError::new(kind, format!("Could not start ssh: {error}"))
    })?;
    let mut stdin = child.stdin.take().expect("piped stdin");
    let stdout = child.stdout.take().expect("piped stdout");
    let stderr = child.stderr.take().expect("piped stderr");
    let captured = AtomicUsize::new(0);
    let result = tokio::select! {
        biased;
        _ = cancelled.changed() => Err(AppError::new(ErrorKind::Cancelled, "Operation cancelled")),
        _ = sleep_until(deadline) => Err(AppError::new(ErrorKind::Timeout, "SSH operation timed out")),
        result = async {
            tokio::try_join!(
                capture(stdout, &captured, opts.max_output),
                capture(stderr, &captured, opts.max_output),
                // An early SSH failure closes stdin. Read its diagnostic before classifying it.
                async move {
                    let written = stdin.write_all(script.unwrap_or_default().as_bytes()).await;
                    drop(stdin);
                    Ok::<_, AppError>(written)
                },
                async { child.wait().await.map_err(local_error) },
            )
        } => result,
    };
    match result {
        Ok((stdout, stderr, written, status)) => {
            let secret = opts.redact.as_ref().map(|secret| secret.as_str());
            let login = password.as_ref().map(|p| p.as_str());
            let stdout = redact_text(&String::from_utf8_lossy(&stdout), login);
            let stderr = redact_text(&String::from_utf8_lossy(&stderr), login);
            if let Some(sink) = &opts.diagnostics {
                let log = redact_text(&stderr, secret);
                *sink.lock().unwrap_or_else(|e| e.into_inner()) =
                    log.chars().take(64 * 1024).collect();
            }
            if !status.success() {
                let error = match secret {
                    Some(secret) => {
                        classify_ssh_failure_redacted(&stderr, &stdout, status.code(), Some(secret))
                    }
                    None => classify_ssh_failure(&stderr, &stdout, status.code()),
                };
                return Err(refine_auth(error, target, &stderr, login.is_some()));
            }
            written.map_err(local_error)?;
            let mut stdout = redact_text(&stdout, secret);
            Ok(std::mem::take(&mut *stdout))
        }
        Err(error) => {
            // Terminate and reap before returning; kill_on_drop also covers dropped caller futures.
            let _ = child.kill().await;
            Err(error)
        }
    }
}

// Binary subsystem ownership is separate from script execution so run() keeps its existing semantics.
pub struct Subsystem {
    pub stdin: Option<tokio::process::ChildStdin>,
    pub stdout: Option<tokio::process::ChildStdout>,
    pub cancelled: watch::Receiver<bool>,
    child: tokio::process::Child,
    diagnostics: std::sync::Arc<Mutex<Vec<u8>>>,
    stderr_task: tokio::task::JoinHandle<()>,
    _registration: Registration,
    _sender: watch::Sender<bool>,
}

impl Subsystem {
    /// Preserve OpenSSH's typed authentication / trust diagnostic when SFTP initialization fails.
    pub async fn failure(&mut self, fallback: AppError) -> AppError {
        let status = tokio::time::timeout(Duration::from_millis(100), self.child.wait()).await;
        if let Ok(Ok(status)) = status {
            let _ = (&mut self.stderr_task).await;
            let bytes = self.diagnostics.lock().unwrap_or_else(|e| e.into_inner());
            if !status.success() {
                return classify_ssh_failure(&String::from_utf8_lossy(&bytes), "", status.code());
            }
        }
        fallback
    }

    pub async fn stop(&mut self) {
        let _ = self.child.kill().await;
        self.stderr_task.abort();
    }
}

impl Drop for Subsystem {
    fn drop(&mut self) {
        self.stderr_task.abort();
        // Child has kill_on_drop; the registration is removed even if the caller future is dropped.
    }
}

/// Spawn only a named subsystem, never a remote shell command. The caller owns cancellation cleanup.
pub async fn spawn_subsystem(
    target: &Target,
    subsystem: &str,
    opts: RunOpts,
) -> Result<Subsystem, AppError> {
    if subsystem != "sftp" {
        return Err(AppError::new(
            ErrorKind::InvalidInput,
            "Unsupported SSH subsystem",
        ));
    }
    let deadline = Instant::now() + opts.timeout;
    validate(target)?;
    let (sender, mut cancelled) = watch::channel(false);
    let registration = Registration::new(opts.operation_id.clone(), sender.clone())?;
    let proxy = proxy_jump(target, &opts, deadline, &mut cancelled)
        .await?
        .map(|jump| {
            proxy_command(
                target,
                &opts.ssh_program,
                &jump,
                opts.known_hosts_file.as_deref(),
            )
        })
        .transpose()?;
    if *cancelled.borrow() {
        return Err(AppError::new(ErrorKind::Cancelled, "Operation cancelled"));
    }
    let mut command = Command::new(&opts.ssh_program);
    if let Some(config) = selected_config(target) {
        command.arg("-F").arg(config);
    }
    command.arg("-T");
    let password = credentials::password(target);
    if let Some(password) = &password {
        askpass_env(&mut command, &opts, password);
    }
    for option in connection_options(password.is_some()) {
        // OpenSSH rejects `-s` together with SessionType, so request the subsystem through it.
        let option = if option == "SessionType=default" {
            "SessionType=subsystem"
        } else {
            option
        };
        command.arg("-o").arg(option);
    }
    if let Some(path) = &opts.known_hosts_file {
        command.arg("-o").arg(known_hosts_option(path)?);
        for option in [
            "GlobalKnownHostsFile=none",
            "KnownHostsCommand=none",
            "VerifyHostKeyDNS=no",
        ] {
            command.arg("-o").arg(option);
        }
    }
    if let Some(proxy) = proxy {
        command.arg("-o").arg(format!("ProxyCommand={proxy}"));
    }
    command
        .arg("--")
        .arg(&target.host)
        .arg(subsystem)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x0800_0000);
    let mut child = command.spawn().map_err(|error| {
        AppError::new(
            if error.kind() == io::ErrorKind::NotFound {
                ErrorKind::SshMissing
            } else {
                ErrorKind::Internal
            },
            format!("Could not start ssh: {error}"),
        )
    })?;
    let stdin = child.stdin.take();
    let stdout = child.stdout.take();
    let mut stderr = child.stderr.take().expect("piped stderr");
    let diagnostics = std::sync::Arc::new(Mutex::new(Vec::new()));
    let captured = diagnostics.clone();
    let stderr_task = tokio::spawn(async move {
        let mut buffer = [0; 4096];
        while let Ok(count) = stderr.read(&mut buffer).await {
            if count == 0 {
                break;
            }
            let mut bytes = captured.lock().unwrap_or_else(|e| e.into_inner());
            let keep = count.min(16_384usize.saturating_sub(bytes.len()));
            bytes.extend_from_slice(&buffer[..keep]);
        }
    });
    Ok(Subsystem {
        stdin,
        stdout,
        cancelled,
        child,
        diagnostics,
        stderr_task,
        _registration: registration,
        _sender: sender,
    })
}
