# ADR 0001：使用 Pi 作为 Agent Runtime

## 状态

已接受

## 背景

当前项目已经有自研的 AgentLoop。
它会调用模型、识别工具调用、执行工具，并把工具结果再次交给模型。

本项目的新目标是构建 Resource-Aware Agent Harness：
它需要记录每一次任务、保存事件、支持恢复、根据 GPU 状态排队，
而不是继续维护模型和工具之间的循环细节。

## 决策

使用 Pi Coding Agent SDK 作为 Agent Runtime。
Pi SDK 固定为 @earendil-works/pi-coding-agent@0.80.10。

Harness 自己负责：
- AgentRun 生命周期；
- 事件持久化；
- 工具执行治理；
- Checkpoint 与恢复；
- GPU 资源观测；
- 并发和公平队列。

Pi 负责：
- Agent Loop；
- 模型流式输出；
- 工具调用协议；
- Pi Session 历史；
- 上下文压缩。

Day 1 的 Pi Session 仅用于 Spike 验证。后续 Harness 使用 SQLite 持久化自己的 `AgentRun`；Pi Session 只会作为运行时会话引用或 Checkpoint 的一部分，而不是替代 `AgentRun`。

## 不选择的方案

### 继续扩展现有 AgentLoop

不选择，因为会继续由本项目维护模型—工具循环，
并增加流式处理、上下文管理和工具协议的维护成本。

### Fork Pi

不选择，因为第一周 MVP 不需要修改 Pi 内部实现；
Fork 会带来版本同步和维护负担。

## 后果

好处：
- Harness 与 Agent Runtime 解耦；
- 未来可用别的 Runtime 替换 Pi；
- 项目能把精力放在可观测性、恢复和资源控制。

限制：
- 需要适配 Pi 的事件和 Session 概念；
- 需要固定并维护 Pi SDK 版本 `0.80.10`。
