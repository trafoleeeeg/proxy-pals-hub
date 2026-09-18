const test = require("node:test");
const assert = require("node:assert/strict");
const { sanitizeBrowserSettings } = require("../runtime/browser-settings.cjs");

const ID = "10000000-0000-4000-8000-000000000001";

test("cloud browser settings accept only bounded safe data", () => {
  const settings = sanitizeBrowserSettings({
    profileId: ID,
    bookmarks: [{ id: ID, title: "Почта", url: "https://mail.google.com/" }, { title: "bad", url: "file:///tmp/x" }],
    bookmarkBarVisible: false,
    zoomLevel: 1,
    extensions: [
      { id: "aaaaaaaaaaaaaaaaaaaaaaaa", url: "https://chromewebstore.google.com/detail/example/abcdefghijklmnopqrstuvwx", pinned: true },
      { id: "../../bad", url: "https://example.test/extension.crx", pinned: true },
    ],
    revision: 4,
  }, ID);
  assert.equal(settings.bookmarks.length, 1);
  assert.equal(settings.extensions.length, 1);
  assert.equal(settings.bookmarkBarVisible, false);
  assert.equal(settings.zoomLevel, 1);
});

test("cloud browser settings reject another profile and invalid revisions", () => {
  assert.equal(sanitizeBrowserSettings({ profileId: crypto.randomUUID(), revision: 1, zoomLevel: 0 }, ID), null);
  assert.equal(sanitizeBrowserSettings({ profileId: ID, revision: -1, zoomLevel: 0 }, ID), null);
});