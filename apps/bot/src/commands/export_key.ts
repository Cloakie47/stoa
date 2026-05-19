/**
 * /export_key — V1.0 single-account private-key recovery flow.
 *
 * Two-step: /export_key asks for confirmation, /export_key_confirm (within
 * 60s, as the very next message from the same user) reveals the private
 * key in plaintext. Any other message between the two cancels.
 *
 * Hard rules:
 *   - DM-only (ctx.chat.type === "private")
 *   - Never log the private key — no console, no audit_log metadata
 *   - Decrypted key is never cached; it lives only on the request stack
 *
 * Multi-account variants (/accounts, /create_account, /switch, /rename,
 * /delete) are deferred to V1.1 — this file is single-wallet only.
 */
import {
  consumePendingExport,
  decryptPrivateKey,
  makePendingExportStore,
  openPendingExport,
  cancelPendingExport,
  type PendingExportStore,
} from "@stoa/bot-core";
import type { D1Database } from "@cloudflare/workers-types";

import { getWallet } from "../db.js";
import { toCfg, type Env } from "../env.js";

/** Module-level singleton state. The Cloudflare Workers isolate keeps this
 *  alive across requests while warm — the 60-second confirmation window is
 *  well under typical isolate lifetimes. A cold start clears it, in which
 *  case the user has to /export_key again. */
const pendingExports: PendingExportStore = makePendingExportStore();

/** Group-chat refusal message — exported so callers can short-circuit
 *  before doing any wallet lookup or DB work. */
export const GROUP_CHAT_REFUSAL =
  "🔒 /export_key only works in direct messages with the bot. Open a private chat with @stoa_insight_bot.";

const STEP1_REPLY = [
  "⚠️ *Export Private Key*",
  "",
  "This will reveal your wallet's private key. Anyone with this key has complete control of your funds.",
  "",
  "Type /export_key_confirm within 60 seconds to proceed.",
  "Any other message cancels.",
].join("\n");

const EXPIRED_REPLY =
  "Confirmation window expired. Run /export_key again to retry.";

const NO_PENDING_REPLY =
  "No pending export. Run /export_key first to begin the confirmation flow.";

const NO_WALLET_REPLY =
  "You don't have a wallet yet — run /start first.";

export interface ExportKeyArgs {
  db: D1Database;
  env: Env;
  telegramUserId: number;
  chatType: string;
}

export interface ExportKeyResult {
  /** Message to send back. */
  message: string;
  /** When true, the message body contains the private key — caller MUST NOT
   *  log it. Caller may use this flag to add a parse_mode hint or to
   *  suppress any debug logging of the reply text. */
  containsSecret?: boolean;
}

/** Handle `/export_key`. Returns the step-1 prompt or a group-chat refusal. */
export function handleExportKeyStart(args: ExportKeyArgs): ExportKeyResult {
  if (args.chatType !== "private") {
    return { message: GROUP_CHAT_REFUSAL };
  }
  openPendingExport(pendingExports, args.telegramUserId);
  return { message: STEP1_REPLY };
}

/** Handle `/export_key_confirm`. */
export async function handleExportKeyConfirm(
  args: ExportKeyArgs,
): Promise<ExportKeyResult> {
  if (args.chatType !== "private") {
    return { message: GROUP_CHAT_REFUSAL };
  }
  const consumed = consumePendingExport(pendingExports, args.telegramUserId);
  if (consumed.kind === "none") {
    return { message: NO_PENDING_REPLY };
  }
  if (consumed.kind === "expired") {
    return { message: EXPIRED_REPLY };
  }

  const cfg = toCfg(args.env);
  const wallet = await getWallet(args.db, args.telegramUserId);
  if (!wallet) {
    return { message: NO_WALLET_REPLY };
  }

  // Decrypt and immediately format. The decrypted key lives only inside
  // this function — it is NOT logged, cached, or stored anywhere.
  const privateKey = await decryptPrivateKey(
    wallet.pk_ciphertext_b64,
    cfg.WALLET_ENCRYPTION_KEY,
  );

  // Audit log — non-secret metadata only. The action name, user id, and
  // chat type are sufficient for reconciliation; the key itself never
  // enters this row.
  try {
    await args.db
      .prepare(
        "INSERT INTO audit_log (telegram_user_id, action, metadata) VALUES (?, ?, ?)",
      )
      .bind(
        args.telegramUserId,
        "export_key",
        JSON.stringify({ chat_type: args.chatType }),
      )
      .run();
  } catch (e) {
    // Audit-log write failure must NOT block the user from getting their
    // key — they're trying to recover access. Log a non-secret warning
    // and proceed.
    console.warn(
      `[export_key] audit_log insert failed for user ${args.telegramUserId}: ${(e as Error).message}`,
    );
  }

  const body = [
    "🔑 Your private key:",
    "`" + privateKey + "`",
    "",
    "Save this somewhere secure (password manager). Anyone with this key controls your funds. Delete this message after saving.",
  ].join("\n");
  return { message: body, containsSecret: true };
}

/** Cancel a pending export if one exists. Used by the bot's catch-all
 *  message middleware: any message that is neither /export_key nor
 *  /export_key_confirm clears the pending state. */
export function cancelPendingExportForUser(telegramUserId: number): boolean {
  return cancelPendingExport(pendingExports, telegramUserId);
}

/** Test seam — DO NOT use in production code. Exposes the underlying
 *  Map so tests can inspect / reset state. */
export function _exportKeyStateForTesting(): PendingExportStore {
  return pendingExports;
}
