/**
 * 这个文件做的是分析当前资源情况
 */

import type {
    ResourceSnapshot,
}   from "./resource-observer.ts";

// 定义资源压力分类结果
export type ResourcePressure = 
    | "NORMAL"
    | "BUSY"
    | "CRITICAL"
    | "UNKNOWN";
// 允许部分指标为 null；只有所有压力信号都不可用时才算 UNKNOWN。

// 这个资源是能够解释上面结果的
// 比如 为什么是“BUSY” ？ -> 因为 KV_CACHE_BUSY
export type ResourcePressureReason = 
    | "WITHIN_THRESHOLDS"
    | "INSUFFICIENT_DATA"
    | "GPU_MEMORY_BUSY"
    | "GPU_MEMORY_CRITICAL"
    | "KV_CACHE_BUSY"
    | "KV_CACHE_CRITICAL"
    | "RUNNING_REQUESTS_BUSY"
    | "RUNNING_REQUESTS_CRITICAL"
    | "WAITING_REQUESTS_BUSY"
    | "WAITING_REQUESTS_CRITICAL";

// 定义配置化阈值
// 达到什么程度对应上面的情况
export interface ResourceThresholds {
    busyGpuMemoryPercent : number;
    criticalGpuMemoryPercent : number;

    busyKvCachePercent : number;
    criticalKvCachePercent : number;

    busyRunningRequests : number;
    criticalRunningRequests : number;

    busyWaitingRequests : number;
    criticalWaitingRequests : number;

    /**
     * N5：同机推理服务的「稳态预分配基线」（占整卡百分比）。
     *
     * vLLM 之类框架默认 `--gpu-memory-utilization 0.9`，启动即把约 90% 显存
     * 一次占满（其中大部分是 KV cache 空池）。若直接拿「显存已用比例」做准入，
     * 平台只看自己的模型服务就会长期判 CRITICAL，把所有 Run 无差别排队到 TTL
     * 熔断——真机上 13 字符的小任务也被排掉。
     *
     * 设定基线后，显存压力按「基线之上的增量」度量：
     *   adjusted = (used% - baseline) / (100 - baseline) * 100
     * 基线内是预期稳态，不构成压力；基线之上才按 BUSY/CRITICAL 阈值判定。
     * 未配置（undefined/0）= 旧行为（按原始已用比例判定）。
     * 无同机推理服务的部署应设为 0。
     */
    gpuMemoryBaselinePercent? : number;
}

// 定义输出结构
export interface ResourceClassification {
    snapshotId:string;
    pressure:ResourcePressure;
    reasons:readonly ResourcePressureReason[];

    /** 原始「显存已用 / 总显存」比例（观测事实，不因基线配置而变化）。 */
    gpuMemoryUsagePercent:number | null;

    /**
     * N5：扣掉同机推理服务稳态基线之后的「增量压力」比例，准入真正看的就是它。
     * 未配置基线时与 gpuMemoryUsagePercent 相等（旧行为）。
     */
    gpuMemoryPressurePercent:number | null;
}

// 计算显存比例
function calculateGpuMemoryUsagePercent (
    snapshot : ResourceSnapshot,
)   : number | null {
    if (
        snapshot.gpuTotalMemoryMiB === null ||
        snapshot.gpuUsedMemoryMiB === null ||
        snapshot.gpuTotalMemoryMiB <= 0
    ){
        return null;
    }

    return (snapshot.gpuUsedMemoryMiB / snapshot.gpuTotalMemoryMiB ) * 100
    
}

/**
 * N5：把「已用比例」折算成「基线之上的增量压力比例」。
 * baseline <= 0 或 >= 100 时退化为原值（不做度量变换）。
 */
function calculateGpuMemoryPressurePercent (
    usagePercent : number | null,
    baselinePercent : number | undefined,
)   : number | null {
    if (usagePercent === null) {
        return null;
    }
    const baseline = baselinePercent;
    if (
        baseline === undefined ||
        baseline <= 0 ||
        baseline >= 100
    ) {
        return usagePercent;
    }
    const headroom = 100 - baseline;
    const delta = Math.max(0, usagePercent - baseline);
    return (delta / headroom) * 100;
}

// 定义分类函数框架
export function classifyResource(
    snapshot:ResourceSnapshot,
    thresholds:ResourceThresholds,
):ResourceClassification {
    const reasons : ResourcePressureReason[] = [];

    const gpuMemoryUsagePercent = 
    calculateGpuMemoryUsagePercent(snapshot);

    // N5：准入判定用「基线之上的增量」，观测事实仍原样保留 usage。
    const gpuMemoryPressurePercent = calculateGpuMemoryPressurePercent(
        gpuMemoryUsagePercent,
        thresholds.gpuMemoryBaselinePercent,
    );

    // 先判断是否有可用数据
    const hasUsableSignal = 
        gpuMemoryUsagePercent !== null || 
        snapshot.kvCacheUsagePercent !== null ||
        snapshot.runningRequests !== null ||
        snapshot.waitingRequests !== null;
    
    if (!hasUsableSignal){
        return {
            snapshotId:snapshot.snapshotId,
            pressure:"UNKNOWN",
            reasons:["INSUFFICIENT_DATA"],
            gpuMemoryUsagePercent,
            gpuMemoryPressurePercent,
        };
    }

    // GPU Memory 情况判断
    if (gpuMemoryPressurePercent !== null) {
        if (
            gpuMemoryPressurePercent >= thresholds.criticalGpuMemoryPercent
        )   {
            reasons.push("GPU_MEMORY_CRITICAL");
        }   else if (
            gpuMemoryPressurePercent >= thresholds.busyGpuMemoryPercent
        )   {
            reasons.push("GPU_MEMORY_BUSY");
        }
    }

    if (snapshot.kvCacheUsagePercent !== null){
        if (
            snapshot.kvCacheUsagePercent >= thresholds.criticalKvCachePercent
        )   {
            reasons.push("KV_CACHE_CRITICAL");
        }   else if (
            snapshot.kvCacheUsagePercent >= thresholds.busyKvCachePercent
        )   {
            reasons.push("KV_CACHE_BUSY");
        }
    }

    if (snapshot.runningRequests !== null) {
        if (
            snapshot.runningRequests >= thresholds.criticalRunningRequests
        )   {
            reasons.push("RUNNING_REQUESTS_CRITICAL");
        }   else if (
            snapshot.runningRequests >= thresholds.busyRunningRequests
        )   {
            reasons.push("RUNNING_REQUESTS_BUSY");
        }
    }

    if (snapshot.waitingRequests !== null) {
        if (
            snapshot.waitingRequests >= thresholds.criticalWaitingRequests
        )   {
            reasons.push("WAITING_REQUESTS_CRITICAL");
        }   else if (
            snapshot.waitingRequests >= thresholds.busyWaitingRequests
        )   {
            reasons.push("WAITING_REQUESTS_BUSY");
        }
    }

    const hasCriticalReason = reasons.some((reason) => 
        reason.endsWith("_CRITICAL")
    );

    if (hasCriticalReason) {
        return {
            snapshotId:snapshot.snapshotId,
            pressure:"CRITICAL",
            reasons,
            gpuMemoryUsagePercent,
            gpuMemoryPressurePercent,
        }
    }

    const hasBusyReason = reasons.some((reason) => 
        reason.endsWith("_BUSY")
    );

    if (hasBusyReason){
        return {
            snapshotId:snapshot.snapshotId,
            pressure:"BUSY",
            reasons,
            gpuMemoryUsagePercent,
            gpuMemoryPressurePercent,
        }
    }
    

    return {
        snapshotId:snapshot.snapshotId,
        pressure:"NORMAL",
        reasons:["WITHIN_THRESHOLDS"],
        gpuMemoryUsagePercent,
        gpuMemoryPressurePercent,
    };
}
