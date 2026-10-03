// Pins a beacon's WAAPI timeline for tests that read rendered state after the mount (oculist-ltsj,
// oculist-ns64). The effect self-removes on its own animation clock, so a read that lands after a
// stalled poll finds the element gone (a TimeoutError) or mid-fade. A main-world MutationObserver
// armed before the trigger pauses every animation at t=0 in the microtask after the mount, and
// latches window.__beaconMounted (and the tag names of the roots it saw, __beaconRootTags) so a
// caller can wait on the mount itself. Pass { freeze: false }
// to latch only (a test that needs the animation to run to its natural end).
async function armBeaconFreeze(page, { freeze = true } = {}) {
  await page.evaluate((doFreeze) => {
    if (window.__beaconFreeze) window.__beaconFreeze.disconnect();
    window.__beaconMounted = false;
    window.__beaconFreeze = new MutationObserver(() => {
      const roots = document.querySelectorAll('.oc-beacon-transient');
      if (roots.length && !window.__beaconMounted) {
        window.__beaconMounted = true;
        window.__beaconRootTags = Array.from(roots).map((r) => r.tagName.toLowerCase());
      }
      if (!doFreeze) return;
      roots.forEach((root) => {
        root.getAnimations({ subtree: true }).forEach((a) => { a.pause(); a.currentTime = 0; });
      });
    });
    window.__beaconFreeze.observe(document.documentElement, { childList: true, subtree: true });
  }, freeze);
}

async function disarmBeaconFreeze(page) {
  await page.evaluate(() => {
    if (window.__beaconFreeze) window.__beaconFreeze.disconnect();
    delete window.__beaconFreeze;
    delete window.__beaconMounted;
    delete window.__beaconRootTags;
  });
}

module.exports = { armBeaconFreeze, disarmBeaconFreeze };
