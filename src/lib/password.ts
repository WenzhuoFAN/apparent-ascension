import { randomBytes, scrypt as _scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(_scrypt);
const PREFIX = "scrypt";
const SALT_BYTES = 16;
const KEY_BYTES = 64;

const toBuffer = async (password: string, saltHex: string) => {
  const key = (await scrypt(password, Buffer.from(saltHex, "hex"), KEY_BYTES)) as Buffer;
  return key;
};

export const hashPassword = async (password: string) => {
  const value = String(password || "");
  if (value.length < 8) {
    throw new Error("Password must be at least 8 characters.");
  }

  const saltHex = randomBytes(SALT_BYTES).toString("hex");
  const hash = await toBuffer(value, saltHex);
  return `${PREFIX}:${saltHex}:${hash.toString("hex")}`;
};

export const verifyPassword = async (password: string, storedHash: string) => {
  const parts = String(storedHash || "").split(":");
  if (parts.length !== 3) return false;
  const [prefix, saltHex, hashHex] = parts;
  if (prefix !== PREFIX || !saltHex || !hashHex) return false;

  const expected = Buffer.from(hashHex, "hex");
  const actual = await toBuffer(String(password || ""), saltHex);
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
};

