import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";

/** Ed25519 keypair as base64url raw 32-byte values (JWK `x` and `d`). */
export interface Ed25519KeyPair {
  publicKey: string;
  privateKey: string;
}

export function generateEd25519KeyPair(): Ed25519KeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const jwk = privateKey.export({ format: "jwk" });
  const pub = publicKey.export({ format: "jwk" });
  if (typeof jwk.d !== "string" || typeof pub.x !== "string") throw new Error("Ed25519 export failed");
  return { publicKey: pub.x, privateKey: jwk.d };
}

function privateKeyObject(keys: Ed25519KeyPair): KeyObject {
  return createPrivateKey({ key: { kty: "OKP", crv: "Ed25519", x: keys.publicKey, d: keys.privateKey }, format: "jwk" });
}

function publicKeyObject(publicKey: string): KeyObject {
  return createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: publicKey }, format: "jwk" });
}

export function signMessage(keys: Ed25519KeyPair, message: string): string {
  return sign(null, Buffer.from(message, "utf8"), privateKeyObject(keys)).toString("base64url");
}

export function verifyMessage(publicKey: string, message: string, signature: string): boolean {
  try {
    return verify(null, Buffer.from(message, "utf8"), publicKeyObject(publicKey), Buffer.from(signature, "base64url"));
  } catch {
    return false;
  }
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}
