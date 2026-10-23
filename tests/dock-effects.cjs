// Run with: node tests/dock-effects.cjs
// Exercise integration and cleanup without a graphical GNOME Shell session.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');

const surfaceSandbox = {};
vm.createContext(surfaceSandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, '../shellMenuStyle.js'), 'utf8')
    .replace(/\bexport /g, '') + '\nthis.surfaceStyle = shellMenuSurfaceStyle;', surfaceSandbox);
const shadowColor = {red: 10, green: 20, blue: 30, alpha: 128};
const shadowNode = {
    get_border_width: () => 2,
    get_border_color: () => shadowColor,
    get_border_radius: () => 12,
    get_box_shadow: () => ({xoffset: -4, yoffset: 6, blur: 16, spread: 2, color: shadowColor}),
};
assert.equal(surfaceSandbox.surfaceStyle(shadowNode, 1),
    surfaceSandbox.surfaceStyle(shadowNode, 1, false, 100, 100), 'Default size preserves theme');
for (const scale of [1, 2]) {
    for (const size of [0, 25, 50, 100, 150, 200]) {
        const css = surfaceSandbox.surfaceStyle(shadowNode, scale, false, 50, size);
        const lengths = [-4, 6, 16, 2].map(v => `${v / scale * size / 100}px`).join(' ');
        assert(css.includes(size === 0 ? 'box-shadow: none;' :
            `box-shadow: ${lengths} rgba(10, 20, 30, ${128 / 255 * 0.5});`));
        assert(css.includes(`border-top: ${2 / scale}px solid`), 'Size leaves border unchanged');
        assert(css.includes(`border-radius: ${Array(4).fill(`${12 / scale}px`).join(' ')};`),
            'Size leaves corners unchanged');
    }
}
assert(surfaceSandbox.surfaceStyle({...shadowNode, get_box_shadow: () => null}, 1, false, 100, 200)
    .includes('box-shadow: none;'), 'Themes without a shadow remain supported');

const settings = {applyCustomTheme: false, customThemeShrink: false,
    runningIndicatorStyle: 0, forceStraightCorner: false,
    iconShadow: false, iconShadowIntensity: 24, iconShadowOffsetX: 0, iconShadowOffsetY: 2, iconShadowBlur: 4,
    dockOutline: false, dockOutlineIntensity: 15, dockBlur: false, dockBlurRadius: 30, dockBlurCornerRadius: 24};
function createTheme() {
    return {styles: new Map(), loads: 0,
        load_stylesheet(file) {this.styles.set(file, file.content); this.loads++; this.onLoad?.();},
        unload_stylesheet(file) {this.styles.delete(file);}};
}
const context = {scale_factor: 1, theme: createTheme(), get_theme() {return this.theme;}};
let propertyNames = ['radius', 'brightness', 'mode'];
let effectCount = 0;
class MockBlurEffect {
    static list_properties() {
        return propertyNames.map(name => ({name}));
    }
    constructor(params) {
        Object.assign(this, params);
        this.repaints = 0;
        effectCount++;
    }
    queue_repaint() { this.repaints++; }
}

class MockActor {
    constructor(params) {
        Object.assign(this, {x: 0, y: 0, width: 0, height: 0,
            translation_x: 0, translation_y: 0, scale_x: 1, scale_y: 1, visible: true});
        Object.assign(this, params);
        this.mapped = true;
        this.redraws = 0;
        this.children = [];
        this.effects = new Map();
    }
    add_child(child) { this.children.push(child); child.parent = this; }
    get_children() { return this.children; }
    get_parent() { return this.parent; }
    get_theme_node() { return {get_transition_duration: () => this.transitionDuration || 0}; }
    insert_child_below(child, sibling) {
        assert.equal(sibling.parent, this);
        this.children.unshift(child);
        child.parent = this;
    }
    add_effect_with_name(name, effect) { this.effects.set(name, effect); }
    remove_effect(effect) {
        const entry = [...this.effects].find(([, value]) => value === effect);
        assert(entry, 'Remove only an attached effect');
        this.effects.delete(entry[0]);
    }
    queue_redraw() { this.redraws++; }
    get_transformed_position() {
        const [px, py] = this.parent?.get_transformed_position() || [0, 0];
        const [sx, sy] = this.parent?.stageScale() || [1, 1];
        return [px + (this.x + this.translation_x) * sx, py + (this.y + this.translation_y) * sy];
    }
    stageScale() {
        const [sx, sy] = this.parent?.stageScale() || [1, 1];
        return [sx * this.scale_x, sy * this.scale_y];
    }
    get_transformed_size() {
        const [sx, sy] = this.stageScale();
        return [this.width * sx, this.height * sy];
    }
    transform_stage_point(x, y) {
        const [px, py] = this.get_transformed_position();
        const [sx, sy] = this.stageScale();
        return [sx !== 0 && sy !== 0, (x - px) / sx, (y - py) / sy];
    }
    get_paint_opacity() { return this.opacity ?? 255; }
    get mapped() { return this._mapped && this.visible && (this.parent?.mapped ?? true); }
    set mapped(value) { this._mapped = value; }
    set_position(x, y) { this.x = x; this.y = y; }
    set_size(width, height) { this.width = width; this.height = height; }
    destroy() {
        this.destroyed = true;
        this.children.forEach(child => child.destroy());
        this.effects.clear();
        if (this.parent)
            this.parent.children = this.parent.children.filter(child => child !== this);
    }
}
const laters = new Map();
let laterId = 0;
let monotonicTime = 1000000;
let drawFlags = 0;
let flagAdds = 0;
let flagRemoves = 0;
const clippedFlag = 4;
const clutter = {DrawDebugFlag: {DISABLE_CLIPPED_REDRAWS: clippedFlag},
    get_debug_flags: () => [0, drawFlags, 0],
    add_debug_flags: (_debug, draw) => {drawFlags |= draw; flagAdds++;},
    remove_debug_flags: (_debug, draw) => {drawFlags &= ~draw; flagRemoves++;}};

const sandbox = {imports: {signals: {addSignalMethods() {}}}, global: {stage: {}, window_group: {}, display: {}, get_window_actors: () => []},
    Main: {sessionMode: {isLocked: false}, screenShield: {active: false}},
    LoginManager: {getLoginManager: () => loginManager},
    Clutter: clutter,
    GObject: {signal_lookup: () => 1},
    GLib: {get_monotonic_time: () => monotonicTime},
    Gio: {FileCreateFlags: {REPLACE_DESTINATION: 1}, File: {new_tmp: () => [{
        replace_contents(content) {this.content = content;},
        delete() {this.deleted = true;},
    }, {close() {}}]}},
    Docking: {DockManager: {settings}},
    Shell: {BlurEffect: MockBlurEffect, BlurMode: {BACKGROUND: 1}},
    Meta: {BackgroundGroup: MockActor, LaterType: {BEFORE_REDRAW: 1}},
    St: {Widget: MockActor, ThemeContext: {get_for_stage: () => context}, Corner: {TOPLEFT: 0}},
    Utils: {SignalsHandlerFlags: {CONNECT_AFTER: 1},
        laterAdd: (_type, callback) => {laters.set(++laterId, callback); return laterId;},
        laterRemove: id => laters.delete(id)}};
sandbox.BlurBackend = sandbox.Shell;
const loginManager = {preparingForSleep: false};
vm.createContext(sandbox);
const guardSource = fs.readFileSync(path.join(__dirname, '../blurRedrawGuard.js'), 'utf8')
    .replace(/\bexport /g, '');
vm.runInContext(guardSource + '\nthis.BlurRedrawGuard = BlurRedrawGuard;', sandbox);
const guard = new sandbox.BlurRedrawGuard(clutter, {});
const secondGuard = new sandbox.BlurRedrawGuard(clutter, {});
const blurActor = new MockActor({x: 20, y: 30, width: 400, height: 64});
const view = {layout: {x: 0, y: 0, width: 1920, height: 1080}};
const otherView = {layout: {x: 1920, y: 0, width: 1920, height: 1080}};
guard.begin(blurActor, otherView);
assert.equal(drawFlags, 0, 'Leave unrelated monitor frames clipped');
blurActor.opacity = 0;
guard.begin(blurActor, view);
assert.equal(drawFlags, 0, 'Leave invisible blur frames clipped');
blurActor.opacity = 255;
blurActor.mapped = false;
guard.begin(blurActor, view);
assert.equal(drawFlags, 0);
blurActor.mapped = true;
guard.begin(blurActor, view);
secondGuard.begin(blurActor, view);
assert.equal(drawFlags, clippedFlag);
assert.equal(flagAdds, 1, 'Two docks share one frame guard');
guard.end();
assert.equal(drawFlags, clippedFlag, 'Keep guard until both docks finish');
secondGuard.end();
secondGuard.end();
assert.equal(drawFlags, 0);
assert.equal(flagRemoves, 1);
assert.equal(blurActor.redraws, 0, 'Frame guard never schedules another redraw');
drawFlags = clippedFlag | 16;
guard.begin(blurActor, view);
guard.end();
assert.equal(drawFlags, clippedFlag | 16, 'Preserve existing compositor flags');
drawFlags = 16;
const legacyGuard = new sandbox.BlurRedrawGuard({DrawDebugFlag: clutter.DrawDebugFlag}, {
    get_clutter_debug_flags: clutter.get_debug_flags,
    add_clutter_debug_flags: clutter.add_debug_flags,
    remove_clutter_debug_flags: clutter.remove_debug_flags});
legacyGuard.begin(blurActor, view);
assert.equal(drawFlags, clippedFlag | 16);
legacyGuard.end();
assert.equal(drawFlags, 16, 'Legacy API restores only the changed flag');
drawFlags = 0;
const backendSource = fs.readFileSync(path.join(__dirname, '../blurBackend.js'), 'utf8')
    .replace(/\bexport /g, '');
vm.runInContext(backendSource + '\nthis.selectBlurBackend = selectBlurBackend;', sandbox);
const native = sandbox.Shell;
const compatibility = {BlurEffect: class RoundedEffect extends MockBlurEffect {},
    BlurMode: {BACKGROUND: 42}};
compatibility.BlurEffect.$gtype = 'rounded-effect-type';
const typeName = type => type === 'rounded-effect-type' ? 'RoundedBlurEffect' : null;
assert.equal(sandbox.selectBlurBackend(null, native, typeName), native);
assert.equal(sandbox.selectBlurBackend({}, native, typeName), native);
assert.equal(sandbox.selectBlurBackend(compatibility, native, () => {throw new Error('Bad ABI');}), native);
assert.equal(sandbox.selectBlurBackend(compatibility, native, typeName), compatibility);
const source = fs.readFileSync(path.join(__dirname, '../theming.js'), 'utf8')
    .replace(/^import\s+[\s\S]*?;\n/gm, '').replace(/\bexport /g, '')
    .replace('const BlurBackend = await loadBlurBackend(Shell, GObject);', '');
vm.runInContext(source + '\nthis.ThemeManager = ThemeManager; this.Transparency = Transparency;', sandbox);

function createDock() {
    let style = null;
    let color = {red: 25, green: 25, blue: 25, alpha: 255};
    const effects = new Map();
    const classes = new Set(['bottom', 'existing-theme']);
    const background = new MockActor({x: 4, y: 6, width: 400, height: 64,
        get_style: () => style,
        set_style: value => {
            style = value;
            // St stops parsing at an empty declaration; regex-only mocks hid
            // the doubled-semicolon regression in the earlier builds.
            assert(!value || !/;\s*;|^\s*;/.test(value), 'No empty St CSS declarations');
            color = {red: 25, green: 25, blue: 25, alpha: 255};
            const fills = [...(value || '').matchAll(/background-color:\s*rgba\(([^)]+)\)/g)];
            if (fills.length) {
                const [red, green, blue, alpha] = fills.at(-1)[1].split(',').map(Number);
                color = {red, green, blue, alpha: alpha * 255};
            }
        },
        get_theme_node: () => ({get_background_color: () => color,
            get_border_radius: () => 24, get_transition_duration: () => 250}),
        add_effect_with_name: (name, effect) => effects.set(name, effect),
        remove_effect: effect => {
            const entry = [...effects].find(([, value]) => value === effect);
            assert(entry, 'Remove only an attached effect');
            effects.delete(entry[0]);
        },
    });
    const parent = new MockActor({});
    const dash = new MockActor({_background: background, x: 12, y: 18, parent,
        get_children: () => [], get_theme_node: () => ({get_transition_duration: () => 250}),
        get_parent: () => parent});
    background.parent = dash;
    parent.children.push(dash);
    const dock = {mapped: true, dash,
        add_style_class_name: name => classes.add(name),
        remove_style_class_name: name => classes.delete(name)};
    const manager = Object.create(sandbox.ThemeManager.prototype);
    const signalBindings = new Map();
    const signalHandler = {
        addWithLabel: (label, ...signals) => {
            if (!Array.isArray(signals[0])) signals = [signals];
            signalBindings.set(label, [...signalBindings.get(label) || [], ...signals]);
        },
        removeWithLabel: label => signalBindings.delete(label),
    };
    Object.assign(manager, {_signalsHandler: signalHandler, _actor: dock, _dash: dock.dash, _blurEffect: null,
        _updateDashOpacity() {}, _updateDashColor() {},
        _adjustTheme() { background.set_style('border-radius: 24px;'); },
        _transparency: {destroy() {}}, emit() {}});
    return {dock, manager, background, signalBindings, surfaceEffects: effects, classes, parent,
        get effects() { return manager._blurActor?.effects || new Map(); }};
}

const a = createDock();
for (const shadow of [false, true]) {
    for (const outline of [false, true]) {
        for (const blur of [false, true]) {
            Object.assign(settings, {iconShadow: shadow, dockOutline: outline, dockBlur: blur});
            a.manager.updateCustomTheme();
            assert.equal(a.classes.has('soft-icon-shadow'), shadow);
            assert(a.classes.has('existing-theme'));
            assert(![...a.classes].some(name => name.startsWith('soft-icon-outline')));
            assert.equal(a.background.get_style().includes('border: 1px solid'), outline);
            assert(a.background.get_style().includes('border-radius: 24px;'));
            assert.equal(a.effects.size, Number(blur));
            assert.equal(a.surfaceEffects.size, 0, 'Never sample from inside the offscreen dash');
            if (blur) {
                assert.equal(a.manager._blurGroup.parent, a.parent);
                assert.equal(a.parent.children[0], a.manager._blurGroup);
                assert.equal(a.manager._blurActor.x, 16);
                assert.equal(a.manager._blurActor.y, 24);
                assert.equal(a.manager._blurActor.width, 400);
                assert.equal(a.manager._blurActor.height, 64);
            }
            assert.equal(a.background.get_style().includes('background-image: none'), blur);
            assert.equal(a.background.get_theme_node().get_background_color().alpha, 255);
        }
    }
}

// Reuse one effect when changing intensity and account for monitor scale.
// Shadow controls update live; no reload loop, leaked stylesheet, or cross-dock changes.
settings.iconShadowIntensity = 65;
a.manager._updateCustomStyleClasses();
assert(a.manager._shadowCss.includes('icon-shadow: 0px 2px 4px rgba(0, 0, 0, 0.65)'));
const shadowFile = a.manager._shadowFile;
const loads = context.theme.loads;
context.theme.onLoad = () => a.manager._updateIconShadow();
settings.iconShadowOffsetX = -8;
settings.iconShadowOffsetY = 12;
settings.iconShadowBlur = 0;
a.manager._updateCustomStyleClasses();
assert.equal(a.manager._shadowFile, shadowFile);
assert(a.manager._shadowCss.includes('icon-shadow: -8px 12px 0px rgba(0, 0, 0, 0.65)'));
a.manager._updateCustomStyleClasses();
assert.equal(context.theme.loads, loads + 1, 'No recursive theme load for identical settings');
delete context.theme.onLoad;
const otherShadow = createDock();
otherShadow.manager._updateCustomStyleClasses();
const otherFile = otherShadow.manager._shadowFile;
assert.notEqual(otherFile, shadowFile);
assert.notEqual(otherShadow.manager._shadowClass, a.manager._shadowClass);
const oldTheme = context.theme;
context.theme = createTheme();
// Main.loadTheme() copies every custom stylesheet before replacing the theme.
for (const [file, css] of oldTheme.styles)
    context.theme.styles.set(file, css);
a.manager._updateCustomStyleClasses();
assert(!oldTheme.styles.has(shadowFile));
assert(context.theme.styles.has(shadowFile), 'Reload shadow after a theme replacement');
settings.iconShadow = false;
a.manager._updateCustomStyleClasses();
assert(shadowFile.deleted);
assert(!context.theme.styles.has(shadowFile));
assert(!a.classes.has(a.manager._shadowClass));
assert(oldTheme.styles.has(otherFile), 'Disabling one dock cannot remove another stylesheet');
otherShadow.manager.destroy();
assert(otherFile.deleted);
assert(!oldTheme.styles.has(otherFile));
assert(!context.theme.styles.has(otherFile), 'Teardown unloads the copied stylesheet from the current theme');

// Replacing the theme and destroying a dock before its deferred theme update
// must never leave a reference to a deleted file in the replacement theme.
settings.iconShadow = true;
const reloadedShadow = createDock();
reloadedShadow.manager._updateIconShadow();
const reloadFile = reloadedShadow.manager._shadowFile;
const sourceTheme = context.theme;
context.theme = createTheme();
for (const [file, css] of sourceTheme.styles)
    context.theme.styles.set(file, css);
reloadedShadow.manager.destroy();
assert(reloadFile.deleted);
assert(!sourceTheme.styles.has(reloadFile));
assert(!context.theme.styles.has(reloadFile), 'Reload cannot reference a deleted shadow stylesheet');
settings.iconShadow = false;
Object.assign(settings, {iconShadowOffsetX: 0, iconShadowOffsetY: 2, iconShadowBlur: 4});

const effect = a.manager._blurEffect;
const count = effectCount;
context.scale_factor = 2;
settings.dockBlurRadius = 44;
a.manager._updateBlur();
assert.equal(a.manager._blurEffect, effect);
assert.equal(effectCount, count);
assert.equal(effect.radius, 88);
assert.equal(effect.mode, sandbox.Shell.BlurMode.BACKGROUND);

// Each dock owns its own effect; disabling or destroying one cannot remove another.
const b = createDock();
b.manager.updateCustomTheme();
assert.notEqual(b.manager._blurEffect, effect);
const group = a.manager._blurGroup;
const pending = a.manager._blurGeometryLater;
a.manager.destroy();
a.manager.destroy();
assert(group.destroyed);
assert(!a.parent.children.includes(group));
assert(!laters.has(pending));
assert.equal(a.effects.size, 0);
assert.equal(b.effects.size, 1);

// Upstream window-driven transparency must not erase the outline or blur tint.
const transparency = Object.create(sandbox.Transparency.prototype);
Object.assign(transparency, {_dock: b.dock, _dockActor: b.dock, _backgroundActor: b.background,
    _opaque_style: 'border-radius: 24px;background-color: rgba(255, 255, 255, 1);border-color: black;',
    _transparent_style: 'border-radius: 24px;background-color: rgba(25, 25, 25, 0.1);border-color: black;',
    emit() {}});
for (const intensity of [0, 15, 65, 100]) {
    settings.dockOutlineIntensity = intensity;
    for (const near of [true, false, true]) {
        transparency._dockIsNear = () => near;
        transparency._updateSolidStyle();
        const style = b.background.get_style();
        const color = near ? '0, 0, 0' : '255, 255, 255';
        assert(style.includes(`border: 1px solid rgba(${color}, ${intensity / 100})`));
        assert(style.includes('border-radius: 24px;'));
        assert.equal(b.background.get_theme_node().get_background_color().alpha, near ? 255 : 25.5);
    }
}
settings.dockOutlineIntensity = 15;

// Blur must preserve the full opacity range, without capping or quantizing it.
for (const alpha of [0, 0.1, 0.3, 0.6, 0.85, 1]) {
    transparency._opaque_style = `background-color: rgba(25, 25, 25, ${alpha});`;
    transparency._dockIsNear = () => true;
    transparency._updateSolidStyle();
    assert.equal(b.background.get_theme_node().get_background_color().alpha, alpha * 255);
    assert.equal((b.background.get_style().match(/background-color:/g) || []).length, 1,
        'Blur does not override or duplicate the upstream opacity declaration');
}

// Disabling restores the upstream surface style and releases the GPU effect.
Object.assign(settings, {dockOutline: false, dockBlur: false});
b.manager.updateCustomTheme();
assert.equal(b.background.get_style(), 'border-radius: 24px;');
assert.equal(b.effects.size, 0);

// Older Shell versions use sigma; optional native corner-radius is feature detected.
propertyNames = ['sigma', 'brightness', 'mode', 'corner-radius'];
settings.dockBlur = true;
b.manager.updateCustomTheme();
assert.equal(b.manager._blurEffect.sigma, 44);
assert.equal(b.manager._blurEffect.corner_radius, 48);
settings.dockBlurCornerRadius = 0;
b.manager._updateBlur();
assert.equal(b.manager._blurEffect.corner_radius, 0);
settings.dockBlurCornerRadius = 24;

// A hidden dock applies pending changes when it is mapped again.
b.dock.mapped = false;
settings.dockBlur = false;
b.manager.updateCustomTheme();
assert.equal(b.effects.size, 1);
b.dock.mapped = true;
b.manager.updateCustomTheme();
assert.equal(b.effects.size, 0);

let signals;
const originalHandler = b.manager._signalsHandler;
b.manager._signalsHandler = {addWithLabel: (label, ...bindings) => {signals = bindings;}};
b.manager._bindSettingsChanges();
b.manager._signalsHandler = originalHandler;
for (const key of ['icon-shadow', 'icon-shadow-intensity', 'icon-shadow-offset-x', 'icon-shadow-offset-y', 'icon-shadow-blur', 'dock-outline', 'dock-outline-intensity', 'dock-blur', 'dock-blur-radius', 'dock-blur-corner-radius', 'background-color'])
    assert(signals.some(binding => binding[1] === `changed::${key}`));
// GNOME Rounded Blur must provide both the effect class and matching mode enum.
sandbox.BlurBackend = sandbox.selectBlurBackend(compatibility, native, typeName);
propertyNames = ['radius', 'brightness', 'mode', 'corner-radius'];
settings.dockBlur = true;
context.scale_factor = 1;
b.manager._updateBlur();
assert(b.manager._blurEffect instanceof compatibility.BlurEffect);
assert.equal(b.manager._blurEffect.mode, 42);
assert.equal(b.manager._blurEffect.corner_radius, 24);
context.scale_factor = 2;
b.manager._updateBlur();
assert.equal(b.manager._blurEffect.corner_radius, 48);
// Window redraws are batched; moving out still invalidates the old footprint.
b.background.set_style('background-color: rgba(25,25,25,0.55);');
b.manager._refreshBlurForStyle(b.background);
for (const [id, callback] of [...laters]) {laters.delete(id); callback();}
const window = {mapped: true, rect: {x: 0, y: 0, width: 800, height: 600},
    get_meta_window() {return {get_frame_rect: () => this.rect};}};
b.manager._trackBlurWindow(window);
const record = b.manager._blurWindows.get(window);
const bindings = b.signalBindings.get(record.label);
const damage = bindings.find(binding => binding[1] === 'damaged')[2];
const geometry = bindings.find(binding => binding[1] === 'notify::allocation')[2];
const scheduled = b.manager._blurRepaintLater;
const repaintCount = b.manager._blurEffect.repaints;
for (let i = 0; i < 10; i++) damage();
assert.equal(b.manager._blurRepaintLater, scheduled);
assert.equal(b.manager._blurEffect.repaints, repaintCount);
laters.get(scheduled)(); laters.delete(scheduled);
assert.equal(b.manager._blurEffect.repaints, repaintCount + 1);
assert(b.manager._blurActor.redraws > 0);

// Redraw the whole blur through hover/focus transitions, then stop at rest.
const beforeUpdate = [...b.signalBindings.values()].flat()
    .find(binding => binding[1] === 'before-update')[2];
const tile = new MockActor({transitionDuration: 250});
const icon = new MockActor({transitionDuration: 400});
tile.add_child(icon);
const dashBindings = b.signalBindings.get(b.manager._blurDashActors.get(b.dock.dash));
dashBindings.find(binding => binding[1] === 'child-added')[2](b.dock.dash, tile);
const tileBindings = b.signalBindings.get(b.manager._blurDashActors.get(tile));
const styleChanged = tileBindings.find(binding => binding[1] === 'style-changed')[2];
styleChanged();
const styleRepaints = b.manager._blurEffect.repaints;
monotonicTime += 200000;
beforeUpdate();
assert.equal(b.manager._blurEffect.repaints, styleRepaints + 1);
const iconBindings = b.signalBindings.get(b.manager._blurDashActors.get(icon));
iconBindings.find(binding => binding[1] === 'style-changed')[2]();
monotonicTime += 350000;
beforeUpdate();
assert.equal(b.manager._blurEffect.repaints, styleRepaints + 2, 'Child transition extends refresh duration');
monotonicTime += 150000;
beforeUpdate();
assert.equal(b.manager._blurEffect.repaints, styleRepaints + 2, 'No permanent frame repaint loop');
const afterUpdate = [...b.signalBindings.values()].flat()
    .find(binding => binding[1] === 'after-update')[2];
afterUpdate();
assert.equal(drawFlags, 0, 'Restore clipping after the frame');
beforeUpdate(undefined, view);
assert.equal(drawFlags, clippedFlag);
const tileLabel = b.manager._blurDashActors.get(tile);
const iconLabel = b.manager._blurDashActors.get(icon);
dashBindings.find(binding => binding[1] === 'child-removed')[2](b.dock.dash, tile);
assert(!b.signalBindings.has(tileLabel));
assert(!b.signalBindings.has(iconLabel), 'Remove handlers on detached descendants');

window.rect.x = 3000;
geometry();
assert(b.manager._blurRepaintLater, 'Refresh the window footprint after moving away');
const pendingRepaint = b.manager._blurRepaintLater;
b.manager.destroy();
assert.equal(drawFlags, 0, 'Destroying during a frame restores clipping');
assert(!laters.has(pendingRepaint));
assert.equal(b.manager._blurDashActors, null);
assert.equal(b.manager._blurStyleUntil, 0);
assert.equal(b.signalBindings.size, 0, 'Remove window and global handlers on teardown');

// Resume while locked must discard cached framebuffer resources only once the
// dock can be painted, with current geometry/settings and no polling timer.
function flushLaters() {
    while (laters.size) {
        for (const [id, callback] of [...laters]) {
            if (laters.delete(id)) callback();
        }
    }
}
function handler(dock, object, signal) {
    return [...dock.signalBindings.values()].flat()
        .find(binding => binding[0] === object && binding[1] === signal)[2];
}
context.scale_factor = 2;
// A sibling blur must follow rendered translations/scales, including ancestors,
// without requiring an allocation signal or scheduling idle frames.
const transformed = createDock();
transformed.manager._updateBlur();
flushLaters();
const paint = handler(transformed, sandbox.global.stage, 'before-paint');
const assertAligned = () => {
    assert.deepEqual(transformed.manager._blurActor.get_transformed_position(),
        transformed.background.get_transformed_position());
    const blurSize = transformed.manager._blurActor.get_transformed_size();
    const backgroundSize = transformed.background.get_transformed_size();
    for (let i = 0; i < 2; i++) assert(Math.abs(blurSize[i] - backgroundSize[i]) < 0.01);
};
transformed.dock.dash.translation_y = -24;
paint();
assertAligned();
transformed.parent.translation_x = 70;
transformed.parent.translation_y = 150;
transformed.parent.scale_x = 1.5;
transformed.parent.scale_y = 1.5;
transformed.dock.dash.scale_y = 0.8;
paint();
assertAligned();
flushLaters();
const settledRepaints = transformed.manager._blurEffect.repaints;
for (let i = 0; i < 60; i++) paint();
assert.equal(laters.size, 0, 'Unchanged paint geometry schedules no future frames');
assert.equal(transformed.manager._blurEffect.repaints, settledRepaints);
transformed.parent.scale_x = 0;
paint();
assert.equal(laters.size, 0, 'Ignore noninvertible transforms until allocation settles');
transformed.manager.destroy();

// An opaque surface stops both blur repaints and full-monitor redraws once its
// CSS fill has settled. Hovering its children must not wake the hidden effect.
const opaque = createDock();
opaque.manager._updateBlur();
flushLaters();
const opaqueFrame = handler(opaque, sandbox.global.stage, 'before-update');
const opaqueAfter = handler(opaque, sandbox.global.stage, 'after-update');
monotonicTime += 200000;
opaqueFrame(undefined, view);
assert(opaque.manager._blurActor.mapped, 'Keep blur through the fill transition');
opaqueAfter();
monotonicTime += 150000;
opaqueFrame(undefined, view);
assert(!opaque.manager._blurActor.mapped, 'Cull blur completely covered by the settled fill');
assert.equal(drawFlags, 0, 'Opaque surfaces do not request full-monitor redraws');
let coverageReads = 0;
const opaqueNode = opaque.background.get_theme_node;
opaque.background.get_theme_node = () => {coverageReads++; return opaqueNode();};
for (let i = 0; i < 60; i++) opaqueFrame(undefined, view);
assert.equal(coverageReads, 0, 'Settled frames reuse theme coverage without querying St');
const opaqueRepaints = opaque.manager._blurEffect.repaints;
opaque.manager._refreshBlurForStyle(new MockActor({transitionDuration: 250}));
opaque.manager._refreshBlurForStyle(opaque.background);
opaqueFrame(undefined, view);
assert(!opaque.manager._blurActor.mapped, 'Unchanged opaque style does not wake the effect');
flushLaters();
assert.equal(opaque.manager._blurEffect.repaints, opaqueRepaints);
opaque.background.opacity = 128;
opaqueFrame(undefined, view);
assert(opaque.manager._blurActor.mapped, 'A fading surface still needs its backdrop');
opaqueAfter();
flushLaters();
opaque.background.opacity = 255;
opaqueFrame(undefined, view);
assert(!opaque.manager._blurActor.mapped);
opaque.background.set_style('background-color: rgba(25,25,25,0.55);');
opaque.manager._refreshBlurForStyle(opaque.background);
assert(opaque.manager._blurActor.mapped, 'Restore immediately when the fill becomes transparent');
flushLaters();
opaque.background.set_style(null);
opaque.manager._syncBlurVisibility(true);
monotonicTime += 350000;
opaque.manager._blurEffect.corner_radius = 0;
opaqueFrame(undefined, view);
assert(opaque.manager._blurActor.mapped, 'Keep blur that extends outside the rounded fill');
opaqueAfter();
opaque.manager.destroy();
flushLaters();

const resumed = createDock();
resumed.manager._updateBlur();
flushLaters();
const staleEffect = resumed.manager._blurEffect;
const backdrop = resumed.manager._blurActor;
const sleepChanged = handler(resumed, loginManager, 'prepare-for-sleep');
const sessionChanged = handler(resumed, sandbox.Main.sessionMode, 'updated');
const shieldChanged = handler(resumed, sandbox.Main.screenShield, 'active-changed');
const mappedChanged = handler(resumed, backdrop, 'notify::mapped');
sleepChanged(loginManager, true);
assert.equal(resumed.manager._blurRecoveryLater || 0, 0, 'No recovery frame while sleeping');
sandbox.Main.sessionMode.isLocked = true;
sandbox.Main.screenShield.active = true;
sessionChanged();
backdrop.mapped = false;
mappedChanged();
sleepChanged(loginManager, false);
assert.equal(resumed.manager._blurEffect, staleEffect, 'Defer recovery while locked and unmapped');
sandbox.Main.sessionMode.isLocked = false;
sessionChanged();
assert.equal(resumed.manager._blurRecoveryLater || 0, 0, 'Unlock may precede actor mapping');
resumed.background.y = 42;
resumed.background.width = 480;
backdrop.mapped = true;
mappedChanged();
assert.equal(resumed.manager._blurRecoveryLater || 0, 0, 'Wait for the unlock animation to finish');
sandbox.Main.screenShield.active = false;
shieldChanged();
const recovery = resumed.manager._blurRecoveryLater;
sessionChanged();
sleepChanged(loginManager, false);
assert.equal(resumed.manager._blurRecoveryLater, recovery, 'Coalesce wake/unlock/map signals');
flushLaters();
assert.notEqual(resumed.manager._blurEffect, staleEffect, 'Replace the cached effect after resume');
assert.equal(resumed.manager._blurActor, backdrop, 'Keep the existing actor and its signal handlers');
assert.equal(backdrop.effects.size, 1);
assert.equal(resumed.manager._blurEffect.mode, 42);
assert.equal(resumed.manager._blurEffect.radius, settings.dockBlurRadius * 2);
assert.equal(resumed.manager._blurEffect.corner_radius, settings.dockBlurCornerRadius * 2);
assert.equal(backdrop.y, 60, 'Use the post-unlock allocation');
assert.equal(backdrop.width, 480);
assert(resumed.manager._blurEffect.repaints > 0, 'Invalidate the recovered effect');
assert.equal(resumed.manager._blurRecoveryPending, false);
assert.equal(laters.size, 0, 'Recovery settles without an idle loop');

// Suspend without screen locking, and hide again before a queued recovery.
const unlockedEffect = resumed.manager._blurEffect;
sleepChanged(loginManager, true);
sleepChanged(loginManager, false);
backdrop.mapped = false;
mappedChanged();
flushLaters();
assert.equal(resumed.manager._blurEffect, unlockedEffect);
assert(resumed.manager._blurRecoveryPending);
backdrop.mapped = true;
mappedChanged();
flushLaters();
assert.notEqual(resumed.manager._blurEffect, unlockedEffect);

sleepChanged(loginManager, false);
const cancelledRecovery = resumed.manager._blurRecoveryLater;
settings.dockBlur = false;
resumed.manager._updateBlur();
assert(!laters.has(cancelledRecovery), 'Disable cancels pending recovery');
assert.equal(resumed.signalBindings.size, 0, 'Disable disconnects sleep/session/map listeners');
settings.dockBlur = true;
resumed.manager._updateBlur();
sleepChanged(loginManager, false);
resumed.manager.destroy();
flushLaters();
assert.equal(resumed.manager._blurEffect, null, 'Destroy cannot resurrect blur');
assert.equal(resumed.signalBindings.size, 0);
assert.equal(drawFlags, 0);

console.log('PASS: backdrop geometry, adjustable shadows/outline, transparency, hover, suspend/unlock/remap recovery, bounded repaint/cleanup, scale and API compatibility');
