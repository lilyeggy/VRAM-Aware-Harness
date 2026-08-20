# ADR 0005：采用可替换模型与可扩展 vLLM 推理层

## 状态

已接受

## 背景

Harness 的核心价值是 Run 生命周期、工具治理、恢复、多租户资源准入和审计，
不是绑定某一个模型，也不是把模型能力作为项目正确性的前提。

当前实验室可用的单卡基线是 RTX A6000 48 GB。我们可以修改自己编译的 vLLM
源码，因此 vLLM 不是不可触碰的黑盒；但如果一开始就把 Harness 业务语义写进
vLLM Scheduler，控制面和推理层会形成难以测试、难以升级的强耦合。

为了加快 MVP，同时保留后续 Agent–Inference Co-scheduling 的研究空间，需要
明确当前模型、硬件和源码改造边界。

## 决策

1. Harness 领域模型和业务服务保持模型无关。模型 ID、Chat Template、Reasoning
   Parser、Tool Call Parser、量化方式和上下文长度属于部署配置，不能散落在
   RunService、ToolGateway 或 ExecutionPolicy 中。
2. 单卡 RTX A6000 48 GB 作为当前开发和验证硬件基线。
3. 使用 Qwen3.5-4B 进行高频开发和快速回归，使用 Qwen3.5-9B 进行主要集成验证。
   Fake Runtime 继续承担状态机、恢复、工具幂等和调度策略的确定性测试。
4. 初始真实模型测试将 `max-model-len` 控制在 16K；只有测试确实需要更长上下文
   时再提高到 32K。模型卡支持的理论最大上下文不是 Harness MVP 的目标。
5. 当前 Qwen3.5 vLLM 配置按官方模型卡使用兼容版本，并将模型相关参数留在启动
   配置中。当前验证参数为：

   ```text
   --reasoning-parser qwen3
   --enable-auto-tool-choice
   --tool-call-parser qwen3_coder
   ```

6. vLLM fork 允许修改，但按以下层级推进：
   - 第一层：标准 OpenAI-compatible API、usage 和 Metrics；
   - 第二层：增加 `tenantId`、`runId`、`traceId` 等请求归因和观测事件；
   - 第三层：在数据证明有收益后，再研究 priority、KV Events、offload 或
     Agent-aware scheduling。
7. 第一周 MVP 不依赖深度重写 vLLM Scheduler 或物理 KV Cache。必要的观测、
   请求归因和实验性 hint 可以进入 fork，但 Harness 仍负责业务状态、权限、
   恢复和准入，vLLM 仍负责 token 级推理执行。

## 不选择的方案

### 将项目绑定到 DeepSeek-V4-Flash

不选择。它会把单一模型的显存布局、稀疏注意力和部署 patch 变成 Harness 的
前置条件，减慢控制面 MVP。原有 DeepSeek 分析保留为未来大模型和 KV 研究材料，
不再代表当前开发基线。

### 只使用最小模型完成所有验证

不选择。4B 模型适合缩短开发反馈周期，但不能单独代表真实工具调用、上下文和
资源压力。9B 模型用于主要集成验证，两者承担不同职责。

### 因为可以修改 vLLM，就立即重写 Scheduler

不选择。源码权限只表示我们拥有扩展能力，不代表深度改造已经有收益证据。
先建立可重复的外部基线和请求归因，再由数据决定内部改造点。

## 后果

好处：

- 日常开发可以在单卡 A6000 上快速迭代；
- Harness 测试不依赖模型偶然输出，结果更稳定；
- 更换模型时主要修改部署配置，不需要重写控制面；
- vLLM fork 可以逐层增加观测和调度实验，而不破坏职责边界；
- 4B 与 9B 的双层验证兼顾反馈速度和真实集成可信度。

限制：

- 必须维护开发模型和验证模型的兼容性矩阵；
- 真实工具调用仍需验证 Chat Template、Parser 和 vLLM 版本组合；
- A6000 单卡结果不能直接代表多卡、MoE 或超长上下文部署；
- 进入 vLLM 内部调度研究前，仍需固定 fork commit、启动参数和性能基线。

## 参考

- [Qwen3.5-4B 模型卡](https://huggingface.co/Qwen/Qwen3.5-4B)
- [Qwen3.5-9B 模型卡](https://huggingface.co/Qwen/Qwen3.5-9B)
- [NVIDIA RTX A6000](https://www.nvidia.com/en-us/products/workstations/rtx-a6000/)
