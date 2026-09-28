import { rpc } from "@stellar/stellar-sdk";
import { NextResponse } from "next/server";

import { serverEnv } from "@/lib/env-server";
import { getRuntimeConfig } from "@/lib/runtime-config";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type DependencyStatus = "ok" | "unreachable";

/**
 * Verification-indexer gap state. `GAP_DETECTED` means the checkpoint ledger
 * has fallen behind the Soroban RPC retention window (`oldestLedger`), so
 * events may have been lost and the indexer refuses to advance until a
 * backfill completes. Surfaced here so probes/on-call can see it without
 * exposing ledger numbers or contract identifiers.
 */
type IndexerGapStatus = "ok" | "GAP_DETECTED" | "unknown";

async function checkSupabase(): Promise<DependencyStatus> {
  try {
    const { error } = await createAdminClient()
      .from("profiles")
      .select("user_id", { head: true, count: "exact" })
      .limit(1);
    return error ? "unreachable" : "ok";
  } catch {
    return "unreachable";
  }
}

async function checkStellar(): Promise<DependencyStatus> {
  try {
    await new rpc.Server(serverEnv.SOROBAN_RPC_URL).getHealth();
    return "ok";
  } catch {
    return "unreachable";
  }
}

/**
 * Reads the most recent unresolved gap incident recorded by the verification
 * indexer. Returns `unknown` when the table is unreachable so readiness never
 * silently reports `ok` for a state it could not verify.
 */
async function checkIndexerGap(): Promise<IndexerGapStatus> {
  try {
    const { data, error } = await createAdminClient()
      .from("indexer_gap_incidents")
      .select("id")
      .is("resolved_at", null)
      .limit(1);
    if (error) return "unknown";
    return data && data.length > 0 ? "GAP_DETECTED" : "ok";
  } catch {
    return "unknown";
  }
}

/**
 * Non-sensitive deployment readiness for platform probes. This endpoint never
 * returns a connection string, contract/address, key, record identifier, or
 * patient-derived state. It is deliberately distinct from liveness: a
 * process can be alive while a dependency it needs is not safe/able to
 * receive traffic. The per-dependency breakdown lets on-call go straight to
 * the failing system instead of debugging from zero.
 */
export async function GET() {
  const config = getRuntimeConfig();
  const [supabase, stellar, verificationIndexer] = await Promise.all([
    checkSupabase(),
    checkStellar(),
    checkIndexerGap(),
  ]);

  const ready =
    supabase === "ok" &&
    stellar === "ok" &&
    verificationIndexer !== "GAP_DETECTED";
  return NextResponse.json(
    {
      status: ready ? "ready" : "not_ready",
      build: {
        revision: config.buildRevision,
        schemaCompatibility: config.schemaCompatibility,
      },
      environment: config.deployment,
      components: {
        supabase,
        stellar,
        verificationIndexer,
        attestation: config.attestation.mode,
        payoutIndexer: config.payoutIndexer.enabled ? "enabled" : "disabled",
        sentry: config.sentry.enabled ? "enabled" : "disabled",
      },
    },
    {
      status: ready ? 200 : 503,
      headers: {
        "Cache-Control": "no-store, max-age=0",
        "X-Robots-Tag": "noindex, nofollow, noarchive",
      },
    },
  );
}
