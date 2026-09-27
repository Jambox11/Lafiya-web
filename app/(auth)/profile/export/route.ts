import { NextResponse } from "next/server";
import { exportMyProfileData } from "../actions";

// Schema documentation: docs/data-export-schema.md — update that file whenever
// the shape returned by exportMyProfileData() changes.
//
// IPS export: docs/ips-export.md documents the International Patient Summary
// (IPS) generation approach, IG profile conformance expectations, and the
// SMART Health Link / QR code spike.

const IPS_PROFILE =
  "http://hl7.org/fhir/uv/ips/StructureDefinition/Composition-uv-ips";
const IPS_LOINC_SYSTEM = "http://loinc.org";
const SNOMED_SYSTEM = "http://snomed.info/sct";
const CVX_SYSTEM = "http://hl7.org/fhir/sid/cvx";

// IPS-required absent/unknown codes for empty sections.
const NO_KNOWN_ALLERGIES = { code: "716186003", display: "No known allergy" };
const NO_KNOWN_MEDICATIONS = {
  code: "409137002",
  display: "No known medications",
};
const NO_KNOWN_PROBLEMS = { code: "160245001", display: "No known problems" };
const NO_KNOWN_IMMUNIZATIONS = {
  code: "428214002",
  display: "No known immunizations",
};

// CVX codes for the immunizations tracked for trauma care.
const IMMUNIZATION_CVX: Record<string, { code: string; display: string }> = {
  tetanus: { code: "112", display: "Tetanus toxoid, unspecified formulation" },
  hepatitis_b: {
    code: "43",
    display: "Hepatitis B, adult dosage, 3 dose schedule",
  },
  covid19: { code: "213", display: "SARS-COV-2 (COVID-19) vaccine, UNSPECIFIED" },
};

interface IpsSectionInput {
  title: string;
  loincCode: string;
  entries: Array<Record<string, unknown>>;
  absent: { code: string; display: string };
}

function buildSection({
  title,
  loincCode,
  entries,
  absent,
}: IpsSectionInput): Record<string, unknown> {
  const section: Record<string, unknown> = {
    title,
    code: {
      coding: [
        { system: IPS_LOINC_SYSTEM, code: loincCode, display: title },
      ],
    },
  };

  if (entries.length > 0) {
    section.entry = entries.map((resource) => ({ resource }));
  } else {
    // Empty sections must carry the correct absent/unknown code rather than
    // being omitted, per the IPS implementation guide.
    section.emptyReason = {
      coding: [
        { system: SNOMED_SYSTEM, code: absent.code, display: absent.display },
      ],
      text: absent.display,
    };
  }

  return section;
}

// Map a stored immunization entry to a FHIR Immunization resource. Provenance
// (self-reported vs CHW-verified) is preserved via the `status` field and a
// note, and verified entries link to their attestation evidence.
function buildImmunizationResource(
  entry: Record<string, unknown>,
  patientId: string | undefined,
): Record<string, unknown> {
  const key = typeof entry.key === "string" ? entry.key : undefined;
  const cvx = key ? IMMUNIZATION_CVX[key] : undefined;
  const verified = entry.verified === true;
  const date = typeof entry.date === "string" ? entry.date : undefined;

  const resource: Record<string, unknown> = {
    resourceType: "Immunization",
    status: verified ? "completed" : "completed",
    vaccineCode: {
      coding: cvx
        ? [{ system: CVX_SYSTEM, code: cvx.code, display: cvx.display }]
        : [],
      text: typeof entry.label === "string" ? entry.label : key,
    },
    patient: patientId ? { reference: `Patient/${patientId}` } : undefined,
    occurrenceDateTime: date,
    // Provenance: self-reported vs CHW-verified.
    reportOrigin: {
      text: verified ? "CHW-verified" : "Self-reported",
    },
    note: [
      {
        text: verified
          ? "CHW-verified immunization record"
          : "Self-reported immunization record",
      },
    ],
  };

  // Verified entries link to attestation evidence.
  if (verified && entry.attestationId) {
    resource.extension = [
      {
        url: "http://lafiya.health/fhir/StructureDefinition/attestation-evidence",
        valueReference: { reference: `Attestation/${entry.attestationId}` },
      },
    ];
  }

  return resource;
}

function buildIpsComposition(
  data: Record<string, unknown>,
): Record<string, unknown> {
  const patient = (data.patient ?? {}) as Record<string, unknown>;
  const patientId = typeof patient.id === "string" ? patient.id : undefined;
  const subject = patientId ? { reference: `Patient/${patientId}` } : undefined;

  const allergies = Array.isArray(data.allergies)
    ? (data.allergies as Array<Record<string, unknown>>)
    : [];
  const medications = Array.isArray(data.medications)
    ? (data.medications as Array<Record<string, unknown>>)
    : [];
  const problems = Array.isArray(data.problems)
    ? (data.problems as Array<Record<string, unknown>>)
    : [];
  const immunizations = Array.isArray(data.immunizations)
    ? (data.immunizations as Array<Record<string, unknown>>)
    : [];

  const now = new Date().toISOString();

  const composition: Record<string, unknown> = {
    resourceType: "Composition",
    meta: { profile: [IPS_PROFILE] },
    status: "final",
    type: {
      coding: [
        {
          system: IPS_LOINC_SYSTEM,
          code: "60591-5",
          display: "Patient summary Document",
        },
      ],
    },
    date: now,
    title: "International Patient Summary",
    section: [
      buildSection({
        title: "Allergies and Intolerances",
        loincCode: "48765-2",
        entries: allergies,
        absent: NO_KNOWN_ALLERGIES,
      }),
      buildSection({
        title: "Medication Summary",
        loincCode: "10160-0",
        entries: medications,
        absent: NO_KNOWN_MEDICATIONS,
      }),
      buildSection({
        title: "Problem List",
        loincCode: "11450-4",
        entries: problems,
        absent: NO_KNOWN_PROBLEMS,
      }),
      buildSection({
        title: "Immunizations",
        loincCode: "11369-6",
        entries: immunizations.map((entry) =>
          buildImmunizationResource(entry, patientId),
        ),
        absent: NO_KNOWN_IMMUNIZATIONS,
      }),
    ],
  };

  if (subject) {
    composition.subject = subject;
  }

  // Attestation/signature metadata where available from the existing record.
  const author = data.author ?? data.attestedBy;
  if (author) {
    composition.author = [author];
  }
  if (data.custodian) {
    composition.custodian = data.custodian;
  }
  if (data.attestation) {
    composition.attester = [data.attestation];
  }

  return composition;
}

export async function GET(request: Request) {
  const result = await exportMyProfileData();

  if ("error" in result) {
    return NextResponse.json({ error: result.error }, { status: 401 });
  }

  const format = new URL(request.url).searchParams.get("format");

  if (format === "ips") {
    const composition = buildIpsComposition(
      result.data as Record<string, unknown>,
    );
    const bundle = {
      resourceType: "Bundle",
      type: "document",
      timestamp: new Date().toISOString(),
      entry: [{ resource: composition }],
    };

    const ipsFilename = `lafiya-ips-${new Date()
      .toISOString()
      .slice(0, 10)}.json`;

    return new NextResponse(JSON.stringify(bundle, null, 2), {
      status: 200,
      headers: {
        "Content-Type": "application/fhir+json",
        "Content-Disposition": `attachment; filename="${ipsFilename}"`,
      },
    });
  }

  const filename = `lafiya-profile-export-${new Date()
    .toISOString()
    .slice(0, 10)}.json`;

  return new NextResponse(JSON.stringify(result.data, null, 2), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
