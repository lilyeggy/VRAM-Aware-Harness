import type { Database } from "bun:sqlite";
import {
    createRuntimeCapabilityProfile,
    type RuntimeCapability,
    type RuntimeCapabilityProfile,
} from "./runtime-capability.ts";

interface CapabilityRow {
    id: string;
    runtimeKind: "PI";
    deploymentKey: string;
    supportedJson: string;
    auditCompleteness: "FULL" | "PARTIAL";
    reportedAt: string;
}

export class RuntimeCapabilityProfileStore {
    constructor(private readonly db: Database) {}

    save(profile: RuntimeCapabilityProfile): void {
        const validated = createRuntimeCapabilityProfile(profile);
        const existing = this.getByDeployment(
            validated.runtimeKind,
            validated.deploymentKey,
        );
        if (existing !== null) {
            if (
                existing.id !== validated.id
                || existing.auditCompleteness !== validated.auditCompleteness
                || JSON.stringify(existing.supported)
                    !== JSON.stringify(validated.supported)
            ) {
                throw new Error(
                    `CapabilityProfile deployment 已存在不同声明：${validated.deploymentKey}`,
                );
            }
            return;
        }
        const parameters = {
            id: validated.id,
            runtimeKind: validated.runtimeKind,
            deploymentKey: validated.deploymentKey,
            supportedJson: JSON.stringify(validated.supported),
            auditCompleteness: validated.auditCompleteness,
            reportedAt: validated.reportedAt,
        };
        this.db.query<unknown, typeof parameters>(`
            INSERT INTO runtime_capability_profiles (
                id, runtime_kind, deployment_key, supported_json,
                audit_completeness, reported_at
            ) VALUES (
                $id, $runtimeKind, $deploymentKey, $supportedJson,
                $auditCompleteness, $reportedAt
            );
        `).run(parameters);
    }

    get(id: string): RuntimeCapabilityProfile | null {
        const row = this.select("id = $value", id);
        return row === null ? null : this.fromRow(row);
    }

    getByDeployment(
        runtimeKind: "PI",
        deploymentKey: string,
    ): RuntimeCapabilityProfile | null {
        const row = this.db.query<CapabilityRow, {
            runtimeKind: string;
            deploymentKey: string;
        }>(`
            SELECT id, runtime_kind AS runtimeKind,
                deployment_key AS deploymentKey,
                supported_json AS supportedJson,
                audit_completeness AS auditCompleteness,
                reported_at AS reportedAt
            FROM runtime_capability_profiles
            WHERE runtime_kind = $runtimeKind
              AND deployment_key = $deploymentKey;
        `).get({ runtimeKind, deploymentKey });
        return row === null ? null : this.fromRow(row);
    }

    private select(condition: string, value: string): CapabilityRow | null {
        return this.db.query<CapabilityRow, { value: string }>(`
            SELECT id, runtime_kind AS runtimeKind,
                deployment_key AS deploymentKey,
                supported_json AS supportedJson,
                audit_completeness AS auditCompleteness,
                reported_at AS reportedAt
            FROM runtime_capability_profiles
            WHERE ${condition};
        `).get({ value });
    }

    private fromRow(row: CapabilityRow): RuntimeCapabilityProfile {
        return createRuntimeCapabilityProfile({
            id: row.id,
            runtimeKind: row.runtimeKind,
            deploymentKey: row.deploymentKey,
            supported: JSON.parse(row.supportedJson) as RuntimeCapability[],
            auditCompleteness: row.auditCompleteness,
            reportedAt: row.reportedAt,
        });
    }
}
