// Shared Animation Speed collection (oculist-mcpd): { delay, duration } from
// getComputedTiming() for every live WAAPI animation on every top-level
// .oc-beacon-transient element currently mounted -- some effects mount more than one
// (animateTrail's line/arrow/flash, animateHorseman's rider/pumpkin/four burst bands) --
// sorted by [delay, duration] so ties compare correctly across two independently-mounted
// instances (getAnimations() does not promise stable ordering; a uniform durFactor keeps
// interchangeable ties interchangeable).
//
// Plain and closure-free: callers pass it straight to page.evaluate(collectAnimationTimings),
// which stringifies and runs it in the page's own main-world context.
function collectAnimationTimings() {
  var timings = [];
  Array.prototype.forEach.call(document.querySelectorAll('.oc-beacon-transient'), function (root) {
    root.getAnimations({ subtree: true }).forEach(function (a) {
      var t = a.effect.getComputedTiming();
      timings.push({ delay: t.delay, duration: t.duration });
    });
  });
  return timings.sort(function (x, y) { return x.delay - y.delay || x.duration - y.duration; });
}

module.exports = { collectAnimationTimings };
