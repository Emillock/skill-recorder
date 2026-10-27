import { safeStorage } from "electron";

import type { TokenCipher } from "./settings-store";

/** Token encryption backed by the OS keychain (Keychain, DPAPI, libsecret/kwallet). */
export const safeStorageCipher: TokenCipher = {
  available() {
    if (!safeStorage.isEncryptionAvailable()) return false;
    // On Linux without a keyring Chromium falls back to a hard-coded key, which
    // is obfuscation rather than encryption; don't store tokens that way.
    return !(process.platform === "linux" && safeStorage.getSelectedStorageBackend() === "basic_text");
  },
  encrypt(plain) {
    return safeStorage.encryptString(plain).toString("base64");
  },
  decrypt(encoded) {
    return safeStorage.decryptString(Buffer.from(encoded, "base64"));
  },
};
