import {
    createHarnessInstance,
    transitionHarnessInstance,
} from "../instances/harness-instance.ts";
import { HarnessInstanceStore } from "../instances/harness-instance-store.ts";
import {
    createPiCapabilityProfile,
    type RuntimeCapabilityProfile,
} from "../runtime/runtime-capability.ts";
import { RuntimeCapabilityProfileStore } from "../runtime/runtime-capability-store.ts";
import type {
    RunControlBinding,
    RunControlBindingResolver,
    StartRunInput,
} from "../runs/run-service.ts";
import { createHarnessSession } from "../sessions/harness-session.ts";
import { HarnessSessionStore } from "../sessions/harness-session-store.ts";
import {
    createHarnessTemplate,
    createPiTemplateVersion,
} from "../templates/harness-template.ts";
import { HarnessTemplateStore } from "../templates/harness-template-store.ts";

export interface DefaultPiControlPlaneConfig {
    readonly provider: string;
    readonly modelId: string;
    readonly tools: readonly string[];
    readonly capabilityProfile?: RuntimeCapabilityProfile;
}

/**
 * 旧 API 只提供 tenant/session/workspace。兼容控制面为每个 Tenant 懒创建
 * 默认 TemplateVersion 与 Instance，并把调用方 sessionId 变成真实 Session。
 */
export class DefaultPiControlPlane implements RunControlBindingResolver {
    private readonly profile: RuntimeCapabilityProfile;

    constructor(
        private readonly templates: HarnessTemplateStore,
        private readonly instances: HarnessInstanceStore,
        private readonly sessions: HarnessSessionStore,
        private readonly capabilities: RuntimeCapabilityProfileStore,
        private readonly config: DefaultPiControlPlaneConfig,
    ) {
        const deploymentKey = `${config.provider}/${config.modelId}`;
        this.profile = config.capabilityProfile ?? createPiCapabilityProfile(
            `pi-capability:${deploymentKey}`,
            deploymentKey,
        );
    }

    resolve(input: StartRunInput): RunControlBinding {
        this.capabilities.save(this.profile);
        const suffix = encodeURIComponent(input.tenantId);
        const templateId = `default-pi-template:${suffix}`;
        const templateVersionId = `default-pi-template-version:${suffix}:1`;
        const instanceId = `default-pi-instance:${suffix}`;
        const now = new Date().toISOString();

        if (this.templates.getTemplate(templateId) === null) {
            this.templates.createTemplate(createHarnessTemplate({
                id: templateId,
                tenantId: input.tenantId,
                createdAt: now,
            }));
            this.templates.publishVersion(templateId, createPiTemplateVersion({
                id: templateVersionId,
                templateId,
                version: 1,
                provider: this.config.provider,
                modelId: this.config.modelId,
                tools: this.config.tools,
                skills: [],
                requiredCapabilities: [
                    "SESSION_CREATE",
                    "INTERRUPT",
                    "TOOL_INTERCEPTION",
                    "SIDE_EFFECT_EVIDENCE",
                    "EXTERNAL_SANDBOX",
                ],
                optionalCapabilities: [
                    "SESSION_RESUME",
                    "MODEL_USAGE",
                    "MODEL_EVENTS",
                ],
                createdAt: now,
            }));
        }

        let instance = this.instances.get(instanceId);
        if (instance === null) {
            instance = createHarnessInstance({
                id: instanceId,
                tenantId: input.tenantId,
                templateVersionId,
                capabilityProfileId: this.profile.id,
                runtimeKind: "PI",
                createdAt: now,
            });
            this.instances.create(instance);
            const ready = transitionHarnessInstance(instance, "READY", now);
            this.instances.update(ready, instance.actualState);
            instance = ready;
        }

        const existingSession = this.sessions.get(input.harnessSessionId);
        if (existingSession === null) {
            this.sessions.create(createHarnessSession({
                id: input.harnessSessionId,
                tenantId: input.tenantId,
                instanceId: instance.id,
                createdAt: now,
            }));
        } else if (
            existingSession.tenantId !== input.tenantId
            || existingSession.instanceId !== instance.id
        ) {
            throw new Error(
                `HarnessSession 归属与本次 Run 不匹配：${input.harnessSessionId}`,
            );
        }

        return Object.freeze({
            templateVersionId,
            harnessInstanceId: instance.id,
        });
    }
}
