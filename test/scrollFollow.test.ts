import { describe, expect, it } from "vitest";
import { ScrollFollow } from "../src/ui/chatView/webview/scrollFollow.js";

function setup(scrollTop = 900) {
  const state = { autoScroll: true };
  const position = { scrollTop, scrollHeight: 1000, clientHeight: 100 };
  const follow = new ScrollFollow(state);
  follow.reset(true, position);
  return { state, position, follow };
}

describe("chat scroll following", () => {
  it("pauses on the first upward input before the browser moves or a render runs", () => {
    const { state, position, follow } = setup();
    follow.userIntent(-1, position);
    expect(state.autoScroll).toBe(false);
    follow.recordLayout(position);
    follow.onScroll(position); // Delayed event from the preceding automatic jump.
    expect(state.autoScroll).toBe(false);
    position.scrollTop -= 40;
    follow.onScroll(position);
    expect(state.autoScroll).toBe(false);
  });

  it("notices upward native scrolling before its scroll event arrives", () => {
    const { state, position, follow } = setup();
    position.scrollTop -= 60;
    follow.onScroll(position); // Render's preflight position check.
    expect(state.autoScroll).toBe(false);
  });

  it("does not resume on rendering, content growth, or a layout that clamps to bottom", () => {
    const { state, position, follow } = setup();
    follow.userIntent(-1, position);
    position.scrollTop = 450;
    follow.onScroll(position);
    follow.endGesture();
    position.scrollHeight += 300;
    follow.recordLayout(position);
    follow.onScroll(position);
    expect(state.autoScroll).toBe(false);
    position.scrollHeight = 400;
    position.scrollTop = 300;
    follow.recordLayout(position);
    follow.onScroll(position);
    expect(state.autoScroll).toBe(false);
  });

  it("resumes only when downward user movement reaches the bottom", () => {
    const { state, position, follow } = setup(400);
    follow.pause();
    follow.userIntent(1, position);
    position.scrollTop = 897;
    follow.onScroll(position);
    expect(state.autoScroll).toBe(false);
    position.scrollTop = 900;
    follow.onScroll(position);
    expect(state.autoScroll).toBe(true);
  });

  it("allows downward input at an already reached bottom to resume following", () => {
    const { state, position, follow } = setup();
    follow.pause();
    follow.userIntent(1, position);
    expect(state.autoScroll).toBe(true);
  });

  it("does not treat delayed programmatic scroll events as manual movement", () => {
    const { state, position, follow } = setup();
    position.scrollHeight += 100;
    position.scrollTop = 1000;
    follow.recordLayout(position);
    follow.userIntent(-1, position);
    follow.onScroll(position);
    expect(state.autoScroll).toBe(false);
  });

  it("keeps following off throughout a scrollbar drag, even at the bottom", () => {
    const { state, position, follow } = setup();
    follow.beginDrag(position);
    position.scrollTop = 700;
    follow.onScroll(position);
    position.scrollTop = 900;
    follow.onScroll(position);
    expect(state.autoScroll).toBe(false);
    follow.endDrag(position);
    expect(state.autoScroll).toBe(true);
  });

  it("leaves following paused after a drag ends above the bottom", () => {
    const { state, position, follow } = setup();
    follow.beginDrag(position);
    position.scrollTop = 700;
    follow.endDrag(position);
    expect(state.autoScroll).toBe(false);
  });

  it("preserves downward touch momentum until the bottom is reached", () => {
    const { state, position, follow } = setup(400);
    follow.userIntent(1, position);
    for (const scrollTop of [500, 700, 850, 900]) {
      position.scrollTop = scrollTop;
      follow.onScroll(position);
    }
    follow.endGesture();
    expect(state.autoScroll).toBe(true);
  });

  it("resets gesture state for explicit jumps and restored chat views", () => {
    const { state, position, follow } = setup();
    follow.beginDrag(position);
    follow.reset(true, position);
    expect(state.autoScroll).toBe(true);
    expect(follow.dragging).toBe(false);
    follow.reset(false, { ...position, scrollTop: 400 });
    follow.onScroll({ ...position, scrollTop: 400 });
    expect(state.autoScroll).toBe(false);
  });
});
