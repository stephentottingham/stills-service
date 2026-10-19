/** Small DOM helpers shared by the screens. */

export const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector(sel) as T;
export const $$ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) =>
  Array.from(root.querySelectorAll(sel)) as T[];

export function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

let toastTimer: number | undefined;
export function toast(msg: string) {
  const t = $('#toast');
  t.textContent = msg;
  t.style.display = 'block';
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (t.style.display = 'none'), 4000);
}

export function main(html: string): HTMLElement {
  const m = $('#main');
  m.innerHTML = html;
  return m;
}

export const COMPANIES: [string, string][] = [
  ['bigsmall', 'Big Small TV'],
  ['atspeed', 'At Speed Productions'],
  ['serpentine', 'Serpentine Creative'],
  ['happened', 'Happened'],
];

export const companyName = (id: string) => COMPANIES.find(([c]) => c === id)?.[1] ?? id;

export function companyOptions(selected?: string) {
  return COMPANIES.map(([id, name]) => `<option value="${id}"${id === selected ? ' selected' : ''}>${esc(name)}</option>`).join('');
}

export function formData(form: HTMLFormElement): Record<string, string> {
  return Object.fromEntries(new FormData(form) as any);
}

export function date(iso?: string) {
  return iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
}

export function dateTime(iso?: string) {
  return iso ? new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
}
