import {
    createPolicyLayer,
    unrestrictedPolicy,
    type PolicyConstraints,
    type PolicyLayer,
} from "./effective-policy.ts";

export class PolicyRegistry {
    private platform: PolicyLayer = createPolicyLayer(
        "platform:default",
        "PLATFORM",
    );
    private readonly tenantPolicies = new Map<string, PolicyLayer>();

    setPlatformPolicy(id: string, policy: PolicyConstraints): void {
        this.platform = createPolicyLayer(id, "PLATFORM", policy);
    }

    setTenantPolicy(
        tenantId: string,
        id: string,
        policy: PolicyConstraints,
    ): void {
        this.tenantPolicies.set(
            tenantId,
            createPolicyLayer(id, "TENANT", policy),
        );
    }

    getPlatformPolicy(): PolicyLayer {
        return this.platform;
    }

    getTenantPolicy(tenantId: string): PolicyLayer {
        return this.tenantPolicies.get(tenantId)
            ?? createPolicyLayer(
                `tenant:${tenantId}:default`,
                "TENANT",
                unrestrictedPolicy,
            );
    }
}
