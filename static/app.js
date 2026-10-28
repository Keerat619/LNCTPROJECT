'use strict';

const state = {
  page: 'overview', sessions: [], session: null, settings: null,
  attendanceSearch: '', attendanceFilter: 'all', confirmFn: null,
  capture: null, chartCount: 0, sampleVideo: false
};
const content = document.getElementById('content');
const modalRoot = document.getElementById('modal-root');
const localHost = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(location.hostname);
const svg = (name, cls = '') => `<svg class="${cls}" aria-hidden="true"><use href="#i-${name}"></use></svg>`;
const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
const number = value => value == null || !Number.isFinite(Number(value)) ? '—' : String(Math.round(Number(value)));
const initials = name => String(name || '').trim().split(/\s+/).slice(0, 2).map(x => x[0] || '').join('').toUpperCase();
const elapsed = seconds => {
  const n = Math.max(0, Math.floor(Number(seconds) || 0));
  const p = v => String(v).padStart(2, '0');
  return n >= 3600 ? `${p(Math.floor(n/3600))}:${p(Math.floor(n%3600/60))}:${p(n%60)}` : `${p(Math.floor(n/60))}:${p(n%60)}`;
};
const durationLabel = seconds => {
  seconds = Number(seconds) || 0;
  if (seconds < 60) return `${Math.round(seconds)} sec`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
  return `${Math.floor(seconds / 3600)} hr ${Math.round((seconds % 3600) / 60)} min`;
};
const formatDate = s => {
  try { return new Date(s).toLocaleDateString(undefined, {month:'short', day:'numeric', year:'numeric'}); }
  catch { return ''; }
};
const badge = session => {
  const status = session.status === 'demo'
    ? '<span class="badge badge-demo"><span class="mini-dot"></span> DEMO DATA</span>'
    : session.status === 'open' ? '<span class="badge badge-open"><span class="mini-dot"></span> OPEN</span>'
    : '<span class="badge badge-done"><span class="mini-dot"></span> COMPLETED</span>';
  return status + (session.status !== 'demo' && session.media_kind === 'synthetic' ? ' <span class="badge badge-demo">SYNTHETIC CLIP</span>' : '');
};
const presencePill = status => `<span class="status-pill status-${esc(status)}">${status === 'unmarked' ? 'Not marked' : status === 'absent' ? 'Absent' : 'Present'}</span>`;
const safeStorage = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k,v) { try { localStorage.setItem(k,v); } catch {} }
};

async function api(path, options={}) {
  const config = {...options, headers:{...(options.headers || {})}};
  if (options.body && typeof options.body === 'object' && !(options.body instanceof Blob) && !(options.body instanceof ArrayBuffer)) {
    config.headers['Content-Type'] = 'application/json';
    config.body = JSON.stringify(options.body);
  }
  const response = await fetch(path, config);
  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try { const data = await response.json(); message = data.error || message; } catch {}
    throw new Error(message);
  }
  return response.json();
}
function toast(message, error=false) {
  const node=document.createElement('div'); node.className=`toast${error?' error':''}`; node.textContent=message;
  document.getElementById('toast-region').appendChild(node);
  setTimeout(()=>node.remove(), 4300);
}
async function refreshIndex() {
  const data = await api('/api/bootstrap'); state.sessions=data.sessions; state.settings=data.settings;
}
async function selectSession(id, renderAfter=true) {
  if (!id) { state.session=null; if(renderAfter) render(); return; }
  state.session=await api(`/api/sessions/${encodeURIComponent(id)}`);
  safeStorage.set('classroom-lens-session',id);
  if(renderAfter) render();
}
async function navigate(page) {
  if (state.capture?.active) {
    await stopCapture(false);
    toast('Capture paused. Resuming creates new anonymous track IDs.');
  }
  state.page=page;
  safeStorage.set('classroom-lens-page',page === 'capture' ? 'overview' : page);
  try { history.replaceState(null, '', `#${page}`); } catch {}
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('mobile-scrim').classList.remove('open');
  render();
  window.scrollTo({top:0, behavior:'smooth'});
}
function pageHeading(kicker,title,body,right='') {
  return `<div class="page-head-row"><div class="page-intro"><div class="eyebrow">${esc(kicker)}</div><h1>${esc(title)}</h1><p>${esc(body)}</p></div>${right ? `<div class="head-actions">${right}</div>` : ''}</div>`;
}
function hostedNotice() {
  if (localHost) return '';
  return `<div class="hosted-note">${svg('info')}<span><strong>Hosted preview:</strong> frames are sent to the preview server. For private footage, download the project and run it on your own computer.</span></div>`;
}
function sessionSelect() {
  if (!state.sessions.length) return '';
  return `<span class="select-shell"><select aria-label="Choose session" data-action="select-session">${state.sessions.map(s=>`<option value="${esc(s.id)}" ${state.session?.id===s.id?'selected':''}>${esc(s.name)}${s.status==='demo'?' · Demo':''}</option>`).join('')}</select>${svg('chevron-down')}</span>`;
}
function sessionStrip(session) {
  if(!session) return '';
  const descriptor = session.status==='demo' ? 'Fictional sample · simulated observations' : `${session.source==='camera'?'Camera':'Video'} · ${session.detector==='face'?'Frontal-face':'Full-body'} detector`;
  const sessionAction = session.status === 'open' && state.page !== 'capture' ? `<button class="button button-secondary button-sm" data-action="nav" data-page="capture">Continue capture ${svg('arrow-right')}</button>` : `<button class="button button-secondary button-sm" data-action="nav" data-page="sessions">All sessions ${svg('arrow-right')}</button>`;
  return `<div class="session-strip"><div class="session-icon">${svg('folder')}</div><div class="session-strip-main"><div class="session-name">${esc(session.name)} ${badge(session)}</div><p>${esc(session.section || 'Session')} &nbsp;·&nbsp; ${esc(descriptor)}</p></div><div class="session-strip-right">${sessionSelect()}${sessionAction}</div></div>`;
}
function metrics(session) {
  const s=session.stats;
  const present = s.roster_total ? `${number(s.present)} <small>/ ${number(s.roster_total)}</small>` : `${number(s.qualified_tracks)} <small>tracks</small>`;
  const attendanceNote = s.roster_total ? `${s.unmarked} not marked <span class="sep">·</span> human review` : 'Anonymous tracks above threshold';
  const activity = s.activity == null ? '—' : `${number(s.activity)} <small>/ 100</small>`;
  const sound = s.audio_activity == null ? '—' : `${number(s.audio_activity)}<span class="metric-unit">%</span>`;
  const duration=Number(s.duration)||0;
  const dValue=duration >= 60 ? `${number(duration/60)} <span class="metric-unit">min</span>` : `${number(duration)} <span class="metric-unit">sec</span>`;
  const data=[
    ['Attendance','users','green',present,attendanceNote],
    ['Activity signal','wave','lilac',activity,'Movement + sound proxy'],
    ['Sound activity','sound','peach',sound,s.audio_activity==null?'Audio not available':'Sampled moments above threshold'],
    ['Session length','clock','blue',dValue,`${s.samples} sampled moments`]
  ];
  return `<div class="metrics-grid">${data.map(m=>`<div class="metric-card"><div class="metric-top"><span>${m[0]}</span><span class="metric-icon ${m[2]}">${svg(m[1])}</span></div><div class="metric-value">${m[3]}</div><div class="metric-bottom">${m[4]}</div></div>`).join('')}</div>`;
}
function renderChart(session, tall=false) {
  const timeline=session.timeline||[];
  const usable=timeline.filter(x=>x.activity!=null);
  if(!usable.length) return `<div class="chart-empty">${svg('wave')}<span>No activity samples yet.<br>Start a capture to see a trend.</span></div>`;
  const id=`grad${++state.chartCount}`;
  const left=37, right=684, top=14, bottom=180, w=right-left, h=bottom-top;
  const duration=Math.max(10, Number(session.duration)||0, ...timeline.map(x=>x.t));
  const x=t=>left+Math.min(1,Math.max(0,t/duration))*w;
  const y=v=>bottom-(Math.min(100,Math.max(0,v))/100)*h;
  const lines=[0,25,50,75,100].map(n=>`<line x1="${left}" y1="${y(n)}" x2="${right}" y2="${y(n)}" stroke="#edf1ed" stroke-width="1"/><text x="${left-10}" y="${y(n)+3.5}" text-anchor="end">${n}</text>`).join('');
  const tickStep=duration>=2400?600:duration>=600?300:duration>=120?60:duration>=30?30:10;
  let ticks='';
  for(let t=0;t<=duration;t+=tickStep) ticks+=`<text x="${x(t)}" y="201" text-anchor="${t===0?'start':'middle'}">${elapsed(t)}</text>`;
  const segment=(key)=>{
    let segments=[], current=[];
    for(const p of timeline){
      if(p[key]==null){ if(current.length)segments.push(current); current=[]; continue; }
      if(current.length && p.t-current[current.length-1].t>(current[current.length-1].end-current[current.length-1].t)*1.5){segments.push(current);current=[];}
      current.push(p);
    }
    if(current.length)segments.push(current);
    return segments;
  };
  const activityPaths=segment('activity').map(seg=>{
    const path=seg.map((p,i)=>`${i?'L':'M'} ${x(p.t).toFixed(1)} ${y(p.activity).toFixed(1)}`).join(' ');
    const area=seg.length>1?`<path d="${path} L ${x(seg[seg.length-1].t).toFixed(1)} ${bottom} L ${x(seg[0].t).toFixed(1)} ${bottom} Z" fill="url(#${id})" stroke="none"/>`:'';
    const dots=seg.map(p=>`<circle cx="${x(p.t)}" cy="${y(p.activity)}" r="3.4" fill="#fff" stroke="#6d9e7b" stroke-width="1.8"><title>${elapsed(p.t)}: activity ${number(p.activity)}/100, ${p.samples} sample(s)</title></circle>`).join('');
    return `${area}<path d="${path}" fill="none" stroke="#75a786" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>${dots}`;
  }).join('');
  const audioPaths=segment('audio').map(seg=>`<path d="${seg.map((p,i)=>`${i?'L':'M'} ${x(p.t).toFixed(1)} ${y(p.audio).toFixed(1)}`).join(' ')}" fill="none" stroke="#d8ae98" stroke-width="1.7" stroke-dasharray="4 4" stroke-linecap="round" stroke-linejoin="round"/>`).join('');
  return `<div class="chart-frame"><svg viewBox="0 0 700 210" preserveAspectRatio="none" role="img" aria-label="Activity and sound levels across the session"><defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#b6d6bb" stop-opacity=".45"/><stop offset="100%" stop-color="#eaf4ea" stop-opacity=".06"/></linearGradient></defs>${lines}${ticks}${audioPaths}${activityPaths}</svg></div>`;
}
function chartCard(session) {
  return `<section class="card card-pad chart-card"><div class="card-header"><div><div class="card-kicker">SESSION DYNAMICS</div><h2 class="card-title">Activity across the session</h2><p class="card-subtitle">A group-level view of observable signals</p></div><div class="chart-head-right"><strong>${number(session.stats.activity)} <small>/ 100</small></strong><span>Average signal</span></div></div><div class="chart-legend"><span class="legend-item"><span class="legend-swatch"></span> Activity signal</span><span class="legend-item"><span class="legend-swatch audio"></span> Sound activity</span></div>${renderChart(session)}<div class="chart-note">${svg('info')} Signals are proxies, not a measure of attention or learning.</div></section>`;
}
function insightsCard(session) {
  return `<section class="card suggestion-card"><div class="card-pad"><div class="card-header"><div><div class="card-kicker">TEACHING ASSISTANT <span class="mini-ai-badge">RULE-BASED</span></div><h2 class="card-title">A few things to consider</h2><p class="card-subtitle">Gentle prompts, grounded in the signals</p></div><div class="assistant-head-icon">${svg('sparkle')}</div></div></div><div class="insight-list">${session.suggestions.map((x,i)=>`<div class="insight-item"><span class="insight-index">0${i+1}</span><div><strong>${esc(x.title)}</strong><p>${esc(x.body)}</p></div></div>`).join('')}</div><div class="suggestion-footer"><button class="button button-ghost" data-action="nav" data-page="engagement">Explore all insights ${svg('arrow-right')}</button></div></section>`;
}
function learnerRowsOverview(session) {
  const rows=session.roster_rows.slice(0,4);
  if(!rows.length) return `<tr><td colspan="4"><div class="table-empty">No roster yet. Add learners in Attendance.</div></td></tr>`;
  return rows.map((r,i)=>`<tr><td><div class="learner-cell"><span class="learner-avatar a${i%4}">${esc(initials(r.name))}</span><div><div class="learner-name">${esc(r.name)}</div><div class="learner-code">${esc(r.code || 'Manual roster entry')}</div></div></div></td><td>${presencePill(r.status)}</td><td>${r.track?elapsed(r.track.first_seen):'—'}</td><td>${r.track?durationLabel(r.track.seen_seconds):'—'}</td></tr>`).join('');
}
function overview(session) {
  if(!session) return emptyWorkspace();
  const today=new Date().toLocaleDateString(undefined,{weekday:'long',month:'long',day:'numeric'});
  return `<div class="page-heading"><div><div class="eyebrow green">A LITTLE MORE CLARITY, EVERY DAY</div><h1>Your classroom, in focus.</h1><p>Here's a thoughtful look at your session so far.</p></div><div class="heading-date">${svg('calendar')} ${esc(today)}</div></div>${hostedNotice()}${sessionStrip(session)}${metrics(session)}<div class="dashboard-grid">${chartCard(session)}${insightsCard(session)}</div><div class="lower-grid"><section class="card table-card"><div class="table-header"><div><div class="card-kicker">YOUR LEARNERS</div><h2 class="card-title">Attendance at a glance</h2><p class="card-subtitle">Presence requires ${number(session.presence_threshold)} seconds of observed tracking</p></div><button class="button button-secondary button-sm" data-action="nav" data-page="attendance">View attendance ${svg('arrow-right')}</button></div><div class="table-responsive"><table class="data-table"><thead><tr><th>Learner</th><th>Status</th><th>First observed</th><th>Observed time</th></tr></thead><tbody>${learnerRowsOverview(session)}</tbody></table></div></section><section class="card snapshot-card"><div class="snapshot-header"><div class="card-kicker">A MORE THOUGHTFUL SPACE</div><h2 class="card-title">Designed for your classroom</h2></div><div class="snapshot-image"><img src="/static/classroom.jpg" alt="Illustration of a classroom, viewed from behind"><span class="image-label">ILLUSTRATION · NOT A CAMERA FEED</span></div><div class="snapshot-footer">${svg('shield')}<div><strong>Your space, your data.</strong><p>No footage or audio is saved. Learner names are assigned by you, not by facial recognition.</p></div></div></section></div>`;
}
function emptyWorkspace() {
  return `${pageHeading('WELCOME','Your workspace is ready.','Create a session or restore the fictional sample to explore the prototype.')}<div class="card card-pad"><div class="chart-empty">${svg('folder')}<strong>No sessions yet</strong><span>Start with a camera, video, or sample session.</span><div class="head-actions"><button class="button button-primary" data-action="new-session">${svg('plus')} New session</button><button class="button button-secondary" data-action="restore-demo">Restore sample</button></div></div></div>`;
}

function filteredRows(){
  if(!state.session) return [];
  const q=state.attendanceSearch.trim().toLowerCase();
  return state.session.roster_rows.filter(r => (state.attendanceFilter==='all'||r.status===state.attendanceFilter) && (!q||`${r.name} ${r.code||''} ${r.track_id||''}`.toLowerCase().includes(q)));
}
function assignmentOptions(row) {
  const assigned=new Set(state.session.roster_rows.filter(r=>r.id!==row.id && r.track_id).map(r=>r.track_id));
  return `<option value="">Unassigned</option>${state.session.tracks.map(t=>`<option value="${esc(t.id)}" ${t.id===row.track_id?'selected':''} ${assigned.has(t.id)?'disabled':''}>${esc(t.id)}${assigned.has(t.id)?' · matched':''}</option>`).join('')}`;
}
function attendanceBody() {
  const rows=filteredRows();
  if(!rows.length) return `<tr><td colspan="7"><div class="table-empty">${state.session.roster_rows.length ? 'No learners match your filters.' : 'No roster yet. Add a learner to get started.'}</div></td></tr>`;
  return rows.map((r,i)=>`<tr><td><div class="learner-cell"><span class="learner-avatar a${i%4}">${esc(initials(r.name))}</span><div><div class="learner-name">${esc(r.name)}</div><div class="learner-code">${esc(r.code||'No learner ID')}</div></div></div></td><td>${presencePill(r.status)}<div class="learner-code">${r.status_source==='manual'?'Manual override':r.status_source==='tracked'?'From matched track':'Awaiting review'}</div></td><td><select class="table-select" aria-label="Match a track to ${esc(r.name)}" data-action="change-track" data-id="${esc(r.id)}">${assignmentOptions(r)}</select></td><td>${r.track?elapsed(r.track.first_seen):'—'}</td><td>${r.track?durationLabel(r.track.seen_seconds):'—'}</td><td><select class="table-select" aria-label="Attendance override for ${esc(r.name)}" data-action="change-status" data-id="${esc(r.id)}"><option value="auto" ${r.manual_status==='auto'?'selected':''}>Use track</option><option value="present" ${r.manual_status==='present'?'selected':''}>Mark present</option><option value="unmarked" ${r.manual_status==='unmarked'?'selected':''}>Not marked</option><option value="absent" ${r.manual_status==='absent'?'selected':''}>Mark absent</option></select></td><td><button class="row-icon-btn" data-action="remove-learner" data-id="${esc(r.id)}" aria-label="Remove ${esc(r.name)}">${svg('trash')}</button></td></tr>`).join('');
}
function updateAttendanceBody() {
  const body=document.getElementById('attendance-body');
  if(body) body.innerHTML=attendanceBody();
  const count=document.getElementById('attendance-count');
  if(count) count.textContent=`Showing ${filteredRows().length} of ${state.session.roster_rows.length} learners`;
}
function attendance(session){
  if(!session) return emptyWorkspace();
  const s=session.stats;
  const unnamed=session.unmapped_tracks;
  const events=[...(session.events||[])].sort((a,b)=>b.t-a.t).slice(0,6);
  return `${pageHeading('PRESENCE, WITH CONTEXT','Attendance','Review the roster, match anonymous tracks, and correct records yourself.',`<button class="button button-secondary" data-action="export">${svg('download')} Export CSV</button><button class="button button-primary" data-action="add-learner">${svg('plus')} Add learner</button>`)}${hostedNotice()}${sessionStrip(session)}<div class="stats-inline"><div class="small-stat"><span>Roster</span><strong>${number(s.roster_total)} <small>learners</small></strong></div><div class="small-stat"><span>Present</span><strong>${number(s.present)}</strong></div><div class="small-stat"><span>Not marked</span><strong>${number(s.unmarked)}</strong></div><div class="small-stat"><span>Unmatched tracks</span><strong>${number(unnamed.length)}</strong></div></div><div class="inline-note">${svg('info')}<span><strong>A person is not identified by the detector.</strong> Match a track to a learner only after checking the live overlay. A missed detection is not proof of absence.</span></div><section class="card table-card section-space"><div class="toolbar"><div class="toolbar-left"><div class="search-box">${svg('search')}<input id="attendance-search" data-action="attendance-search" type="search" placeholder="Search learners or tracks" value="${esc(state.attendanceSearch)}" aria-label="Search learners or tracks"></div><select class="table-select" data-action="attendance-filter" aria-label="Filter attendance"><option value="all" ${state.attendanceFilter==='all'?'selected':''}>All statuses</option><option value="present" ${state.attendanceFilter==='present'?'selected':''}>Present</option><option value="unmarked" ${state.attendanceFilter==='unmarked'?'selected':''}>Not marked</option><option value="absent" ${state.attendanceFilter==='absent'?'selected':''}>Absent</option></select></div><div class="toolbar-right"><span class="card-subtitle">Threshold: ${number(session.presence_threshold)} seconds</span></div></div><div class="table-responsive"><table class="data-table"><thead><tr><th>Learner</th><th>Attendance</th><th>Track assignment</th><th>First observed</th><th>Observed time</th><th>Override</th><th></th></tr></thead><tbody id="attendance-body">${attendanceBody()}</tbody></table></div><div class="table-foot"><span id="attendance-count">Showing ${filteredRows().length} of ${session.roster_rows.length} learners</span><span>Times are relative to the session</span></div></section><div class="lower-grid"><section class="card table-card"><div class="table-header"><div><div class="card-kicker">MANUAL MATCHING</div><h2 class="card-title">Unmatched observations</h2><p class="card-subtitle">Track IDs are temporary and may split or swap.</p></div><span class="badge badge-done">${unnamed.length} TRACKS</span></div><div class="table-responsive"><table class="data-table" style="min-width:440px"><thead><tr><th>Track ID</th><th>First observed</th><th>Observed time</th><th>Threshold</th></tr></thead><tbody>${unnamed.length?unnamed.map(t=>`<tr><td><strong>${esc(t.id)}</strong></td><td>${elapsed(t.first_seen)}</td><td>${durationLabel(t.seen_seconds)}</td><td>${t.qualified?presencePill('present'):presencePill('unmarked')}</td></tr>`).join(''):`<tr><td colspan="4"><div class="table-empty">No unmatched observations.</div></td></tr>`}</tbody></table></div></section><section class="card card-pad"><div class="card-kicker">TIMESTAMPED LOG</div><h2 class="card-title">Recent observations</h2><p class="card-subtitle">Elapsed time from the session start</p><div class="activity-log">${events.length?events.map(e=>`<div class="log-row"><span class="log-dot"></span><span>${esc(e.text)}</span><span class="log-time">${elapsed(e.t)}</span></div>`).join(''):`<div class="table-empty">No observations yet.</div>`}</div></section></div>`;
}
function engagement(session){
  if(!session) return emptyWorkspace();
  const s=session.stats;
  const details=session.suggestions.map((x,i)=>`<div class="insight-detail"><div class="insight-detail-icon">${svg(x.icon||'sparkle')}</div><div><div class="card-kicker">${esc(x.eyebrow)}</div><h3>${esc(x.title)}</h3><p>${esc(x.body)}</p><span class="evidence">${esc(x.evidence)}</span>${x.kind==='attendance'?`<div style="margin-top:9px"><button class="button button-ghost button-sm" data-action="nav" data-page="attendance">Review attendance ${svg('arrow-right')}</button></div>`:''}</div></div>`).join('');
  return `${pageHeading('SIGNALS, NOT ASSUMPTIONS','Engagement','Explore session-level activity and practical, rule-based teaching prompts.',`<button class="button button-secondary" data-action="guide">${svg('info')} How it works</button>`)}${hostedNotice()}${sessionStrip(session)}<div class="inline-note">${svg('shield')}<span><strong>These signals do not establish attention, emotion, intent, or learning.</strong> Quiet learners may be engaged; sound may be background noise. Do not use this prototype to grade or make consequential decisions.</span></div><div class="stats-inline section-space"><div class="small-stat"><span>Average activity signal</span><strong>${number(s.activity)} <small>/ 100</small></strong></div><div class="small-stat"><span>Observed movement</span><strong>${number(s.movement)}${s.movement==null?'':' <small>% of matched tracks</small>'}</strong></div><div class="small-stat"><span>Sound activity</span><strong>${number(s.audio_activity)}${s.audio_activity==null?'':' <small>% of audio samples</small>'}</strong></div><div class="small-stat"><span>Longest observed stillness</span><strong>${s.longest_still==null?'—':durationLabel(s.longest_still)}</strong></div></div><div class="insight-detail-grid"><div>${chartCard(session)}<section class="card section-space"><div class="table-header"><div><div class="card-kicker">DECISION SUPPORT</div><h2 class="card-title">Teaching suggestions</h2><p class="card-subtitle">Transparent rules, with the evidence shown</p></div><div class="assistant-head-icon">${svg('sparkle')}</div></div>${details}</section></div><div><section class="card card-pad"><div class="card-kicker">UNDER THE HOOD</div><h2 class="card-title">How to read the signals</h2><p class="card-subtitle">Simple heuristics, not a trained engagement model.</p><div class="divider"></div><div class="signal-row"><span>Moving matched tracks</span><strong>${s.movement==null?'Not available':`${number(s.movement)}% average`}</strong></div><div class="signal-row"><span>Sound above threshold</span><strong>${s.audio_activity==null?'Not enabled / available':`${number(s.audio_activity)}% of samples`}</strong></div><div class="signal-row"><span>Approximate face tilt</span><strong>${s.mean_tilt==null?'Not available':`${number(s.mean_tilt)}° avg (${s.tilt_samples} samples)`}</strong></div><div class="signal-row"><span>Samples collected</span><strong>${s.samples}</strong></div><div class="divider"></div><div class="card-kicker">PROTOTYPE FORMULA</div><ul class="calc-list"><li><strong>65%</strong> moving fraction of matched visible tracks</li><li><strong>35%</strong> sound-active samples</li><li>Weights are normalized when a signal is missing.</li><li>Face tilt is a rough 2D eye-line angle, not gaze or full head pose; it is not used in the score.</li></ul><div class="inline-note section-space">${svg('info')}<span>The index is illustrative and unvalidated. Camera movement, occlusion, accessibility needs and ambient noise can change it.</span></div></section><section class="card card-pad section-space"><div class="card-kicker">YOUR ROLE</div><h2 class="card-title">You make the call.</h2><p class="card-subtitle">The assistant suggests, never decides. Pair any prompt with your own classroom context and learner feedback.</p><button class="button button-ghost section-space" data-action="guide">See limitations ${svg('arrow-right')}</button></section></div></div>`;
}
function sessionsPage(){
  const tiles=state.sessions.map(s=>`<section class="card session-tile"><div class="session-tile-top"><div class="session-icon">${svg(s.source==='video'?'upload':s.source==='demo'?'folder':'camera')}</div>${badge(s)}</div><h3>${esc(s.name)}</h3><p>${esc(s.section||'No section')}<br>${formatDate(s.created_at)} &nbsp;·&nbsp; ${durationLabel(s.duration)}</p><div class="session-tile-footer"><span>${s.stats.roster_total?`${s.stats.present} / ${s.stats.roster_total} present`:`${s.stats.qualified_tracks} qualified tracks`}</span><div class="session-tile-actions"><button class="button button-ghost button-sm" data-action="open-session" data-id="${esc(s.id)}">Open ${svg('arrow-right')}</button><button class="row-icon-btn" data-action="delete-session" data-id="${esc(s.id)}" aria-label="Delete ${esc(s.name)}">${svg('trash')}</button></div></div></section>`).join('');
  return `${pageHeading('YOUR CLASSROOM HISTORY','Sessions','All session metadata stays where this server is running.',`<button class="button button-primary" data-action="new-session">${svg('plus')} New session</button>`)}${hostedNotice()}<div class="session-list">${tiles}<button class="new-tile" data-action="new-session">${svg('plus')}<span>Create a new session</span></button></div><div class="inline-note section-space">${svg('shield')}<span><strong>Storage reminder:</strong> the app saves roster names, attendance, timestamps, and numeric signals locally on the server. They are not encrypted by this prototype.</span></div>`;
}
function settingsPage(){
  const s=state.settings||{presence_threshold:10,sample_interval:2,detector:'face',audio_threshold:0.02};
  return `${pageHeading('MAKE IT YOURS','Settings','Set sensible defaults for new sessions and understand your data.')}<div class="settings-grid"><div><section class="card settings-card"><div class="card-kicker">SESSION DEFAULTS</div><h3>Capture preferences</h3><p>Changes apply to new sessions; existing sessions keep their original settings.</p><form id="settings-form"><div class="settings-form"><div class="form-field"><label for="setting-presence">Presence threshold (seconds)</label><input class="input" id="setting-presence" name="presence_threshold" type="number" min="2" max="600" step="1" value="${esc(s.presence_threshold)}" required><span class="field-hint">Minimum observed time before a track qualifies.</span></div><div class="form-field"><label for="setting-interval">Sampling interval (seconds)</label><input class="input" id="setting-interval" name="sample_interval" type="number" min="1" max="10" step="1" value="${esc(s.sample_interval)}" required><span class="field-hint">A longer interval uses less processing power.</span></div><div class="form-field"><label for="setting-detector">Visual detector</label><select class="input" name="detector" id="setting-detector"><option value="face" ${s.detector==='face'?'selected':''}>Frontal face (seated)</option><option value="body" ${s.detector==='body'?'selected':''}>Full body (standing)</option></select><span class="field-hint">Neither detector recognizes identities.</span></div><div class="form-field"><label for="setting-audio">Sound threshold (RMS)</label><input class="input" id="setting-audio" name="audio_threshold" type="number" min=".001" max=".5" step=".001" value="${esc(s.audio_threshold)}" required><span class="field-hint">Energy threshold from 0.001 to 0.5.</span></div></div><div class="divider"></div><button class="button button-primary" type="submit">Save preferences</button></form></section><section class="card settings-card section-space"><div class="card-kicker">SAMPLE DATA</div><h3>Start fresh with the demo</h3><p>Restore the fictional example without affecting your other sessions.</p><button class="button button-secondary section-space" data-action="restore-demo">Restore demo session</button></section></div><div><section class="card settings-card"><div class="card-kicker">PRIVACY &amp; SAFETY</div><h3>Local-first, with you in control</h3><p>Use only with informed consent and the institution's applicable policies.</p><div class="privacy-list"><div class="privacy-line">${svg('check')}<div><strong>No raw media storage</strong>Video frames are processed in memory; audio is reduced to a numeric level in the browser.</div></div><div class="privacy-line">${svg('check')}<div><strong>No identity recognition</strong>Tracks are anonymous. Names require your manual assignment.</div></div><div class="privacy-line">${svg('check')}<div><strong>Works offline after setup</strong>No cloud services or external APIs are needed at runtime when run locally.</div></div><div class="privacy-line">${svg('info')}<div><strong>Prototype limitations</strong>Local JSON and CSV exports are not encrypted; there is no login or access control. Do not deploy as-is in a real institution.</div></div></div></section>${!localHost?`<div class="hosted-note section-space">${svg('info')}<span>This is a hosted preview; private media should only be processed after running the project locally.</span></div>`:''}</div></div>`;
}

function capturePage(session){
  if(!session) return emptyWorkspace();
  if(session.status!=='open') return `${pageHeading('SESSION CAPTURE','This session is complete.','Completed and demo sessions cannot receive new frames.')}<button class="button button-primary" data-action="new-session">${svg('plus')} Start a new session</button>`;
  const video=session.source==='video';
  return `${pageHeading('READY TO OBSERVE','Capture a session','Use a camera or video with permission. Tracking is anonymous.',`<button class="button button-secondary" data-action="nav" data-page="overview">${svg('arrow-left')} Back to overview</button><button class="button button-primary" data-action="finish-capture">Finish &amp; view summary ${svg('arrow-right')}</button>`)}${hostedNotice()}${sessionStrip(session)}<div class="capture-grid"><section class="card card-pad"><div class="card-header"><div><div class="card-kicker">${video?'RECORDED VIDEO':'LIVE CAMERA'}</div><h2 class="card-title">Capture preview</h2><p class="card-subtitle">${video?'The video is analyzed during normal playback.':'Frames are sampled every '+session.sample_interval+' seconds.'}</p></div><span class="badge badge-open"><span class="mini-dot"></span> ${esc(session.detector==='face'?'FACE DETECTOR':'BODY DETECTOR')}</span></div><div class="capture-stage section-space"><div id="capture-placeholder" class="capture-placeholder"><div class="capture-placeholder-icon">${svg(video?'upload':'camera')}</div><strong>${video?'Choose a video to begin':'Your camera is off'}</strong><p>${video?'Select a local video file, then press Start analysis. The full file is not uploaded.':'Press Start camera when you are ready. Your browser will ask for permission.'}</p></div><div class="video-wrapper hidden" id="video-wrapper"><video id="live-video" playsinline muted></video><canvas id="live-overlay" aria-label="Anonymous detection boxes"></canvas></div></div><div class="capture-controls"><button class="button button-primary" id="capture-start" data-action="start-capture">${svg('play')} ${video?'Start analysis':'Start camera'}</button><button class="button button-secondary" id="capture-pause" data-action="pause-capture" disabled>${svg('pause')} Pause capture</button><span class="capture-status" id="capture-status"><span class="status-dot"></span><span id="capture-status-text">Ready to start</span></span></div><div class="capture-error" id="capture-error" role="alert"></div><div class="hint-box"><strong>How to match learners:</strong> boxes show temporary track IDs while capturing. Note each ID and then assign it to a name in Attendance. IDs can swap or split, especially with occlusion. Pausing or restarting creates new IDs.</div></section><section class="card card-pad"><div class="card-kicker">CAPTURE CONTROLS</div><h2 class="card-title">Session signals</h2><p class="card-subtitle">Only numeric signals and anonymous track metadata are saved.</p><div class="capture-options">${video?`<div class="form-field"><label for="capture-file">Video file</label><input class="input-file" id="capture-file" type="file" accept="video/*"><span class="field-hint">Playback speed is 1×. Your file stays in your browser; sampled frames go to the server.</span><div style="margin-top:9px"><button type="button" class="button button-secondary button-sm" id="sample-video-button" data-action="sample-video">${svg('play')} Use synthetic test clip</button></div><span class="field-hint" id="sample-selection">14 seconds · fictional AI portrait and generated tone.</span></div>`:''}<label class="checkbox-line"><input type="checkbox" id="capture-audio"><span><strong>Include ${video?'video audio':'microphone'} activity</strong><br>Optional; measures sound energy only. No speech is recorded or transcribed.</span></label><div class="field-hint">${video?'A video without an audio track may appear silent.':'Allow microphone permission only if everyone has agreed.'}</div></div><div class="capture-counter-grid"><div class="capture-counter"><span>VISIBLE NOW</span><strong id="capture-visible">—</strong></div><div class="capture-counter"><span>QUALIFIED</span><strong id="capture-qualified">${number(session.stats.qualified_tracks)}</strong></div><div class="capture-counter"><span>ELAPSED</span><strong id="capture-elapsed">${elapsed(session.duration)}</strong></div></div><div class="live-prompt" id="capture-prompt">${capturePrompt(session.suggestions)}</div><div class="divider"></div><div class="card-kicker">RECENT ANONYMOUS TRACKS</div><div class="capture-track-list" id="capture-tracks">${captureTrackRows(session.tracks)}</div><div class="inline-note section-space">${svg('info')}<span>Detections can miss people or create duplicate tracks. Review all attendance manually.</span></div></section></div>`;
}
function capturePrompt(suggestions){
  const tip=suggestions?.[0];
  if(!tip)return `<div class="card-kicker">LIVE TEACHING PROMPT</div><strong>Waiting for observations</strong><p>Suggestions will appear as samples are collected.</p>`;
  return `<div class="card-kicker">LIVE TEACHING PROMPT · RULE-BASED</div><strong>${esc(tip.title)}</strong><p>${esc(tip.body)}</p><span>${esc(tip.evidence)}</span>`;
}
function captureTrackRows(tracks){
  if(!tracks?.length) return `<div class="table-empty">No tracks yet. Start a capture.</div>`;
  return [...tracks].slice(-12).reverse().map(t=>`<div class="capture-track"><strong>${esc(t.id)}</strong><span>${durationLabel(t.seen_seconds)} observed</span>${t.qualified?presencePill('present'):presencePill('unmarked')}</div>`).join('');
}
function captureError(message){
  const el=document.getElementById('capture-error');
  if(el){el.textContent=message;el.classList.toggle('visible',!!message);}
}
function setCaptureUi(active, status){
  const start=document.getElementById('capture-start'), pause=document.getElementById('capture-pause');
  if(start)start.disabled=active;
  if(pause)pause.disabled=!active;
  const c=document.getElementById('capture-status'); if(c)c.classList.toggle('active',active);
  const t=document.getElementById('capture-status-text'); if(t)t.textContent=status;
  const file=document.getElementById('capture-file'), audio=document.getElementById('capture-audio'), sampleButton=document.getElementById('sample-video-button');
  if(file)file.disabled=active;
  if(audio)audio.disabled=active;
  if(sampleButton)sampleButton.disabled=active;
}
function waitForMetadata(video){
  if(video.readyState>=1)return Promise.resolve();
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{cleanup();reject(new Error('Video could not be loaded. Try another browser or video format.'));},15000);
    const good=()=>{cleanup();resolve();}; const bad=()=>{cleanup();reject(new Error('This video format is not supported by your browser.'));};
    const cleanup=()=>{clearTimeout(timer);video.removeEventListener('loadedmetadata',good);video.removeEventListener('error',bad);};
    video.addEventListener('loadedmetadata',good,{once:true});video.addEventListener('error',bad,{once:true});
  });
}
async function startCapture(){
  const session=state.session;
  if(!session||session.status!=='open'||state.capture?.active) return;
  const video=document.getElementById('live-video');
  const includeAudio=!!document.getElementById('capture-audio')?.checked;
  const fileInput=document.getElementById('capture-file');
  if(session.source==='video'&&!state.sampleVideo&&!fileInput?.files?.length){captureError('Choose a video file or the synthetic test clip first.');return;}
  if(session.source==='camera'&&(!navigator.mediaDevices||!navigator.mediaDevices.getUserMedia)){
    captureError('Camera access requires localhost or HTTPS and browser permission. Run locally or open the preview in a compatible browser.');return;
  }
  captureError('');
  const startButton=document.getElementById('capture-start'); if(startButton)startButton.disabled=true;
  let stream=null, objectUrl=null, audioContext=null, analyser=null;
  try {
    if(session.source==='camera'){
      stream=await navigator.mediaDevices.getUserMedia({video:{width:{ideal:640},height:{ideal:480}},audio:includeAudio});
      if(state.page!=='capture'||state.session?.id!==session.id){stream.getTracks().forEach(t=>t.stop());return;}
      video.srcObject=stream; video.muted=true;
    } else {
      if(state.sampleVideo) video.src='/static/sample.webm';
      else { objectUrl=URL.createObjectURL(fileInput.files[0]); video.src=objectUrl; }
      video.muted=true;
      await waitForMetadata(video);
    }
    // Dropping ephemeral state prevents a resumed capture from silently continuing an old identity.
    state.session=await api(`/api/sessions/${session.id}/pause`,{method:'POST',body:{media_kind:state.sampleVideo && session.source==='video'?'synthetic':'user'}});
    if(includeAudio){
      try {
        const AudioCtx=window.AudioContext||window.webkitAudioContext;
        if(!AudioCtx)throw new Error('Audio activity is not supported in this browser.');
        audioContext=new AudioCtx();
        analyser=audioContext.createAnalyser();analyser.fftSize=2048;
        if(session.source==='camera'){
          if(!stream.getAudioTracks().length)throw new Error('No microphone track was available.');
          audioContext.createMediaStreamSource(stream).connect(analyser);
        } else {
          // Analyze the media element before a zero-gain output; raw audio never leaves the browser.
          const source=audioContext.createMediaElementSource(video);
          const silent=audioContext.createGain(); silent.gain.value=0;
          source.connect(analyser);analyser.connect(silent);silent.connect(audioContext.destination);
          video.muted=false;
        }
        await audioContext.resume();
      } catch(err){
        if(audioContext)await audioContext.close().catch(()=>{});
        audioContext=null;analyser=null;video.muted=true;
        toast('Audio unavailable; continuing with video only.',true);
      }
    }
    if(state.page!=='capture'||state.session?.id!==session.id){
      if(stream)stream.getTracks().forEach(t=>t.stop()); if(objectUrl)URL.revokeObjectURL(objectUrl);
      if(audioContext)audioContext.close().catch(()=>{});return;
    }
    document.getElementById('capture-placeholder').classList.add('hidden');
    document.getElementById('video-wrapper').classList.remove('hidden');
    await video.play();
    const base=session.last_sample ? Math.max(session.duration, session.last_sample.t+session.sample_interval) : 0;
    const cap={sessionId:session.id,active:true,stream,objectUrl,audioContext,analyser,video,
      source:session.source,base,startedAt:performance.now(),lastSent:session.last_sample?.t ?? -1,
      interval:session.sample_interval,pending:null,timer:null};
    state.capture=cap;
    setCaptureUi(true,session.source==='video'?'Analyzing video':'Camera active');
    if(session.source==='video')video.onended=async()=>{
      if(state.capture===cap && cap.active){
        await stopCapture(true);
        toast('Video analysis complete. Review the session summary.');
        await refreshIndex(); await navigate('overview');
      }
    };
    cap.timer=setInterval(()=>sampleFrame(cap),session.sample_interval*1000);
    sampleFrame(cap);
  } catch(err){
    if(stream)stream.getTracks().forEach(t=>t.stop());
    if(objectUrl)URL.revokeObjectURL(objectUrl);
    if(audioContext)audioContext.close().catch(()=>{});
    video.srcObject=null;video.removeAttribute('src');
    const wrapper=document.getElementById('video-wrapper'); if(wrapper)wrapper.classList.add('hidden');
    const placeholder=document.getElementById('capture-placeholder'); if(placeholder)placeholder.classList.remove('hidden');
    setCaptureUi(false,'Ready to start');
    const msg=err.name==='NotAllowedError'?'Permission was denied. Allow camera or microphone access in your browser, or turn off audio.':err.name==='NotFoundError'?'No compatible camera or microphone was found.':err.message||'Could not start capture.';
    captureError(msg);
  }
}
function audioRms(analyser){
  if(!analyser)return null;
  const values=new Float32Array(analyser.fftSize);analyser.getFloatTimeDomainData(values);
  let sum=0;for(const v of values)sum+=v*v;
  return Math.min(1,Math.sqrt(sum/values.length));
}
async function blobFromCanvas(canvas){return new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',.72));}
async function sampleFrame(cap){
  if(!cap.active||cap.pending||cap.video.readyState<2)return;
  const time=cap.base+(cap.source==='video'?cap.video.currentTime:(performance.now()-cap.startedAt)/1000);
  if(time<=cap.lastSent+.01)return;
  cap.pending=(async()=>{
    const video=cap.video,w=video.videoWidth,h=video.videoHeight;
    if(!w||!h)return;
    const canvas=document.createElement('canvas');
    canvas.width=Math.min(640,w);canvas.height=Math.max(1,Math.round(h*canvas.width/w));
    const ctx=canvas.getContext('2d');ctx.drawImage(video,0,0,canvas.width,canvas.height);
    const blob=await blobFromCanvas(canvas);if(!blob)throw new Error('Could not sample the video frame.');
    const rms=audioRms(cap.analyser);
    const headers={'Content-Type':'image/jpeg','X-Elapsed':time.toFixed(2)};
    if(rms!=null)headers['X-Audio-RMS']=rms.toFixed(5);
    const data=await api(`/api/sessions/${cap.sessionId}/frame`,{method:'POST',headers,body:blob});
    cap.lastSent=time;
    if(cap.active&&state.capture===cap){
      drawDetections(data.detections,video);
      const visible=document.getElementById('capture-visible');if(visible)visible.textContent=number(data.sample.visible);
      const qualified=document.getElementById('capture-qualified');if(qualified)qualified.textContent=number(data.stats.qualified_tracks);
      const elapsedEl=document.getElementById('capture-elapsed');if(elapsedEl)elapsedEl.textContent=elapsed(data.sample.t);
      const tracks=document.getElementById('capture-tracks');if(tracks)tracks.innerHTML=captureTrackRows(data.tracks);
      const prompt=document.getElementById('capture-prompt');if(prompt)prompt.innerHTML=capturePrompt(data.suggestions);
    }
  })();
  try{await cap.pending;}catch(err){if(cap.active){captureError(err.message||'Frame processing failed.');toast('Frame processing failed.',true);}}finally{cap.pending=null;}
}
function drawDetections(detections,video){
  const overlay=document.getElementById('live-overlay');if(!overlay)return;
  overlay.width=video.videoWidth;overlay.height=video.videoHeight;
  const ctx=overlay.getContext('2d');ctx.clearRect(0,0,overlay.width,overlay.height);
  const fontSize=Math.max(12,Math.round(overlay.width/45));
  ctx.font=`600 ${fontSize}px sans-serif`;ctx.lineWidth=Math.max(2,overlay.width/300);
  for(const d of detections||[]){
    const [x,y,w,h]=d.box;const xx=x*overlay.width,yy=y*overlay.height,ww=w*overlay.width,hh=h*overlay.height;
    ctx.strokeStyle='#b3e6ba';ctx.strokeRect(xx,yy,ww,hh);
    const label=d.track_id||'Track',labelW=ctx.measureText(label).width+10, labelH=fontSize+8;
    ctx.fillStyle='#285f4a';ctx.fillRect(xx,Math.max(0,yy-labelH),labelW,labelH);
    ctx.fillStyle='#ffffff';ctx.fillText(label,xx+5,Math.max(fontSize+2,yy-5));
  }
}
async function stopCapture(finish){
  const cap=state.capture;
  let finalElapsed=null;
  if(cap){
    finalElapsed=cap.base+(cap.source==='video'?cap.video.currentTime:(performance.now()-cap.startedAt)/1000);
    cap.active=false;clearInterval(cap.timer);cap.video.onended=null;cap.video.pause();
    if(cap.pending)try{await cap.pending;}catch{}
    if(cap.stream)cap.stream.getTracks().forEach(t=>t.stop());
    if(cap.audioContext)await cap.audioContext.close().catch(()=>{});
    if(cap.objectUrl)URL.revokeObjectURL(cap.objectUrl);
    cap.video.srcObject=null;cap.video.removeAttribute('src');
    // A MediaElementSource may only be created once per video element. Replace it
    // after a pause so an opted-in recording can be resumed with audio again.
    const freshVideo=cap.video.cloneNode(false); freshVideo.muted=true;
    cap.video.replaceWith(freshVideo);
    state.capture=null;
  }
  const session=state.session;if(!session||session.status!=='open')return;
  try{
    state.session=await api(`/api/sessions/${session.id}/${finish?'close':'pause'}`,{method:'POST',body:finalElapsed==null?{}:{duration:finalElapsed}});
    setCaptureUi(false,finish?'Completed':'Paused');
    const wrapper=document.getElementById('video-wrapper');if(wrapper)wrapper.classList.add('hidden');
    const placeholder=document.getElementById('capture-placeholder');if(placeholder)placeholder.classList.remove('hidden');
  }catch(err){toast(err.message,true);}
}

function setModal(html){
  modalRoot.innerHTML=html;
  document.body.style.overflow='hidden';
  setTimeout(()=>modalRoot.querySelector('input:not([type=radio]):not([type=checkbox]),button')?.focus(),0);
}
function closeModal(){modalRoot.innerHTML='';document.body.style.overflow='';state.confirmFn=null;}
function modalShell(kicker,title,subtitle,body,footer='',wide=false,formId=''){
  return `<div class="modal-backdrop" data-action="modal-backdrop"><${formId?'form':'div'} ${formId?`id="${esc(formId)}"`:''} class="modal ${wide?'modal-wide':''}" role="dialog" aria-modal="true" aria-labelledby="modal-title"><div class="modal-header"><div><div class="eyebrow green">${esc(kicker)}</div><h2 id="modal-title">${esc(title)}</h2><p>${esc(subtitle)}</p></div><button class="modal-close" type="button" data-action="close-modal" aria-label="Close">${svg('close')}</button></div><div class="modal-body">${body}<div class="form-error" id="modal-error" role="alert"></div></div><div class="modal-footer">${footer}</div></${formId?'form':'div'}></div>`;
}
function showModalError(message){const el=document.getElementById('modal-error');if(el){el.textContent=message;el.classList.add('visible');}else toast(message,true);}
function openNewSession(){
  const s=state.settings||{presence_threshold:10,sample_interval:2,detector:'face'};
  const body=`<div class="form-grid"><div class="form-field full"><label for="new-name">Session name *</label><input class="input" id="new-name" name="name" placeholder="e.g. Foundations of Data Science" maxlength="100" required></div><div class="form-field full"><label for="new-section">Section or description <span class="field-hint">(optional)</span></label><input class="input" id="new-section" name="section" placeholder="e.g. Section A · Monday" maxlength="100"></div><div class="form-field full"><span class="form-label">What would you like to analyze?</span><div class="source-choices"><div class="source-choice"><input type="radio" name="source" id="source-camera" value="camera" checked><label for="source-camera">${svg('camera')}<span><strong>Live camera</strong><small>Sample a camera feed</small></span></label></div><div class="source-choice"><input type="radio" name="source" id="source-video" value="video"><label for="source-video">${svg('upload')}<span><strong>Video file</strong><small>Analyze during playback</small></span></label></div></div></div><div class="form-field"><label for="new-threshold">Presence threshold (seconds)</label><input class="input" id="new-threshold" name="presence_threshold" type="number" value="${esc(s.presence_threshold)}" min="2" max="600" required><span class="field-hint">A track must be observed for this long.</span></div><div class="form-field"><label for="new-detector">Visual detector</label><select class="input" id="new-detector" name="detector"><option value="face" ${s.detector==='face'?'selected':''}>Frontal faces · seated</option><option value="body" ${s.detector==='body'?'selected':''}>Full bodies · standing</option></select><span class="field-hint">Anonymous, best-effort detection.</span></div><div class="form-field full"><label for="new-roster">Learner names <span class="field-hint">(optional, one per line)</span></label><textarea class="textarea" id="new-roster" name="roster" placeholder="Add names now, or add them later in Attendance"></textarea><span class="field-hint">Names are matched to track IDs manually, never by facial recognition.</span></div><div class="form-field full"><label class="checkbox-line"><input type="checkbox" name="consent" required><span><strong>I have permission</strong> to process this session and will follow my institution's consent and privacy policies.</span></label></div></div>${!localHost?`<div class="hosted-note section-space">${svg('info')}<span>This preview is hosted. Run locally before processing any private footage.</span></div>`:''}`;
  setModal(modalShell('A NEW LEARNING SPACE','Create a session','First, tell us a little about the session.',body,`<button type="button" class="button button-secondary" data-action="close-modal">Cancel</button><button type="submit" class="button button-primary">Create session ${svg('arrow-right')}</button>`,true,'new-session-form'));
}
function openAddLearner(){
  const body=`<div class="form-grid"><div class="form-field full"><label for="learner-name">Learner name *</label><input class="input" id="learner-name" name="name" maxlength="100" placeholder="Enter a name" required></div><div class="form-field full"><label for="learner-code">Learner ID <span class="field-hint">(optional)</span></label><input class="input" id="learner-code" name="code" maxlength="80" placeholder="e.g. ST-001"></div></div><div class="inline-note section-space">${svg('info')}<span>Adding a learner does not automatically match them to a camera detection.</span></div>`;
  setModal(modalShell('ADD TO ROSTER','Add a learner','You can match a track or mark attendance after adding them.',body,`<button type="button" class="button button-secondary" data-action="close-modal">Cancel</button><button type="submit" class="button button-primary">Add learner</button>`,false,'add-learner-form'));
}
function openGuide(){
  const body=`<div class="guide-step"><span class="guide-step-number">01</span><div><strong>Explore the fictional sample</strong><p>The default session, learner names and numbers are simulated. Nothing in the sample was collected from a classroom.</p></div></div><div class="guide-step"><span class="guide-step-number">02</span><div><strong>Capture with permission</strong><p>Start a session and select a live camera or video. OpenCV detects frontal faces or full bodies and tracks their approximate positions. Frames are processed in memory.</p></div></div><div class="guide-step"><span class="guide-step-number">03</span><div><strong>Review the roster yourself</strong><p>A track qualifies after the configured observed time. Track IDs are not identities and can switch, split or be missed. Match them manually; an unmarked person is not automatically absent.</p></div></div><div class="guide-step"><span class="guide-step-number">04</span><div><strong>Use signals as prompts, not judgments</strong><p>Movement and optional short sound-level samples produce an unvalidated illustrative index. Approximate eye-line tilt is only 2D roll, not gaze or full head pose. None of these signals measures attention, emotion or learning.</p></div></div><div class="guide-step"><span class="guide-step-number">05</span><div><strong>Keep people in control</strong><p>Suggestions follow transparent rules, not a generative AI model. Review them in context. Store files securely, explain data practices and obtain consent; the prototype has no login or encryption.</p></div></div>${!localHost?`<div class="hosted-note section-space">${svg('info')}<span><strong>Hosted preview:</strong> sampled frames are sent to the server. Download and run locally for private footage.</span></div>`:''}`;
  setModal(modalShell('THE SHORT VERSION','How Classroom Lens works','A prototype designed to support—not replace—your judgment.',body,`<button class="button button-primary" type="button" data-action="close-modal">Got it</button>`,true));
}
function openConfirm(title,body,callback,destructive=false){
  state.confirmFn=callback;
  setModal(modalShell('PLEASE CONFIRM',title,body,'',`<button type="button" class="button button-secondary" data-action="close-modal">Cancel</button><button type="button" class="button ${destructive?'button-danger':'button-primary'}" data-action="confirm-yes">${destructive?'Delete':'Continue'}</button>`));
}
async function exportAttendance(){
  if(!state.session)return;
  try{
    const response=await fetch(`/api/sessions/${encodeURIComponent(state.session.id)}/export.csv`);
    if(!response.ok)throw new Error('Could not export attendance.');
    const blob=await response.blob(), url=URL.createObjectURL(blob),a=document.createElement('a');
    a.href=url;a.download=`attendance-${state.session.id}.csv`;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),10000);
    toast('Attendance CSV downloaded.');
  }catch(err){toast(err.message,true);}
}
function render(){
  const labels={overview:'Overview',attendance:'Attendance',engagement:'Engagement',sessions:'Sessions',settings:'Settings',capture:'Capture'};
  document.getElementById('breadcrumb').textContent=labels[state.page]||'Overview';
  document.querySelectorAll('.nav-item[data-page]').forEach(el=>el.classList.toggle('active',el.dataset.page===state.page));
  if(state.page==='overview')content.innerHTML=overview(state.session);
  else if(state.page==='attendance')content.innerHTML=attendance(state.session);
  else if(state.page==='engagement')content.innerHTML=engagement(state.session);
  else if(state.page==='sessions')content.innerHTML=sessionsPage();
  else if(state.page==='settings')content.innerHTML=settingsPage();
  else if(state.page==='capture'){state.sampleVideo=false;content.innerHTML=capturePage(state.session);}
  else content.innerHTML=overview(state.session);
}
async function applySessionMutation(result){state.session=result;await refreshIndex();render();}

// A single delegated handler keeps dynamic views and controls functional without external libraries.
document.addEventListener('click',async event=>{
  const el=event.target.closest('[data-action]'); if(!el)return;
  const action=el.dataset.action;
  if(['select-session','change-track','change-status','attendance-filter','attendance-search'].includes(action))return;
  if(action==='modal-backdrop' && event.target!==el)return;
  event.preventDefault();
  try{
    if(action==='nav'){await navigate(el.dataset.page);}
    else if(action==='new-session')openNewSession();
    else if(action==='guide'||action==='privacy')openGuide();
    else if(action==='open-sidebar'){document.getElementById('sidebar').classList.add('open');document.getElementById('mobile-scrim').classList.add('open');}
    else if(action==='close-sidebar'){document.getElementById('sidebar').classList.remove('open');document.getElementById('mobile-scrim').classList.remove('open');}
    else if(action==='close-modal'||action==='modal-backdrop')closeModal();
    else if(action==='confirm-yes'){
      const callback=state.confirmFn;el.disabled=true;
      try{if(callback)await callback();closeModal();}catch(err){el.disabled=false;showModalError(err.message);}
    }
    else if(action==='add-learner')openAddLearner();
    else if(action==='export')await exportAttendance();
    else if(action==='sample-video'){
      state.sampleVideo=true; const file=document.getElementById('capture-file');if(file)file.value='';
      const label=document.getElementById('sample-selection');if(label)label.textContent='Synthetic test clip selected · AI portrait and generated tone.';
      captureError('');toast('Synthetic test clip selected.');
    }
    else if(action==='start-capture')await startCapture();
    else if(action==='pause-capture'){await stopCapture(false);await refreshIndex();toast('Capture paused. Resuming creates new track IDs.');}
    else if(action==='finish-capture'){
      openConfirm('Finish this session?','Capture will stop. You can still review the attendance and export the results.',async()=>{
        await stopCapture(true);await refreshIndex();await navigate('overview');toast('Session completed.');
      });
    }
    else if(action==='open-session'){
      if(state.capture?.active)await stopCapture(false);
      await selectSession(el.dataset.id,false);await navigate('overview');
    }
    else if(action==='delete-session'){
      const id=el.dataset.id,entry=state.sessions.find(s=>s.id===id);
      openConfirm('Delete this session?',`“${entry?.name||'This session'}” and its local attendance and signal records will be removed. This cannot be undone.`,async()=>{
        if(state.capture?.active && state.capture.sessionId===id)await stopCapture(false);
        await api(`/api/sessions/${encodeURIComponent(id)}`,{method:'DELETE'});await refreshIndex();
        if(state.session?.id===id)await selectSession(state.sessions[0]?.id,false);
        render();toast('Session deleted.');
      },true);
    }
    else if(action==='remove-learner'){
      const row=state.session.roster_rows.find(r=>r.id===el.dataset.id);
      openConfirm('Remove this learner?',`Remove ${row?.name||'this learner'} from the roster? The anonymous track, if any, will remain.`,async()=>{
        const result=await api(`/api/sessions/${state.session.id}/roster/${encodeURIComponent(row.id)}`,{method:'DELETE'});
        await applySessionMutation(result);toast('Learner removed.');
      },true);
    }
    else if(action==='restore-demo'){
      openConfirm('Restore the demo session?','The fictional sample will be reset. Your other sessions will not be changed.',async()=>{
        const demo=await api('/api/demo/restore',{method:'POST',body:{}});state.session=demo;safeStorage.set('classroom-lens-session',demo.id);await refreshIndex();await navigate('overview');toast('Fictional demo restored.');
      });
    }
  }catch(err){toast(err.message||'Something went wrong.',true);}
});

document.addEventListener('change',async event=>{
  if(event.target.id==='capture-file'){state.sampleVideo=false;const label=document.getElementById('sample-selection');if(label)label.textContent='Your selected file will be used. Sample clip is available above.';return;}
  const el=event.target.closest('[data-action]');if(!el)return;
  const action=el.dataset.action;
  try{
    if(action==='select-session'){
      if(state.capture?.active)await stopCapture(false);
      await selectSession(el.value,false);
      if(state.page==='capture')state.page='overview';
      state.attendanceSearch='';state.attendanceFilter='all';render();
    } else if(action==='attendance-filter'){state.attendanceFilter=el.value;updateAttendanceBody();}
    else if(action==='change-track'||action==='change-status'){
      const payload=action==='change-track'?{track_id:el.value||null}:{manual_status:el.value};
      const result=await api(`/api/sessions/${state.session.id}/roster/${encodeURIComponent(el.dataset.id)}`,{method:'PATCH',body:payload});
      await applySessionMutation(result);toast(action==='change-track'?'Track assignment updated.':'Attendance override updated.');
    }
  }catch(err){toast(err.message,true);render();}
});
document.addEventListener('input',event=>{
  if(event.target.dataset.action==='attendance-search'){state.attendanceSearch=event.target.value;updateAttendanceBody();}
});
document.addEventListener('submit',async event=>{
  const form=event.target;if(!['new-session-form','add-learner-form','settings-form'].includes(form.id))return;
  event.preventDefault();
  const btn=form.querySelector('button[type=submit]');if(btn)btn.disabled=true;
  try{
    const data=new FormData(form);
    if(form.id==='new-session-form'){
      const roster=String(data.get('roster')||'').split(/\r?\n/).map(n=>n.trim()).filter(Boolean);
      const payload={name:data.get('name'),section:data.get('section')||'',source:data.get('source'),roster,
        consent:data.has('consent'),settings:{presence_threshold:Number(data.get('presence_threshold')),detector:data.get('detector')}};
      const session=await api('/api/sessions',{method:'POST',body:payload});
      if(state.capture?.active)await stopCapture(false);
      state.session=session;safeStorage.set('classroom-lens-session',session.id);await refreshIndex();closeModal();await navigate('capture');toast('Session created. Ready to capture.');
    } else if(form.id==='add-learner-form'){
      const result=await api(`/api/sessions/${state.session.id}/roster`,{method:'POST',body:{name:data.get('name'),code:data.get('code')||''}});
      closeModal();await applySessionMutation(result);toast('Learner added.');
    } else {
      state.settings=await api('/api/settings',{method:'PATCH',body:{presence_threshold:Number(data.get('presence_threshold')),
        sample_interval:Number(data.get('sample_interval')),detector:data.get('detector'),audio_threshold:Number(data.get('audio_threshold'))}});
      render();toast('Preferences saved for new sessions.');
    }
  }catch(err){if(form.id==='settings-form')toast(err.message,true);else showModalError(err.message);if(btn)btn.disabled=false;}
});
document.addEventListener('keydown',event=>{if(event.key==='Escape'){if(modalRoot.innerHTML)closeModal();else{document.getElementById('sidebar').classList.remove('open');document.getElementById('mobile-scrim').classList.remove('open');}}});
window.addEventListener('beforeunload',()=>{if(state.capture?.stream)state.capture.stream.getTracks().forEach(t=>t.stop());});

(async function init(){
  try{
    await refreshIndex();
    const saved=safeStorage.get('classroom-lens-session');
    const selected=state.sessions.find(s=>s.id===saved)||state.sessions.find(s=>s.id==='demo-session')||state.sessions[0];
    if(selected)await selectSession(selected.id,false);
    const hash=location.hash.replace('#','');
    state.page=['overview','attendance','engagement','sessions','settings'].includes(hash)?hash:'overview';
    render();
  }catch(err){content.innerHTML=`<div class="card card-pad"><h2 class="card-title">Could not load the workspace</h2><p class="card-subtitle">${esc(err.message)}. Make sure the local server is running, then refresh.</p></div>`;}
})();
