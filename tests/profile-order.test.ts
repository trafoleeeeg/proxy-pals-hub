import { describe, expect, test } from "bun:test";
import { reorderProfileRows } from "../src/lib/profile-order";

const rows = [
  { id: "a", folder: "Основная", sort_order: 1 },
  { id: "x", folder: "Команда", sort_order: 1 },
  { id: "b", folder: "Основная", sort_order: 2 },
  { id: "c", folder: "Основная", sort_order: 3 },
];

describe("profile ordering", () => {
  test("moves a profile up and down without disturbing another folder", () => {
    const up = reorderProfileRows(rows, "c", "a");
    expect(up?.ids).toEqual(["c", "a", "b"]);
    expect(up?.rows.map((row) => row.id)).toEqual(["c", "x", "a", "b"]);
    expect(up?.rows.map((row) => row.sort_order)).toEqual([1, 1, 2, 3]);
    const down = reorderProfileRows(up!.rows, "c", "b");
    expect(down?.ids).toEqual(["a", "b", "c"]);
  });

  test("ignores different folders and unchanged targets", () => {
    expect(reorderProfileRows(rows, "a", "x")).toBeNull();
    expect(reorderProfileRows(rows, "a", "a")).toBeNull();
    expect(reorderProfileRows(rows, "missing", "a")).toBeNull();
  });
});

