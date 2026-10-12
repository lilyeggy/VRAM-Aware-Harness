import gsap from "gsap";
import { CREATE_STEPS } from "./data.js";

const WHO = {
  host: { label: "宿主机代码", cls: "who-host" },
  kvm: { label: "Firecracker / KVM", cls: "who-kvm" },
  guest: { label: "虚拟机内部", cls: "who-guest" },
};

// 舞台上的"部件"：每一步会点亮哪些部件
const PARTS = {
  dir: { label: "私有目录 0700", x: 0.04, y: 0.04, w: 0.92, h: 0.92, color: "#2a3644" },
  kernel: { label: "kernel.bin", x: 0.10, y: 0.2, w: 0.26, h: 0.12, color: "#b28dff" },
  rootfs: { label: "rootfs.ext4", x: 0.10, y: 0.36, w: 0.26, h: 0.12, color: "#5ac8fa" },
  ws: { label: "workspace.ext4", x: 0.64, y: 0.36, w: 0.26, h: 0.12, color: "#ffb547" },
  jailer: { label: "jailer 笼子", x: 0.02, y: 0.02, w: 0.96, h: 0.96, color: "#b28dff", dashed: true },
  fc: { label: "Firecracker", x: 0.10, y: 0.6, w: 0.26, h: 0.16, color: "#b28dff" },
  vm: { label: "microVM", x: 0.64, y: 0.6, w: 0.26, h: 0.16, color: "#3ddc97" },
  vsock: { label: "vsock 5000", x: 0.30, y: 0.82, w: 0.40, h: 0.08, color: "#3ddc97" },
  pid: { label: "vm.pid", x: 0.64, y: 0.2, w: 0.26, h: 0.12, color: "#8b98a5" },

};

// 每一步亮起哪些部件（索引与 CREATE_STEPS 对齐）
const LIGHT = [
  [],                              // 0 检查环境
  ["dir"],                         // 1 分配身份
  ["kernel", "rootfs", "ws"],      // 2 准备材料
  ["jailer"],                      // 3 改属主
  ["fc"],                          // 4 启动 jailer → fc
  ["pid"],                         // 5 写 pidfile
  [],                              // 6 等 API socket
  ["vm"],                          // 7 插假硬件
  ["vm"],                          // 8 开机
  ["vm"],                          // 9 inittab
  ["vsock"],                       // 10 握手
  ["snap"],                        // 11 快照
];

export function mountCreation(root) {
  root.innerHTML = `
    <div class="cr-layout">
      <div class="cr-stage"><svg class="cr-svg" viewBox="0 0 1000 560" preserveAspectRatio="xMidYMid meet"></svg></div>
      <div class="cr-side">
        <ol class="cr-list"></ol>
        <div class="cr-detail"></div>
        <div class="cr-term"><div class="cr-term-head">Firecracker API / 通道日志</div><pre class="cr-log"></pre></div>
      </div>
    </div>
    <div class="cr-controls">
      <button data-act="prev">◀ 上一步</button>
      <button data-act="play" class="primary">▶ 播放</button>
      <button data-act="next">下一步 ▶</button>
      <input type="range" min="0" max="${CREATE_STEPS.length - 1}" value="0" class="cr-range" />
      <span class="cr-count"></span>
    </div>`;

  const svg = root.querySelector(".cr-svg");
  const list = root.querySelector(".cr-list");
  const detail = root.querySelector(".cr-detail");
  const log = root.querySelector(".cr-log");
  const range = root.querySelector(".cr-range");
  const count = root.querySelector(".cr-count");
  const playBtn = root.querySelector('[data-act="play"]');

  // 步骤列表
  CREATE_STEPS.forEach((s, i) => {
    const li = document.createElement("li");
    li.className = "cr-item";
    li.innerHTML = `<span class="n">${i + 1}</span><span class="t">${s.title}</span><span class="w ${WHO[s.who].cls}">${WHO[s.who].label}</span>`;
    li.addEventListener("click", () => go(i));
    list.appendChild(li);
  });

  // 舞台：SVG 节点
  const W = 1000, H = 560;
  const nodes = {};
  const defs = `
    <defs>
      <filter id="glow"><feGaussianBlur stdDeviation="4" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    </defs>`;
  svg.innerHTML = defs;
  Object.entries(PARTS).forEach(([key, p]) => {
    if (key === "snap") return;
    const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
    g.classList.add("part");
    const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    rect.setAttribute("x", p.x * W);
    rect.setAttribute("y", p.y * H);
    rect.setAttribute("width", p.w * W);
    rect.setAttribute("height", p.h * H);
    rect.setAttribute("rx", 14);
    rect.setAttribute("fill", "rgba(23,30,38,0.9)");
    rect.setAttribute("stroke", p.color);
    rect.setAttribute("stroke-width", 2);
    if (p.dashed) rect.setAttribute("stroke-dasharray", "10 8");
    g.appendChild(rect);
    const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
    text.setAttribute("x", (p.x + p.w / 2) * W);
    const labelY = key === "dir" ? (p.y + p.h) * H - 14 : p.dashed ? p.y * H + 26 : (p.y + p.h / 2) * H + 6;
    text.setAttribute("y", labelY);
    text.setAttribute("text-anchor", "middle");
    text.setAttribute("fill", "#e6edf3");
    text.setAttribute("font-size", p.dashed ? 18 : 20);
    text.textContent = p.label;
    g.appendChild(text);
    svg.appendChild(g);
    nodes[key] = { g, rect, p };
    gsap.set(g, { opacity: 0.12 });
  });

  // 快照：一个单独的"存档"标记
  const snapG = document.createElementNS("http://www.w3.org/2000/svg", "g");
  snapG.classList.add("part", "snap");
  snapG.innerHTML = `
    <rect x="${0.38 * W}" y="${0.34 * H}" width="${0.24 * W}" height="${0.16 * H}" rx="12" fill="rgba(23,30,38,0.9)" stroke="#ff6b6b" stroke-width="2"/>
    <text x="${0.5 * W}" y="${0.34 * H + 0.07 * H}" text-anchor="middle" fill="#e6edf3" font-size="18">vm.snap / mem.snap</text>
    <text x="${0.5 * W}" y="${0.34 * H + 0.12 * H}" text-anchor="middle" fill="#8b98a5" font-size="15">黄金快照（存档）</text>`;
  svg.appendChild(snapG);
  gsap.set(snapG, { opacity: 0.12 });
  nodes.snap = { g: snapG };

  let index = -1;
  let timer = null;

  function renderLog(i) {
    const s = CREATE_STEPS[i];
    const lines = [];
    CREATE_STEPS.slice(0, i + 1).forEach((st, k) => {
      if (st.api.length) {
        lines.push(`# 第 ${k + 1} 步 · ${st.title}`);
        st.api.forEach((a) => lines.push(a));
      }
    });
    log.textContent = lines.length ? lines.join("\n") : "（这一步在宿主机本地完成，没有对外请求）";
    return s;
  }

  function go(i) {
    if (i < 0 || i >= CREATE_STEPS.length) return;
    index = i;
    const s = CREATE_STEPS[i];

    // 列表高亮
    list.querySelectorAll(".cr-item").forEach((el, k) => {
      el.classList.toggle("on", k === i);
      el.classList.toggle("done", k < i);
    });
    // 只滚动列表容器，不能用 scrollIntoView（会带着整个页面一起滚）
    const item = list.children[i];
    if (item.offsetTop < list.scrollTop || item.offsetTop + item.offsetHeight > list.scrollTop + list.clientHeight) {
      list.scrollTo({ top: item.offsetTop - 60, behavior: "smooth" });
    }

    // 详情
    detail.innerHTML = `
      <div class="cr-step-title"><span class="w ${WHO[s.who].cls}">${WHO[s.who].label}</span><b>第 ${i + 1} 步：${s.title}</b></div>
      <p>${s.desc}</p>
      <p class="cr-where">代码：<code>${s.where}</code></p>`;

    // 舞台：点亮本步部件，其余保持淡化
    const lit = new Set(LIGHT[i]);
    const dimmed = (key) => {
      const n = nodes[key];
      const on = lit.has(key);
      // 之前亮过的保持半亮
      const isDone = CREATE_STEPS.slice(0, i + 1).some((_, k) => LIGHT[k].includes(key));
      gsap.to(n.g, { opacity: on ? 1 : isDone ? 0.55 : 0.12, duration: 0.5, ease: "power2.out" });
      if (n.rect) {
        n.rect.setAttribute("filter", on ? "url(#glow)" : "");
      }
    };
    Object.keys(nodes).forEach(dimmed);

    // 第 8 步之后，VM 高亮动画
    if (i === 8 || i === 9) {
      gsap.fromTo(nodes.vm.rect, { attr: { "stroke-width": 2 } }, { attr: { "stroke-width": 6 }, duration: 0.4, yoyo: true, repeat: 1 });
    }
    if (i === 10) {
      gsap.fromTo(nodes.vsock.rect, { attr: { "stroke-width": 2 } }, { attr: { "stroke-width": 6 }, duration: 0.4, yoyo: true, repeat: 2 });
    }
    // 销毁顺序提示由 data 内容承担

    renderLog(i);
    range.value = i;
    count.textContent = `${i + 1} / ${CREATE_STEPS.length}`;
  }

  function play() {
    if (timer) return stop();
    playBtn.textContent = "❚❚ 暂停";
    if (index >= CREATE_STEPS.length - 1) go(0);
    timer = setInterval(() => {
      if (index >= CREATE_STEPS.length - 1) return stop();
      go(index + 1);
    }, 2200);
  }
  function stop() {
    clearInterval(timer);
    timer = null;
    playBtn.textContent = "▶ 播放";
  }

  root.querySelector('[data-act="prev"]').addEventListener("click", () => { stop(); go(Math.max(0, index - 1)); });
  root.querySelector('[data-act="next"]').addEventListener("click", () => { stop(); go(Math.min(CREATE_STEPS.length - 1, index + 1)); });
  playBtn.addEventListener("click", play);
  range.addEventListener("input", () => { stop(); go(Number(range.value)); });

  go(0);
  return { go, stop };
}
