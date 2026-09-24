import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  buildPermissionNotificationArguments,
  escapeNotificationMarkup,
} from "./notificationText.ts"

describe("escapeNotificationMarkup", () => {
  it("shows command text without treating it as notification markup", () => {
    assert.equal(
      escapeNotificationMarkup(
        "<a href='https://example.test'>allow</a> & run",
      ),
      "&lt;a href='https://example.test'&gt;allow&lt;/a&gt; &amp; run",
    )
  })

  it("escapes existing entities before the notification parser reads them", () => {
    assert.equal(
      escapeNotificationMarkup("&lt;link&gt;"),
      "&amp;lt;link&amp;gt;",
    )
  })

  it("keeps untrusted body text after the end-of-options marker", () => {
    assert.deepEqual(
      buildPermissionNotificationArguments("--action=allow=Do not allow"),
      [
        "--app-name=OpenCode",
        "--wait",
        "--expire-time=0",
        "--action=allow=Allow once",
        "--",
        "OpenCode needs permission",
        "--action=allow=Do not allow",
      ],
    )
  })
})
