/** Loaded before React/Three. Counts actual GL submissions, including shadow passes. */
import { distribution, recordFrame, summarize } from './core.mjs';
const nativeRaf = window.requestAnimationFrame.bind(window);
const nativeGetContext = HTMLCanvasElement.prototype.getContext;
const instrumented = new WeakSet();
const probe = { frames: [], renderer: null, lastRenderAt: null, firstRenderAt: null, contexts: 0,
  hidden: false, contextLost: false, window: null, counter: null, outsideRafDrawCalls: 0, detachedContextLosses: 0, frameClockCalibration: null };
document.addEventListener('visibilitychange', () => { if (probe.window && document.visibilityState !== 'visible') probe.hidden = true; });
HTMLCanvasElement.prototype.getContext = function (...args) {
  const gl = nativeGetContext.apply(this, args);
  if (!gl || !['webgl', 'webgl2', 'experimental-webgl'].includes(args[0]) || instrumented.has(gl)) return gl;
  instrumented.add(gl); probe.contexts++;
  this.addEventListener('webglcontextlost', () => { if (this.isConnected) probe.contextLost = true; else probe.detachedContextLosses++; });
  const ext = gl.getExtension('WEBGL_debug_renderer_info');
  // A hasWebGL capability probe is detached. Identity must come from the scene canvas.
  const identity = () => ({ vendor: gl.getParameter(gl.VENDOR), renderer: gl.getParameter(gl.RENDERER),
    version: gl.getParameter(gl.VERSION), shadingLanguageVersion: gl.getParameter(gl.SHADING_LANGUAGE_VERSION),
    unmaskedVendor: ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : null,
    unmaskedRenderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : null,
    context: args[0], attributes: gl.getContextAttributes(), width: this.width, height: this.height });
  let identified = false;
  function wrap(target, name, instanceIndex) {
    if (typeof target[name] !== 'function') return;
    const original = target[name];
    target[name] = function (...drawArgs) {
      const result = original.apply(this, drawArgs);
      if (probe.counter) { probe.counter.drawCalls++; probe.counter.instances += instanceIndex === undefined ? 1 : drawArgs[instanceIndex]; }
      else probe.outsideRafDrawCalls++;
      if (!identified && gl.canvas.isConnected) { probe.renderer = identity(); identified = true; }
      return result;
    };
  }
  wrap(gl, 'drawArrays'); wrap(gl, 'drawElements');
  wrap(gl, 'drawArraysInstanced', 3); wrap(gl, 'drawElementsInstanced', 4);
  const angle = gl.getExtension('ANGLE_instanced_arrays');
  if (angle) { wrap(angle, 'drawArraysInstancedANGLE', 3); wrap(angle, 'drawElementsInstancedANGLE', 4); }
  return gl;
};
window.requestAnimationFrame = callback => nativeRaf(at => {
  const cpuStart = performance.now(), counter = { drawCalls: 0, instances: 0 };
  probe.counter = counter;
  try { callback(at); } finally {
    probe.counter = null;
    if (counter.drawCalls) {
      const previous = probe.lastRenderAt;
      probe.firstRenderAt ??= at;
      probe.lastRenderAt = at;
      if (probe.window) recordFrame(probe.frames, { at, previous, ...counter, cpuMs: performance.now() - cpuStart });
    }
  }
});
window.__gpuProbe = {
  calibrateFrameClock: () => new Promise(resolve => {
    const timestamps = []; let finished = false;
    const finish = () => {
      if (finished) return; finished = true; clearTimeout(timer);
      const intervals = distribution(timestamps.slice(1).map((at, i) => at - timestamps[i]));
      probe.frameClockCalibration = { intervals, estimatedHz: intervals.median > 0 ? 1000 / intervals.median : null,
        source: 'pre-scene rAF pacing estimate; headless uses a synthetic clock; not physical refresh-rate proof' };
      resolve(probe.frameClockCalibration);
    };
    const timer = setTimeout(finish, 5000);
    const collect = at => { if (finished) return; timestamps.push(at); if (timestamps.length >= 40) finish(); else nativeRaf(collect); };
    nativeRaf(collect);
  }),
  state: () => ({ renderer: probe.renderer, firstRenderAt: probe.firstRenderAt, lastRenderAt: probe.lastRenderAt,
    frameClockCalibration: probe.frameClockCalibration,
    contexts: probe.contexts, visibility: document.visibilityState, contextLost: probe.contextLost, detachedContextLosses: probe.detachedContextLosses, outsideRafDrawCalls: probe.outsideRafDrawCalls }),
  begin: () => { probe.frames = []; probe.hidden = document.visibilityState !== 'visible'; probe.window = { start: performance.now(), lastRenderAt: probe.lastRenderAt, outsideRafDrawCalls: probe.outsideRafDrawCalls }; return probe.window.start; },
  end: minimumSamples => {
    const end = performance.now(), start = probe.window.start;
    const result = { ...summarize(probe.frames, { start, end, minimumSamples, hidden: probe.hidden, contextLost: probe.contextLost }),
      start, end, outsideRafDrawCalls: probe.outsideRafDrawCalls - probe.window.outsideRafDrawCalls, visibilityAtEnd: document.visibilityState, rawFrames: probe.frames };
    result.renderLoopCondition = probe.lastRenderAt === probe.window.lastRenderAt ? 'render_loop_stalled' : result.sampledFrames < 2 ? 'frame_interval_exceeds_window' : 'rendering';
    result.longestObservedIntervalMs = distribution(probe.frames.filter(f => f.previous != null).map(f => f.at - f.previous)).max;
    probe.window = null;
    return result;
  },
};
