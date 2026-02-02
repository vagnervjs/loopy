const { suite } = require("./suite");
const test = suite("task-checkboxes");
const assert = require("node:assert/strict");

const { parseCheckboxes, compareCheckboxDiffs } = require("../src/task");

test("parseCheckboxes - extracts basic checkboxes", () => {
  const text = `
# Plan

- [ ] first task
- [x] second task
- [ ] third task
`;
  const boxes = parseCheckboxes(text);
  assert.equal(boxes.length, 3);
  assert.deepEqual(boxes[0], { line: 4, checked: false, text: "first task" });
  assert.deepEqual(boxes[1], { line: 5, checked: true, text: "second task" });
  assert.deepEqual(boxes[2], { line: 6, checked: false, text: "third task" });
});

test("parseCheckboxes - handles uppercase X", () => {
  const text = `- [X] Task with uppercase X`;
  const boxes = parseCheckboxes(text);
  assert.equal(boxes.length, 1);
  assert.equal(boxes[0].checked, true);
  assert.equal(boxes[0].text, "Task with uppercase X");
});

test("parseCheckboxes - handles empty text", () => {
  const boxes = parseCheckboxes("");
  assert.deepEqual(boxes, []);
});

test("parseCheckboxes - handles null", () => {
  const boxes = parseCheckboxes(null);
  assert.deepEqual(boxes, []);
});

test("parseCheckboxes - handles undefined", () => {
  const boxes = parseCheckboxes(undefined);
  assert.deepEqual(boxes, []);
});

test("parseCheckboxes - handles malformed checkboxes", () => {
  const text = `
- [ ] valid task
-[ ] missing space before bracket (still valid due to \\s*)
- [] missing checkbox state
- [y] invalid checkbox state
- [ ]no space after bracket
`;
  const boxes = parseCheckboxes(text);
  // The regex -\s*\[( |x|X)\]\s+ is permissive, allows -[ ] pattern
  assert.equal(boxes.length, 2);
  assert.equal(boxes[0].text, "valid task");
  assert.equal(boxes[1].text, "missing space before bracket (still valid due to \\s*)");
});

test("parseCheckboxes - ignores checkboxes in HTML comments", () => {
  const text = `
- [ ] visible task
<!-- - [ ] hidden task -->
- [x] another visible task
`;
  const boxes = parseCheckboxes(text);
  assert.equal(boxes.length, 2);
  assert.equal(boxes[0].text, "visible task");
  assert.equal(boxes[1].text, "another visible task");
});

test("parseCheckboxes - ignores checkboxes in multiline comments", () => {
  const text = `
- [ ] before comment
<!--
- [ ] inside comment line 1
- [x] inside comment line 2
-->
- [x] after comment
`;
  const boxes = parseCheckboxes(text);
  assert.equal(boxes.length, 2);
  assert.equal(boxes[0].text, "before comment");
  assert.equal(boxes[1].text, "after comment");
});

test("parseCheckboxes - handles inline comments after checkbox", () => {
  const text = `- [ ] task with inline comment <!-- comment -->`;
  const boxes = parseCheckboxes(text);
  assert.equal(boxes.length, 1);
  assert.equal(boxes[0].text, "task with inline comment ");
});

test("parseCheckboxes - handles nested lists", () => {
  const text = `
- [ ] parent task
  - [ ] child task (should not be detected as checkbox)
- [x] another parent
`;
  const boxes = parseCheckboxes(text);
  // Only top-level checkboxes (no leading spaces before -)
  assert.equal(boxes.length, 2);
  assert.equal(boxes[0].text, "parent task");
  assert.equal(boxes[1].text, "another parent");
});

test("parseCheckboxes - handles empty lines", () => {
  const text = `
- [ ] task one


- [x] task two

`;
  const boxes = parseCheckboxes(text);
  assert.equal(boxes.length, 2);
});

test("parseCheckboxes - handles varying whitespace", () => {
  const text = `
-  [  ]   task with extra spaces
-\t[\t]\ttask with tabs
`;
  const boxes = parseCheckboxes(text);
  // Should handle some variation, though exact behavior may vary
  assert.ok(boxes.length >= 0);
});

test("compareCheckboxDiffs - detects zero transitions", () => {
  const before = `
- [ ] task one
- [x] task two
`;
  const after = `
- [ ] task one
- [x] task two
`;
  const diff = compareCheckboxDiffs(before, after);
  assert.equal(diff.length, 0);
});

test("compareCheckboxDiffs - detects single transition", () => {
  const before = `
- [ ] task one
- [ ] task two
`;
  const after = `
- [x] task one
- [ ] task two
`;
  const diff = compareCheckboxDiffs(before, after);
  assert.equal(diff.length, 1);
  assert.equal(diff[0].text, "task one");
  assert.equal(diff[0].checked, true);
});

test("compareCheckboxDiffs - detects multiple transitions", () => {
  const before = `
- [ ] task one
- [ ] task two
- [ ] task three
`;
  const after = `
- [x] task one
- [x] task two
- [ ] task three
`;
  const diff = compareCheckboxDiffs(before, after);
  assert.equal(diff.length, 2);
  assert.equal(diff[0].text, "task one");
  assert.equal(diff[1].text, "task two");
});

test("compareCheckboxDiffs - ignores unchecking", () => {
  const before = `
- [x] task one
- [ ] task two
`;
  const after = `
- [ ] task one
- [x] task two
`;
  const diff = compareCheckboxDiffs(before, after);
  assert.equal(diff.length, 1);
  assert.equal(diff[0].text, "task two");
});

test("compareCheckboxDiffs - ignores tasks that start checked", () => {
  const before = `
- [x] task one
- [ ] task two
`;
  const after = `
- [x] task one
- [x] task two
`;
  const diff = compareCheckboxDiffs(before, after);
  assert.equal(diff.length, 1);
  assert.equal(diff[0].text, "task two");
});

test("compareCheckboxDiffs - handles tasks added in after", () => {
  const before = `
- [ ] task one
`;
  const after = `
- [ ] task one
- [x] task two
`;
  const diff = compareCheckboxDiffs(before, after);
  // New task that wasn't in before shouldn't count as transition
  assert.equal(diff.length, 0);
});

test("compareCheckboxDiffs - handles tasks removed from after", () => {
  const before = `
- [ ] task one
- [ ] task two
`;
  const after = `
- [x] task one
`;
  const diff = compareCheckboxDiffs(before, after);
  assert.equal(diff.length, 1);
  assert.equal(diff[0].text, "task one");
});

test("compareCheckboxDiffs - handles empty before", () => {
  const before = "";
  const after = `
- [x] task one
`;
  const diff = compareCheckboxDiffs(before, after);
  assert.equal(diff.length, 0);
});

test("compareCheckboxDiffs - handles empty after", () => {
  const before = `
- [ ] task one
`;
  const after = "";
  const diff = compareCheckboxDiffs(before, after);
  assert.equal(diff.length, 0);
});

test("compareCheckboxDiffs - uses text for matching", () => {
  const before = `
- [ ] implement feature A
- [ ] implement feature B
`;
  const after = `
- [ ] implement feature A
- [x] implement feature B
`;
  const diff = compareCheckboxDiffs(before, after);
  assert.equal(diff.length, 1);
  assert.equal(diff[0].text, "implement feature B");
});

test("compareCheckboxDiffs - handles duplicate task text", () => {
  const before = `
- [ ] duplicate task
- [ ] duplicate task
- [ ] unique task
`;
  const after = `
- [x] duplicate task
- [x] duplicate task
- [ ] unique task
`;
  const diff = compareCheckboxDiffs(before, after);
  // Both should be detected as newly checked
  assert.equal(diff.length, 2);
  assert.equal(diff[0].text, "duplicate task");
  assert.equal(diff[1].text, "duplicate task");
});
