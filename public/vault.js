const encoder = new TextEncoder();
const decoder = new TextDecoder();

function bytesToBase64(bytes) {
  if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64");
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value) {
  if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(value, "base64"));
  const binary = atob(value);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function deriveKey(passphrase, salt, iterations, cryptoProvider) {
  const material = await cryptoProvider.subtle.importKey("raw", encoder.encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  return cryptoProvider.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

export async function encryptVault(payload, passphrase, { iterations = 250000, cryptoProvider = globalThis.crypto } = {}) {
  if (!cryptoProvider?.subtle) throw new Error("当前环境不支持安全加密");
  if (String(passphrase).length < 8) throw new Error("保险箱密码至少需要8个字符");
  const salt = cryptoProvider.getRandomValues(new Uint8Array(16));
  const iv = cryptoProvider.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt, iterations, cryptoProvider);
  const ciphertext = await cryptoProvider.subtle.encrypt({ name: "AES-GCM", iv }, key, encoder.encode(JSON.stringify(payload)));
  return {
    format: "fund-trend-vault",
    version: 1,
    createdAt: new Date().toISOString(),
    kdf: { name: "PBKDF2", hash: "SHA-256", iterations },
    cipher: "AES-256-GCM",
    salt: bytesToBase64(salt),
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(ciphertext))
  };
}

export async function decryptVault(vault, passphrase, { cryptoProvider = globalThis.crypto } = {}) {
  if (!cryptoProvider?.subtle) throw new Error("当前环境不支持安全解密");
  if (vault?.format !== "fund-trend-vault" || vault.version !== 1) throw new Error("不是受支持的净值罗盘保险箱文件");
  const iterations = Number(vault.kdf?.iterations);
  if (!Number.isFinite(iterations) || iterations < 1000) throw new Error("保险箱加密参数无效");
  try {
    const salt = base64ToBytes(vault.salt);
    const iv = base64ToBytes(vault.iv);
    const key = await deriveKey(passphrase, salt, iterations, cryptoProvider);
    const plaintext = await cryptoProvider.subtle.decrypt({ name: "AES-GCM", iv }, key, base64ToBytes(vault.ciphertext));
    return JSON.parse(decoder.decode(plaintext));
  } catch {
    throw new Error("密码错误或保险箱文件已损坏");
  }
}
