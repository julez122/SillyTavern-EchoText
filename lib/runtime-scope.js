// One activation owns all of its asynchronous work. No host globals are patched.
let nextScope = 0;

export function createRuntimeScope() {
    const controller = new AbortController();
    const timeouts = new Set(), intervals = new Set(), frames = new Set();
    const observers = new Set(), listeners = new Set(), cleanups = [], idleCallbacks = new Set();
    const eventNamespace = `.etRuntime${++nextScope}`;
    const globalTargets = new Set();
    const cancelled = () => new DOMException('EchoText disabled', 'AbortError');
    const check = () => { if (controller.signal.aborted) throw cancelled(); };
    const guard = callback => function (...args) {
        if (!controller.signal.aborted) return callback.apply(this, args);
    };
    const trackedObserver = Native => class extends Native {
        constructor(callback, options) {
            super(guard(callback), options);
            observers.add(this);
        }
        disconnect() { observers.delete(this); super.disconnect(); }
    };

    const scope = {
        get active() { return !controller.signal.aborted; },
        signal: controller.signal,
        check,
        guard,
        onCleanup(callback) { cleanups.push(callback); },
        setTimeout(callback, delay, ...args) {
            if (!scope.active) return null;
            const id = window.setTimeout(() => {
                timeouts.delete(id);
                if (scope.active) callback(...args);
            }, delay);
            timeouts.add(id);
            return id;
        },
        clearTimeout(id) { timeouts.delete(id); window.clearTimeout(id); },
        setInterval(callback, delay, ...args) {
            if (!scope.active) return null;
            const id = window.setInterval(guard(() => callback(...args)), delay);
            intervals.add(id);
            return id;
        },
        clearInterval(id) { intervals.delete(id); window.clearInterval(id); },
        requestAnimationFrame(callback) {
            if (!scope.active) return null;
            const id = window.requestAnimationFrame(time => {
                frames.delete(id);
                if (scope.active) callback(time);
            });
            frames.add(id);
            return id;
        },
        cancelAnimationFrame(id) { frames.delete(id); window.cancelAnimationFrame(id); },
        // A macrotask after a frame gives the browser a paint/input opportunity.
        // Chrome can pause frames in an occluded/background tab; keep setup moving
        // with a bounded fallback rather than waiting forever for a visible frame.
        async yieldToBrowser() {
            check();
            await new Promise((resolve, reject) => {
                let frame = null, fallback = null;
                const cleanup = () => {
                    scope.cancelAnimationFrame(frame);
                    scope.clearTimeout(fallback);
                    controller.signal.removeEventListener('abort', abort);
                };
                const finish = () => { cleanup(); resolve(); };
                const abort = () => { cleanup(); reject(cancelled()); };
                frame = scope.requestAnimationFrame(finish);
                fallback = scope.setTimeout(finish, 50);
                controller.signal.addEventListener('abort', abort, { once: true });
            });
            await scope.delay(0);
            check();
        },
        idle(callback) {
            if (!scope.active) return;
            if (!window.requestIdleCallback) return scope.setTimeout(guard(callback), 300);
            const id = window.requestIdleCallback(deadline => {
                idleCallbacks.delete(id);
                if (scope.active) callback(deadline);
            });
            idleCallbacks.add(id);
            return id;
        },
        // Copy the persisted JSON object without serializing every message string.
        // Large histories yield between small batches during activation.
        async copySettings(source) {
            const result = {};
            const pending = [{ source, target: result, keys: Object.keys(source), index: 0 }];
            let batchStart = performance.now();
            while (pending.length) {
                const job = pending[pending.length - 1];
                if (job.index === job.keys.length) { pending.pop(); continue; }
                const key = job.keys[job.index++], value = job.source[key];
                const copy = value && typeof value === 'object' ? (Array.isArray(value) ? [] : {}) : value;
                Object.defineProperty(job.target, key, { value: copy, enumerable: true, writable: true, configurable: true });
                if (copy !== value) pending.push({ source: value, target: copy, keys: Object.keys(value), index: 0 });
                if (performance.now() - batchStart >= 4) {
                    await scope.yieldToBrowser();
                    batchStart = performance.now();
                }
            }
            check();
            return result;
        },
        // Delays used by generation must reject on shutdown, never leave pending promises.
        delay(ms, signal) {
            return new Promise((resolve, reject) => {
                const signals = [controller.signal, signal].filter(Boolean);
                const cleanup = () => signals.forEach(s => s.removeEventListener('abort', abort));
                const abort = () => { scope.clearTimeout(id); cleanup(); reject(cancelled()); };
                const id = scope.setTimeout(() => { cleanup(); resolve(); }, ms);
                signals.forEach(s => s.addEventListener('abort', abort, { once: true }));
                if (signals.some(s => s.aborted)) abort();
            });
        },
        async fetch(input, options = {}) {
            check();
            const signals = [controller.signal, options.signal || (input instanceof Request ? input.signal : null)].filter(Boolean);
            if (AbortSignal.any) {
                const response = await window.fetch(input, { ...options, signal: AbortSignal.any(signals) });
                check();
                for (const name of ['json', 'text', 'blob', 'arrayBuffer', 'formData']) {
                    const read = response[name].bind(response);
                    response[name] = async (...args) => { const body = await read(...args); check(); return body; };
                }
                return response;
            }
            const requestController = new AbortController();
            const abort = () => requestController.abort();
            signals.forEach(s => s.addEventListener('abort', abort, { once: true }));
            if (signals.some(s => s.aborted)) abort();
            try {
                const response = await window.fetch(input, { ...options, signal: requestController.signal });
                check();
                const cleanup = () => signals.forEach(s => s.removeEventListener('abort', abort));
                // Keep cancellation attached through body consumption, then release it.
                for (const name of ['json', 'text', 'blob', 'arrayBuffer', 'formData']) {
                    const read = response[name].bind(response);
                    response[name] = async (...args) => {
                        try { const body = await read(...args); check(); return body; }
                        finally { cleanup(); }
                    };
                }
                // Best-effort POSTs do not read a body; release fallback signal links
                // after their caller has had a turn to select a body reader.
                scope.setTimeout(() => { if (!response.bodyUsed) cleanup(); }, 0);
                return response;
            } catch (error) {
                signals.forEach(s => s.removeEventListener('abort', abort));
                throw error;
            }
        },
        listen(target, type, callback, options) {
            if (!scope.active || !target) return;
            const wrapped = function (...args) {
                if (options?.once) listeners.delete(record);
                if (scope.active) return callback.apply(this, args);
            };
            const record = { target, type, callback, wrapped, options };
            listeners.add(record);
            target.addEventListener(type, wrapped, options);
        },
        unlisten(target, type, callback, options) {
            for (const record of listeners) {
                if (record.target === target && record.type === type && record.callback === callback) {
                    target.removeEventListener(type, record.wrapped, record.options);
                    listeners.delete(record);
                }
            }
        },
        // Only document/window delegates get a private namespace. Element handlers die
        // with their owned UI. Existing namespaces and normal off()/one() semantics remain.
        events(target) {
            globalTargets.add(target);
            const result = jQuery(target);
            for (const method of ['on', 'one', 'off']) {
                result[method] = function (events, ...args) {
                    if (typeof events === 'string') {
                        events = events.split(/\s+/).filter(Boolean).map(e => e + eventNamespace).join(' ');
                    } else if (events && typeof events === 'object') {
                        events = Object.fromEntries(Object.entries(events).map(([name, fn]) => [name + eventNamespace, fn]));
                    } else if (method === 'off') events = eventNamespace;
                    if (scope.active || method === 'off') jQuery.fn[method].call(result, events, ...args);
                    return result;
                };
            }
            return result;
        },
        MutationObserver: trackedObserver(window.MutationObserver),
        IntersectionObserver: trackedObserver(window.IntersectionObserver),
        ResizeObserver: trackedObserver(window.ResizeObserver),
        dispose() {
            if (!scope.active) return;
            controller.abort();
            timeouts.forEach(id => window.clearTimeout(id)); timeouts.clear();
            intervals.forEach(id => window.clearInterval(id)); intervals.clear();
            frames.forEach(id => window.cancelAnimationFrame(id)); frames.clear();
            idleCallbacks.forEach(id => window.cancelIdleCallback(id)); idleCallbacks.clear();
            observers.forEach(observer => observer.disconnect()); observers.clear();
            listeners.forEach(r => r.target.removeEventListener(r.type, r.wrapped, r.options)); listeners.clear();
            globalTargets.forEach(target => jQuery(target).off(eventNamespace)); globalTargets.clear();
            cleanups.reverse().forEach(callback => {
                try { callback(); } catch (error) { console.error('[EchoText] Cleanup failed', error); }
            });
            cleanups.length = 0;
        },
    };
    return scope;
}
