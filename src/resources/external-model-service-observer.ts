/**
 * 外部模型服务模式下的资源观察器。
 *
 * 背景：当模型服务（vLLM / opencode-go / 其他 OpenAI 兼容端点）由平台外部
 * 独立部署和运维时，本平台不再与推理引擎共机，也就无法、也不应该通过
 * vLLM /metrics 或 nvidia-smi 推断推理侧压力。此时把资源压力固定为
 * NORMAL，让 Run 准入不再被本地 GPU/KV cache 观测阻塞。
 *
 * 语义边界：
 * - 只影响“资源压力”这一层；租户并发上限（TenantRunScheduler）仍然生效。
 * - 不伪造 GPU 数据：显存、KV cache、token 速率全部返回 null；只提供
 *   runningRequests/waitingRequests/kvCacheUsagePercent=0 作为“无本地压力”
 *   的显式信号，使 classifyResource 判定为 NORMAL 而不是 UNKNOWN。
 */
import type {
    ResourceObservation,
    ResourceObservationSource,
    ResourceObserver,
    ResourceSnapshot,
} from "./resource-observer.ts";

export const EXTERNAL_MODEL_SERVICE_SOURCE: ResourceObservationSource =
    "EXTERNAL_MODEL_SERVICE";

export interface ExternalModelServiceResourceObserverOptions {
    readonly now?: () => Date;
    readonly createSnapshotId?: () => string;
}

export class ExternalModelServiceResourceObserver implements ResourceObserver {
    private readonly now: () => Date;
    private readonly createSnapshotId: () => string;

    constructor(options: ExternalModelServiceResourceObserverOptions = {}) {
        this.now = options.now ?? (() => new Date());
        this.createSnapshotId = options.createSnapshotId ?? (() => crypto.randomUUID());
    }

    observe(): Promise<ResourceObservation> {
        const observedAt = this.now().toISOString();
        const snapshot: ResourceSnapshot = {
            snapshotId: this.createSnapshotId(),
            observedAt,
            sources: [EXTERNAL_MODEL_SERVICE_SOURCE],
            gpuTotalMemoryMiB: null,
            gpuUsedMemoryMiB: null,
            gpuFreeMemoryMiB: null,
            gpuUtilizationPercent: null,
            runningRequests: 0,
            waitingRequests: 0,
            kvCacheUsagePercent: 0,
            inputTokensPerSecond: null,
            outputTokensPerSecond: null,
        };
        return Promise.resolve({ ok: true, snapshot });
    }
}
