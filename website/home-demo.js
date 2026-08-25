(() => {
  const demo = document.getElementById("demo");
  const tryInteraction = document.getElementById("try-interaction");
  const controls = Object.fromEntries([...document.querySelectorAll("[data-rhythm-control]")]
    .map((input) => [input.dataset.rhythmControl, input]));
  const outputs = Object.fromEntries([...document.querySelectorAll("[data-rhythm-output]")]
    .map((output) => [output.dataset.rhythmOutput, output]));
  if (!demo || Object.keys(controls).length !== 5) return;

  const render = () => {
    const values = Object.fromEntries(Object.entries(controls)
      .map(([key, input]) => [key, Number(input.value)]));
    outputs.wpm.textContent = `${values.wpm} WPM`;
    outputs.delay.textContent = `${values.delay}s`;
    for (const key of ["typos", "pauses", "bursts"]) outputs[key].textContent = `${values[key]}%`;
    for (const input of Object.values(controls)) {
      const progress = ((Number(input.value) - Number(input.min)) /
        (Number(input.max) - Number(input.min))) * 100;
      input.style.setProperty("--fill", `${progress}%`);
    }
    demo.style.setProperty("--beat", `${Math.max(0.55, Math.min(1.55, 70 / values.wpm)).toFixed(2)}s`);
  };

  Object.values(controls).forEach((input) => input.addEventListener("input", render));
  tryInteraction?.addEventListener("click", (event) => {
    event.preventDefault();
    demo.scrollIntoView({ behavior: "smooth", block: "center" });
    demo.classList.remove("demo-attention");
    void demo.offsetWidth;
    demo.classList.add("demo-attention");
    window.setTimeout(() => controls.wpm.focus({ preventScroll: true }), 360);
  });
  render();
})();
