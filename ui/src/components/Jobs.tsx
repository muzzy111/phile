// Transfer manager: live queue with pause / resume / cancel and a speed limit.
import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { api, fmtSize, type JobProgress, onJobProgress } from "../lib/api";
import { collision, jobsOpen, setCollision, setJobsOpen, setVerify, verify } from "../lib/actions";
import { load, notify } from "../lib/state";

const [jobs, setJobs] = createStore<Record<number, JobProgress>>({});
export const activeJobs = () => Object.values(jobs).filter((j) => j.state === "running" || j.state === "queued" || j.state === "paused");

const LIMITS: [string, number][] = [["Unlimited", 0], ["100 MB/s", 100e6], ["50 MB/s", 50e6], ["20 MB/s", 20e6], ["5 MB/s", 5e6], ["1 MB/s", 1e6]];

export function JobsBridge() {
  onMount(async () => {
    const un = await onJobProgress((p) => {
      const prev = jobs[p.id]?.state;
      setJobs(p.id, reconcile(p));
      if (prev !== p.state && (p.state === "done" || p.state === "failed")) {
        // Refresh both panes so results appear immediately.
        load(0, true);
        load(1, true);
        if (p.state === "failed") notify(`${p.label}: ${p.errors[0] ?? "failed"}`, "error");
        else if (!jobsOpen()) notify(`Done: ${p.label}`);
      }
    });
    onCleanup(un);
    (await api.jobList()).forEach((j) => setJobs(j.id, j));
  });
  return null;
}

export function JobsPanel() {
  const [limit, setLimit] = createSignal(0);
  onMount(async () => setLimit((await api.settingGet<number>("throttle")) ?? 0));
  const list = () => Object.values(jobs).sort((a, b) => b.id - a.id);
  const pct = (j: JobProgress) => (j.bytesTotal ? (j.bytesDone / j.bytesTotal) * 100 : j.filesTotal ? (j.filesDone / j.filesTotal) * 100 : j.state === "done" ? 100 : 0);
  return (
    <Show when={jobsOpen()}>
      <div class="jobs">
        <div class="jobs-head">
          <b>Transfers</b>
          <label>
            Speed
            <select value={limit()} onChange={(e) => { const v = +e.currentTarget.value; setLimit(v); api.setThrottle(v); }}>
              <For each={LIMITS}>{([l, v]) => <option value={v}>{l}</option>}</For>
            </select>
          </label>
          <label>
            If name exists
            <select value={collision()} onChange={(e) => setCollision(e.currentTarget.value as any)}>
              <option value="rename">Keep both</option>
              <option value="newer">Replace if newer</option>
              <option value="overwrite">Replace</option>
              <option value="skip">Skip</option>
            </select>
          </label>
          <label><input type="checkbox" checked={verify()} onChange={(e) => setVerify(e.currentTarget.checked)} /> Verify copies</label>
          <span class="spacer" />
          <button onClick={() => { api.jobClear(); setJobs(reconcile(Object.fromEntries(activeJobs().map((j) => [j.id, j])))); }}>Clear finished</button>
          <button onClick={() => setJobsOpen(false)}>×</button>
        </div>
        <div class="jobs-list">
          <Show when={list().length} fallback={<div class="empty">No transfers yet. F5 copies and F6 moves to the other pane.</div>}>
            <For each={list()}>
              {(j) => (
                <div class={`job ${j.state}`}>
                  <div class="job-top">
                    <span class="job-label" title={j.label}>{j.label}</span>
                    <span class="job-state">{j.state}</span>
                    <Show when={j.state === "running" || j.state === "queued"}><button onClick={() => api.jobPause(j.id)}>Pause</button></Show>
                    <Show when={j.state === "paused"}><button onClick={() => api.jobResume(j.id)}>Resume</button></Show>
                    <Show when={j.state === "running" || j.state === "queued" || j.state === "paused"}><button onClick={() => api.jobCancel(j.id)}>Cancel</button></Show>
                  </div>
                  <div class="bar"><div style={{ width: `${pct(j)}%` }} /></div>
                  <div class="job-sub">
                    {j.filesDone}/{j.filesTotal} files · {fmtSize(j.bytesDone)} / {fmtSize(j.bytesTotal)}
                    <Show when={j.current}> · {j.current.split(/[\\/]/).pop()}</Show>
                  </div>
                  <For each={j.errors.slice(0, 5)}>{(e) => <div class="job-err">{e}</div>}</For>
                </div>
              )}
            </For>
          </Show>
        </div>
      </div>
    </Show>
  );
}

