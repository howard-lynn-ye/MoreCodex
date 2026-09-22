export interface WebModelAvailabilityEvidence {
  source: "authenticated-catalog-flags";
  status: "available" | "unavailable" | "unknown";
  observedAt: string;
  /** Only literal boolean fields actually present in the authenticated response. */
  signals: { available?: boolean; disabled?: boolean; is_disabled?: boolean };
}

/** Catalogue declarations are permission metadata, never proof of a successful request. */
export function observeModelAvailability(raw: Record<string, unknown>, observedAt = new Date().toISOString()): WebModelAvailabilityEvidence {
  const signals: WebModelAvailabilityEvidence["signals"] = {};
  for (const key of ["available", "disabled", "is_disabled"] as const) {
    if (typeof raw[key] === "boolean") signals[key] = raw[key];
  }
  const status = signals.available === false || signals.disabled === true || signals.is_disabled === true
    ? "unavailable"
    : signals.available === true || signals.disabled === false || signals.is_disabled === false
      ? "available"
      : "unknown";
  return { source: "authenticated-catalog-flags", status, observedAt, signals };
}

export function validateModelAvailability(model: {
  available: boolean | null;
  availabilityEvidence?: WebModelAvailabilityEvidence;
}): void {
  const evidence = model.availabilityEvidence;
  if (evidence !== undefined) {
    if (!evidence || typeof evidence !== "object" || evidence.source !== "authenticated-catalog-flags"
      || !["available", "unavailable", "unknown"].includes(evidence.status)
      || typeof evidence.observedAt !== "string" || !Number.isFinite(Date.parse(evidence.observedAt))
      || !evidence.signals || typeof evidence.signals !== "object" || Array.isArray(evidence.signals)
      || Object.entries(evidence.signals).some(([key, value]) => !["available", "disabled", "is_disabled"].includes(key) || typeof value !== "boolean")
      || observeModelAvailability(evidence.signals, evidence.observedAt).status !== evidence.status
      || model.available !== (evidence.status === "unknown" ? null : evidence.status === "available")) {
      throw Error("Invalid model availability evidence; unknown catalogue permissions cannot be marked available");
    }
  }
  if (model.available === null && evidence?.status !== "unknown") throw Error("Unknown model availability requires catalogue provenance");
}

/** Older booleans remain compatible, but cannot be retroactively called verified permission evidence. */
export function describeModelAvailability(model: { available: boolean | null; availabilityEvidence?: WebModelAvailabilityEvidence }) {
  return {
    status: model.availabilityEvidence?.status ?? "unknown",
    source: model.availabilityEvidence?.source ?? "legacy-boolean-unqualified",
    observedAt: model.availabilityEvidence?.observedAt,
    signals: model.availabilityEvidence?.signals,
    legacyBooleanCompatibility: model.availabilityEvidence === undefined,
    requestVerification: "not-recorded-in-registry" as const,
  };
}
