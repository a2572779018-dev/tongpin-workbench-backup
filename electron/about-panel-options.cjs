"use strict";

/**
 * Native "About 同频" panel content (app.setAboutPanelOptions).
 *
 * The office scene's floor/wall/furniture/character art comes from LimeZu's
 * "Modern Interiors" pack, whose license requires visible credit (see
 * THIRD_PARTY_NOTICES.md). That credit used to render as a line of text in
 * the office panel's own UI; the owner asked for it to move out of there, so
 * it now lives here instead — still visible to anyone who checks the app's
 * About panel, still satisfying the license, just out of the office's way.
 */

const LIMEZU_CREDIT = "办公室像素美术：LimeZu（limezu.itch.io）";

/**
 * Pure builder so the content can be unit-tested without booting Electron's
 * `app` module. `applicationVersion` is the caller's job to supply (normally
 * `app.getVersion()`), since this module never imports `electron` itself.
 */
function buildAboutPanelOptions({ applicationName = "同频", applicationVersion = "", credits = LIMEZU_CREDIT } = {}) {
  return {
    applicationName,
    applicationVersion,
    credits,
  };
}

module.exports = {
  LIMEZU_CREDIT,
  buildAboutPanelOptions,
};
