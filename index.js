// EchoText bootstrap: no runtime imports, settings template, or runtime CSS while OFF.
const entryUrl = new URL(import.meta.url);
const BASE_URL = new URL('.', entryUrl).href.replace(/\/$/, '');
const VERSION_QUERY = entryUrl.search;
const moduleFiles = [
    ['config', 'EchoTextConfig'], ['emotion-system', 'EchoTextEmotionSystem'],
    ['proactive-messaging', 'EchoTextProactiveMessaging'], ['settings-modal', 'EchoTextSettingsModal'],
    ['untethered-chat', 'EchoTextUntetheredChat'], ['memory-system', 'EchoTextMemorySystem'],
    ['saveload-modal', 'EchoTextSaveLoadModal'], ['group', 'EchoTextGroupManager'],
    ['image-generation', 'EchoTextImageGeneration'], ['gallery', 'EchoTextGallery'],
    ['character-picker', 'EchoTextCharacterPicker'], ['st-context-emotion', 'EchoTextSTContextEmotion'],
    ['theme-editor', 'EchoTextThemeEditor'], ['context-override', 'EchoTextContextOverride'],
];
let activation = null;
let transition = null;
let assetsPromise = null;
let retries = 0;
let root;

function context() { return SillyTavern.getContext(); }
function storedSettings() {
    return context().extensionSettings.EchoText ||= { enabled: false };
}
function persistEnabled(enabled) {
    storedSettings().enabled = enabled;
    context().saveSettingsDebounced();
}
function assetUrl(path) {
    const url = new URL(`${BASE_URL}/${path}${VERSION_QUERY}`);
    // Failed native imports are cached by browsers too; allow an explicit retry.
    if (retries) url.searchParams.set('et_retry', retries);
    return url.href;
}
async function loadAssets() {
    if (!assetsPromise) {
        const controller = new AbortController();
        let timeout;
        const timedOut = new Promise((_, reject) => {
            timeout = window.setTimeout(() => { controller.abort(); reject(new Error('EchoText loading timed out')); }, 30000);
        });
        assetsPromise = Promise.race([timedOut, Promise.all([
            import(assetUrl('runtime.js')), import(assetUrl('lib/runtime-scope.js')),
            Promise.all(moduleFiles.map(([file]) => import(assetUrl(`lib/${file}.js`)))),
            fetch(assetUrl('settings.html'), { signal: controller.signal }).then(r => {
                if (!r.ok) throw new Error(`Settings: HTTP ${r.status}`);
                return r.text();
            }),
            fetch(assetUrl('lib/emotions.json'), { signal: controller.signal }).then(r => r.ok ? r.json() : null).catch(() => null),
        ])]).catch(error => { controller.abort(); assetsPromise = null; retries++; throw error; })
            .finally(() => window.clearTimeout(timeout));
    }
    return assetsPromise;
}
function runtimeStyle(path, id, media, scope) {
    const link = document.createElement('link');
    link.id = id; link.rel = 'stylesheet'; link.href = assetUrl(path);
    if (media) link.media = media;
    const loaded = new Promise((resolve, reject) => {
        const timeout = window.setTimeout(() => reject(new Error(`Could not load ${path}`)), 30000);
        const clear = () => window.clearTimeout(timeout);
        scope.onCleanup(clear);
        link.onload = () => { clear(); resolve(); };
        link.onerror = () => { clear(); reject(new Error(`Could not load ${path}`)); };
    });
    document.head.append(link);
    return { link, loaded };
}
function updateMaster(loading = false, message = '') {
    root.querySelector('#et_enabled_quick').checked = storedSettings().enabled === true;
    root.querySelector('#et_enabled_quick').disabled = loading;
    root.setAttribute('aria-busy', String(loading));
    root.classList.toggle('et-runtime-active', !!activation && !loading);
    const status = root.querySelector('.et-bootstrap-status');
    status.textContent = message;
    status.hidden = !message;
    root.querySelector('#et-runtime-settings').hidden = !activation || loading;
}
async function setEnabled(enabled) {
    // Checkbox stays locked during activation; all surfaces share this single gate.
    if (transition) return transition;
    if (!enabled) {
        if (activation) {
            const old = activation;
            activation = null;
            old.dispose();
        }
        persistEnabled(false);
        updateMaster();
        return;
    }
    if (activation) return;
    persistEnabled(true);
    updateMaster(true, 'Loading EchoText…');
    transition = (async () => {
        let scope;
        const styles = [];
        try {
            const [runtime, lifecycleModule, factories, settingsHtml, emotionKeywords] = await loadAssets();
            scope = lifecycleModule.createRuntimeScope();
            activation = scope;
            for (const [file, id, media] of [
                ['style.css', 'et-runtime-styles'],
                ['mobile-style.css', 'et-mobile-styles', '(max-width: 1000px)'],
            ]) {
                const style = runtimeStyle(file, id, media, scope);
                styles.push(style);
                scope.onCleanup(() => style.link.remove());
            }
            // Fetch independent files together, instantiate in dependency order.
            const modules = {};
            for (let i = 0; i < factories.length; i++) {
                modules[moduleFiles[i][1]] = factories[i].default(scope, modules);
                if (i % 3 === 2) await scope.yieldToBrowser();
            }
            await Promise.all(styles.map(style => style.loaded));
            await scope.yieldToBrowser();
            await runtime.startRuntime({ BASE_URL, VERSION_QUERY, lifecycle: scope, modules,
                settingsHtml, emotionKeywords, setEnabled });
            updateMaster();
        } catch (error) {
            scope?.dispose();
            if (assetsPromise) { assetsPromise = null; retries++; }
            activation = null;
            styles.forEach(style => style.link.remove());
            persistEnabled(false);
            updateMaster(false, 'EchoText could not load. Enable it to try again.');
            console.error('[EchoText] Activation failed', error);
        } finally { transition = null; }
    })();
    return transition;
}

function mount() {
    if (document.getElementById('et-bootstrap')) return;
    root = document.createElement('div');
    root.id = 'et-bootstrap'; root.className = 'et-settings-drawer';
    root.innerHTML = `<div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header"><b>EchoText</b>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div>
        <div class="inline-drawer-content">
            <label class="et-drawer-toggle-row" for="et_enabled_quick">
                <input id="et_enabled_quick" type="checkbox" class="checkbox">
                <span style="font-weight:bold"><i class="fa-solid fa-power-off"></i> Enable EchoText</span>
            </label>
            <div class="et-bootstrap-status" role="status" hidden></div>
            <div id="et-runtime-settings" hidden></div>
        </div></div>`;
    document.getElementById('extensions_settings').append(root);
    root.querySelector('#et_enabled_quick').addEventListener('change', event => setEnabled(event.target.checked));
    updateMaster();
    if (storedSettings().enabled === true) void setEnabled(true);
}
// The host supplies these before loading third-party extensions. The fallback is
// only for a script inserted early; it stops permanently once the drawer mounts.
function start() {
    if (!window.SillyTavern?.getContext?.()?.extensionSettings || !document.getElementById('extensions_settings')) {
        window.setTimeout(start, 250);
        return;
    }
    mount();
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
else start();
