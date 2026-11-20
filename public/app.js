import { levels, scenarios, start } from "./game.js";
import { runBatch } from "./batch.js";

const $ = (id) => document.getElementById(id);
let selected;
let frame = 0;
let timer;
let levelId = 0;
const trialButtons = [];
const outcomes = {
  regression_found: "Regression found",
  no_regression_found: "No regression found",
  agent_incomplete: "Agent couldn't finish",
};
let activeBatch;
let pollTimer;
let polling = false;

for (const [index, level] of levels.entries()) {
  $("level").add(new Option(level.name, index));
}
for (const scenario of scenarios) $("scenario").add(new Option(scenario.name, scenario.id));

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function board(level, state, label, version) {
  const container = element("article", "", "build");
  const heading = element("h3", label);
  heading.append(element("span", version));
  const grid = element("div", "", "board");
  grid.setAttribute("aria-hidden", "true");
  const gateOpen = state.gateOpen && !(label === "CANDIDATE" && selected?.scenario === "gate_locked");
  const classes = { "#": "wall", P: "plate", G: gateOpen ? "gate open" : "gate", E: "exit" };
  for (const [y, row] of level.rows.entries()) {
    for (const [x, tile] of [...row].entries()) {
      const player = state.x === x && state.y === y;
      grid.append(element("div", player ? "◆" : "PGE".includes(tile) ? tile : "", `tile ${player ? "player" : classes[tile] ?? ""}`));
    }
  }
  const detail = `(${state.x}, ${state.y}) · ${state.won ? "Exit reached" : gateOpen ? "Gate open" : "Gate shut"}`;
  container.append(heading, grid, element("p", detail));
  return container;
}

function render() {
  const level = levels[selected?.levelId ?? levelId];
  const last = selected?.inputs.length ?? 0;
  $("boards").replaceChildren(
    board(level, selected?.baseline[frame] ?? start(level), "BASELINE", "v1.0"),
    board(level, selected?.candidate[frame] ?? start(level), "CANDIDATE", "v1.1"),
  );
  $("timeline").max = last;
  $("timeline").value = frame;
  $("timeline").disabled = last === 0;
  $("back").disabled = frame === 0;
  $("next").disabled = frame === last;
  $("play").disabled = last === 0;
  $("counter").textContent = [frame, last].map((count) => String(count).padStart(2, "0")).join(" / ");
  $("move").textContent = frame ? `LAST INPUT · ${selected.inputs[frame - 1].toUpperCase()}` : "START POSITION";
  $("verdict").dataset.verified = selected?.verified ?? false;
  $("verdict").textContent = selected ? outcomes[selected.outcome] ?? (selected.verified ? "Regression found" : "Agent couldn't finish") : "AWAITING RUN";
  $("finding").textContent = selected?.verified
    ? `The baseline reaches the exit. The candidate fails the replay, and an exhaustive search finds no route to completion. Update under test: ${scenarios.find((item) => item.id === selected.scenario)?.name ?? "Gate forgets pressure plate"}.`
    : selected?.outcome === "no_regression_found" ? "Both builds reached the exit on this trace. No regression was found in this trial."
    : selected ? "The agent did not complete a trace that establishes a result." : "Launch a hunt to collect a replay.";
}

function pause() {
  clearInterval(timer);
  timer = undefined;
  $("play").textContent = "▶ Play";
}

function seek(position) {
  frame = position;
  render();
}

function choose(result, index) {
  pause();
  selected = result;
  if (result) {
    levelId = result.levelId;
    $("level").value = String(result.levelId);
    $("scenario").value = result.scenario ?? "gate_reset";
  }
  trialButtons.forEach((button, i) => button.setAttribute("aria-pressed", String(index === i)));
  seek(0);
  renderTrace();
}

function renderTrace() {
  $("trace").replaceChildren();
  if (!selected || selected.mode !== "live") {
    $("trace-summary").textContent = selected
      ? "Offline solver trial. Launch a live AI trial to inspect tool calls."
      : "Select a live trial to inspect its activity.";
    return;
  }
  const endings = {
    baseline_completed: "Baseline reached the exit.",
    call_limit: "Model call limit reached.",
    move_limit: "Move limit reached.",
    missing_tool_call: "Model did not return a usable tool call.",
  };
  $("trace-summary").textContent = [
    selected.model, `${selected.usage.modelCalls} model calls`,
    `${(selected.elapsedMs / 1000).toFixed(2)}s`,
    endings[selected.stopReason] ?? "Run ended.",
  ].join(" · ");
  for (const entry of selected.trace ?? []) {
    const item = element("li", "", "trace-entry");
    const button = element("button",
      `Call ${entry.call} · ${entry.tool}${entry.arguments?.x !== undefined ? ` (${entry.arguments.x}, ${entry.arguments.y})` : ""} · ${entry.moves.join(" → ")}`);
    button.type = "button";
    button.addEventListener("click", () => { pause(); seek(entry.frameEnd); });
    const describe = (state) => `(${state.x}, ${state.y}) · gate ${state.gateOpen ? "open" : "closed"} · ${state.won ? "exit reached" : "playing"}`;
    item.append(button,
      element("p", `Baseline ${describe(entry.baseline)}`),
      element("p", `Candidate ${describe(entry.candidate)}`),
      element("small", `${entry.elapsedMs} ms · input tokens ${entry.inputTokens ?? "unreported"} · output tokens ${entry.outputTokens ?? "unreported"}`));
    if (entry.feedback) {
      const details = element("details");
      details.append(element("summary", "Move outcomes and nearby tiles"));
      for (const [build, feedback] of Object.entries(entry.feedback)) {
        if (!feedback?.attempts) continue;
        details.append(element("p", build === "baseline" ? "Baseline" : "Candidate"));
        const attempts = element("ul");
        for (const attempt of feedback.attempts) {
          attempts.append(element("li",
            `${attempt.move} · (${attempt.from.x}, ${attempt.from.y}) → (${attempt.to.x}, ${attempt.to.y}) · ${attempt.outcome.replaceAll("_", " ")}`));
        }
        details.append(attempts, element("p",
          feedback.nearby.map((tile) => `${tile.direction} · ${tile.tile} (${tile.blocked ? "blocked" : "open"})`).join(" / ")));
      }
      item.append(details);
    }
    $("trace").append(item);
  }
}

$("play").addEventListener("click", () => {
  if (timer) return pause();
  if (frame === selected.inputs.length) seek(0);
  $("play").textContent = "Ⅱ Pause";
  timer = setInterval(() => {
    seek(frame + 1);
    if (frame === selected.inputs.length) pause();
  }, 390);
});
$("back").addEventListener("click", () => { pause(); seek(frame - 1); });
$("next").addEventListener("click", () => { pause(); seek(frame + 1); });
$("timeline").addEventListener("input", (event) => { pause(); seek(Number(event.target.value)); });
$("mode").addEventListener("change", () => {
  const live = $("mode").value === "live";
  $("token-field").hidden = !live;
  $("token").required = live;
  if (live) {
    $("trials").value = "1";
    $("parallel").value = "1";
  }
});
$("level").addEventListener("change", () => {
  levelId = Number($("level").value);
  if (!selected) render();
});

$("hunt").addEventListener("submit", async (event) => {
  event.preventDefault();
  const mode = $("mode").value;
  const count = Number($("trials").value);
  const parallel = Math.min(Number($("parallel").value), count, 20);
  const token = $("token").value;
  const scenario = $("scenario").value;
  if (mode === "live") {
    await submitBatch({ count, parallel: Math.min(Number($("parallel").value), count), token, scenario });
    return;
  }
  const seeds = Array.from({ length: count }, (_, index) => index + 1);
  const started = performance.now();
  let completed = 0;
  $("launch").disabled = true;
  $("level").disabled = true;
  $("metrics").replaceChildren();
  $("trial-list").replaceChildren();
  trialButtons.length = 0;
  for (const seed of seeds) {
    const button = element("button", `Seed ${seed} · queued`);
    button.disabled = true;
    trialButtons.push(button);
    $("trial-list").append(button);
  }
  choose(undefined, -1);
  $("status").textContent = `Running ${count} trials across ${parallel} slots…`;
  const results = await runBatch(seeds, parallel, async (seed) => {
    const response = await fetch("/api/hunt", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(mode === "live" && { Authorization: `Bearer ${token}` }) },
      body: JSON.stringify({ mode, seed, levelId, scenario }),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error ?? "Trial failed.");
    return body;
  }, ({ value, error }, index) => {
    const button = trialButtons[index];
    button.textContent = `Seed ${seeds[index]} · ${value ? outcomes[value.outcome] : "failed"}`;
    button.title = error ?? "";
    button.disabled = !value;
    if (value) {
      button.addEventListener("click", () => choose(value, index));
      if (!selected) choose(value, index);
    }
    $("status").textContent = `${++completed}/${count} complete · ${parallel} slots`;
  });
  const values = results.flatMap(({ value }) => value ? [value] : []);
  const verified = values.filter((value) => value.verified).length;
  const error = results.find((result) => result.error)?.error;
  $("status").textContent = `${values.length}/${count} finished · ${verified} regressions${error ? ` · ${error}` : ""}`;
  const elapsed = (performance.now() - started) / 1000;
  const tokens = values.reduce((sum, value) => sum + (value.usage?.inputTokens ?? 0) + (value.usage?.outputTokens ?? 0), 0);
  const metrics = [`BATCH ${elapsed.toFixed(2)}s`, `${(values.length / elapsed).toFixed(1)} TRIALS/S`, `${parallel} SLOTS`];
  if (mode === "live") metrics.push(`${tokens} REPORTED TOKENS`);
  $("metrics").replaceChildren(...metrics.map((metric) => element("span", metric)));
  $("level").disabled = false;
  $("launch").disabled = false;
});

async function batchRequest(method, body) {
  const response = await fetch(`/api/batches${method === "POST" ? "" : `?id=${activeBatch}`}`, {
    method,
    headers: { Authorization: `Bearer ${$("token").value}`, "Content-Type": "application/json" },
    ...(body && { body: JSON.stringify(body) }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? "Batch request failed.");
  return result;
}

async function submitBatch({ count, parallel, scenario }) {
  $("launch").disabled = true;
  try {
    const result = await batchRequest("POST", {
      requestKey: crypto.randomUUID(), concurrency: parallel,
      inputs: Array.from({ length: count }, (_, index) => ({
        mode: "live", seed: index + 1, levelId, scenario,
      })),
    });
    activeBatch = result.id;
    localStorage.setItem("glitch-hunt-batch", activeBatch);
    $("trial-list").replaceChildren();
    trialButtons.length = 0;
    choose(undefined, -1);
    startPolling();
  } catch (error) {
    $("status").textContent = error.message;
    $("launch").disabled = false;
  }
}

function startPolling() {
  clearInterval(pollTimer);
  $("cancel").hidden = false;
  $("launch").disabled = true;
  $("batch-info").textContent = `Saved batch ${activeBatch}. Workers continue after this tab closes.`;
  pollTimer = setInterval(pollBatch, 1500);
  pollBatch();
}

async function pollBatch() {
  if (polling) return;
  polling = true;
  try {
    const batch = await batchRequest("GET");
    const completed = batch.jobs.filter((job) => ["succeeded", "failed", "cancelled"].includes(job.status)).length;
    $("status").textContent = `${completed}/${batch.jobs.length} complete · ${batch.concurrency} slots`;
    if (batch.jobs.some((job) => job.status === "queued" && job.input.mode === "live")) {
      if (batch.control.live_attempts >= batch.control.daily_live_limit) {
        $("status").textContent += " · Daily live attempt limit reached";
      } else if (new Date(batch.control.model_cooldown_until).getTime() > Date.now()) {
        $("status").textContent += " · Waiting for Gateway rate limit cooldown";
      }
    }
    for (const [index, job] of batch.jobs.entries()) {
      let button = trialButtons[index];
      if (!button) {
        button = element("button");
        trialButtons.push(button);
        $("trial-list").append(button);
      }
      button.textContent = `Seed ${job.input.seed} · ${job.result ? outcomes[job.result.outcome] : job.status}`;
      button.disabled = !job.result;
      button.onclick = () => choose(job.result, index);
      button.title = job.error ?? "";
      if (!selected && job.result) choose(job.result, index);
    }
    const traces = batch.attempts.filter((attempt) => attempt.progress);
    const calls = traces.reduce((sum, attempt) => sum + (attempt.progress.usage?.modelCalls ?? 0), 0);
    $("metrics").replaceChildren(element("span", `${batch.attempts.length} ATTEMPTS · ${calls} SAVED MODEL CALLS`));
    if (completed === batch.jobs.length) {
      clearInterval(pollTimer);
      $("cancel").hidden = true;
      $("launch").disabled = false;
    }
  } catch (error) {
    clearInterval(pollTimer);
    $("status").textContent = error.message;
    $("launch").disabled = false;
  } finally {
    polling = false;
  }
}

$("resume").addEventListener("click", () => {
  activeBatch = localStorage.getItem("glitch-hunt-batch");
  if (!activeBatch) { $("status").textContent = "No saved batch on this browser."; return; }
  $("token-field").hidden = false;
  if (!$("token").value) { $("status").textContent = "Enter your operator token, then resume."; return; }
  $("trial-list").replaceChildren();
  trialButtons.length = 0;
  choose(undefined, -1);
  batchRequest("PATCH").catch((error) => { $("status").textContent = error.message; });
  startPolling();
});
$("cancel").addEventListener("click", async () => {
  try { await batchRequest("DELETE"); await pollBatch(); }
  catch (error) { $("status").textContent = error.message; }
});
$("sample").addEventListener("click", async () => {
  try {
    const response = await fetch("/sample-run.json");
    if (!response.ok) throw new Error("Saved replay unavailable.");
    const sample = await response.json();
    $("metrics").replaceChildren();
    choose(sample, -1);
    $("status").textContent = "Saved live run · replay at your own pace.";
  } catch (error) { $("status").textContent = error.message; }
});

render();
$("sample").click();
async function loadBenchmark() {
  try {
    const response = await fetch("/benchmark.json");
    if (!response.ok) throw new Error();
    const report = await response.json();
    $("benchmark-summary").textContent =
      `${report.model} · ${report.trialsPerCohort} identical trials per cohort · ${new Date(report.measuredAt).toLocaleDateString()}. ${report.environment} Cost uses estimated uncached list rates. Rate-limited and cancelled jobs count as incomplete. ${report.notes ?? ""}`;
    for (const cohort of report.cohorts) {
      const row = element("tr");
      for (const value of [
        cohort.concurrency, `${cohort.completed}/${report.trialsPerCohort}`,
        cohort.truePositives, `${cohort.falseNegatives} / ${cohort.falsePositives}`,
        `${(cohort.p95CompletionMs / 1000).toFixed(2)}s`,
        cohort.costPerFindingUsd === null ? "—" : `$${cohort.costPerFindingUsd.toFixed(5)}`,
      ]) row.append(element("td", String(value)));
      $("benchmark-rows").append(row);
    }
  } catch {
    $("benchmark-summary").textContent = "Measurements have not been published yet.";
  }
}
loadBenchmark();
