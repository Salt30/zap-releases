#!/usr/bin/env python3
"""
Encrypt an Electron .asar file using AES-256-GCM.
The key derivation must match the Rust launcher exactly.

Usage: python3 encrypt_asar.py <input.asar> <output.asar.enc>
"""

import hashlib
import os
import sys

try:
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
except ImportError:
    print("Installing cryptography package...")
    os.system(f"{sys.executable} -m pip install cryptography")
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM


# These must match the Rust launcher EXACTLY
FRAG_A = bytes([0x7a, 0x61, 0x70, 0x5f, 0x73, 0x65, 0x63, 0x72])
FRAG_B = bytes([0x65, 0x74, 0x5f, 0x6b, 0x65, 0x79, 0x5f, 0x70])
FRAG_C = bytes([0x72, 0x6f, 0x5f, 0x32, 0x30, 0x32, 0x36, 0x5f])
FRAG_D = bytes([0x65, 0x6e, 0x63, 0x72, 0x79, 0x70, 0x74, 0x21])
KEY_SALT = b"zap_launcher_v1_aes256gcm"


def derive_key() -> bytes:
    seed = FRAG_A + FRAG_B + FRAG_C + FRAG_D + KEY_SALT
    return hashlib.sha256(seed).digest()


def encrypt_file(input_path: str, output_path: str):
    key = derive_key()
    print(f"Key derived (SHA256 of fragments + salt)")

    with open(input_path, "rb") as f:
        plaintext = f.read()
    print(f"Read {len(plaintext):,} bytes from {input_path}")

    # Generate random 12-byte nonce
    nonce = os.urandom(12)

    # Encrypt with AES-256-GCM
    aesgcm = AESGCM(key)
    ciphertext = aesgcm.encrypt(nonce, plaintext, None)

    # Output format: nonce (12 bytes) + ciphertext (includes 16-byte auth tag)
    with open(output_path, "wb") as f:
        f.write(nonce)
        f.write(ciphertext)

    total_size = 12 + len(ciphertext)
    print(f"Encrypted to {output_path} ({total_size:,} bytes)")
    print(f"  Nonce: {nonce.hex()}")
    print(f"  Ciphertext: {len(ciphertext):,} bytes (includes 16-byte auth tag)")


def main():
    if len(sys.argv) != 3:
        print(f"Usage: {sys.argv[0]} <input.asar> <output.asar.enc>")
        sys.exit(1)

    input_path = sys.argv[1]
    output_path = sys.argv[2]

    if not os.path.exists(input_path):
        print(f"Error: {input_path} not found")
        sys.exit(1)

    encrypt_file(input_path, output_path)
    print("Done!")


if __name__ == "__main__":
    main()
