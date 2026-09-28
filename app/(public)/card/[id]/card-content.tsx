import Image from "next/image";
import Link from "next/link";

import { formatDateTime } from "@/lib/format/datetime";
import { OfflineEnvelopeSource } from "@/lib/emergency/offline-source";
import type { EmergencyCardRow } from "@/lib/supabase/types";

import { VerifiedBadge, type VerificationStatus } from "./verified-badge";

/** Issue #544: window within which a critical field is considered "recently
 * updated". Kept in sync with the server-side projection in the card RPC. */
const RECENT_CHANGE_WINDOW_DAYS = 30;

function formatList(values: string[] | null): string {
  if (values === null) return "Withheld by patient";
  return values.length > 0 ? values.join(", ") : "None recorded";
}

function formatTime(value: string | null): string {
  return formatDateTime(value);
}

function formatRelativeTime(value: string | null): string {
  if (!value) return "Unavailable";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unavailable";
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSeconds = Math.floor(diffMs / 1000);
  const diffMinutes = Math.floor(diffSeconds / 60);
  const diffHours = Math.floor(diffMinutes / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffSeconds < 60) return "Just now";
  if (diffMinutes < 60)
    return `${diffMinutes} minute${diffMinutes === 1 ? "" : "s"} ago`;
  if (diffHours < 24)
    return `${diffHours} hour${diffHours === 1 ? "" : "s"} ago`;
  if (diffDays < 7) return `${diffDays} day${diffDays === 1 ? "" : "s"} ago`;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
  }).format(date);
}

/** Issue #544: true only when the server-projected `changed_at` for a field
 * falls inside the recent-change window. The server never sends historical
 * values, only the timestamp, so nothing sensitive leaks here. */
function isRecentlyChanged(changedAt: string | null | undefined): boolean {
  if (!changedAt) return false;
  const date = new Date(changedAt);
  if (Number.isNaN(date.getTime())) return false;
  const diffMs = Date.now() - date.getTime();
  return diffMs >= 0 && diffMs <= RECENT_CHANGE_WINDOW_DAYS * 24 * 60 * 60 * 1000;
}

function phoneHref(phone: string): string | null {
  const normalized = phone.replace(/[\s().-]/g, "");
  return /^\+?[1-9]\d{6,14}$/.test(normalized) ? `tel:${normalized}` : null;
}

export function EmergencyCardContent({
  card,
  authorizationKind,
  isOwner = false,
}: {
  card: EmergencyCardRow;
  authorizationKind: "legacy" | "capability";
  /** Issue #383: true only when the signed-in viewer's own profile owns
   * this card — determined by the page without ever exposing the card's
   * user_id to the client (get_emergency_card deliberately never returns
   * it). Never trust this from anywhere but a server-side check. */
  isOwner?: boolean;
}) {
  const status: VerificationStatus =
    card.trust_state === "unverified"
      ? "not_verified"
      : (card.trust_state ?? "unavailable");

  return (
    <>
      {/* A skip link outside every landmark fails axe's "region" rule
          (all page content must be contained by a landmark), so it gets its
          own nav landmark rather than sitting bare before <main>. */}
      <nav aria-label="Skip links">
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:bg-white focus:p-4 focus:text-black dark:focus:bg-black dark:focus:text-white"
        >
          Skip to emergency information
        </a>
      </nav>
      <main
        id="main-content"
        className="mx-auto flex w-full max-w-xl flex-1 flex-col gap-6 px-4 py-8 sm:px-6 sm:py-16"
      >
        {isOwner ? (
          <Link
            href="/profile"
            className="self-start rounded-full border border-zinc-300 px-4 py-1.5 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            ✎ Edit my card
          </Link>
        ) : null}
        <section
          aria-label="Record trust and freshness"
          className="flex flex-col gap-3"
        >
          <VerifiedBadge status={status} />
          <dl className="grid gap-2 rounded-lg border border-zinc-300 p-3 text-sm dark:border-zinc-700">
            <div className="flex flex-wrap justify-between gap-x-4 gap-y-1">
              <dt className="font-medium">Record updated</dt>
              <dd>{formatTime(card.record_updated_at)}</dd>
            </div>
            <div className="flex flex-wrap justify-between gap-x-4 gap-y-1">
              <dt className="font-medium">Last updated</dt>
              <dd>{formatRelativeTime(card.record_updated_at)}</dd>
            </div>
            <div className="flex flex-wrap justify-between gap-x-4 gap-y-1">
              <dt className="font-medium">Authorization valid until</dt>
              <dd>{formatTime(card.authorization_expires_at)}</dd>
            </div>
            <div className="flex flex-wrap justify-between gap-x-4 gap-y-1">
              <dt className="font-medium">Verification last checked</dt>
              <dd>{formatTime(card.trust_updated_at)}</dd>
            </div>
          </dl>
        </section>

        <section
          aria-labelledby="identity-heading"
          className="flex items-center gap-4"
        >
          {card.photo_url ? (
            <Image
              src={card.photo_url}
              alt=""
              width={80}
              height={80}
              sizes="80px"
              className="h-20 w-20 rounded-full object-cover"
            />
          ) : null}
          <div>
            <h1
              id="identity-heading"
              data-testid="card-identity-name"
              className="text-2xl font-semibold text-zinc-950 dark:text-zinc-50"
            >
              {card.name ?? "Name withheld"}
            </h1>
            {card.age !== null ? (
              <p className="text-sm text-zinc-600 dark:text-zinc-400">
                {card.age} years old
              </p>
            ) : null}
          </div>
        </section>

        <section aria-labelledby="critical-facts-heading">
          <h2
            id="critical-facts-heading"
            className="mb-3 text-lg font-semibold"
          >
            Critical emergency information
          </h2>
          <dl className="grid gap-4 rounded-lg border border-zinc-300 p-4 sm:grid-cols-2 dark:border-zinc-700">
            <div>
              <dt className="text-xs font-medium tracking-wide text-zinc-500 uppercase">
                Blood group
              </dt>
              <dd
                data-testid="card-blood-group"
                className="text-lg font-semibold text-zinc-950 dark:text-zinc-50"
              >
                {card.blood_group ?? "Withheld"}
              </dd>
            </div>
            <div>
              <dt className="text-xs font-medium tracking-wide text-zinc-500 uppercase">
                Genotype
              </dt>
              <dd
                data-testid="card-genotype"
                className="text-lg font-semibold text-zinc-950 dark:text-zinc-50"
              >
                {card.genotype ?? "Withheld"}
              </dd>
            </div>
          </dl>
        </section>

        <section
          aria-labelledby="clinical-details-heading"
          className="flex flex-col gap-5"
        >
          <h2 id="clinical-details-heading" className="sr-only">
            Clinical details
          </h2>
          <CardField
            label="Allergies"
            value={formatList(card.allergies)}
            changedAt={card.allergies_changed_at}
          />
          <CardField
            label="Current medications"
            value={formatList(card.medications)}
            changedAt={card.medications_changed_at}
          />
          <CardField
            label="Chronic conditions / implants"
            value={formatList(card.chronic_conditions)}
            changedAt={card.chronic_conditions_changed_at}
          />
        </section>

        {card.emergency_contacts === null ? (
          <CardField label="Emergency contacts" value="Withheld by patient" />
        ) : card.emergency_contacts.length > 0 ? (
          <section aria-labelledby="contacts-heading">
            <h2
              id="contacts-heading"
              className="text-sm font-medium text-zinc-700 dark:text-zinc-300"
            >
              Emergency contacts
            </h2>
            <ul role="list" className="mt-2 flex flex-col gap-3">
              {card.emergency_contacts.map((contact) => {
                const href = phoneHref(contact.phone);
                return (
                  <li
                    key={`${contact.name}-${contact.phone}`}
                    className="rounded-md border border-zinc-200 p-3 dark:border-zinc-800"
                  >
                    <p className="font-medium">{contact.name}</p>
                    <p className="text-sm text-zinc-600 dark:text-zinc-400">
                      {contact.relationship}
                    </p>
                    {href ? (
                      <a
                        href={href}
                        className="text-sm font-medium text-blue-700 underline dark:text-blue-400"
                      >
                        {contact.phone}
                      </a>
                    ) : (
                      <p className="text-sm">{contact.phone}</p>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        ) : (
          <CardField label="Emergency contacts" value="None recorded" />
        )}

        <OfflineEnvelopeSource card={card} />
      </main>
    </>
  );
}

function CardField({
  label,
  value,
  changedAt,
}: {
  label: string;
  value: string;
  /** Issue #544: server-projected revision timestamp for this field, or
   * undefined when the field is not tracked / never changed. */
  changedAt?: string | null;
}) {
  const recentlyChanged = isRecentlyChanged(changedAt);
  return (
    <div>
      <dt className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
        {label}
      </dt>
      <dd className="mt-1 text-zinc-950 dark:text-zinc-50">
        {value}
        {recentlyChanged ? (
          <span
            data-testid={`card-recent-change-${label
              .toLowerCase()
              .replace(/[^a-z0-9]+/g, "-")}`}
            className="mt-1 flex items-center gap-1 text-xs font-medium text-amber-800 dark:text-amber-300"
          >
            {/* Icon + text so the marker never relies on colour alone. */}
            <span aria-hidden="true">⟳</span>
            <span>
              Recently updated — {formatTime(changedAt ?? null)}
            </span>
          </span>
        ) : null}
      </dd>
    </div>
  );
}
