use crate::contracts::{
    classify_ssh_failure, classify_ssh_failure_redacted, redact_text, valid_host, AppError,
    ErrorKind, Target,
};
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
        if captured
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |size| {
                size.checked_add(count).filter(|total| *total <= limit)
            })
            .is_err()
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
        let config = invoke(target, None, &opts, None, deadline, &mut cancelled).await?;
        let jump = config
            .lines()
            .find_map(|line| line.strip_prefix("proxyjump "))
            .filter(|jump| !jump.eq_ignore_ascii_case("none"));
        jump.map(|jump| {
            proxy_command(
                target,
                &opts.ssh_program,
                jump,
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
    for option in OPTIONS {
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
            let stdout = Zeroizing::new(String::from_utf8_lossy(&stdout).into_owned());
            let stderr = Zeroizing::new(String::from_utf8_lossy(&stderr).into_owned());
            if !status.success() {
                return Err(match secret {
                    Some(secret) => {
                        classify_ssh_failure_redacted(&stderr, &stdout, status.code(), Some(secret))
                    }
                    None => classify_ssh_failure(&stderr, &stdout, status.code()),
                });
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
