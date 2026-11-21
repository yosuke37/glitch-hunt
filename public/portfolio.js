const $ = (id) => document.getElementById(id);
async function json(path) { const response = await fetch(path); if (!response.ok) throw new Error(`Evidence unavailable: ${path}`); return response.json(); }
const sources = [
  ["Original hosted run", "/benchmark-before-pacing.json"],
  ["Checkpoint recovery", "/benchmark-after-checkpoints.json"],
  ["Semantic landmarks + pacing", "/benchmark.json"],
];
let reports;
function comparison() {
  $("comparison-rows").replaceChildren();
  const metric = $("comparison-metric").value;
  for (const [label, report] of reports) {
    const row = document.createElement("tr");
    const spacing = report.cohorts[0].requestSpacingMs;
    const values = [label, `${report.cohortTimeoutSeconds ?? 180}s`, spacing == null ? "Not recorded" : `${spacing / 1000}s`, ...report.cohorts.map((c) => metric === "completion" ? `${c.completed}/${report.trialsPerCohort}` : metric === "findings" ? String(c.truePositives) : c.costPerFindingUsd == null ? "Unreported" : `$${c.costPerFindingUsd.toFixed(5)}`)];
    for (const value of values) { const cell = document.createElement("td"); cell.textContent = value; row.append(cell); }
    $("comparison-rows").append(row);
  }
}
try {
  reports = await Promise.all(sources.map(async ([label, url]) => [label, await json(url)]));
  comparison(); $("comparison-status").textContent = "Same 20-case live workload at each worker-slot setting. Costs are estimates at uncached list rates.";
  $("comparison-metric").addEventListener("change", comparison);
} catch (error) { $("comparison-status").textContent = error.message; }
try {
  const evidence = await json("/recovery-evidence.json");
  $("recovery-summary").textContent = `${evidence.passed ? "Passed" : "Failed"} · ${new Date(evidence.measuredAt).toLocaleString()} · ${evidence.modelCalls} real model calls · estimated $${evidence.costUsd.toFixed(5)} · ${evidence.environment}.`;
  const descriptions = {
    checkpoint_persisted: d => 'Saved ' + d.moves + ' game moves after the first model call.',
    worker_process_terminated: () => 'Terminated the worker process with the operating system.',
    lease_expiry_accelerated: d => 'Accelerated the normal ' + d.normalLeaseSeconds + '-second lease timeout inside the isolated test schema.',
    checkpoint_resumed: d => 'Resumed all ' + d.retainedMoves + ' saved moves and finished in ' + d.totalMoves + ' moves across ' + d.modelCalls + ' total model calls. Both builds completed.',
    duplicate_delivery_ignored: d => 'Delivered the completed job again: attempts stayed at ' + d.attemptsAfter + '.',
    cancelled_worker_fenced: () => 'Cancelled another job. Its worker could no longer extend its lease, checkpoint, or save a stale result.'
  };
  for (const event of evidence.events) { const item = document.createElement('li'); item.textContent = descriptions[event.name]?.(event.detail) ?? event.name; $('recovery-events').append(item); }
} catch (error) { $("recovery-summary").textContent = error.message; }
try {
  const featured = await json("/featured-runs.json"); $("featured-runs").replaceChildren();
  for (const run of featured) { const item = document.createElement("li"); const link = document.createElement("a"); link.textContent = run.label; link.href = `/?run=${encodeURIComponent(run.id)}`; item.append(link); $("featured-runs").append(item); }
} catch (error) { $("featured-runs").textContent = error.message; }
