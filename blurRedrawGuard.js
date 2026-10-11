// BACKGROUND blur samples the framebuffer, including pixels outside the
// compositor's damage clip. Those pixels can contain the previous frame's dock.
// Use complete redraws only for an existing frame on a view containing blur.
// Unlike queue_redraw() from a frame callback, this cannot drive an idle loop.
const owners = new Set();
let changedFlags = false;

export class BlurRedrawGuard {
    constructor(clutter, meta) {
        this._api = typeof clutter.get_debug_flags === 'function' ? {
            get: () => clutter.get_debug_flags(),
            add: flag => clutter.add_debug_flags(0, flag, 0),
            remove: flag => clutter.remove_debug_flags(0, flag, 0),
        } : {
            get: () => meta.get_clutter_debug_flags(),
            add: flag => meta.add_clutter_debug_flags(0, flag, 0),
            remove: flag => meta.remove_clutter_debug_flags(0, flag, 0),
        };
        this._flag = clutter.DrawDebugFlag.DISABLE_CLIPPED_REDRAWS;
    }

    begin(actor, view) {
        this.end();
        if (!actor?.mapped || actor.get_paint_opacity() === 0)
            return;
        if (view) {
            // Use the boxed property: get_layout() requires a caller-allocated
            // rectangle in GJS, with a different namespace on older Shells.
            const rect = view.layout;
            const [x, y] = actor.get_transformed_position();
            const [width, height] = actor.get_transformed_size();
            if (width <= 0 || height <= 0 || x >= rect.x + rect.width ||
                x + width <= rect.x || y >= rect.y + rect.height || y + height <= rect.y)
                return;
        }
        if (owners.size === 0) {
            const [, drawFlags] = this._api.get();
            changedFlags = (drawFlags & this._flag) === 0;
            if (changedFlags)
                this._api.add(this._flag);
        }
        owners.add(this);
    }

    end() {
        if (!owners.delete(this) || owners.size !== 0)
            return;
        // Preserve a flag already enabled by the user or another extension.
        if (changedFlags)
            this._api.remove(this._flag);
        changedFlags = false;
    }
}
