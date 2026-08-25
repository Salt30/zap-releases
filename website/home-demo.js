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

  const demoTokens = [
    { word: "Drip", suffix: " " },
    { word: "Type", suffix: " " },
    { word: "types", suffix: " " },
    { word: "finished", suffix: " " },
    { word: "words", suffix: " " },
    { word: "naturally", suffix: " " },
    { word: "into", suffix: " " },
    { word: "any", suffix: " " },
    { word: "app", suffix: "." },
  ];
  const targetText = demoTokens.map(({ word, suffix }) => `${word}${suffix}`).join("");
  const typoCandidates = [
    { tokenIndex: 1, wrongCharacter: "w" },
    { tokenIndex: 3, wrongCharacter: "f" },
    { tokenIndex: 5, wrongCharacter: "u" },
    { tokenIndex: 8, wrongCharacter: "o" },
  ];
  const pauseCandidates = [2, 4, 5, 7];
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  let runNumber = 0;
  let replayTimer = 0;
  let restartTimer = 0;
  let enteredViewport = false;

  const readValues = () => Object.fromEntries(Object.entries(controls)
    .map(([key, input]) => [key, Number(input.value)]));

  const representativeCount = (value, step, maximum) => value === 0
    ? 0
    : Math.min(maximum, Math.max(1, Math.round(value / step)));

  const runPlan = (values) => ({
    corrections: representativeCount(values.typos, 4, typoCandidates.length),
    pauses: representativeCount(values.pauses, 3, pauseCandidates.length),
  });

  const runSummary = (values, plan) => {
    const correctionLabel = plan.corrections === 1 ? "correction" : "corrections";
    const pauseLabel = plan.pauses === 1 ? "pause" : "pauses";
    return `${values.wpm} WPM · ${plan.corrections} ${correctionLabel} · ${plan.pauses} ${pauseLabel}`;
  };

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
    const plan = runPlan(values);
    const plannedCorrections = typoCandidates.slice(0, plan.corrections);
    const plannedPauses = new Set(pauseCandidates.slice(0, plan.pauses));
    demo.classList.remove("is-typing", "is-correcting");

    if (reducedMotion.matches) {
      paintText(targetText);
      demoStatus.textContent = `Preview ready · ${runSummary(values, plan)}`;
      return;
    }

    paintText("");
    demo.classList.add("is-typing");
    demoStatus.textContent = runSummary(values, plan);
    let text = "";
    let completedCorrections = 0;
    let completedPauses = 0;
    const burstPace = values.bursts > 0 ? Math.max(0.52, 1 - (values.bursts / 55)) : 1;
    for (let tokenIndex = 0; tokenIndex < demoTokens.length; tokenIndex += 1) {
      const { word, suffix } = demoTokens[tokenIndex];
      const correction = plannedCorrections.find((candidate) => candidate.tokenIndex === tokenIndex);
      const pace = tokenIndex >= 6 ? burstPace : 1;

      if (correction) {
        const mistypedWord = `${word.slice(0, -1)}${correction.wrongCharacter}`;
        text = await typeCharacters(text, mistypedWord, values, token, pace);
        if (text === null) return;
        completedCorrections += 1;
        demo.classList.add("is-correcting");
        demoStatus.textContent = `Correcting typo ${completedCorrections} of ${plan.corrections} · ${values.typos}%`;
        if (!await wait(300 + (values.typos * 35), token)) return;
        text = await eraseCharacters(text, 1, values, token);
        if (text === null) return;
        text = await typeCharacters(text, word.slice(-1), values, token, pace);
        if (text === null) return;
        demo.classList.remove("is-correcting");
      } else {
        text = await typeCharacters(text, word, values, token, pace);
        if (text === null) return;
      }

      text = await typeCharacters(text, suffix, values, token, pace);
      if (text === null) return;

      if (plannedPauses.has(tokenIndex)) {
        completedPauses += 1;
        demoStatus.textContent = `Thinking pause ${completedPauses} of ${plan.pauses} · ${values.pauses}%`;
        if (!await wait(260 + (values.pauses * 40), token)) return;
      }
      demoStatus.textContent = runSummary(values, plan);
    }

    demo.classList.remove("is-typing");
    demoStatus.textContent = `${plan.corrections} corrections · ${plan.pauses} pauses · replay in ${values.delay}s`;
    demoProgress.style.width = "100%";
    replayTimer = window.setTimeout(() => {
      if (!document.hidden && token === runNumber) runDemo();
    }, (values.delay * 1000) + 1400);
  };

  const restartDemo = () => {
    window.clearTimeout(restartTimer);
    runNumber += 1;
    demoStatus.textContent = "Applying settings";
    restartTimer = window.setTimeout(runDemo, 160);
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
