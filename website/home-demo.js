(() => {
  const demo = document.getElementById("demo");
  const tryInteraction = document.getElementById("try-interaction");
  const replay = document.querySelector("[data-demo-replay]");
  const demoText = document.querySelector("[data-demo-text]");
  const demoStatus = document.querySelector("[data-demo-status]");
  const demoProgress = document.querySelector("[data-demo-progress]");
  const controls = Object.fromEntries([...document.querySelectorAll("[data-rhythm-control]")]
    .map((input) => [input.dataset.rhythmControl, input]));
  const outputs = Object.fromEntries([...document.querySelectorAll("[data-rhythm-output]")]
    .map((output) => [output.dataset.rhythmOutput, output]));
  if (!demo || !demoText || !demoStatus || !demoProgress || Object.keys(controls).length !== 5) return;

  const targetText = "Drip Type types your words naturally into any app.";
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  let runNumber = 0;
  let replayTimer = 0;
  let restartTimer = 0;
  let enteredViewport = false;

  const readValues = () => Object.fromEntries(Object.entries(controls)
    .map(([key, input]) => [key, Number(input.value)]));

  const renderControls = () => {
    const values = readValues();
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

  const paintText = (text) => {
    demoText.textContent = text;
    demoProgress.style.width = `${Math.min(100, (text.length / targetText.length) * 100)}%`;
  };

  const wait = (milliseconds, token) => new Promise((resolve) => {
    window.setTimeout(() => resolve(token === runNumber), milliseconds);
  });

  const typeCharacters = async (startingText, addition, values, token, pace = 1) => {
    let text = startingText;
    const baseDelay = 60000 / (Math.max(15, values.wpm) * 5);
    for (let index = 0; index < addition.length; index += 1) {
      const character = addition[index];
      const variation = 1 + (((index % 5) - 2) * 0.045);
      const punctuationPause = /[,.!?]/u.test(character) ? 1.65 : character === " " ? 0.72 : 1;
      if (!await wait(baseDelay * variation * punctuationPause * pace, token)) return null;
      text += character;
      paintText(text);
    }
    return text;
  };

  const eraseCharacters = async (startingText, count, values, token) => {
    let text = startingText;
    const eraseDelay = Math.max(55, 18000 / Math.max(15, values.wpm));
    for (let index = 0; index < count; index += 1) {
      if (!await wait(eraseDelay, token)) return null;
      text = text.slice(0, -1);
      paintText(text);
    }
    return text;
  };

  const runDemo = async () => {
    window.clearTimeout(replayTimer);
    const token = ++runNumber;
    const values = readValues();
    demo.classList.remove("is-typing", "is-correcting");

    if (reducedMotion.matches) {
      paintText(targetText);
      demoStatus.textContent = "Preview ready";
      return;
    }

    paintText("");
    for (let remaining = values.delay; remaining > 0; remaining -= 1) {
      demoStatus.textContent = `Starting in ${remaining}s`;
      if (!await wait(1000, token)) return;
    }

    demo.classList.add("is-typing");
    demoStatus.textContent = `${values.wpm} WPM · typing`;
    let text = await typeCharacters("", "Drip Type types your words ", values, token);
    if (text === null) return;

    if (values.pauses > 0) {
      demoStatus.textContent = "Thinking pause";
      if (!await wait(320 + (values.pauses * 38), token)) return;
      demoStatus.textContent = `${values.wpm} WPM · typing`;
    }

    if (values.typos > 0) {
      text = await typeCharacters(text, "naturak", values, token);
      if (text === null) return;
      demo.classList.add("is-correcting");
      demoStatus.textContent = "Correcting a typo";
      if (!await wait(240 + (values.typos * 24), token)) return;
      text = await eraseCharacters(text, 1, values, token);
      if (text === null) return;
      demo.classList.remove("is-correcting");
      text = await typeCharacters(text, "lly", values, token);
    } else {
      text = await typeCharacters(text, "naturally", values, token);
    }
    if (text === null) return;

    const burstPace = values.bursts > 0 ? Math.max(0.52, 1 - (values.bursts / 55)) : 1;
    if (values.bursts > 0) demoStatus.textContent = "Brief speed burst";
    text = await typeCharacters(text, " into any app.", values, token, burstPace);
    if (text === null) return;

    demo.classList.remove("is-typing");
    demoStatus.textContent = "Typed into the active field";
    demoProgress.style.width = "100%";
    replayTimer = window.setTimeout(() => {
      if (!document.hidden && token === runNumber) runDemo();
    }, 2800);
  };

  const restartDemo = () => {
    window.clearTimeout(restartTimer);
    restartTimer = window.setTimeout(runDemo, 260);
  };

  Object.values(controls).forEach((input) => input.addEventListener("input", () => {
    renderControls();
    restartDemo();
  }));

  replay?.addEventListener("click", runDemo);
  tryInteraction?.addEventListener("click", (event) => {
    event.preventDefault();
    demo.scrollIntoView({ behavior: reducedMotion.matches ? "auto" : "smooth", block: "center" });
    demo.classList.remove("demo-attention");
    void demo.offsetWidth;
    demo.classList.add("demo-attention");
    window.setTimeout(runDemo, reducedMotion.matches ? 0 : 420);
  });

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      runNumber += 1;
      window.clearTimeout(replayTimer);
    } else if (enteredViewport) {
      runDemo();
    }
  });

  renderControls();
  if ("IntersectionObserver" in window) {
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting || enteredViewport) return;
      enteredViewport = true;
      observer.disconnect();
      runDemo();
    }, { threshold: 0.35 });
    observer.observe(demo);
  } else {
    enteredViewport = true;
    runDemo();
  }
})();
