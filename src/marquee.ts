interface Options {
  enabled(): boolean;
  selection(): Set<string>;
  update(ids: Set<string>): void;
}
export function installMarquee(root: HTMLElement, options: Options) {
  let suppressClick = false;
  let session: {
    pointer: number; gallery: HTMLElement; x: number; y: number; clientX: number; clientY: number;
    startX: number; startY: number; base: Set<string>; additive: boolean; active: boolean; box?: HTMLElement; items?: { id: string; x: number; y: number; width: number; height: number }[];
  } | undefined;
  let frame = 0;
  const update = () => {
    if (!session?.active) return;
    const { gallery } = session;
    const bounds = gallery.getBoundingClientRect();
    const x = session.clientX - bounds.left + gallery.scrollLeft;
    const y = session.clientY - bounds.top + gallery.scrollTop;
    const left = Math.min(session.x, x), top = Math.min(session.y, y);
    const right = Math.max(session.x, x), bottom = Math.max(session.y, y);
    Object.assign(session.box!.style, { left: `${left}px`, top: `${top}px`, width: `${right - left}px`, height: `${bottom - top}px` });
    const ids = new Set(session.additive ? session.base : []);
    for (const item of session.items ?? []) {
      if (item.x < right && item.x + item.width > left && item.y < bottom && item.y + item.height > top) ids.add(item.id);
    }
    options.update(ids);
  };
  const scroll = () => {
    if (!session?.active) return;
    const { gallery, clientY } = session;
    const bounds = gallery.getBoundingClientRect();
    if (clientY < bounds.top + 38) gallery.scrollTop -= Math.min(22, (bounds.top + 38 - clientY) / 3);
    if (clientY > bounds.bottom - 38) gallery.scrollTop += Math.min(22, (clientY - bounds.bottom + 38) / 3);
    update(); frame = requestAnimationFrame(scroll);
  };
  root.addEventListener('pointerdown', event => {
    if (event.button !== 0 || !options.enabled()) return;
    const target = event.target as HTMLElement;
    const gallery = target.closest<HTMLElement>('.gallery-scroll');
    if (!gallery || !gallery.querySelector('.photo-card') || (target.closest('button') && !target.closest('.photo-card'))) return;
    const rect = gallery.getBoundingClientRect();
    session = { pointer: event.pointerId, gallery, x: event.clientX - rect.left + gallery.scrollLeft,
      y: event.clientY - rect.top + gallery.scrollTop, clientX: event.clientX, clientY: event.clientY,
      startX: event.clientX, startY: event.clientY, base: new Set(options.selection()),
      additive: event.ctrlKey || event.metaKey || event.shiftKey, active: false };
  });
  document.addEventListener('pointermove', event => {
    if (!session || event.pointerId !== session.pointer) return;
    session.clientX = event.clientX; session.clientY = event.clientY;
    if (!session.active && Math.hypot(event.clientX - session.startX, event.clientY - session.startY) > 6) {
      session.active = true;
      const gallery = session.gallery;
      const bounds = gallery.getBoundingClientRect();
      session.items = [...gallery.querySelectorAll<HTMLElement>('.photo-card')].map(card => {
        const rect = card.getBoundingClientRect();
        return { id: card.dataset.photo!, x: rect.left - bounds.left + gallery.scrollLeft, y: rect.top - bounds.top + gallery.scrollTop, width: rect.width, height: rect.height };
      });
      session.gallery.setPointerCapture(event.pointerId);
      session.box = document.createElement('div'); session.box.className = 'selection-marquee';
      session.box.setAttribute('aria-hidden', 'true'); session.gallery.append(session.box);
      session.gallery.classList.add('is-selecting');
      frame = requestAnimationFrame(scroll);
    }
    if (session.active) { event.preventDefault(); update(); }
  });
  const finish = (event: PointerEvent) => {
    if (!session || event.pointerId !== session.pointer) return;
    if (session.active) {
      if (event.type === 'pointercancel') options.update(session.base); else update();
      suppressClick = true;
      setTimeout(() => { suppressClick = false; }, 0);
      session.box?.remove(); session.gallery.classList.remove('is-selecting');
      if (session.gallery.hasPointerCapture(event.pointerId)) session.gallery.releasePointerCapture(event.pointerId);
    }
    cancelAnimationFrame(frame); session = undefined;
  };
  document.addEventListener('pointerup', finish);
  document.addEventListener('pointercancel', finish);
  root.addEventListener('dragstart', event => { if ((event.target as HTMLElement).closest('.gallery-scroll')) event.preventDefault(); });
  return { get active() { return session?.active ?? false; }, consumeClick() { const value = suppressClick; suppressClick = false; return value; } };
}
