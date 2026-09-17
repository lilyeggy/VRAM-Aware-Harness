import type { Database } from "bun:sqlite";
import {
    computeEffectivePolicy,
    createPolicyLayer,
    type EffectivePolicySnapshot,
    type PolicyConstraints,
    type PolicyLayer,
} from "./effective-policy.ts";
interface SnapshotRow {
    id: string;
    runId: string;
    tenantId: string;
    templateVersionId: string;
    layersJson: string;
    effectiveJson: string;
    createdAt: string;
}

export interface ToolPolicyDecision {
    readonly id: string;
    readonly snapshotId: string;
    readonly runId: string;
    readonly toolCallId: string;
    readonly toolName: string;
    readonly action: "ALLOW" | "DENY";
    readonly reason: string;
    readonly decidedAt: string;
}

export class EffectivePolicyStore {
    constructor(private readonly db: Database) {}

    saveSnapshot(snapshot: EffectivePolicySnapshot): void {
        const effective = constraintsOnly(snapshot);
        const parameters = {
            id: snapshot.id,
            runId: snapshot.runId,
            tenantId: snapshot.tenantId,
            templateVersionId: snapshot.templateVersionId,
            layersJson: JSON.stringify(snapshot.layers),
            effectiveJson: JSON.stringify(effective),
            createdAt: snapshot.createdAt,
        };
        this.db.query<unknown, typeof parameters>(`
            INSERT INTO effective_policy_snapshots (
                id, run_id, tenant_id, template_version_id,
                layers_json, effective_json, created_at
            ) VALUES (
                $id, $runId, $tenantId, $templateVersionId,
                $layersJson, $effectiveJson, $createdAt
            );
        `).run(parameters);
    }

    getSnapshot(id: string): EffectivePolicySnapshot | null {
        const row = this.db.query<SnapshotRow, { id: string }>(`
            SELECT id, run_id AS runId, tenant_id AS tenantId,
                template_version_id AS templateVersionId,
                layers_json AS layersJson, effective_json AS effectiveJson,
                created_at AS createdAt
            FROM effective_policy_snapshots WHERE id = $id;
        `).get({ id });
        if (row === null) return null;
        const rawLayers = JSON.parse(row.layersJson) as PolicyLayer[];
        const layers = rawLayers.map((layer) => createPolicyLayer(
            layer.id,
            layer.kind,
            layer,
        ));
        const computedSnapshot = computeEffectivePolicy({
            id: row.id,
            runId: row.runId,
            tenantId: row.tenantId,
            templateVersionId: row.templateVersionId,
            layers,
            createdAt: row.createdAt,
        });
        const persistedEffective = JSON.parse(row.effectiveJson) as PolicyConstraints;
        const snapshot = Object.freeze({
            ...computedSnapshot,
            sandboxProfile: persistedEffective.sandboxProfile ?? null,
        });
        const normalizedPersisted = {
            ...persistedEffective,
            sandboxProfile: persistedEffective.sandboxProfile ?? null,
        };
        if (JSON.stringify(constraintsOnly(snapshot)) !== JSON.stringify(normalizedPersisted)) {
            throw new Error(`EffectivePolicySnapshot 内容不一致：${id}`);
        }
        return snapshot;
    }

    listSnapshotsForRun(runId: string): EffectivePolicySnapshot[] {
        const ids = this.db.query<{ id: string }, { runId: string }>(`
            SELECT id FROM effective_policy_snapshots
            WHERE run_id = $runId ORDER BY created_at ASC, rowid ASC;
        `).all({ runId });
        return ids.map(({ id }) => this.getSnapshot(id)).filter(
            (snapshot): snapshot is EffectivePolicySnapshot => snapshot !== null,
        );
    }

    recordToolDecision(decision: ToolPolicyDecision): void {
        const parameters = { ...decision };
        this.db.query<unknown, typeof parameters>(`
            INSERT OR IGNORE INTO tool_policy_decisions (
                id, snapshot_id, run_id, tool_call_id,
                tool_name, action, reason, decided_at
            ) VALUES (
                $id, $snapshotId, $runId, $toolCallId,
                $toolName, $action, $reason, $decidedAt
            );
        `).run(parameters);
    }

    listToolDecisions(runId: string): ToolPolicyDecision[] {
        return this.db.query<ToolPolicyDecision, { runId: string }>(`
            SELECT id, snapshot_id AS snapshotId, run_id AS runId,
                tool_call_id AS toolCallId, tool_name AS toolName,
                action, reason, decided_at AS decidedAt
            FROM tool_policy_decisions
            WHERE run_id = $runId ORDER BY decided_at ASC, rowid ASC;
        `).all({ runId });
    }
}

function constraintsOnly(value: PolicyConstraints): PolicyConstraints {
    return {
        sandboxProfile: value.sandboxProfile ?? null,
        allowedTools: value.allowedTools,
        allowedSkills: value.allowedSkills,
        allowedModels: value.allowedModels,
        workspaceRoots: value.workspaceRoots,
        allowNetwork: value.allowNetwork,
        allowProcess: value.allowProcess,
        allowedSecrets: value.allowedSecrets,
        resourceLimits: value.resourceLimits,
    };
}
