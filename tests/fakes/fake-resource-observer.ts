/**
 * 必须观测当前资源情况
 */

import type {
    ResourceObservation,
    ResourceObserver,
} from "../../src/resources/resource-observer.ts";

// 保存当前观测结果
export class FakeResourceObserver implements ResourceObserver {
    observeCallCount = 0;
    constructor(
        private currentObservation:ResourceObservation,
    ) {}

    async observe(): Promise<ResourceObservation> {
        this.observeCallCount += 1;
        return this.currentObservation;
    }

    setObservation(
        observation : ResourceObservation,
    ): void {
        this.currentObservation = observation;
    }


}
