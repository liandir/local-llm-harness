import { describe, expect, it } from "vitest";
import {
  normalizeTodos,
  renderTodosMarkdown,
  todoCounts,
  MAX_TODOS,
  type TodoItem
} from "../src/chat/todos.js";

describe("normalizeTodos", () => {
  it("accepts the { todos: [...] } shape", () => {
    expect(normalizeTodos({ todos: [{ content: "a", status: "completed" }] }))
      .toEqual([{ content: "a", status: "completed" }]);
  });

  it("accepts a bare array", () => {
    expect(normalizeTodos([{ content: "a", status: "pending" }]))
      .toEqual([{ content: "a", status: "pending" }]);
  });

  it("accepts string items as pending", () => {
    expect(normalizeTodos({ todos: ["first", "second"] })).toEqual([
      { content: "first", status: "pending" },
      { content: "second", status: "pending" }
    ]);
  });

  it("drops items with empty content", () => {
    expect(normalizeTodos({ todos: [{ content: "  " }, { content: "keep" }] }))
      .toEqual([{ content: "keep", status: "pending" }]);
  });

  it("defaults a missing or unknown status to pending and maps synonyms", () => {
    expect(normalizeTodos({
      todos: [
        { content: "a" },
        { content: "b", status: "in-progress" },
        { content: "c", status: "DONE" },
        { content: "d", status: "weird" }
      ]
    })).toEqual([
      { content: "a", status: "pending" },
      { content: "b", status: "in_progress" },
      { content: "c", status: "completed" },
      { content: "d", status: "pending" }
    ]);
  });

  it("reads alternate content keys", () => {
    expect(normalizeTodos({ todos: [{ text: "via text" }, { task: "via task" }] }))
      .toEqual([
        { content: "via text", status: "pending" },
        { content: "via task", status: "pending" }
      ]);
  });

  it("returns an empty list for junk input", () => {
    expect(normalizeTodos(undefined)).toEqual([]);
    expect(normalizeTodos(42)).toEqual([]);
    expect(normalizeTodos({ nope: 1 })).toEqual([]);
  });

  it("caps the list at MAX_TODOS", () => {
    const many = Array.from({ length: MAX_TODOS + 10 }, (_, i) => ({ content: `t${i}` }));
    expect(normalizeTodos({ todos: many })).toHaveLength(MAX_TODOS);
  });
});

describe("todoCounts", () => {
  it("counts completed against total", () => {
    const todos: TodoItem[] = [
      { content: "a", status: "completed" },
      { content: "b", status: "in_progress" },
      { content: "c", status: "pending" }
    ];
    expect(todoCounts(todos)).toEqual({ done: 1, total: 3 });
  });
});

describe("renderTodosMarkdown", () => {
  it("checks completed items and flags the in-progress one", () => {
    const md = renderTodosMarkdown([
      { content: "done it", status: "completed" },
      { content: "doing it", status: "in_progress" },
      { content: "later", status: "pending" }
    ]);
    expect(md).toBe("- [x] done it\n- [ ] doing it (in progress)\n- [ ] later");
  });
});
