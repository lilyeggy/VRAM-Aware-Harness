# 面试深挖网页 · 深化方案（基于中国大厂 Agent Infra 真题调研）

> 调研日期：2026-08-22 · 方案状态：**已确认实施（P0+P1，M11 跳过）**
> 实施记录：新增模块 10-14 已完成；_base 导航、M08/M09 衔接已升级；M13 框架细节已经 OpenClaw 官方 README 与仓库内架构图谱二次核实。
> 现状：`docs/interview-deep-dive/index.html` 已有 9 个模块（项目本体深挖）。
> 本方案回答一个问题：**对照中国大厂 2026 秋招 Agent Infra 岗位的真实考法，这 9 个模块缺什么、补什么、怎么补。**

---

## 一、调研来源（真实面经，可核查）

| # | 来源 | 内容 |
|---|---|---|
| A | 知乎《AI infra 26秋招面经》（zhuanlan.zhihu.com/p/2017740483217081305） | 百度/字节/阿里云PAI/京东/快手/蚂蚁/同花顺/地平线/DeepSeek/上海AI Lab 的逐轮真题 |
| B | 卡码笔记《字节Agent开发四面面经：21道题》（notes.kamacoder.com/interview/llm/20260506bytedance.html） | 字节 Agent 开发岗四面全记录 + 备考心得 |
| C | 卡码笔记《Harness Engineering大厂面试题汇总》及姊妹篇（harness_interview / agent_harness_observability_interview / multi_agent_harness_interview 等） | 业界 Harness 六层组件框架、可观测性九问、生产级 Agent 全景 |
| D | 知乎《Shopee大模型二面：如何设计一个 LLM Gateway？》 | 系统设计题完整评分点 |
| E | 腾讯云开发者/技术博客的多篇《多租户 Agent 沙箱架构》文章 | 云端大规模 Agent 沙箱：隔离/持久化/弹性调度/Sticky 会话/资源配额 |

---

## 二、大厂考点全景（从真题中提炼）

### 2.1 推理引擎层（出现频率最高，AI Infra 绝对核心）
- PD 分离（Prefill-Decode Decoupling）：必要性、不分时的资源干扰（百度二面）
- KV Cache：传输优化、命中率优化、Tree 结构管理、**分布式 KV Cache 架构**（快手三面）
- PagedAttention：多 Request 不同 Seq Length 场景的处理机制（同花顺一面）
- **vLLM Scheduler 抢占策略的源码位置**（同花顺二面——直接问源码！）
- Continuous Batching 原理；长序列 Decode 优化（蚂蚁二面）
- 量化：FP8 与 INT8 KV Cache 量化**并存的原因**（阿里 PAI 二面）；INT8 收益理论 vs 实际（快手二面）
- MoE 的 EP（Expert Parallelism）对推理吞吐的影响；长文本的计算通信掩盖

### 2.2 CUDA / GPU 底层（芯片与异构岗门槛陡增）
- Roofline Model；GEMM 优化（Split-K/Stream-K、Swizzle、L2 命中率）
- Bank Conflict、Warp Specialization、WGMMA vs MMA 指令
- 手写 Kernel：RMSNorm、Prefix Sum、Attention（京东/快手真题）
- FlashAttention3 / FlashMLA 架构异同；NCU 性能分析 Bound 指标识别
- Double Buffer；低比特（低于 FP8）精度研究

### 2.3 RL / 训练 Infra（蚂蚁、快手都在问）
- 强化学习训练框架与训练崩溃原因；采样瓶颈分析
- 长尾负载不均（短 Prompt 长输出无法序列并行）；KV Cache 的 Routing 与 Replay

### 2.4 Agent 应用层八股（Agent 开发岗标配，来源 B 全部 21 题分六组）
- Prompt：Engineering 核心目标、System Prompt/Few-shot/CoT 分工、Token/上下文窗口/**上下文腐化（Lost in the Middle）**
- 输出控制：幻觉产生与五板斧减轻、Structured Output（JSON Schema）、**Function Calling vs RAG 选型**、混合检索/RRF/HyDE/Chunk 策略
- Agent 设计：主子 Agent 通信链路与异常、上下文漂移、MCP 与 Skill 的作用
- 训练常识：SFT vs RLHF 适用场景、微调 vs RAG 选型、降推理成本
- 记忆管理：有限窗口内放关键内容、短期/长期记忆压缩、**混合路由与限流器在多 Agent 系统中为什么重要**

### 2.5 Harness / 生产化方法论（新兴高频，来源 C）
- "你怎么理解 Harness Engineering？""Agent = Model + Harness 怎么理解？"（有人当场愣住的真题）
- Harness 六层组件：上下文精细化 / 工具系统 / 执行编排（Loop Engineering）/ 记忆与状态 / 评估观测（Eval+Trace）/ 约束恢复
- Mitchell Hashimoto《My AI Adoption Journey》与 OpenAI《Harness engineering》的概念出处
- 可观测性九问：Trace 该记什么、长链路怎么发现跑偏、**工具出错时怎么归因（模型错/参数错/工具错）**、成本失控监控哪些指标、失败样本怎么沉淀成改进
- 框架横评：**OpenClaw / Hermes / Claude Code 要能撑住 5 分钟对比**（记忆机制、工具调用、上下文管理），CC 的 hook 实现细节是加分项

### 2.6 系统设计题（二面/三面主菜）
- **"设计一个 LLM Gateway"**（Shopee 真题）评分点：能力/成本/延迟/语义四种路由策略、四级 Fallback（同模型重试→跨 Provider→跨模型等级降级→兜底）、加权与 token 吞吐量负载均衡、统一协议适配、语义缓存、可观测性、开源方案对比（LiteLLM/RouteLLM/Portkey）
- "设计一个完整的训练/推理任务平台流程"（百度四面）
- 云端大规模 Agent 沙箱：多租户隔离、持久化、弹性调度、Sticky 会话、资源配额（来源 E）

### 2.7 备考元信息（来源 B 心得，值得单独一屏）
- 大厂 Agent 岗期望"全栈"：模型（LLM/VLM）+ 训练/推理/RL 常识都要有
- 名词不能只会念：Skills/MCP/CLI 要往深了搞明白；Harness 概念一定要清楚
- 主动展示：被问记忆机制时先答自己项目实现，再主动对比三个流行框架
- 字节真实流程：4.5 一面 → 4.18 四面（转岗加面）→ 4.25 offer；三面挂了会被主动转岗

---

## 三、Gap 分析：现有 9 模块 vs 考点矩阵

| 考点域 | 大厂频率 | 现有覆盖 | 缺口判定 |
|---|---|---|---|
| 控制面/调度/准入/恢复 | 中（差异化深度） | ★★★★★ Module 3/4/5 | 已超额，保持 |
| 多租户/沙箱/安全 | 高（来源 E 热点） | ★★★★☆ Module 6/7 | 可加 Sticky 会话/资源配额对比视角 |
| Eval/可观测/网关 | 高 | ★★★★☆ Module 8 | 缺 Trace 归因方法论与成本治理话语 |
| **推理引擎原理（vLLM 内部）** | **最高** | ☆ 仅 metrics 解析 | **重大缺口 → 新增模块** |
| **CUDA/GPU 底层** | 高（异构岗必考） | 无 | **缺口 → 新增速答卡模块** |
| **Harness 方法论话语体系** | 快速上升（来源 C） | 有实质无话语 | **缺口 → 新增映射模块** |
| **框架横评（CC/Hermes/OpenClaw）** | 高（来源 B 明示） | 无 | **缺口 → 新增模块** |
| **系统设计题实战** | 二三面主菜 | 无 | **缺口 → 新增工坊模块** |
| RAG/幻觉/Prompt 八股 | Agent 岗标配 | 无 | 缺口 → 新增补充包 |
| 后端分布式一致性映射 | 后端面试官视角 | 有实质无翻译 | 小缺口 → 术语映射表 |
| 行为面/HR 面 | 必有 | 无 | 可选 → 并入弹药库 |

**结论：项目本体的深度已经足够独特（这正是差异化），但"向上够得到业界话语体系、向下接得住推理引擎原理"的两层都缺。大厂面试官的典型路径是：听你讲控制面 → 用业界词汇验证你（Harness 六层/框架横评）→ 往下钻一层验证你懂依赖（vLLM 原理）→ 出一道系统设计题看迁移能力。四段中我们只有第一段。**

---

## 四、新增模块设计（7 个候选）

### M10 · 推理引擎原理（Harness 视角看 vLLM）【P0】
- **教学目标**：被问"你天天调 vLLM，它内部怎么工作"时能讲 10 分钟，并能精确回答"为什么 Harness 不接管 token 调度"（ADR 0005 的论证升级版）。
- **内容大纲**：
  1. 一次请求的一生：Tokenizer → Prefill → Decode → Detokenize（flow 动画）
  2. KV Cache 生命周期与显存账本（呼应项目 ResourceSnapshot 的 kvCacheUsagePercent 到底在量什么）
  3. PagedAttention：逻辑块/物理块/块表，类比虚拟内存分页（互动图）
  4. Continuous Batching vs static batching（对比动画）
  5. Scheduler 抢占（Recompute/Preemption 模式）——同花顺真题"抢占策略源码位置"的答法：scheduler.py 的 schedule()/_preempt_by_recompute/_preempt_by_swapped，配合项目"我们不改 Scheduler 只读 metrics"的边界论述
  6. PD 分离：为什么要分、干扰是什么、XpYd 记法（百度真题）
  7. 量化：FP8 vs INT8 KV Cache 并存原因（阿里真题）——精度/吞吐/兼容三角
  8. 项目连接：VllmResourceObserver 读的每个指标对应引擎内部哪个状态；gpu_cache_usage_perc 改名事件正是"跟着上游演进"的证据
- **素材**：来源 A 真题、项目 vllm-resource-observer.ts 注释、ADR 0005

### M11 · GPU 与算力底座速答卡【P2】
- **教学目标**：非 CUDA 专家也能扛住两层追问。
- **内容大纲**：Roofline 一页图；显存带宽 vs 算力的瓶颈判断口诀；GEMM 优化三板斧（tiling/swizzle/split-k）卡片；FlashAttention 为什么快（IO-aware，少读写 HBM）；FP16/BF16/FP8/INT8 表格；手写 RMSNorm 的伪代码思路（京东真题的最低准备线）
- **形式**：数字卡 + 翻转问答，不做长篇

### M12 · Harness Engineering 话语映射【P0】★最重要
- **教学目标**："把项目的实质翻译成面试官的业界词汇"——听到"Harness 六层""Loop Engineering"不再愣住，并能反客为主。
- **内容大纲**：
  1. 三次重心转移叙事：Prompt → Context → Harness（来源 C 的框架）
  2. **六层组件 ↔ 本项目逐层映射表**（本模块主视觉）：
     - 上下文精细化 ↔ Pi 会话句柄 + §14 定稿设计（压缩归 Pi）
     - 工具系统 ↔ ToolGateway + 策略守卫
     - 执行编排 ↔ Run 状态机 + Loop 由 Pi 提供（Loop Engineering 对照）
     - 记忆与状态 ↔ Checkpoint/RunEvent/状态外化到 SQLite
     - 评估观测 ↔ Eval 聚合 + Observe 页 + RunEvent 时间线（对照可观测性九问逐条自评）
     - 约束恢复 ↔ fail-closed 四条线 + RecoveryService
  3. Mitchell Hashimoto 复利效应 ↔ 项目"每次踩坑沉淀为 CHECK 约束/migration/测试"的演进史（举 migration v4/v15 为例）
  4. 概念出处速答：Mitchell 博客 2026-02-05 → OpenAI 背书文 → Agent = Model + Harness
  5. 差异化反杀话术："业界六层大多停在方法论，我把其中'约束与恢复'和'评估观测'两层做成了带数据库约束的真系统"
- **素材**：来源 C 全部、项目 handbook §13

### M13 · 框架横评与生态坐标【P1】
- **教学目标**："OpenClaw/Hermes/Claude Code 撑住五分钟"（来源 B 原话），并回答"为什么不用 LangChain/Dify 而自建"。
- **内容大纲**：对比矩阵（记忆机制/上下文管理/工具调用/沙箱/扩展点）× Claude Code、Hermes、OpenClaw、OpenHands、LangGraph、Dify；CC hook 机制一句话原理；Pi SDK 在坐标系的位置；选型论述三段论
- **注意**：需二次核实各框架细节（实施时再抓取一手文档）

### M14 · 系统设计题实战工坊【P0】
- **教学目标**：二三面的系统设计环节有固定打法。
- **内容大纲**：
  1. 万能四步法：需求澄清 → 容量估算 → 分层架构 → 深挖权衡（每步时间盒）
  2. **真题全真演练①：设计一个多租户 Agent 任务平台**——就是本项目，但练习"白板从零推一遍"：QPS 估算→对象模型→调度→隔离→故障→演进；附"面试官追问树"
  3. **真题全真演练②：设计一个 LLM Gateway**（Shopee 评分点全覆盖）——对照自己 C 方向实现逐项打分：✅主备回退/熔断/决策记录 ⚠️语义缓存 ❌语义路由 ❌token 吞吐均衡 ❌跨模型等级降级——把差距变成"下一步规划"话术
  4. 沙箱设计题要点（来源 E）：Sticky 会话 vs 冷启动、持久化卷、弹性伸缩、配额
- **形式**：step-cards + 打分卡互动

### M15 · 应用层八股补充包【P1】
- **教学目标**：Agent 岗标配题不失分，每题都桥接回项目。
- **内容大纲**（每题 = 标准答案 + "结合本项目怎么说"桥接）：
  - Function Calling vs RAG 选型 → 桥接：项目工具治理即 FC 的安全壳
  - 幻觉五板斧 → 桥接：结构化输出/审计/fail-closed 是工程侧幻觉兜底
  - 上下文腐化/Lost in the Middle → 桥接：Pi 压缩归 Pi 的会话设计
  - 检索策略（混合检索/RRF/HyDE/Chunk）→ 承认项目未涉及，展示知识面
  - SFT vs RLHF、微调 vs RAG → 一页常识卡
- **形式**：Q&A 翻转卡为主，控制篇幅

### M16 · 后端一致性术语映射表【P2】
- **教学目标**：面对后端背景面试官，把项目机制翻译成标准八股词。
- **内容大纲**：乐观锁↔CAS/版本号、双复写↔WAL/2PC 意图日志、dedupe_key↔at-least-once+幂等键、single-flight↔Go singleflight、404 反枚举↔BLP 不可区分原则、TOCTOU↔check-act 竞态、限流算法对比（令牌桶/漏桶/滑动窗口）↔网关下一步

### M17（可选）· 行为面与流程攻略【P2】
- 字节式流程复盘（来源 B：转岗加面故事）、STAR 叙事对齐、"骑驴找马"节奏、反问库扩充

---

## 五、现有模块升级点

| 模块 | 升级内容 |
|---|---|
| M01 定位 | 加"2026 秋招考察趋势五点"雷达卡（来源 A 总结：推理优化绝对核心/CUDA 门槛提高/MoE 与长文本/国产芯片/业务驱动选型） |
| M08 网关 | 补 Shopee 评分点打分卡（✅⚠️❌ 清单），把诚实边界变成 roadmap 话术 |
| M09 弹药库 | 扩容真题速答：vLLM 抢占源码位置、FP8/INT8 并存、PD 分离必要性、主子 Agent 通信异常、成本失控监控指标、Trace 归因三步法 |
| 全局 quiz | 每模块加 1 题"大厂变体问法"（同一知识点的大厂包装方式） |

---

## 六、实施计划（待确认后执行）

| 批次 | 内容 | 形式 | 预估体量 |
|---|---|---|---|
| **P0**（第一轮） | M12 话语映射 + M10 vLLM 原理 + M14 系统设计工坊 + 全局导航更新 | 3 个新模块 + 3 处升级 | ~60KB HTML |
| **P1**（第二轮） | M13 框架横评 + M15 八股补充包 + M09 弹药库扩容 | 2 个新模块 + 1 处升级 | ~40KB |
| **P2**（第三轮，可选） | M11 GPU 速答卡 + M16 术语映射 + M17 行为面 | 2-3 个轻模块 | ~25KB |

实施方式沿用本次：briefs（含预提取片段与真题）→ 并行子代理写作 → build.sh 组装 → 自动校验（ID 冲突/JSON/quiz 配线/标签闭合）。

---

## 七、风险与注意

1. **框架细节时效性**：M13 涉及 Claude Code/Hermes/OpenClaw 的机制细节，实施时需再抓一手文档核实，避免背错被内行戳穿。
2. **不要过度堆砌**：新增模块全部服务于"面试官追问链"，凡不能帮用户多拿分的砍掉。
3. **诚实边界纪律延续**：vLLM/CUDA 模块定位必须是"懂依赖的使用者"，绝不能暗示"改过内核"；这与项目 ADR 0005 的口径一致。
