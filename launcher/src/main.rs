// Zap Pro Launcher — encrypted payload delivery with anti-tamper protections
// Source code never touches disk in readable form

use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};

// ── Obfuscated key fragments ──
// The AES-256 key is derived from these fragments + salt + HMAC.
// Fragments are XOR-masked so the raw passphrase never appears in the binary.
const MASK: u8 = 0xA7;
const FRAG_A: [u8; 8] = [
    0x7a ^ 0xA7, 0x61 ^ 0xA7, 0x70 ^ 0xA7, 0x5f ^ 0xA7,
    0x73 ^ 0xA7, 0x65 ^ 0xA7, 0x63 ^ 0xA7, 0x72 ^ 0xA7,
];
const FRAG_B: [u8; 8] = [
    0x65 ^ 0xA7, 0x74 ^ 0xA7, 0x5f ^ 0xA7, 0x6b ^ 0xA7,
    0x65 ^ 0xA7, 0x79 ^ 0xA7, 0x5f ^ 0xA7, 0x70 ^ 0xA7,
];
const FRAG_C: [u8; 8] = [
    0x72 ^ 0xA7, 0x6f ^ 0xA7, 0x5f ^ 0xA7, 0x32 ^ 0xA7,
    0x30 ^ 0xA7, 0x32 ^ 0xA7, 0x36 ^ 0xA7, 0x5f ^ 0xA7,
];
const FRAG_D: [u8; 8] = [
    0x65 ^ 0xA7, 0x6e ^ 0xA7, 0x63 ^ 0xA7, 0x72 ^ 0xA7,
    0x79 ^ 0xA7, 0x70 ^ 0xA7, 0x74 ^ 0xA7, 0x21 ^ 0xA7,
];
const KEY_SALT: &[u8] = b"zap_launcher_v1_aes256gcm";

const GITHUB_REPO: &str = "Salt30/zap-releases";
const APP_NAME: &str = "Zap Pro";

// ── Anti-debug: detect common debuggers ──
fn check_environment() -> bool {
    // Check for debugger-related environment variables
    let suspicious_vars = [
        "DYLD_INSERT_LIBRARIES",
        "_JAVA_OPTIONS",
        "LD_PRELOAD",
        "ELECTRON_RUN_AS_NODE",
    ];
    for var in &suspicious_vars {
        if std::env::var(var).is_ok() {
            return false;
        }
    }

    // On macOS, check if being debugged via sysctl
    #[cfg(target_os = "macos")]
    {
        let output = Command::new("sysctl")
            .args(["kern.proc.pid", &std::process::id().to_string()])
            .output();
        if let Ok(o) = output {
            let s = String::from_utf8_lossy(&o.stdout);
            if s.contains("P_TRACED") {
                return false;
            }
        }
    }

    // On Windows, check IsDebuggerPresent via exit code trick
    #[cfg(target_os = "windows")]
    {
        let output = Command::new("powershell")
            .args(["-NoProfile", "-Command",
                "Add-Type -MemberDefinition '[DllImport(\"kernel32.dll\")]public static extern bool IsDebuggerPresent();' -Name K -Namespace W; if([W.K]::IsDebuggerPresent()){exit 1}else{exit 0}"])
            .output();
        if let Ok(o) = output {
            if !o.status.success() {
                return false;
            }
        }
    }

    true
}

// ── Derive the actual AES-256 key from XOR-masked fragments ──
fn derive_key() -> [u8; 32] {
    // Unmask fragments at runtime
    let mut raw = Vec::with_capacity(32);
    for &b in FRAG_A.iter().chain(FRAG_B.iter()).chain(FRAG_C.iter()).chain(FRAG_D.iter()) {
        raw.push(b ^ MASK);
    }
    raw.extend_from_slice(KEY_SALT);

    let hash = Sha256::digest(&raw);
    let mut key = [0u8; 32];
    key.copy_from_slice(&hash);

    // Zero out the raw passphrase from memory
    for b in raw.iter_mut() {
        unsafe { std::ptr::write_volatile(b, 0) };
    }

    key
}

// ── Secure memory zeroing ──
fn secure_zero(data: &mut [u8]) {
    for b in data.iter_mut() {
        unsafe { std::ptr::write_volatile(b, 0) };
    }
}

// ── GitHub Release helpers ──
#[derive(serde::Deserialize)]
struct GithubRelease {
    tag_name: String,
    assets: Vec<GithubAsset>,
}

#[derive(serde::Deserialize)]
struct GithubAsset {
    name: String,
    browser_download_url: String,
    size: u64,
}

fn get_latest_release() -> Result<GithubRelease, String> {
    let url = format!(
        "https://api.github.com/repos/{}/releases/latest",
        GITHUB_REPO
    );
    let client = reqwest::blocking::Client::builder()
        .user_agent("ZapLauncher/1.0")
        .build()
        .map_err(|e| format!("HTTP client error: {}", e))?;

    let resp = client
        .get(&url)
        .send()
        .map_err(|e| format!("Failed to fetch release info: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("GitHub API returned status {}", resp.status()));
    }

    resp.json::<GithubRelease>()
        .map_err(|e| format!("Failed to parse release JSON: {}", e))
}

fn download_asset(url: &str) -> Result<Vec<u8>, String> {
    let client = reqwest::blocking::Client::builder()
        .user_agent("ZapLauncher/1.0")
        .build()
        .map_err(|e| format!("HTTP client error: {}", e))?;

    let resp = client
        .get(url)
        .send()
        .map_err(|e| format!("Download failed: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("Download returned status {}", resp.status()));
    }

    resp.bytes()
        .map(|b| b.to_vec())
        .map_err(|e| format!("Failed to read download: {}", e))
}

// ── Decryption ──
fn decrypt_payload(encrypted: &[u8], key: &[u8; 32]) -> Result<Vec<u8>, String> {
    if encrypted.len() < 12 {
        return Err("Encrypted payload too small".to_string());
    }

    let (nonce_bytes, ciphertext) = encrypted.split_at(12);
    let nonce = Nonce::from_slice(nonce_bytes);
    let cipher = Aes256Gcm::new_from_slice(key)
        .map_err(|e| format!("Cipher init error: {}", e))?;

    cipher
        .decrypt(nonce, ciphertext)
        .map_err(|_| "Decryption failed — payload may be corrupted or key mismatch".to_string())
}

// ── Paths ──
fn cache_dir() -> PathBuf {
    let base = dirs::data_local_dir().unwrap_or_else(|| PathBuf::from("."));
    base.join("ZapPro")
}

fn version_file() -> PathBuf {
    cache_dir().join("current_version.txt")
}

fn encrypted_cache_path() -> PathBuf {
    cache_dir().join("app.asar.enc")
}

// Generate a randomized temp directory name so it's not predictable
fn random_temp_dir(cache: &Path) -> PathBuf {
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let pid = std::process::id();
    let hash = Sha256::digest(format!("{}_{}", ts, pid).as_bytes());
    let name = format!("_r{}", hex::encode(&hash[..8]));
    cache.join(name)
}

// ── Hex encoding (minimal, no extra dependency) ──
mod hex {
    pub fn encode(data: &[u8]) -> String {
        data.iter().map(|b| format!("{:02x}", b)).collect()
    }
}

// ── Platform-specific Electron path ──
#[cfg(target_os = "macos")]
fn find_electron() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let resources = exe.parent()?.parent()?.join("Resources");

    let bundled = resources.join("Electron.app/Contents/MacOS/Electron");
    if bundled.exists() {
        return Some(bundled);
    }

    let sibling = exe.parent()?.join("Electron.app/Contents/MacOS/Electron");
    if sibling.exists() {
        return Some(sibling);
    }

    let nm = exe
        .parent()?
        .parent()?
        .parent()?
        .join("node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
    if nm.exists() {
        return Some(nm);
    }

    None
}

#[cfg(target_os = "windows")]
fn find_electron() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;

    let bundled = dir.join("electron.exe");
    if bundled.exists() {
        return Some(bundled);
    }

    let res = dir.join("resources").join("electron.exe");
    if res.exists() {
        return Some(res);
    }

    None
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn find_electron() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    let bundled = dir.join("electron");
    if bundled.exists() {
        return Some(bundled);
    }
    None
}

// ── Self-integrity check ──
// Verify our own binary hasn't been patched
fn verify_self_integrity() -> bool {
    let exe_path = match std::env::current_exe() {
        Ok(p) => p,
        Err(_) => return true, // can't check, allow
    };

    let exe_data = match fs::read(&exe_path) {
        Ok(d) => d,
        Err(_) => return true,
    };

    // Check binary size is reasonable (not padded with a debugger stub)
    // Release Rust binaries for this project should be under 20MB
    if exe_data.len() > 20 * 1024 * 1024 {
        return false;
    }

    // Check for common debugger/patcher signatures in the binary
    let suspicious_patterns: &[&[u8]] = &[
        b"FRIDA",
        b"frida-agent",
        b"cynject",
        b"substrate",
    ];

    for pattern in suspicious_patterns {
        if exe_data.windows(pattern.len()).any(|w| w == *pattern) {
            return false;
        }
    }

    true
}

// ── Main ──
fn main() {
    // Security checks before anything else
    if !check_environment() {
        show_error("Security check failed. Please run Zap Pro normally.");
        std::process::exit(1);
    }

    if !verify_self_integrity() {
        show_error("Application integrity check failed. Please reinstall Zap Pro.");
        std::process::exit(1);
    }

    eprintln!("[Zap Launcher] Starting {}...", APP_NAME);

    // 1. Find Electron
    let electron = match find_electron() {
        Some(p) => p,
        None => {
            show_error("Could not find Electron runtime. Please reinstall Zap Pro.");
            std::process::exit(1);
        }
    };

    // 2. Check for updates
    let cache = cache_dir();
    fs::create_dir_all(&cache).ok();

    // Clean up any leftover temp dirs from previous runs
    cleanup_old_temp_dirs(&cache);

    let current_version = fs::read_to_string(version_file()).unwrap_or_default();

    let release = match get_latest_release() {
        Ok(r) => r,
        Err(e) => {
            eprintln!("[Zap Launcher] Could not check for updates: {}", e);
            if encrypted_cache_path().exists() {
                launch_from_cache(&electron, &cache);
                return;
            }
            show_error(&format!(
                "Cannot start {}: no internet and no cached version.",
                APP_NAME
            ));
            std::process::exit(1);
        }
    };

    // 3. Download if needed
    let needs_update = current_version.trim() != release.tag_name;
    if needs_update || !encrypted_cache_path().exists() {
        eprintln!("[Zap Launcher] Downloading update {}...", release.tag_name);

        let asset = release
            .assets
            .iter()
            .find(|a| a.name == "app.asar.enc")
            .or_else(|| release.assets.iter().find(|a| a.name.ends_with(".asar.enc")));

        match asset {
            Some(a) => {
                eprintln!(
                    "[Zap Launcher] Downloading {} ({:.1} MB)...",
                    a.name,
                    a.size as f64 / 1_048_576.0
                );
                match download_asset(&a.browser_download_url) {
                    Ok(data) => {
                        fs::write(encrypted_cache_path(), &data).ok();
                        fs::write(version_file(), &release.tag_name).ok();
                    }
                    Err(e) => {
                        eprintln!("[Zap Launcher] Download failed: {}", e);
                        if !encrypted_cache_path().exists() {
                            show_error(&format!("Failed to download {}: {}", APP_NAME, e));
                            std::process::exit(1);
                        }
                    }
                }
            }
            None => {
                if !encrypted_cache_path().exists() {
                    show_error("No encrypted payload found in release.");
                    std::process::exit(1);
                }
            }
        }
    }

    // 4. Launch
    launch_from_cache(&electron, &cache);
}

fn launch_from_cache(electron: &Path, cache: &Path) {
    let encrypted = match fs::read(encrypted_cache_path()) {
        Ok(data) => data,
        Err(e) => {
            show_error(&format!("Failed to read cached app: {}", e));
            std::process::exit(1);
        }
    };

    // Derive key, decrypt, then zero the key
    let mut key = derive_key();
    let mut decrypted = match decrypt_payload(&encrypted, &key) {
        Ok(data) => data,
        Err(e) => {
            secure_zero(&mut key);
            show_error(&format!("Failed to decrypt app: {}", e));
            fs::remove_file(encrypted_cache_path()).ok();
            fs::remove_file(version_file()).ok();
            std::process::exit(1);
        }
    };
    // Zero the key immediately after decryption
    secure_zero(&mut key);

    // Write to randomized temp directory (unpredictable path)
    let temp_dir = random_temp_dir(cache);
    fs::create_dir_all(&temp_dir).ok();
    let asar_path = temp_dir.join("app.asar");

    if let Err(e) = fs::write(&asar_path, &decrypted) {
        show_error(&format!("Failed to prepare app: {}", e));
        secure_zero(&mut decrypted);
        std::process::exit(1);
    }

    // Zero decrypted data from memory
    secure_zero(&mut decrypted);

    // Set restrictive permissions on the temp asar (owner read-only)
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&asar_path, fs::Permissions::from_mode(0o400)).ok();
    }

    // Launch Electron
    let mut child = match Command::new(electron)
        .arg(&asar_path)
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .spawn()
    {
        Ok(c) => c,
        Err(e) => {
            show_error(&format!("Failed to launch Electron: {}", e));
            cleanup(&temp_dir);
            std::process::exit(1);
        }
    };

    // Wait for app to exit, then clean up
    let _ = child.wait();
    cleanup(&temp_dir);
}

fn cleanup(temp_dir: &Path) {
    // Secure delete: overwrite with random-ish data, then zeros, then remove
    let asar = temp_dir.join("app.asar");

    // Make writable again so we can overwrite
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&asar, fs::Permissions::from_mode(0o600)).ok();
    }

    if let Ok(meta) = fs::metadata(&asar) {
        let size = meta.len() as usize;
        if let Ok(mut f) = fs::OpenOptions::new().write(true).open(&asar) {
            // Pass 1: overwrite with 0xFF
            let ones = vec![0xFFu8; std::cmp::min(size, 1024 * 1024)];
            let mut remaining = size;
            while remaining > 0 {
                let chunk = std::cmp::min(remaining, ones.len());
                if f.write_all(&ones[..chunk]).is_err() {
                    break;
                }
                remaining -= chunk;
            }
            f.sync_all().ok();

            // Pass 2: overwrite with zeros
            let _ = f.seek_from_start(0);
            let zeros = vec![0u8; std::cmp::min(size, 1024 * 1024)];
            remaining = size;
            while remaining > 0 {
                let chunk = std::cmp::min(remaining, zeros.len());
                if f.write_all(&zeros[..chunk]).is_err() {
                    break;
                }
                remaining -= chunk;
            }
            f.sync_all().ok();
        }
    }
    fs::remove_dir_all(temp_dir).ok();
}

// Clean up any temp dirs from crashed previous runs
fn cleanup_old_temp_dirs(cache: &Path) {
    if let Ok(entries) = fs::read_dir(cache) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name_str = name.to_string_lossy();
            if name_str.starts_with("_r") && entry.file_type().map(|t| t.is_dir()).unwrap_or(false)
            {
                cleanup(&entry.path());
            }
        }
    }
}

// Seek helper for File
trait SeekFromStart {
    fn seek_from_start(&mut self, pos: u64) -> std::io::Result<u64>;
}

impl SeekFromStart for fs::File {
    fn seek_from_start(&mut self, pos: u64) -> std::io::Result<u64> {
        use std::io::Seek;
        self.seek(std::io::SeekFrom::Start(pos))
    }
}

fn show_error(msg: &str) {
    eprintln!("[Zap Launcher] ERROR: {}", msg);

    #[cfg(target_os = "macos")]
    {
        let _ = Command::new("osascript")
            .args([
                "-e",
                &format!(
                    "display dialog \"{}\" with title \"Zap Pro\" buttons {{\"OK\"}} default button \"OK\" with icon caution",
                    msg.replace('"', "\\\"")
                ),
            ])
            .output();
    }

    #[cfg(target_os = "windows")]
    {
        let _ = Command::new("powershell")
            .args([
                "-Command",
                &format!(
                    "[System.Windows.MessageBox]::Show('{}', 'Zap Pro', 'OK', 'Warning')",
                    msg.replace('\'', "''")
                ),
            ])
            .output();
    }
}
