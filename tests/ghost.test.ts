import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { mountGhostDecorations, refreshGhost, registerGhost } from "../lib/ghost.ts";

function fixture() {
  const dom = new JSDOM(`<!doctype html><html><head></head><body><div data-promptbox-shell><span id="bridge"></span><form data-promptbox><div data-promptbox-editor-content><div contenteditable="true"><p class="is-editor-empty"><br></p></div></div></form></div></body></html>`, { pretendToBeVisual: true });
  const doc = dom.window.document;
  const editor = doc.querySelector<HTMLElement>("[contenteditable]")!;
  const anchor = doc.getElementById("bridge")!;
  let accepted = 0; let dismissed = 0; let eligible = true; let generationId = "one";
  const disposeScript = mountGhostDecorations(doc);
  const disposeBinding = registerGhost({ anchor, snapshot: () => ({ suggestion: "Show me the diff", generationId, eligible, compact: false }), accept: () => { accepted++; editor.textContent = "Show me the diff"; return true; }, dismiss: () => { dismissed++; eligible = false; } });
  const press = (key: string, options: KeyboardEventInit = {}) => {
    const event = new dom.window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...options });
    editor.dispatchEvent(event); return event;
  };
  const touch = (type: string, x = 80, y = 50, options: { count?: number; id?: number; time?: number; prevented?: boolean; cancelable?: boolean } = {}) => {
    const point = { identifier: options.id ?? 1, clientX: x, clientY: y };
    const event = new dom.window.Event(type, { bubbles: true, cancelable: options.cancelable ?? true });
    Object.defineProperties(event, {
      touches: { value: Array.from({ length: options.count ?? (type === "touchend" ? 0 : 1) }, (_, i) => ({ ...point, identifier: point.identifier + i })) },
      changedTouches: { value: [point] },
      timeStamp: { value: options.time ?? 100 },
    });
    if (options.prevented) event.preventDefault();
    editor.dispatchEvent(event); return event;
  };
  const dispose = () => { disposeBinding(); disposeScript(); };
  return { dom, doc, editor, anchor, press, touch, dispose, accepted: () => accepted, dismissed: () => dismissed, setEligible: (value: boolean) => { eligible = value; refreshGhost(); }, setGeneration: (value: string) => { generationId = value; refreshGhost(); }, cleanup: () => { dispose(); dom.window.close(); } };
}
test("ghost is outside the editor; only plain Tab accepts, never submits", () => {
  const f = fixture(); let submitted = 0;
  f.doc.querySelector("form")!.addEventListener("submit", () => submitted++);
  assert.equal(f.editor.textContent, "");
  assert.equal(f.editor.querySelector("[data-composer-prediction-ghost]"), null);
  for (const options of [{ shiftKey: true }, { ctrlKey: true }, { altKey: true }, { metaKey: true }, { isComposing: true }]) assert.equal(f.press("Tab", options).defaultPrevented, false);
  assert.equal(f.press("Enter").defaultPrevented, false);
  assert.equal(f.accepted(), 0);
  assert.equal(f.press("Tab").defaultPrevented, true);
  assert.equal(f.accepted(), 1); assert.equal(submitted, 0); assert.equal(f.editor.textContent, "Show me the diff");
  assert.equal(f.press("Tab").defaultPrevented, false);
  f.cleanup();
});
test("typing and IME dismiss immediately; a nonempty or unavailable composer cannot accept", () => {
  for (const event of ["beforeinput", "paste", "compositionstart"]) {
    const f = fixture(); f.editor.dispatchEvent(new f.dom.window.Event(event, { bubbles: true }));
    assert.equal(f.doc.querySelector<HTMLElement>("[data-composer-prediction-ghost]")!.hidden, true);
    assert.equal(f.press("Tab").defaultPrevented, false); assert.equal(f.dismissed(), 1); f.cleanup();
  }
  const f = fixture(); f.editor.textContent = "my own draft"; refreshGhost();
  assert.equal(f.press("Tab").defaultPrevented, false); assert.equal(f.accepted(), 0);
  f.editor.textContent = ""; f.setEligible(false); assert.equal(f.press("Tab").defaultPrevented, false); f.cleanup();
});
test("Escape dismisses without trapping focus and cleanup restores editor styling", () => {
  const f = fixture(); assert.ok(f.editor.hasAttribute("data-composer-prediction-active"));
  assert.equal(f.press("Escape").defaultPrevented, false); assert.equal(f.dismissed(), 1);
  f.cleanup();
  assert.equal(f.editor.hasAttribute("data-composer-prediction-active"), false);
  assert.equal(f.doc.querySelector("[data-composer-prediction-ghost]"), null);
});
test("bridge targets only its own composer, regardless of pane order", () => {
  const f = fixture();
  const other = f.doc.createElement("div"); other.setAttribute("data-promptbox-shell", "");
  other.innerHTML = '<form data-promptbox><div data-promptbox-editor-content><div contenteditable="true"></div></div></form>';
  f.doc.body.prepend(other); refreshGhost();
  const editor = other.querySelector("[contenteditable]")!;
  const event = new f.dom.window.KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }); editor.dispatchEvent(event);
  assert.equal(event.defaultPrevented, false); assert.equal(f.accepted(), 0);
  assert.equal(other.querySelector("[data-composer-prediction-ghost]"), null); f.cleanup();
});
test("ambiguous or moved composer shells release their old overlay and Tab handler", () => {
  const f = fixture();
  const duplicate = f.editor.cloneNode(true);
  f.editor.parentElement!.append(duplicate); refreshGhost();
  assert.equal(f.doc.querySelector("[data-composer-prediction-ghost]"), null);
  assert.equal(f.press("Tab").defaultPrevented, false);
  duplicate.parentNode!.removeChild(duplicate); refreshGhost();
  f.doc.body.append(f.anchor); refreshGhost();
  assert.equal(f.doc.querySelector("[data-composer-prediction-ghost]"), null);
  assert.equal(f.press("Tab").defaultPrevented, false); f.cleanup();
});
test("editing while generation is pending still notifies the composer bridge", () => {
  const f = fixture(); f.setEligible(false);
  f.editor.dispatchEvent(new f.dom.window.Event("beforeinput", { bubbles: true }));
  assert.equal(f.dismissed(), 1); f.cleanup();
});
test("read-only and voice-mode transitions hide the ghost without waiting for a React render", async () => {
  for (const mode of ["readonly", "voice"]) {
    const f = fixture();
    if (mode === "readonly") f.editor.setAttribute("contenteditable", "false");
    else f.editor.closest("form")!.setAttribute("data-promptbox-voice-active", "");
    await new Promise(resolve => f.dom.window.requestAnimationFrame(() => f.dom.window.requestAnimationFrame(resolve)));
    assert.equal(f.doc.querySelector<HTMLElement>("[data-composer-prediction-ghost]:not([hidden])"), null);
    assert.equal(f.editor.hasAttribute("data-composer-prediction-active"), false);
    assert.equal(f.press("Tab").defaultPrevented, false); f.cleanup();
  }
});
test("a Tab already handled by the host is not accepted again", () => {
  const f = fixture();
  f.doc.addEventListener("keydown", event => event.preventDefault(), { capture: true });
  f.press("Tab"); assert.equal(f.accepted(), 0); f.cleanup();
});
test("explicit regeneration can show the same words after a dismissal", () => {
  const f = fixture(); f.press("Escape"); f.setEligible(true);
  assert.equal(f.doc.querySelector<HTMLElement>("[data-composer-prediction-ghost]")!.hidden, true);
  f.setGeneration("two");
  assert.equal(f.doc.querySelector<HTMLElement>("[data-composer-prediction-ghost]")!.hidden, false); f.cleanup();
});

test("a right swipe inserts once on release without submitting", () => {
  const f = fixture(); let submitted = 0;
  f.doc.querySelector("form")!.addEventListener("submit", () => submitted++);
  assert.equal(f.touch("touchstart").defaultPrevented, false);
  assert.equal(f.touch("touchmove", 140, 55).defaultPrevented, true);
  assert.equal(f.accepted(), 0);
  assert.equal(f.touch("touchend", 150, 55).defaultPrevented, true);
  assert.equal(f.accepted(), 1); assert.equal(submitted, 0);
  assert.equal(f.editor.textContent, "Show me the diff");
  f.touch("touchend", 150, 55); assert.equal(f.accepted(), 1);
  f.cleanup();
});

test("taps, left swipes, vertical and diagonal scrolling are not accepted or prevented", () => {
  for (const [x, y] of [[80, 50], [40, 50], [85, 110], [140, 110]]) {
    const f = fixture(); f.touch("touchstart");
    assert.equal(f.touch("touchmove", x, y).defaultPrevented, false);
    assert.equal(f.touch("touchend", x, y).defaultPrevented, false);
    assert.equal(f.accepted(), 0); f.cleanup();
  }
});

test("short gestures, screen edges, long presses, pinch and cancelled gestures do not accept", () => {
  const scenarios: ((f: ReturnType<typeof fixture>) => void)[] = [
    f => { f.touch("touchstart"); f.touch("touchend", 110); },
    f => { f.touch("touchstart", 10); f.touch("touchend", 100); },
    f => { f.touch("touchstart", f.dom.window.innerWidth - 10); f.touch("touchend", f.dom.window.innerWidth + 50); },
    f => { f.touch("touchstart", 80, 50, { time: 0 }); f.touch("touchend", 150, 50, { time: 1100 }); },
    f => { f.touch("touchstart", 80, 50, { count: 2 }); f.touch("touchend", 150); },
    f => { f.touch("touchstart"); f.touch("touchmove", 120, 50, { count: 2 }); f.touch("touchend", 150); },
    f => { f.touch("touchstart"); f.touch("touchstart", 90, 50, { count: 2 }); f.touch("touchend", 150); },
    f => {
      f.touch("touchstart");
      const outside = new f.dom.window.Event("touchstart", { bubbles: true });
      Object.defineProperty(outside, "touches", { value: [{ identifier: 1 }, { identifier: 2 }] });
      f.doc.body.dispatchEvent(outside); f.touch("touchend", 150);
    },
    f => { f.touch("touchstart"); f.touch("touchcancel"); f.touch("touchend", 150); },
    f => { f.touch("touchstart"); f.editor.dispatchEvent(new f.dom.window.Event("contextmenu")); f.touch("touchend", 150); },
    f => { f.touch("touchstart"); f.touch("touchend", 150, 50, { id: 2 }); },
    f => { f.touch("touchstart"); f.touch("touchmove", 140, 50, { cancelable: false }); f.touch("touchend", 150); },
    f => { f.touch("touchstart"); f.touch("touchmove", 85, 70); f.touch("touchend", 150, 50); },
    f => { f.touch("touchstart"); f.touch("touchmove", 40, 50); f.touch("touchend", 150); },
    f => { f.touch("touchstart", 80, 50, { prevented: true }); f.touch("touchend", 150); },
    f => { f.touch("touchstart"); f.touch("touchend", 150, 50, { prevented: true }); },
  ];
  for (const scenario of scenarios) {
    const f = fixture(); scenario(f); assert.equal(f.accepted(), 0); f.cleanup();
  }
});

test("a swipe cannot accept a changed, hidden, read-only, composing or detached suggestion", () => {
  const changes: ((f: ReturnType<typeof fixture>) => void)[] = [
    f => f.setGeneration("replacement"),
    f => f.setEligible(false),
    f => { f.editor.textContent = "my draft"; },
    f => f.editor.setAttribute("contenteditable", "false"),
    f => f.editor.closest("form")!.setAttribute("data-promptbox-voice-active", ""),
    f => { f.editor.dispatchEvent(new f.dom.window.Event("compositionstart")); },
    f => { f.editor.dispatchEvent(new f.dom.window.Event("beforeinput")); },
    f => { f.doc.body.append(f.anchor); refreshGhost(); },
    f => f.dispose(),
  ];
  for (const change of changes) {
    const f = fixture(); f.touch("touchstart"); change(f);
    assert.equal(f.touch("touchend", 150).defaultPrevented, false);
    assert.equal(f.accepted(), 0); f.cleanup();
  }
});
