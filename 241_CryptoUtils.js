"use strict";

/**
 * gitCode_Redesign - Cryptography & Storage Property Utilities
 * Contains stable hashing, AES encryption/decryption, PIN generation, and property access.
 */

// Global storage properties helpers (fragile credentials lookup)
const getProp = (key) => {
  if (typeof PropertiesService !== "undefined") {
    return PropertiesService.getScriptProperties().getProperty(key);
  }
  return null;
};

const setProp = (key, value) => {
  if (typeof PropertiesService !== "undefined") {
    PropertiesService.getScriptProperties().setProperty(key, value);
  }
};

const NativeAES = {
  S: [0x63, 0x7c, 0x77, 0x7b, 0xf2, 0x6b, 0x6f, 0xc5, 0x30, 0x01, 0x67, 0x2b, 0xfe, 0xd7, 0xab, 0x76, 0xca, 0x82, 0xc9, 0x7d, 0xfa, 0x59, 0x47, 0xf0, 0xad, 0xd4, 0xa2, 0xaf, 0x9c, 0xa4, 0x72, 0xc0, 0xb7, 0xfd, 0x93, 0x26, 0x36, 0x3f, 0xf7, 0xcc, 0x34, 0xa5, 0xe5, 0xf1, 0x71, 0xd8, 0x31, 0x15, 0x04, 0xc7, 0x23, 0xc3, 0x18, 0x96, 0x05, 0x9a, 0x07, 0x12, 0x80, 0xe2, 0xeb, 0x27, 0xb2, 0x75, 0x09, 0x83, 0x2c, 0x1a, 0x1b, 0x6e, 0x5a, 0xa0, 0x52, 0x3b, 0xd6, 0xb3, 0x29, 0xe3, 0x2f, 0x84, 0x53, 0xd1, 0x00, 0xed, 0x20, 0xfc, 0xb1, 0x5b, 0x6a, 0xcb, 0xbe, 0x39, 0x4a, 0x4c, 0x58, 0xcf, 0xd0, 0xef, 0xaa, 0xfb, 0x43, 0x4d, 0x33, 0x85, 0x45, 0xf9, 0x02, 0x7f, 0x50, 0x3c, 0x9f, 0xa8, 0x51, 0xa3, 0x40, 0x8f, 0x92, 0x9d, 0x38, 0xf5, 0xbc, 0xb6, 0xda, 0x21, 0x10, 0xff, 0xf3, 0xd2, 0xcd, 0x0c, 0x13, 0xec, 0x5f, 0x97, 0x44, 0x17, 0xc4, 0xa7, 0x7e, 0x3d, 0x64, 0x5d, 0x19, 0x73, 0x60, 0x81, 0x4f, 0xdc, 0x22, 0x2a, 0x90, 0x88, 0x46, 0xee, 0xb8, 0x14, 0xde, 0x5e, 0x0b, 0xdb, 0xe0, 0x32, 0x3a, 0x0a, 0x49, 0x06, 0x24, 0x5c, 0xc2, 0xd3, 0xac, 0x62, 0x91, 0x95, 0xe4, 0x79, 0xe7, 0xc8, 0x37, 0x6d, 0x8d, 0xd5, 0x4e, 0xa9, 0x6c, 0x56, 0xf4, 0xea, 0x65, 0x7a, 0xae, 0x08, 0xba, 0x78, 0x25, 0x2e, 0x1c, 0xa6, 0xb4, 0xc6, 0xe8, 0xdd, 0x74, 0x1f, 0x4b, 0xbd, 0x8b, 0x8a, 0x70, 0x3e, 0xb5, 0x66, 0x48, 0x03, 0xf6, 0x0e, 0x61, 0x35, 0x57, 0xb9, 0x86, 0xc1, 0x1d, 0x9e, 0xe1, 0xf8, 0x98, 0x11, 0x69, 0xd9, 0x8e, 0x94, 0x9b, 0x1e, 0x87, 0xe9, 0xce, 0x55, 0x28, 0xdf, 0x8c, 0xa1, 0x89, 0x0d, 0xbf, 0xe6, 0x42, 0x68, 0x41, 0x99, 0x2d, 0x0f, 0xb0, 0x54, 0xbb, 0x16],
  SI: [],
  toU(s) { return typeof s === 'string' ? Array.from(Utilities.newBlob(s).getBytes()).map(b => b & 255) : Array.from(s).map(b => b & 255); },
  toS(b) { return Utilities.newBlob(b.map(x => x > 127 ? x - 256 : x)).getDataAsString(); },
  toH(b) { return b.map(v => v.toString(16).padStart(2, '0')).join(''); },
  fromH(h) { const b = []; for (let i = 0; i < h.length; i += 2) b.push(parseInt(h.substr(i, 2), 16)); return b; },
  gm(a, b) { let p = 0; for (let i = 0; i < 8; i++) { if (b & 1) p ^= a; let m = a & 0x80; a = (a << 1) & 0xFF; if (m) a ^= 0x1B; b >>= 1; } return p; },
  expand(k) {
    let b = this.toU(k);
    if (b.length >= 32) b = b.slice(0, 32); else if (b.length >= 24) b = b.slice(0, 24); else b = b.slice(0, 16);
    const n = b.length / 4, r = n + 6, w = new Uint32Array(4 * (r + 1)), rc = [0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80, 0x1b, 0x36];
    for (let i = 0; i < n; i++) w[i] = ((b[4 * i] << 24) | (b[4 * i + 1] << 16) | (b[4 * i + 2] << 8) | b[4 * i + 3]) >>> 0;
    for (let i = n; i < w.length; i++) {
      let t = w[i - 1];
      if (i % n === 0) {
        t = ((this.S[(t >>> 16) & 255] << 24) | (this.S[(t >>> 8) & 255] << 16) | (this.S[t & 255] << 8) | this.S[(t >>> 24) & 255]) >>> 0;
        t ^= (rc[i / n - 1] << 24);
      } else if (n > 6 && i % n === 4) {
        t = ((this.S[(t >>> 24) & 255] << 24) | (this.S[(t >>> 16) & 255] << 16) | (this.S[(t >>> 8) & 255] << 8) | this.S[t & 255]) >>> 0;
      }
      w[i] = (w[i - n] ^ t) >>> 0;
    }
    return w;
  },
  encrypt(p, k, iv = null) {
    const pb = this.toU(p), pad = 16 - (pb.length % 16); for (let i = 0; i < pad; i++) pb.push(pad);
    const w = this.expand(k), r = w.length / 4 - 1, res = []; let prev = iv;
    for (let i = 0; i < pb.length; i += 16) {
      const s = new Uint8Array(pb.slice(i, i + 16));
      if (prev) for (let j = 0; j < 16; j++) s[j] ^= prev[j];
      for (let j = 0; j < 16; j++) s[j] ^= (w[j >> 2] >>> (24 - 8 * (j % 4))) & 255;
      for (let rnd = 1; rnd <= r; rnd++) {
        for (let j = 0; j < 16; j++) s[j] = this.S[s[j]];
        const t = [...s];
        s[1] = t[5]; s[5] = t[9]; s[9] = t[13]; s[13] = t[1]; s[2] = t[10]; s[6] = t[14]; s[10] = t[2]; s[14] = t[6]; s[3] = t[15]; s[7] = t[3]; s[11] = t[7]; s[15] = t[11];
        if (rnd < r) for (let j = 0; j < 16; j += 4) {
          const a = s[j], b = s[j + 1], c = s[j + 2], d = s[j + 3];
          s[j] = this.gm(a, 2) ^ this.gm(b, 3) ^ c ^ d; s[j + 1] = a ^ this.gm(b, 2) ^ this.gm(c, 3) ^ d;
          s[j + 2] = a ^ b ^ this.gm(c, 2) ^ this.gm(d, 3); s[j + 3] = this.gm(a, 3) ^ b ^ c ^ this.gm(d, 2);
        }
        for (let j = 0; j < 16; j++) s[j] ^= (w[4 * rnd + (j >> 2)] >>> (24 - 8 * (j % 4))) & 255;
      }
      res.push(...Array.from(s)); if (iv) prev = s;
    }
    return res;
  },
  decrypt(b, k, iv = null) {
    if (!this.SI.length) for (let i = 0; i < 256; i++) this.SI[this.S[i]] = i;
    const db = this.toU(b), w = this.expand(k), r = w.length / 4 - 1, res = [];
    for (let i = 0; i < db.length; i += 16) {
      const s = new Uint8Array(db.slice(i, i + 16)); const ct = [...s];
      for (let j = 0; j < 16; j++) s[j] ^= (w[4 * r + (j >> 2)] >>> (24 - 8 * (j % 4))) & 255;
      for (let rnd = r - 1; rnd >= 0; rnd--) {
        const t = [...s];
        s[1] = t[13]; s[5] = t[1]; s[9] = t[5]; s[13] = t[9]; s[2] = t[10]; s[6] = t[14]; s[10] = t[2]; s[14] = t[6]; s[3] = t[7]; s[7] = t[11]; s[11] = t[15]; s[15] = t[3];
        for (let j = 0; j < 16; j++) s[j] = this.SI[s[j]];
        for (let j = 0; j < 16; j++) s[j] ^= (w[4 * rnd + (j >> 2)] >>> (24 - 8 * (j % 4))) & 255;
        if (rnd > 0) for (let j = 0; j < 16; j += 4) {
          const a = s[j], b = s[j + 1], c = s[j + 2], d = s[j + 3];
          s[j] = this.gm(a, 14) ^ this.gm(b, 11) ^ this.gm(c, 13) ^ this.gm(d, 9);
          s[j + 1] = this.gm(a, 9) ^ this.gm(b, 14) ^ this.gm(c, 11) ^ this.gm(d, 13);
          s[j + 2] = this.gm(a, 13) ^ this.gm(b, 9) ^ this.gm(c, 14) ^ this.gm(d, 11);
          s[j + 3] = this.gm(a, 11) ^ this.gm(b, 13) ^ this.gm(c, 9) ^ this.gm(d, 14);
        }
      }
      if (iv) { for (let j = 0; j < 16; j++) s[j] ^= iv[j]; iv = ct; }
      res.push(...Array.from(s));
    }
    return res;
  },
  evp(pass, salt, keySize, ivSize) {
    const key = [], iv = []; let hash = []; const p = this.toU(pass), s = this.toU(salt);
    while (key.length < keySize || iv.length < ivSize) {
      const b = hash.concat(p).concat(s);
      hash = Array.from(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, Utilities.newBlob(b).getBytes())).map(x => x & 255);
      for (const x of hash) {
        if (key.length < keySize) key.push(x);
        else if (iv.length < ivSize) iv.push(x);
      }
    }
    return { key, iv };
  },
  decryptHex(h, k) {
    const raw = this.decrypt(this.fromH(h), k);
    const p = raw[raw.length - 1]; let res = raw;
    if (p > 0 && p <= 16 && res.slice(res.length - p).every(x => x === p)) res = res.slice(0, res.length - p);
    return this.toS(res);
  }
};

const CryptoUtils = {
  // Expose NativeAES reference internally
  NativeAES,

  /**
   * Generates a stable SHA-256 hash for a given string.
   * Used primarily for Key1/Key2 generation in mapping logic.
   */
  generateHash(input) {
    if (!input) return "";
    
    // GAS native hashing
    const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(input));
    
    // Convert to hex string
    return digest.map(byte => {
      const v = (byte < 0) ? 256 + byte : byte;
      return v.toString(16).padStart(2, '0');
    }).join('');
  },

  /**
   * Encrypts a raw PIN using Tuya Secret Key from script properties.
   */
  encrypt(rawPin, secret = getProp("TUYA_SECRET_KEY")) {
    if (!secret) throw new Error("Cryptography Error: TUYA_SECRET_KEY is not defined in Script Properties.");
    const salt = Array.from({ length: 8 }, () => Math.floor(Math.random() * 256));
    const { key, iv } = NativeAES.evp(secret, salt, 32, 16);
    const encryptedBytes = NativeAES.encrypt(rawPin, key, iv);
    const magic = NativeAES.toU("Salted__");
    const finalBytes = magic.concat(salt).concat(encryptedBytes);
    return Utilities.base64Encode(finalBytes);
  },

  /**
   * Decrypts a base64 encoded encrypted PIN.
   */
  decrypt(encrypted, secret = getProp("TUYA_SECRET_KEY")) {
    if (!secret) throw new Error("Cryptography Error: TUYA_SECRET_KEY is not defined in Script Properties.");
    const bytes = Utilities.base64Decode(encrypted);
    const uBytes = Array.from(bytes).map(b => b & 0xFF);
    let resBytes;
    if (uBytes.length >= 17 && String.fromCharCode(...uBytes.slice(0, 8)) === "Salted__") {
      const salt = uBytes.slice(8, 16);
      const ct = uBytes.slice(16);
      const { key, iv } = NativeAES.evp(secret, salt, 32, 16);
      resBytes = NativeAES.decrypt(ct, key, iv);
    } else {
      resBytes = NativeAES.decrypt(uBytes, secret);
    }
    const p = resBytes[resBytes.length - 1];
    if (p > 0 && p <= 16) {
      const check = resBytes.slice(resBytes.length - p);
      if (check.every(x => x === p)) resBytes = resBytes.slice(0, resBytes.length - p);
    }
    return NativeAES.toS(resBytes);
  },

  /**
   * Generates a random pin of specified length and returns the encrypted base64 payload.
   */
  generateEncryptedPin(length = CONFIG_CONSTANTS.TUYA_PIN_LENGTH, secret = getProp("TUYA_SECRET_KEY")) {
    const limit = Math.pow(10, length);
    const pin = Math.floor(Math.random() * limit).toString().padStart(length, '0');
    return this.encrypt(pin, secret);
  },

  /**
   * Evaluates enc/dec cell formulas during sheet updates.
   */
  processClosure(targetRange, match, sheet) {
    const action = match[1].toLowerCase();
    const refCell = match[2];
    const sourceValue = sheet.getRange(refCell).getValue();
    if (sourceValue !== "" && sourceValue !== null && sourceValue !== undefined) {
      try {
        let result;
        if (action === "enc") {
          result = this.encrypt(sourceValue.toString());
        } else {
          result = this.decrypt(sourceValue.toString());
        }
        targetRange.setValue(result);
      } catch (err) {
        myLog("error", "processClosure Error: " + err.message);
      }
    }
  }
};
