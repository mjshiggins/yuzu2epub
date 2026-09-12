/** popup.js - thin view over the service worker's job state. */

const $ = (id) => document.getElementById(id);
let tabId = null;

function show(which) {
  for (const k of ['idle', 'running', 'finished', 'failed']) $(k).hidden = k !== which;
}

function resumeLine(n) {
  return `${n} sections from an earlier run are cached, so this picks up at the assembly step.`;
}

function render(s) {
  if (!s) return;
  $('sub').textContent = s.title || 'Open a book in the Yuzu reader, then start.';

  if (s.status === 'running' || s.status === 'assembling') {
    show('running');
    $('phase').textContent = s.phase || '';
    const pct = s.total ? Math.round((s.current / s.total) * 100) : 0;
    $('fill').style.width = `${s.status === 'assembling' ? 100 : pct}%`;
    $('counter').textContent = s.total ? `${s.current} / ${s.total} sections` : '';
  } else if (s.status === 'done') {
    show('finished');
    $('okmsg').textContent = `Saved ${s.filename}`;
    $('stats').textContent = s.message || '';
  } else if (s.status === 'error') {
    show('failed');
    $('errmsg').textContent = s.message || 'Something went wrong.';
    $('retryhint').textContent = s.resumable ? resumeLine(s.resumable) : '';
  } else {
    show('idle');
    $('start').textContent = s.resumable ? 'Finish EPUB' : 'Build EPUB';
    $('fresh').hidden = !s.resumable;
    if (s.resumable) $('hint').textContent = resumeLine(s.resumable);
  }

  const w = $('warnings');
  w.textContent = '';
  for (const line of (s.warnings || []).slice(-40)) {
    const d = document.createElement('div');
    d.textContent = line;
    w.appendChild(d);
  }
}

async function start(fresh) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !/^https?:\/\/reader\.yuzu\.com\//.test(tab.url || '')) {
    render({ status: 'error', message: 'Open the Yuzu reader on a book first, then click Build EPUB.' });
    return;
  }
  tabId = tab.id;
  const res = await chrome.runtime.sendMessage({ type: 'y2e:start', tabId: tab.id, fresh: !!fresh });
  if (res && !res.ok) render({ status: 'error', message: res.error });
}

$('start').addEventListener('click', () => start(false));
$('retry').addEventListener('click', () => start(false));
$('again').addEventListener('click', () => start(true));
$('fresh').addEventListener('click', () => start(true));
$('cancel').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'y2e:cancel' }));

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'y2e:state') render(msg.state);
});

(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab ? tab.id : null;
  const r = await chrome.runtime.sendMessage({ type: 'y2e:getState', tabId });
  render(r && r.state);
})();
