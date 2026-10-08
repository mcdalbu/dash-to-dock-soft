// Run with: node tests/dock-effects.cjs
// Exercise integration and cleanup without a graphical GNOME Shell session.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');

const settings = {applyCustomTheme: false, customThemeShrink: false,
    runningIndicatorStyle: 0, forceStraightCorner: false,
    iconShadow: false, iconShadowIntensity: 24, dockOutline: false, dockBlur: false, dockBlurRadius: 30, dockBlurCornerRadius: 24};
const context = {scale_factor: 1};
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
        Object.assign(this, params);
        this.mapped = true;
        this.redraws = 0;
        this.children = [];
        this.effects = new Map();
    }
    add_child(child) { this.children.push(child); child.parent = this; }
    get_children() { return this.children; }
    get_theme_node() { return {get_transition_duration: () => this.transitionDuration || 0}; }
    insert_child_below(child, sibling) {
        assert.equal(sibling.parent, this);
        this.children.unshift(child);
        child.parent = this;
    }
    add_effect_with_name(name, effect) { this.effects.set(name, effect); }
    queue_redraw() { this.redraws++; }
    get_transformed_position() { return [this.x, this.y]; }
    get_transformed_size() { return [this.width, this.height]; }
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

const sandbox = {imports: {signals: {addSignalMethods() {}}}, global: {stage: {}, window_group: {}, display: {}, get_window_actors: () => []},
    GObject: {signal_lookup: () => 1},
    GLib: {get_monotonic_time: () => monotonicTime},
    Docking: {DockManager: {settings}},
    Shell: {BlurEffect: MockBlurEffect, BlurMode: {BACKGROUND: 1}},
    Meta: {BackgroundGroup: MockActor, LaterType: {BEFORE_REDRAW: 1}},
    St: {Widget: MockActor, ThemeContext: {get_for_stage: () => context}, Corner: {TOPLEFT: 0}},
    Utils: {SignalsHandlerFlags: {CONNECT_AFTER: 1},
        laterAdd: (_type, callback) => {laters.set(++laterId, callback); return laterId;},
        laterRemove: id => laters.delete(id)}};
sandbox.BlurBackend = sandbox.Shell;
vm.createContext(sandbox);
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
    const background = {x: 4, y: 6, width: 400, height: 64,
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
            get_border_radius: () => 24}),
        add_effect_with_name: (name, effect) => effects.set(name, effect),
        remove_effect: effect => {
            const entry = [...effects].find(([, value]) => value === effect);
            assert(entry, 'Remove only an attached effect');
            effects.delete(entry[0]);
        },
    };
    const parent = new MockActor({});
    const dash = {_background: background, x: 12, y: 18, parent,
        get_children: () => [], get_theme_node: () => ({get_transition_duration: () => 250}),
        get_parent: () => parent};
    parent.children.push(dash);
    const dock = {mapped: true, dash,
        add_style_class_name: name => classes.add(name),
        remove_style_class_name: name => classes.delete(name)};
    const manager = Object.create(sandbox.ThemeManager.prototype);
    const signalBindings = new Map();
    const signalHandler = {
        addWithLabel: (label, ...signals) => signalBindings.set(label, [...signalBindings.get(label) || [], ...signals]),
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
// Shadow strength updates live and disabling removes its CSS class.
settings.iconShadowIntensity = 65;
a.manager._updateCustomStyleClasses();
assert(a.classes.has('soft-shadow-strength-65'));
assert(!a.classes.has('soft-shadow-strength-24'));
settings.iconShadow = false;
a.manager._updateCustomStyleClasses();
assert(!a.classes.has('soft-shadow-strength-65'));

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
for (const near of [true, false, true]) {
    transparency._dockIsNear = () => near;
    transparency._updateSolidStyle();
    const style = b.background.get_style();
    assert(style.includes(near ? 'border: 1px solid rgba(0, 0, 0, 0.12)' :
        'border: 1px solid rgba(255, 255, 255, 0.15)'));
    assert.equal(b.background.get_theme_node().get_background_color().alpha, near ? 255 : 25.5);
}

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
for (const key of ['icon-shadow', 'icon-shadow-intensity', 'dock-outline', 'dock-blur', 'dock-blur-radius', 'dock-blur-corner-radius', 'background-color'])
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
assert(!laters.has(pendingRepaint));
assert.equal(b.manager._blurDashActors, null);
assert.equal(b.manager._blurStyleUntil, 0);
assert.equal(b.signalBindings.size, 0, 'Remove window and global handlers on teardown');

console.log('PASS: separate backdrop layer/geometry, shadow strength, dock surface, independent options, transparency and hover transitions, bounded repaint/cleanup, scale and API compatibility');
