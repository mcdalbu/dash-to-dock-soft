import {Meta} from './dependencies/gi.js';
import {LoginManager} from './dependencies/shell/misc.js';
import {Main} from './dependencies/shell/ui.js';
import * as Utils from './utils.js';

// Recover the dock itself, including its sliding clip and offscreen texture.
// This must run independently of the optional background blur.
export class DockRedrawRecovery {
    constructor(dock) {
        this._dock = dock;
        this._signals = new Utils.GlobalSignalsHandler();
        const loginManager = LoginManager.getLoginManager();
        this._sleeping = loginManager.preparingForSleep ?? false;
        this._signals.add(
            [loginManager, 'prepare-for-sleep', (_manager, sleeping) => {
                this._sleeping = sleeping;
                this.queue();
            }],
            [Main.sessionMode, 'updated', () => this.queue()],
            [dock, 'notify::mapped', () => this.queue()],
            [dock, 'destroy', () => this.destroy()]);
        if (Main.screenShield)
            this._signals.add(Main.screenShield, 'active-changed', () => this.queue());

        // Docks recreated by session-mode changes need the same final layout
        // pass as docks that survive suspend. Their initialization has finished.
        this.queue();
    }

    _canRecover() {
        return this._dock?.mapped && !this._sleeping &&
            !Main.sessionMode.isLocked && !Main.screenShield?.active;
    }

    queue() {
        if (!this._canRecover() || this._layoutLater || this._redrawLater)
            return;
        // RESIZE precedes Clutter's layout pass. BEFORE_REDRAW alone can paint
        // the old sliding clip before the requested layout has been applied.
        this._layoutLater = Utils.laterAdd(Meta.LaterType.RESIZE, () => {
            this._layoutLater = 0;
            if (!this._canRecover())
                return;
            const dock = this._dock;
            dock._themeManager.updateCustomTheme();
            dock._resetPosition();
            dock.dash.queue_relayout();
            dock._box.queue_relayout();
            dock._slider.queue_relayout();
            this._redrawLater = Utils.laterAdd(Meta.LaterType.BEFORE_REDRAW, () => {
                this._redrawLater = 0;
                if (!this._canRecover())
                    return;
                // Invalidating the whole dash also invalidates its offscreen
                // cache; a blur-only repaint leaves this texture untouched.
                dock.dash.queue_redraw();
                dock._box.queue_redraw();
                dock.queue_redraw();
            });
        });
    }

    destroy() {
        for (const id of [this._layoutLater, this._redrawLater]) {
            if (id)
                Utils.laterRemove(id);
        }
        this._layoutLater = 0;
        this._redrawLater = 0;
        this._dock = null;
        this._signals.destroy();
    }
}
