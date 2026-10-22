// Fusion-style command dialog: floating panel with inputs, live preview and OK / Cancel.
let current = null;

// reason: 'user' when the person pressed Cancel / Esc, 'auto' when another command took over.
export function closeDialog(ok = false, reason = 'auto') {
  if (!current) return;
  const d = current;
  current = null;
  d.el.remove();
  if (ok) d.onOk?.(d.values());
  else d.onCancel?.(reason);
}

export function dialogOpen() { return !!current; }

/**
 * fields: [{ key, label, type: 'number'|'select'|'checkbox'|'color'|'text', value, min, max, step, options: [[value, label]] }]
 */
export function openDialog({ title, subtitle = '', help = '', fields = [], okLabel = 'OK', onChange, onOk, onCancel }) {
  closeDialog(false);
  const host = document.getElementById('dialog-host');
  const el = document.createElement('div');
  el.className = 'dialog';
  el.innerHTML = `
    <div class="dialog-head"><span>${title}</span><small>${subtitle}</small></div>
    <div class="dialog-body">${help ? `<div class="dialog-help">${help}</div>` : ''}</div>
    <div class="dialog-foot">
      <button class="btn" data-act="cancel">Cancel</button>
      <button class="btn primary" data-act="ok">${okLabel}</button>
    </div>`;
  const body = el.querySelector('.dialog-body');
  const inputs = {};

  for (const f of fields) {
    const row = document.createElement('div');
    row.className = 'field';
    const id = 'dlg-' + f.key.replace(/\W/g, '-');
    let input;
    if (f.type === 'select') {
      input = document.createElement('select');
      for (const [v, l] of f.options) input.add(new Option(l, v));
      input.value = f.value;
    } else {
      input = document.createElement('input');
      input.type = f.type || 'number';
      if (input.type === 'checkbox') input.checked = !!f.value;
      else input.value = f.type === 'number' || !f.type ? round(f.value) : f.value;
      if (f.min !== undefined) input.min = f.min;
      if (f.max !== undefined) input.max = f.max;
      input.step = f.step ?? 'any';
    }
    input.id = id;
    input.dataset.key = f.key;
    row.innerHTML = `<label for="${id}">${f.label}</label>`;
    row.appendChild(input);
    body.appendChild(row);
    inputs[f.key] = { input, f };
    input.addEventListener('input', () => onChange?.(values()));
    input.addEventListener('change', () => onChange?.(values()));
  }

  function values() {
    const out = {};
    for (const [k, { input, f }] of Object.entries(inputs)) {
      if (f.type === 'checkbox') out[k] = input.checked;
      else if (f.type === 'select' || f.type === 'color' || f.type === 'text') out[k] = input.value;
      else {
        let v = parseFloat(input.value);
        if (!Number.isFinite(v)) v = f.value;
        if (f.min !== undefined) v = Math.max(f.min, v);
        if (f.max !== undefined) v = Math.min(f.max, v);
        out[k] = v;
      }
    }
    return out;
  }

  el.querySelector('[data-act=ok]').onclick = () => closeDialog(true);
  el.querySelector('[data-act=cancel]').onclick = () => closeDialog(false, 'user');
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); closeDialog(true); }
    if (e.key === 'Escape') { e.preventDefault(); closeDialog(false, 'user'); }
    e.stopPropagation();
  });

  host.appendChild(el);
  current = { el, onOk, onCancel, values };
  const first = el.querySelector('input,select');
  if (first) setTimeout(() => { first.focus(); first.select?.(); }, 0);
  onChange?.(values());
  return {
    set(key, v) { const i = inputs[key]; if (i) { i.input.value = round(v); onChange?.(values()); } },
    setSilent(key, v) { const i = inputs[key]; if (i) i.input.value = round(v); },
    values,
  };
}

export const round = (v, d = 2) => (typeof v === 'number' ? Math.round(v * 10 ** d) / 10 ** d : v);

export function toast(msg, kind = '', ms = 2600) {
  const host = document.getElementById('toasts');
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.innerHTML = msg;
  host.appendChild(el);
  setTimeout(() => el.remove(), ms);
}
