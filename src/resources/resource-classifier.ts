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
}

// 定义输出结构
export interface ResourceClassification {
    snapshotId:string;
    pressure:ResourcePressure;
    reasons:readonly ResourcePressureReason[];

    gpuMemoryUsagePercent:number | null;
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

// 定义分类函数框架
export function classifyResource(
    snapshot:ResourceSnapshot,
    thresholds:ResourceThresholds,
):ResourceClassification {
    const reasons : ResourcePressureReason[] = [];

    const gpuMemoryUsagePercent = 
    calculateGpuMemoryUsagePercent(snapshot);

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
        };
    }

    // GPU Memory 情况判断
    if (gpuMemoryUsagePercent !== null) {
        if (
            gpuMemoryUsagePercent >= thresholds.criticalGpuMemoryPercent
        )   {
            reasons.push("GPU_MEMORY_CRITICAL");
        }   else if (
            gpuMemoryUsagePercent >= thresholds.busyGpuMemoryPercent
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
        }
    }
    

    return {
        snapshotId:snapshot.snapshotId,
        pressure:"NORMAL",
        reasons:["WITHIN_THRESHOLDS"],
        gpuMemoryUsagePercent,
    };
}
