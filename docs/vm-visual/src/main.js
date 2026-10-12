import gsap from "gsap";
import { mountArchitecture } from "./architecture.js";
import { mountCreation } from "./creation.js";
import { mountChannel, mountStartup } from "./channel.js";
import { mountRings, mountWhyHard, mountVmxExit, mountMemory, mountDevices, mountKvm } from "./lessons.js";
import { DESTROY_STEPS } from "./data.js";

// 第一部分：底层六章
mountRings(document.getElementById("lesson-rings"));
mountWhyHard(document.getElementById("lesson-why"));
mountVmxExit(document.getElementById("lesson-vmx"));
mountMemory(document.getElementById("lesson-mem"));
mountDevices(document.getElementById("lesson-dev"));
mountKvm(document.getElementById("lesson-kvm"));

// 第三部分：生命周期
mountCreation(document.getElementById("creation"));
mountChannel(document.getElementById("channel"));
mountStartup(document.getElementById("startup"));
document.getElementById("destroy").innerHTML = `<h3 class="sub">销毁顺序：先停、再导出、最后删除</h3><div class="destroy-grid">` +
  DESTROY_STEPS.map((s, i) => `<div class="ds"><div class="ds-n">${i + 1}</div><b>${s.title}</b><p>${s.desc}</p></div>`).join("") + `</div>`;

// 附：模块总览
mountArchitecture(document.getElementById("arch"), document.getElementById("arch-detail"));

// 章节淡入
const io = new IntersectionObserver((entries) => {
  entries.forEach((e) => {
    if (e.isIntersecting) {
      gsap.fromTo(e.target, { y: 18, opacity: 0 }, { y: 0, opacity: 1, duration: 0.6, ease: "power3.out" });
      io.unobserve(e.target);
    }
  });
}, { threshold: 0.1 });
document.querySelectorAll(".chapter, .card-block, .sec-head").forEach((el) => io.observe(el));

// 顶部进度条
const bar = document.querySelector(".progress");
window.addEventListener("scroll", () => {
  const h = document.documentElement.scrollHeight - innerHeight;
  bar.style.transform = `scaleX(${h > 0 ? scrollY / h : 0})`;
}, { passive: true });
