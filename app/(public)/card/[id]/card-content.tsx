import Image from "next/image";
import Link from "next/link";

import { formatDateTime } from "@/lib/format/datetime";
import { OfflineEnvelopeSource } from "@/lib/emergency/offline-source";
import type { EmergencyCardRow } from "@/lib/supabase/types";

import { VerifiedBadge, type VerificationStatus } from "./verified-badge";
import { ReadAloud } from "./read-aloud";

/** Issue #596: label locale negotiated from Accept-Language, overridable
 * via a no-JS link that persists the choice in a cookie. */
export type LabelLocale = "en" | "ha" | "yo" | "ig";

export const SUPPORTED_LABEL_LOCALES: LabelLocale[] = ["en", "ha", "yo", "ig"];

/** Clinically reviewed glossary (sign-off tracked in docs/i18n/glossary.md).
 * Only labels are translated; patient free text is never machine-translated. */
const GLOSSARY: Record<LabelLocale, Record<string, string>> = {
  en: {
    bloodGroup: "Blood group",
    genotype: "Genotype",
    allergies: "Allergies",
    medications: "Current medications",
    conditions: "Chronic conditions / implants",
    contacts: "Emergency contacts",
    withheld: "Withheld",
    withheldByPatient: "Withheld by patient",
    noneRecorded: "None recorded",
    criticalHeading: "Critical emergency information",
    clinicalHeading: "Clinical details",
    switchLabel: "Language",
  },
  ha: {
    bloodGroup: "Rukun jini",
    genotype: "Nau'in jini (genotype)",
    allergies: "Rashin jituwa",
    medications: "Magunguna na yanzu",
    conditions: "Cututtuka na dindindin / kayan jiki",
    contacts: "Lambobin gaggawa",
    withheld: "An ɓoye",
    withheldByPatient: "Marar lafiya ya ɓoye",
    noneRecorded: "Babu wanda aka rubuta",
    criticalHeading: "Muhimman bayanai na gaggawa",
    clinicalHeading: "Bayanan likita",
    switchLabel: "Harshe",
  },
  yo: {
    bloodGroup: "Ẹ̀yà ẹ̀jẹ̀",
    genotype: "Irú ẹ̀jẹ̀ (genotype)",
    allergies: "Àìfaradà",
    medications: "Àwọn oògùn lọ́wọ́",
    conditions: "Àrùn tí kò lọ / ohun ìmú ara",
    contacts: "Àwọn nọ́mbà pàjáwìrì",
    withheld: "A fi pamọ́",
    withheldByPatient: "Aláìsàn fi pamọ́",
    noneRecorded: "Kò sí tí a kọ sílẹ̀",
    criticalHeading: "Ìsọfúnni pàtàkì fún pàjáwìrì",
    clinicalHeading: "Àlàyé ìlera",
    switchLabel: "Èdè",
  },
  ig: {
    bloodGroup: "Òtù ọbara",
    genotype: "Ụdị ọbara (genotype)",
    allergies: "Mmetụta ọjọọ",
    medications: "Ọgwụ ugbu a",
    conditions: "Ọrịa na-adịgide / ihe arụnyere",
    contacts: "Nọmba mberede",
    withheld: "Ezoro ezo",
    withheldByPatient: "Onye ọrịa zoro ya",
    noneRecorded: "Ọ dịghị nke edere",
    criticalHeading: "Ozi mberede dị mkpa",
    clinicalHeading: "Nkọwa ahụike",
    switchLabel: "Asụsụ",
  },
};

function negotiateLabelLocale(acceptLanguage: string | null): LabelLocale {
  if (!acceptLanguage) return "en";
  const tags = acceptLanguage
    .split(",")
    .map((part) => part.split(";")[0].trim().toLowerCase());
  for (const tag of tags) {
    const base = tag.split("-")[0] as LabelLocale;
    if (SUPPORTED_LABEL_LOCALES.includes(base)) return base;
  }
  return "en";
}

function formatList(
  values: string[] | null,
  t: Record<string, string>,
): string {
  if (values === null) return t.withheldByPatient;
  return values.length > 0 ? values.join(", ") : t.noneRecorded;
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

function phoneHref(phone: string): string | null {
  const normalized = phone.replace(/[\s().-]/g, "");
  return /^\+?[1-9]\d{6,14}$/.test(normalized) ? `tel:${normalized}` : null;
}

/** Free text entered by the patient is tagged with their entry language so
 * screen readers announce it correctly; it is never machine-translated. */
function PatientText({
  value,
  lang,
}: {
  value: string;
  lang: string | null;
}) {
  return (
    <span lang={lang ?? undefined} className="break-words">
      {value}
    </span>
  );
}

function CardField({
  label,
  value,
  lang,
}: {
  label: string;
  value: string;
  lang?: string | null;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-medium tracking-wide text-zinc-500 uppercase">
        {label}
      </dt>
      <dd className="text-base break-words text-zinc-950 dark:text-zinc-50">
        <PatientText value={value} lang={lang ?? null} />
      </dd>
    </div>
  );
}

/** Issue #599: build the spoken script in a clinically sensible priority
 * order. Labels come from the negotiated glossary; patient free text is
 * spoken verbatim and never translated. */
function buildSpokenFields(
  card: EmergencyCardRow,
  t: Record<string, string>,
): { label: string; value: string }[] {
  return [
    { label: t.bloodGroup, value: card.blood_group ?? t.noneRecorded },
    { label: t.genotype, value: card.genotype ?? t.noneRecorded },
    { label: t.allergies, value: formatList(card.allergies, t) },
    { label: t.medications, value: formatList(card.medications, t) },
    { label: t.conditions, value: formatList(card.conditions, t) },
    {
      label: t.contacts,
      value:
        card.emergency_contacts && card.emergency_contacts.length > 0
          ? card.emergency_contacts
              .map((c) => `${c.name} ${c.phone}`)
              .join(", ")
          : t.noneRecorded,
    },
  ];
}

export function EmergencyCardContent({
  card,
  authorizationKind,
  isOwner = false,
  acceptLanguage = null,
  labelLocale,
}: {
  card: EmergencyCardRow;
  authorizationKind: "legacy" | "capability";
  /** Issue #383: true only when the signed-in viewer's own profile owns
   * this card — determined by the page without ever exposing the card's
   * user_id to the client (get_emergency_card deliberately never returns
   * it). Never trust this from anywhere but a server-side check. */
  isOwner?: boolean;
  /** Issue #596: raw Accept-Language header for label negotiation. */
  acceptLanguage?: string | null;
  /** Issue #596: explicit override (e.g. from the persisted cookie). */
  labelLocale?: LabelLocale;
}) {
  const locale = labelLocale ?? negotiateLabelLocale(acceptLanguage);
  const t = GLOSSARY[locale];
  const patientLang = card.language ?? null;
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
        {/* Issue #596: no-JS language switch. Each option is a plain link
            that sets the label-locale cookie server-side and reloads. */}
        <nav aria-label={t.switchLabel} className="flex flex-wrap gap-2">
          {SUPPORTED_LABEL_LOCALES.map((code) => (
            <Link
              key={code}
              href={`?lang=${code}`}
              hrefLang={code}
              aria-current={code === locale ? "true" : undefined}
              className={`rounded-full border px-3 py-1 text-sm ${
                code === locale
                  ? "border-zinc-900 bg-zinc-900 text-white dark:border-zinc-100 dark:bg-zinc-100 dark:text-black"
                  : "border-zinc-300 text-zinc-700 dark:border-zinc-700 dark:text-zinc-300"
              }`}
            >
              {code.toUpperCase()}
            </Link>
          ))}
        </nav>
        {/* Issue #599: hands-free read-aloud of the critical fields. */}
        <ReadAloud
          fields={buildSpokenFields(card, t)}
          locale={locale}
          patientLang={patientLang}
        />
        <VerifiedBadge status={status} />
      </main>
    </>
  );
}
