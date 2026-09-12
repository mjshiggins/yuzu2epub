/** popup.js - thin view over the service worker's job state. */

const $ = (id) => document.getElementById(id);

function show(which) {
  for (const k of ['idle', 'running', 'finished', 'failed']) {
    $(k).hidden = k !== which;
  }
}

function render(s) {
  if (!s) return;
  $('sub').textContent = s.title || 'Open a book in the Yuzu reader, then start.';

  if (s.status === 'running' || s.status === 'assembling') {
    show('running');
    $('phase').textContent = s.phase || '';
    const pct = s.total ? Math.round((s.current / s.total) * 100) : (s.status === 'assembling' ? 100 : 0);
    $('fill').style.width = `${pct}%`;
    $('counter').textContent = s.total ? `${s.current} / ${s.total} sections` : '';
  } else if (s.status === 'done') {
    show('finished');
    $('okmsg').textContent = `Saved ${s.filename}`;
    $('stats').textContent = s.message || '';
  } else if (s.status === 'error') {
    show('failed');
    $('errmsg').textContent = s.message || 'Something went wrong.';
  } else {
    show('idle');
  }

  const w = $('warnings');
  w.textContent = '';
  for (const line of (s.warnings || []).slice(-40)) {
    const d = document.createElement('div');
    d.textContent = line;
    w.appendChild(d);
  }
}

async function start() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !/^https?:\/\/reader\.yuzu\.com\//.test(tab.url || '')) {
    render({ status: 'error', message: 'Open the Yuzu reader on a book first, then click Build EPUB.' });
    return;
  }
  const res = await chrome.runtime.sendMessage({ type: 'y2e:start', tabId: tab.id });
  if (res && !res.ok) render({ status: 'error', message: res.error });
}

$('start').addEventListener('click', start);
$('retry').addEventListener('click', start);
$('again').addEventListener('click', start);
$('cancel').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'y2e:cancel' }));

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'y2e:state') render(msg.state);
});

chrome.runtime.sendMessage({ type: 'y2e:getState' }).then((r) => render(r && r.state));
