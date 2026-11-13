/** Trusted content-script decoration. Nothing is inserted into the editor document. */
export interface GhostBinding {
  anchor: HTMLElement;
  snapshot(): { suggestion: string | null; generationId: string | null; eligible: boolean; compact: boolean };
  accept(): boolean;
  dismiss(): void;
}
const bindings = new Map<HTMLElement, GhostBinding>();
let refresh = () => {};
export function registerGhost(binding: GhostBinding): () => void {
  bindings.set(binding.anchor, binding); refresh();
  return () => { bindings.delete(binding.anchor); refresh(); };
}
export function refreshGhost() { refresh(); }

export function mountGhostDecorations(doc: Document): () => void {
  const win = doc.defaultView!;
  const style = doc.createElement("style");
  style.textContent = `
    [data-composer-prediction-swipe] { touch-action:pan-y pinch-zoom; }
    [data-composer-prediction-active] p.is-editor-empty:first-child::before { content: none !important; }
    [data-composer-prediction-ghost] { position:absolute; pointer-events:none; user-select:none; white-space:pre-wrap; overflow:hidden; color:var(--muted-foreground); opacity:.65; z-index:1; }
    [data-composer-prediction-ghost]:not([hidden]) { display:flex; align-items:baseline; }
    [data-composer-prediction-ghost] span { min-width:0; overflow:hidden; display:-webkit-box; -webkit-box-orient:vertical; }
    [data-composer-prediction-ghost] kbd { flex-shrink:0; margin-left:.65em; padding:0 .35em; border:1px solid currentColor; border-radius:4px; font:10px/1.5 ui-monospace,monospace; opacity:.8; white-space:nowrap; }
    [data-composer-prediction-ghost] .prediction-swipe-hint { display:none; }
    @media (pointer:coarse) {
      [data-composer-prediction-ghost] .prediction-tab-hint { display:none; }
      [data-composer-prediction-ghost] .prediction-swipe-hint { display:block; }
    }
  `;
  doc.head.append(style);
  type Decoration = { editor: HTMLElement; update(): void; dispose(): void };
  const decorations = new Map<HTMLElement, Decoration>();
  let disposed = false;
  let frame: number | null = null;

  function decorate(binding: GhostBinding, editor: HTMLElement): Decoration {
    const parent = editor.parentElement!;
    // BB listens for sidebar gestures on document capture, before our editor
    // handlers. Reserve the padded text area up front while a ghost is visible.
    const swipeArea = editor.closest<HTMLElement>("[data-promptbox-editor-scroll]") ?? parent;
    const originalSidebarGuard = swipeArea.getAttribute("data-no-sidebar-swipe");
    function reserveSwipeArea(active: boolean) {
      swipeArea.toggleAttribute("data-composer-prediction-swipe", active);
      if (active) swipeArea.setAttribute("data-no-sidebar-swipe", originalSidebarGuard ?? "");
      else if (originalSidebarGuard !== null) swipeArea.setAttribute("data-no-sidebar-swipe", originalSidebarGuard);
      else swipeArea.removeAttribute("data-no-sidebar-swipe");
    }
    const originalPosition = parent.style.position;
    const positioned = win.getComputedStyle(parent).position === "static" || !win.getComputedStyle(parent).position;
    if (positioned) parent.style.position = "relative";
    const overlay = doc.createElement("div");
    overlay.dataset.composerPredictionGhost = "";
    overlay.setAttribute("aria-hidden", "true");
    overlay.inert = true;
    const text = doc.createElement("span");
    const key = doc.createElement("kbd"); key.textContent = "Tab / →"; key.className = "prediction-tab-hint";
    const swipeHint = doc.createElement("kbd"); swipeHint.textContent = "Swipe →"; swipeHint.className = "prediction-swipe-hint";
    overlay.append(text, key, swipeHint); parent.append(overlay);
    let composing = false;
    let dismissed = false;
    let lastGeneration: string | null = null;
    let visible = false;
    let swipe: { id: number; x: number; y: number; startedAt: number; generationId: string | null } | null = null;
    function update() {
      const state = binding.snapshot();
      if (state.generationId !== lastGeneration) { lastGeneration = state.generationId; dismissed = false; swipe = null; }
      const form = editor.closest("form[data-promptbox]");
      visible = state.eligible && !!state.suggestion && !composing && !dismissed && !editor.textContent?.trim() && editor.getAttribute("contenteditable") === "true" && !form?.hasAttribute("data-promptbox-voice-active");
      overlay.hidden = !visible;
      reserveSwipeArea(visible);
      if (!visible) { swipe = null; delete editor.dataset.composerPredictionActive; return; }
      editor.dataset.composerPredictionActive = "";
      if (text.textContent !== state.suggestion) text.textContent = state.suggestion;
      const font = win.getComputedStyle(editor);
      text.style.webkitLineClamp = state.compact ? "1" : "3";
      const box = editor.getBoundingClientRect();
      const container = parent.getBoundingClientRect();
      Object.assign(overlay.style, {
        left: `${box.left - container.left + parent.scrollLeft}px`, top: `${box.top - container.top + parent.scrollTop}px`,
        width: `${box.width}px`, font: font.font, lineHeight: font.lineHeight, letterSpacing: font.letterSpacing,
        maxHeight: `${(parseFloat(font.lineHeight) || parseFloat(font.fontSize) * 1.7 || 22) * (state.compact ? 1 : 3)}px`,
      });
    }
    function dismiss() {
      swipe = null; dismissed = true; visible = false; overlay.hidden = true;
      delete editor.dataset.composerPredictionActive;
      reserveSwipeArea(false);
      binding.dismiss();
    }
    function accept() {
      update();
      if (!visible || !binding.accept()) return false;
      swipe = null; dismissed = true; visible = false; overlay.hidden = true;
      delete editor.dataset.composerPredictionActive;
      reserveSwipeArea(false);
      return true;
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key === "Escape" && visible) { dismiss(); return; }
      // The ghost only shows in an empty editor, where → has no caret to move.
      if ((event.key !== "Tab" && event.key !== "ArrowRight") || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey || event.isComposing || event.keyCode === 229 || composing) return;
      if (!accept()) return;
      event.preventDefault(); event.stopImmediatePropagation();
    };
    const cancelSwipe = () => { swipe = null; };
    // A second finger may land outside this editor (for example, pinch zoom).
    const onAdditionalTouch = (event: TouchEvent) => { if (event.touches.length > 1) cancelSwipe(); };
    const onTouchStart = (event: TouchEvent) => {
      const alreadyTracking = swipe !== null;
      cancelSwipe(); update();
      if (alreadyTracking || event.defaultPrevented || !visible || event.touches.length !== 1) return;
      const target = event.target;
      if (!(target instanceof win.Element)) return;
      const control = target.closest("button, a, input, textarea, select, [role='button'], [role='slider'], [contenteditable]");
      if (control && control !== editor) return;
      const touch = event.touches[0];
      // Leave the browser's screen-edge navigation gesture alone.
      if (touch.clientX < 24 || touch.clientX > win.innerWidth - 24) return;
      swipe = { id: touch.identifier, x: touch.clientX, y: touch.clientY, startedAt: event.timeStamp, generationId: lastGeneration };
    };
    function displacement(event: TouchEvent, touch: Touch) {
      if (!swipe) return null;
      const dx = touch.clientX - swipe.x;
      const dy = Math.abs(touch.clientY - swipe.y);
      if (event.defaultPrevented || touch.identifier !== swipe.id || event.timeStamp - swipe.startedAt > 1000 || dx < -12 || dy > 24 || (dy > 12 && dy >= Math.abs(dx))) {
        cancelSwipe(); return null;
      }
      return { dx, dy };
    }
    const onTouchMove = (event: TouchEvent) => {
      update();
      if (event.touches.length !== 1) { cancelSwipe(); return; }
      const delta = displacement(event, event.touches[0]);
      if (!delta || delta.dx < 12 || delta.dx < delta.dy * 2) return;
      // Only claim a deliberate horizontal gesture. Vertical scrolling and
      // pinch zoom keep their native behaviour; acceptance waits for release.
      // With touch-action: pan-y, browsers can send non-cancelable horizontal
      // moves because there is no native horizontal pan left to prevent.
      if (event.cancelable) event.preventDefault();
    };
    const onTouchEnd = (event: TouchEvent) => {
      update();
      if (!swipe || event.touches.length !== 0 || event.changedTouches.length !== 1) { cancelSwipe(); return; }
      const generationId = swipe.generationId;
      const delta = displacement(event, event.changedTouches[0]);
      cancelSwipe();
      if (!delta || delta.dx < 48 || delta.dx < delta.dy * 2 || generationId !== lastGeneration) return;
      if (accept() && event.cancelable) event.preventDefault();
    };
    const onCompositionStart = () => { composing = true; dismiss(); update(); };
    const onCompositionEnd = () => { composing = false; update(); };
    editor.addEventListener("keydown", onKey, true);
    doc.addEventListener("touchstart", onAdditionalTouch, { capture: true, passive: true });
    swipeArea.addEventListener("touchstart", onTouchStart, { capture: true, passive: true });
    swipeArea.addEventListener("touchmove", onTouchMove, { capture: true, passive: false });
    swipeArea.addEventListener("touchend", onTouchEnd, { capture: true, passive: false });
    swipeArea.addEventListener("touchcancel", cancelSwipe, true);
    swipeArea.addEventListener("contextmenu", cancelSwipe, true);
    for (const event of ["beforeinput", "input", "paste", "drop"] as const) editor.addEventListener(event, dismiss, true);
    editor.addEventListener("compositionstart", onCompositionStart, true);
    editor.addEventListener("compositionend", onCompositionEnd, true);
    const Resize = win.ResizeObserver;
    const resize = Resize ? new Resize(update) : null;
    resize?.observe(editor); resize?.observe(parent);
    update();
    return {
      editor, update,
      dispose() {
        reserveSwipeArea(false);
        resize?.disconnect(); overlay.remove(); delete editor.dataset.composerPredictionActive;
        if (positioned && parent.style.position === "relative") parent.style.position = originalPosition;
        editor.removeEventListener("keydown", onKey, true);
        doc.removeEventListener("touchstart", onAdditionalTouch, true);
        cancelSwipe();
        swipeArea.removeEventListener("touchstart", onTouchStart, true);
        swipeArea.removeEventListener("touchmove", onTouchMove, true);
        swipeArea.removeEventListener("touchend", onTouchEnd, true);
        swipeArea.removeEventListener("touchcancel", cancelSwipe, true);
        swipeArea.removeEventListener("contextmenu", cancelSwipe, true);
        for (const event of ["beforeinput", "input", "paste", "drop"] as const) editor.removeEventListener(event, dismiss, true);
        editor.removeEventListener("compositionstart", onCompositionStart, true);
        editor.removeEventListener("compositionend", onCompositionEnd, true);
      },
    };
  }
  function sync() {
    if (disposed) return;
    for (const [anchor, decoration] of decorations) {
      if (!bindings.has(anchor) || !anchor.isConnected || !decoration.editor.isConnected) { decoration.dispose(); decorations.delete(anchor); }
    }
    for (const [anchor, binding] of bindings) {
      if (anchor.ownerDocument !== doc || !anchor.isConnected) continue;
      // A bridge lives inside its own composer's banner slot. Never pair editors by DOM order.
      const shell = anchor.closest("[data-promptbox-shell]");
      const editors = shell?.querySelectorAll<HTMLElement>("form[data-promptbox] [data-promptbox-editor-content] [contenteditable='true']");
      if (editors?.length !== 1) {
        decorations.get(anchor)?.dispose(); decorations.delete(anchor); continue;
      }
      const editor = editors[0];
      const current = decorations.get(anchor);
      if (current?.editor !== editor) { current?.dispose(); decorations.set(anchor, decorate(binding, editor)); }
      else current.update();
    }
  }
  refresh = sync;
  const observer = new win.MutationObserver(() => {
    if (frame !== null) return;
    frame = win.requestAnimationFrame(() => { frame = null; sync(); });
  });
  observer.observe(doc.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["contenteditable", "data-promptbox-voice-active"] });
  sync();
  return () => {
    disposed = true; observer.disconnect(); if (frame !== null) win.cancelAnimationFrame(frame);
    refresh = () => {}; decorations.forEach(decoration => decoration.dispose()); decorations.clear(); style.remove();
  };
}
