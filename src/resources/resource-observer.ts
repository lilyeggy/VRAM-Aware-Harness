/**
 * 我们 day5 要做的是说明我们系统观察到的是什么
 * 这个文件做的是对资源事实的观察
 */

// 一个快照下，可以包含多个来源：vllm,nvidia-smi
export type ResourceObservationSource = 
    | "VLLM_METRICS"
    | "NVIDIA_SMI"
    | "FAKE";

// 当前资源情况
export interface ResourceSnapshot {
    snapshotId : string;
    observedAt : string;

    sources:readonly ResourceObservationSource[];

    // 考虑到下面的内容中可能来自不同来源，所以有些是null

    gpuTotalMemoryMiB : number | null;  // vllm Metrics 无法获取 nvidia-smi 可以获取
    gpuUsedMemoryMiB : number | null;   // vllm Metrics 无法获取 nvidia-smi 可以获取
    gpuFreeMemoryMiB:number | null;     // vllm Metrics 无法获取 nvidia-smi 可以获取
    gpuUtilizationPercent:number | null;    // vllm Metrics 无法获取 nvidia-smi 可以获取

    runningRequests : number | null;
    waitingRequests : number | null;

    kvCacheUsagePercent : number | null;    // 内部实现可以通过 usedKvBlocks/totalKvBlocks

    inputTokensPerSecond : number | null;
    outputTokensPerSecond : number | null;

}

// 增加对资源的观测失败类型
export type ResourceObservationFailureReason = 
    | "TIMEOUT"
    | "UNAVAILABLE"
    | "INVALID_RESPONSE";

// 定义对当前资源观测的成功和失败结果
export type ResourceObservation = 
    | {
        ok:true;
        snapshot: ResourceSnapshot;
    }
    | {
        ok : false;
        observedAt : string;
        attemptedSources: readonly ResourceObservationSource[];
        reason : ResourceObservationFailureReason;
        message : string;
    };

export interface ResourceObserver {
    observe() : Promise<ResourceObservation>;
}
