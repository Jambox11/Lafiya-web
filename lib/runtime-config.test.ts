import { describe, expect, it } from "vitest";

import {
  assertPreviewGuardrails,
  isPreviewDeployment,
  resolveRuntimeConfig,
} from "./runtime-config";

const baseEnv = {
  LAFIYA_DEPLOYMENT_ENV: "preview",
  NEXT_PUBLIC_SUPABASE_URL: "https://branch-preview.supabase.co",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
  LAFIYA_ATTESTATION_MODE: "mock",
  LAFIYA_CHAIN_NETWORK: "testnet",
} as const;

describe("preview deployment guardrails", () => {
  it("detects preview deployments from the deployment env flag", () => {
    expect(isPreviewDeployment({ LAFIYA_DEPLOYMENT_ENV: "preview" })).toBe(true);
    expect(isPreviewDeployment({ LAFIYA_DEPLOYMENT_ENV: "production" })).toBe(false);
    expect(isPreviewDeployment({})).toBe(false);
  });

  it("forces mock attestations in previews", () => {
    const config = resolveRuntimeConfig({ ...baseEnv, LAFIYA_ATTESTATION_MODE: "live" });
    expect(config.attestationMode).toBe("mock");
  });

  it("rejects previews that point at mainnet", () => {
    expect(() =>
      resolveRuntimeConfig({ ...baseEnv, LAFIYA_CHAIN_NETWORK: "mainnet" }),
    ).toThrow(/mainnet/i);
  });

  it("rejects previews that reuse the shared staging database", () => {
    expect(() =>
      resolveRuntimeConfig({
        ...baseEnv,
        NEXT_PUBLIC_SUPABASE_URL: "https://staging.supabase.co",
      }),
    ).toThrow(/isolated/i);
  });

  it("accepts a well-formed preview configuration", () => {
    const config = resolveRuntimeConfig(baseEnv);
    expect(config.deploymentEnv).toBe("preview");
    expect(config.attestationMode).toBe("mock");
    expect(config.chainNetwork).toBe("testnet");
    expect(() => assertPreviewGuardrails(baseEnv)).not.toThrow();
  });
});
