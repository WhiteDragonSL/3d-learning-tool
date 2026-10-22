import { icon } from '../icons.js';
import { bus } from '../events.js';

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Fusion-style timeline: playback controls and one icon per step. Clicking a
// step (or using the controls) rolls the design back or forward to it.
export function buildTimeline(app) {
  const el = document.getElementById('timeline');
  const go = (i) => { app.cancelTools(); app.doc.goto(i); bus.emit('timeline', { index: i }); };

  const render = () => {
    const { history, index } = app.doc;
    const last = history.length - 1;
    el.innerHTML = `
      <div class="tl-controls">
        <button class="tl-btn" data-go="first" title="Go to start" ${index > 0 ? '' : 'disabled'}>${icon('first')}</button>
        <button class="tl-btn" data-go="prev" title="Step back (undo)" ${index > 0 ? '' : 'disabled'}>${icon('prev')}</button>
        <button class="tl-btn" data-go="next" title="Step forward (redo)" ${index < last ? '' : 'disabled'}>${icon('next')}</button>
        <button class="tl-btn" data-go="last" title="Go to end" ${index < last ? '' : 'disabled'}>${icon('last')}</button>
      </div>
      <div class="tl-track"></div>`;
    const track = el.querySelector('.tl-track');
    history.forEach((h, i) => {
      const item = document.createElement('button');
      item.className = 'tl-item' + (i === index ? ' current' : i > index ? ' future' : '');
      item.title = `${i}. ${h.label}${i === index ? ' (current)' : ' - click to roll back/forward to here'}`;
      item.innerHTML = icon(h.icon);
      item.onclick = () => go(i);
      track.appendChild(item);
      if (i === index) track.insertAdjacentHTML('beforeend', '<span class="tl-marker" title="Timeline marker"></span>');
    });
    const target = { first: 0, prev: index - 1, next: index + 1, last };
    for (const b of el.querySelectorAll('[data-go]')) b.onclick = () => go(target[b.dataset.go]);
    el.querySelector('.tl-marker')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    const cur = history[index];
    el.insertAdjacentHTML('beforeend', `<div class="tl-current">${esc(cur?.label || '')}</div>`);
  };
  bus.on('doc:changed', render);
  render();
}
