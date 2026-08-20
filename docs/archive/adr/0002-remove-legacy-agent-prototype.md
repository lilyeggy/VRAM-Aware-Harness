# ADR 0002：删除旧自研 Agent 原型

## 状态

已接受

## 背景

ADR 0001 已决定使用 Pi Coding Agent SDK 承担 Agent Loop、模型流、工具调用协议、Pi Session 历史和上下文压缩。仓库中仍并行保留自研 AgentLoop、内存 ContextManager、直接 vLLM Client、Output Validator、旧 System Prompt 和主动 KV lifecycle 实验。

并行保留会让源码入口、测试与学习路径继续表达两套相互竞争的 Agent Runtime 方案，并增加误用旧入口的风险。

## 决策

从当前工作树删除旧自研 Agent 原型及其对应测试：

- `src/harness/*`；
- `src/client/*`；
- `src/kv/*`；
- 仅服务旧原型的 `src/types/*`；
- 对应的顶层测试。

`src/index.ts` 改为只导出新的 Harness Runtime 抽象。Pi Spike、MVP 文档和 Git 历史继续保留。

## 后果

好处：

- 仓库只有一条 Agent 主路径；
- 后续模块不会误用自研 Agent Loop；
- 测试将围绕 AgentRuntime、PiAdapter、Run、Event、Tool、Checkpoint 和 Policy 建立。

限制：

- 旧实验不能再通过当前工作树直接运行；
- 若需比较旧算法，必须从 Git 历史读取或在独立实验分支恢复；
- 删除旧测试后，需要从 FakeAgentRuntime 合同测试开始重建 MVP 测试集。
