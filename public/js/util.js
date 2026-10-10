export const $ = (sel, root = document) => root.querySelector(sel);

export function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export function fmt(n, minus = '−') {
  const v = Math.round(Number(n) || 0);
  const s = Math.abs(v).toLocaleString('en-US');
  return v < 0 ? minus + s : s;
}

export const secs = (ms) => (Math.max(0, ms) / 1000).toFixed(ms < 10000 ? 1 : 0);

export function renderInto(root, html) {
  if (root.__html === html) return;
  root.__html = html;
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  morphChildren(root, tpl.content);
}

function sameKind(a, b) {
  if (a.nodeType !== b.nodeType || a.nodeName !== b.nodeName) return false;
  if (a.nodeType !== 1) return true;
  if ((a.id || '') !== (b.id || '')) return false;
  return a.nodeName !== 'INPUT' || a.type === b.type;
}

function morphChildren(from, to) {
  const oldNodes = [...from.childNodes];
  const newNodes = [...to.childNodes];
  newNodes.forEach((next, i) => {
    const cur = oldNodes[i];
    if (!cur) from.appendChild(next);
    else if (!sameKind(cur, next)) from.replaceChild(next, cur);
    else if (cur.nodeType === 1) morphElement(cur, next);
    else if (cur.nodeValue !== next.nodeValue) cur.nodeValue = next.nodeValue;
  });
  for (let i = newNodes.length; i < oldNodes.length; i++) oldNodes[i].remove();
}

function morphElement(cur, next) {
  for (const { name } of [...cur.attributes]) if (!next.hasAttribute(name)) cur.removeAttribute(name);
  for (const { name, value } of [...next.attributes]) if (cur.getAttribute(name) !== value) cur.setAttribute(name, value);
  if (cur.nodeName === 'BUTTON') cur.disabled = next.hasAttribute('disabled');
  if (cur.nodeName === 'INPUT' || cur.nodeName === 'TEXTAREA') return;
  morphChildren(cur, next);
}

export function startTimerLoop() {
  const tick = () => {
    const now = Date.now();
    document.querySelectorAll('[data-deadline]').forEach((el) => {
      const left = Math.max(0, Number(el.dataset.deadline) - now);
      const total = Number(el.dataset.total) || 1;
      if (el.dataset.countdown !== undefined) el.textContent = `${secs(left)} s`;
      else {
        const fill = el.firstElementChild;
        if (fill) fill.style.width = `${Math.min(100, (left / total) * 100)}%`;
      }
    });
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

export async function copyText(text, button) {
  try {
    await navigator.clipboard.writeText(text);
    if (button) {
      const which = `${button.dataset.act}|${button.dataset.kind || ''}`;
      if (button.__copyFor !== which) {
        button.__copyFor = which;
        button.__label = button.textContent;
      }
      clearTimeout(button.__copyTimer);
      button.textContent = 'Copied';
      button.__copyTimer = setTimeout(() => {
        if (button.__copyFor === `${button.dataset.act}|${button.dataset.kind || ''}`) button.textContent = button.__label;
      }, 1200);
    }
  } catch {
    window.prompt('Copy this link:', text);
  }
}

export const typingInField = (e) => {
  const t = e.target;
  return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
};
