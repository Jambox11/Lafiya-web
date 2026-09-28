import { rpc } from "@stellar/stellar-sdk";
import { NextResponse } from "next/server";

import { serverEnv } from "@/lib/env-server";
import { getRuntimeConfig } from "@/lib/runtime-config";
import { createAdminClient } from "@/lib/supabase/admin";
import { getFlagStates } from "@/lib/flags";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type DependencyStatus = "ok" | "unreachable";

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
 * Non-sensitive deployment readiness for platform probes. This endpoint never
 * returns a connection string, contract/address, key, record identifier, or
 * patient-derived state. It is deliberately distinct from liveness: a
 * process can be alive while a dependency it needs is not safe/able to
 * receive traffic. The per-dependency breakdown lets on-call go straight to
 * the failing system instead of debugging from zero.
 *
 * Feature-flag state is reported at the flag level only (enabled/disabled and
 * rollout percentage). Per-user bucketing is never exposed here, so probes
 * cannot be used to infer which cohort a given user falls into.
 */
export async function GET() {
  const config = getRuntimeConfig();
  const [supabase, stellar, flags] = await Promise.all([
    checkSupabase(),
    checkStellar(),
    getFlagStates(),
  ]);

  const ready = supabase === "ok" && stellar === "ok";
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
        attestation: config.attestation.mode,
        payoutIndexer: config.payoutIndexer.enabled ? "enabled" : "disabled",
        sentry: config.sentry.enabled ? "enabled" : "disabled",
      },
      flags,
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
