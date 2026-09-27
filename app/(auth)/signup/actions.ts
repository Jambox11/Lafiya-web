"use server";

import { redirect } from "next/navigation";
import { z } from "zod";

import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

import { logError } from "@/lib/logging/logger";
import { CURRENT_POLICY_VERSION } from "@/lib/consent";
import { defineAction } from "@/lib/actions/define-action";

const signUpSchema = z.object({
  email: z.email("Enter a valid email address"),
  password: z.string().min(8, "Password must be at least 8 characters"),
  consent: z
    .string()
    .transform((val) => val === "on")
    .refine((val) => val, "You must accept the privacy policy to continue"),
});

export interface SignUpState {
  error?: string;
  info?: string;
}

const signUpAction = defineAction({
  input: signUpSchema,
  handler: async ({ email, password }) => {
    const supabase = await createClient();
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
    });

    if (error) {
      logError("Sign up failed", error, {
        route: "/signup (action: signUp)",
        email,
      });
      const message = error.message.toLowerCase();
      if (
        message.includes("already registered") ||
        message.includes("already exists")
      ) {
        return {
          ok: false as const,
          error: {
            code: "EMAIL_ALREADY_REGISTERED" as const,
            message:
              "That email is already registered — try signing in instead.",
          },
        };
      }
      if (message.includes("password")) {
        return {
          ok: false as const,
          error: {
            code: "WEAK_PASSWORD" as const,
            message:
              "That password doesn't meet the requirements. Please choose a stronger password.",
          },
        };
      }
      return {
        ok: false as const,
        error: {
          code: "UNKNOWN" as const,
          message:
            "We couldn't create your account. Please try again or contact support if the problem continues.",
        },
      };
    }

    if (data.user) {
      const adminClient = createAdminClient();
      const { error: consentError } = await adminClient
        .from("consent_logs")
        .insert({
          user_id: data.user.id,
          policy_version: CURRENT_POLICY_VERSION,
        });

      if (consentError) {
        logError("Failed to record user consent", consentError, {
          route: "/signup (action: signUp)",
          userId: data.user.id,
        });
        // Rollback auth user creation if consent recording fails
        await adminClient.auth.admin.deleteUser(data.user.id);
        return {
          ok: false as const,
          error: {
            code: "CONSENT_RECORD_FAILED" as const,
            message: "Failed to record consent. Please try again.",
          },
        };
      }
    }

    // If email confirmations are enabled (the default for hosted projects),
    // signUp() succeeds but returns no session until the link is clicked.
    if (!data.session) {
      return {
        ok: true as const,
        data: {
          info: "Check your email to confirm your account, then sign in.",
        },
      };
    }

    return { ok: true as const, data: {} };
  },
});

export async function signUp(
  _prevState: SignUpState | undefined,
  formData: FormData,
): Promise<SignUpState> {
  const result = await signUpAction({
    email: formData.get("email"),
    password: formData.get("password"),
    consent: formData.get("consent"),
  });

  if (!result.ok) {
    return { error: result.error.message };
  }

  if (result.data.info) {
    return { info: result.data.info };
  }

  redirect("/profile");
}
