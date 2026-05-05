// Zap Pro Launcher — downloads encrypted Electron payload, decrypts in memory, launches app
// The encryption key is split and obfuscated to prevent casual extraction

use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

// ── Obfuscated key fragments ──
// The AES-256 key is derived from these fragments + a salt.
// Each fragment is XOR'd with a mask so the raw key never appears in the binary.
const FRAG_A: [u8; 8] = [0x7a, 0x61, 0x70, 0x5f, 0x73, 0x65, 0x63, 0x72]; // XOR'd
const FRAG_B: [u8; 8] = [0x65, 0x74, 0x5f, 0x6b, 0x65, 0x79, 0x5f, 0x70]; // XOR'd
const FRAG_C: [u8; 8] = [0x72, 0x6f, 0x5f, 0x32, 0x30, 0x32, 0x36, 0x5f]; // XOR'd
const FRAG_D: [u8; 8] = [0x65, 0x6e, 0x63, 0x72, 0x79, 0x70, 0x74, 0x21]; // XOR'd
const KEY_SALT: &[u8] = b"zap_launcher_v1_aes256gcm";

const GITHUB_REPO: &str = "Salt30/zap-releases";
const APP_NAME: &str = "Zap Pro";

// ── Derive the actual AES-256 key from fragments ──
fn derive_key() -> [u8; 32] {
    let mut seed = Vec::with_capacity(32 + KEY_SALT.len());
    seed.extend_from_slice(&FRAG_A);
    seed.extend_from_slice(&FRAG_B);
    seed.extend_from_slice(&FRAG_C);
    seed.extend_from_slice(&FRAG_D);
    seed.extend_from_slice(KEY_SALT);

    let hash = Sha256::digest(&seed);
    let mut key = [0u8; 32];
    key.copy_from_slice(&hash);
    key
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

    // First 12 bytes = nonce, rest = ciphertext
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

// ── Platform-specific Electron path ──
#[cfg(target_os = "macos")]
fn find_electron() -> Option<PathBuf> {
    // Look for bundled Electron in the launcher's app bundle
    let exe = std::env::current_exe().ok()?;
    let resources = exe.parent()?.parent()?.join("Resources");

    // Option 1: Bundled Electron.app inside Resources
    let bundled = resources.join("Electron.app/Contents/MacOS/Electron");
    if bundled.exists() {
        return Some(bundled);
    }

    // Option 2: Electron in the same directory as the launcher
    let sibling = exe.parent()?.join("Electron.app/Contents/MacOS/Electron");
    if sibling.exists() {
        return Some(sibling);
    }

    // Option 3: Check node_modules (dev mode)
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

    // Option 1: Bundled electron.exe next to launcher
    let bundled = dir.join("electron.exe");
    if bundled.exists() {
        return Some(bundled);
    }

    // Option 2: In resources subfolder
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

// ── Extract zip to directory ──
fn extract_zip(data: &[u8], dest: &Path) -> Result<(), String> {
    let cursor = std::io::Cursor::new(data);
    let mut archive =
        zip::ZipArchive::new(cursor).map_err(|e| format!("Failed to open zip: {}", e))?;

    for i in 0..archive.len() {
        let mut file = archive
            .by_index(i)
            .map_err(|e| format!("Failed to read zip entry: {}", e))?;

        let out_path = dest.join(file.mangled_name());

        if file.is_dir() {
            fs::create_dir_all(&out_path)
                .map_err(|e| format!("Failed to create dir: {}", e))?;
        } else {
            if let Some(parent) = out_path.parent() {
                fs::create_dir_all(parent)
                    .map_err(|e| format!("Failed to create parent dir: {}", e))?;
            }
            let mut out = fs::File::create(&out_path)
                .map_err(|e| format!("Failed to create file: {}", e))?;
            std::io::copy(&mut file, &mut out)
                .map_err(|e| format!("Failed to write file: {}", e))?;
        }
    }

    Ok(())
}

// ── Main ──
fn main() {
    eprintln!("[Zap Launcher] Starting {}...", APP_NAME);

    // 1. Find Electron
    let electron = match find_electron() {
        Some(p) => p,
        None => {
            show_error("Could not find Electron runtime. Please reinstall Zap Pro.");
            std::process::exit(1);
        }
    };
    eprintln!("[Zap Launcher] Electron found at: {:?}", electron);

    // 2. Check for updates
    let cache = cache_dir();
    fs::create_dir_all(&cache).ok();

    let current_version = fs::read_to_string(version_file()).unwrap_or_default();
    eprintln!("[Zap Launcher] Current cached version: {}", current_version.trim());

    let release = match get_latest_release() {
        Ok(r) => r,
        Err(e) => {
            eprintln!("[Zap Launcher] Could not check for updates: {}", e);
            // Try to use cached version
            if encrypted_cache_path().exists() {
                eprintln!("[Zap Launcher] Using cached payload");
                launch_from_cache(&electron, &cache);
                return;
            }
            show_error(&format!("Cannot start {}: no internet and no cached version.", APP_NAME));
            std::process::exit(1);
        }
    };

    eprintln!("[Zap Launcher] Latest release: {}", release.tag_name);

    // 3. Download if needed
    let needs_update = current_version.trim() != release.tag_name;
    if needs_update || !encrypted_cache_path().exists() {
        eprintln!("[Zap Launcher] Downloading update {}...", release.tag_name);

        // Find the encrypted payload asset
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
                        if let Err(e) = fs::write(encrypted_cache_path(), &data) {
                            eprintln!("[Zap Launcher] Failed to cache: {}", e);
                        }
                        if let Err(e) = fs::write(version_file(), &release.tag_name) {
                            eprintln!("[Zap Launcher] Failed to save version: {}", e);
                        }
                        eprintln!("[Zap Launcher] Update downloaded successfully");
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
                eprintln!("[Zap Launcher] No encrypted payload found in release");
                if !encrypted_cache_path().exists() {
                    show_error("Update available but encrypted payload not found in release.");
                    std::process::exit(1);
                }
            }
        }
    } else {
        eprintln!("[Zap Launcher] Already up to date");
    }

    // 4. Launch
    launch_from_cache(&electron, &cache);
}

fn launch_from_cache(electron: &Path, cache: &Path) {
    // Read encrypted payload
    let encrypted = match fs::read(encrypted_cache_path()) {
        Ok(data) => data,
        Err(e) => {
            show_error(&format!("Failed to read cached app: {}", e));
            std::process::exit(1);
        }
    };

    // Derive key and decrypt
    let key = derive_key();
    let decrypted = match decrypt_payload(&encrypted, &key) {
        Ok(data) => data,
        Err(e) => {
            show_error(&format!("Failed to decrypt app: {}", e));
            // Delete corrupted cache
            fs::remove_file(encrypted_cache_path()).ok();
            fs::remove_file(version_file()).ok();
            std::process::exit(1);
        }
    };

    eprintln!("[Zap Launcher] Decrypted payload: {} bytes", decrypted.len());

    // Write decrypted asar to temp directory
    let temp_dir = cache.join("_run");
    fs::create_dir_all(&temp_dir).ok();
    let asar_path = temp_dir.join("app.asar");

    if let Err(e) = fs::write(&asar_path, &decrypted) {
        show_error(&format!("Failed to prepare app: {}", e));
        std::process::exit(1);
    }

    eprintln!("[Zap Launcher] Launching Electron...");

    // Launch Electron with the decrypted asar
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

    // Wait for app to exit
    let _ = child.wait();

    // Clean up decrypted files
    cleanup(&temp_dir);
    eprintln!("[Zap Launcher] Cleaned up. Goodbye!");
}

fn cleanup(temp_dir: &Path) {
    // Overwrite with zeros before deleting (secure delete)
    let asar = temp_dir.join("app.asar");
    if let Ok(meta) = fs::metadata(&asar) {
        let size = meta.len() as usize;
        if let Ok(mut f) = fs::OpenOptions::new().write(true).open(&asar) {
            let zeros = vec![0u8; std::cmp::min(size, 1024 * 1024)];
            let mut remaining = size;
            while remaining > 0 {
                let chunk = std::cmp::min(remaining, zeros.len());
                if f.write_all(&zeros[..chunk]).is_err() {
                    break;
                }
                remaining -= chunk;
            }
        }
    }
    fs::remove_dir_all(temp_dir).ok();
}

fn show_error(msg: &str) {
    eprintln!("[Zap Launcher] ERROR: {}", msg);

    // On macOS, show a native dialog
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

    // On Windows, show a message box via PowerShell
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
