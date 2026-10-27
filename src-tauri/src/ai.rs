//! The query editor's AI assistant. It brings the user's own AI: the Claude
//! Code or Cursor CLI, signed in with the user's subscription; an Anthropic API
//! key; or a local model behind an OpenAI-compatible endpoint (Ollama, LM
//! Studio). Keys live in the OS credential store.
//!
//! The model never gets a connection. It sees what the frontend puts in the
//! prompt (the schema, the editor text, an error or a plan), and the CLIs run
//! with every tool, MCP server, hook and settings file switched off, in an
//! empty folder, saving no session. When the user lets it read data, the
//! assistant can only ask for a query; `ai_sql_query` and `ai_mongo_query`
//! run it on a session of their own, refusing anything that writes.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::LazyLock;
use std::time::Duration;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::State;
use tokio::io::AsyncWriteExt as _;
use tokio::process::Command;
use tokio_util::sync::CancellationToken;

use crate::commands::AppState;
use crate::config::Engine;
use crate::drivers::mongo::{MongoOutput, MongoRequest};
use crate::error::{AppError, AppResult};
use crate::model::{ExecOptions, ExecOutput};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Provider {
    /// The `claude` CLI, signed in with a Claude subscription (or its own key)
    ClaudeCode,
    /// The Cursor CLI (`cursor-agent`, or `agent` in newer installs)
    Cursor,
    /// The Anthropic API with a key the user saved
    Anthropic,
    /// `/chat/completions` on a local or self-hosted server
    OpenaiCompatible,
}

impl Provider {
    fn programs(self) -> &'static [&'static str] {
        match self {
            Provider::ClaudeCode => &["claude"],
            Provider::Cursor => &["cursor-agent", "agent"],
            _ => &[],
        }
    }

    fn key_name(self) -> &'static str {
        match self {
            Provider::ClaudeCode => "claude-code",
            Provider::Cursor => "cursor",
            Provider::Anthropic => "anthropic",
            Provider::OpenaiCompatible => "openai-compatible",
        }
    }
}

/// Where the CLIs' installers put them, beyond what `cloud::find_program` checks.
fn cli_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(home) = std::env::home_dir() {
        dirs.push(home.join(".claude").join("local"));
        dirs.push(home.join(".local").join("bin"));
        dirs.push(home.join(".npm-global").join("bin"));
        dirs.push(home.join(".bun").join("bin"));
        dirs.push(home.join(".cursor").join("bin"));
    }
    dirs
}

fn locate(provider: Provider) -> Option<PathBuf> {
    crate::cloud::find_program(provider.programs(), &cli_dirs())
}

/* ---------- Status ---------- */

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiStatus {
    pub provider: Provider,
    /// The CLI found, for the CLI providers
    pub path: Option<String>,
    /// Whether a request can be sent as things stand
    pub ready: bool,
    /// Who it's signed in as, or what's missing
    pub detail: String,
}

fn status(
    provider: Provider,
    path: Option<&Path>,
    ready: bool,
    detail: impl Into<String>,
) -> AiStatus {
    AiStatus {
        provider,
        path: path.map(|p| p.display().to_string()),
        ready,
        detail: detail.into(),
    }
}

#[tauri::command]
pub async fn ai_status(provider: Provider, base_url: Option<String>) -> AiStatus {
    match provider {
        Provider::ClaudeCode | Provider::Cursor => cli_status(provider).await,
        Provider::Anthropic => {
            let saved = load_key(provider).is_some();
            status(
                provider,
                None,
                saved,
                if saved {
                    "API key saved in the credential store"
                } else {
                    "Add an Anthropic API key"
                },
            )
        }
        Provider::OpenaiCompatible => match base_url.as_deref().map(endpoint).transpose() {
            Ok(Some(base)) => match list_openai_models(&base).await {
                Ok(models) => status(
                    provider,
                    None,
                    true,
                    format!("{base} answered with {} models", models.len()),
                ),
                Err(e) => status(provider, None, false, e.to_string()),
            },
            Ok(None) => status(provider, None, false, "Set the server's URL"),
            Err(e) => status(provider, None, false, e.to_string()),
        },
    }
}

async fn cli_status(provider: Provider) -> AiStatus {
    let Some(path) = locate(provider) else {
        let hint = match provider {
            Provider::ClaudeCode => {
                "Claude Code isn't installed. Install it, then run `claude` once to sign in."
            }
            _ => "The Cursor CLI isn't installed. Install it, then run `cursor-agent login`.",
        };
        return status(provider, None, false, hint);
    };
    let args: &[&str] = match provider {
        Provider::ClaudeCode => &["auth", "status"],
        _ => &["status"],
    };
    let output = match run_cli(&path, args, None, None, Duration::from_secs(20), None).await {
        Ok(out) => out,
        Err(e) => return status(provider, Some(&path), false, e.to_string()),
    };
    let (ready, detail) = match provider {
        Provider::ClaudeCode => claude_auth(&output),
        _ => cursor_auth(&output),
    };
    status(provider, Some(&path), ready, detail)
}

/// Reads `claude auth status`, which prints JSON.
fn claude_auth(output: &str) -> (bool, String) {
    let Ok(json) = serde_json::from_str::<serde_json::Value>(output.trim()) else {
        return (false, "Couldn't read `claude auth status`".into());
    };
    if json["loggedIn"].as_bool() != Some(true) {
        return (
            false,
            "Not signed in. Run `claude auth login` in a terminal.".into(),
        );
    }
    let method = match json["authMethod"].as_str() {
        Some("claude.ai") => "Claude subscription",
        Some(other) => other,
        None => "signed in",
    };
    match json["email"].as_str() {
        Some(email) => (true, format!("{method} ({email})")),
        None => (true, method.to_string()),
    }
}

/// Reads `cursor-agent status`, whose text names the account or says it isn't signed in.
fn cursor_auth(output: &str) -> (bool, String) {
    let lower = output.to_lowercase();
    if lower.contains("not logged in")
        || lower.contains("not authenticated")
        || lower.contains("login required")
    {
        return (
            false,
            "Not signed in. Run `cursor-agent login` in a terminal.".into(),
        );
    }
    let email = output
        .split_whitespace()
        .map(|w| {
            w.trim_matches(|c: char| {
                !c.is_alphanumeric() && c != '@' && c != '.' && c != '-' && c != '_'
            })
        })
        .find(|w| w.contains('@') && w.contains('.'));
    match email {
        Some(email) => (true, format!("Cursor account ({email})")),
        None => (true, "Signed in to Cursor".into()),
    }
}

/// Models to offer: the Cursor account's, a local server's, or none (free text).
#[tauri::command]
pub async fn ai_models(provider: Provider, base_url: Option<String>) -> AppResult<Vec<String>> {
    match provider {
        Provider::Cursor => {
            let path =
                locate(provider).ok_or_else(|| AppError::msg("The Cursor CLI isn't installed"))?;
            let out = run_cli(
                &path,
                &["models"],
                None,
                None,
                Duration::from_secs(30),
                None,
            )
            .await?;
            Ok(parse_model_list(&out))
        }
        Provider::OpenaiCompatible => {
            let base = endpoint(base_url.as_deref().unwrap_or_default())?;
            list_openai_models(&base).await
        }
        _ => Ok(Vec::new()),
    }
}

/// Model ids from a listing like `- gpt-5 (default)` or `sonnet-4.5  Claude 4.5 Sonnet`.
fn parse_model_list(text: &str) -> Vec<String> {
    let mut models: Vec<String> = text
        .lines()
        .filter_map(|line| {
            let word = line
                .trim()
                .trim_start_matches(['-', '*', '•'])
                .split_whitespace()
                .next()?;
            let word = word.trim_end_matches([',', ':']);
            (valid_model(word)
                && word.chars().any(|c| c.is_ascii_digit() || c == '-')
                && word != "-")
                .then(|| word.to_string())
        })
        .collect();
    models.dedup();
    models
}

/// Model names go on a command line, so they're limited to what ids look like.
fn valid_model(model: &str) -> bool {
    !model.is_empty()
        && model.len() <= 128
        && !model.starts_with('-')
        && model.chars().all(|c| {
            c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | ':' | '/' | '[' | ']')
        })
}

/* ---------- Keys ---------- */

fn key_entry(provider: Provider) -> AppResult<keyring::Entry> {
    keyring::Entry::new(
        crate::config::KEYRING_SERVICE,
        &format!("ai-key:{}", provider.key_name()),
    )
    .map_err(|e| AppError::msg(format!("Credential store unavailable: {e}")))
}

fn load_key(provider: Provider) -> Option<String> {
    key_entry(provider)
        .ok()?
        .get_password()
        .ok()
        .filter(|k| !k.is_empty())
}

#[tauri::command]
pub fn ai_key_status(provider: Provider) -> bool {
    load_key(provider).is_some()
}

#[tauri::command]
pub fn ai_key_set(provider: Provider, key: String) -> AppResult<()> {
    key_entry(provider)?
        .set_password(key.trim())
        .map_err(|e| AppError::msg(format!("Could not save the key: {e}")))
}

#[tauri::command]
pub fn ai_key_delete(provider: Provider) {
    if let Ok(entry) = key_entry(provider) {
        let _ = entry.delete_credential();
    }
}

/* ---------- Chat ---------- */

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    User,
    Assistant,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: Role,
    pub content: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatRequest {
    pub provider: Provider,
    /// Empty for the provider's default
    #[serde(default)]
    pub model: String,
    pub system: String,
    pub messages: Vec<ChatMessage>,
    /// OpenAI-compatible servers only
    pub base_url: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatReply {
    pub text: String,
    /// The model that answered, when the provider says
    pub model: Option<String>,
}

const CHAT_TIMEOUT: Duration = Duration::from_secs(300);

static RUNNING: LazyLock<Mutex<HashMap<String, CancellationToken>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Removes a request from `RUNNING` however it ends.
struct Running(String);

impl Drop for Running {
    fn drop(&mut self) {
        RUNNING.lock().remove(&self.0);
    }
}

/// Sends the conversation and returns the reply. `ai_cancel(request_id)` stops it.
#[tauri::command]
pub async fn ai_chat(request_id: String, request: ChatRequest) -> AppResult<ChatReply> {
    if request.messages.last().is_none_or(|m| m.role != Role::User) {
        return Err(AppError::msg("The conversation must end with a question"));
    }
    let model = request.model.trim().to_string();
    if !model.is_empty() && !valid_model(&model) {
        return Err(AppError::msg(format!(
            "\"{model}\" isn't a valid model name"
        )));
    }
    let token = CancellationToken::new();
    {
        let mut running = RUNNING.lock();
        // Stop can reach the backend before this request does
        if EARLY_CANCELS.lock().remove(&request_id).is_some() {
            return Err(AppError::msg("Stopped"));
        }
        running.insert(request_id.clone(), token.clone());
    }
    let _running = Running(request_id);
    let work = async {
        match request.provider {
            Provider::ClaudeCode => claude_code(&model, &request).await,
            Provider::Cursor => cursor(&model, &request).await,
            Provider::Anthropic => anthropic(&model, &request).await,
            Provider::OpenaiCompatible => openai_compatible(&model, &request).await,
        }
    };
    let result = tokio::select! {
        result = work => result,
        _ = token.cancelled() => Err(AppError::msg("Stopped")),
    };
    if let Err(e) = &result {
        log::error!("AI assistant request ({:?}) failed: {e}", request.provider);
    }
    result
}

#[tauri::command]
pub fn ai_cancel(request_id: String) {
    let running = RUNNING.lock();
    match running.get(&request_id) {
        Some(token) => token.cancel(),
        // Not started yet: `ai_chat` refuses it when it arrives
        None => {
            let mut early = EARLY_CANCELS.lock();
            early.retain(|_, at| at.elapsed() < Duration::from_secs(60));
            early.insert(request_id, std::time::Instant::now());
        }
    }
}

/// Cancels that arrived before their request, kept a minute
static EARLY_CANCELS: LazyLock<Mutex<HashMap<String, std::time::Instant>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// The conversation as one prompt, for the CLIs, which take a single message.
fn transcript(messages: &[ChatMessage]) -> String {
    if let [only] = messages {
        return only.content.clone();
    }
    let mut out = String::from("The conversation so far, oldest first:\n\n");
    let (last, earlier) = messages.split_last().expect("not empty");
    for m in earlier {
        let tag = match m.role {
            Role::User => "user",
            Role::Assistant => "assistant",
        };
        out.push_str(&format!("<{tag}>\n{}\n</{tag}>\n\n", m.content));
    }
    out.push_str(&format!(
        "Reply to this latest message:\n\n{}",
        last.content
    ));
    out
}

/// An empty folder for one CLI request, so it has no project to read; deleted
/// when the request ends.
struct Sandbox(PathBuf);

impl Sandbox {
    fn new() -> AppResult<Self> {
        let dir = crate::cloud::workdir("ai-assistant")?.join(uuid::Uuid::new_v4().to_string());
        std::fs::create_dir(&dir)?;
        Ok(Self(dir))
    }
}

impl Drop for Sandbox {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

async fn claude_code(model: &str, request: &ChatRequest) -> AppResult<ChatReply> {
    let path = locate(Provider::ClaudeCode).ok_or_else(|| {
        AppError::msg("Claude Code isn't installed. Install it, then run `claude` once to sign in.")
    })?;
    let sandbox = Sandbox::new()?;
    let dir = &sandbox.0;
    // The schema can be long, so the system prompt goes in a file, not on the command line
    let system_file = dir.join("system-prompt.md");
    std::fs::write(&system_file, &request.system)?;
    let system_path = system_file.display().to_string();
    let mut args = vec![
        "--print",
        "--output-format",
        "json",
        // No tools at all: it can't read files, run commands or browse
        "--tools",
        "",
        // Ignore MCP servers, settings files (and their hooks), CLAUDE.md and plugins
        "--strict-mcp-config",
        "--setting-sources",
        "",
        "--safe-mode",
        "--disable-slash-commands",
        // Nothing is written to ~/.claude/projects
        "--no-session-persistence",
        "--system-prompt-file",
        &system_path,
    ];
    if !model.is_empty() {
        args.extend(["--model", model]);
    }
    let out = run_cli(
        &path,
        &args,
        Some(transcript(&request.messages)),
        Some(dir),
        CHAT_TIMEOUT,
        None,
    )
    .await?;
    let json: serde_json::Value = serde_json::from_str(out.trim()).map_err(|_| {
        AppError::msg(format!(
            "Unexpected output from Claude Code: {}",
            first_line(&out)
        ))
    })?;
    let text = json["result"].as_str().unwrap_or_default().to_string();
    if json["is_error"].as_bool() == Some(true) {
        return Err(AppError::msg(if text.is_empty() {
            "Claude Code reported an error".to_string()
        } else {
            text
        }));
    }
    let model = json["modelUsage"]
        .as_object()
        .and_then(|m| m.keys().next().cloned());
    Ok(ChatReply { text, model })
}

/// `.cursor/cli.json` for the sandbox: every tool denied, so ask mode stays a chat.
const CURSOR_PERMISSIONS: &str = r#"{
  "permissions": {
    "allow": [],
    "deny": ["Shell(*)", "Read(**)", "Read(/**)", "Write(**)", "Write(/**)", "WebFetch(*)", "Mcp(*:*)"]
  }
}
"#;

/// Longest prompt passed on Cursor's command line (it has no stdin input):
/// under Linux's 128 KiB per argument and Windows' 32K command line.
const CURSOR_MAX_PROMPT: usize = if cfg!(windows) { 30_000 } else { 120_000 };

async fn cursor(model: &str, request: &ChatRequest) -> AppResult<ChatReply> {
    let path = locate(Provider::Cursor).ok_or_else(|| {
        AppError::msg("The Cursor CLI isn't installed. Install it, then run `cursor-agent login`.")
    })?;
    let sandbox = Sandbox::new()?;
    let dir = &sandbox.0;
    std::fs::create_dir_all(dir.join(".cursor"))?;
    std::fs::write(dir.join(".cursor").join("cli.json"), CURSOR_PERMISSIONS)?;
    // No system prompt flag, so the instructions lead the message
    let prompt = format!(
        "<instructions>\n{}\n</instructions>\n\n{}",
        request.system,
        transcript(&request.messages)
    );
    if command_line_len(&prompt) > CURSOR_MAX_PROMPT {
        return Err(AppError::msg(
            "This request is too long for the Cursor CLI. Ask about fewer tables, or use another provider.",
        ));
    }
    let workspace = dir.display().to_string();
    let (program, script) = unwrap_batch_shim(&path)?;
    let mut args: Vec<&str> = script.iter().map(String::as_str).collect();
    args.extend([
        "--print",
        "--output-format",
        "json",
        // Ask mode answers questions and changes nothing; the sandbox and the
        // deny-all permissions above back that up. No --force, no --approve-mcps.
        "--mode",
        "ask",
        "--sandbox",
        "enabled",
        "--workspace",
        &workspace,
    ]);
    if !model.is_empty() {
        args.extend(["--model", model]);
    }
    args.push(&prompt);
    let out = run_cli(&program, &args, None, Some(dir), CHAT_TIMEOUT, None).await?;
    let json: serde_json::Value = serde_json::from_str(out.trim()).map_err(|_| {
        AppError::msg(format!(
            "Unexpected output from Cursor: {}",
            first_line(&out)
        ))
    })?;
    if json["is_error"].as_bool() == Some(true) {
        return Err(AppError::msg(
            json["result"]
                .as_str()
                .unwrap_or("Cursor reported an error")
                .to_string(),
        ));
    }
    Ok(ChatReply {
        text: json["result"].as_str().unwrap_or_default().to_string(),
        model: None,
    })
}

/// The program to run for a CLI, and the arguments that lead: the CLI itself,
/// or for a Windows batch shim (Cursor's installer puts `cursor-agent.cmd` on
/// PATH) the `node.exe` and script it launches. Arguments to a batch file pass
/// through cmd.exe, which mangles or refuses a multi-line prompt.
fn unwrap_batch_shim(path: &Path) -> AppResult<(PathBuf, Vec<String>)> {
    let batch = path
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("cmd") || e.eq_ignore_ascii_case("bat"));
    if !batch {
        return Ok((path.to_path_buf(), Vec::new()));
    }
    let unreadable = || {
        AppError::msg(format!(
            "{} is a batch script, which can't be given a multi-line prompt safely. \
             Reinstall the Cursor CLI, or use another provider.",
            path.display()
        ))
    };
    let text = std::fs::read_to_string(path).map_err(|_| unreadable())?;
    let dir = path.parent().ok_or_else(unreadable)?;
    // Quoted paths in the shim, with its own folder (%~dp0, %dp0%) filled in
    let folder = format!("{}{}", dir.display(), std::path::MAIN_SEPARATOR);
    let paths: Vec<PathBuf> = text
        .split('"')
        .map(|t| {
            let t = t.replace("%~dp0", &folder).replace("%dp0%", &folder);
            PathBuf::from(t.trim())
        })
        .filter(|p| p.is_file())
        .collect();
    let has = |ext: &str| {
        paths
            .iter()
            .find(|p| p.extension().is_some_and(|e| e.eq_ignore_ascii_case(ext)))
    };
    match (has("exe"), has("js")) {
        (Some(node), Some(script)) => Ok((node.clone(), vec![script.display().to_string()])),
        _ => Err(unreadable()),
    }
}

/// How long `arg` is once on the command line. Windows quotes it, escaping each
/// `"` and doubling the backslashes before one, so JSON-heavy prompts grow;
/// elsewhere arguments pass as they are.
fn command_line_len(arg: &str) -> usize {
    if !cfg!(windows) {
        return arg.len();
    }
    windows_quoted_len(arg)
}

fn windows_quoted_len(arg: &str) -> usize {
    let mut len = 2;
    let mut backslashes = 0;
    for c in arg.chars() {
        match c {
            '\\' => backslashes += 1,
            '"' => {
                len += backslashes * 2 + 2;
                backslashes = 0;
                continue;
            }
            _ => {
                len += backslashes;
                backslashes = 0;
            }
        }
        if c != '\\' {
            len += c.len_utf16();
        }
    }
    // Backslashes before the closing quote double too
    len + backslashes * 2
}

fn first_line(text: &str) -> String {
    let line = text
        .lines()
        .find(|l| !l.trim().is_empty())
        .unwrap_or_default();
    line.chars().take(200).collect()
}

/// Runs a CLI to completion and returns its standard output; `stdin` is
/// written then closed. Killed on timeout, on `cancel`, or when dropped.
async fn run_cli(
    program: &Path,
    args: &[&str],
    stdin: Option<String>,
    dir: Option<&Path>,
    timeout: Duration,
    cancel: Option<CancellationToken>,
) -> AppResult<String> {
    let mut command = Command::new(program);
    command
        .args(args)
        .stdin(if stdin.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .env("NO_COLOR", "1")
        .env("CI", "1");
    // Apps opened from Finder have a bare PATH, and the CLIs start node or bash
    if let Some(bin) = program.parent() {
        let mut paths = vec![bin.to_path_buf()];
        if let Some(path) = std::env::var_os("PATH") {
            paths.extend(std::env::split_paths(&path));
        }
        paths.extend(["/opt/homebrew/bin", "/usr/local/bin"].map(PathBuf::from));
        if let Ok(joined) = std::env::join_paths(paths) {
            command.env("PATH", joined);
        }
    }
    if let Some(dir) = dir {
        command.current_dir(dir);
    }
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let name = program
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let mut child = command
        .spawn()
        .map_err(|e| AppError::msg(format!("Couldn't start {name}: {e}")))?;
    // Written alongside waiting, under the same timeout: a CLI that never reads
    // stdin can't stall us, and one that exits early (a bad flag) shows its own
    // error rather than a broken pipe
    let pipe = child.stdin.take();
    let feed = async move {
        if let (Some(text), Some(mut pipe)) = (stdin, pipe) {
            let _ = pipe.write_all(text.as_bytes()).await;
        }
    };
    let run = async {
        let ((), output) = tokio::join!(feed, child.wait_with_output());
        output
    };
    let cancel = cancel.unwrap_or_default();
    let output = tokio::select! {
        out = tokio::time::timeout(timeout, run) => out
            .map_err(|_| AppError::msg(format!("{name} didn't answer within {}s", timeout.as_secs())))??,
        _ = cancel.cancelled() => return Err(AppError::msg("Stopped")),
    };
    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    if output.status.success() {
        return Ok(stdout);
    }
    // Claude Code reports errors as JSON on stdout with a failing exit code
    if stdout.trim_start().starts_with('{') {
        return Ok(stdout);
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    let message = [stderr.trim(), stdout.trim()]
        .into_iter()
        .find(|s| !s.is_empty())
        .map(|s| s.lines().take(5).collect::<Vec<_>>().join("\n"))
        .unwrap_or_else(|| format!("exited with {}", output.status));
    Err(AppError::msg(format!("{name}: {message}")))
}

static HTTP: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .timeout(CHAT_TIMEOUT)
        .user_agent(concat!("dbms-tool/", env!("CARGO_PKG_VERSION")))
        // A redirect would resend the prompt (schema, rows) and key somewhere else
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .expect("HTTP client")
});

const ANTHROPIC_DEFAULT_MODEL: &str = "claude-opus-5-5";

/// Models that take the server-side `fallbacks` parameter, which re-runs a
/// declined request on another model instead of stopping
fn takes_fallbacks(model: &str) -> bool {
    matches!(
        model,
        "claude-fable-5-1" | "claude-opus-5-5" | "claude-opus-5" | "claude-sonnet-5-5"
    )
}

async fn anthropic(model: &str, request: &ChatRequest) -> AppResult<ChatReply> {
    let key = load_key(Provider::Anthropic)
        .ok_or_else(|| AppError::msg("Add an Anthropic API key in Settings → AI assistant"))?;
    let model = if model.is_empty() {
        ANTHROPIC_DEFAULT_MODEL
    } else {
        model
    };
    let mut body = serde_json::json!({
        "model": model,
        "max_tokens": 16000,
        "system": request.system,
        "messages": request.messages,
    });
    let mut http = HTTP
        .post("https://api.anthropic.com/v1/messages")
        .header("x-api-key", key)
        .header("anthropic-version", "2023-06-01");
    if takes_fallbacks(model) {
        body["fallbacks"] = "default".into();
        http = http.header("anthropic-beta", "server-side-fallback-2026-07-01");
    }
    let response = http
        .json(&body)
        .send()
        .await
        .map_err(|e| AppError::msg(format!("Couldn't reach the Anthropic API: {e}")))?;
    let status = response.status();
    let json: serde_json::Value = response.json().await.unwrap_or_default();
    if !status.is_success() {
        let message = json["error"]["message"]
            .as_str()
            .unwrap_or("request failed");
        return Err(AppError::msg(format!(
            "Anthropic API ({status}): {message}"
        )));
    }
    if json["stop_reason"] == "refusal" {
        return Err(AppError::msg("The model declined to answer this request"));
    }
    let text = json["content"]
        .as_array()
        .map(|blocks| {
            blocks
                .iter()
                .filter(|b| b["type"] == "text")
                .filter_map(|b| b["text"].as_str())
                .collect::<Vec<_>>()
                .join("")
        })
        .unwrap_or_default();
    Ok(ChatReply {
        text,
        model: json["model"].as_str().map(str::to_string),
    })
}

/// A server's base URL without the trailing slash; http(s) only.
fn endpoint(base: &str) -> AppResult<String> {
    let base = base.trim().trim_end_matches('/');
    let url =
        reqwest::Url::parse(base).map_err(|_| AppError::msg(format!("\"{base}\" isn't a URL")))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(AppError::msg(
            "The server URL must start with http:// or https://",
        ));
    }
    Ok(base.to_string())
}

/// Adds the saved key, which only goes over HTTPS or to this machine: plain
/// HTTP to another host would send it in the clear.
fn with_key(base: &str, builder: reqwest::RequestBuilder) -> AppResult<reqwest::RequestBuilder> {
    let Some(key) = load_key(Provider::OpenaiCompatible) else {
        return Ok(builder);
    };
    if !key_allowed(base) {
        return Err(AppError::msg(
            "The saved key is only sent over https://, or over http:// to this computer. \
             Use an https:// URL for this server, or remove the key.",
        ));
    }
    Ok(builder.bearer_auth(key))
}

fn key_allowed(base: &str) -> bool {
    let Ok(url) = reqwest::Url::parse(base) else {
        return false;
    };
    url.scheme() == "https" || matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"))
}

async fn list_openai_models(base: &str) -> AppResult<Vec<String>> {
    let response = with_key(
        base,
        HTTP.get(format!("{base}/models"))
            .timeout(Duration::from_secs(10)),
    )?
    .send()
    .await
    .map_err(|e| AppError::msg(format!("Couldn't reach {base}: {e}")))?;
    let status = response.status();
    if !status.is_success() {
        return Err(AppError::msg(format!("{base}/models answered {status}")));
    }
    let json: serde_json::Value = response.json().await.unwrap_or_default();
    Ok(json["data"]
        .as_array()
        .map(|models| {
            models
                .iter()
                .filter_map(|m| m["id"].as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default())
}

async fn openai_compatible(model: &str, request: &ChatRequest) -> AppResult<ChatReply> {
    let base = endpoint(request.base_url.as_deref().unwrap_or_default())?;
    if model.is_empty() {
        return Err(AppError::msg(
            "Pick a model for the local server in Settings → AI assistant",
        ));
    }
    let mut messages = vec![serde_json::json!({ "role": "system", "content": request.system })];
    messages.extend(
        request
            .messages
            .iter()
            .map(|m| serde_json::to_value(m).unwrap_or_default()),
    );
    let response = with_key(&base, HTTP.post(format!("{base}/chat/completions")))?
        .json(&serde_json::json!({ "model": model, "messages": messages, "stream": false }))
        .send()
        .await
        .map_err(|e| AppError::msg(format!("Couldn't reach {base}: {e}")))?;
    let status = response.status();
    let json: serde_json::Value = response.json().await.unwrap_or_default();
    if !status.is_success() {
        let message = json["error"]["message"]
            .as_str()
            .or_else(|| json["error"].as_str())
            .unwrap_or("request failed");
        return Err(AppError::msg(format!("{base} ({status}): {message}")));
    }
    Ok(ChatReply {
        text: json["choices"][0]["message"]["content"]
            .as_str()
            .unwrap_or_default()
            .to_string(),
        model: json["model"].as_str().map(str::to_string),
    })
}

/* ---------- Data the assistant asks for ---------- */

/// Most rows a query the assistant asked for may return
const MAX_ROWS: usize = 500;
const QUERY_TIMEOUT_SECS: u64 = 30;

/// The session assistant queries run on, apart from the tab's own (and its transaction).
fn session_key(session: &str) -> String {
    format!("ai-assistant:{session}")
}

fn options(max_rows: usize, database: Option<String>) -> ExecOptions {
    ExecOptions {
        max_rows: max_rows.clamp(1, MAX_ROWS),
        read_only: true,
        timeout_secs: Some(QUERY_TIMEOUT_SECS),
        max_binary_bytes: 64,
        assistant: true,
        assistant_database: database,
        ..Default::default()
    }
}

/// Why the backend would refuse SQL the assistant wrote, checked before the
/// user is asked to approve it; `None` when it would run.
#[tauri::command]
pub fn ai_sql_check(
    state: State<'_, AppState>,
    id: String,
    sql: String,
) -> AppResult<Option<String>> {
    let engine = state.manager.get(&id)?.config.engine;
    Ok(crate::guard::assistant_blocked(&sql, engine)
        .map(|keyword| format!("it uses {keyword}, and the assistant can only read data")))
}

/// Like `ai_sql_check`, for a MongoDB read on the tab's `database`.
#[tauri::command]
pub fn ai_mongo_check(database: String, request: MongoRequest) -> Option<String> {
    request.assistant_refusal(&database)
}

/// Runs a query the assistant asked for, after the user allowed it, on a
/// session of its own. `Server::execute` refuses anything that writes (DELETE,
/// DROP, UPDATE, …) or acts on the server, whatever the frontend did, and puts
/// PostgreSQL and MySQL sessions in read-only mode so the server refuses writes too.
#[tauri::command]
pub async fn ai_sql_query(
    state: State<'_, AppState>,
    id: String,
    session: String,
    database: String,
    sql: String,
    max_rows: usize,
) -> AppResult<ExecOutput> {
    let server = state.manager.get(&id)?;
    if matches!(server.config.engine, Engine::Mongo | Engine::Redis) {
        return Err(AppError::msg("SQL queries can't run on this connection"));
    }
    server
        .execute(
            &session_key(&session),
            &database,
            &sql,
            &options(max_rows, None),
        )
        .await
}

/// Runs a MongoDB read the assistant asked for: find, aggregate (without
/// `$out` / `$merge`), count, distinct or listIndexes on the tab's `database`.
/// `Server::mongo_execute` refuses everything else (see `assistant_refusal`).
#[tauri::command]
pub async fn ai_mongo_query(
    state: State<'_, AppState>,
    id: String,
    session: String,
    // The tab's database: the only one the request may read
    database: String,
    request: MongoRequest,
    max_rows: usize,
) -> AppResult<MongoOutput> {
    let server = state.manager.get(&id)?;
    let max_rows = max_rows.clamp(1, MAX_ROWS);
    let mut output = server
        .mongo_execute(
            &session_key(&session),
            request,
            &options(max_rows, Some(database)),
        )
        .await?;
    // `distinct` hands back every value at once, past the row limit
    if let Some(serde_json::Value::Array(values)) = &mut output.value
        && values.len() > max_rows
    {
        values.truncate(max_rows);
        output.truncated = true;
    }
    Ok(output)
}

#[tauri::command]
pub async fn ai_session_close(
    state: State<'_, AppState>,
    id: String,
    session: String,
) -> AppResult<()> {
    if let Ok(server) = state.manager.get(&id) {
        server.close_session(&session_key(&session)).await;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transcript_keeps_turns_in_order() {
        let m = |role, content: &str| ChatMessage {
            role,
            content: content.into(),
        };
        assert_eq!(transcript(&[m(Role::User, "hi")]), "hi");
        let text = transcript(&[
            m(Role::User, "a"),
            m(Role::Assistant, "b"),
            m(Role::User, "c"),
        ]);
        assert!(text.contains("<user>\na\n</user>"));
        assert!(text.contains("<assistant>\nb\n</assistant>"));
        assert!(text.ends_with("c"));
    }

    #[test]
    fn model_names_cannot_become_flags() {
        assert!(valid_model("claude-opus-5-5"));
        assert!(valid_model("sonnet"));
        assert!(valid_model("qwen2.5-coder:7b"));
        assert!(valid_model("claude-sonnet-5-5[1m]"));
        assert!(!valid_model("--dangerously-skip-permissions"));
        assert!(!valid_model("a b"));
        assert!(!valid_model("x;rm"));
    }

    #[test]
    fn reads_model_listings() {
        let text =
            "Available models\n\n- auto (default)\n- gpt-5\n- sonnet-4.5  Claude 4.5 Sonnet\n";
        assert_eq!(parse_model_list(text), ["gpt-5", "sonnet-4.5"]);
    }

    #[test]
    fn reads_claude_auth_status() {
        let (ready, detail) =
            claude_auth(r#"{"loggedIn": true, "authMethod": "claude.ai", "email": "a@b.co"}"#);
        assert!(ready);
        assert_eq!(detail, "Claude subscription (a@b.co)");
        assert!(!claude_auth(r#"{"loggedIn": false}"#).0);
        assert!(!cursor_auth("Not logged in").0);
        assert!(cursor_auth("✓ Logged in as a@b.co").0);
    }

    /// Sends one request through the installed, signed-in Claude Code CLI:
    /// `cargo test --lib ai::tests::claude_code_answers -- --ignored`
    #[tokio::test]
    #[ignore = "needs a signed-in Claude Code CLI"]
    async fn claude_code_answers() {
        let reply = ai_chat(
            "live-test".into(),
            ChatRequest {
                provider: Provider::ClaudeCode,
                model: "haiku".into(),
                system: "You write SQL. Reply with one fenced sql block only.\n<schema>\npublic.users(id, email)\n</schema>".into(),
                messages: vec![ChatMessage {
                    role: Role::User,
                    content: "Count the users".into(),
                }],
                base_url: None,
            },
        )
        .await
        .expect("reply");
        assert!(
            reply.text.to_lowercase().contains("count"),
            "{}",
            reply.text
        );
    }

    #[test]
    fn keys_only_travel_safely() {
        assert!(key_allowed("https://llm.example.com/v1"));
        assert!(key_allowed("http://localhost:11434/v1"));
        assert!(key_allowed("http://127.0.0.1:1234/v1"));
        assert!(key_allowed("http://[::1]:1234/v1"));
        assert!(!key_allowed("http://192.168.1.20:11434/v1"));
        assert!(!key_allowed("http://llm.example.com/v1"));
    }

    #[test]
    fn batch_shims_run_their_node_script() {
        let dir = std::env::temp_dir().join(format!("dbms-tool-shim-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("versions")).unwrap();
        let node = dir.join("versions").join("node.exe");
        let script = dir.join("versions").join("index.js");
        std::fs::write(&node, "").unwrap();
        std::fs::write(&script, "").unwrap();
        let shim = dir.join("cursor-agent.cmd");
        let sep = std::path::MAIN_SEPARATOR;
        std::fs::write(
            &shim,
            format!(
                "@echo off\r\n\"%~dp0versions{sep}node.exe\" \"%~dp0versions{sep}index.js\" %*\r\n"
            ),
        )
        .unwrap();
        let (program, lead) = unwrap_batch_shim(&shim).unwrap();
        assert!(program.ends_with("node.exe"), "{}", program.display());
        assert!(lead[0].ends_with("index.js"));
        std::fs::write(&shim, "@echo off\r\nsomething %*\r\n").unwrap();
        assert!(unwrap_batch_shim(&shim).is_err());
        // Anything else runs as it is
        let plain = dir.join("cursor-agent");
        assert_eq!(
            unwrap_batch_shim(&plain).unwrap(),
            (plain.clone(), Vec::new())
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn windows_command_lines_count_escapes() {
        assert_eq!(windows_quoted_len("ab"), 4);
        // Each quote gains a backslash, and backslashes before one double
        assert_eq!(windows_quoted_len(r#"{"a":1}"#), 2 + 7 + 2);
        assert_eq!(windows_quoted_len(r#"a\"b"#), 2 + 1 + 2 + 2 + 1);
        assert_eq!(windows_quoted_len(r"a\b"), 2 + 3);
        assert_eq!(windows_quoted_len(r"a\"), 2 + 1 + 2);
    }

    #[test]
    fn a_cancel_before_the_request_still_stops_it() {
        ai_cancel("early".into());
        let reply = tauri::async_runtime::block_on(ai_chat(
            "early".into(),
            ChatRequest {
                provider: Provider::Anthropic,
                model: String::new(),
                system: String::new(),
                messages: vec![ChatMessage {
                    role: Role::User,
                    content: "hi".into(),
                }],
                base_url: None,
            },
        ));
        assert!(matches!(reply, Err(e) if e.to_string() == "Stopped"));
    }

    #[test]
    fn endpoints_must_be_http() {
        assert_eq!(
            endpoint("http://localhost:11434/v1/").unwrap(),
            "http://localhost:11434/v1"
        );
        assert!(endpoint("file:///etc").is_err());
        assert!(endpoint("nope").is_err());
    }
}
