// Run with: node tests/dock-redraw-recovery.cjs
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const path = require('node:path');

class Emitter {
    constructor() {this.handlers = new Map(); this.id = 0;}
    connect(signal, callback) {this.handlers.set(++this.id, {signal, callback}); return this.id;}
    disconnect(id) {this.handlers.delete(id);}
    emit(signal, ...args) {
        for (const [id, record] of [...this.handlers]) {
            if (this.handlers.has(id) && record.signal === signal) record.callback(this, ...args);
        }
    }
}
class Signals {
    constructor() {this.records = [];}
    add(...bindings) {
        if (!Array.isArray(bindings[0])) bindings = [bindings];
        for (const [object, signal, callback] of bindings)
            this.records.push([object, object.connect(signal, callback)]);
    }
    destroy() {
        for (const [object, id] of this.records) object.disconnect(id);
        this.records = [];
    }
}
const login = new Emitter();
const session = Object.assign(new Emitter(), {isLocked: false});
const shield = Object.assign(new Emitter(), {active: false});
const laters = new Map();
let nextId = 0;
const types = {RESIZE: 1, BEFORE_REDRAW: 2};
const sandbox = {
    Meta: {LaterType: types},
    Main: {sessionMode: session, screenShield: shield},
    LoginManager: {getLoginManager: () => login},
    Utils: {GlobalSignalsHandler: Signals,
        laterAdd(type, callback) {laters.set(++nextId, {type, callback}); return nextId;},
        laterRemove(id) {laters.delete(id);}},
};
vm.createContext(sandbox);
const source = fs.readFileSync(path.join(__dirname, '../dockRedrawRecovery.js'), 'utf8')
    .replace(/^import .*;\n/gm, '').replace('export class', 'class');
vm.runInContext(source + '\nthis.Recovery = DockRedrawRecovery;', sandbox);
function flush(type) {
    for (const [id, record] of [...laters]) {
        if (record.type === type && laters.delete(id)) record.callback();
    }
}
function createDock() {
    const dock = Object.assign(new Emitter(), {mapped: true, redraws: 0, resets: 0,
        _themeManager: {updates: 0, updateCustomTheme() {this.updates++;}},
        _resetPosition() {this.resets++;}, queue_redraw() {this.redraws++;}});
    function actor() {
        return {dirty: false, redraws: 0, queue_relayout() {this.dirty = true;},
            queue_redraw() {
                assert(!dock._slider.dirty, 'Paint must happen after layout refreshed the clip');
                this.redraws++;
            }};
    }
    Object.assign(dock, {dash: actor(), _box: actor(), _slider: Object.assign(actor(), {slideX: 1})});
    dock._box.height = 80;
    dock._box.clipHeight = 52;
    dock.layout = () => {
        if (dock._slider.dirty) dock._box.clipHeight = dock._box.height * dock._slider.slideX;
        for (const a of [dock.dash, dock._box, dock._slider]) a.dirty = false;
    };
    dock.recovery = new sandbox.Recovery(dock);
    return dock;
}
function frame(dock) {flush(types.RESIZE); dock.layout(); flush(types.BEFORE_REDRAW);}

// The path exists even when all optional appearance effects are disabled.
const dock = createDock();
assert.equal(dock.dash.redraws, 0);
frame(dock);
assert.equal(dock._box.clipHeight, 80, 'Refresh a stale bottom clip');
assert.equal(dock.dash.redraws, 1, 'Invalidate the entire offscreen dash');
assert.equal(laters.size, 0, 'No idle repaint loop');

// A wake event can precede session unlock and the visual shield animation.
login.emit('prepare-for-sleep', true);
assert.equal(laters.size, 0);
session.isLocked = true;
shield.active = true;
login.emit('prepare-for-sleep', false);
assert.equal(laters.size, 0);
session.isLocked = false;
session.emit('updated');
assert.equal(laters.size, 0, 'Wait for the shield to finish disappearing');
shield.active = false;
shield.emit('active-changed');
login.emit('prepare-for-sleep', false);
assert.equal(laters.size, 1, 'Coalesce wake and shield notifications');
dock._box.height = 96;
frame(dock);
assert.equal(dock._box.clipHeight, 96);
assert.equal(dock.dash.redraws, 2);

// Recover a remapped dock without forcing it open or cancelling autohide.
dock.mapped = false;
dock.emit('notify::mapped');
login.emit('prepare-for-sleep', false);
assert.equal(laters.size, 0);
dock._slider.slideX = 0.5;
dock.mapped = true;
dock.emit('notify::mapped');
frame(dock);
assert.equal(dock._slider.slideX, 0.5);
assert.equal(dock._box.clipHeight, 48, 'Preserve intentional sliding clip');

// Relocking after RESIZE defers redraw; the next unlock recovers normally.
login.emit('prepare-for-sleep', false);
flush(types.RESIZE);
dock.layout();
session.isLocked = true;
flush(types.BEFORE_REDRAW);
assert.equal(dock.dash.redraws, 3);
session.isLocked = false;
session.emit('updated');
frame(dock);
assert.equal(dock.dash.redraws, 4);

// Dock replacement and extension teardown must cancel either frame phase.
login.emit('prepare-for-sleep', false);
dock.emit('destroy');
assert.equal(laters.size, 0);
assert.equal(dock.handlers.size, 0);
const replacement = createDock();
flush(types.RESIZE);
replacement.layout();
replacement.emit('destroy');
flush(types.BEFORE_REDRAW);
assert.equal(replacement.dash.redraws, 0);
assert.equal(laters.size, 0);
for (const emitter of [login, session, shield]) assert.equal(emitter.handlers.size, 0);
console.log('PASS: whole-dock resume layout/redraw, stale clip, unlock/shield ordering, autohide, coalescing and teardown');
