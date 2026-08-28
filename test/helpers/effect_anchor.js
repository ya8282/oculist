// Independent source-of-truth positional check, shared by the four new beacon-effect
// suites (Speed Lines, Chrono Tunnel, Light Cycle, Cyber-Vision).
//
// Every one of those effects positions a shared .oc-beacon container from the match's own
// getBoundingClientRect() and then draws (or positions) everything else — streaks, rings,
// wall segments, brackets — relative to a single internal anchor computed once inside that
// effect's own function (e.g. content.js's `offsetY`). Nothing forces that internal anchor
// to stay consistent with where the container is actually placed on screen: an effect
// could shift its internal anchor away from the match while the container itself sits
// exactly where it should (a whole-effect offset), and every assertion that only reads the
// effect's own reported state back would still agree with itself (oculist-dvt.7).
//
// elementCenterInContainer() sidesteps that by never touching effect state: it reads the
// *live rendered* bounding boxes of two real DOM elements (getBoundingClientRect, after any
// CSS transform: scale(...) has resolved) and maps the first element's centre into the
// second element's own local coordinate space, by simple rect subtraction. That is exactly
// the coordinate space each effect's internal anchor (offsetY, vpCx, ...) is expressed in,
// so the two are directly comparable: a real, DOM-verified ground truth to grade a
// reported anchor against — modelled on how cyber_vision.test.js's own
// assertBracketsLandOnMatch() already grades bracket position against the match's rendered
// rect without trusting any internal bookkeeping.
//
// Two ways callers use this:
//   1. Compare the effect's own reported anchor (a window.__ocTest hook, e.g.
//      lastChronoAnchor = {matchX, matchY}) against
//      elementCenterInContainer(page, targetSelector, '.oc-beacon') — this is what Speed
//      Lines and Chrono Tunnel need, since neither draws a separate positioned DOM element
//      whose own rect would otherwise stand in for that anchor.
//   2. Compare two elements' local centres directly with no effect-side hook at all — e.g.
//      Light Cycle's outline box already carries its own real position
//      (elementCenterInContainer(page, '.oc-lightcycle-box', '.oc-beacon')) that can be
//      graded straight against the match's (elementCenterInContainer(page, '#target',
//      '.oc-beacon')) without content.js reporting anything extra.
//
// Only meaningful while beaconSize (getBeaconScale()) is 1 — the container's own
// transform: scale(...) is anchored at the effect's own internal anchor (transformOrigin),
// not at (0,0), so the container's post-transform getBoundingClientRect() only equals its
// pre-transform local coordinate space when that scale is exactly 1. Suites that sweep
// beaconSize (cyber_vision.test.js, light_cycle.test.js's right-angle test) already grade a
// scaled expectation directly against the match's viewport rect, which is the correct
// approach at non-1 scale; this helper is for the default-size case the other assertions
// exercise.
//
// Returns null (rather than throwing) if either selector fails to resolve, so a caller can
// assert on that directly and get a loud, specific failure instead of a downstream
// NaN/undefined comparison.
async function elementCenterInContainer(page, elementSelector, containerSelector) {
  return page.evaluate(
    ({ elementSelector, containerSelector }) => {
      var el = document.querySelector(elementSelector);
      var container = document.querySelector(containerSelector);
      if (!el || !container) return null;
      var r = el.getBoundingClientRect();
      var c = container.getBoundingClientRect();
      return { x: r.left + r.width / 2 - c.left, y: r.top + r.height / 2 - c.top };
    },
    { elementSelector, containerSelector }
  );
}

module.exports = { elementCenterInContainer };
