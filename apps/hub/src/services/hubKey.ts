import { eq } from "drizzle-orm";
import { generateEd25519KeyPair, type Ed25519KeyPair } from "@operator/shared/crypto";
import type { Db } from "../db/index.js";
import { hubKeys } from "../db/schema.js";
import type { SecretBox } from "../lib/crypto.js";

const SIGNING_KEY_ID = "command-signing";

/** Load the hub's Ed25519 command-signing key, creating it on first boot. It must survive restarts. */
export async function loadHubSigningKey(db: Db, box: SecretBox): Promise<Ed25519KeyPair> {
  const [existing] = await db.select().from(hubKeys).where(eq(hubKeys.id, SIGNING_KEY_ID));
  if (existing) return { publicKey: existing.publicKey, privateKey: box.open(existing.privateKeyEnc) };

  const keys = generateEd25519KeyPair();
  await db
    .insert(hubKeys)
    .values({ id: SIGNING_KEY_ID, publicKey: keys.publicKey, privateKeyEnc: box.seal(keys.privateKey) })
    .onConflictDoNothing();
  // Re-read so concurrent first boots agree on one key.
  const [stored] = await db.select().from(hubKeys).where(eq(hubKeys.id, SIGNING_KEY_ID));
  if (!stored) throw new Error("Failed to persist hub signing key");
  return { publicKey: stored.publicKey, privateKey: box.open(stored.privateKeyEnc) };
}
