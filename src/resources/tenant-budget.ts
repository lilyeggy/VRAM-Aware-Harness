/**
 * Per-tenant resource budget + fair-share model.
 *
 * Unlike the existing DeterministicExecutionPolicy (which only counts concurrency),
 * this gives each tenant a budget expressed in abstract resource *units*, a
 * fairness *weight*, and a hard ceiling (`maxUnits`). Admission compares a
 * tenant's *current ledger usage* against the smaller of its fair share and its
 * ceiling — i.e. scheduling that actually respects "how much this tenant has
 * already consumed", not just "how many runs it has in flight".
 */

/** Abstract resource units a run occupies (defaults to 1 per running attempt). */
export interface TenantBudget {
    readonly tenantId: string;
    /** Fair-share weight, proportional to allocation. Must be > 0. */
    readonly weight: number;
    /**
     * Hard ceiling on concurrently-occupied units (budget). 0 is not allowed;
     * use Infinity for "no ceiling beyond fair share".
     */
    readonly maxUnits: number;
}

export interface FairShareContext {
    readonly capacityUnits: number;
    readonly weights: Readonly<Record<string, number>>;
}

export function computeFairShareUnits(input: {
    tenantId: string;
    capacityUnits: number;
    weights: Readonly<Record<string, number>>;
}): number {
    const weight = normalizedWeight(input.weights[input.tenantId]);
    const totalWeight = Object.values(input.weights).reduce(
        (sum, value) => sum + normalizedWeight(value),
        0,
    );
    if (totalWeight <= 0) {
        return 0;
    }
    return Math.floor((input.capacityUnits * weight) / totalWeight);
}

/**
 * Fair-share admission check: a tenant may start `requestedUnits` more only if
 * its current usage plus the request stays within the tighter of its fair share
 * and its ceiling.
 */
export function canAdmitUnits(input: {
    tenantId: string;
    activeUnits: number;
    requestedUnits: number;
    fairShareUnits: number;
    maxUnits: number;
}): boolean {
    const ceiling = Math.min(
        Number.isFinite(input.maxUnits) ? Math.max(0, input.maxUnits) : Infinity,
        Math.max(0, input.fairShareUnits),
    );
    return input.activeUnits + input.requestedUnits <= ceiling;
}

function normalizedWeight(value: number | undefined): number {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
        return 1;
    }
    return value;
}
