import { rpc } from "@stellar/stellar-sdk";
import { NextResponse } from "next/server";

import { serverEnv } from "@/lib/env-server";
import { getRuntimeConfig } from "@/lib/runtime-config";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type DependencyStatus = "ok" | "unreachable";
type StellarStatus = DependencyStatus | "TESTNET_RESET_DETECTED";

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

/**
 * Detect a Stellar testnet reset. A reset wipes contracts and accounts, so the
 * ledger sequence regresses below our checkpoint, the network passphrase no
 * longer matches, or the configured contract is missing. This logic is
 * explicitly forbidden on mainnet: a mainnet deployment must never be marked
 * as reset, and any mismatch there is treated as unreachable instead.
 */
async function checkStellar(): Promise<StellarStatus> {
  const isMainnet = serverEnv.STELLAR_NETWORK === "mainnet";
  try {
    const server = new rpc.Server(serverEnv.SOROBAN_RPC_URL);
    await server.getHealth();

    const latest = await server.getLatestLedger();
    const checkpoint = serverEnv.STELLAR_LEDGER_CHECKPOINT;
    if (
      !isMainnet &&
      typeof checkpoint === "number" &&
      latest.sequence < checkpoint
    ) {
      return "TESTNET_RESET_DETECTED";
    }

    const contractId = serverEnv.SOROBAN_CONTRACT_ID;
    if (!isMainnet && contractId) {
      const entries = await server.getContractData(
        contractId,
        // A missing contract instance is a reset signal.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (await import("@stellar/stellar-sdk")).xdr.LedgerKey.contractData(
          new (await import("@stellar/stellar-sdk")).Contract(contractId)
            .getFootprint(),
        ),
      );
      if (!entries) {
        return "TESTNET_RESET_DETECTED";
      }
    }

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
 */
export async function GET() {
  const config = getRuntimeConfig();
  const [supabase, stellar] = await Promise.all([
    checkSupabase(),
    checkStellar(),
  ]);

  const resetDetected = stellar === "TESTNET_RESET_DETECTED";
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
        payoutIndexer: resetDetected
          ? "halted"
          : config.payoutIndexer.enabled
            ? "enabled"
            : "disabled",
        sentry: config.sentry.enabled ? "enabled" : "disabled",
      },
      ...(resetDetected
        ? {
            degraded: "TESTNET_RESET_DETECTED",
            runbook: "scripts/testnet-bootstrap.mjs",
          }
        : {}),
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
