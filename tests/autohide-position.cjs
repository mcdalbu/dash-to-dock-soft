// Run with: node tests/autohide-position.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const Side = {TOP: 0, RIGHT: 1, BOTTOM: 2, LEFT: 3};
const settings = {dockHeight: 0, shellMenuStyle: false, dockFixed: false};
const context = {scale_factor: 1};
let shadowPadding = 0;
// A secondary monitor catches accidental use of the primary monitor origin.
const monitor = {x: 1440, y: 120, width: 1280, height: 900};
const sandbox = {
    GObject: {registerClass: (_, cls) => cls,
        ParamSpec: {uint() {}, enum() {}, double() {}},
        ParamFlags: {READWRITE: 1, CONSTRUCT_ONLY: 2, CONSTRUCT: 4}},
    GLib: {MAXUINT32: 0xffffffff},
    St: {Side, Bin: class {}, ThemeContext: {get_for_stage: () => context}},
    Clutter: {ActorBox: class {constructor(params) {Object.assign(this, params);}}},
    Main: {layoutManager: {monitors: [null, monitor]}, panel: {x: 0, y: 0}},
    DockManager: {settings}, global: {stage: {}},
    Graphene: {Point3D: class {constructor(params) {Object.assign(this, params);}}},
};
const source = fs.readFileSync(path.join(__dirname, '../docking.js'), 'utf8');
vm.runInNewContext(source.slice(source.indexOf('const DashSlideContainer ='),
    source.indexOf('const DockedDash =')) + '\nthis.Slider = DashSlideContainer;', sandbox);

function allocate(side, offset, slide) {
    settings.dockHeight = offset;
    const slider = new sandbox.Slider();
    const width = 200, height = 80;
    const scaledOffset = offset * context.scale_factor;
    const originX = monitor.x + (side === Side.RIGHT ? monitor.width - width * slide : 0);
    const originY = monitor.y - scaledOffset +
        (side === Side.BOTTOM ? monitor.height - height * slide : 0);
    const dock = {translation_x: side === Side.RIGHT ? -width : 0,
        translation_y: side === Side.BOTTOM ? -height : 0,
        dash: {_background: {get_theme_node: () => ({
            get_box_shadow: () => shadowPadding ? {inset: false} : null,
            get_paint_box: box => ({x1: -shadowPadding, y1: -shadowPadding,
                x2: box.x2 + shadowPadding, y2: box.y2 + shadowPadding}),
        })}},
        get_allocation_box: () => ({get_height: () => height * slide,
            get_width: () => width * slide})};
    Object.assign(slider, {side, slideX: slide, monitorIndex: 1, _slideoutSize: 0,
        get_theme_node: () => ({get_content_box: box => box}), set_allocation() {},
        get_parent: () => dock,
        child: {
            get_preferred_size: () => [width, height, width, height],
            allocate(box) {this.box = box;},
            apply_relative_transform_to_point(stage, point) {
                // Parent size has changed, but its notify handler still holds
                // the previous fully-shown anchor until allocation finishes.
                const staleX = side === Side.RIGHT ? dock.translation_x + width * slide : 0;
                const staleY = side === Side.BOTTOM ? dock.translation_y + height * slide : 0;
                return {x: point.x + originX + this.box.x1 + staleX,
                    y: point.y + originY + this.box.y1 + staleY};
            },
            set_clip(...clip) {this.clip = clip;},
        }});
    slider.vfunc_allocate({x1: 0, y1: 0,
        x2: width * ([Side.LEFT, Side.RIGHT].includes(side) ? slide : 1),
        y2: height * ([Side.TOP, Side.BOTTOM].includes(side) ? slide : 1)});
    return {child: slider.child, x: originX + slider.child.box.x1,
        y: originY + slider.child.box.y1, width, height};
}

for (const menu of [false, true]) {
    settings.shellMenuStyle = menu;
    for (const scale of [1, 2]) {
        context.scale_factor = scale;
        for (const side of [Side.TOP, Side.BOTTOM]) {
            for (const offset of [-12, -6, 0, 6, 12]) {
                const shown = allocate(side, offset, 1);
                assert.equal(shown.y, monitor.y - offset * scale +
                    (side === Side.BOTTOM ? monitor.height - shown.height : 0));
                for (const slide of [0, 0.01, 0.25, 0.5, 0.75, 0.99, 1]) {
                    const frame = allocate(side, offset, slide);
                    const hiddenY = side === Side.BOTTOM ? monitor.y + monitor.height :
                        monitor.y - frame.height;
                    assert(Math.abs(frame.y - (hiddenY + (shown.y - hiddenY) * slide)) < 1e-8,
                        'Travel must include the gap between the custom position and the screen edge');
                    if (menu || offset !== 0) {
                        const [left, top, width, height] = frame.child.clip;
                        if (slide === 0) {
                            assert.equal(width * height, 0, 'No hidden shadow');
                        } else {
                            assert(Math.abs(frame.x + left - monitor.x) < 1e-8);
                            assert(Math.abs(frame.y + top - monitor.y) < 1e-8);
                            assert.equal(width, monitor.width);
                            assert.equal(height, monitor.height, 'Clip stays on the monitor');
                        }
                    }
                }
            }
        }
        for (const side of [Side.LEFT, Side.RIGHT]) {
            for (const slide of [0, 0.5, 1]) {
                const normal = allocate(side, 0, slide);
                const shifted = allocate(side, 12, slide);
                assert.equal(shifted.x, normal.x, 'Sideways sliding stays unchanged');
                assert.equal(shifted.y, normal.y - 12 * scale);
            }
        }
    }
}
settings.shellMenuStyle = true;
for (const scale of [1, 2]) {
    context.scale_factor = scale;
    for (const padding of [4, 16, 32]) {
        shadowPadding = padding * scale;
        for (const side of Object.values(Side)) {
            for (const offset of [-12, 0, 12]) {
                const shown = allocate(side, offset, 1);
                const hidden = allocate(side, offset, 0);
                if (side === Side.BOTTOM)
                    assert(hidden.y - shadowPadding >= monitor.y + monitor.height);
                else if (side === Side.TOP)
                    assert(hidden.y + hidden.height + shadowPadding <= monitor.y);
                else if (side === Side.RIGHT)
                    assert(hidden.x - shadowPadding >= monitor.x + monitor.width);
                else
                    assert(hidden.x + hidden.width + shadowPadding <= monitor.x);
                for (const slide of [0.001, 0.02, 0.5, 0.99]) {
                    const frame = allocate(side, offset, slide);
                    assert(Math.abs(frame.x - (hidden.x + (shown.x-hidden.x)*slide)) < 1e-8);
                    assert(Math.abs(frame.y - (hidden.y + (shown.y-hidden.y)*slide)) < 1e-8);
                    assert(Math.abs(frame.x + frame.child.clip[0] - monitor.x) < 1e-8);
                    assert(Math.abs(frame.y + frame.child.clip[1] - monitor.y) < 1e-8);
                }
            }
        }
    }
}
console.log('PASS: autohide reaches monitor edges at custom heights, both styles, 1x/2x and all sides');
