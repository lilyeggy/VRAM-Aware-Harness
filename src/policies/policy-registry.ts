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
    private readonly userPolicies = new Map<string, PolicyLayer>();

    setPlatformPolicy(id: string, policy: PolicyConstraints): void {
        this.platform = createPolicyLayer(id, "PLATFORM", policy);
    }

    setUserPolicy(
        userId: string,
        id: string,
        policy: PolicyConstraints,
    ): void {
        this.userPolicies.set(
            userId,
            createPolicyLayer(id, "USER", policy),
        );
    }

    getPlatformPolicy(): PolicyLayer {
        return this.platform;
    }

    getUserPolicy(userId: string): PolicyLayer {
        return this.userPolicies.get(userId)
            ?? createPolicyLayer(
                `user:${userId}:default`,
                "USER",
                unrestrictedPolicy,
            );
    }
}
